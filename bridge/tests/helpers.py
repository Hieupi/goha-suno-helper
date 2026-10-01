"""Shared test helpers: a paired fake extension talking straight to a BridgeCore, and project fixtures."""

import hashlib
import hmac
import os
import struct
import tempfile
from pathlib import Path

# No test ever reads or writes the real ~/GOHA-Suno projects.
os.environ["GOHA_SUNO_HOME"] = tempfile.mkdtemp(prefix="goha-suno-test-")
# Nor loads the dev machine's own plugin.
os.environ.pop("GOHA_SUNO_PLUGIN", None)

TOKEN = "t" * 43
CLIENT_NONCE = "a" * 64

SONG_A = "6f19dcde-f082-447d-a0d5-c6f74e4ac837"
SONG_B = "e833996d-cd17-47e3-be97-eb56e1380806"
TITLE_A = "冬の書斎、朝の静けさ"
TITLE_B = "Tinh Hà Độ Kiếm"
EXPORT_ID = "99999999-9999-4999-8999-999999999999"
CLIP_ID = "11111111-1111-4111-8111-111111111111"
PACKET = {"title": "Rain on the tea house", "styles": "lofi koto, soft rain, warm tape", "exclude": "vocals"}
PROJECT = "lofi"


def clock() -> str:
    return "2026-09-26T07:00:00Z"


def compute_proof(token: str, message: str) -> str:
    """The same HMAC-SHA256 the extension computes -- never the token itself."""
    return hmac.new(token.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).hexdigest()


def authenticate(core, nonce: str = CLIENT_NONCE, version: str | None = None, stopped: bool = False) -> list[dict]:
    """Run the full hello -> challenge -> auth exchange against a BridgeCore; return what the auth step drains."""
    from goha_suno.suno_bridge_core import BRIDGE_VERSION, PROTOCOL_VERSION

    core.on_connect()
    hello = {"type": "hello", "protocol": PROTOCOL_VERSION, "version": BRIDGE_VERSION if version is None else version, "nonce": nonce}
    if stopped:
        hello["stopped"] = True
    core.on_message(hello)
    challenge = core.drain()[0]
    proof = compute_proof(TOKEN, f"jr-suno/ext/{challenge['nonce']}/{nonce}")
    core.on_message({"type": "auth", "proof": proof})
    return core.drain()


def suno_clips(ids):
    """Suno's public clip endpoint as the two test songs see it (anything else: not found)."""
    from goha_suno.suno_clip_status import ClipStatus

    known = {SONG_A: (TITLE_A, 329.0), SONG_B: (TITLE_B, 330.0)}
    return [
        ClipStatus(i, "complete", *known[i], "gen", None, None, None, True, None) if i in known
        else ClipStatus(i, None, None, None, None, None, None, None, None, "HTTP 404")
        for i in ids
    ]


def make_core(tmp: Path, **kwargs):
    """A core whose projects live under `tmp/GOHA-Suno` and whose local state lives in `tmp/local`."""
    from goha_suno.suno_bridge_core import BridgeCore

    options = {"token": TOKEN, "now": clock, "local_dir": tmp / "local", "clip_status_fetch": suno_clips,
               "projects_root": tmp / "GOHA-Suno", **kwargs}
    return BridgeCore(**options)


def project_store(tmp: Path, project: str = PROJECT):
    """The project's job list as saved on disk right now."""
    from goha_suno.suno_jobs import JobStore

    return JobStore.at(tmp / "GOHA-Suno" / project / f"{project}-suno-jobs.json")


def write_suno_wav(path: Path, song_id: str, created: str = "2026-09-20T10:00:00Z", studio: bool = False) -> None:
    """A minimal WAV carrying the LIST/INFO comment Suno stamps on its exports."""
    maker = "suno studio" if studio else "suno"
    comment = f"made with {maker}; created={created}; id={song_id}\x00".encode()
    info = b"INFO" + b"ICMT" + struct.pack("<I", len(comment)) + comment
    fmt = struct.pack("<HHIIHH", 1, 2, 48000, 48000 * 4, 4, 16)
    audio = b"\x00" * 4 * 480
    body = (
        b"WAVE"
        + b"fmt " + struct.pack("<I", len(fmt)) + fmt
        + b"LIST" + struct.pack("<I", len(info)) + info
        + b"data" + struct.pack("<I", len(audio)) + audio
    )
    path.write_bytes(b"RIFF" + struct.pack("<I", len(body)) + body)
