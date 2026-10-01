"""What a downloaded Suno file says about itself: the stamp inside it and the title in its name.

Suno stamps every exported file with its own provenance. A downloaded WAV carries
a RIFF `LIST/INFO` comment like::

    made with suno; created=2026-09-17T10:52:52Z; id=2c5a7c03-ff32-4805-909e-b9908b7fe990

A Studio export says "made with suno studio" and carries the id of the *export*,
which is a new song, not the one it was rendered from. Suno names the file after
the song title; the browser adds ` (1)` to a repeat download.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import NamedTuple

# The INFO chunk sits near the front of the file, before the audio data.
METADATA_SCAN_BYTES = 64_000
# A library download says "made with suno"; a Studio export says "made with suno studio".
SUNO_STAMP = re.compile(
    rb"made with suno(?P<studio> studio)?; created=(?P<created>[0-9T:\-Z]+); "
    rb"id=(?P<id>[0-9a-f-]{36})"
)
BROWSER_REPEAT_SUFFIX = re.compile(r"\s*\(\d+\)$")


class SunoStamp(NamedTuple):
    """What the file itself says about where it came from."""

    song_id: str
    created_at: str  # ISO-8601 UTC, as written by Suno
    studio: bool  # exported from Suno Studio rather than downloaded from the library


def read_suno_stamp(path: Path) -> SunoStamp | None:
    """Return the Suno id and creation time embedded in an exported file."""
    try:
        with path.open("rb") as handle:
            head = handle.read(METADATA_SCAN_BYTES)
    except OSError:
        return None
    match = SUNO_STAMP.search(head)
    if not match:
        return None
    return SunoStamp(match.group("id").decode(), match.group("created").decode(), bool(match.group("studio")))


def title_matches(stem: str, title: str) -> bool:
    """A downloaded file's name (without extension) is the song's title, maybe with the browser's ` (N)`."""
    return BROWSER_REPEAT_SUFFIX.sub("", stem).strip() == title.strip()
