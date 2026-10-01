"""Projects: jobs handed straight to the extension, with no other records behind them.

The user's AI agent names the songs (a Suno link or id) or the Create packet directly.
A project is just a folder under the projects root (`~/GOHA-Suno/<name>/` unless GOHA_SUNO_HOME says otherwise) holding the job list,
and each song or Create submission takes the next slot number in that project.

Every job is one of the four job kinds (download / generate / 32-bit export / stems split),
so the extension, the credit safety rules and the bridge treat them like any other job.
Packets are checked against Suno's own limits only.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Callable, Iterable

from goha_suno.suno_clip_status import ClipStatus, check_clips
from goha_suno.suno_jobs import JOBS_SUFFIX, DownloadJob, GenerateJob, JobStore, MultitrackJob, StemsJob

# Lower case only: Windows folders ignore case, so "Lofi" and "lofi" must never become two job lists on one file.
PROJECT_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,40}$")
WINDOWS_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}
HOME_ENV = "GOHA_SUNO_HOME"
# A song link (`suno.com/song/<id>`) or a bare id. Short share links (`suno.com/s/<code>`) hide the id and are refused.
SONG_ID_IN_TEXT = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)
# A Studio export can come back a fraction shorter than the song; refuse only a clearly cut-off one.
EXPORT_FLOOR = 0.95
FALLBACK_MIN_SECONDS = 1.0
# The Create form (extension lib/protocol.js validPacket): Suno's own limits, nothing channel-specific.
TEXT_MAX = 1000
TITLE_MAX = 300
DEFAULT_PACKET = {
    "model": "v6",
    "tab": "advanced",
    "durationSeconds": None,
    "maxMode": False,
    "variety": 2,
    "weirdness": 50,
    "styleInfluence": 50,
    "vocalGender": None,
    "myTaste": False,
}

ClipFetch = Callable[[list[str]], list[ClipStatus]]


class ProjectError(ValueError):
    """The request cannot become a job (bad name, bad song link, packet outside Suno's limits)."""


def projects_root(environ: "dict[str, str] | None" = None) -> Path:
    value = (os.environ if environ is None else environ).get(HOME_ENV, "").strip()
    return Path(value).expanduser() if value else Path.home() / "GOHA-Suno"


def is_project_name(name: object) -> bool:
    return isinstance(name, str) and bool(PROJECT_NAME.fullmatch(name)) and name not in WINDOWS_RESERVED


def check_project_name(name: str) -> str:
    if not is_project_name(name):
        raise ProjectError(
            f"tên dự án {name!r} không hợp lệ: 1–41 ký tự chữ thường không dấu, số, '-' hoặc '_' (ví dụ lofi-thang10)"
        )
    return name


def project_store(root: Path, name: str) -> JobStore:
    """The project's job list (created on first use), persisted as `<root>/<name>/<name>-suno-jobs.json`."""
    folder = root / check_project_name(name)
    folder.mkdir(parents=True, exist_ok=True)
    return JobStore.at(folder / f"{name}{JOBS_SUFFIX}")


def song_ids(songs: Iterable[str]) -> list[str]:
    """Suno song ids, in order and without repeats, from song links or bare ids."""
    ids: list[str] = []
    for song in songs:
        text = str(song).strip()
        match = SONG_ID_IN_TEXT.search(text)
        if not match:
            raise ProjectError(f"không đọc được id bài Suno trong {text[:120]!r} — dùng link dạng suno.com/song/<id>")
        song_id = match.group(0).lower()
        if song_id not in ids:
            ids.append(song_id)
    if not ids:
        raise ProjectError("chưa có bài nào")
    return ids


def _next_slot(store: JobStore) -> int:
    return max((job.slot for job in store.jobs), default=0) + 1


def _slot_of_song(store: JobStore, song_id: str) -> int | None:
    """The slot this song already holds in the project: asking again for the same song reuses it."""
    return next((job.slot for job in store.jobs if getattr(job, "song_id", None) == song_id), None)


def _clip_facts(ids: list[str], fetch: ClipFetch) -> dict[str, ClipStatus]:
    facts = {status.id: status for status in fetch(ids)}
    missing = [i for i in ids if facts.get(i) is None or facts[i].error or not facts[i].title]
    if missing:
        raise ProjectError(f"không đọc được thông tin bài trên Suno: {', '.join(missing)} (link sai, hoặc bài đang để riêng tư)")
    unfinished = [i for i in ids if facts[i].status != "complete"]
    if unfinished:
        raise ProjectError(f"bài chưa tạo xong trên Suno: {', '.join(unfinished)} — đợi Suno tạo xong rồi giao lại")
    return facts


def _min_seconds(status: ClipStatus) -> float:
    return round(status.seconds * EXPORT_FLOOR, 1) if status.seconds else FALLBACK_MIN_SECONDS


def plan_song_jobs(store: JobStore, project: str, songs: Iterable[str], kind: str, dry_run: bool = True,
                   fetch: ClipFetch = check_clips) -> list:
    """Download / 32-bit export / stems jobs for named songs, one slot per song in this project."""
    ids = song_ids(songs)
    facts = _clip_facts(ids, fetch)
    next_slot = _next_slot(store)
    jobs = []
    for song_id in ids:
        slot = _slot_of_song(store, song_id)
        if slot is None:
            slot, next_slot = next_slot, next_slot + 1
        title, floor = facts[song_id].title.strip()[:TITLE_MAX], _min_seconds(facts[song_id])
        prefix = f"{project}.{slot:02d}"
        if kind == "download":
            jobs.append(DownloadJob(id=f"{prefix}.{song_id}", episode=project, slot=slot, candidate_id=song_id,
                                    song_id=song_id, expected_title=title, min_seconds=floor))
        elif kind == "multitrack":
            jobs.append(MultitrackJob(id=f"{prefix}.MT1", episode=project, slot=slot, take=1, song_id=song_id,
                                      expected_title=title, min_seconds=floor))
        elif kind == "stems":
            jobs.append(StemsJob(id=f"{prefix}.ST1", episode=project, slot=slot, take=1, song_id=song_id,
                                 expected_title=title, min_seconds=floor, dry_run=dry_run))
        else:
            raise ProjectError(f"loại việc lạ: {kind!r}")
    return jobs


def packet_problems(packet: dict) -> list[str]:
    """Where a Create packet leaves Suno's own limits (the same checks the extension makes before filling the form)."""
    problems = []

    def text(key: str, limit: int, required: bool) -> None:
        value = packet.get(key)
        if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
            problems.append(f"{key}: {'bắt buộc, ' if required else ''}tối đa {limit} ký tự")

    def integer(key: str, low: int, high: int) -> None:
        value = packet.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
            problems.append(f"{key}: số nguyên {low}–{high}")

    text("title", TITLE_MAX, True)
    text("styles", TEXT_MAX, True)
    text("exclude", TEXT_MAX, False)
    if packet.get("lyrics") != "":
        problems.append("lyrics: bản này chỉ tạo nhạc không lời (để trống)")
    if not re.fullmatch(r"v\d[\w.-]*", str(packet.get("model"))):
        problems.append("model: dạng v6, v5.5…")
    if packet.get("tab") != "advanced":
        problems.append("tab: chỉ hỗ trợ advanced")
    duration = packet.get("durationSeconds")
    if duration is not None and (not isinstance(duration, int) or isinstance(duration, bool)
                                 or not 10 <= duration <= 360 or duration % 5):
        problems.append("durationSeconds: bỏ trống (Suno tự chọn) hoặc 10–360, bước 5 giây")
    for key in ("maxMode", "myTaste"):
        if not isinstance(packet.get(key), bool):
            problems.append(f"{key}: true/false")
    integer("variety", 0, 4)
    integer("weirdness", 0, 100)
    integer("styleInfluence", 0, 100)
    if packet.get("vocalGender") not in (None, "male", "female"):
        problems.append("vocalGender: bỏ trống, male hoặc female")
    return problems


def plan_generation(store: JobStore, project: str, packet: dict, count: int = 1, dry_run: bool = True) -> list[GenerateJob]:
    """`count` Create submissions of one packet (each makes two songs on Suno), one slot each."""
    full = {**DEFAULT_PACKET, "exclude": "", "lyrics": "", **packet}
    problems = packet_problems(full)
    if problems:
        raise ProjectError("packet vượt giới hạn của Suno: " + "; ".join(problems))
    if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 10:
        raise ProjectError("count: 1–10 lần Create mỗi lượt")
    floor = max(float(full["durationSeconds"]) - 10, FALLBACK_MIN_SECONDS) if full["durationSeconds"] else FALLBACK_MIN_SECONDS
    first = _next_slot(store)
    return [
        GenerateJob(id=f"{project}.{slot:02d}.B{slot:02d}", episode=project, slot=slot, batch_id=f"B{slot:02d}",
                    packet=dict(full), dry_run=dry_run, min_seconds=floor)
        for slot in range(first, first + count)
    ]

