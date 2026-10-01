#!/usr/bin/env python3
"""MCP server that lets the agent hand Suno download and generation jobs to the JR Suno Helper extension.

Claude Code starts this over stdio (see `.mcp.json`). It also listens on
127.0.0.1 for the extension, which pairs once with a code kept outside the repo:

    python scripts/suno_agent_bridge.py --pairing-code   # legacy: print the file-based code (the extension now generates the code and passes it via JR_SUNO_PAIRING_CODE)

Only a Chrome extension origin may open the socket, only one extension at a time,
and nothing of the owner's Suno session ever passes through it. See
`scripts/suno_bridge_core.py` for the queue and protocol rules.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import subprocess
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from websockets.asyncio.server import ServerConnection, serve  # noqa: E402

from scripts.suno_projects import ProjectError  # noqa: E402
from websockets.datastructures import Headers  # noqa: E402
from websockets.exceptions import ConnectionClosed  # noqa: E402
from websockets.http11 import Request, Response  # noqa: E402
from websockets.protocol import State  # noqa: E402

from scripts.suno_bridge_core import BridgeCore, origin_allowed, pairing_token  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
CONFIG_DIR = Path(os.environ.get("JR_SUNO_BRIDGE_HOME", Path.home() / ".jr-suno-bridge"))
# Fixed, so the extension always knows where to connect. A busy port means another
# bridge is already running: stop that one instead of moving to a new port.
DEFAULT_PORT = int(os.environ.get("JR_SUNO_BRIDGE_PORT", "47831"))
MAX_MESSAGE_BYTES = 64 * 1024
# A socket must prove itself with a valid hello this fast, or it is dropped. It never
# holds the one extension slot before that, so a silent local peer cannot lock it.
HELLO_TIMEOUT_SECONDS = 10.0

log = logging.getLogger("jr-suno-bridge")


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class SocketBridge:
    """Moves JSON between one extension socket and `BridgeCore`."""

    def __init__(self, core: BridgeCore, hello_timeout: float = HELLO_TIMEOUT_SECONDS):
        self.core = core
        self.port: int | None = None
        self.hello_timeout = hello_timeout
        self._ws: ServerConnection | None = None

    async def start(self, host: str = "127.0.0.1", port: int = DEFAULT_PORT):
        server = await serve(
            self._handle,
            host,
            port,
            process_request=self._check_origin,
            max_size=MAX_MESSAGE_BYTES,
            server_header=None,
        )
        self.port = server.sockets[0].getsockname()[1]
        self.core.recover()  # this process owns the port now, so it alone may touch the job files
        return server

    @staticmethod
    def _check_origin(connection: ServerConnection, request: Request) -> Response | None:
        if origin_allowed(request.headers.get("Origin")):
            return None
        return Response(403, "Forbidden", Headers(), b"extension origin required\n")

    def _outgoing(self) -> list[dict]:
        """Queued replies, then the queue picture if it changed since the last send."""
        messages = self.core.drain()
        update = self.core.queue_update()
        return messages + [update] if update else messages

    async def flush(self) -> None:
        ws = self._ws
        for message in self._outgoing():
            if ws is None:
                continue
            if message.get("type") == "close":
                await ws.close()
                continue
            await ws.send(json.dumps(message, ensure_ascii=False))

    @staticmethod
    async def _refuse(ws: ServerConnection, message: str) -> None:
        await ws.send(json.dumps({"type": "error", "message": message}))
        await ws.close()

    @staticmethod
    async def _recv_json(ws: ServerConnection) -> dict | None:
        try:
            message = json.loads(await ws.recv())
        except (TypeError, ValueError, ConnectionClosed):
            return None
        return message if isinstance(message, dict) else None

    async def _send_drained(self, ws: ServerConnection) -> None:
        for message in self._outgoing():
            if message.get("type") == "close":
                await ws.close()
                continue
            await ws.send(json.dumps(message, ensure_ascii=False))

    async def _authenticate(self, ws: ServerConnection) -> bool:
        """Run the hello -> challenge -> auth exchange. True once `core.connected`.

        Sends each reply as it is produced, so the pairing token's own proof
        exchange is visible on the wire only as hex digests -- never the token.
        The caller (`_handle`) bounds the whole exchange with one deadline.
        """
        hello = await self._recv_json(ws)
        if hello is None:
            return False
        reply, handshake = self.core.begin_auth(hello)  # nonces stay with THIS connection
        await ws.send(json.dumps(reply))
        if handshake is None:
            return False
        auth = await self._recv_json(ws)
        if auth is None:
            return False
        reply = self.core.finish_auth(handshake, auth)
        await ws.send(json.dumps(reply))
        if reply["type"] != "welcome":
            return False
        await self._send_drained(ws)  # the job finish_auth just pumped
        return True

    async def _handle(self, ws: ServerConnection) -> None:
        if self._ws is not None:
            await self._refuse(ws, "another extension is already connected")
            return
        try:
            authenticated = await asyncio.wait_for(self._authenticate(ws), self.hello_timeout)
        except (asyncio.TimeoutError, ConnectionClosed):
            authenticated = False
        if not authenticated:
            # Never drain the shared outbox here: it may hold the live extension's next job.
            if ws.state is State.OPEN:
                await self._refuse(ws, "pairing failed or no hello/auth in time")
            return
        if self._ws is not None:
            await self._refuse(ws, "another extension is already connected")
            return
        self._ws = ws
        try:
            async for raw in ws:
                try:
                    message = json.loads(raw)
                except (TypeError, ValueError):
                    await ws.send(json.dumps({"type": "error", "message": "messages must be JSON objects"}))
                    continue
                self.core.on_message(message)
                await self.flush()
        except ConnectionClosed:
            pass
        finally:
            self._ws = None
            self.core.on_disconnect()
            self.core.drain()


PROJECT_INSTRUCTIONS = (
    "Hand Suno jobs to the GOHA Suno Helper extension in the user's Chrome. Group work in a project (a short name "
    "like 'my-album'). suno_download_songs and suno_export_32bit are free. suno_generate and suno_split_stems SPEND "
    "SUNO CREDITS on a real run: run dry_run=True first, tell the user the cost, and pass dry_run=False AND "
    "confirm_spend=True only after they agree. Check suno_status first (the extension must be connected). Jobs stop "
    "with needs_human on CAPTCHA, logout or a hidden Suno tab: tell the user, then suno_resume. Never requeue an "
    "'unknown' job without checking Suno first (it may already have created songs). Follow progress with suno_jobs. "
)
EPISODE_INSTRUCTIONS = (
    "Hand Suno Studio-export + WAV download jobs, and Suno Create generation jobs, to the "
    "JR Suno Helper extension. Generation SPENDS SUNO CREDITS once dry_run=False AND "
    "confirm_spend=True are both passed to suno_enqueue_generation -- only queue a real run "
    "when the owner has approved it, and never for a slot whose last real attempt already "
    "reports clip ids without a decision to requeue it. Check suno_status first. Jobs stop "
    "with needs_human on CAPTCHA or logout: tell the owner, then suno_resume. Never requeue "
    "an 'unknown' job without checking Suno first (duplicate exports/generations). "
    "suno_enqueue_multitrack is free: it re-exports filed takes as 32-bit float ZIPs; "
    "file them with suno_ingest_stems. suno_enqueue_stems splits named takes into stems "
    "(50 credits per unsplit take: dry_run=False AND confirm_spend=True, owner-approved) and "
    "downloads mix + stems as 32-bit float; file them with suno_ingest_stems too."
)


def build_server(bridge: SocketBridge, port: int):
    from mcp.server import MCPServer

    @asynccontextmanager
    async def lifespan(_server):
        ws_server = await bridge.start(port=port)
        log.info("listening for the extension on 127.0.0.1:%s", bridge.port)
        try:
            yield {}
        finally:
            ws_server.close()
            await ws_server.wait_closed()

    # The channel's own repo has episodes/: its episode tools join the project tools. A community install has
    # none, so its agent only sees the project tools (songs by link, Create packets).
    has_episodes = (ROOT / "episodes").is_dir()
    server = MCPServer(
        name="jr-suno",
        instructions=PROJECT_INSTRUCTIONS + (EPISODE_INSTRUCTIONS if has_episodes else ""),
        lifespan=lifespan,
    )
    core = bridge.core
    episode_tool = server.tool() if has_episodes else (lambda function: function)

    @server.tool()
    async def suno_status() -> dict:
        """Is the extension connected, is the queue paused, job counts and recent alerts."""
        return core.status()

    @server.tool()
    async def suno_check_clips(clip_ids: list[str]) -> list[dict]:
        """Public status of Suno clips (render state, title, seconds, type, tags/max_mode/instrumental). No browser, no login."""
        from scripts.suno_clip_status import check_clips

        results = await asyncio.to_thread(check_clips, clip_ids)
        return [result._asdict() for result in results]

    @episode_tool
    async def suno_plan_downloads(episode: str) -> dict:
        """Which candidates the episode still needs, without queuing anything."""
        from scripts.episode_audio import find_episode_dir
        from scripts.suno_jobs import plan_download_jobs

        jobs, short = plan_download_jobs(find_episode_dir(ROOT, episode))
        return {
            "jobs": [{"slot": j.slot, "song_id": j.song_id, "min_seconds": j.min_seconds} for j in jobs],
            "slots_short_of_candidates": short,
        }

    @episode_tool
    async def suno_enqueue_downloads(episode: str, song_ids: list[str] | None = None) -> dict:
        """Queue Studio export + WAV download for the episode's missing takes (or only these songs)."""
        summary = core.enqueue(episode, song_ids)
        await bridge.flush()
        return summary

    @episode_tool
    async def suno_plan_multitrack(episode: str, slots: list[int] | None = None) -> dict:
        """Which filed takes WOULD get the free 32-bit float export (Studio → Export → Multitrack). No side effects."""
        from scripts.episode_audio import find_episode_dir
        from scripts.suno_jobs import plan_multitrack_jobs

        jobs = plan_multitrack_jobs(find_episode_dir(ROOT, episode), slots=slots)
        return {"jobs": [{"id": j.id, "slot": j.slot, "take": j.take, "song_id": j.song_id} for j in jobs]}

    @episode_tool
    async def suno_enqueue_multitrack(episode: str, slots: list[int] | None = None) -> dict:
        """Queue the free 32-bit float export of every filed take (0 credits, no monthly quota): one ZIP per take."""
        summary = core.enqueue_multitrack(episode, slots)
        await bridge.flush()
        return summary

    @episode_tool
    async def suno_plan_stems(episode: str, slots: list[int], takes: list[int] | None = None) -> dict:
        """Which filed takes WOULD be split into stems (Auto split, 50 credits each when run for real). No side effects."""
        from scripts.episode_audio import find_episode_dir
        from scripts.suno_jobs import plan_stems_jobs

        jobs = plan_stems_jobs(find_episode_dir(ROOT, episode), slots=slots, takes=takes)
        return {"jobs": [{"id": j.id, "slot": j.slot, "take": j.take, "song_id": j.song_id} for j in jobs],
                "credits_if_none_split_yet": 50 * len(jobs)}

    @episode_tool
    async def suno_enqueue_stems(
        episode: str, slots: list[int], takes: list[int] | None = None, dry_run: bool = True, confirm_spend: bool = False
    ) -> dict:
        """Split filed takes into stems on Suno, then download mix + every stem as one 32-bit float ZIP per take.

        A take already split on Suno costs nothing more. An unsplit take costs 50 credits, so a real run needs
        dry_run=False AND confirm_spend=True, after the owner approved it. File the ZIPs with suno_ingest_stems.
        """
        if not dry_run and not confirm_spend:
            return {"ok": False, "error": "splitting stems spends Suno credits (50 per take); pass confirm_spend=true"}
        summary = core.enqueue_stems(episode, slots, takes, dry_run=dry_run)
        await bridge.flush()
        return {"ok": True, **summary}

    @episode_tool
    async def suno_plan_generation(episode: str, slots: list[int] | None = None) -> dict:
        """What Suno Create jobs WOULD be queued (title, Styles/Exclude length, sliders). No side effects, no credits spent."""
        from scripts.episode_audio import find_episode_dir
        from scripts.suno_generation import plan_generation_jobs

        jobs = plan_generation_jobs(find_episode_dir(ROOT, episode), slots=slots)
        return {
            "jobs": [
                {
                    "slot": j.slot,
                    "batch_id": j.batch_id,
                    "min_seconds": j.min_seconds,
                    "packet": {
                        "title": j.packet["title"],
                        "styles_chars": len(j.packet["styles"]),
                        "exclude_chars": len(j.packet["exclude"]),
                        "duration_seconds": j.packet["durationSeconds"],
                        "max_mode": j.packet["maxMode"],
                        "variety": j.packet["variety"],
                        "weirdness": j.packet["weirdness"],
                        "style_influence": j.packet["styleInfluence"],
                    },
                }
                for j in jobs
            ],
        }

    @episode_tool
    async def suno_enqueue_generation(
        episode: str,
        slots: list[int] | None = None,
        dry_run: bool = True,
        confirm_spend: bool = False,
    ) -> dict:
        """Queue Suno Create jobs. dry_run=False SPENDS SUNO CREDITS and also requires confirm_spend=True."""
        if not dry_run and not confirm_spend:
            return {
                "ok": False,
                "error": (
                    "a real generation spends Suno credits; pass dry_run=False AND "
                    "confirm_spend=True to proceed"
                ),
            }
        summary = core.enqueue_generation(episode, slots, dry_run=dry_run)
        await bridge.flush()
        return {"ok": True, **summary}

    @server.tool()
    async def suno_jobs(episode: str | None = None) -> list[dict]:
        """Every job and its result (kind, ids, seconds, clip ids, file name). `episode` = a project name (or EP###)."""
        return core.jobs(episode)

    async def _project_call(call) -> dict:
        try:
            # Planning reads each song from Suno's public API: off the event loop, so the extension link keeps beating.
            summary = await asyncio.to_thread(call)
        except ProjectError as error:
            return {"ok": False, "error": str(error)}
        await bridge.flush()
        return {"ok": True, **summary}

    @server.tool()
    async def suno_download_songs(project: str, songs: list[str]) -> dict:
        """Download Suno songs as WAV (Studio export, no monthly download quota). `songs`: suno.com/song/<id> links or ids.

        Files land in the browser's Downloads folder under GOHA-Suno/<project>/. Free: no credits.
        """
        return await _project_call(lambda: core.enqueue_project_songs(project, songs, "download"))

    @server.tool()
    async def suno_export_32bit(project: str, songs: list[str]) -> dict:
        """Export songs as a 48 kHz / 32-bit float WAV inside a ZIP (Studio → Export → Multitrack). Free: no credits.

        For a song already split into stems, the ZIP holds the mix and every stem.
        """
        return await _project_call(lambda: core.enqueue_project_songs(project, songs, "multitrack"))

    @server.tool()
    async def suno_split_stems(project: str, songs: list[str], dry_run: bool = True, confirm_spend: bool = False) -> dict:
        """Split songs into stems (Suno Auto split) and download mix + stems as one 32-bit float ZIP per song.

        A song already split costs nothing more. An unsplit song costs 50 credits: a real run needs dry_run=False AND
        confirm_spend=True, only after the user agreed to the cost. dry_run=True only reports whether each song is split.
        """
        if not dry_run and not confirm_spend:
            return {"ok": False, "error": "splitting stems spends Suno credits (50 per song); pass confirm_spend=true after the user agrees"}
        return await _project_call(lambda: core.enqueue_project_songs(project, songs, "stems", dry_run=dry_run))

    @server.tool()
    async def suno_generate(
        project: str,
        title: str,
        styles: str,
        exclude: str = "",
        count: int = 1,
        model: str = "v6",
        duration_seconds: int | None = None,
        max_mode: bool = False,
        weirdness: int = 50,
        style_influence: int = 50,
        variety: int = 2,
        vocal_gender: str | None = None,
        dry_run: bool = True,
        confirm_spend: bool = False,
        allow_additional: bool = False,
    ) -> dict:
        """Fill Suno's Create form (Advanced, instrumental) and, for a real run, press Create `count` times (2 songs each).

        A real run is refused while an earlier real run of the project is still queued, running or of unknown fate;
        pass allow_additional=True only when the user asked for more songs on purpose.

        styles/exclude ≤ 1000 characters; duration_seconds 10–360 in steps of 5 or None for Suno's choice; sliders 0–100,
        variety 0–4. dry_run=True fills the form and reads it back without creating anything. A real run spends credits:
        dry_run=False AND confirm_spend=True, only after the user agreed. Download the new songs with suno_download_songs
        using the clip ids the finished job reports (suno_jobs).
        """
        if not dry_run and not confirm_spend:
            return {"ok": False, "error": "a real generation spends Suno credits; pass confirm_spend=true after the user agrees"}
        packet = {
            "title": title, "styles": styles, "exclude": exclude, "lyrics": "", "model": model, "tab": "advanced",
            "durationSeconds": duration_seconds, "maxMode": max_mode, "variety": variety, "weirdness": weirdness,
            "styleInfluence": style_influence, "vocalGender": vocal_gender, "myTaste": False,
        }
        return await _project_call(
            lambda: core.enqueue_project_generation(project, packet, count=count, dry_run=dry_run, allow_additional=allow_additional)
        )

    @server.tool()
    async def suno_pause() -> dict:
        """Stop handing out new jobs; the one in progress finishes."""
        core.pause()
        return core.status()

    @server.tool()
    async def suno_resume() -> dict:
        """Continue after the owner cleared a CAPTCHA or logged back in."""
        core.resume()
        await bridge.flush()
        return core.status()

    @server.tool()
    async def suno_cancel(job_id: str) -> dict:
        """Cancel one job; if the extension is working on it, it is told to stop.

        Refused for a real (non-dry-run) generate job once its last step is
        submitting/rendering: the Create click may already have spent credits.
        """
        core.cancel(job_id)
        await bridge.flush()
        return core.status()

    @server.tool()
    async def suno_requeue(job_id: str, confirm_spend: bool = False) -> dict:
        """Put a failed / needs_human / unknown job back in line (check Suno first for 'unknown').

        A real generate or stems job may spend credits again: pass confirm_spend=True only after the user agreed.
        """
        core.requeue(job_id, confirm_spend=confirm_spend)
        await bridge.flush()
        return core.status()

    @episode_tool
    async def suno_ingest(episode: str, dry_run: bool = True, plan: str | None = None) -> dict:
        """Run ingest_suno_downloads.py on the folder the finished jobs landed in. Dry run by default.

        `plan` (free/pro/premier) is required only on an episode's first ingest (D023).
        """
        source = core.download_dir(episode)
        if source is None:
            return {"ok": False, "output": "no finished download for this episode"}
        command = [sys.executable, str(ROOT / "scripts" / "ingest_suno_downloads.py"), episode, "--source", str(source)]
        if plan:
            command.extend(["--plan", plan])
        if dry_run:
            command.append("--dry-run")
        completed = await asyncio.to_thread(
            subprocess.run, command, capture_output=True, text=True, encoding="utf-8", cwd=ROOT, check=False
        )
        return {"ok": completed.returncode == 0, "output": (completed.stdout + completed.stderr)[-4000:]}

    @episode_tool
    async def suno_ingest_stems(episode: str, dry_run: bool = True) -> dict:
        """File the finished Multitrack ZIPs into episodes/<EP>/stems/ (take matched by audio). Dry run by default."""
        source = core.download_dir(episode)
        if source is None:
            return {"ok": False, "output": "no finished download for this episode"}
        command = [sys.executable, str(ROOT / "scripts" / "ingest_suno_stems.py"), episode, "--source", str(source)]
        if dry_run:
            command.append("--dry-run")
        completed = await asyncio.to_thread(
            subprocess.run, command, capture_output=True, text=True, encoding="utf-8", cwd=ROOT, check=False
        )
        return {"ok": completed.returncode == 0, "output": (completed.stdout + completed.stderr)[-4000:]}

    return server


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pairing-code", action="store_true", help="print the code to paste into the extension")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args()

    try:
        token = pairing_token(CONFIG_DIR)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2
    if args.pairing_code:
        print(token)
        return 0

    # stdout carries the MCP protocol; everything else goes to stderr.
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(name)s: %(message)s")
    # Every refused or half-open handshake would print a full traceback; the bridge logs what matters.
    logging.getLogger("websockets.server").setLevel(logging.CRITICAL)
    bridge = SocketBridge(
        BridgeCore(root=ROOT, token=token, now=utc_now, local_dir=CONFIG_DIR, bridge_path=Path(__file__).resolve())
    )
    build_server(bridge, args.port).run("stdio")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
