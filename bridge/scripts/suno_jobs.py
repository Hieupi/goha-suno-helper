"""Jobs the agent hands to the JR Suno Helper extension.

Four kinds share one queue and one file. A `DownloadJob` is one candidate to
Studio-export and download as WAV; the plan comes from the same records the
worklist and the handoff read (`choose_candidates`), so the episode's own data
stays the single source of truth. A `GenerateJob` is one Suno Create submission
filled from a compiled SUNO INPUT PACKET (`scripts/suno_generation.py` builds
and validates it); real (non-dry-run) generation spends Suno credits. A
`MultitrackJob` re-exports a filed take from Studio as a 32-bit float ZIP (free).
A `StemsJob` splits a filed take into stems on Suno (Auto split, 50 credits when
not dry-run) and exports the mix plus every stem as one 32-bit float ZIP.

Jobs are immutable values; `JobStore` swaps a whole job for its successor on every
transition and persists the list next to the episode as `<EP###>-suno-jobs.json`.
A job the extension was working on when the link dropped becomes `unknown` and is
never retried by itself: exporting the same candidate twice creates a duplicate
song on Suno, and a real generation left `unknown` may already have spent
credits, so only the agent (or the owner) may requeue it.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path

from scripts.episode_audio import (
    ENCODING,
    JOBS_SUFFIX,
    KIND_DOWNLOAD,
    has_split_stems,
    iter_takes,
    stems_dir_for,
    TRUNCATED_BELOW,
    load_slot_targets,
    load_slot_titles,
)
from scripts.export_download_handoff import choose_candidates

SCHEMA_VERSION = 1
# The owner accepts 320-330 s for a 330 s slot: ten seconds under target at most.
OWNER_MARGIN_SECONDS = 10

KIND_GENERATE = "generate"
# Studio → Export → Multitrack of a take already filed: its full mix as 48 kHz / 32-bit float (0 credits,
# no monthly quota) until stems are split, then every stem. Seen on Suno 2026-09-28.
KIND_MULTITRACK = "multitrack_export"
# Suno "Extract Stems and MIDI" → Auto split (50 credits, measured 2026-10-01), then Studio → Export →
# Multitrack of the split project: the mix and every stem as 48 kHz / 32-bit float in one ZIP.
KIND_STEMS = "stems_split"

IN_FLIGHT = frozenset({"sent", "running"})
REQUEUEABLE = frozenset({"failed", "needs_human", "unknown", "cancelled"})
TRANSITIONS: dict[str, frozenset[str]] = {
    "queued": frozenset({"sent", "cancelled"}),
    "sent": frozenset({"running", "done", "failed", "needs_human", "unknown", "cancelled"}),
    "running": frozenset({"done", "failed", "needs_human", "unknown", "cancelled"}),
    "done": frozenset(),
    "failed": frozenset(),
    "needs_human": frozenset(),
    "unknown": frozenset(),
    "cancelled": frozenset(),
}
STATUSES = frozenset(TRANSITIONS)


class JobTransitionError(ValueError):
    """A job was asked to move somewhere its state machine does not allow."""


@dataclass(frozen=True)
class DownloadJob:
    """One candidate to export in Studio and download as WAV."""

    id: str
    episode: str
    slot: int
    candidate_id: str
    song_id: str
    expected_title: str
    min_seconds: float
    kind: str = KIND_DOWNLOAD
    status: str = "queued"
    created_at: str = ""
    updated_at: str = ""
    result: dict = field(default_factory=dict)

    def to_wire(self) -> dict:
        """What the extension receives: no paths, no secrets, nothing it does not act on.

        A job that already exported (its `export_id` survived a requeue) resumes from that
        export instead of exporting the candidate a second time.
        """
        wire = {
            "id": self.id,
            "kind": "export_download",
            "episode": self.episode,
            "slot": self.slot,
            "candidateId": self.song_id,
            "expectedTitle": self.expected_title,
            "minSeconds": self.min_seconds,
        }
        if self.result.get("export_id"):
            wire["exportId"] = self.result["export_id"]
        return wire


@dataclass(frozen=True)
class GenerateJob:
    """One Suno Create submission, filled from a compiled SUNO INPUT PACKET.

    `packet` is already in the wire shape the extension fills the Create form
    from (`scripts.suno_generation.wire_packet_from_album_plan`), not the
    album_plan.yaml packet shape. `dry_run=True` fills and reads back the form
    without pressing Create, so it never spends a credit; `dry_run=False` does,
    and the state machine below refuses to hand out a second real submission
    for a slot until the agent (or the owner) decides what happened to the
    first one.
    """

    id: str
    episode: str
    slot: int
    batch_id: str
    packet: dict
    dry_run: bool
    min_seconds: float
    kind: str = KIND_GENERATE
    status: str = "queued"
    created_at: str = ""
    updated_at: str = ""
    result: dict = field(default_factory=dict)

    def to_wire(self) -> dict:
        """What the extension receives to fill and (maybe) submit the Create form."""
        return {
            "id": self.id,
            "kind": "generate",
            "episode": self.episode,
            "slot": self.slot,
            "batchId": self.batch_id,
            "dryRun": self.dry_run,
            "minSeconds": self.min_seconds,
            "packet": self.packet,
        }


@dataclass(frozen=True)
class MultitrackJob:
    """One filed take to export again from Studio as a Multitrack ZIP (32-bit float WAV inside)."""

    id: str
    episode: str
    slot: int
    take: int
    song_id: str  # the id stamped on the filed WAV: that song opens in Studio as it is
    expected_title: str
    min_seconds: float
    kind: str = KIND_MULTITRACK
    status: str = "queued"
    created_at: str = ""
    updated_at: str = ""
    result: dict = field(default_factory=dict)

    def to_wire(self) -> dict:
        return {
            "id": self.id,
            "kind": KIND_MULTITRACK,
            "episode": self.episode,
            "slot": self.slot,
            "take": self.take,
            "candidateId": self.song_id,
            "expectedTitle": self.expected_title,
            "minSeconds": self.min_seconds,
        }


@dataclass(frozen=True)
class StemsJob:
    """One filed take to split into stems on Suno and export (mix + stems) as a 32-bit float ZIP.

    `dry_run=True` only opens Suno's stem dialog and reports whether the take was split
    already; `dry_run=False` presses Extract when it was not, which spends credits. Once a
    run reached that click the job remembers it (`spent` / `earlier_spent`), and every later
    attempt tells the extension `alreadySpent` so it never presses Extract a second time.
    """

    id: str
    episode: str
    slot: int
    take: int
    song_id: str
    expected_title: str
    min_seconds: float
    dry_run: bool
    kind: str = KIND_STEMS
    status: str = "queued"
    created_at: str = ""
    updated_at: str = ""
    result: dict = field(default_factory=dict)

    @property
    def already_spent(self) -> bool:
        return bool(self.result.get("spent") or self.result.get("earlier_spent"))

    def to_wire(self) -> dict:
        wire = {
            "id": self.id,
            "kind": KIND_STEMS,
            "episode": self.episode,
            "slot": self.slot,
            "take": self.take,
            "candidateId": self.song_id,
            "expectedTitle": self.expected_title,
            "minSeconds": self.min_seconds,
            "dryRun": self.dry_run,
        }
        if self.already_spent:
            wire["alreadySpent"] = True
        return wire


def plan_stems_jobs(
    episode_dir: Path, slots: "list[int]", takes: "list[int] | None" = None, dry_run: bool = True
) -> "list[StemsJob]":
    """One job per filed take (with a Suno stamp) of the named slots that has no split stems filed yet.

    Slots are required: splitting costs credits per song, so there is no "every slot" default.
    A stems folder holding only the mix (a free 32-bit export) does not count as split.
    """
    if not slots:
        raise ValueError("name the slots to split; splitting spends Suno credits per song")
    titles = load_slot_titles(episode_dir)
    targets = load_slot_targets(episode_dir)
    short_id = episode_dir.name.split("-")[0]
    jobs = []
    for take in sorted(iter_takes(episode_dir), key=lambda t: (t.slot, t.take)):
        if take.stamp is None or take.slot not in titles or take.slot not in slots:
            continue
        if (takes is not None and take.take not in takes) or has_split_stems(episode_dir, take.slot, take.take):
            continue
        jobs.append(
            StemsJob(
                id=f"{short_id}.{take.slot:02d}.ST{take.take}",
                episode=episode_dir.name,
                slot=take.slot,
                take=take.take,
                song_id=take.stamp.song_id,
                expected_title=titles[take.slot],
                min_seconds=min_seconds_for(targets.get(take.slot, 0)),
                dry_run=dry_run,
            )
        )
    return jobs


def plan_multitrack_jobs(episode_dir: Path, slots: "list[int] | None" = None) -> "list[MultitrackJob]":
    """One job per filed take (with a Suno stamp) whose `stems/` folder does not exist yet."""
    titles = load_slot_titles(episode_dir)
    targets = load_slot_targets(episode_dir)
    short_id = episode_dir.name.split("-")[0]
    jobs = []
    for take in sorted(iter_takes(episode_dir), key=lambda t: (t.slot, t.take)):
        if take.stamp is None or take.slot not in titles or (slots is not None and take.slot not in slots):
            continue
        if stems_dir_for(episode_dir, take.slot, take.take).exists():
            continue
        jobs.append(
            MultitrackJob(
                id=f"{short_id}.{take.slot:02d}.MT{take.take}",
                episode=episode_dir.name,
                slot=take.slot,
                take=take.take,
                song_id=take.stamp.song_id,
                expected_title=titles[take.slot],
                min_seconds=min_seconds_for(targets.get(take.slot, 0)),
            )
        )
    return jobs


def min_seconds_for(target_seconds: int) -> float:
    """Shortest render worth downloading: the owner's floor, never below the code's truncation line."""
    return max(target_seconds - OWNER_MARGIN_SECONDS, target_seconds * TRUNCATED_BELOW)


def plan_download_jobs(episode_dir: Path) -> tuple[list[DownloadJob], dict[int, int]]:
    """Jobs for every missing take, and the slots that lack enough usable candidates.

    Each slot gets exactly as many jobs as it is missing takes, taken in the
    order `choose_candidates` ranks them (newest regeneration first).
    """
    usable, needed = choose_candidates(episode_dir)
    titles = load_slot_titles(episode_dir)
    targets = load_slot_targets(episode_dir)
    short_id = episode_dir.name.split("-")[0]
    jobs: list[DownloadJob] = []
    short: dict[int, int] = {}
    for slot, count in sorted(needed.items()):
        chosen = usable.get(slot, [])[:count]
        if len(chosen) < count:
            short[slot] = count - len(chosen)
        for candidate in chosen:
            jobs.append(
                DownloadJob(
                    id=f"{short_id}.{slot:02d}.{candidate.song_id}",
                    episode=episode_dir.name,
                    slot=slot,
                    candidate_id=candidate.candidate_id,
                    song_id=candidate.song_id,
                    expected_title=titles[slot],
                    min_seconds=min_seconds_for(targets.get(slot, 0)),
                )
            )
    return jobs, short


def _check_result(kind: str, status: str, result: dict) -> None:
    if kind == KIND_GENERATE:
        if status == "done" and result.get("dry_run") is False:
            clip_ids = result.get("clip_ids")
            if not isinstance(clip_ids, list) or not clip_ids:
                raise JobTransitionError(
                    "a finished real generation job must report at least one clip id "
                    "(credits were spent; never leave that unrecorded)"
                )
        return
    if kind == KIND_MULTITRACK:
        if status == "done" and not str(result.get("filename", "")).lower().endswith(".zip"):
            raise JobTransitionError("a finished multitrack job must report the ZIP it downloaded")
        return
    if kind == KIND_STEMS:
        if status == "done" and result.get("dry_run") is False and not str(result.get("filename", "")).lower().endswith(".zip"):
            raise JobTransitionError("a finished stems job must report the ZIP it downloaded")
        return
    if status == "done" and not (result.get("export_id") and result.get("filename")):
        raise JobTransitionError("a finished download job must report export_id and filename")


def _job_from_dict(data: dict) -> "DownloadJob | GenerateJob":
    """Rebuild the right dataclass; a file written before v2 has no `kind` at all."""
    if data.get("kind") == KIND_GENERATE:
        return GenerateJob(**data)
    if data.get("kind") == KIND_MULTITRACK:
        return MultitrackJob(**data)
    if data.get("kind") == KIND_STEMS:
        return StemsJob(**data)
    return DownloadJob(**data)


# os.replace on a job file another process has open fails on Windows; it is free again within milliseconds.
SAVE_ATTEMPTS = 10
SAVE_RETRY_SECONDS = 0.05


class JobStore:
    """The job list of one episode, persisted as JSON beside the episode's records."""

    def __init__(self, path: Path, jobs: "tuple[DownloadJob | GenerateJob, ...]" = ()):
        self.path = path
        self.jobs: "tuple[DownloadJob | GenerateJob, ...]" = jobs

    @classmethod
    def for_episode(cls, episode_dir: Path) -> "JobStore":
        return cls.at(episode_dir / f"{episode_dir.name.split('-')[0]}{JOBS_SUFFIX}")

    @classmethod
    def at(cls, path: Path) -> "JobStore":
        """The job list saved at `path` (an episode's or a project's), empty when the file does not exist yet."""
        if not path.exists():
            return cls(path)
        data = json.loads(path.read_text(encoding=ENCODING))
        return cls(path, tuple(_job_from_dict(job) for job in data.get("jobs", [])))

    def save(self) -> None:
        """Write beside the file, then swap it in: a crash mid-write never leaves half a job list."""
        payload = {"schema_version": SCHEMA_VERSION, "jobs": [asdict(job) for job in self.jobs]}
        temp = self.path.with_name(self.path.name + ".tmp")
        temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding=ENCODING)
        try:
            for attempt in range(SAVE_ATTEMPTS):
                try:
                    os.replace(temp, self.path)
                    break
                except PermissionError:
                    # Windows: a reader (the agent, an indexer) holds the file for a moment. Try again shortly.
                    if attempt == SAVE_ATTEMPTS - 1:
                        raise
                    time.sleep(SAVE_RETRY_SECONDS)
        except OSError:
            temp.unlink(missing_ok=True)
            raise

    def get(self, job_id: str) -> "DownloadJob | GenerateJob":
        for job in self.jobs:
            if job.id == job_id:
                return job
        raise KeyError(job_id)

    def _swap(self, updated: "DownloadJob | GenerateJob") -> "DownloadJob | GenerateJob":
        self.jobs = tuple(updated if job.id == updated.id else job for job in self.jobs)
        return updated

    def enqueue(
        self, planned: "list[DownloadJob | GenerateJob]", now: str
    ) -> "tuple[list[DownloadJob | GenerateJob], list[DownloadJob | GenerateJob]]":
        """Add planned jobs not already present. Returns (added, skipped)."""
        known = {job.id for job in self.jobs}
        added = [replace(job, status="queued", created_at=now, updated_at=now) for job in planned if job.id not in known]
        skipped = [job for job in planned if job.id in known]
        self.jobs = self.jobs + tuple(added)
        return added, skipped

    def forget_finished_dry_runs(self, job_ids: "set[str]") -> None:
        """Drop finished dry-run generate / stems jobs with these ids so the same job can be queued again.

        A dry run fills Suno's Create form and reads it back but never clicks
        Create, so a finished one records nothing that must survive. The usual
        flow is dry run, owner agrees, real run — both carry the same batch id.
        Real generate jobs and anything still queued or out are never touched.
        """
        self.jobs = tuple(
            job
            for job in self.jobs
            if not (
                job.id in job_ids
                and job.kind in (KIND_GENERATE, KIND_STEMS)
                and job.dry_run
                and job.status not in {"queued", *IN_FLIGHT}
            )
        )

    def next_queued(self) -> "DownloadJob | GenerateJob | None":
        return next((job for job in self.jobs if job.status == "queued"), None)

    def transition(self, job_id: str, status: str, now: str, result: dict | None = None) -> "DownloadJob | GenerateJob":
        if status not in STATUSES:
            raise JobTransitionError(f"unknown status {status!r}")
        job = self.get(job_id)
        if status not in TRANSITIONS[job.status]:
            raise JobTransitionError(f"{job.id}: {job.status} -> {status} is not allowed")
        merged = {**job.result, **(result or {})}
        _check_result(job.kind, status, merged)
        return self._swap(replace(job, status=status, updated_at=now, result=merged))

    def annotate(self, job_id: str, now: str, result: dict) -> "DownloadJob | GenerateJob":
        """Record progress on a job without moving it (e.g. the step it reached)."""
        job = self.get(job_id)
        return self._swap(replace(job, updated_at=now, result={**job.result, **result}))

    def requeue(self, job_id: str, now: str) -> "DownloadJob | GenerateJob":
        """Put a stopped job back in line. Only the agent or the owner decides this."""
        job = self.get(job_id)
        if job.status not in REQUEUEABLE:
            raise JobTransitionError(f"{job.id}: {job.status} cannot be requeued")
        # Clips an earlier real attempt already spent credits on stay on record for good.
        spent = list(dict.fromkeys([*job.result.get("earlier_clip_ids", []), *job.result.get("clip_ids", [])]))
        kept: dict = {"earlier_clip_ids": spent} if spent else {}
        # A download that already exported keeps that export: the retry downloads it, never re-exports.
        if job.kind == KIND_DOWNLOAD and job.result.get("export_id"):
            kept["export_id"] = job.result["export_id"]
        # A stems split that already pressed Extract never presses it again (the extension is told `alreadySpent`).
        if job.kind == KIND_STEMS and job.already_spent:
            kept["earlier_spent"] = True
        return self._swap(replace(job, status="queued", updated_at=now, result=kept))

    def mark_in_flight_unknown(self, now: str) -> "list[DownloadJob | GenerateJob]":
        """The link dropped: whatever was out with the extension is now of unknown fate."""
        changed = [
            replace(job, status="unknown", updated_at=now, result={**job.result, "reason": "link_lost"})
            for job in self.jobs
            if job.status in IN_FLIGHT
        ]
        for job in changed:
            self._swap(job)
        return changed
