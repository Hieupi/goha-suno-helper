"""The real Python bridge and the real extension controller, talking over a real socket.

`extension/tests/wire-harness.mjs` runs `lib/controller.js` in Node with a real WebSocket;
only the Suno page and `chrome.*` are fakes. Each side has its own unit tests; this one
proves they agree on the wire: the HMAC handshake, a project download end to end, and a
dry-run and a real Create end to end.
"""

import asyncio
import logging
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from goha_suno.suno_agent_bridge import SocketBridge
from goha_suno.suno_clip_status import ClipStatus
from tests.helpers import PACKET, PROJECT, SONG_A, TITLE_A, make_core, suno_clips

logging.getLogger("websockets").setLevel(logging.CRITICAL)
# The test loop runs in asyncio debug mode; once the MCP library has set up logging it would narrate every subprocess.
logging.getLogger("asyncio").setLevel(logging.WARNING)

HARNESS = Path(__file__).resolve().parents[2] / "extension" / "tests" / "wire-harness.mjs"
TOKEN = "w" * 43
EXPORT = "55555555-5555-4555-8555-555555555555"
CLIP = "66666666-6666-4666-8666-666666666666"
DEADLINE_SECONDS = 25


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class WireEndToEndTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.core = make_core(self.tmp, token=TOKEN, clip_status_fetch=self.public_metadata)
        self.bridge = SocketBridge(self.core, hello_timeout=5)
        self.server = await self.bridge.start(host="127.0.0.1", port=0)
        self.node = None

    async def asyncTearDown(self):
        if self.node and self.node.returncode is None:
            self.node.kill()
            await self.node.wait()
        self.server.close()
        await self.server.wait_closed()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def public_metadata(self, clip_ids):
        """Suno's public clip endpoint: the test song, and a faithful render of the packet for new clips."""
        if clip_ids == [SONG_A]:
            return suno_clips(clip_ids)
        return [ClipStatus(cid, "complete", PACKET["title"], 330.0, "gen", PACKET["styles"], PACKET["exclude"], False, True, None)
                for cid in clip_ids]

    async def start_extension(self):
        env = {**os.environ, "JR_PORT": str(self.bridge.port), "JR_TOKEN": TOKEN, "JR_EXPORT": EXPORT,
               "JR_TITLE": TITLE_A, "JR_CLIP": CLIP, "JR_LIFETIME_MS": str(DEADLINE_SECONDS * 1000)}
        self.node = await asyncio.create_subprocess_exec(
            "node", str(HARNESS), env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )

    async def wait_until_finished(self) -> list[dict]:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + DEADLINE_SECONDS
        while loop.time() < deadline:
            jobs = self.core.jobs(PROJECT)
            if jobs and all(job["status"] in {"done", "failed", "needs_human", "unknown"} for job in jobs):
                return jobs
            await asyncio.sleep(0.2)
        stderr = await self.node.stderr.read() if self.node and self.node.returncode is not None else b""
        self.fail(f"jobs did not finish: {self.core.jobs(PROJECT)} status={self.core.status()} node={stderr.decode(errors='replace')[-800:]}")

    async def test_a_download_and_a_dry_run_create_complete_over_the_real_socket(self):
        self.assertEqual(len(self.core.enqueue_project_songs(PROJECT, [SONG_A], "download")["added"]), 1)
        self.assertEqual(len(self.core.enqueue_project_generation(PROJECT, PACKET)["added"]), 1)
        await self.start_extension()
        jobs = await self.wait_until_finished()

        self.assertTrue(self.core.status()["connected"], "handshake completed")
        by_kind = {job["kind"]: job for job in jobs}
        download = by_kind["export_download"]
        self.assertEqual(download["status"], "done", download)
        self.assertEqual((download["result"]["export_id"], download["result"]["filename"]), (EXPORT, f"{TITLE_A}.wav"))
        self.assertTrue(download["result"]["title_ok"])
        dry = by_kind["generate"]
        self.assertEqual(dry["status"], "done", dry)
        self.assertTrue(dry["dry_run"])
        self.assertEqual(dry["result"]["observed"]["max_mode"], True)

    async def test_a_real_create_keeps_its_clips_and_checks_them_against_the_packet(self):
        self.core.enqueue_project_generation(PROJECT, PACKET, dry_run=False)
        await self.start_extension()
        [job] = await self.wait_until_finished()

        self.assertEqual(job["status"], "done", job)
        self.assertEqual(job["clip_ids"], [CLIP])
        self.assertTrue(job["packet_check"][CLIP]["ok"], job["packet_check"])


if __name__ == "__main__":
    unittest.main()
