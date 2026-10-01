"""The core's own rules -- pairing, protocol, queue, results and credit safety -- driven with project jobs."""

import json
import shutil
import tempfile
import unittest
from pathlib import Path, PureWindowsPath
from unittest import mock

from goha_suno.suno_bridge_core import (
    BRIDGE_VERSION,
    PROTOCOL_VERSION,
    load_or_create_token,
    local_wav_path,
    origin_allowed,
    pairing_token,
)
from goha_suno.suno_clip_status import ClipStatus
from goha_suno.suno_jobs import JobTransitionError
from tests.helpers import (
    CLIENT_NONCE,
    CLIP_ID,
    EXPORT_ID,
    PACKET,
    PROJECT,
    SONG_A,
    SONG_B,
    TITLE_A,
    TITLE_B,
    TOKEN,
    authenticate,
    compute_proof,
    make_core,
    project_store,
    write_suno_wav,
)

LOCAL_WAV = PureWindowsPath("C:/", "Users", "RealName", "Downloads", "GOHA-Suno", "lofi", "a.wav")


class PairingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_token_is_created_once_and_reused(self):
        first = load_or_create_token(self.tmp / "cfg")
        self.assertEqual(first, load_or_create_token(self.tmp / "cfg"))
        self.assertGreaterEqual(len(first), 40)

    def test_pairing_code_from_the_extension_wins_over_the_file(self):
        code = "A" * 20 + "b_-" + "9" * 20
        self.assertEqual(pairing_token(self.tmp / "cfg", {"JR_SUNO_PAIRING_CODE": f"  {code} "}), code)
        self.assertFalse((self.tmp / "cfg").exists(), "mã từ extension không bị ghi ra file")

    def test_without_the_env_var_the_file_code_is_used(self):
        self.assertEqual(pairing_token(self.tmp / "cfg", {}), load_or_create_token(self.tmp / "cfg"))

    def test_a_malformed_pairing_code_fails_fast_with_a_clear_message(self):
        for bad in ("short", "has space " + "x" * 40, "x" * 200):
            with self.assertRaises(ValueError) as caught:
                pairing_token(self.tmp / "cfg", {"JR_SUNO_PAIRING_CODE": bad})
            self.assertIn("sao chép lại cấu hình MCP", str(caught.exception))

    def test_only_extension_origins_may_connect(self):
        self.assertTrue(origin_allowed("chrome-extension://abcdefghijklmnopabcdefghijklmnop"))
        self.assertFalse(origin_allowed("https://suno.com"))
        self.assertFalse(origin_allowed("null"))
        self.assertFalse(origin_allowed(None))

    def test_protocol_version_is_2(self):
        self.assertEqual(PROTOCOL_VERSION, 2)

    def test_bridge_version_matches_the_extension_manifest(self):
        """The footer warns on a mismatch; shipping both at the same number keeps that warning meaningful."""
        manifest = Path(__file__).resolve().parents[2] / "extension" / "manifest.json"
        self.assertEqual(BRIDGE_VERSION, json.loads(manifest.read_text(encoding="utf-8"))["version"])


class CoreTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.core = make_core(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def connect(self, core=None):
        return authenticate(core or self.core)

    def stored(self, job_id):
        return project_store(self.tmp).get(job_id)

    def queue_two_downloads(self, core=None):
        return (core or self.core).enqueue_project_songs(PROJECT, [SONG_A, SONG_B], "download")


class HandshakeTests(CoreTestCase):
    def test_an_older_extension_is_told_to_reload_and_gets_no_job_first(self):
        self.queue_two_downloads()
        out = authenticate(self.core, version="0.0.1")
        self.assertEqual([m["type"] for m in out], ["welcome", "reload"])

    def test_work_queued_while_an_older_extension_reloads_waits_for_the_new_version(self):
        authenticate(self.core, version="0.0.1")
        self.queue_two_downloads()
        self.assertFalse(any(m["type"] == "job" for m in self.core.drain()))
        self.core.on_disconnect()
        self.assertIn("job", [m["type"] for m in self.connect()])

    def test_an_extension_that_comes_back_still_old_is_asked_once_then_works_and_the_user_is_told(self):
        authenticate(self.core, version="0.0.1")
        self.core.on_disconnect()
        self.queue_two_downloads()
        out = authenticate(self.core, version="0.0.1")
        self.assertNotIn("reload", [m["type"] for m in out])
        self.assertIn("job", [m["type"] for m in out])
        self.assertEqual(self.core.status()["alerts"][-1]["kind"], "extension_outdated")

    def test_a_current_or_unreadable_extension_version_is_never_told_to_reload(self):
        for version in (BRIDGE_VERSION, "9.9.9", "dev-build", ""):
            with self.subTest(version=version):
                core = make_core(self.tmp)
                self.assertNotIn("reload", [m["type"] for m in authenticate(core, version=version)])

    def test_welcome_carries_the_bridge_version_for_the_panel_footer(self):
        welcome = self.connect()[0]
        self.assertEqual(welcome["bridgeVersion"], BRIDGE_VERSION)
        self.assertRegex(BRIDGE_VERSION, r"^\d+\.\d+\.\d+$")

    def test_welcome_tells_the_extension_where_the_bridge_lives_only_after_auth(self):
        path = self.tmp / "bridge" / "goha_suno" / "suno_agent_bridge.py"
        welcome = authenticate(make_core(self.tmp, bridge_path=path))[0]
        self.assertEqual((welcome["type"], welcome["bridgePath"]), ("welcome", str(path)))
        self.assertNotIn("bridgePath", self.connect()[0], "không cấu hình đường dẫn thì không gửi")

    def test_a_wrong_auth_proof_is_refused_and_nothing_is_dispatched(self):
        self.queue_two_downloads()
        self.core.on_connect()
        self.core.on_message({"type": "hello", "protocol": PROTOCOL_VERSION, "nonce": CLIENT_NONCE})
        self.core.drain()
        self.core.on_message({"type": "auth", "proof": "0" * 64})
        self.assertEqual([m["type"] for m in self.core.drain()], ["error", "close"])
        self.assertFalse(self.core.status()["connected"])

    def test_a_hello_with_the_wrong_protocol_is_refused(self):
        self.core.on_connect()
        self.core.on_message({"type": "hello", "protocol": 99, "nonce": CLIENT_NONCE})
        self.assertEqual([m["type"] for m in self.core.drain()], ["error", "close"])
        self.assertFalse(self.core.awaiting_auth)

    def test_a_hello_with_a_malformed_nonce_is_refused(self):
        self.core.on_connect()
        self.core.on_message({"type": "hello", "protocol": PROTOCOL_VERSION, "nonce": "too-short"})
        self.assertEqual([m["type"] for m in self.core.drain()], ["error", "close"])

    def test_an_auth_without_a_preceding_hello_is_refused(self):
        self.core.on_connect()
        self.core.on_message({"type": "auth", "proof": "0" * 64})
        self.assertEqual([m["type"] for m in self.core.drain()], ["error", "close"])
        self.assertFalse(self.core.status()["connected"])

    def test_the_token_never_appears_in_any_outgoing_message(self):
        self.core.on_connect()
        self.core.on_message({"type": "hello", "protocol": PROTOCOL_VERSION, "nonce": CLIENT_NONCE})
        challenge_out = self.core.drain()
        self.assertNotIn(TOKEN, repr(challenge_out))
        proof = compute_proof(TOKEN, f"jr-suno/ext/{challenge_out[0]['nonce']}/{CLIENT_NONCE}")
        self.core.on_message({"type": "auth", "proof": proof})
        self.assertNotIn(TOKEN, repr(self.core.drain()))
        self.assertTrue(self.core.status()["connected"])

    def test_a_replayed_auth_with_a_different_server_nonce_fails(self):
        self.core.on_connect()
        self.core.on_message({"type": "hello", "protocol": PROTOCOL_VERSION, "nonce": CLIENT_NONCE})
        stale_proof = compute_proof(TOKEN, f"jr-suno/ext/{self.core.drain()[0]['nonce']}/{CLIENT_NONCE}")
        self.core.on_message({"type": "hello", "protocol": PROTOCOL_VERSION, "nonce": CLIENT_NONCE})
        self.core.drain()
        self.core.on_message({"type": "auth", "proof": stale_proof})
        self.assertEqual([m["type"] for m in self.core.drain()], ["error", "close"])
        self.assertFalse(self.core.status()["connected"])

    def test_a_correct_auth_proof_connects_and_a_wrong_one_never_will(self):
        self.core.on_connect()
        self.core.on_message({"type": "hello", "protocol": PROTOCOL_VERSION, "nonce": CLIENT_NONCE})
        challenge = self.core.drain()[0]
        good = compute_proof(TOKEN, f"jr-suno/ext/{challenge['nonce']}/{CLIENT_NONCE}")
        self.core.on_message({"type": "auth", "proof": good[:-1] + ("0" if good[-1] != "0" else "1")})
        self.assertFalse(self.core.status()["connected"])

    def test_messages_before_hello_are_refused(self):
        self.queue_two_downloads()
        self.core.on_connect()
        self.core.on_message({"type": "result", "jobId": "x", "status": "done"})
        self.assertEqual([m["type"] for m in self.core.drain()], ["error", "close"])

    def test_a_stop_pressed_while_offline_pauses_the_queue_before_any_job_goes_out(self):
        self.queue_two_downloads()
        self.assertEqual([m["type"] for m in authenticate(self.core, stopped=True)], ["welcome"])
        self.assertTrue(self.core.status()["paused"])
        self.assertEqual(self.core.status()["alerts"][-1]["kind"], "user_stop")

    def test_a_stop_flag_in_a_hello_that_fails_pairing_changes_nothing(self):
        self.queue_two_downloads()
        self.core.on_connect()
        self.core.on_message({"type": "hello", "protocol": PROTOCOL_VERSION, "version": "x", "nonce": CLIENT_NONCE, "stopped": True})
        self.core.drain()
        self.core.on_message({"type": "auth", "proof": "0" * 64})
        self.assertFalse(self.core.status()["paused"])


class DownloadQueueTests(CoreTestCase):
    def test_one_job_at_a_time_after_a_good_hello(self):
        self.assertEqual(len(self.queue_two_downloads()["added"]), 2)
        out = self.connect()
        self.assertEqual([m["type"] for m in out], ["welcome", "job"])
        self.assertEqual((out[1]["job"]["candidateId"], out[1]["job"]["expectedTitle"]), (SONG_A, TITLE_A))
        self.assertNotIn("path", out[1]["job"])

    def test_done_result_advances_to_the_next_job_and_checks_the_title(self):
        self.queue_two_downloads()
        job = self.connect()[1]["job"]
        self.core.on_message({"type": "progress", "jobId": job["id"], "step": "studio_loaded"})
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "done", "exportId": EXPORT_ID,
                              "filename": f"{TITLE_A} (1).wav", "path": "C:/x/GOHA-Suno/lofi/a.wav", "seconds": 327.9})
        self.assertEqual(self.core.drain()[-1]["job"]["candidateId"], SONG_B)
        stored = self.stored(job["id"])
        self.assertEqual((stored.status, stored.result["title_ok"], stored.result["export_id"]), ("done", True, EXPORT_ID))

    def test_a_filename_for_another_song_is_flagged(self):
        self.queue_two_downloads()
        job = self.connect()[1]["job"]
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "done", "exportId": EXPORT_ID,
                              "filename": f"{TITLE_B}.wav", "seconds": 327.9})
        self.assertFalse(self.stored(job["id"]).result["title_ok"])

    def test_the_local_path_never_reaches_the_jobs_file_but_its_folder_is_remembered(self):
        self.queue_two_downloads()
        job = self.connect()[1]["job"]
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "done", "exportId": EXPORT_ID,
                              "filename": f"{TITLE_A}.wav", "path": str(LOCAL_WAV), "seconds": 327.9})
        tracked = project_store(self.tmp).path.read_text(encoding="utf-8")
        self.assertNotIn("RealName", tracked)
        self.assertNotIn("Downloads", tracked)
        self.assertEqual(self.core.download_dir(PROJECT), Path(LOCAL_WAV.parent))
        self.assertEqual(make_core(self.tmp).download_dir(PROJECT), Path(LOCAL_WAV.parent), "nhớ qua lần khởi động lại")

    def test_no_finished_download_means_no_download_dir(self):
        self.assertIsNone(self.core.download_dir(PROJECT))

    def test_a_finished_download_reads_the_wavs_suno_stamp_when_the_file_exists(self):
        self.queue_two_downloads()
        job = self.connect()[1]["job"]
        path = self.tmp / "downloaded.wav"
        write_suno_wav(path, EXPORT_ID, studio=True)
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "done", "exportId": EXPORT_ID,
                              "filename": f"{TITLE_A}.wav", "path": str(path), "seconds": 327.9})
        stored = self.stored(job["id"])
        self.assertTrue(stored.result["stamp_ok"])
        self.assertTrue(stored.result["stamp_studio"])

    def test_a_missing_download_file_does_not_fail_the_job(self):
        self.queue_two_downloads()
        job = self.connect()[1]["job"]
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "done", "exportId": EXPORT_ID,
                              "filename": f"{TITLE_A}.wav", "path": "C:/nowhere/missing.wav", "seconds": 327.9})
        stored = self.stored(job["id"])
        self.assertEqual(stored.status, "done")
        self.assertNotIn("stamp_ok", stored.result)

    def test_a_network_share_path_from_the_extension_is_never_touched(self):
        """A UNC path would make Windows try SMB authentication to someone else's machine."""
        self.queue_two_downloads()
        job = self.connect()[1]["job"]
        unc = str(PureWindowsPath("//evil.example/share/x.wav"))
        self.assertTrue(unc.startswith("\\\\"))
        for hostile in (unc, "//evil.example/share/x.wav", "C:/fine/../x.wav", "relative/x.wav", "C:/x.exe", "C:x.wav"):
            self.assertIsNone(local_wav_path(hostile), hostile)
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "done", "exportId": EXPORT_ID,
                              "filename": f"{TITLE_A}.wav", "path": unc, "seconds": 327.9})
        stored = self.stored(job["id"])
        self.assertEqual(stored.status, "done")
        self.assertTrue(stored.result["path_rejected"])
        self.assertIsNone(self.core.download_dir(PROJECT), "a rejected path is not remembered")

    def test_a_plain_local_windows_or_posix_wav_path_is_accepted(self):
        self.assertIsNotNone(local_wav_path(str(LOCAL_WAV)))
        self.assertIsNotNone(local_wav_path("/home/x/GOHA-Suno/lofi/a (1).WAV"))

    def test_a_result_for_a_job_that_is_not_out_is_rejected(self):
        self.queue_two_downloads()
        self.connect()
        self.core.on_message({"type": "result", "jobId": "lofi.09.nope", "status": "done", "exportId": EXPORT_ID, "filename": "a.wav"})
        self.assertEqual(self.core.drain()[-1]["type"], "error")

    def test_a_result_with_an_unknown_status_is_refused(self):
        self.queue_two_downloads()
        job = self.connect()[1]["job"]
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "cancelled"})
        self.assertEqual(self.core.drain()[-1]["type"], "error")
        self.assertEqual(self.stored(job["id"]).status, "sent")

    def test_a_driver_failure_keeps_a_trimmed_picture_of_the_page(self):
        self.queue_two_downloads()
        job = self.connect()[1]["job"]
        hint = {"path": "/studio", "labels": ["Export menu", 7, "x" * 500] + [f"b{i}" for i in range(60)]}
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "failed", "reason": "content:x", "domHint": hint})
        stored = self.stored(job["id"]).result["dom_hint"]
        self.assertEqual(stored["path"], "/studio")
        self.assertEqual(len(stored["labels"]), 40)
        self.assertTrue(all(isinstance(label, str) and len(label) <= 60 for label in stored["labels"]))

    def test_each_step_and_the_send_are_time_stamped(self):
        times = iter(["2026-09-28T01:00:00Z", "2026-09-28T01:00:05Z", "2026-09-28T01:00:40Z", "2026-09-28T01:00:41Z"])
        core = make_core(self.tmp, now=lambda: next(times, "2026-09-28T01:09:00Z"))
        self.queue_two_downloads(core)
        job = authenticate(core)[1]["job"]
        for step in ("opening_studio", "exporting", "exporting"):
            core.on_message({"type": "progress", "jobId": job["id"], "step": step})
        stored = self.stored(job["id"])
        self.assertIn("sent_at", stored.result)
        self.assertEqual(list(stored.result["step_times"]), ["opening_studio", "exporting"], "mỗi bước ghi một lần")
        self.assertLess(stored.result["sent_at"], stored.result["step_times"]["opening_studio"])

    def test_a_malformed_export_id_in_progress_is_not_kept(self):
        self.queue_two_downloads()
        job = self.connect()[1]["job"]
        self.core.on_message({"type": "progress", "jobId": job["id"], "step": "checking_export", "exportId": "../../x"})
        self.assertNotIn("export_id", self.stored(job["id"]).result)

    def test_status_reports_counts_without_secrets(self):
        self.queue_two_downloads()
        self.connect()
        status = self.core.status()
        self.assertTrue(status["connected"])
        self.assertEqual(status["counts"], {"queued": 1, "sent": 1})
        self.assertNotIn(TOKEN, repr(status))

    def test_cancel_a_queued_job_tells_nobody_and_skips_it(self):
        self.queue_two_downloads()
        self.core.cancel(self.core.jobs(PROJECT)[0]["id"])
        self.assertEqual(self.connect()[-1]["job"]["candidateId"], SONG_B)

    def test_cancel_the_job_that_is_out_tells_the_extension(self):
        self.queue_two_downloads()
        job = self.connect()[1]["job"]
        self.core.cancel(job["id"])
        self.assertEqual(self.core.drain()[0], {"type": "cancel", "jobId": job["id"]})


class PauseAndRecoveryTests(CoreTestCase):
    def test_a_pause_survives_a_bridge_restart(self):
        """Paused for a CAPTCHA, then the agent restarts: the queue must not quietly run again."""
        self.connect()
        self.core.on_message({"type": "alert", "kind": "captcha"})
        reborn = make_core(self.tmp)
        self.assertTrue(reborn.status()["paused"])
        reborn.resume()
        self.assertFalse(make_core(self.tmp).status()["paused"])

    def test_a_restarted_bridge_knows_every_queue_and_marks_lost_work_unknown(self):
        self.queue_two_downloads()
        sent = self.connect()[1]["job"]
        reborn = make_core(self.tmp)  # the old process died without a clean disconnect
        self.assertEqual(reborn.status()["counts"], {}, "chưa giành được cổng thì chưa đụng sổ job")
        reborn.recover()
        self.assertEqual(reborn.status()["counts"], {"unknown": 1, "queued": 1})
        self.assertEqual(self.stored(sent["id"]).status, "unknown")
        # Lost before any step was reported: nothing was made on Suno, so it simply runs again first.
        self.assertEqual(authenticate(reborn)[-1]["job"]["id"], sent["id"])

    def test_one_damaged_job_file_does_not_stop_the_bridge(self):
        (self.tmp / "GOHA-Suno" / "broken").mkdir(parents=True)
        (self.tmp / "GOHA-Suno" / "broken" / "broken-suno-jobs.json").write_text("{not json", encoding="utf-8")
        self.queue_two_downloads()
        fresh = make_core(self.tmp)
        fresh.recover()
        self.assertEqual(len(fresh.jobs(PROJECT)), 2)
        self.assertEqual(fresh.status()["alerts"][-1]["kind"], "project_unreadable")

    def test_a_folder_that_is_not_a_project_name_is_left_alone(self):
        folder = self.tmp / "GOHA-Suno" / "EP900"
        folder.mkdir(parents=True)
        (folder / "EP900-suno-jobs.json").write_text('{"jobs": []}', encoding="utf-8")
        fresh = make_core(self.tmp)
        fresh.recover()
        self.assertEqual(fresh.queue_picture()["episodes"], [])

    def test_captcha_pauses_the_queue_until_the_agent_resumes(self):
        self.queue_two_downloads()
        job = self.connect()[1]["job"]
        self.core.on_message({"type": "alert", "kind": "captcha"})
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "needs_human", "reason": "captcha"})
        self.assertEqual(self.core.drain(), [], "đang dừng thì không gửi job mới")
        self.assertTrue(self.core.status()["paused"])
        self.assertEqual(self.core.status()["alerts"][-1]["kind"], "captcha")
        self.core.resume()
        self.assertEqual(self.core.drain()[-1]["job"]["candidateId"], SONG_B)

    def test_needs_human_pauses_the_queue_even_before_its_alert_arrives(self):
        self.queue_two_downloads()
        job = self.connect()[1]["job"]
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "needs_human", "reason": "tab_hidden"})
        self.assertEqual(self.core.drain(), [])
        self.assertTrue(self.core.status()["paused"])
        self.core.resume()
        self.assertEqual(self.core.drain()[-1]["job"]["candidateId"], SONG_B)

    def test_stop_from_the_side_panel_pauses_the_queue_like_captcha(self):
        self.queue_two_downloads()
        job = self.connect()[1]["job"]
        self.core.on_message({"type": "alert", "kind": "user_stop"})
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "needs_human", "reason": "user_stop"})
        self.assertEqual(self.core.drain(), [])
        self.assertTrue(self.core.status()["paused"])

    def test_link_drop_mid_export_leaves_the_job_unknown_and_does_not_resend_it(self):
        """Lost mid-export: Suno may already hold an export, so only a person decides (no silent duplicate)."""
        self.queue_two_downloads()
        job = self.connect()[1]["job"]
        self.core.on_message({"type": "progress", "jobId": job["id"], "step": "exporting"})
        self.core.on_disconnect()
        self.assertEqual(self.stored(job["id"]).status, "unknown")
        self.assertEqual(self.connect()[-1]["job"]["candidateId"], SONG_B)
        self.assertEqual(self.stored(job["id"]).status, "unknown")

    def test_on_reconnect_a_download_lost_before_exporting_is_retried_automatically(self):
        self.queue_two_downloads()
        job = self.connect()[1]["job"]
        self.core.on_message({"type": "progress", "jobId": job["id"], "step": "opening_studio"})
        self.core.on_disconnect()
        self.assertEqual(self.connect()[-1]["job"]["id"], job["id"])

    def test_run_on_retries_a_job_stopped_before_it_exported(self):
        self.queue_two_downloads()
        job = self.connect()[1]["job"]
        self.core.on_message({"type": "progress", "jobId": job["id"], "step": "opening_studio"})
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "needs_human", "reason": "tab_hidden"})
        self.core.drain()
        self.core.on_message({"type": "control", "action": "resume"})
        self.assertFalse(self.core.status()["paused"])
        self.assertEqual(self.core.drain()[-1]["job"]["id"], job["id"])

    def test_run_on_resumes_a_job_that_exported_from_its_export_without_exporting_again(self):
        self.queue_two_downloads()
        job = self.connect()[1]["job"]
        self.core.on_message({"type": "progress", "jobId": job["id"], "step": "checking_export", "exportId": EXPORT_ID})
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "needs_human", "reason": "tab_hidden", "exportId": EXPORT_ID})
        self.core.drain()
        self.core.on_message({"type": "control", "action": "resume"})
        resent = self.core.drain()[-1]["job"]
        self.assertEqual((resent["id"], resent["exportId"]), (job["id"], EXPORT_ID))

    def test_run_on_leaves_a_job_that_may_already_have_exported_to_the_agent(self):
        self.queue_two_downloads()
        job = self.connect()[1]["job"]
        self.core.on_message({"type": "progress", "jobId": job["id"], "step": "opening_song"})
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "needs_human", "reason": "tab_hidden"})
        self.core.drain()
        self.core.on_message({"type": "control", "action": "resume"})
        self.assertEqual(self.stored(job["id"]).status, "needs_human")
        self.assertEqual(self.core.drain()[-1]["job"]["candidateId"], SONG_B, "việc khác vẫn chạy tiếp")

    def test_an_unknown_control_action_is_refused(self):
        self.connect()
        self.core.on_message({"type": "control", "action": "format_disk"})
        self.assertEqual(self.core.drain()[-1]["type"], "error")

    def test_a_job_the_extension_silently_dropped_is_taken_back_and_retried_when_safe(self):
        clock_now = ["2026-09-28T16:00:00Z"]
        core = make_core(self.tmp, now=lambda: clock_now[0])
        self.queue_two_downloads(core)
        job = authenticate(core)[1]["job"]
        core.on_message({"type": "progress", "jobId": job["id"], "step": "opening_studio"})
        core.drain()
        clock_now[0] = "2026-09-28T16:00:45Z"
        core.on_message({"type": "heartbeat", "phase": "idle"})
        self.assertEqual([m["job"]["id"] for m in core.drain() if m.get("type") == "job"], [job["id"]])

    def test_a_short_idle_heartbeat_right_after_sending_is_not_a_drop(self):
        core = make_core(self.tmp, now=lambda: "2026-09-28T16:00:00Z")
        self.queue_two_downloads(core)
        job = authenticate(core)[1]["job"]
        core.on_message({"type": "heartbeat", "phase": "idle"})
        self.assertEqual(self.stored(job["id"]).status, "sent")


class QueuePictureTests(CoreTestCase):
    def test_the_queue_picture_goes_out_once_connected_and_only_when_it_changes(self):
        self.queue_two_downloads()
        self.assertIsNone(self.core.queue_update(), "chưa nối thì không gửi")
        job = self.connect()[1]["job"]
        update = self.core.queue_update()
        self.assertEqual((update["type"], update["paused"]), ("queue", False))
        [listed] = update["episodes"]
        self.assertEqual(listed["episode"], PROJECT)
        statuses = {j["id"]: j["status"] for j in listed["jobs"]}
        self.assertEqual(sorted(statuses.values()), ["queued", "sent"])
        first = next(j for j in listed["jobs"] if j["id"] == job["id"])
        self.assertEqual((first["title"], first["kind"]), (TITLE_A, "export_download"))
        self.assertIsNone(self.core.queue_update(), "không đổi thì không gửi lại")
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "needs_human", "reason": "tab_hidden"})
        update = self.core.queue_update()
        self.assertTrue(update["paused"])
        stopped = next(j for j in update["episodes"][0]["jobs"] if j["id"] == job["id"])
        self.assertEqual((stopped["status"], stopped["reason"]), ("needs_human", "tab_hidden"))

    def test_a_capped_queue_picture_keeps_the_most_recently_active_list(self):
        times = iter(["2026-09-28T01:00:00Z", "2026-09-28T02:00:00Z"])
        core = make_core(self.tmp, now=lambda: next(times, "2026-09-28T03:00:00Z"))
        core.enqueue_project_songs("older", [SONG_A], "download")
        core.enqueue_project_songs(PROJECT, [SONG_B], "download")
        with mock.patch("goha_suno.suno_bridge_core.QUEUE_PICTURE_MAX_JOBS", 1):
            picture = core.queue_picture()
        self.assertEqual([listed["episode"] for listed in picture["episodes"]], [PROJECT])

    def test_a_reconnected_extension_gets_the_queue_picture_again(self):
        self.queue_two_downloads()
        self.connect()
        self.assertIsNotNone(self.core.queue_update())
        self.core.on_disconnect()
        self.connect()
        self.assertIsNotNone(self.core.queue_update())


def faithful_render(packet):
    """Suno's public clip endpoint for a render that followed the packet."""
    return lambda ids: [ClipStatus(i, "complete", "t", 330.0, "gen", packet["styles"], packet["exclude"], False, True, None) for i in ids]


class GenerationTests(CoreTestCase):
    def queue_real(self, core=None):
        return (core or self.core).enqueue_project_generation(PROJECT, {**PACKET, "durationSeconds": 330}, dry_run=False)

    def test_a_dry_run_generation_is_queued_and_sent(self):
        self.core.enqueue_project_generation(PROJECT, PACKET)
        job = self.connect()[-1]["job"]
        self.assertEqual((job["kind"], job["dryRun"]), ("generate", True))

    def test_the_jobs_own_dry_run_flag_decides_not_what_the_extension_claims(self):
        self.queue_real()
        job = self.connect()[-1]["job"]
        # A real job reported as a "dry run" with no clip ids must not slip through as done.
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "done", "dryRun": True})
        self.assertEqual(self.stored(job["id"]).status, "sent")
        self.assertEqual(self.core.drain()[-1]["type"], "error")

    def test_a_dry_run_job_stays_a_dry_run_whatever_the_extension_says(self):
        self.core.enqueue_project_generation(PROJECT, PACKET)
        job = self.connect()[-1]["job"]
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "done", "dryRun": False, "clipIds": [CLIP_ID]})
        stored = self.stored(job["id"])
        self.assertTrue(stored.result["dry_run"])
        self.assertTrue(stored.result["dry_run_mismatch"])
        self.assertNotIn("packet_check", stored.result)

    def test_only_well_formed_clip_ids_are_kept(self):
        self.queue_real()
        job = self.connect()[-1]["job"]
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "failed", "reason": "clip_error",
                              "clipIds": [CLIP_ID, CLIP_ID + "x", "../../etc", 5]})
        self.assertEqual(self.stored(job["id"]).result["clip_ids"], [CLIP_ID])

    def test_a_real_done_result_keeps_the_clip_ids_and_runs_the_packet_check(self):
        packet = {**PACKET, "durationSeconds": 330}
        core = make_core(self.tmp, clip_status_fetch=faithful_render(packet))
        self.queue_real(core)
        job = authenticate(core)[-1]["job"]
        core.on_message({"type": "result", "jobId": job["id"], "status": "done", "dryRun": False,
                         "clipIds": [CLIP_ID], "seconds": {CLIP_ID: 330.4}, "observed": {"model": "v6", "nested": {"x": 1}}})
        stored = self.stored(job["id"])
        self.assertEqual((stored.status, stored.result["clip_ids"]), ("done", [CLIP_ID]))
        self.assertTrue(stored.result["packet_check"][CLIP_ID]["ok"])
        self.assertEqual(stored.result["observed"], {"model": "v6"}, "chỉ giữ giá trị phẳng")

    def test_a_clip_status_fetch_failure_is_recorded_as_unavailable_not_a_crash(self):
        def broken(ids):
            raise OSError("network down")

        core = make_core(self.tmp, clip_status_fetch=broken)
        self.queue_real(core)
        job = authenticate(core)[-1]["job"]
        core.on_message({"type": "result", "jobId": job["id"], "status": "done", "dryRun": False, "clipIds": [CLIP_ID]})
        self.assertTrue(self.stored(job["id"]).result["packet_check"]["unavailable"])

    def test_a_failed_result_with_clip_ids_keeps_them_and_the_mismatched_fields(self):
        self.queue_real()
        job = self.connect()[-1]["job"]
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "failed", "reason": "form_mismatch",
                              "clipIds": [CLIP_ID], "mismatches": ["max_mode", "weirdness"]})
        stored = self.stored(job["id"])
        self.assertEqual((stored.status, stored.result["clip_ids"]), ("failed", [CLIP_ID]))
        self.assertEqual(stored.result["mismatches"], ["max_mode", "weirdness"])

    def test_a_second_real_create_waits_while_the_first_is_unsettled_unless_asked_on_purpose(self):
        self.queue_real()
        job = self.connect()[-1]["job"]
        self.core.on_message({"type": "progress", "jobId": job["id"], "step": "submitting"})
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "needs_human", "reason": "tab_hidden"})
        from goha_suno.suno_projects import ProjectError

        with self.assertRaises(ProjectError):
            self.queue_real()
        more = self.core.enqueue_project_generation(PROJECT, PACKET, dry_run=False, allow_additional=True)
        self.assertEqual(more["added"], ["lofi.02.B02"])

    def test_a_create_stopped_before_the_click_does_not_hold_up_the_next(self):
        self.queue_real()
        job = self.connect()[-1]["job"]
        self.core.on_message({"type": "progress", "jobId": job["id"], "step": "filling_form"})
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "failed", "reason": "content:x"})
        self.assertEqual(self.queue_real()["added"], ["lofi.02.B02"])

    def test_requeuing_a_real_create_needs_the_users_ok_again(self):
        self.queue_real()
        job = self.connect()[-1]["job"]
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "failed", "reason": "content:fill_create_form"})
        with self.assertRaises(JobTransitionError):
            self.core.requeue(job["id"])
        self.core.requeue(job["id"], confirm_spend=True)
        self.assertEqual(self.stored(job["id"]).status, "sent")

    def test_requeuing_a_real_create_keeps_the_clips_already_paid_for(self):
        self.queue_real()
        job = self.connect()[-1]["job"]
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "failed", "reason": "x", "clipIds": [CLIP_ID]})
        self.core.requeue(job["id"], confirm_spend=True)
        self.assertEqual(self.stored(job["id"]).result["earlier_clip_ids"], [CLIP_ID])

    def test_run_on_never_retries_a_real_generation_stopped_at_the_create_step(self):
        self.queue_real()
        job = self.connect()[-1]["job"]
        self.core.on_message({"type": "progress", "jobId": job["id"], "step": "submitting"})
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "needs_human", "reason": "captcha"})
        self.core.on_message({"type": "control", "action": "resume"})
        self.assertEqual(self.stored(job["id"]).status, "needs_human")

    def test_run_on_retries_a_real_generation_stopped_while_filling_the_form(self):
        self.queue_real()
        job = self.connect()[-1]["job"]
        self.core.on_message({"type": "progress", "jobId": job["id"], "step": "filling_form"})
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "needs_human", "reason": "tab_hidden"})
        self.core.drain()
        self.core.on_message({"type": "control", "action": "resume"})
        self.assertEqual(self.core.drain()[-1]["job"]["id"], job["id"])

    def test_a_real_generation_lost_with_the_link_is_never_retried_on_its_own(self):
        self.queue_real()
        job = self.connect()[-1]["job"]
        self.core.on_message({"type": "progress", "jobId": job["id"], "step": "filling_form"})
        self.core.on_disconnect()
        self.assertEqual([m for m in self.connect() if m.get("type") == "job"], [])
        self.core.on_message({"type": "control", "action": "resume"})
        self.assertEqual([m for m in self.core.drain() if m.get("type") == "job"], [])
        self.assertEqual(self.stored(job["id"]).status, "unknown")

    def test_a_real_generation_the_extension_dropped_after_create_is_never_run_again(self):
        clock_now = ["2026-09-28T16:00:00Z"]
        core = make_core(self.tmp, now=lambda: clock_now[0])
        self.queue_real(core)
        job = authenticate(core)[-1]["job"]
        core.on_message({"type": "progress", "jobId": job["id"], "step": "submitting"})
        core.drain()
        clock_now[0] = "2026-09-28T16:00:45Z"
        core.on_message({"type": "heartbeat", "phase": "idle"})
        self.assertEqual(self.stored(job["id"]).status, "unknown")
        self.assertEqual([m for m in core.drain() if m.get("type") == "job"], [], "không tự gửi lại")
        self.assertIsNone(core.active_job_id)
        core.on_disconnect()
        again = [m for m in authenticate(core) if m.get("type") == "job"]
        core.on_message({"type": "control", "action": "resume"})
        again += [m for m in core.drain() if m.get("type") == "job"]
        self.assertEqual(again, [])

    def test_cancel_refuses_once_the_create_click_may_have_spent_credits(self):
        self.queue_real()
        job = self.connect()[-1]["job"]
        self.core.on_message({"type": "progress", "jobId": job["id"], "step": "submitting"})
        with self.assertRaises(JobTransitionError):
            self.core.cancel(job["id"])

    def test_cancel_still_works_while_only_filling_the_form(self):
        self.queue_real()
        job = self.connect()[-1]["job"]
        self.core.on_message({"type": "progress", "jobId": job["id"], "step": "filling_form"})
        self.core.cancel(job["id"])
        self.assertEqual(self.stored(job["id"]).status, "cancelled")

    def test_cancel_a_dry_run_generation_stays_allowed_even_past_submitting(self):
        self.core.enqueue_project_generation(PROJECT, PACKET)
        job = self.connect()[-1]["job"]
        self.core.on_message({"type": "progress", "jobId": job["id"], "step": "submitting"})
        self.core.cancel(job["id"])
        self.assertEqual(self.stored(job["id"]).status, "cancelled")

    def test_jobs_summary_shows_kind_and_clip_ids_for_generate_jobs(self):
        self.queue_real()
        job = self.connect()[-1]["job"]
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "failed", "reason": "x", "clipIds": [CLIP_ID]})
        summary = next(j for j in self.core.jobs(PROJECT) if j["id"] == job["id"])
        self.assertEqual((summary["kind"], summary["clip_ids"], summary["dry_run"]), ("generate", [CLIP_ID], False))


class OrphanTests(CoreTestCase):
    def orphaned_job(self):
        """Queue a real generation, hand it out, then drop the link so it goes `unknown`."""
        self.core.enqueue_project_generation(PROJECT, PACKET, dry_run=False)
        job = self.connect()[-1]["job"]
        self.core.on_disconnect()
        self.assertEqual(self.stored(job["id"]).status, "unknown")
        return job

    def test_an_orphan_report_merges_clip_ids_without_changing_status(self):
        job = self.orphaned_job()
        self.connect()
        self.core.on_message({"type": "orphan", "jobId": job["id"], "phase": "rendering", "clipIds": [CLIP_ID]})
        stored = self.stored(job["id"])
        self.assertEqual(stored.status, "unknown", "orphan không được tự đổi trạng thái job")
        self.assertEqual((stored.result["clip_ids"], stored.result["orphan_phase"]), ([CLIP_ID], "rendering"))
        self.assertEqual(stored.result["reason"], "service_worker_restart")

    def test_an_orphan_report_for_an_unknown_job_id_is_an_error_not_a_crash(self):
        self.connect()
        self.core.on_message({"type": "orphan", "jobId": "lofi.99.nope", "phase": "submitting", "clipIds": []})
        self.assertEqual(self.core.drain()[-1]["type"], "error")

    def test_an_orphan_report_drops_bad_ids_and_dedupes_against_what_is_already_recorded(self):
        job = self.orphaned_job()
        self.connect()
        self.core.on_message({"type": "orphan", "jobId": job["id"], "phase": "submitting", "clipIds": [CLIP_ID, "not-a-uuid", CLIP_ID]})
        self.assertEqual(self.stored(job["id"]).result["clip_ids"], [CLIP_ID])
        self.core.on_message({"type": "orphan", "jobId": job["id"], "phase": "rendering", "clipIds": []})
        stored = self.stored(job["id"])
        self.assertEqual((stored.result["clip_ids"], stored.result["orphan_phase"]), ([CLIP_ID], "rendering"))

    def test_an_orphan_report_for_a_job_not_eligible_is_an_error(self):
        self.core.enqueue_project_generation(PROJECT, PACKET)
        job = self.connect()[-1]["job"]
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "done", "dryRun": True, "observed": {}})
        self.connect()
        self.core.on_message({"type": "orphan", "jobId": job["id"], "phase": "rendering", "clipIds": [CLIP_ID]})
        self.assertEqual(self.core.drain()[-1]["type"], "error")


class StemsTests(CoreTestCase):
    def zip_path(self):
        return str(self.tmp / "Downloads" / "GOHA-Suno" / PROJECT / f"{TITLE_A}.zip")

    def queue_split(self, dry_run=False):
        return self.core.enqueue_project_songs(PROJECT, [SONG_A], "stems", dry_run=dry_run)

    def test_a_real_split_goes_out_records_spent_at_extract_and_files_the_zip(self):
        self.assertEqual(self.queue_split()["added"], ["lofi.01.ST1"])
        job = self.connect()[1]["job"]
        self.assertEqual((job["kind"], job["dryRun"]), ("stems_split", False))
        self.core.on_message({"type": "progress", "jobId": job["id"], "step": "extracting"})
        self.assertIs(self.stored(job["id"]).result["spent"], True, "đã tới bước bấm Extract = đã tiêu credit")
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "done", "filename": f"{TITLE_A}.zip",
                              "path": self.zip_path(), "stems": ["Bass", "Strings", 7], "spent": True})
        stored = self.stored(job["id"])
        self.assertEqual((stored.status, stored.result["stems"]), ("done", ["Bass", "Strings"]))
        self.assertEqual(self.core.download_dir(PROJECT), Path(self.zip_path()).parent)

    def test_the_extension_cannot_unsay_spent(self):
        self.queue_split()
        job = self.connect()[1]["job"]
        self.core.on_message({"type": "progress", "jobId": job["id"], "step": "extracting"})
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "failed", "reason": "timeout:extracting", "spent": False})
        self.assertIs(self.stored(job["id"]).result["spent"], True)

    def test_a_spent_split_requeued_tells_the_extension_never_to_press_extract_again(self):
        self.queue_split()
        job = self.connect()[1]["job"]
        self.core.on_message({"type": "progress", "jobId": job["id"], "step": "extracting"})
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "failed", "reason": "timeout:extracting"})
        with self.assertRaises(JobTransitionError):
            self.core.requeue(job["id"])  # a real split may spend credits again: the user's OK first
        self.core.requeue(job["id"], confirm_spend=True)
        resent = self.core.drain()[-1]["job"]
        self.assertEqual((resent["id"], resent["alreadySpent"]), (job["id"], True))

    def test_a_real_split_that_reports_no_zip_is_not_done(self):
        self.queue_split()
        job = self.connect()[1]["job"]
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "done", "filename": "x.exe", "path": "C:\\x.exe"})
        self.assertNotEqual(self.stored(job["id"]).status, "done")

    def test_a_dry_run_finishes_without_a_file_and_a_real_run_of_the_same_song_can_follow(self):
        self.queue_split(dry_run=True)
        job = self.connect()[1]["job"]
        self.assertIs(job["dryRun"], True)
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "done", "dryRun": True,
                              "hasStems": True, "stems": [], "spent": False})
        stored = self.stored(job["id"])
        self.assertEqual((stored.status, stored.result["stems"], stored.result["has_stems"]), ("done", [], True))
        self.assertEqual(self.queue_split()["added"], ["lofi.01.ST1"], "dry-run xong không chặn lần chạy thật cùng mã job")

    def test_a_real_split_is_never_replaced_by_a_new_request(self):
        self.queue_split()
        job = self.connect()[1]["job"]
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "failed", "reason": "x"})
        self.assertEqual(self.queue_split(dry_run=True)["skipped"], ["lofi.01.ST1"])
        self.assertFalse(self.stored(job["id"]).dry_run)

    def test_run_on_does_not_retry_a_job_stopped_while_suno_was_splitting(self):
        self.queue_split()
        job = self.connect()[1]["job"]
        self.core.on_message({"type": "progress", "jobId": job["id"], "step": "extracting"})
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "needs_human", "reason": "captcha"})
        self.core.drain()
        self.core.on_message({"type": "control", "action": "resume"})
        self.assertFalse(any(m.get("type") == "job" for m in self.core.drain()))
        self.assertEqual(self.stored(job["id"]).status, "needs_human")

    def test_run_on_retries_a_job_stopped_before_extract_it_costs_nothing(self):
        self.queue_split()
        job = self.connect()[1]["job"]
        self.core.on_message({"type": "progress", "jobId": job["id"], "step": "opening_stems"})
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "needs_human", "reason": "tab_hidden"})
        self.core.drain()
        self.core.on_message({"type": "control", "action": "resume"})
        resent = self.core.drain()[-1]["job"]
        self.assertEqual(resent["id"], job["id"])
        self.assertNotIn("alreadySpent", resent)

    def test_a_real_split_lost_with_the_link_is_never_retried_on_its_own(self):
        self.queue_split()
        job = self.connect()[1]["job"]
        self.core.on_message({"type": "progress", "jobId": job["id"], "step": "opening_stems"})
        self.core.on_disconnect()
        self.assertEqual([m for m in self.connect() if m.get("type") == "job"], [])
        self.assertEqual(self.stored(job["id"]).status, "unknown")


class MultitrackTests(CoreTestCase):
    def test_a_32bit_export_goes_out_and_its_zip_is_recorded(self):
        self.core.enqueue_project_songs(PROJECT, [SONG_A], "multitrack")
        job = self.connect()[1]["job"]
        self.assertEqual(job["kind"], "multitrack_export")
        path = str(self.tmp / "Downloads" / "GOHA-Suno" / PROJECT / f"{TITLE_A}.zip")
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "done", "filename": f"{TITLE_A}.zip", "path": path})
        stored = self.stored(job["id"])
        self.assertEqual((stored.status, stored.result["filename"]), ("done", f"{TITLE_A}.zip"))
        self.assertEqual(self.core.download_dir(PROJECT), Path(path).parent)

    def test_a_32bit_result_that_is_not_a_zip_is_refused(self):
        self.core.enqueue_project_songs(PROJECT, [SONG_A], "multitrack")
        job = self.connect()[1]["job"]
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "done", "filename": "x.exe", "path": "C:\\x.exe"})
        self.assertNotEqual(self.stored(job["id"]).status, "done")

    def test_run_on_retries_a_stopped_32bit_export_it_costs_nothing(self):
        self.core.enqueue_project_songs(PROJECT, [SONG_A], "multitrack")
        job = self.connect()[1]["job"]
        self.core.on_message({"type": "progress", "jobId": job["id"], "step": "exporting_multitrack"})
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "needs_human", "reason": "tab_hidden"})
        self.core.drain()
        self.core.on_message({"type": "control", "action": "resume"})
        self.assertEqual(self.core.drain()[-1]["job"]["id"], job["id"])

    def test_job_list_describes_song_jobs_without_generation_fields(self):
        self.core.enqueue_project_songs(PROJECT, [SONG_A], "multitrack")
        self.core.enqueue_project_songs(PROJECT, [SONG_A], "stems")
        summaries = {s["id"]: s for s in self.core.jobs(PROJECT)}
        self.assertEqual((summaries["lofi.01.ST1"]["take"], summaries["lofi.01.ST1"]["dry_run"]), (1, True))
        self.assertEqual(summaries["lofi.01.MT1"]["song_id"], SONG_A)
        self.assertNotIn("batch_id", summaries["lofi.01.MT1"])


if __name__ == "__main__":
    unittest.main()
