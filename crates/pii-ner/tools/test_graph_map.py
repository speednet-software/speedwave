"""Unit tests for the graph mapper: helpers on a fake graph plus the real model when cached."""

from __future__ import annotations

import json
import os
import struct
import unittest
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import graph_map as gm
import tflite_reader as tr

TOOLS_DIR = Path(__file__).resolve().parent


@dataclass
class FakeTensor:
    index: int
    name: str
    shape: tuple[int, ...]
    dtype: int
    data: bytes = b""
    quantization: Optional[tr.Quantization] = None
    buffer: int = 0


class FakeModel:
    def __init__(self):
        self.tensors: list[FakeTensor] = []
        self.operators: list[tr.Operator] = []
        self.inputs: list[int] = []
        self.outputs: list[int] = []
        self.options: dict[int, dict[int, object]] = {}

    def tensor(self, name: str, shape: tuple[int, ...], dtype: int = tr.TENSOR_FLOAT32, data: bytes = b"",
               quantization: Optional[tr.Quantization] = None) -> int:
        self.tensors.append(FakeTensor(len(self.tensors), name, shape, dtype, data, quantization))
        return len(self.tensors) - 1

    def scalar(self, value: float) -> int:
        return self.tensor("scalar", (), tr.TENSOR_FLOAT32, struct.pack("<f", value))

    def op(self, opcode: int, inputs: list[int], outputs: list[int], options: Optional[dict[int, object]] = None) -> tr.Operator:
        operator = tr.Operator(len(self.operators), opcode, tuple(inputs), tuple(outputs), 0, 1 if options else None)
        self.operators.append(operator)
        if options:
            self.options[operator.index] = options
        return operator

    def is_constant(self, index: int) -> bool:
        return len(self.tensors[index].data) > 0

    def tensor_bytes(self, index: int) -> bytes:
        return self.tensors[index].data

    def option_bool(self, op, expected_type, field) -> bool:
        return bool(self.options.get(op.index, {}).get(field, False))

    def option_i8(self, op, expected_type, field) -> int:
        return int(self.options.get(op.index, {}).get(field, 0))

    def option_f32(self, op, expected_type, field) -> float:
        return float(self.options.get(op.index, {}).get(field, 0.0))

    def op_histogram(self) -> dict[str, int]:
        histogram: dict[str, int] = {}
        for op in self.operators:
            histogram[op.name] = histogram.get(op.name, 0) + 1
        return histogram


def int8_weight(model: FakeModel, name: str, rows: int, cols: int, zero_point: int = 0, qdim: int = 0) -> int:
    quant = tr.Quantization(tuple([0.5] * rows), tuple([zero_point] * rows), qdim)
    return model.tensor(name, (rows, cols), tr.TENSOR_INT8, bytes(rows * cols), quant)


def f32_const(model: FakeModel, name: str, shape: tuple[int, ...], fill: float = 1.0) -> int:
    count = 1
    for dim in shape:
        count *= dim
    return model.tensor(name, shape, tr.TENSOR_FLOAT32, struct.pack(f"<{count}f", *([fill] * count)))


class HelperTest(unittest.TestCase):
    def test_layer_index_from_name(self):
        self.assertEqual(gm.layer_index_from_name("a/BertLayer_3/b/Linear_query;"), 3)
        self.assertIsNone(gm.layer_index_from_name("classifier"))

    def test_check_quantization_rejects_zero_points_and_axis(self):
        model = FakeModel()
        good = int8_weight(model, "w", 4, 8)
        bad_zp = int8_weight(model, "w", 4, 8, zero_point=3)
        bad_axis = int8_weight(model, "w", 4, 8, qdim=1)
        graph = gm.Graph(model)
        self.assertEqual(len(gm.check_quantization(graph, good)), 4)
        with self.assertRaises(gm.GraphMapError):
            gm.check_quantization(graph, bad_zp)
        with self.assertRaises(gm.GraphMapError):
            gm.check_quantization(graph, bad_axis)

    def test_trace_back_to_fc_passes_reshape_transpose_and_scalar_mul(self):
        model = FakeModel()
        x = model.tensor("x", (1, 4, 8))
        w = int8_weight(model, "BertLayer_0/Linear_query;", 8, 8)
        bias = f32_const(model, "BertLayer_0/Linear_query;", (8,))
        fc_out = model.tensor("fc", (1, 4, 8))
        fc = model.op(tr.OP_FULLY_CONNECTED, [x, w, bias], [fc_out])
        shape_const = model.tensor("shape", (4,), tr.TENSOR_INT32, struct.pack("<4i", 1, 4, 2, 4))
        reshaped = model.tensor("r", (1, 4, 2, 4))
        model.op(tr.OP_RESHAPE, [fc_out, shape_const], [reshaped])
        perm = model.tensor("perm", (4,), tr.TENSOR_INT32, struct.pack("<4i", 0, 2, 1, 3))
        transposed = model.tensor("t", (1, 2, 4, 4))
        model.op(tr.OP_TRANSPOSE, [reshaped, perm], [transposed])
        scale = model.scalar(0.25)
        scaled = model.tensor("s", (1, 2, 4, 4))
        model.op(tr.OP_MUL, [transposed, scale], [scaled])
        graph = gm.Graph(model)
        sink: list[float] = []
        self.assertIs(graph.trace_back_to_fc(scaled, sink), fc)
        self.assertEqual(sink, [0.25])
        self.assertIsNone(graph.trace_back_to_fc(x, []))

    def test_layer_norm_affine_finds_gamma_beta_or_folding(self):
        model = FakeModel()
        variance = model.tensor("var", (4,))
        rsqrt_out = model.tensor("rsqrt", (4,))
        rsqrt = model.op(tr.OP_RSQRT, [variance], [rsqrt_out])
        x = model.tensor("x", (1, 4, 8))
        normalized = model.tensor("n", (1, 4, 8))
        model.op(tr.OP_MUL, [x, rsqrt_out], [normalized])
        gamma = f32_const(model, "gamma", (8,), 2.0)
        scaled = model.tensor("scaled", (1, 4, 8))
        model.op(tr.OP_MUL, [normalized, gamma], [scaled])
        beta = f32_const(model, "beta", (8,), 3.0)
        shifted = model.tensor("shifted", (1, 4, 8))
        model.op(tr.OP_ADD, [scaled, beta], [shifted])
        graph = gm.Graph(model)
        found_gamma, found_beta = gm.layer_norm_affine(graph, rsqrt, 8)
        self.assertEqual(found_gamma, model.tensor_bytes(gamma))
        self.assertEqual(found_beta, model.tensor_bytes(beta))

        folded = FakeModel()
        variance = folded.tensor("var", (4,))
        rsqrt_out = folded.tensor("rsqrt", (4,))
        rsqrt = folded.op(tr.OP_RSQRT, [variance], [rsqrt_out])
        x = folded.tensor("x", (1, 4, 8))
        normalized = folded.tensor("n", (1, 4, 8))
        folded.op(tr.OP_MUL, [x, rsqrt_out], [normalized])
        w = int8_weight(folded, "classifier", 5, 8)
        bias = f32_const(folded, "classifier", (5,))
        logits = folded.tensor("logits", (1, 4, 5))
        folded.op(tr.OP_FULLY_CONNECTED, [normalized, w, bias], [logits])
        self.assertEqual(gm.layer_norm_affine(gm.Graph(folded), rsqrt, 8), (None, None))

    def test_layer_norm_tensors_emit_identity_when_folded(self):
        params = gm.LayerNormParams(gamma=None, beta=None, eps=1e-12, folded=True)
        tensors = gm.layer_norm_tensors("x", params, 3)
        self.assertEqual(struct.unpack("<3f", tensors["x.weight"].data), (1.0, 1.0, 1.0))
        self.assertEqual(struct.unpack("<3f", tensors["x.bias"].data), (0.0, 0.0, 0.0))

    def test_sanity_rejects_unexpected_histogram(self):
        model = FakeModel()
        model.op(tr.OP_ADD, [], [])
        with self.assertRaises(gm.GraphMapError):
            gm.check_sanity(gm.Graph(model))


def cached_tflite() -> Optional[Path]:
    with open(TOOLS_DIR / "pins.json", encoding="utf-8") as handle:
        pins = json.load(handle)
    override = os.environ.get("SPEEDWAVE_PII_NER_CACHE")
    cache = Path(override) if override else Path.home() / ".cache" / "speedwave" / "pii-ner" / pins["revision"]
    path = cache / "redact.tflite"
    return path if path.exists() else None


@unittest.skipUnless(cached_tflite(), "pinned redact.tflite not present in the converter cache")
class RealModelTest(unittest.TestCase):
    def test_real_model_maps_completely(self):
        model = tr.TfliteModel(cached_tflite().read_bytes())
        mapped = gm.map_graph(model)
        cfg = mapped.config
        self.assertEqual(cfg["num_hidden_layers"], 6)
        self.assertEqual(cfg["hidden_size"], 384)
        self.assertEqual((cfg["num_attention_heads"], cfg["head_dim"]), (12, 32))
        self.assertEqual(cfg["intermediate_size"], 1536)
        self.assertEqual(cfg["num_labels"], 89)
        self.assertEqual(cfg["vocab_size"], 31475)
        self.assertAlmostEqual(cfg["layer_norm_eps"], 1e-12, places=15)
        self.assertAlmostEqual(cfg["attention_scale"], 32 ** -0.5, places=6)
        self.assertFalse(cfg["gelu_approximate"])
        self.assertEqual(mapped.param_count, 22866905)
        self.assertEqual(len(mapped.tensors), 141)
        self.assertEqual(mapped.notes, ["layer 5 output LayerNorm affine folded into the classifier; emitting identity"])


if __name__ == "__main__":
    unittest.main()
