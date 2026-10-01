"""Read a Suno clip's public status: render state, title, type, length and packet fields.

The clip endpoint answers without a login, so the agent can check durations and
whether an export finished rendering without opening a browser or touching the
owner's session. No token, cookie or header of the owner's is ever sent.

The extra metadata fields (`tags`, `negative_tags`, `is_max_mode`,
`make_instrumental`) let a real generation's result be checked against the
packet that was sent (`check_packet_against_clips`).

    python bridge/goha_suno/suno_clip_status.py <clip-id> [<clip-id> ...]
"""

from __future__ import annotations

import json
import re
import sys
import urllib.request
from typing import Callable, NamedTuple

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


def check_packet_against_clips(wire_packet: dict, min_seconds: float, statuses: list[ClipStatus]) -> dict[str, dict]:
    """Compare Suno's own public clip metadata against the packet a real generation sent.

    `statuses` is what `check_clips` returns (or a stand-in with the same fields, for tests):
    one entry per clip id, in order, never raising for an individual clip's own fetch failure.
    """
    checks: dict[str, dict] = {}
    for status in statuses:
        if status.error is not None:
            checks[status.id] = {"ok": None, "mismatches": [], "unavailable": True}
            continue
        mismatches: list[str] = []
        # Suno v6 rewrites the Styles text server-side for every clip, so a different non-empty
        # text is expected and only noted; the extension already read the sent Styles back from
        # the form before clicking Create.
        styles_rewritten = bool(status.tags) and status.tags != wire_packet.get("styles")
        if not status.tags:
            mismatches.append("styles")
        if status.negative_tags != wire_packet.get("exclude"):
            mismatches.append("exclude")
        if bool(status.is_max_mode) != bool(wire_packet.get("maxMode")):
            mismatches.append("max_mode")
        if not status.make_instrumental:
            mismatches.append("instrumental")
        if status.seconds is None or status.seconds < min_seconds:
            mismatches.append("duration")
        check = {"ok": not mismatches, "mismatches": mismatches}
        if styles_rewritten:
            check["styles_rewritten"] = True
        checks[status.id] = check
    return checks


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    results = check_clips(sys.argv[1:])
    sys.stdout.write(json.dumps([result._asdict() for result in results], ensure_ascii=False, indent=2) + "\n")
    return 0 if all(result.error is None for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
