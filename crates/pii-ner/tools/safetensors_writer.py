"""Stdlib writer and header reader for the safetensors container format."""

from __future__ import annotations

import hashlib
import json
import struct
from dataclasses import dataclass
from pathlib import Path

DTYPE_SIZES = {"I8": 1, "F32": 4}
HEADER_ALIGNMENT = 8


@dataclass(frozen=True)
class TensorSpec:
    dtype: str
    shape: tuple[int, ...]
    data: bytes

    def validate(self, name: str) -> None:
        if self.dtype not in DTYPE_SIZES:
            raise ValueError(f"{name}: unsupported dtype {self.dtype}")
        count = 1
        for dim in self.shape:
            count *= dim
        expected = count * DTYPE_SIZES[self.dtype]
        if len(self.data) != expected:
            raise ValueError(
                f"{name}: {len(self.data)} bytes do not match shape {list(self.shape)} of {self.dtype}"
                f" ({expected} bytes expected)"
            )


def write_safetensors(path: Path, tensors: dict[str, TensorSpec], metadata: dict[str, str]) -> str:
    header: dict[str, object] = {"__metadata__": dict(metadata)}
    offset = 0
    ordered = sorted(tensors.items())
    for name, spec in ordered:
        spec.validate(name)
        end = offset + len(spec.data)
        header[name] = {"dtype": spec.dtype, "shape": list(spec.shape), "data_offsets": [offset, end]}
        offset = end
    header_bytes = json.dumps(header, separators=(",", ":"), sort_keys=True).encode("utf-8")
    padding = (-len(header_bytes)) % HEADER_ALIGNMENT
    header_bytes += b" " * padding
    digest = hashlib.sha256()
    with open(path, "wb") as out:
        prefix = struct.pack("<Q", len(header_bytes))
        out.write(prefix)
        digest.update(prefix)
        out.write(header_bytes)
        digest.update(header_bytes)
        for _, spec in ordered:
            out.write(spec.data)
            digest.update(spec.data)
    return digest.hexdigest()


def read_safetensors_header(path: Path) -> dict[str, object]:
    with open(path, "rb") as handle:
        (header_len,) = struct.unpack("<Q", handle.read(8))
        return json.loads(handle.read(header_len).decode("utf-8"))


def read_safetensors_tensor(path: Path, name: str) -> tuple[str, list[int], bytes]:
    with open(path, "rb") as handle:
        (header_len,) = struct.unpack("<Q", handle.read(8))
        header = json.loads(handle.read(header_len).decode("utf-8"))
        entry = header[name]
        start, end = entry["data_offsets"]
        handle.seek(8 + header_len + start)
        return entry["dtype"], entry["shape"], handle.read(end - start)
