import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import analyze_clip as app


class ResultTests(unittest.TestCase):
    def setUp(self):
        self.frames = [{"time_s": 1.5, "image": "data:image/jpeg;base64,eA=="}, {"time_s": 3.0, "image": "data:image/jpeg;base64,eQ=="}]
        self.result = {"label": "assault", "evidence": "An apparent striking motion is visible.", "uncertainty": "Contact is unclear and this could be staged.", "evidence_frames": [0, 1]}

    def test_timestamps_come_from_sampled_frames(self):
        self.assertEqual(app.validate_result(self.result, self.frames)["evidence_times_s"], [1.5, 3.0])

    def test_rejects_invalid_frame_references(self):
        for indices in ([2], [-1], [True], [1, 0], [0, 0], []):
            with self.subTest(indices=indices), self.assertRaises(ValueError):
                app.validate_result({**self.result, "evidence_frames": indices}, self.frames)

    def test_rejects_missing_or_fabricated_fields(self):
        for value in ({}, {**self.result, "confidence": 0.99}, {**self.result, "label": "guilty"}, {**self.result, "uncertainty": ""}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                app.validate_result(value, self.frames)

    def test_none_and_uncertain_are_valid(self):
        for label in ("none", "uncertain"):
            self.assertEqual(app.validate_result({**self.result, "label": label, "evidence_frames": []}, self.frames)["label"], label)

    def test_payload_contains_frames_but_no_filename_or_expected_answer(self):
        body = app.make_payload("gemma-test", self.frames)
        content = body["messages"][0]["content"]
        self.assertEqual(content[2]["image_url"]["url"], self.frames[0]["image"])
        self.assertIn("1.500", content[1]["text"])
        self.assertEqual(body["response_format"]["type"], "json_schema")

    def test_insecure_endpoint_is_rejected_before_network(self):
        with patch("analyze_clip.build_opener") as opener:
            for url in ("http://example.test/v1", "https://user:secret@example.test/v1", "https://example.test/v1?secret=1"):
                with self.assertRaises(ValueError):
                    app.request_gemma(self.frames, url, "key", "gemma-test")
            opener.assert_not_called()

    def test_truncated_response_is_not_a_prediction(self):
        response = json.dumps({"choices": [{"finish_reason": "length", "message": {"content": json.dumps(self.result)}}]}).encode()
        with patch("analyze_clip.build_opener") as opener:
            opener.return_value.open.return_value.__enter__.return_value.read.return_value = response
            with self.assertRaisesRegex(ValueError, "did not finish"):
                app.request_gemma(self.frames, "https://example.test/v1", "key", "gemma-test")

    def test_dry_run_never_contacts_model(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "sample.json"
            with patch("analyze_clip.sample_clip", return_value=(self.frames, {"start_s": 0, "end_s": 4})), patch("analyze_clip.request_gemma") as model:
                self.assertEqual(app.main(["test.mp4", "--dry-run", "--output", str(output)]), 0)
                model.assert_not_called()
                self.assertEqual(json.loads(output.read_text())["status"], "sampled_not_analyzed")


class VideoTests(unittest.TestCase):
    def test_real_decoder_on_synthetic_non_incident_video(self):
        try:
            import cv2
            import numpy as np
        except ImportError:
            self.skipTest("Install requirements.txt to test real decoding.")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "synthetic.avi"
            writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 10, (160, 120))
            self.assertTrue(writer.isOpened())
            for index in range(40):
                writer.write(np.full((120, 160, 3), index * 5, dtype=np.uint8))
            writer.release()
            frames, window = app.sample_clip(path, start=1, seconds=2, count=4)
            self.assertEqual(len(frames), 4)
            self.assertAlmostEqual(window["clip_duration_s"], 4)
            self.assertTrue(all(1 <= f["time_s"] <= 3 for f in frames))
            self.assertEqual(len(set(f["time_s"] for f in frames)), 4)
            self.assertTrue(all(f["image"].startswith("data:image/jpeg;base64,") for f in frames))
            with self.assertRaises(ValueError):
                app.sample_clip(path, start=10)
            with self.assertRaises(ValueError):
                app.sample_clip(path, seconds=float("nan"))


if __name__ == "__main__":
    unittest.main()
