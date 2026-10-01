"""The real WebSocket server: origin check, pairing over the wire, one extension at a time."""

import asyncio
import hashlib
import hmac
import json
import logging
import secrets
import shutil
import tempfile
import unittest
from pathlib import Path

from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

from goha_suno.suno_agent_bridge import SocketBridge
from goha_suno.suno_bridge_core import BRIDGE_VERSION, PROTOCOL_VERSION
from tests.helpers import PROJECT, SONG_A, make_core, project_store

# The server logs every refused handshake; the refusals below are the point of the tests.
logging.getLogger("websockets").setLevel(logging.CRITICAL)

TOKEN = "k" * 43
ORIGIN = "chrome-extension://" + "a" * 32


def compute_proof(token: str, message: str) -> str:
    return hmac.new(token.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).hexdigest()


async def recv_skipping_queue(ws) -> dict:
    """Next message that is not a queue picture (those follow every change; see test_suno_bridge_core)."""
    while True:
        message = json.loads(await asyncio.wait_for(ws.recv(), 2))
        if message.get("type") != "queue":
            return message


class SocketTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.bridge = SocketBridge(make_core(self.tmp, token=TOKEN), hello_timeout=0.5)
        self.server = await self.bridge.start(host="127.0.0.1", port=0)
        self.url = f"ws://127.0.0.1:{self.bridge.port}"

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()
        shutil.rmtree(self.tmp, ignore_errors=True)

    async def handshake(self, ws, nonce: str | None = None) -> dict:
        """Run the full v2 hello -> challenge -> auth exchange. Returns the final reply (welcome/error)."""
        client_nonce = nonce or secrets.token_hex(32)
        await ws.send(json.dumps({"type": "hello", "protocol": PROTOCOL_VERSION, "version": BRIDGE_VERSION, "nonce": client_nonce}))
        challenge = json.loads(await ws.recv())
        if challenge.get("type") != "challenge":
            return challenge
        proof = compute_proof(TOKEN, f"jr-suno/ext/{challenge['nonce']}/{client_nonce}")
        await ws.send(json.dumps({"type": "auth", "proof": proof}))
        return json.loads(await ws.recv())

    async def test_a_web_page_origin_is_refused_before_the_handshake(self):
        with self.assertRaises(InvalidStatus):
            async with connect(self.url, origin="https://suno.com"):
                pass

    async def test_paired_extension_gets_welcome_then_the_job_the_agent_queued(self):
        async with connect(self.url, origin=ORIGIN) as ws:
            self.assertEqual((await self.handshake(ws))["type"], "welcome")
            self.bridge.core.enqueue_project_songs(PROJECT, [SONG_A], "download")
            await self.bridge.flush()
            message = await recv_skipping_queue(ws)
            self.assertEqual(message["type"], "job")
            self.assertEqual(message["job"]["candidateId"], SONG_A)

    async def test_a_wrong_auth_proof_closes_the_socket(self):
        async with connect(self.url, origin=ORIGIN) as ws:
            client_nonce = secrets.token_hex(32)
            await ws.send(json.dumps({"type": "hello", "protocol": PROTOCOL_VERSION, "version": "x", "nonce": client_nonce}))
            challenge = json.loads(await ws.recv())
            self.assertEqual(challenge["type"], "challenge")
            await ws.send(json.dumps({"type": "auth", "proof": "0" * 64}))
            self.assertEqual(json.loads(await ws.recv())["type"], "error")
            await asyncio.wait_for(ws.wait_closed(), 2)

    async def test_the_token_never_appears_on_the_wire(self):
        async with connect(self.url, origin=ORIGIN) as ws:
            client_nonce = secrets.token_hex(32)
            await ws.send(json.dumps({"type": "hello", "protocol": PROTOCOL_VERSION, "version": "x", "nonce": client_nonce}))
            challenge_raw = await ws.recv()
            self.assertNotIn(TOKEN, challenge_raw)
            challenge = json.loads(challenge_raw)
            proof = compute_proof(TOKEN, f"jr-suno/ext/{challenge['nonce']}/{client_nonce}")
            await ws.send(json.dumps({"type": "auth", "proof": proof}))
            welcome_raw = await ws.recv()
            self.assertNotIn(TOKEN, welcome_raw)
            self.assertEqual(json.loads(welcome_raw)["type"], "welcome")

    async def test_a_bad_nonce_is_refused_before_any_challenge(self):
        async with connect(self.url, origin=ORIGIN) as ws:
            await ws.send(json.dumps({"type": "hello", "protocol": PROTOCOL_VERSION, "version": "x", "nonce": "short"}))
            self.assertEqual(json.loads(await ws.recv())["type"], "error")
            await asyncio.wait_for(ws.wait_closed(), 2)

    async def test_a_second_extension_connection_is_refused_while_one_is_live(self):
        async with connect(self.url, origin=ORIGIN) as first:
            await self.handshake(first)
            async with connect(self.url, origin=ORIGIN) as second:
                message = json.loads(await asyncio.wait_for(second.recv(), 2))
                self.assertEqual(message["type"], "error")
                await asyncio.wait_for(second.wait_closed(), 2)

    async def test_an_interleaved_second_handshake_cannot_break_the_first(self):
        """Each connection keeps its own nonces: a stranger's hello mid-pairing changes nothing."""
        async with connect(self.url, origin=ORIGIN) as real, connect(self.url, origin=ORIGIN) as stranger:
            client_nonce = secrets.token_hex(32)
            await real.send(json.dumps({"type": "hello", "protocol": PROTOCOL_VERSION, "version": "x", "nonce": client_nonce}))
            challenge = json.loads(await real.recv())
            await stranger.send(json.dumps({"type": "hello", "protocol": PROTOCOL_VERSION, "version": "y", "nonce": secrets.token_hex(32)}))
            self.assertEqual(json.loads(await stranger.recv())["type"], "challenge")
            proof = compute_proof(TOKEN, f"jr-suno/ext/{challenge['nonce']}/{client_nonce}")
            await real.send(json.dumps({"type": "auth", "proof": proof}))
            self.assertEqual(json.loads(await real.recv())["type"], "welcome")
            self.assertEqual(self.bridge.core.extension["version"], "x")

    async def test_a_failed_stranger_never_receives_the_live_extensions_jobs(self):
        async with connect(self.url, origin=ORIGIN) as real, connect(self.url, origin=ORIGIN) as stranger:
            await stranger.send(json.dumps({"type": "hello", "protocol": PROTOCOL_VERSION, "version": "y", "nonce": secrets.token_hex(32)}))
            self.assertEqual(json.loads(await stranger.recv())["type"], "challenge")
            self.assertEqual((await self.handshake(real))["type"], "welcome")
            self.bridge.core.enqueue_project_songs(PROJECT, [SONG_A], "download")  # a job waits in the shared outbox
            await stranger.send(json.dumps({"type": "auth", "proof": "0" * 64}))
            replies = []
            try:
                while True:
                    replies.append(json.loads(await asyncio.wait_for(stranger.recv(), 1)))
            except Exception:  # noqa: BLE001 - closed or silent: either way the loop ends
                pass
            self.assertFalse([r for r in replies if r.get("type") == "job"], replies)

    async def test_a_silent_peer_is_dropped_and_never_holds_the_slot(self):
        async with connect(self.url, origin=ORIGIN) as squatter:
            async with connect(self.url, origin=ORIGIN) as real:
                self.assertEqual((await self.handshake(real))["type"], "welcome", "kẻ im lặng không chiếm được chỗ")
            await asyncio.wait_for(squatter.wait_closed(), 2)

    async def test_garbage_is_answered_with_an_error_not_a_crash(self):
        async with connect(self.url, origin=ORIGIN) as ws:
            await self.handshake(ws)
            await ws.send("not json")
            self.assertEqual((await recv_skipping_queue(ws))["type"], "error")

    async def test_dropping_the_socket_marks_the_job_unknown(self):
        self.bridge.core.enqueue_project_songs(PROJECT, [SONG_A], "download")
        async with connect(self.url, origin=ORIGIN) as ws:
            await self.handshake(ws)
            job = json.loads(await ws.recv())["job"]
        await asyncio.sleep(0.2)
        self.assertEqual(project_store(self.tmp).get(job["id"]).status, "unknown")


if __name__ == "__main__":
    unittest.main()
