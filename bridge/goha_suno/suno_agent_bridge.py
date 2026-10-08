#!/usr/bin/env python3
"""MCP server that lets the agent hand Suno download and generation jobs to the GOHA Suno Helper extension.

The AI assistant starts this over stdio with the MCP config the extension hands out
(the pairing code travels in JR_SUNO_PAIRING_CODE). It also listens on 127.0.0.1 for
the extension:

    python bridge/goha_suno/suno_agent_bridge.py --pairing-code   # legacy: print the file-based code

Only a Chrome extension origin may open the socket, only one extension at a time,
and nothing of the user's Suno session ever passes through it. See
`suno_bridge_core.py` for the queue and protocol rules, and `suno_plugin.py` for
GOHA_SUNO_PLUGIN (extra job lists and tools of one installation).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from websockets.asyncio.server import ServerConnection, serve  # noqa: E402
from websockets.datastructures import Headers  # noqa: E402
from websockets.exceptions import ConnectionClosed  # noqa: E402
from websockets.http11 import Request, Response  # noqa: E402
from websockets.protocol import State  # noqa: E402

from goha_suno.suno_bridge_core import BridgeCore, origin_allowed, pairing_token  # noqa: E402
from goha_suno.suno_plugin import PluginError, load_plugin  # noqa: E402
from goha_suno.suno_projects import ProjectError  # noqa: E402

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

    # A community install has no plugin: its agent sees the project tools only (songs by link, Create packets).
    plugin = bridge.core.plugin
    server = MCPServer(
        name="jr-suno",
        instructions=PROJECT_INSTRUCTIONS + (plugin.instructions if plugin is not None else ""),
        lifespan=lifespan,
    )
    core = bridge.core

    @server.tool()
    async def suno_status() -> dict:
        """Is the extension connected, is the queue paused, job counts and recent alerts."""
        return core.status()

    @server.tool()
    async def suno_check_clips(clip_ids: list[str]) -> list[dict]:
        """Public status of Suno clips (render state, title, seconds, type, tags/max_mode/instrumental). No browser, no login."""
        from goha_suno.suno_clip_status import check_clips

        results = await asyncio.to_thread(check_clips, clip_ids)
        return [result._asdict() for result in results]

    @server.tool()
    async def suno_jobs(episode: str | None = None) -> list[dict]:
        """Every job and its result (kind, ids, seconds, clip ids, file name). `episode` = a project name (or one a plugin owns)."""
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
        """Download Suno songs as WAV via Studio export (a Premier plan feature). `songs`: suno.com/song/<id> links or ids.

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

    if plugin is not None:
        plugin.register_tools(server, core, bridge)
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
    try:
        plugin = load_plugin()
    except PluginError as error:
        print(error, file=sys.stderr)
        return 2

    # stdout carries the MCP protocol; everything else goes to stderr.
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(name)s: %(message)s")
    # Every refused or half-open handshake would print a full traceback; the bridge logs what matters.
    logging.getLogger("websockets.server").setLevel(logging.CRITICAL)
    bridge = SocketBridge(
        BridgeCore(token=token, now=utc_now, local_dir=CONFIG_DIR, bridge_path=Path(__file__).resolve(), plugin=plugin)
    )
    build_server(bridge, args.port).run("stdio")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
