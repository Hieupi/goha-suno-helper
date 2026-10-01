import unittest

from scripts.suno_clip_status import CLIP_ENDPOINT, ClipStatus, check_clips, parse_clip

GOOD = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
OTHER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"


def fake_fetch(responses):
    calls = []

    def fetch(url):
        calls.append(url)
        value = responses[url]
        if isinstance(value, Exception):
            raise value
        return value

    fetch.calls = calls
    return fetch


class ParseTests(unittest.TestCase):
    def test_reads_status_title_type_and_duration(self):
        clip = parse_clip(
            GOOD,
            {
                "id": GOOD, "status": "complete", "title": "秋風の宿場", "type": "studio_export",
                "metadata": {
                    "duration": 327.94, "tags": "koto, calm", "negative_tags": "vocals",
                    "is_max_mode": True, "make_instrumental": True,
                },
            },
        )
        self.assertEqual(
            clip,
            ClipStatus(GOOD, "complete", "秋風の宿場", 327.94, "studio_export", "koto, calm", "vocals", True, True, None),
        )

    def test_missing_duration_is_none_not_zero(self):
        self.assertIsNone(parse_clip(GOOD, {"id": GOOD, "status": "streaming"}).seconds)

    def test_missing_packet_fields_read_as_none(self):
        clip = parse_clip(GOOD, {"id": GOOD, "status": "streaming"})
        self.assertIsNone(clip.tags)
        self.assertIsNone(clip.negative_tags)
        self.assertIsNone(clip.is_max_mode)
        self.assertIsNone(clip.make_instrumental)

    def test_a_response_for_another_id_is_an_error(self):
        clip = parse_clip(GOOD, {"id": OTHER, "status": "complete"})
        self.assertIsNotNone(clip.error)


class CheckTests(unittest.TestCase):
    def test_checks_each_id_on_the_public_endpoint(self):
        fetch = fake_fetch({
            CLIP_ENDPOINT.format(GOOD): {"id": GOOD, "status": "complete", "metadata": {"duration": 330.0}},
            CLIP_ENDPOINT.format(OTHER): OSError("timed out"),
        })
        results = check_clips([GOOD, OTHER], fetch=fetch)
        self.assertEqual(results[0].seconds, 330.0)
        self.assertIsNone(results[0].error)
        self.assertIn("timed out", results[1].error)
        self.assertEqual(fetch.calls, [CLIP_ENDPOINT.format(GOOD), CLIP_ENDPOINT.format(OTHER)])

    def test_rejects_anything_that_is_not_a_uuid_without_calling_out(self):
        fetch = fake_fetch({})
        results = check_clips(["../../etc/passwd", "abc"], fetch=fetch)
        self.assertTrue(all(result.error for result in results))
        self.assertEqual(fetch.calls, [])

    def test_endpoint_is_https_and_unauthenticated(self):
        self.assertTrue(CLIP_ENDPOINT.startswith("https://studio-api.prod.suno.com/api/clip/"))


if __name__ == "__main__":
    unittest.main()
