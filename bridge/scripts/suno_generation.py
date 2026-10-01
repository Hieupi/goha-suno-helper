"""Turn an album_plan.yaml SUNO INPUT PACKET into a generation job, and record the result.

Three jobs live here, kept apart from the queue mechanics in `scripts/suno_jobs.py`:

  plan_generation_jobs   pick slots, compile each slot's packet to the wire shape
                          the extension fills the Create form from, refuse anything
                          this bridge does not support
  check_packet_against_clips  compare Suno's own public clip metadata against what
                          was sent, after a real generation finishes
  append_generation_batch  write the one new batch a finished real generation earns
                          into music_test_results.yaml, without touching a byte
                          already on disk

`validate_generation_packet` reuses `scripts/validate_suno.py` -- the same rules
`validate_project.py` runs over every packet in the repo -- so a generation job
never sends something already known to be malformed, and never invents a second
set of packet rules.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import yaml

from scripts.episode_audio import (
    ALBUM_PLAN_FILENAME,
    BATCH_ID,
    ENCODING,
    MUSIC_TEST_FILENAME,
    load_slot_targets,
)
from scripts.suno_jobs import GenerateJob, min_seconds_for, plan_download_jobs
from scripts.validate_suno import load_suno_constraints, validate_suno_packet
from scripts.validation_types import ERROR

# Suno's Duration slider moves in 5-second steps (measured 2026-09-27); the extension refuses the rest.
DURATION_STEP_SECONDS = 5

# The 12_MUSIC_QA_SCORECARD.md dimensions, used only when an episode's
# music_test_results.yaml has no prior batch to copy qa_scores keys from.
DEFAULT_QA_SCORE_KEYS = (
    "long_listening_comfort",
    "hero_instrument_quality",
    "low_distraction",
    "japanese_historical_identity",
    "emotional_beauty",
    "organic_non_generic",
    "mix_stability",
)


class PacketRejected(ValueError):
    """A SUNO INPUT PACKET failed validation, or asks for something this bridge cannot send."""


# `yaml.safe_dump` renders an empty list in flow style: `batches: []`. Matched
# as bytes so fixing it never runs the rest of the file through a text-mode
# encoder/newline translation.
_EMPTY_BATCHES_KEY = re.compile(rb"(?m)^batches:[ \t]*\[[ \t]*\][ \t]*(\r?\n|$)")


def wire_packet_from_album_plan(packet: dict[str, Any]) -> dict[str, Any]:
    """Map an album_plan.yaml `suno_packet` onto the wire shape the extension fills the form from."""
    lyrics = "" if packet.get("instrumental") else packet.get("lyrics", "")
    duration_seconds = packet.get("duration_seconds") if packet.get("duration_mode") == "custom" else None
    return {
        "title": packet["title"],
        "styles": packet["styles"],
        "exclude": packet["exclude"],
        "lyrics": lyrics,
        "model": packet["model"],
        "tab": packet["suno_ui_tab"],
        "durationSeconds": duration_seconds,
        "maxMode": packet["max_mode"],
        "variety": packet["variety"],
        "weirdness": packet["weirdness"],
        "styleInfluence": packet["style_influence"],
        "vocalGender": packet.get("vocal_gender"),
        "myTaste": bool((packet.get("magic_wand_my_taste") or {}).get("enabled")),
    }


def validate_generation_packet(packet: dict[str, Any], label: str, constraints: dict[str, int]) -> None:
    """Raise `PacketRejected` if the packet is malformed or unsupported here.

    Platform/policy errors come from the same checks `validate_project.py` runs.
    On top of those, a generation job refuses Inspo, Custom Model, and any
    non-empty lyrics: the extension only drives the instrumental Advanced-tab
    path that was measured in P2.
    """
    findings = validate_suno_packet(packet, label, constraints, compiled=True)
    errors = [finding.message for finding in findings if finding.severity == ERROR]
    if (packet.get("inspo") or {}).get("enabled"):
        errors.append(f"{label}.inspo.enabled is true -> generation jobs do not support Inspo")
    if (packet.get("custom_model") or {}).get("enabled"):
        errors.append(f"{label}.custom_model.enabled is true -> generation jobs do not support Custom Model")
    lyrics = packet.get("lyrics")
    if isinstance(lyrics, str) and lyrics.strip():
        errors.append(f"{label}.lyrics is not empty -> generation jobs only support instrumental packets")
    duration = packet.get("duration_seconds")
    if packet.get("duration_mode") == "custom" and isinstance(duration, int) and duration % DURATION_STEP_SECONDS:
        errors.append(f"{label}.duration_seconds={duration} is off Suno's {DURATION_STEP_SECONDS} s slider grid")
    if errors:
        raise PacketRejected("; ".join(errors))


def _load_album_plan(episode_dir: Path) -> dict:
    return yaml.safe_load((episode_dir / ALBUM_PLAN_FILENAME).read_text(encoding=ENCODING))


def _slot_entries(plan: dict) -> dict[int, tuple[int, dict]]:
    """Slot number -> (its index in `slots`, the slot dict), for `packet_ref` and lookup."""
    return {slot["slot_number"]: (index, slot) for index, slot in enumerate(plan.get("slots") or [])}


def _next_batch_id(episode_dir: Path, slot: int) -> str:
    """B<SS> if the slot has no batch yet, else B<SS>v<n+1> with n the highest existing revision.

    A bare `B06` counts as revision 1 (episode_audio.BATCH_ID's own convention),
    so a slot regenerated once already gets `B06v2`.
    """
    path = episode_dir / MUSIC_TEST_FILENAME
    max_revision = 0
    if path.exists():
        results = yaml.safe_load(path.read_text(encoding=ENCODING)) or {}
        for batch in results.get("batches") or []:
            match = BATCH_ID.fullmatch(batch.get("batch_id") or "")
            if match and int(match.group("slot")) == slot:
                max_revision = max(max_revision, int(match.group("revision") or 1))
    if max_revision == 0:
        return f"B{slot:02d}"
    return f"B{slot:02d}v{max_revision + 1}"


def plan_generation_jobs(
    episode_dir: Path, slots: list[int] | None = None, dry_run: bool = True
) -> list[GenerateJob]:
    """Jobs to fill (and maybe submit) the Create form for slots that need a fresh generation.

    Without `slots`, every slot `plan_download_jobs` reports short of usable
    candidates is planned -- the same rule the download worklist uses to decide
    a slot still needs work. Passing `slots` explicitly is how a deliberate
    regeneration of an already-covered slot is asked for.
    """
    plan = _load_album_plan(episode_dir)
    entries = _slot_entries(plan)
    targets = load_slot_targets(episode_dir)
    root = episode_dir.parent.parent
    constraints = load_suno_constraints(root)
    short_id = episode_dir.name.split("-")[0]

    if slots is None:
        _, short = plan_download_jobs(episode_dir)
        slots = sorted(short)

    jobs: list[GenerateJob] = []
    for slot in slots:
        entry = entries.get(slot)
        if entry is None:
            raise KeyError(f"slot {slot} is not in {episode_dir.name}'s {ALBUM_PLAN_FILENAME}")
        index, slot_data = entry
        packet = slot_data.get("suno_packet")
        if not isinstance(packet, dict):
            raise PacketRejected(f"slot {slot} has no suno_packet in {ALBUM_PLAN_FILENAME}")
        label = f"{episode_dir.name}:slots[{index}].suno_packet"
        validate_generation_packet(packet, label, constraints)
        batch_id = _next_batch_id(episode_dir, slot)
        jobs.append(
            GenerateJob(
                id=f"{short_id}.{slot:02d}.{batch_id}",
                episode=episode_dir.name,
                slot=slot,
                batch_id=batch_id,
                packet=wire_packet_from_album_plan(packet),
                dry_run=dry_run,
                min_seconds=min_seconds_for(targets.get(slot, 0)),
            )
        )
    return jobs


def check_packet_against_clips(wire_packet: dict[str, Any], min_seconds: float, statuses: list) -> dict[str, dict]:
    """Compare Suno's own public clip metadata against the packet a real generation sent.

    `statuses` is whatever `scripts.suno_clip_status.check_clips` returns (or a
    stand-in with the same fields, for tests): one entry per clip id, in order,
    never raising for an individual clip's own fetch failure.
    """
    checks: dict[str, dict] = {}
    for status in statuses:
        if status.error is not None:
            checks[status.id] = {"ok": None, "mismatches": [], "unavailable": True}
            continue
        mismatches: list[str] = []
        # Suno v6 rewrites the Styles text server-side for every clip (EP012, EP013),
        # so a different non-empty text is expected and only noted; the extension
        # already read the sent Styles back from the form before clicking Create.
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


def _existing_qa_keys(results: dict) -> tuple[str, ...]:
    """The qa_scores keys the file's own batches already use, so a new one matches them."""
    for batch in results.get("batches") or []:
        for candidate in batch.get("candidates") or []:
            scores = candidate.get("qa_scores")
            if isinstance(scores, dict) and scores:
                return tuple(scores.keys())
    return DEFAULT_QA_SCORE_KEYS


def _packet_check_note(check: dict) -> str:
    if check.get("unavailable"):
        return "Kiểm packet: không lấy được trạng thái clip từ endpoint công khai."
    mismatches = check.get("mismatches") or []
    if not mismatches and check.get("styles_rewritten"):
        return "Kiểm packet: khớp packet đã gửi (Styles do Suno v6 tự viết lại, bình thường)."
    if not mismatches:
        return "Kiểm packet: khớp packet đã gửi."
    return f"Kiểm packet: lệch {', '.join(mismatches)}."


def _candidate_record(job: GenerateJob, position: int, clip_id: str, qa_keys: list[str]) -> dict:
    seconds: dict = job.result.get("seconds") or {}
    checks: dict = job.result.get("packet_check") or {}
    duration = seconds.get(clip_id)
    return {
        "candidate_id": f"{job.batch_id}-C{position}",
        "suno_song_id": clip_id,
        "suno_url": f"https://suno.com/song/{clip_id}",
        "duration_actual": int(round(duration)) if isinstance(duration, (int, float)) else None,
        "qa_scores": {key: 0 for key in qa_keys},
        "qa_total": 0,
        "verdict": None,
        "rejection_flags": [],
        "notes_vi": _packet_check_note(checks.get(clip_id, {})),
    }


def _batch_record(episode_dir: Path, job: GenerateJob, generated_at: str, qa_keys: list[str]) -> dict:
    index = _slot_entries(_load_album_plan(episode_dir))[job.slot][0]
    clip_ids: list[str] = job.result.get("clip_ids") or []
    return {
        "batch_id": job.batch_id,
        "generated_at": generated_at,
        "model": job.packet.get("model"),
        "packet_ref": f"{ALBUM_PLAN_FILENAME}:slots[{index}].suno_packet",
        "changed_variable": None,
        "changed_from": None,
        "changed_to": None,
        "hypothesis_vi": f"Gen bởi JR Suno Helper qua Agent (job {job.id}).",
        "candidates": [_candidate_record(job, n, clip_id, qa_keys) for n, clip_id in enumerate(clip_ids, start=1)],
        "batch_conclusion": {
            "accepted_candidates": [],
            "dominant_failure_pattern": None,
            "next_single_variable": None,
            "next_variable_rationale_vi": "",
        },
        "generation_panel_observed": job.result.get("observed") or {},
    }


def _with_batch_appended(path: Path, raw: bytes, has_batches: bool, batch: dict) -> bytes:
    """The new file bytes: every existing byte kept, one block-style list item added."""
    if not has_batches:
        # An episode's very first batch: `batches: []` is flow-style, so a plain
        # append after it would trail a fully-closed document. Rewrite only that
        # one line's bytes so the appended block sequence attaches to `batches:`.
        fixed = _EMPTY_BATCHES_KEY.sub(lambda m: b"batches:" + m.group(1), raw, count=1)
        if fixed == raw:
            raise ValueError(f"{path}: batches is empty but not in the expected 'batches: []' form")
        raw = fixed
    if raw and not raw.endswith(b"\n"):
        raw += b"\n"  # an editor that strips the final newline must not glue the new item to the last line
    return raw + yaml.safe_dump([batch], allow_unicode=True, sort_keys=False).encode(ENCODING)


def append_generation_batch(episode_dir: Path, job: GenerateJob, generated_at: str) -> None:
    """Append the one batch a finished, real generation earns to music_test_results.yaml.

    Every byte already on disk -- including hand-edited notes -- is kept. The new
    document is built and parsed in memory first and replaces the file atomically,
    so a failure never leaves a half-written or invalid file behind.
    """
    path = episode_dir / MUSIC_TEST_FILENAME
    raw = path.read_bytes()
    results = yaml.safe_load(raw.decode(ENCODING)) or {}
    batch = _batch_record(episode_dir, job, generated_at, _existing_qa_keys(results))
    updated = _with_batch_appended(path, raw, bool(results.get("batches")), batch)
    yaml.safe_load(updated.decode(ENCODING))  # refuse to write anything the project could not read back
    staging = path.with_name(path.name + ".tmp")
    staging.write_bytes(updated)
    os.replace(staging, path)
