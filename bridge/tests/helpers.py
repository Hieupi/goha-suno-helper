"""Shared test helpers: a paired fake extension talking straight to a BridgeCore."""

import hashlib
import hmac
import os
import tempfile

# No test ever reads or writes the real ~/GOHA-Suno projects.
os.environ["GOHA_SUNO_HOME"] = tempfile.mkdtemp(prefix="goha-suno-test-")

TOKEN = "t" * 43
CLIENT_NONCE = "a" * 64


def clock() -> str:
    return "2026-09-26T07:00:00Z"


def compute_proof(token: str, message: str) -> str:
    """The same HMAC-SHA256 the extension computes -- never the token itself."""
    return hmac.new(token.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).hexdigest()


def authenticate(core, nonce: str = CLIENT_NONCE, version: str | None = None, stopped: bool = False) -> list[dict]:
    """Run the full hello -> challenge -> auth exchange against a BridgeCore; return what the auth step drains."""
    from scripts.suno_bridge_core import BRIDGE_VERSION, PROTOCOL_VERSION

    core.on_connect()
    hello = {"type": "hello", "protocol": PROTOCOL_VERSION, "version": BRIDGE_VERSION if version is None else version, "nonce": nonce}
    if stopped:
        hello["stopped"] = True
    core.on_message(hello)
    challenge = core.drain()[0]
    proof = compute_proof(TOKEN, f"jr-suno/ext/{challenge['nonce']}/{nonce}")
    core.on_message({"type": "auth", "proof": proof})
    return core.drain()
