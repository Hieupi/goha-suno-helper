"""Job values and the job list: wire shapes, the state machine, and saving that never loses a job."""

import json
import os
import shutil
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

from goha_suno.suno_jobs import (
    KIND_DOWNLOAD,
    KIND_GENERATE,
    KIND_MULTITRACK,
    KIND_STEMS,
    DownloadJob,
    GenerateJob,
    JobStore,
    JobTransitionError,
    MultitrackJob,
    StemsJob,
    job_from_dict,
)
from tests.helpers import CLIP_ID, EXPORT_ID, SONG_A, SONG_B

NOW = "2026-09-26T07:00:00Z"
PACKET = {
    "title": "t", "styles": "s", "exclude": "", "lyrics": "", "model": "v6", "tab": "advanced",
    "durationSeconds": 330, "maxMode": True, "variety": 1, "weirdness": 30, "styleInfluence": 85,
    "vocalGender": None, "myTaste": False,
}


def download(song_id: str, slot: int) -> DownloadJob:
    return DownloadJob(id=f"lofi.{slot:02d}.{song_id}", episode="lofi", slot=slot, candidate_id=song_id,
                       song_id=song_id, expected_title=f"Song {slot}", min_seconds=300.0)


def generate(**overrides) -> GenerateJob:
    fields = dict(id="lofi.03.B03", episode="lofi", slot=3, batch_id="B03", packet=dict(PACKET), dry_run=True, min_seconds=320.0)
    return GenerateJob(**{**fields, **overrides})


def stems(dry_run=False) -> StemsJob:
    return StemsJob(id="lofi.01.ST1", episode="lofi", slot=1, take=1, song_id=SONG_A, expected_title="Song 1",
                    min_seconds=300.0, dry_run=dry_run)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.path = self.tmp / "lofi" / "lofi-suno-jobs.json"
        self.path.parent.mkdir()
        self.store = JobStore.at(self.path)
        self.jobs = [download(SONG_A, 1), download(SONG_B, 2)]

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_a_save_interrupted_before_the_swap_leaves_the_old_file_whole(self):
        """The job file is the only guard against exporting twice; a half-written one would lose it."""
        self.store.enqueue(self.jobs, now=NOW)
        self.store.save()
        before = self.path.read_text(encoding="utf-8")
        self.store.transition(self.jobs[0].id, "sent", now=NOW)
        with mock.patch("goha_suno.suno_jobs.os.replace", side_effect=OSError("disk gone")):
            with self.assertRaises(OSError):
                self.store.save()
        self.assertEqual(self.path.read_text(encoding="utf-8"), before)
        self.assertEqual(list(self.path.parent.glob("*.tmp")), [], "không để lại file tạm")

    def test_a_swap_refused_while_a_reader_holds_the_file_is_retried(self):
        """Windows refuses os.replace while another process has the job file open for a moment."""
        self.store.enqueue(self.jobs, now=NOW)
        real_replace = os.replace
        calls = []

        def busy_then_free(src, dst):
            calls.append(src)
            if len(calls) < 3:
                raise PermissionError(5, "Access is denied")
            return real_replace(src, dst)

        with mock.patch("goha_suno.suno_jobs.os.replace", side_effect=busy_then_free), mock.patch("goha_suno.suno_jobs.time.sleep"):
            self.store.save()
        self.assertEqual(len(calls), 3)
        self.assertEqual(len(JobStore.at(self.path).jobs), 2)

    def test_a_swap_that_stays_refused_still_fails_loudly(self):
        self.store.enqueue(self.jobs, now=NOW)
        with mock.patch("goha_suno.suno_jobs.os.replace", side_effect=PermissionError(5, "Access is denied")), \
                mock.patch("goha_suno.suno_jobs.time.sleep"):
            with self.assertRaises(PermissionError):
                self.store.save()
        self.assertEqual(list(self.path.parent.glob("*.tmp")), [])

    def test_enqueue_is_idempotent(self):
        added, skipped = self.store.enqueue(self.jobs, now=NOW)
        self.assertEqual((len(added), len(skipped)), (2, 0))
        added, skipped = self.store.enqueue(self.jobs, now=NOW)
        self.assertEqual((len(added), len(skipped)), (0, 2))
        self.assertEqual(len(self.store.jobs), 2)

    def test_the_store_survives_a_restart(self):
        self.store.enqueue(self.jobs, now=NOW)
        self.store.save()
        reloaded = JobStore.at(self.path)
        self.assertEqual([j.id for j in reloaded.jobs], [j.id for j in self.jobs])
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["schema_version"], 1)

    def test_happy_path_ends_done_with_the_export_id(self):
        self.store.enqueue(self.jobs, now=NOW)
        job = self.store.next_queued()
        self.store.transition(job.id, "sent", now=NOW)
        self.store.transition(job.id, "running", now=NOW)
        done = self.store.transition(job.id, "done", now=NOW, result={"export_id": EXPORT_ID, "filename": "Song 1.wav"})
        self.assertEqual((done.status, done.result["export_id"]), ("done", EXPORT_ID))
        self.assertEqual(self.store.next_queued().id, self.jobs[1].id)

    def test_done_without_export_id_or_filename_is_refused(self):
        self.store.enqueue(self.jobs, now=NOW)
        self.store.transition(self.jobs[0].id, "sent", now=NOW)
        with self.assertRaises(JobTransitionError):
            self.store.transition(self.jobs[0].id, "done", now=NOW, result={"filename": "x.wav"})

    def test_illegal_transitions_and_unknown_statuses_are_refused(self):
        self.store.enqueue(self.jobs, now=NOW)
        with self.assertRaises(JobTransitionError):
            self.store.transition(self.jobs[0].id, "done", now=NOW, result={"export_id": EXPORT_ID, "filename": "a.wav"})
        with self.assertRaises(JobTransitionError):
            self.store.transition(self.jobs[0].id, "exploded", now=NOW)

    def test_in_flight_jobs_become_unknown_and_are_never_retried_silently(self):
        self.store.enqueue(self.jobs, now=NOW)
        job = self.store.next_queued()
        self.store.transition(job.id, "sent", now=NOW)
        changed = self.store.mark_in_flight_unknown(now=NOW)
        self.assertEqual([j.id for j in changed], [job.id])
        self.assertEqual(self.store.get(job.id).status, "unknown")
        self.assertEqual(self.store.get(job.id).result["reason"], "link_lost")
        self.assertEqual(self.store.next_queued().id, self.jobs[1].id, "job unknown không được lấy lại")

    def test_requeue_is_an_explicit_decision_and_a_done_job_cannot_be_requeued(self):
        self.store.enqueue(self.jobs, now=NOW)
        self.store.transition(self.jobs[0].id, "sent", now=NOW)
        self.store.transition(self.jobs[0].id, "needs_human", now=NOW, result={"reason": "captcha"})
        self.assertEqual(self.store.requeue(self.jobs[0].id, now=NOW).status, "queued")
        self.store.transition(self.jobs[1].id, "sent", now=NOW)
        self.store.transition(self.jobs[1].id, "done", now=NOW, result={"export_id": EXPORT_ID, "filename": "a.wav"})
        with self.assertRaises(JobTransitionError):
            self.store.requeue(self.jobs[1].id, now=NOW)

    def test_a_requeued_download_that_had_exported_resumes_from_that_export(self):
        """Exporting the same song again would make a duplicate song on Suno."""
        self.store.enqueue(self.jobs, now=NOW)
        job_id = self.jobs[0].id
        self.store.transition(job_id, "sent", now=NOW)
        self.store.transition(job_id, "needs_human", now=NOW, result={"export_id": EXPORT_ID, "reason": "tab_hidden"})
        self.assertEqual(self.store.requeue(job_id, now=NOW).to_wire()["exportId"], EXPORT_ID)
        self.assertNotIn("exportId", self.jobs[1].to_wire(), "việc chưa export thì không có mã")

    def test_jobs_are_immutable_values(self):
        self.store.enqueue(self.jobs, now=NOW)
        before = self.store.get(self.jobs[0].id)
        self.store.transition(before.id, "sent", now=NOW)
        self.assertEqual(before.status, "queued", "bản cũ không bị sửa tại chỗ")

    def test_all_four_kinds_share_one_file_and_come_back_as_themselves(self):
        multitrack = MultitrackJob(id="lofi.02.MT1", episode="lofi", slot=2, take=1, song_id=SONG_B,
                                   expected_title="Song 2", min_seconds=300.0)
        self.store.jobs = (self.jobs[0], generate(), multitrack, stems())
        self.store.save()
        reloaded = {job.id: job for job in JobStore.at(self.path).jobs}
        self.assertIsInstance(reloaded[self.jobs[0].id], DownloadJob)
        self.assertIsInstance(reloaded["lofi.03.B03"], GenerateJob)
        self.assertIsInstance(reloaded["lofi.02.MT1"], MultitrackJob)
        self.assertIsInstance(reloaded["lofi.01.ST1"], StemsJob)
        self.assertEqual([job.kind for job in reloaded.values()], [KIND_DOWNLOAD, KIND_GENERATE, KIND_MULTITRACK, KIND_STEMS])

    def test_a_legacy_job_without_kind_loads_as_a_download(self):
        job = job_from_dict({"id": "x.01.legacy", "episode": "x", "slot": 1, "candidate_id": "c", "song_id": "s",
                             "expected_title": "t", "min_seconds": 300.0, "status": "queued", "created_at": "",
                             "updated_at": "", "result": {}})
        self.assertIsInstance(job, DownloadJob)
        self.assertEqual(job.kind, KIND_DOWNLOAD)

    def test_forgetting_finished_dry_runs_never_touches_real_or_unfinished_jobs(self):
        real = generate(id="lofi.04.B04", dry_run=False, status="failed")
        finished_dry = generate(status="done")
        queued_dry = generate(id="lofi.05.B05", status="queued")
        self.store.jobs = (real, finished_dry, queued_dry, self.jobs[0])
        self.store.forget_finished_dry_runs({real.id, finished_dry.id, queued_dry.id, self.jobs[0].id})
        self.assertEqual([job.id for job in self.store.jobs], [real.id, queued_dry.id, self.jobs[0].id])


class GenerateJobTests(unittest.TestCase):
    def setUp(self):
        self.store = JobStore(Path("unused.json"))

    def test_to_wire_carries_the_packet_and_batch_id(self):
        wire = generate().to_wire()
        self.assertEqual((wire["kind"], wire["batchId"], wire["dryRun"], wire["packet"]["title"]), ("generate", "B03", True, "t"))

    def test_a_dry_run_done_job_needs_no_clip_id(self):
        self.store.jobs = (generate(),)
        self.store.transition("lofi.03.B03", "sent", now=NOW)
        self.assertEqual(self.store.transition("lofi.03.B03", "done", now=NOW, result={"dry_run": True}).status, "done")

    def test_a_real_done_job_needs_a_clip_id(self):
        self.store.jobs = (generate(dry_run=False),)
        self.store.transition("lofi.03.B03", "sent", now=NOW)
        with self.assertRaises(JobTransitionError):
            self.store.transition("lofi.03.B03", "done", now=NOW, result={"dry_run": False})
        done = self.store.transition("lofi.03.B03", "done", now=NOW, result={"dry_run": False, "clip_ids": [CLIP_ID]})
        self.assertEqual(done.result["clip_ids"], [CLIP_ID])

    def test_requeuing_a_real_generation_keeps_the_clip_ids_it_already_spent_credits_on(self):
        self.store.jobs = (generate(dry_run=False, status="failed", result={"clip_ids": [CLIP_ID], "reason": "clip_error"}),)
        requeued = self.store.requeue("lofi.03.B03", now=NOW)
        self.assertEqual(requeued.status, "queued")
        self.assertEqual(requeued.result, {"earlier_clip_ids": [CLIP_ID]})


class StemsJobTests(unittest.TestCase):
    def test_a_fresh_split_does_not_say_already_spent(self):
        wire = stems().to_wire()
        self.assertEqual((wire["kind"], wire["candidateId"], wire["dryRun"]), (KIND_STEMS, SONG_A, False))
        self.assertNotIn("alreadySpent", wire)

    def test_a_spent_split_requeued_tells_the_extension_never_to_press_extract_again(self):
        store = JobStore(Path("unused.json"), (stems(),))
        store.transition("lofi.01.ST1", "sent", now=NOW)
        store.transition("lofi.01.ST1", "failed", now=NOW, result={"spent": True, "reason": "timeout:extracting"})
        job = store.requeue("lofi.01.ST1", now=NOW)
        self.assertEqual(job.result, {"earlier_spent": True})
        self.assertIs(job.to_wire()["alreadySpent"], True)

    def test_a_real_split_done_needs_its_zip_a_dry_run_does_not(self):
        store = JobStore(Path("unused.json"), (stems(), replace(stems(dry_run=True), id="x")))
        store.transition("lofi.01.ST1", "sent", now=NOW)
        with self.assertRaises(JobTransitionError):
            store.transition("lofi.01.ST1", "done", now=NOW, result={"dry_run": False, "filename": "a.wav"})
        store.transition("x", "sent", now=NOW)
        self.assertEqual(store.transition("x", "done", now=NOW, result={"dry_run": True}).status, "done")


if __name__ == "__main__":
    unittest.main()
