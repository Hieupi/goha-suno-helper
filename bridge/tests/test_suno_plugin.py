"""GOHA_SUNO_PLUGIN: loading a plugin, and what the core lets it own (its job lists, result follow-up, tools)."""

import asyncio
import shutil
import tempfile
import textwrap
import unittest
from pathlib import Path

from goha_suno.suno_agent_bridge import SocketBridge, build_server
from goha_suno.suno_jobs import DownloadJob, JobStore
from goha_suno.suno_plugin import Plugin, PluginError, load_plugin
from tests.helpers import EXPORT_ID, PROJECT, SONG_A, SONG_B, authenticate, make_core

PROJECT_TOOLS = {
    "suno_status", "suno_check_clips", "suno_jobs", "suno_pause", "suno_resume", "suno_cancel", "suno_requeue",
    "suno_download_songs", "suno_export_32bit", "suno_split_stems", "suno_generate",
}


class BookPlugin(Plugin):
    """A stand-in installation: job lists named BK### live in `<root>/BK###-<slug>/BK###-suno-jobs.json`."""

    instructions = "Books: use book_enqueue."

    def __init__(self, root: Path, title_verdict=None, fail_on_result=False):
        self.root = root
        self.title_verdict = title_verdict
        self.fail_on_result = fail_on_result
        self.results = []

    def claims(self, name):
        return name.startswith("BK")

    def job_file(self, name):
        [folder] = [d for d in self.root.iterdir() if d.name.startswith(name[:5])]
        return folder / f"{folder.name[:5]}-suno-jobs.json"

    def job_files(self):
        return self.root.glob("BK*/BK*-suno-jobs.json")

    def title_ok(self, store, job, stem):
        return self.title_verdict

    def on_result(self, core, store, job):
        if self.fail_on_result:
            raise ValueError("records are read-only")
        self.results.append((job.id, job.status, store.path))

    def register_tools(self, server, core, bridge):
        @server.tool()
        async def book_enqueue(name: str) -> dict:
            """Queue the book's downloads."""
            return {"added": len(core.add_jobs(core.store(name), plan(name))[0])}


def plan(name="BK001-first-book"):
    return [DownloadJob(id=f"BK001.0{slot}.{song}", episode=name, slot=slot, candidate_id=song, song_id=song,
                        expected_title=f"Chapter {slot}", min_seconds=60.0)
            for slot, song in ((1, SONG_A), (2, SONG_B))]


class LoadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, source: str) -> str:
        path = self.tmp / "my_plugin.py"
        path.write_text(textwrap.dedent(source), encoding="utf-8")
        return str(path)

    def test_no_variable_means_no_plugin(self):
        self.assertIsNone(load_plugin({}))
        self.assertIsNone(load_plugin({"GOHA_SUNO_PLUGIN": "  "}))

    def test_a_plugin_file_is_loaded_and_its_factory_called(self):
        path = self.write("""
            from dataclasses import dataclass
            from goha_suno.suno_plugin import Plugin

            @dataclass
            class Mine(Plugin):
                instructions: str = "mine"

            def create_plugin():
                return Mine()
        """)
        plugin = load_plugin({"GOHA_SUNO_PLUGIN": f'"{path}"'})
        self.assertIsInstance(plugin, Plugin)
        self.assertEqual(plugin.instructions, "mine")

    def test_a_missing_file_a_missing_factory_a_wrong_object_or_a_broken_file_fail_loudly(self):
        cases = {
            "missing": str(self.tmp / "nowhere.py"),
            "no factory": self.write("x = 1\n"),
        }
        for label, path in cases.items():
            with self.subTest(label), self.assertRaises(PluginError):
                load_plugin({"GOHA_SUNO_PLUGIN": path})
        for label, source in (("wrong object", "def create_plugin():\n    return object()\n"),
                              ("broken", "import no_such_module_anywhere\n")):
            with self.subTest(label), self.assertRaises(PluginError) as caught:
                load_plugin({"GOHA_SUNO_PLUGIN": self.write(source)})
            self.assertIn("my_plugin.py", str(caught.exception))


class CoreWithPluginTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.books = self.tmp / "books"
        (self.books / "BK001-first-book").mkdir(parents=True)
        self.plugin = BookPlugin(self.books)
        self.core = make_core(self.tmp, plugin=self.plugin)
        self.job_file = self.books / "BK001-first-book" / "BK001-suno-jobs.json"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def queue(self):
        return self.core.add_jobs(self.core.store("BK001"), plan())

    def test_a_claimed_name_keeps_its_jobs_where_the_plugin_says_keyed_by_the_folder(self):
        added, skipped = self.queue()
        self.assertEqual((len(added), skipped), (2, []))
        self.assertEqual(len(JobStore.at(self.job_file).jobs), 2)
        self.assertIs(self.core.store("BK001-first-book"), self.core.store("BK001"), "một sổ cho mọi cách gọi tên")
        self.assertEqual([j["id"] for j in self.core.jobs("BK001")], ["BK001.01." + SONG_A, "BK001.02." + SONG_B])
        self.core.enqueue_project_songs(PROJECT, [SONG_A], "download")
        names = [listed["episode"] for listed in self.core.queue_picture()["episodes"]]
        self.assertEqual(sorted(names), ["BK001-first-book", PROJECT], "dự án vẫn là dự án")

    def test_plugin_jobs_go_out_through_the_same_queue(self):
        self.queue()
        job = authenticate(self.core)[1]["job"]
        self.assertEqual((job["id"], job["episode"]), ("BK001.01." + SONG_A, "BK001-first-book"))

    def test_a_restart_recovers_plugin_lists_and_marks_lost_work_unknown(self):
        self.queue()
        sent = authenticate(self.core)[1]["job"]
        reborn = make_core(self.tmp, plugin=BookPlugin(self.books))
        reborn.recover()
        self.assertEqual(reborn.status()["counts"], {"unknown": 1, "queued": 1})
        self.assertEqual(JobStore.at(self.job_file).get(sent["id"]).status, "unknown")

    def test_the_plugin_judges_the_title_and_None_leaves_the_cores_own_check(self):
        for verdict, filename, expected in ((False, "Chapter 1.wav", False), (True, "anything.wav", True),
                                            (None, "Chapter 1 (2).wav", True), (None, "Chapter 2.wav", False)):
            with self.subTest(verdict=verdict, filename=filename):
                shutil.rmtree(self.tmp / "local", ignore_errors=True)
                self.job_file.unlink(missing_ok=True)
                core = make_core(self.tmp, plugin=BookPlugin(self.books, title_verdict=verdict))
                core.add_jobs(core.store("BK001"), plan())
                job = authenticate(core)[1]["job"]
                core.on_message({"type": "result", "jobId": job["id"], "status": "done", "exportId": EXPORT_ID,
                                 "filename": filename, "path": str(self.tmp / "dl" / filename)})
                self.assertIs(JobStore.at(self.job_file).get(job["id"]).result["title_ok"], expected)

    def test_the_plugin_follows_up_each_result_after_it_is_saved_and_its_download_folder_is_remembered(self):
        self.queue()
        job = authenticate(self.core)[1]["job"]
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "done", "exportId": EXPORT_ID,
                              "filename": "Chapter 1.wav", "path": str(self.tmp / "dl" / "Chapter 1.wav")})
        self.assertEqual(self.plugin.results, [(job["id"], "done", self.job_file)])
        self.assertEqual(self.core.download_dir("BK001"), self.tmp / "dl")

    def test_a_failing_follow_up_is_kept_on_the_job_alerted_and_the_queue_moves_on(self):
        core = make_core(self.tmp, plugin=BookPlugin(self.books, fail_on_result=True))
        core.add_jobs(core.store("BK001"), plan())
        job = authenticate(core)[1]["job"]
        core.on_message({"type": "result", "jobId": job["id"], "status": "failed", "reason": "x"})
        stored = JobStore.at(self.job_file).get(job["id"])
        self.assertEqual(stored.status, "failed")
        self.assertIn("records are read-only", stored.result["plugin_error"])
        self.assertEqual(core.status()["alerts"][-1], {"kind": "plugin_failed", "at": "2026-09-26T07:00:00Z", "job": job["id"]})
        self.assertEqual(core.drain()[-1]["job"]["id"], "BK001.02." + SONG_B)

    def test_project_results_never_reach_the_plugin(self):
        self.core.enqueue_project_songs(PROJECT, [SONG_A], "download")
        job = authenticate(self.core)[1]["job"]
        self.core.on_message({"type": "result", "jobId": job["id"], "status": "failed", "reason": "x"})
        self.assertEqual(self.plugin.results, [])


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "books").mkdir()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def tools(self, plugin):
        server = build_server(SocketBridge(make_core(self.tmp, plugin=plugin)), 0)
        return server, {tool.name for tool in asyncio.run(server.list_tools())}

    def test_without_a_plugin_the_agent_sees_exactly_the_eleven_project_tools(self):
        _, tools = self.tools(None)
        self.assertEqual(tools, PROJECT_TOOLS)

    def test_a_plugin_adds_its_tools_and_instructions(self):
        server, tools = self.tools(BookPlugin(self.tmp / "books"))
        self.assertEqual(tools, PROJECT_TOOLS | {"book_enqueue"})
        self.assertTrue(server.instructions.endswith("Books: use book_enqueue."))


if __name__ == "__main__":
    unittest.main()
