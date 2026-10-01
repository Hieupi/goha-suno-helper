"""Projects: jobs straight from song links or a Create packet, with no episode records (community edition)."""

import shutil
import tempfile
import unittest
from pathlib import Path

from goha_suno.suno_bridge_core import BridgeCore
from goha_suno.suno_clip_status import ClipStatus
from goha_suno.suno_jobs import KIND_GENERATE, KIND_MULTITRACK, KIND_STEMS, JobStore
from goha_suno.suno_projects import ProjectError, check_project_name, packet_problems, projects_root, song_ids
from tests.helpers import TOKEN, authenticate, clock

SONG_A = "6f19dcde-f082-447d-a0d5-c6f74e4ac837"
SONG_B = "e833996d-cd17-47e3-be97-eb56e1380806"
PACKET = {"title": "Rain on the tea house", "styles": "lofi koto, soft rain, warm tape", "exclude": "vocals"}


SONG_RENDERING = "33333333-3333-4333-8333-333333333333"


def clips(ids):
    if SONG_RENDERING in ids:
        return [ClipStatus(i, "streaming" if i == SONG_RENDERING else "complete", "t", 100.0, "gen", None, None, None, True, None)
                for i in ids]
    known = {SONG_A: ("冬の書斎、朝の静けさ", 329.0), SONG_B: ("Tinh Hà Độ Kiếm", 330.0)}
    return [
        ClipStatus(i, "complete", *known[i], "gen", None, None, None, True, None) if i in known
        else ClipStatus(i, None, None, None, None, None, None, None, None, "HTTP 404")
        for i in ids
    ]


class NameAndLinkTests(unittest.TestCase):
    def test_project_names_are_short_safe_and_never_look_like_an_episode(self):
        self.assertEqual(check_project_name("my-album_2"), "my-album_2")
        for bad in ("EP008", "EP008-x", "Lofi", "con", "LPT1", "../x", "a.b", "", "x" * 42, "có dấu"):
            with self.assertRaises(ProjectError, msg=bad):
                check_project_name(bad)

    def test_song_ids_come_from_links_or_bare_ids_in_order_without_repeats(self):
        self.assertEqual(
            song_ids([f"https://suno.com/song/{SONG_A}?sh=abc", SONG_B.upper(), f"suno.com/song/{SONG_A}"]),
            [SONG_A, SONG_B],
        )
        with self.assertRaises(ProjectError):
            song_ids(["https://suno.com/s/AbCdEf"])  # short share link: no id in it
        with self.assertRaises(ProjectError):
            song_ids([])

    def test_projects_live_in_the_users_home_unless_told_otherwise(self):
        self.assertEqual(projects_root({}), Path.home() / "GOHA-Suno")
        self.assertEqual(projects_root({"GOHA_SUNO_HOME": "D:/Music/Suno"}), Path("D:/Music/Suno"))

    def test_packets_are_held_to_sunos_limits_only(self):
        good = {"title": "t", "styles": "s", "exclude": "", "lyrics": "", "model": "v6", "tab": "advanced",
                "durationSeconds": 180, "maxMode": False, "variety": 2, "weirdness": 50, "styleInfluence": 50,
                "vocalGender": None, "myTaste": False}
        self.assertEqual(packet_problems(good), [])
        problems = packet_problems({**good, "styles": "x" * 1001, "durationSeconds": 182, "weirdness": 101, "lyrics": "la la"})
        self.assertEqual(len(problems), 4, problems)


class BridgeProjectTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.home = self.tmp / "GOHA-Suno"
        self.core = BridgeCore(token=TOKEN, now=clock, local_dir=self.tmp / "local",
                               clip_status_fetch=clips, projects_root=self.home)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def stored(self, job_id):
        return JobStore.at(self.home / "lofi" / "lofi-suno-jobs.json").get(job_id)

    def test_songs_by_link_become_download_jobs_with_the_title_and_length_suno_reports(self):
        summary = self.core.enqueue_project_songs("lofi", [f"https://suno.com/song/{SONG_A}", SONG_B], "download")
        self.assertEqual(summary["added"], [f"lofi.01.{SONG_A}", f"lofi.02.{SONG_B}"])
        self.assertTrue((self.home / "lofi" / "lofi-suno-jobs.json").exists())
        job = authenticate(self.core)[1]["job"]
        self.assertEqual((job["kind"], job["episode"], job["candidateId"], job["expectedTitle"]),
                         ("export_download", "lofi", SONG_A, "冬の書斎、朝の静けさ"))
        self.assertAlmostEqual(job["minSeconds"], 312.6, places=1)

    def test_asking_again_for_the_same_song_reuses_its_slot_and_queues_nothing_twice(self):
        self.core.enqueue_project_songs("lofi", [SONG_A], "download")
        again = self.core.enqueue_project_songs("lofi", [SONG_A], "download")
        self.assertEqual((again["added"], again["skipped"]), ([], [f"lofi.01.{SONG_A}"]))
        stems = self.core.enqueue_project_songs("lofi", [SONG_A], "stems")
        self.assertEqual(stems["added"], ["lofi.01.ST1"], "cùng bài, cùng ô, việc khác loại")

    def test_a_song_suno_cannot_find_is_refused_before_anything_is_queued(self):
        with self.assertRaises(ProjectError):
            self.core.enqueue_project_songs("lofi", [SONG_A, "11111111-1111-4111-8111-111111111111"], "download")
        self.assertEqual(self.core.jobs("lofi"), [])

    def test_a_finished_project_download_records_the_file_and_where_it_landed(self):
        self.core.enqueue_project_songs("lofi", [SONG_A], "download")
        job = authenticate(self.core)[1]["job"]
        export = "22222222-2222-4222-8222-222222222222"
        path = str(self.tmp / "Downloads" / "GOHA-Suno" / "lofi" / "冬の書斎、朝の静けさ.wav")
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "done", "exportId": export,
                              "filename": "冬の書斎、朝の静けさ.wav", "path": path})
        stored = self.stored(job["id"])
        self.assertEqual((stored.status, stored.result["title_ok"]), ("done", True))
        self.assertEqual(self.core.download_dir("lofi"), Path(path).parent)

    def test_32bit_and_stems_jobs_take_one_slot_per_song(self):
        self.core.enqueue_project_songs("lofi", [SONG_A], "multitrack")
        summary = self.core.enqueue_project_songs("lofi", [SONG_B], "stems", dry_run=False)
        self.assertEqual(summary["added"], ["lofi.02.ST1"])
        kinds = {j["id"]: j["kind"] for j in self.core.jobs("lofi")}
        self.assertEqual(kinds, {"lofi.01.MT1": KIND_MULTITRACK, "lofi.02.ST1": KIND_STEMS})

    def test_generation_gets_a_new_slot_per_create_and_fills_suno_defaults(self):
        summary = self.core.enqueue_project_generation("lofi", PACKET, count=2)
        self.assertEqual(summary["added"], ["lofi.01.B01", "lofi.02.B02"])
        job = authenticate(self.core)[1]["job"]
        self.assertEqual((job["kind"], job["dryRun"], job["batchId"]), (KIND_GENERATE, True, "B01"))
        self.assertEqual((job["packet"]["model"], job["packet"]["lyrics"], job["packet"]["tab"]), ("v6", "", "advanced"))

    def test_a_packet_outside_sunos_limits_is_refused(self):
        with self.assertRaises(ProjectError):
            self.core.enqueue_project_generation("lofi", {**PACKET, "styles": "x" * 1001})
        with self.assertRaises(ProjectError):
            self.core.enqueue_project_generation("lofi", PACKET, count=11)

    def test_a_real_project_generation_keeps_its_clip_ids_on_the_job(self):
        self.core.enqueue_project_generation("lofi", PACKET, dry_run=False)
        job = authenticate(self.core)[1]["job"]
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "done", "dryRun": False, "clipIds": [SONG_A, SONG_B]})
        stored = self.stored(job["id"])
        self.assertEqual((stored.status, stored.result["clip_ids"]), ("done", [SONG_A, SONG_B]))

    def test_a_song_still_being_made_on_suno_is_not_queued(self):
        with self.assertRaises(ProjectError):
            self.core.enqueue_project_songs("lofi", [SONG_RENDERING], "download")

    def test_a_second_real_create_waits_while_the_first_is_unsettled(self):
        """An agent retrying after a lost answer must not press Create twice."""
        self.core.enqueue_project_generation("lofi", PACKET, dry_run=False)
        with self.assertRaises(ProjectError):
            self.core.enqueue_project_generation("lofi", PACKET, dry_run=False)
        more = self.core.enqueue_project_generation("lofi", PACKET, dry_run=False, allow_additional=True)
        self.assertEqual(more["added"], ["lofi.02.B02"], "thêm có chủ đích thì được")
        self.assertEqual(self.core.enqueue_project_generation("lofi", PACKET)["added"], ["lofi.03.B03"], "dry-run không bị chặn")

    def test_requeuing_a_real_create_needs_the_users_ok_again(self):
        from goha_suno.suno_jobs import JobTransitionError

        self.core.enqueue_project_generation("lofi", PACKET, dry_run=False)
        job = authenticate(self.core)[1]["job"]
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "failed", "reason": "content:fill_create_form"})
        with self.assertRaises(JobTransitionError):
            self.core.requeue(job["id"])
        self.core.requeue(job["id"], confirm_spend=True)
        self.assertEqual(self.stored(job["id"]).status, "sent", "xếp lại rồi giao đi ngay")

    def test_one_damaged_project_file_does_not_stop_the_bridge(self):
        (self.home / "broken").mkdir(parents=True)
        (self.home / "broken" / "broken-suno-jobs.json").write_text("{not json", encoding="utf-8")
        self.core.enqueue_project_songs("lofi", [SONG_A], "download")
        fresh = BridgeCore(token=TOKEN, now=clock, local_dir=self.tmp / "local",
                           clip_status_fetch=clips, projects_root=self.home)
        fresh.recover()
        self.assertEqual(len(fresh.jobs("lofi")), 1)
        self.assertEqual(fresh.status()["alerts"][-1]["kind"], "project_unreadable")

    def test_a_restarted_bridge_finds_project_jobs_and_marks_the_one_out_unknown(self):
        self.core.enqueue_project_songs("lofi", [SONG_A], "download")
        authenticate(self.core)
        fresh = BridgeCore(token=TOKEN, now=clock, local_dir=self.tmp / "local",
                           clip_status_fetch=clips, projects_root=self.home)
        fresh.recover()
        self.assertEqual([j["status"] for j in fresh.jobs("lofi")], ["unknown"])


if __name__ == "__main__":
    unittest.main()
