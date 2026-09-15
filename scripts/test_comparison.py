"""Verify pairing, isolation of reviewer expectations, and overwrite protection."""

import json
from pathlib import Path
import tempfile
import unittest

from prepare_comparison import PACK, build_requests, write_bundle


class ComparisonTests(unittest.TestCase):
    def test_pairs_have_identical_questions_and_separate_treatment(self):
        requests, reviews, manifest = build_requests(PACK)
        self.assertEqual(len(reviews), 18)
        self.assertEqual(manifest["request_count"], 36)
        self.assertEqual(len({r["request_id"] for r in requests}), 36)
        for baseline, framework in zip(requests[::2], requests[1::2]):
            self.assertEqual(baseline["case_id"], framework["case_id"])
            self.assertEqual(baseline["user_prompt"], framework["user_prompt"])
            self.assertEqual(baseline["append_system_prompt"], "")
            self.assertIn("steelman", framework["append_system_prompt"])
            for item in (baseline, framework):
                self.assertEqual(set(item), {"request_id", "case_id", "variant",
                                             "append_system_prompt", "user_prompt"})

    def test_bundle_roundtrip_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "prepared"
            manifest = write_bundle(PACK, output)
            self.assertEqual(json.loads((output / "manifest.json").read_text()), manifest)
            self.assertEqual(manifest["status"], "prepared_not_run")
            self.assertEqual(len((output / "requests.jsonl").read_text(encoding="utf-8").splitlines()), 36)
            self.assertEqual((output / "framework-system-prompt.md").read_bytes(),
                             (PACK / "prompts/priority_loader_prompt.md").read_bytes())
            with self.assertRaises(FileExistsError):
                write_bundle(PACK, output)


if __name__ == "__main__":
    unittest.main()

