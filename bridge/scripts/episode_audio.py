"""Read an episode's audio: what Suno says about a file, and what is still missing.

Suno stamps every exported file with its own provenance. A downloaded WAV carries
a RIFF `LIST/INFO` comment like::

    made with suno; created=2026-09-17T10:52:52Z; id=2c5a7c03-ff32-4805-909e-b9908b7fe990

A Studio export says "made with suno studio" and carries the id of the *export*,
which is a new song, not the candidate it was rendered from. So an id resolves a
file either to a candidate in `music_test_results.yaml` or to nothing, and the
title is the fallback. When the JR Suno Helper did the export, its job file
(`<EP###>-suno-jobs.json`) records which candidate each export id came from, and
`taken_song_ids` / `rejected_song_ids` read that back. It is also the only reliable way to catch the same song
downloaded twice under two take numbers, because the audio is identical and the
filename is not.

The download naming contract is D034: `EP###.SS.T. <title_ja>.wav`.
"""

from __future__ import annotations

import contextlib
import json
import re
import wave
from pathlib import Path
from typing import Iterator, NamedTuple

import yaml

EPISODES_DIRNAME = "episodes"
ENCODING = "utf-8"
AUDIO_SUFFIXES = (".wav", ".mp3")

ALBUM_PLAN_FILENAME = "album_plan.yaml"
# Takes the owner listened to and replaced. They stay in the episode for
# comparison, so their ids must never be offered for download a second time.
REJECTED_DIRNAME = "rejected-takes"
# EP002 was filed by hand into this subfolder before takes lived at the episode root (D034).
LEGACY_TAKES_DIRNAME = "Audio Track"

# A take that lands far from its slot's target_seconds is not a take: Suno
# rendered something short, or the export caught a half-loaded timeline. Under
# this fraction the file is refused outright; past the tolerance it is filed
# with a warning, because a plan's target can legitimately be revised later.
TRUNCATED_BELOW = 0.8
DURATION_TOLERANCE = 0.05
MUSIC_TEST_FILENAME = "music_test_results.yaml"
# The JR Suno Helper's job list for one episode (`scripts/suno_jobs.py` writes it).
JOBS_SUFFIX = "-suno-jobs.json"
KIND_DOWNLOAD = "export_download"
# Multi-track exports (stems, or the free 32-bit float mix) of each take, git-ignored.
STEMS_DIRNAME = "stems"

# The INFO chunk sits near the front of the file, before the audio data.
METADATA_SCAN_BYTES = 64_000
# A library download says "made with suno"; a Studio export says "made with
# suno studio". That word is the only honest signal of which door the file came
# through, and it decides whether the download consumed the monthly quota.
SUNO_STAMP = re.compile(
    rb"made with suno(?P<studio> studio)?; created=(?P<created>[0-9T:\-Z]+); "
    rb"id=(?P<id>[0-9a-f-]{36})"
)

TAKE_FILENAME = re.compile(r"^(?P<ep>EP\d{3})\.(?P<slot>\d{2})\.(?P<take>\d)\. (?P<title>.+)$")

# `B15` is the first generation of slot 15; `B15v2` is the same slot generated
# again under a changed prompt. Both belong to slot 15, and the later one is the
# one to download.
BATCH_ID = re.compile(r"B(?P<slot>\d+)(?:v(?P<revision>\d+))?")

# D029: one published track is two takes of the same prompt, concatenated.
TAKES_PER_SLOT = 2


class SunoStamp(NamedTuple):
    """What the file itself says about where it came from."""

    song_id: str
    created_at: str  # ISO-8601 UTC, as written by Suno
    studio: bool  # exported from Suno Studio rather than downloaded from the library


class Candidate(NamedTuple):
    """One Suno generation offered for a slot."""

    slot: int
    batch_id: str
    candidate_id: str
    song_id: str
    url: str
    revision: int  # 1 for `B15`, 2 for `B15v2`: which generation of the prompt
    duration_actual: int | None  # seconds Suno actually rendered, once checked


class Take(NamedTuple):
    """One downloaded file sitting in the episode directory."""

    slot: int
    take: int
    path: Path
    stamp: SunoStamp | None


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
    return SunoStamp(
        match.group("id").decode(),
        match.group("created").decode(),
        bool(match.group("studio")),
    )


def find_episode_dir(root: Path, episode: str) -> Path:
    """Resolve an episode name or prefix (EP002) to its directory."""
    episodes_root = root / EPISODES_DIRNAME
    if not episodes_root.is_dir():
        raise FileNotFoundError(f"No {EPISODES_DIRNAME}/ directory under {root}")
    matches = sorted(
        d for d in episodes_root.iterdir() if d.is_dir() and d.name.startswith(episode)
    )
    if not matches:
        raise FileNotFoundError(f"No episode directory matching '{episode}'")
    if len(matches) > 1:
        raise ValueError(f"'{episode}' is ambiguous: {', '.join(d.name for d in matches)}")
    return matches[0]


def load_slot_titles(episode_dir: Path) -> dict[int, str]:
    """Slot number to title, stripped of the `EP###.SS.` prefix the plan carries."""
    plan = yaml.safe_load((episode_dir / ALBUM_PLAN_FILENAME).read_text(encoding=ENCODING))
    return {
        slot["slot_number"]: re.sub(r"^EP\d{3}\.\d{2}\.\s*", "", slot["title_ja"])
        for slot in plan["slots"]
    }


def load_slot_targets(episode_dir: Path) -> dict[int, int]:
    """Slot number to the runtime the album plan asks for, in seconds."""
    plan = yaml.safe_load((episode_dir / ALBUM_PLAN_FILENAME).read_text(encoding=ENCODING))
    return {
        slot["slot_number"]: slot["target_seconds"]
        for slot in plan["slots"]
        if isinstance(slot.get("target_seconds"), int)
    }


def audio_seconds(path: Path) -> float | None:
    """Length of a WAV in seconds, or None when the format cannot be read."""
    if path.suffix.lower() != ".wav":
        return None
    try:
        with contextlib.closing(wave.open(str(path))) as handle:
            return handle.getnframes() / handle.getframerate()
    except (wave.Error, OSError, ZeroDivisionError):
        return None


def _seconds(value: object) -> int | None:
    """Rendered length as whole seconds: numbers as-is, hand-typed "mm:ss" (EP001) parsed, anything else unchecked."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        match = re.fullmatch(r"\s*(\d+):([0-5]\d)\s*", value)
        if match:
            return int(match.group(1)) * 60 + int(match.group(2))
    return None


def load_candidates(episode_dir: Path) -> list[Candidate]:
    """Every generated candidate. Batch B07 belongs to slot 7, B07v2 as well.

    Within a slot the newest generation comes first, because a regenerated batch
    exists precisely because the earlier prompt produced something the owner did
    not want. Order inside a batch is left as recorded.
    """
    results = yaml.safe_load((episode_dir / MUSIC_TEST_FILENAME).read_text(encoding=ENCODING))
    candidates: list[Candidate] = []
    for batch in results.get("batches") or []:
        batch_id = batch.get("batch_id") or ""
        batch_match = BATCH_ID.fullmatch(batch_id)
        if not batch_match:
            continue
        for candidate in batch.get("candidates") or []:
            song_id = candidate.get("suno_song_id")
            if not song_id:
                continue
            candidates.append(
                Candidate(
                    slot=int(batch_match.group("slot")),
                    batch_id=batch_id,
                    candidate_id=candidate.get("candidate_id") or "?",
                    song_id=song_id,
                    url=candidate.get("suno_url") or "",
                    revision=int(batch_match.group("revision") or 1),
                    duration_actual=_seconds(candidate.get("duration_actual")),
                )
            )
    return sorted(candidates, key=lambda c: (c.slot, -c.revision))


def exported_candidates(episode_dir: Path) -> dict[str, str]:
    """Studio export id -> the candidate song id it was exported from.

    Read from the helper's finished download jobs. A Studio WAV only carries the
    export id, so without this a candidate already on disk looks untouched and is
    offered again, while its slot's other candidate is never reached. A file
    written before job kinds existed holds download jobs only.
    """
    path = episode_dir / f"{episode_dir.name.split('-')[0]}{JOBS_SUFFIX}"
    if not path.exists():
        return {}
    jobs = json.loads(path.read_text(encoding=ENCODING)).get("jobs", [])
    return {
        job["result"]["export_id"]: job["song_id"]
        for job in jobs
        if job.get("kind", KIND_DOWNLOAD) == KIND_DOWNLOAD
        and job.get("status") == "done"
        and (job.get("result") or {}).get("export_id")
        and job.get("song_id")
    }


def _source_song_ids(stamp_ids: set[str], exports: dict[str, str]) -> set[str]:
    """The stamped ids plus, for Studio exports, the candidates they came from."""
    return stamp_ids | {exports[song] for song in stamp_ids if song in exports}


def taken_song_ids(episode_dir: Path, takes: list[Take]) -> set[str]:
    """Candidate song ids already downloaded into the episode, however they were exported."""
    stamped = {take.stamp.song_id for take in takes if take.stamp}
    return _source_song_ids(stamped, exported_candidates(episode_dir))


def rejected_song_ids(episode_dir: Path) -> set[str]:
    """Song ids of takes the owner replaced, read from `rejected-takes/`.

    The verdict lives in where the file sits, not in a field: a take the owner
    turned down was moved here. Offering its id again would spend a download on
    audio already judged. A rejected Studio export rejects its candidate too.
    """
    rejected_dir = episode_dir / REJECTED_DIRNAME
    if not rejected_dir.is_dir():
        return set()
    stamps = (read_suno_stamp(path) for path in sorted(rejected_dir.iterdir())
              if path.suffix.lower() in AUDIO_SUFFIXES)
    stamped = {stamp.song_id for stamp in stamps if stamp}
    return _source_song_ids(stamped, exported_candidates(episode_dir))


def match_slot_by_title(stem: str, titles: dict[int, str]) -> int | None:
    """Resolve a downloaded file to a slot by its title.

    A Studio export is a new song whose id is in no record yet, but Suno names
    the file after the song title. Strip the `EP###.SS.` prefix the operator may
    have typed into Suno, and the ` (1)` the browser adds to a repeat download.
    """
    cleaned = re.sub(r"\s*\(\d+\)$", "", stem).strip()
    cleaned = re.sub(r"^EP\d{3}\.\d{2}\.\s*", "", cleaned).strip()
    for slot, title in titles.items():
        if cleaned == title.strip():
            return slot
    return None


def stems_dir_for(episode_dir: Path, slot: int, take: int) -> Path:
    """`stems/EP###.SS.T <title> Stems/` — the folder a take's Multitrack export is filed into."""
    title = load_slot_titles(episode_dir)[slot]
    return episode_dir / STEMS_DIRNAME / f"{episode_dir.name.split('-')[0]}.{slot:02d}.{take} {title} Stems"


def has_split_stems(episode_dir: Path, slot: int, take: int) -> bool:
    """The take's stems folder holds real split stems, not only the full mix a free 32-bit export files there."""
    folder = stems_dir_for(episode_dir, slot, take)
    return folder.is_dir() and sum(1 for _ in folder.glob("*.wav")) > 1


def take_filename(episode_id: str, slot: int, take: int, title: str, suffix: str = ".wav") -> str:
    """The D034 basename for one downloaded take."""
    return f"{episode_id.split('-')[0]}.{slot:02d}.{take}. {title}{suffix}"


def iter_takes(episode_dir: Path) -> Iterator[Take]:
    """Every downloaded take already sitting in the episode directory (or its legacy `Audio Track/`)."""
    legacy = episode_dir / LEGACY_TAKES_DIRNAME
    paths = sorted(episode_dir.iterdir()) + (sorted(legacy.iterdir()) if legacy.is_dir() else [])
    for path in paths:
        if path.suffix.lower() not in AUDIO_SUFFIXES:
            continue
        match = TAKE_FILENAME.match(path.stem)
        if not match:
            continue
        yield Take(
            slot=int(match.group("slot")),
            take=int(match.group("take")),
            path=path,
            stamp=read_suno_stamp(path),
        )


def duplicate_song_ids(takes: list[Take]) -> dict[str, list[Take]]:
    """Song ids that landed in more than one file: the same download, twice."""
    by_song: dict[str, list[Take]] = {}
    for take in takes:
        if take.stamp:
            by_song.setdefault(take.stamp.song_id, []).append(take)
    return {song: group for song, group in by_song.items() if len(group) > 1}


def missing_takes(takes: list[Take], slots: list[int]) -> dict[int, int]:
    """How many takes each slot still needs, counting duplicates as one take."""
    unique_per_slot: dict[int, set[str]] = {slot: set() for slot in slots}
    unstamped: dict[int, int] = {slot: 0 for slot in slots}
    for take in takes:
        if take.slot not in unique_per_slot:
            continue
        if take.stamp:
            unique_per_slot[take.slot].add(take.stamp.song_id)
        else:
            unstamped[take.slot] += 1
    return {
        slot: max(0, TAKES_PER_SLOT - len(unique_per_slot[slot]) - unstamped[slot])
        for slot in slots
    }
