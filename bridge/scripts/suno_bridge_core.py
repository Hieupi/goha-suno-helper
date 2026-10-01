"""The bridge between the agent and the JR Suno Helper extension, without the sockets.

`BridgeCore` owns the job queue of every episode the agent touched, speaks the
extension's JSON protocol, and hands out one job at a time. The WebSocket server
(`scripts/suno_agent_bridge.py`) only moves messages in and out of it, so every
rule here is testable without a browser.

Protocol v2 (one JSON object per message; `PROTOCOL_VERSION` must match
`lib/protocol.js`'s on the extension side). Pairing is a mutual HMAC-SHA256
handshake: the pairing token itself never crosses the socket.
  extension -> bridge: hello{protocol, version, nonce, stopped?} · auth{proof}
                       progress{jobId, step}
                       result{jobId, status, exportId?, filename?, path?, seconds?, reason?,
                               dryRun?, observed?, clipIds?, mismatches?}
                       orphan{jobId, phase, clipIds?} · alert{kind} · heartbeat{phase} ·
                       control{action: "resume"} (the owner's "Chạy tiếp" button)
  bridge -> extension: challenge{nonce, proof} · welcome · job{job} · cancel{jobId} ·
                       queue{paused, episodes[{episode, jobs[{id, kind, slot, status, step,
                             reason, title, at}]}]} · error{message} · close ·
                       reload (sent instead of a job when the extension is an older version)

`queue` is a picture of every job this bridge knows, sent after auth and
whenever it changes (`queue_update`), so the side panel can draw a whole
episode's progress; the extension itself only ever holds the job it runs.

`orphan` recovers clip ids after the extension's service worker restarts mid
Create-click (the socket drop already marked the job `unknown`): it never
changes the job's status, only merges `clipIds` into its result -- a job
recorded that way still needs the agent or the owner to decide whether to
requeue it.

hello carries a fresh 32-byte `nonce` (64 lowercase hex chars) and no secret.
The bridge answers with its own `nonce` and a `proof` = HMAC-SHA256(token,
f"jr-suno/bridge/{client_nonce}/{server_nonce}"), proving it holds the token
without sending it. The extension replies `auth` with its own
`proof` = HMAC-SHA256(token, f"jr-suno/ext/{server_nonce}/{client_nonce}"),
checked with `hmac.compare_digest`; only a match sets `connected = True` and
sends `welcome`. A hello with the wrong protocol or a malformed nonce, or an
`auth` whose proof does not match, is refused (error + close) immediately.

A download job's `result` carries `exportId`/`filename`; a generate job's
carries `dryRun`/`observed`/`clipIds`/`seconds`/`mismatches` -- both may carry
`reason`. A generate result after the Create click always keeps `clipIds`
(credits were spent even on a `failed` or `needs_human` result); a `failed`
result whose extension-side form readback did not match the packet sent
carries `mismatches` (field names) and `reason: "form_mismatch"`.

The absolute download path (`C:\\Users\\<name>\\...`) never goes into the episode's
tracked jobs file: only the folder is kept, in `local_dir` outside the repository.
"""

from __future__ import annotations

import hashlib
from datetime import datetime
import hmac
import json
import os
import re
import secrets
from pathlib import Path
from typing import Callable, Mapping

import yaml

from scripts.episode_audio import find_episode_dir, load_slot_titles, match_slot_by_title, read_suno_stamp
from scripts.suno_clip_status import UUID as CLIP_UUID_PATTERN
from scripts.suno_clip_status import ClipStatus, check_clips
from scripts.suno_generation import append_generation_batch, check_packet_against_clips, plan_generation_jobs
from scripts.suno_projects import ProjectError, is_episode_name, plan_generation as plan_project_generation
from scripts.suno_projects import plan_song_jobs, project_store
from scripts.suno_projects import projects_root as default_projects_root
from scripts.suno_jobs import (
    IN_FLIGHT,
    JOBS_SUFFIX,
    KIND_DOWNLOAD,
    KIND_GENERATE,
    KIND_MULTITRACK,
    KIND_STEMS,
    JobStore,
    JobTransitionError,
    plan_download_jobs,
    plan_multitrack_jobs,
    plan_stems_jobs,
)

PROTOCOL_VERSION = 2
# Shown in the side panel footer next to the extension's own version ("Ext v… · App v…");
# bump together with extensions/jr-suno-helper/manifest.json so a stale bridge is visible.
BRIDGE_VERSION = "1.2.3"
TOKEN_FILENAME = "token"
LOCAL_DRIVE_PATH = re.compile(r"^[A-Za-z]:[\\/]")
MAX_PATH_CHARS = 1024
MAX_OBSERVED_KEYS = 20


def local_file_path(value: object, suffix: str) -> Path | None:
    """A plain local path the extension reported, ending in `suffix`; UNC, relative and `..` paths refused."""
    if not isinstance(value, str) or not value or len(value) > MAX_PATH_CHARS:
        return None
    if value.startswith(("\\\\", "//")):
        return None
    if not (LOCAL_DRIVE_PATH.match(value) or value.startswith("/")):
        return None
    if ".." in re.split(r"[\\/]", value) or not value.lower().endswith(suffix):
        return None
    return Path(value)


def local_wav_path(value: object) -> Path | None:
    """The WAV path the extension reported, if it is a plain local path; otherwise None.

    The bridge opens this file to read its Suno stamp. A UNC path (`\\\\host\\share`)
    would make Windows try SMB authentication against someone else's machine, so
    only a drive-letter path (`C:\\...`) or a POSIX absolute path, without `..`,
    ending in `.wav`, is ever touched.
    """
    return local_file_path(value, ".wav")


def _plain_observed(value: object) -> dict | None:
    """The read-back Create form: a flat dict of short primitive values, nothing else."""
    if not isinstance(value, dict):
        return None
    kept = {
        str(key)[:40]: (item[:300] if isinstance(item, str) else item)
        for key, item in value.items()
        if item is None or isinstance(item, (str, int, float, bool))
    }
    return dict(list(kept.items())[:MAX_OBSERVED_KEYS])
EXTENSION_ORIGIN = re.compile(r"^chrome-extension://[a-p]{32}$")
# A client nonce: exactly 32 random bytes as lowercase hex, same shape the
# bridge's own server nonce uses (`secrets.token_hex(32)`).
NONCE_PATTERN = re.compile(r"^[0-9a-f]{64}$")
BRIDGE_PROOF_MESSAGE = "jr-suno/bridge/{client_nonce}/{server_nonce}"
EXT_PROOF_MESSAGE = "jr-suno/ext/{server_nonce}/{client_nonce}"
RESULT_STATUSES = frozenset({"done", "failed", "needs_human"})
# Anything that needs the owner at the keyboard stops the queue until the agent resumes it.
# `user_stop` = the owner pressed DỪNG NGAY in the extension's side panel.
PAUSING_ALERTS = frozenset({"captcha", "logged_out", "tab_closed", "tab_hidden", "user_stop"})
MAX_ALERTS = 20
# The queue picture stays small on the wire: an episode is ~36 jobs, a busy night a few episodes.
QUEUE_PICTURE_MAX_JOBS = 400
DOWNLOAD_DIRS_FILENAME = "download-dirs.json"
# Whether the queue is paused outlives the bridge process: a CAPTCHA pause must not end with a restart.
QUEUE_STATE_FILENAME = "queue-state.json"
# Heartbeat says "idle" while a job is out for this long → the extension dropped it (reload, crash).
DROPPED_AFTER_SECONDS = 30
# Once a generate job's last progress step is one of these, the Create click may
# already have happened: cancelling would lose clip ids credits already paid for.
GENERATE_UNCANCELLABLE_STEPS = frozenset({"submitting", "rendering"})
# "Chạy tiếp" from the side panel retries a stopped job only while nothing can have been made on Suno yet:
# a download before Studio exported anything, a generation before Create. Anything later stays for the agent.
RETRY_SAFE_STEPS = {
    KIND_DOWNLOAD: frozenset({None, "opening_studio"}),
    KIND_GENERATE: frozenset({None, "filling_form"}),
    # A Multitrack export makes nothing on Suno (it downloads): every step is safe to retry.
    KIND_MULTITRACK: frozenset({None, "opening_studio", "exporting_multitrack"}),
    # A stems job never presses Extract twice (`alreadySpent`), but one stopped while Suno was still splitting
    # could open a half-split project: that one waits for the agent.
    KIND_STEMS: frozenset({None, "opening_stems", "opening_stems_studio", "exporting_multitrack"}),
}
# The stems job's step at which Extract is pressed: from here on the take's split is paid for.
STEMS_SPEND_STEP = "extracting"
# A service-worker restart drops the socket mid-job; `on_disconnect` already
# marks whatever was in flight `unknown`, but an `orphan` report may also land
# while the job is still `sent`/`running` if the restart raced ahead of that.
ORPHAN_ELIGIBLE_STATUSES = IN_FLIGHT | {"unknown"}


PAIRING_ENV = "JR_SUNO_PAIRING_CODE"
PAIRING_CODE = re.compile(r"^[A-Za-z0-9_-]{32,128}$")


def pairing_token(config_dir: Path, environ: Mapping[str, str] | None = None) -> str:
    """The pairing secret the extension generated, passed in the agent's MCP config as an env var.

    The extension creates the code and hands the owner a ready-made MCP config containing it, so the
    code flows extension → agent config → bridge. Without the variable the older file-based code is used.
    """
    value = (os.environ if environ is None else environ).get(PAIRING_ENV, "").strip()
    if not value:
        return load_or_create_token(config_dir)
    if not PAIRING_CODE.fullmatch(value):
        raise ValueError(f"{PAIRING_ENV} không đúng định dạng — sao chép lại cấu hình MCP từ extension (mục Cài đặt).")
    return value


def load_or_create_token(config_dir: Path) -> str:
    """The pairing secret, created once outside the repository and reused afterwards."""
    path = config_dir / TOKEN_FILENAME
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    config_dir.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    path.write_text(token, encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass  # Windows ignores POSIX modes; the file lives under the user's profile.
    return token


def origin_allowed(origin: str | None) -> bool:
    """Only a Chrome extension may open the socket; web pages carry an http(s) origin."""
    return bool(origin and EXTENSION_ORIGIN.fullmatch(origin))


def _older_version(version: str, than: str) -> bool:
    """True only when both are plain x.y.z and `version` is strictly older; anything else never triggers a reload."""
    try:
        return tuple(int(part) for part in version.split(".")) < tuple(int(part) for part in than.split("."))
    except ValueError:
        return False


def _retry_safe(job) -> bool:
    """Retrying cannot make anything on Suno twice: no export yet (or resume from the one made), no Create yet."""
    if job.kind in (KIND_GENERATE, KIND_STEMS) and job.dry_run:
        return True
    if job.kind in (KIND_GENERATE, KIND_STEMS) and job.status == "unknown":
        return False  # a real Create / Extract may have fired with no word back: credits first, only a person decides
    if job.kind == KIND_DOWNLOAD and job.result.get("export_id"):
        return True  # resumes from its export, never exports again
    return job.result.get("last_step") in RETRY_SAFE_STEPS[job.kind]


def _seconds_between(earlier: str, later: str) -> float:
    try:
        start = datetime.fromisoformat(earlier.replace("Z", "+00:00"))
        end = datetime.fromisoformat(later.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return 0.0
    return (end - start).total_seconds()


def _page_hint(value: object) -> dict | None:
    """The trimmed page picture a failed driver step sends: where it was and which buttons were visible."""
    if not isinstance(value, dict):
        return None
    labels = [label[:60] for label in value.get("labels", []) if isinstance(label, str)][:40]
    return {"path": str(value.get("path", ""))[:80], "labels": labels}


def _job_picture(job) -> dict:
    """One job as the side panel sees it: where it is, how it ended, and what it is called."""
    title = str(job.packet.get("title", "")) if job.kind == KIND_GENERATE else job.expected_title
    return {
        "id": job.id,
        "kind": job.kind,
        "slot": job.slot,
        "status": job.status,
        "step": job.result.get("last_step"),
        "reason": job.result.get("reason"),
        "title": title[:300],
        "at": job.updated_at,
    }


class BridgeCore:
    """Queue, protocol and dispatch. Outgoing messages collect in an outbox the server drains."""

    def __init__(
        self,
        root: Path,
        token: str,
        now: Callable[[], str],
        local_dir: Path | None = None,
        clip_status_fetch: Callable[[list[str]], list[ClipStatus]] = check_clips,
        bridge_path: Path | None = None,
        projects_root: Path | None = None,
    ):
        self.root = root
        # Jobs handed over directly (song links, Create packets) live in project folders here, not in episodes/.
        self.projects_root = projects_root if projects_root is not None else default_projects_root()
        # Told to the extension after a successful handshake, so its "copy MCP config" box is prefilled.
        self._bridge_path = str(bridge_path) if bridge_path else None
        self._local_dir = local_dir
        self._download_dirs: dict[str, str] = self._load_download_dirs()
        self._token = token
        self._now = now
        self._clip_status_fetch = clip_status_fetch
        self._stores: dict[str, JobStore] = {}
        self._outbox: list[dict] = []
        self._pending_auth: dict | None = None
        self.connected = False
        self._paused = self._load_paused()
        self.extension: dict = {}
        self.phase: str | None = None
        self.alerts: list[dict] = []
        self.active_job_id: str | None = None
        self._outdated_extension = False  # told to reload itself: it gets no job until the new version pairs
        self._reload_asked_of: str | None = None
        self._queue_sent: dict | None = None

    # ── agent side ───────────────────────────────────────────────────────────────────────────

    def _store(self, episode: str) -> JobStore:
        """An episode's job list (`EP###…`), or else a project's under the projects root."""
        if not is_episode_name(episode):
            if episode not in self._stores:
                self._stores[episode] = project_store(self.projects_root, episode)
            return self._stores[episode]
        episode_dir = find_episode_dir(self.root, episode)
        if episode_dir.name not in self._stores:
            self._stores[episode_dir.name] = JobStore.for_episode(episode_dir)
        return self._stores[episode_dir.name]

    def _enqueue_planned(self, store: JobStore, planned: list) -> dict:
        added, skipped = store.enqueue(planned, now=self._now())
        store.save()
        self._pump()
        return {
            "project": store.path.parent.name,
            "added": [job.id for job in added],
            "skipped": [job.id for job in skipped],
            "folder": str(store.path.parent),
        }

    def enqueue_project_songs(self, project: str, songs: list[str], kind: str, dry_run: bool = True) -> dict:
        """Songs named by link or id: `download` (WAV), `multitrack` (32-bit mix) or `stems` (split, 50 credits if not yet)."""
        store = self._store(project)
        planned = plan_song_jobs(store, project, songs, kind, dry_run=dry_run, fetch=self._clip_status_fetch)
        store.forget_finished_dry_runs({job.id for job in planned})
        return self._enqueue_planned(store, planned)

    def enqueue_project_generation(
        self, project: str, packet: dict, count: int = 1, dry_run: bool = True, allow_additional: bool = False
    ) -> dict:
        """`count` Create submissions of one packet; dry_run=False spends credits.

        A real run is refused while an earlier real Create of the project is waiting, out, or of unknown fate
        (an agent retrying after a lost answer would otherwise press Create twice), unless `allow_additional`
        says the user asked for more on purpose.
        """
        store = self._store(project)
        if not dry_run and not allow_additional:
            pending = [job.id for job in store.jobs if self._real_generation_unsettled(job)]
            if pending:
                raise ProjectError(
                    f"dự án còn lượt tạo nhạc thật chưa rõ kết quả ({', '.join(pending)}): xem suno_jobs và Suno trước; "
                    "muốn tạo thêm có chủ đích thì gửi lại kèm allow_additional=true"
                )
        return self._enqueue_planned(store, plan_project_generation(store, project, packet, count=count, dry_run=dry_run))

    @staticmethod
    def _real_generation_unsettled(job) -> bool:
        if job.kind != KIND_GENERATE or job.dry_run:
            return False
        if job.status in {"queued", "unknown"} | IN_FLIGHT:
            return True
        stopped = job.status in {"failed", "needs_human"}
        return stopped and (bool(job.result.get("clip_ids")) or job.result.get("last_step") in GENERATE_UNCANCELLABLE_STEPS)

    def _store_of_job(self, job_id: str) -> JobStore:
        for store in self._stores.values():
            if any(job.id == job_id for job in store.jobs):
                return store
        raise KeyError(job_id)

    def enqueue(self, episode: str, song_ids: list[str] | None = None) -> dict:
        """Queue the episode's missing takes (optionally only these candidate songs)."""
        store = self._store(episode)
        planned, short = plan_download_jobs(store.path.parent)
        if song_ids is not None:
            wanted = set(song_ids)
            planned = [job for job in planned if job.song_id in wanted]
        added, skipped = store.enqueue(planned, now=self._now())
        store.save()
        self._pump()
        return {
            "episode": store.path.parent.name,
            "added": len(added),
            "skipped": len(skipped),
            "slots_short_of_candidates": short,
        }

    def enqueue_multitrack(self, episode: str, slots: list[int] | None = None) -> dict:
        """Queue the free 32-bit float export (Studio → Export → Multitrack) of the episode's filed takes."""
        store = self._store(episode)
        added, skipped = store.enqueue(plan_multitrack_jobs(store.path.parent, slots=slots), now=self._now())
        store.save()
        self._pump()
        return {"episode": store.path.parent.name, "added": len(added), "skipped": len(skipped)}

    def enqueue_stems(
        self, episode: str, slots: list[int], takes: list[int] | None = None, dry_run: bool = True
    ) -> dict:
        """Queue stem splits (Auto split, 50 credits per take when `dry_run=False`) + 32-bit export of mix and stems."""
        store = self._store(episode)
        planned = plan_stems_jobs(store.path.parent, slots=slots, takes=takes, dry_run=dry_run)
        store.forget_finished_dry_runs({job.id for job in planned})
        added, skipped = store.enqueue(planned, now=self._now())
        store.save()
        self._pump()
        return {
            "episode": store.path.parent.name,
            "added": len(added),
            "skipped": len(skipped),
            "dry_run": dry_run,
            "jobs": [job.id for job in added],
        }

    def enqueue_generation(self, episode: str, slots: list[int] | None = None, dry_run: bool = True) -> dict:
        """Queue Suno Create jobs. `dry_run=False` spends credits and is never planned around a slot that already has one out or unaccounted for."""
        store = self._store(episode)
        planned = plan_generation_jobs(store.path.parent, slots=slots, dry_run=dry_run)
        blocked_slots: list[int] = []
        if not dry_run:
            allowed = []
            for job in planned:
                if self._blocks_real_generation(store, job.slot):
                    blocked_slots.append(job.slot)
                else:
                    allowed.append(job)
            planned = allowed
        store.forget_finished_dry_runs({job.id for job in planned})
        added, skipped = store.enqueue(planned, now=self._now())
        store.save()
        self._pump()
        return {
            "episode": store.path.parent.name,
            "added": len(added),
            "skipped": len(skipped),
            "blocked_slots": blocked_slots,
        }

    @staticmethod
    def _blocks_real_generation(store: JobStore, slot: int) -> bool:
        """A slot already has a generate job whose fate a real run must not gamble past.

        In flight (sent/running) or `unknown` (the link dropped mid-job, so the
        Create click's outcome is unknown) refuses outright. A `failed` or
        `needs_human` job that already reports clip ids spent credits too, and so
        may one that stopped at or after the Create step without any ids; only
        the agent or the owner may decide to requeue it.
        """
        for job in store.jobs:
            if job.kind != KIND_GENERATE or job.slot != slot:
                continue
            if job.status in IN_FLIGHT or job.status == "unknown":
                return True
            if job.status in {"failed", "needs_human"} and job.result.get("clip_ids"):
                return True
            # Stopped at or after the Create step with no ids to show: the click may still have spent credits.
            if (
                job.status in {"failed", "needs_human"}
                and not job.dry_run
                and job.result.get("last_step") in GENERATE_UNCANCELLABLE_STEPS
            ):
                return True
        return False

    def jobs(self, episode: str | None = None) -> list[dict]:
        stores = [self._store(episode)] if episode else list(self._stores.values())
        return [self._job_summary(job) for store in stores for job in store.jobs]

    @staticmethod
    def _job_summary(job) -> dict:
        summary = {"id": job.id, "kind": job.kind, "slot": job.slot, "status": job.status, "result": job.result}
        if job.kind == KIND_DOWNLOAD:
            summary["song_id"] = job.song_id
        elif job.kind in (KIND_MULTITRACK, KIND_STEMS):
            summary["song_id"] = job.song_id
            summary["take"] = job.take
            if job.kind == KIND_STEMS:
                summary["dry_run"] = job.dry_run
        else:
            summary["batch_id"] = job.batch_id
            summary["dry_run"] = job.dry_run
            summary["clip_ids"] = job.result.get("clip_ids")
            summary["packet_check"] = job.result.get("packet_check")
        return summary

    def status(self) -> dict:
        counts: dict[str, int] = {}
        for store in self._stores.values():
            for job in store.jobs:
                counts[job.status] = counts.get(job.status, 0) + 1
        return {
            "connected": self.connected,
            "paused": self.paused,
            "extension": dict(self.extension),
            "phase": self.phase,
            "active_job": self.active_job_id,
            "counts": counts,
            "alerts": list(self.alerts),
        }

    def pause(self) -> None:
        self.paused = True

    def resume(self) -> None:
        self.paused = False
        self._pump()

    def cancel(self, job_id: str) -> None:
        """Cancel a queued or in-flight job -- refused past the point a real Create click may have fired."""
        store = self._store_of_job(job_id)
        job = store.get(job_id)
        last_step = job.result.get("last_step")
        if (
            job.kind == KIND_GENERATE
            and not job.dry_run
            and job.status in IN_FLIGHT
            and last_step in GENERATE_UNCANCELLABLE_STEPS
        ):
            raise JobTransitionError(
                f"{job.id}: cannot cancel past step {last_step!r} -- Create may already have been "
                f"pressed and credits spent; wait for a result instead"
            )
        store.transition(job_id, "cancelled", now=self._now())
        store.save()
        if job_id == self.active_job_id:
            self._outbox.append({"type": "cancel", "jobId": job_id})
            self.active_job_id = None
        self._pump()

    def requeue(self, job_id: str, confirm_spend: bool = False) -> None:
        """Put a stopped job back in line. A real generate / stems job spends credits again: it needs `confirm_spend`."""
        store = self._store_of_job(job_id)
        job = store.get(job_id)
        if job.kind in (KIND_GENERATE, KIND_STEMS) and not job.dry_run and not confirm_spend:
            raise JobTransitionError(
                f"{job.id}: requeuing a real {job.kind} job may spend Suno credits again; pass confirm_spend=true "
                "only after the user agreed (check Suno first if it stopped as 'unknown')"
            )
        store.requeue(job_id, now=self._now())
        store.save()
        self._pump()

    # ── local, untracked state ───────────────────────────────────────────────────────────────

    def _load_download_dirs(self) -> dict[str, str]:
        if self._local_dir is None:
            return {}
        path = self._local_dir / DOWNLOAD_DIRS_FILENAME
        if not path.exists():
            return {}
        return json.loads(path.read_text(encoding="utf-8"))

    def _remember_download_dir(self, episode: str, file_path: str) -> None:
        # Windows paths arrive from Chrome with backslashes; split on either separator.
        folder = re.split(r"[\\/](?=[^\\/]*$)", file_path)[0]
        self._download_dirs[episode] = folder
        if self._local_dir is not None:
            self._local_dir.mkdir(parents=True, exist_ok=True)
            (self._local_dir / DOWNLOAD_DIRS_FILENAME).write_text(
                json.dumps(self._download_dirs, ensure_ascii=False, indent=2), encoding="utf-8"
            )

    def download_dir(self, episode: str) -> Path | None:
        """Where Chrome put this episode's (or project's) finished downloads (kept outside the repo)."""
        name = find_episode_dir(self.root, episode).name if is_episode_name(episode) else episode
        folder = self._download_dirs.get(name)
        return Path(folder) if folder else None

    # ── extension side ───────────────────────────────────────────────────────────────────────

    @property
    def paused(self) -> bool:
        return self._paused

    @paused.setter
    def paused(self, value: bool) -> None:
        if value == self._paused:
            return
        self._paused = value
        if self._local_dir is not None:
            self._local_dir.mkdir(parents=True, exist_ok=True)
            (self._local_dir / QUEUE_STATE_FILENAME).write_text(json.dumps({"paused": value}), encoding="utf-8")

    def _load_paused(self) -> bool:
        path = self._local_dir / QUEUE_STATE_FILENAME if self._local_dir is not None else None
        if path is None or not path.exists():
            return False
        return json.loads(path.read_text(encoding="utf-8")).get("paused") is True

    def recover(self) -> None:
        """Load every episode's job list once this process owns the port; work left out is now unknown.

        Only the bridge that won 127.0.0.1:47831 may call this: a second copy (an
        agent probing its MCP config) must never rewrite job files the live one
        is still holding in memory.
        """
        for path in sorted((self.root / "episodes").glob(f"*/*{JOBS_SUFFIX}")):
            episode_dir = path.parent
            if path.name != f"{episode_dir.name.split('-')[0]}{JOBS_SUFFIX}" or episode_dir.name in self._stores:
                continue
            store = JobStore.for_episode(episode_dir)
            if store.mark_in_flight_unknown(now=self._now()):
                store.save()
            self._stores[episode_dir.name] = store
        for path in sorted(self.projects_root.glob(f"*/*{JOBS_SUFFIX}")):
            name = path.parent.name
            if path.name != f"{name}{JOBS_SUFFIX}" or name in self._stores or is_episode_name(name):
                continue
            try:
                store = JobStore.at(path)
            except (OSError, ValueError, TypeError) as error:  # one damaged project must not stop the bridge
                self.alerts = (self.alerts + [{"kind": "project_unreadable", "at": self._now(), "project": name,
                                               "error": f"{type(error).__name__}"}])[-MAX_ALERTS:]
                continue
            if store.mark_in_flight_unknown(now=self._now()):
                store.save()
            self._stores[name] = store

    def queue_picture(self) -> dict:
        """Every known job, oldest first, in the shape the side panel draws.

        Over the cap, the episodes touched most recently are kept: the one the
        owner is watching run must never be the one left out.
        """
        episodes = []
        budget = QUEUE_PICTURE_MAX_JOBS
        recent_first = sorted(
            self._stores.items(), key=lambda item: max((job.updated_at for job in item[1].jobs), default=""), reverse=True
        )
        for name, store in recent_first:
            jobs = sorted(store.jobs, key=lambda job: (job.created_at, job.id))[:budget]
            budget -= len(jobs)
            if not jobs:
                continue
            episodes.append({"episode": name, "jobs": [_job_picture(job) for job in jobs]})
        return {"type": "queue", "paused": self.paused, "episodes": episodes}

    def queue_update(self) -> dict | None:
        """The queue picture when it differs from the last one sent to this connection, else None."""
        if not self.connected:
            return None
        picture = self.queue_picture()
        if picture == self._queue_sent:
            return None
        self._queue_sent = picture
        return picture

    def on_connect(self) -> None:
        """A socket opened. Nothing is trusted until a valid hello + auth completes."""
        self.connected = False
        self.extension = {}
        self._pending_auth = None
        self._queue_sent = None

    @property
    def awaiting_auth(self) -> bool:
        """A hello was accepted and a challenge sent; the matching `auth` has not arrived."""
        return self._pending_auth is not None

    def on_disconnect(self) -> None:
        for store in self._stores.values():
            if store.mark_in_flight_unknown(now=self._now()):
                store.save()
        self.connected = False
        self._pending_auth = None
        self.active_job_id = None
        self._queue_sent = None

    def drain(self) -> list[dict]:
        out, self._outbox = self._outbox, []
        return out

    def _refuse(self, message: str) -> None:
        self._outbox.extend([{"type": "error", "message": message}, {"type": "close"}])

    def on_message(self, message: dict) -> None:
        kind = message.get("type") if isinstance(message, dict) else None
        if not self.connected:
            if kind == "hello":
                self._hello(message)
            elif kind == "auth" and self.awaiting_auth:
                self._auth(message)
            else:
                self._refuse("hello first")
            return
        handler = {
            "progress": self._progress,
            "result": self._result,
            "alert": self._alert,
            "heartbeat": self._heartbeat,
            "orphan": self._orphan,
            "control": self._control,
        }.get(kind)
        if handler is None:
            self._outbox.append({"type": "error", "message": f"unknown message type {kind!r}"})
            return
        handler(message)

    def _hmac_hex(self, message: str) -> str:
        return hmac.new(self._token.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).hexdigest()

    def begin_auth(self, message: object) -> tuple[dict, dict | None]:
        """Step 1 for ONE connection: returns (reply, handshake state that connection keeps).

        The state lives with the connection, never on the shared core, so a
        stranger's hello in the middle of a pairing cannot replace its nonces.
        """
        client_nonce = message.get("nonce") if isinstance(message, dict) else None
        if (
            not isinstance(message, dict)
            or message.get("type") != "hello"
            or message.get("protocol") != PROTOCOL_VERSION
            or not isinstance(client_nonce, str)
            or not NONCE_PATTERN.fullmatch(client_nonce)
        ):
            refusal = f"pairing failed (protocol or nonce; expected protocol {PROTOCOL_VERSION})"
            return {"type": "error", "message": refusal}, None
        server_nonce = secrets.token_hex(32)
        proof = self._hmac_hex(BRIDGE_PROOF_MESSAGE.format(client_nonce=client_nonce, server_nonce=server_nonce))
        handshake = {
            "client_nonce": client_nonce,
            "server_nonce": server_nonce,
            "version": str(message.get("version", ""))[:32],
            # The owner pressed DỪNG NGAY while the link was down; honoured only once pairing succeeds.
            "stopped": message.get("stopped") is True,
        }
        return {"type": "challenge", "nonce": server_nonce, "proof": proof}, handshake

    def finish_auth(self, handshake: dict, message: object) -> dict:
        """Step 3: the extension proves it holds the same token, without ever sending it.

        Returns `welcome` (and queues the first job) or an error to close on.
        """
        expected = self._hmac_hex(
            EXT_PROOF_MESSAGE.format(server_nonce=handshake["server_nonce"], client_nonce=handshake["client_nonce"])
        )
        proof = message.get("proof") if isinstance(message, dict) and message.get("type") == "auth" else None
        if not isinstance(proof, str) or not hmac.compare_digest(proof, expected):
            return {"type": "error", "message": "pairing failed"}
        self.connected = True
        self.extension = {"version": handshake["version"]}
        if handshake.get("stopped"):
            self._alert({"kind": "user_stop"})  # pause before anything below can pump a job
        # Work the last link lost before anything was made on Suno just runs again, no button needed.
        self._retry_stopped({"unknown"})
        welcome = {"type": "welcome", "protocol": PROTOCOL_VERSION, "bridgeVersion": BRIDGE_VERSION}
        if self._bridge_path:
            welcome["bridgePath"] = self._bridge_path
        # Dev machine: newer code is on disk. The extension reloads itself (only while idle) and comes
        # back as the new version; no job goes to the old code in the meantime, not even one queued later.
        self._outdated_extension = _older_version(handshake["version"], BRIDGE_VERSION)
        if self._outdated_extension and self._reload_asked_of == handshake["version"]:
            # Reloading brought back the same old version (an unpacked folder older than this bridge): tell the
            # user instead of asking again and holding every job forever.
            self._outdated_extension = False
            self.alerts = (self.alerts + [{"kind": "extension_outdated", "at": self._now(),
                                           "version": handshake["version"]}])[-MAX_ALERTS:]
        if self._outdated_extension:
            self._reload_asked_of = handshake["version"]
            self._outbox.append({"type": "reload"})
        else:
            self._pump()
        return welcome

    def _hello(self, message: dict) -> None:
        """`on_message` path (one caller at a time, e.g. tests): keep the state on the core."""
        reply, self._pending_auth = self.begin_auth(message)
        if self._pending_auth is None:
            self._refuse(reply["message"])
        else:
            self._outbox.append(reply)

    def _auth(self, message: dict) -> None:
        pending, self._pending_auth = self._pending_auth, None
        queued = len(self._outbox)
        reply = self.finish_auth(pending, message)
        if reply["type"] == "error":
            self._refuse(reply["message"])
        else:
            self._outbox.insert(queued, reply)  # welcome goes out before the job it just pumped

    def _active(self, message: dict) -> tuple[JobStore, str] | None:
        job_id = message.get("jobId")
        if not job_id or job_id != self.active_job_id:
            self._outbox.append({"type": "error", "message": f"job {job_id!r} is not the one out"})
            return None
        return self._store_of_job(job_id), job_id

    def _progress(self, message: dict) -> None:
        active = self._active(message)
        if not active:
            return
        store, job_id = active
        step = str(message.get("step", ""))[:64]
        now = self._now()
        # First time each step starts, kept for the per-step timings (scripts/suno_job_stats.py).
        step_times = dict(store.get(job_id).result.get("step_times", {}))
        step_times.setdefault(step, now)
        progress = {"last_step": step, "step_times": step_times}
        if store.get(job_id).kind == KIND_STEMS and step == STEMS_SPEND_STEP:
            progress["spent"] = True  # Extract is pressed next: even if no result ever comes back, never press it again
        export_id = message.get("exportId")
        if isinstance(export_id, str) and CLIP_UUID_PATTERN.fullmatch(export_id):
            progress["export_id"] = export_id
        if store.get(job_id).status == "sent":
            store.transition(job_id, "running", now=now, result=progress)
        else:
            store.annotate(job_id, now=now, result=progress)
        store.save()

    def _result(self, message: dict) -> None:
        active = self._active(message)
        if not active:
            return
        store, job_id = active
        status = message.get("status")
        if status not in RESULT_STATUSES:
            self._outbox.append({"type": "error", "message": f"result status {status!r} not accepted"})
            return
        job = store.get(job_id)
        if job.kind == KIND_GENERATE:
            result = self._generate_result(job, status, message)
        elif job.kind == KIND_MULTITRACK:
            result = self._multitrack_result(store, status, message)
        elif job.kind == KIND_STEMS:
            result = self._stems_result(store, job, status, message)
        else:
            result = self._download_result(store, job, status, message)
        hint = _page_hint(message.get("domHint"))
        if hint is not None:
            result["dom_hint"] = hint
        try:
            updated = store.transition(job_id, status, now=self._now(), result=result)
        except JobTransitionError as error:
            self._outbox.append({"type": "error", "message": str(error)})
            return
        store.save()
        # A project has no music_test_results.yaml: its clip ids stay on the job itself.
        if job.kind == KIND_GENERATE and status == "done" and updated.result.get("dry_run") is False and is_episode_name(job.episode):
            self._record_batch(store, updated)
        self.active_job_id = None
        # The result can land before its alert; whatever stopped this job would stop the next one too.
        if status == "needs_human":
            self.paused = True
        self._pump()

    def _record_batch(self, store: JobStore, job) -> None:
        """Write the finished generation's batch; on failure keep the ids on the job and alert the agent.

        The append builds and checks the new YAML before replacing the file, so a
        failure leaves music_test_results.yaml as it was; the clip ids are never
        lost because they already sit on the job.
        """
        try:
            append_generation_batch(store.path.parent, job, generated_at=self._now()[:10])
        except (OSError, ValueError, yaml.YAMLError, KeyError) as error:
            store.annotate(job.id, now=self._now(), result={"batch_append_error": f"{type(error).__name__}: {error}"[:300]})
            store.save()
            self.alerts = (self.alerts + [{"kind": "batch_append_failed", "at": self._now(), "job": job.id}])[-MAX_ALERTS:]

    def _download_result(self, store: JobStore, job, status: str, message: dict) -> dict:
        result = {
            key: message[source]
            for key, source in (("export_id", "exportId"), ("filename", "filename"),
                                ("seconds", "seconds"), ("reason", "reason"))
            if message.get(source) is not None
        }
        if "export_id" in result and not (isinstance(result["export_id"], str) and CLIP_UUID_PATTERN.fullmatch(result["export_id"])):
            del result["export_id"]
        if status == "done":
            path = local_wav_path(message.get("path"))
            if message.get("path") is not None and path is None:
                result["path_rejected"] = True
            if path is not None:
                self._remember_download_dir(store.path.parent.name, str(path))
                if path.exists():
                    stamp = read_suno_stamp(path)
                    if stamp is not None:
                        result["stamp_ok"] = stamp.song_id == result.get("export_id")
                        result["stamp_studio"] = stamp.studio
            filename = re.split(r"[\\/]", str(result.get("filename", "")))[-1]
            result["filename"] = filename
            if is_episode_name(job.episode):
                titles = load_slot_titles(store.path.parent)
                result["title_ok"] = match_slot_by_title(Path(filename).stem, titles) == job.slot
            else:
                result["title_ok"] = match_slot_by_title(Path(filename).stem, {job.slot: job.expected_title}) == job.slot
        return result

    def _multitrack_result(self, store: JobStore, status: str, message: dict) -> dict:
        result = {key: message[key] for key in ("reason",) if message.get(key) is not None}
        filename = re.split(r"[\\/]", str(message.get("filename", "")))[-1][:300]
        if filename:
            result["filename"] = filename
        if status == "done":
            path = local_file_path(message.get("path"), ".zip")
            if path is None:
                result["path_rejected"] = True
                result["filename"] = ""  # not a ZIP we can ingest: the transition refuses "done"
            else:
                self._remember_download_dir(store.path.parent.name, str(path))
        return result

    def _stems_result(self, store: JobStore, job, status: str, message: dict) -> dict:
        """Like a Multitrack result, plus the stem names Suno listed and whether Extract was pressed."""
        result = {"dry_run": job.dry_run}
        if job.dry_run:
            # A dry run only looks: is the take split on Suno already? Nothing is downloaded.
            result.update({key: message[key] for key in ("reason",) if message.get(key) is not None})
            result["has_stems"] = message.get("hasStems") is True
        else:
            result.update(self._multitrack_result(store, status, message))
        stems = message.get("stems")
        if isinstance(stems, list):
            result["stems"] = [name[:40] for name in stems if isinstance(name, str) and name][:16]
        # Spent stays spent: the extension's word can add it, never take it back (progress may have set it).
        if message.get("spent") is True or job.result.get("spent"):
            result["spent"] = True
        return result

    def _generate_result(self, job, status: str, message: dict) -> dict:
        result = {
            key: message[source]
            for key, source in (
                ("clip_ids", "clipIds"),
                ("seconds", "seconds"),
                ("observed", "observed"),
                ("reason", "reason"),
                ("mismatches", "mismatches"),
            )
            if message.get(source) is not None
        }
        if "clip_ids" in result:
            raw = result["clip_ids"] if isinstance(result["clip_ids"], list) else []
            result["clip_ids"] = list(dict.fromkeys(c for c in raw if isinstance(c, str) and CLIP_UUID_PATTERN.fullmatch(c)))
        if "observed" in result:
            result["observed"] = _plain_observed(result["observed"])
        # The job's own flag is the truth: the extension's claim never decides whether credits were spent.
        result["dry_run"] = job.dry_run
        if "dryRun" in message and bool(message["dryRun"]) != job.dry_run:
            result["dry_run_mismatch"] = True
        if status == "done" and not job.dry_run:
            clip_ids = result.get("clip_ids") or []
            try:
                statuses = self._clip_status_fetch(clip_ids)
                result["packet_check"] = check_packet_against_clips(job.packet, job.min_seconds, statuses)
            except Exception:  # noqa: BLE001 - a network/parsing failure here must never crash the bridge
                result["packet_check"] = {"unavailable": True}
        return result

    def _orphan(self, message: dict) -> None:
        """A generate job survived a service-worker restart mid-submission; keep its clip ids.

        This never touches `status` -- the job may already be `unknown` (from
        `on_disconnect`) or still `sent`/`running` if the restart raced ahead
        of that -- only the agent or the owner decides what happens next.
        """
        job_id = message.get("jobId")
        try:
            store = self._store_of_job(job_id)
        except KeyError:
            self._outbox.append({"type": "error", "message": f"orphan for unknown job {job_id!r}"})
            return
        job = store.get(job_id)
        if job.kind != KIND_GENERATE or job.status not in ORPHAN_ELIGIBLE_STATUSES:
            self._outbox.append(
                {"type": "error", "message": f"{job_id!r} ({job.kind}, {job.status}) cannot take an orphan report"}
            )
            return
        incoming = message.get("clipIds") or []
        valid_ids = [cid for cid in incoming if isinstance(cid, str) and CLIP_UUID_PATTERN.fullmatch(cid)]
        existing = job.result.get("clip_ids") or []
        merged = list(dict.fromkeys([*existing, *valid_ids]))  # merge, dedupe, keep first-seen order
        store.annotate(
            job_id,
            now=self._now(),
            result={
                "clip_ids": merged,
                "orphan_phase": str(message.get("phase", ""))[:32],
                "reason": "service_worker_restart",
            },
        )
        store.save()

    def _control(self, message: dict) -> None:
        """The owner pressed a button in the side panel. Only `resume` exists; pausing is the `user_stop` alert."""
        if message.get("action") != "resume":
            self._outbox.append({"type": "error", "message": f"unknown control action {str(message.get('action'))[:32]!r}"})
            return
        self._retry_stopped({"needs_human", "unknown"})
        self.resume()

    def _retry_stopped(self, statuses: set[str]) -> None:
        """Put back in line every stopped job in `statuses` that `_retry_safe` allows."""
        for store in self._stores.values():
            retried = False
            for job in store.jobs:
                if job.status in statuses and _retry_safe(job):
                    store.requeue(job.id, now=self._now())
                    retried = True
            if retried:
                store.save()

    def _alert(self, message: dict) -> None:
        kind = str(message.get("kind", ""))[:32]
        self.alerts = (self.alerts + [{"kind": kind, "at": self._now()}])[-MAX_ALERTS:]
        if kind in PAUSING_ALERTS:
            self.paused = True

    def _heartbeat(self, message: dict) -> None:
        self.phase = str(message.get("phase", ""))[:32]
        if self.phase == "idle" and self.active_job_id:
            self._reclaim_dropped_job()

    def _reclaim_dropped_job(self) -> None:
        """The extension says it is idle while a job is still out: it lost the job (e.g. reloaded mid-run).

        Only after DROPPED_AFTER_SECONDS without progress, so a job still on its way is never reclaimed.
        The job becomes `unknown`, then runs again if `_retry_safe` allows; otherwise it waits for a person.
        """
        store = self._store_of_job(self.active_job_id)
        job = store.get(self.active_job_id)
        if job.status not in IN_FLIGHT or _seconds_between(job.updated_at, self._now()) < DROPPED_AFTER_SECONDS:
            return
        store.transition(job.id, "unknown", now=self._now(), result={"reason": "extension_dropped"})
        self.active_job_id = None
        if _retry_safe(store.get(job.id)):
            store.requeue(job.id, now=self._now())
        store.save()
        self._pump()

    # ── dispatch ─────────────────────────────────────────────────────────────────────────────

    def _pump(self) -> None:
        """Send the next queued job when the extension is idle and nobody paused the queue."""
        if not self.connected or self.paused or self.active_job_id or self._outdated_extension:
            return
        if any(job.status in IN_FLIGHT for store in self._stores.values() for job in store.jobs):
            return
        queued = [
            (job.created_at, job.id, store)
            for store in self._stores.values()
            for job in store.jobs
            if job.status == "queued"
        ]
        if not queued:
            return
        _, job_id, store = min(queued, key=lambda item: (item[0], item[1]))
        now = self._now()
        job = store.transition(job_id, "sent", now=now, result={"sent_at": now})
        store.save()
        self.active_job_id = job.id
        self._outbox.append({"type": "job", "job": job.to_wire()})
