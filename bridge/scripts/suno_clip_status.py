"""Read a Suno clip's public status: render state, title, type, length and packet fields.

The clip endpoint answers without a login, so the agent can check durations and
whether an export finished rendering without opening a browser or touching the
owner's session. No token, cookie or header of the owner's is ever sent.

The extra metadata fields (`tags`, `negative_tags`, `is_max_mode`,
`make_instrumental`) let a real generation's result be checked against the
packet that was sent (`scripts.suno_generation.check_packet_against_clips`).

    python scripts/suno_clip_status.py <clip-id> [<clip-id> ...]
"""

from __future__ import annotations

import json
import re
import sys
import urllib.request
from pathlib import Path
from typing import Callable, NamedTuple

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

CLIP_ENDPOINT = "https://studio-api.prod.suno.com/api/clip/{}"
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
TIMEOUT_SECONDS = 15
# An honest name for this tool. Cloudflare turns away Python's default "Python-urllib"
# signature; this does not pretend to be a browser.
USER_AGENT = "goha-suno-helper-bridge/1.0 (read-only clip status)"

Fetch = Callable[[str], dict]


class ClipStatus(NamedTuple):
    id: str
    status: str | None
    title: str | None
    seconds: float | None
    type: str | None
    tags: str | None  # metadata.tags: the Styles box the generation was sent with
    negative_tags: str | None  # metadata.negative_tags: the Exclude box
    is_max_mode: bool | None
    make_instrumental: bool | None
    error: str | None


def _fetch_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: S310 - fixed https host
        return json.loads(response.read().decode("utf-8"))


def parse_clip(clip_id: str, data: dict) -> ClipStatus:
    """Pick the fields the pipeline acts on; anything else in the response is ignored."""
    if data.get("id") != clip_id:
        return ClipStatus(clip_id, None, None, None, None, None, None, None, None, "response is for a different clip")
    metadata = data.get("metadata") or {}
    duration = metadata.get("duration")
    seconds = float(duration) if isinstance(duration, (int, float)) else None
    return ClipStatus(
        clip_id,
        data.get("status"),
        data.get("title"),
        seconds,
        data.get("type"),
        metadata.get("tags"),
        metadata.get("negative_tags"),
        metadata.get("is_max_mode"),
        metadata.get("make_instrumental"),
        None,
    )


def check_clips(clip_ids: list[str], fetch: Fetch = _fetch_json) -> list[ClipStatus]:
    """One status per id, in order. A failure is reported on its row, never raised."""
    results: list[ClipStatus] = []
    for clip_id in clip_ids:
        if not UUID.fullmatch(clip_id):
            results.append(ClipStatus(clip_id, None, None, None, None, None, None, None, None, "not a clip id"))
            continue
        try:
            results.append(parse_clip(clip_id, fetch(CLIP_ENDPOINT.format(clip_id))))
        except (OSError, ValueError) as error:
            results.append(ClipStatus(clip_id, None, None, None, None, None, None, None, None, str(error)))
    return results


def main() -> int:
    from scripts.cli_output import ensure_utf8_stdout, write_stdout

    ensure_utf8_stdout()
    results = check_clips(sys.argv[1:])
    write_stdout(json.dumps([result._asdict() for result in results], ensure_ascii=False, indent=2) + "\n")
    return 0 if all(result.error is None for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
