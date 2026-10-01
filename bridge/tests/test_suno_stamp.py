"""What a downloaded Suno file says about itself."""

import shutil
import tempfile
import unittest
from pathlib import Path

from goha_suno.suno_stamp import read_suno_stamp, title_matches
from tests.helpers import SONG_A, TITLE_A, write_suno_wav


class StampTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_a_library_download_and_a_studio_export_are_told_apart(self):
        write_suno_wav(self.tmp / "a.wav", SONG_A, created="2026-09-17T10:52:52Z")
        write_suno_wav(self.tmp / "b.wav", SONG_A, studio=True)
        library, studio = read_suno_stamp(self.tmp / "a.wav"), read_suno_stamp(self.tmp / "b.wav")
        self.assertEqual((library.song_id, library.created_at, library.studio), (SONG_A, "2026-09-17T10:52:52Z", False))
        self.assertTrue(studio.studio)

    def test_a_file_without_a_stamp_or_no_file_at_all_says_nothing(self):
        (self.tmp / "plain.wav").write_bytes(b"RIFF\x00\x00\x00\x00WAVE")
        self.assertIsNone(read_suno_stamp(self.tmp / "plain.wav"))
        self.assertIsNone(read_suno_stamp(self.tmp / "missing.wav"))


class TitleTests(unittest.TestCase):
    def test_the_file_name_is_the_song_title_maybe_with_the_browsers_repeat_number(self):
        self.assertTrue(title_matches(TITLE_A, TITLE_A))
        self.assertTrue(title_matches(f"{TITLE_A} (2)", f" {TITLE_A} "))
        self.assertFalse(title_matches("Another song", TITLE_A))
        self.assertFalse(title_matches(f"{TITLE_A} remix", TITLE_A))


if __name__ == "__main__":
    unittest.main()
