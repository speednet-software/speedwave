"""Unit tests for pin handling and the bundled notices file in fetch_and_convert."""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import fetch_and_convert as fc


class NoticesPinTest(unittest.TestCase):
    def test_pins_carry_the_upstream_notices(self):
        pin = fc.load_pins()["files"][fc.NOTICES_FILE]
        self.assertRegex(pin["sha256"], r"^[0-9a-f]{64}$")
        self.assertGreater(pin["size"], 0)

    def test_verify_source_rejects_changed_notices(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / fc.NOTICES_FILE
            path.write_bytes(b"notices")
            good = {"sha256": hashlib.sha256(b"notices").hexdigest(), "size": 7}
            fc.verify_source(path, fc.NOTICES_FILE, good)
            with self.assertRaises(fc.ConvertError):
                fc.verify_source(path, fc.NOTICES_FILE, {**good, "size": 8})
            with self.assertRaises(fc.ConvertError):
                fc.verify_source(path, fc.NOTICES_FILE, {**good, "sha256": "0" * 64})


class ArtifactCurrencyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name)
        weights = b"weights"
        (self.out / fc.WEIGHTS_FILE).write_bytes(weights)
        (self.out / fc.TOKENIZER_FILE).write_bytes(b"{}")
        self.pins = {"files": {"redact.tflite": {"sha256": "a" * 64}, fc.NOTICES_FILE: {"sha256": "b" * 64}}}
        manifest = {
            "artifact_format_version": fc.ARTIFACT_FORMAT_VERSION,
            "model": {"source_tflite_sha256": "a" * 64},
            "files": {"weights_sha256": hashlib.sha256(weights).hexdigest()},
        }
        (self.out / fc.MANIFEST_FILE).write_text(json.dumps(manifest), encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_artifact_without_notices_is_stale(self):
        self.assertFalse(fc.artifact_is_current(self.out, self.pins))

    def test_artifact_with_pinned_notices_is_current(self):
        (self.out / fc.NOTICES_FILE).write_bytes(b"notices")
        self.pins["files"][fc.NOTICES_FILE]["sha256"] = hashlib.sha256(b"notices").hexdigest()
        self.assertTrue(fc.artifact_is_current(self.out, self.pins))

    def test_artifact_with_changed_notices_is_stale(self):
        (self.out / fc.NOTICES_FILE).write_bytes(b"stub")
        self.assertFalse(fc.artifact_is_current(self.out, self.pins))

    def test_verify_reports_missing_and_changed_notices(self):
        problems = fc.verify_artifact_notices(self.out, self.pins)
        self.assertEqual(problems, [f"{fc.NOTICES_FILE} missing"])
        (self.out / fc.NOTICES_FILE).write_bytes(b"notices")
        self.assertEqual(fc.verify_artifact_notices(self.out, self.pins), [f"{fc.NOTICES_FILE} sha256 differs from pins.json"])
        (self.out / fc.NOTICES_FILE).write_bytes(b"")
        self.pins["files"][fc.NOTICES_FILE]["sha256"] = hashlib.sha256(b"").hexdigest()
        self.assertEqual(fc.verify_artifact_notices(self.out, self.pins), [])


if __name__ == "__main__":
    unittest.main()
