"""The community package: complete, runnable on its own, and free of this machine's secrets and paths."""

import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))

import build_release  # noqa: E402

FAKE_SECRET = "Zx9_fake-pairing-code-for-the-leak-test-000"


class BuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.archive = build_release.build(out_root=cls.tmp, secrets=[FAKE_SECRET])
        cls.folder = cls.archive.with_suffix("")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_the_package_has_extension_bridge_installer_guide_and_license(self):
        for relative in ("extension/manifest.json", "extension/sidepanel.html", "extension/ui/about/qr-vietinbank.png",
                         "bridge/goha_suno/suno_agent_bridge.py", "bridge/goha_suno/suno_projects.py", "bridge/requirements.txt",
                         "bridge/cai_dat.py", "CAI-DAT.bat", "HUONG-DAN.md", "README.md", "LICENSE"):
            self.assertTrue((self.folder / relative).exists(), relative)

    def test_dev_tools_tests_and_the_channels_modules_stay_out(self):
        for relative in ("extension/dev", "extension/tests", "extension/tools", "extension/install.json",
                         "bridge/scripts", "bridge/goha_suno/suno_bridge_host.py",
                         "bridge/goha_suno/episode_audio.py", "bridge/goha_suno/suno_generation.py",
                         "bridge/goha_suno/export_download_handoff.py", "bridge/goha_suno/validate_suno.py"):
            self.assertFalse((self.folder / relative).exists(), relative)

    def test_the_packaged_bridge_offers_exactly_the_eleven_project_tools(self):
        tools = build_release.smoke_test(self.folder)
        self.assertEqual(tools, build_release.COMMUNITY_TOOLS)
        self.assertEqual(len(tools), 11)

    def test_the_installer_has_windows_line_endings(self):
        data = (self.folder / "CAI-DAT.bat").read_bytes()
        self.assertIn(b"\r\n", data)
        self.assertNotIn(b"\n", data.replace(b"\r\n", b""))

    def test_the_zip_holds_one_top_folder_named_after_the_version(self):
        with zipfile.ZipFile(self.archive) as archive:
            tops = {name.split("/")[0] for name in archive.namelist()}
        self.assertEqual(tops, {f"GOHA-Suno-Helper-{build_release.version()}"})

    def test_the_check_catches_a_secret_a_machine_path_and_an_install_file(self):
        planted = self.tmp / "planted"
        shutil.copytree(self.folder, planted)
        (planted / "extension" / "lib" / "leak.js").write_text(
            f'const a = "{FAKE_SECRET}"; const b = "D:\\\\AI PROJECTS\\\\x";', encoding="utf-8")
        (planted / "extension" / "lib" / "path-note.js").write_text("// from E:\\Social Links\\data.json", encoding="utf-8")
        (planted / "extension" / "install.json").write_text("{}", encoding="utf-8")
        (planted / "episodes").mkdir()
        (planted / "bridge" / "goha_suno" / "episode_audio.py").write_text("", encoding="utf-8")
        problems = build_release.check_package(planted, secrets=[FAKE_SECRET])
        self.assertEqual(len(problems), 6, problems)
        self.assertEqual(build_release.check_package(self.folder, secrets=[FAKE_SECRET]), [])


if __name__ == "__main__":
    unittest.main()
