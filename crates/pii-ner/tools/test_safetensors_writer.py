"""Unit tests for the stdlib safetensors writer."""

from __future__ import annotations

import hashlib
import json
import struct
import tempfile
import unittest
from pathlib import Path

from safetensors_writer import (
    TensorSpec,
    read_safetensors_header,
    read_safetensors_tensor,
    write_safetensors,
)


class SafetensorsWriterTest(unittest.TestCase):
    def test_roundtrip_layout_and_digest(self):
        tensors = {
            "b.weight": TensorSpec("F32", (2,), struct.pack("<2f", 1.5, -2.0)),
            "a.weight.int8": TensorSpec("I8", (2, 3), bytes([1, 2, 3, 250, 251, 252])),
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "w.safetensors"
            digest = write_safetensors(path, tensors, {"format": "test"})
            raw = path.read_bytes()
            self.assertEqual(digest, hashlib.sha256(raw).hexdigest())
            (header_len,) = struct.unpack("<Q", raw[:8])
            self.assertEqual(header_len % 8, 0)
            header = json.loads(raw[8 : 8 + header_len])
            self.assertEqual(header["__metadata__"], {"format": "test"})
            self.assertEqual(list(k for k in header if k != "__metadata__"), ["a.weight.int8", "b.weight"])
            self.assertEqual(header["a.weight.int8"]["data_offsets"], [0, 6])
            self.assertEqual(header["b.weight"]["data_offsets"], [6, 14])
            self.assertEqual(read_safetensors_header(path)["b.weight"]["shape"], [2])
            dtype, shape, data = read_safetensors_tensor(path, "b.weight")
            self.assertEqual((dtype, shape), ("F32", [2]))
            self.assertEqual(struct.unpack("<2f", data), (1.5, -2.0))
            self.assertEqual(read_safetensors_tensor(path, "a.weight.int8")[2], bytes([1, 2, 3, 250, 251, 252]))

    def test_shape_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                write_safetensors(Path(tmp) / "bad", {"x": TensorSpec("F32", (3,), b"\x00" * 8)}, {})

    def test_unknown_dtype_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                write_safetensors(Path(tmp) / "bad", {"x": TensorSpec("F16", (1,), b"\x00\x00")}, {})


if __name__ == "__main__":
    unittest.main()
