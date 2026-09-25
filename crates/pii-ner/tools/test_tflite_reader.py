"""Unit tests for the stdlib flatbuffer reader on hand-built buffers."""

from __future__ import annotations

import struct
import unittest

import tflite_reader as tr


class FlatBufferBuilder:
    def __init__(self):
        self.rev = bytearray()
        self.absolute_fixups: list[tuple[int, int]] = []

    def _prepend(self, data: bytes) -> int:
        self.rev[0:0] = data
        return len(self.rev)

    def _pad_for(self, size: int) -> None:
        while (len(self.rev) + size) % 4:
            self.rev[0:0] = b"\x00"

    def _uoffset(self, dfe_field: int, dfe_target: int) -> bytes:
        return struct.pack("<I", dfe_field - dfe_target)

    def raw(self, data: bytes) -> int:
        self._pad_for(len(data))
        return self._prepend(data)

    def string(self, text: str) -> int:
        data = text.encode("utf-8")
        payload = struct.pack("<I", len(data)) + data + b"\x00"
        self._pad_for(len(payload))
        return self._prepend(payload)

    def vector(self, fmt: str, values) -> int:
        payload = struct.pack("<I", len(values)) + b"".join(struct.pack(f"<{fmt}", v) for v in values)
        self._pad_for(len(payload))
        return self._prepend(payload)

    def offset_vector(self, targets: list[int]) -> int:
        size = 4 + 4 * len(targets)
        self._pad_for(size)
        dfe_vec = len(self.rev) + size
        payload = struct.pack("<I", len(targets))
        for i, target in enumerate(targets):
            payload += self._uoffset(dfe_vec - 4 - 4 * i, target)
        return self._prepend(payload)

    def table(self, fields: list[tuple[str, object]]) -> int:
        layout = []
        table_size = 4
        for fmt, _ in fields:
            if fmt is None:
                layout.append(0)
                continue
            layout.append(table_size)
            if fmt in ("offset",):
                table_size += 4
            elif fmt == "abs64":
                table_size += 8
            else:
                table_size += struct.calcsize(f"<{fmt}")
        table_size += (-table_size) % 4
        vtable_size = 4 + 2 * len(fields)
        self._pad_for(table_size)
        dfe_table = len(self.rev) + table_size
        body = bytearray(table_size)
        struct.pack_into("<i", body, 0, vtable_size)
        for (fmt, value), off in zip(fields, layout):
            if fmt is None:
                continue
            if fmt == "offset":
                body[off : off + 4] = self._uoffset(dfe_table - off, value)
            elif fmt == "abs64":
                self.absolute_fixups.append((dfe_table - off, value))
            else:
                struct.pack_into(f"<{fmt}", body, off, value)
        self._prepend(bytes(body))
        vtable = struct.pack("<HH", vtable_size, table_size) + b"".join(struct.pack("<H", off) for off in layout)
        self._prepend(vtable)
        return dfe_table

    def finish(self, root: int, identifier: bytes = tr.FILE_IDENTIFIER) -> bytes:
        self._pad_for(0)
        total = 8 + len(self.rev)
        out = bytearray(struct.pack("<I", total - root) + identifier + bytes(self.rev))
        for dfe_field, dfe_target in self.absolute_fixups:
            struct.pack_into("<Q", out, total - dfe_field, total - dfe_target)
        return bytes(out)


class ReaderPrimitivesTest(unittest.TestCase):
    def test_scalar_string_vector_and_defaults(self):
        b = FlatBufferBuilder()
        name = b.string("hello")
        values = b.vector("i", [3, -4, 5])
        table = b.table([("I", 7), ("offset", name), ("offset", values), (None, None)])
        buf = b.finish(table)
        r = tr.Reader(buf)
        root = r.root()
        self.assertEqual(r.scalar(root, 0, "<I", 0), 7)
        self.assertEqual(r.string(r.indirect(root, 1)), "hello")
        self.assertEqual(r.vector_scalars(r.indirect(root, 2), "i"), [3, -4, 5])
        self.assertIsNone(r.field_pos(root, 3))
        self.assertEqual(r.scalar(root, 3, "<i", -1), -1)
        self.assertIsNone(r.field_pos(root, 9))

    def test_nested_tables_and_offset_vector(self):
        b = FlatBufferBuilder()
        inner_a = b.table([("b", 5)])
        inner_b = b.table([("b", -2)])
        vec = b.offset_vector([inner_a, inner_b])
        root = b.table([("offset", vec)])
        r = tr.Reader(b.finish(root))
        tables = r.vector_tables(r.indirect(r.root(), 0))
        self.assertEqual([r.scalar(t, 0, "<b", 0) for t in tables], [5, -2])

    def test_out_of_bounds_read_is_an_error(self):
        r = tr.Reader(b"\x00" * 4)
        with self.assertRaises(tr.FlatBufferError):
            r.u32(2)


class ModelTest(unittest.TestCase):
    def build_model(self, legacy_buffer: bool) -> bytes:
        b = FlatBufferBuilder()
        weight_bytes = bytes(range(6))
        if legacy_buffer:
            data = b.vector("B", list(weight_bytes))
            weight_buffer = b.table([("offset", data)])
        else:
            payload = b.raw(weight_bytes)
            weight_buffer = b.table([(None, None), ("abs64", payload), ("Q", len(weight_bytes))])
        empty_buffer = b.table([])
        buffers = b.offset_vector([empty_buffer, weight_buffer])

        scales = b.vector("f", [0.5, 0.25])
        zero_points = b.vector("q", [0, 0])
        quant = b.table([(None, None), (None, None), ("offset", scales), ("offset", zero_points), (None, None), (None, None), ("i", 0)])
        weight_shape = b.vector("i", [2, 3])
        weight_name = b.string("weight")
        weight = b.table([("offset", weight_shape), ("b", tr.TENSOR_INT8), ("I", 1), ("offset", weight_name), ("offset", quant)])
        input_shape = b.vector("i", [1, 3])
        input_name = b.string("serving_default_input_ids")
        input_tensor = b.table([("offset", input_shape), ("b", tr.TENSOR_INT32), ("I", 0), ("offset", input_name)])
        output_shape = b.vector("i", [1, 2])
        output_name = b.string("out")
        output_tensor = b.table([("offset", output_shape), ("b", tr.TENSOR_FLOAT32), ("I", 0), ("offset", output_name)])
        tensors = b.offset_vector([input_tensor, weight, output_tensor])

        gelu_options = b.table([("B", 1)])
        op_inputs = b.vector("i", [0, 1])
        op_outputs = b.vector("i", [2])
        op = b.table([("I", 0), ("offset", op_inputs), ("offset", op_outputs), ("B", tr.OPTIONS_GELU), ("offset", gelu_options)])
        operators = b.offset_vector([op])
        inputs = b.vector("i", [0])
        outputs = b.vector("i", [2])
        subgraph = b.table([("offset", tensors), ("offset", inputs), ("offset", outputs), ("offset", operators)])
        subgraphs = b.offset_vector([subgraph])

        opcode = b.table([("b", 127), (None, None), ("i", 1), ("i", tr.OP_GELU)])
        opcodes = b.offset_vector([opcode])
        root = b.table([("I", 3), ("offset", opcodes), ("offset", subgraphs), (None, None), ("offset", buffers)])
        return b.finish(root)

    def test_parses_model_with_new_buffer_layout(self):
        model = tr.TfliteModel(self.build_model(legacy_buffer=False))
        self.assertEqual(model.version, 3)
        self.assertEqual(model.operator_codes, [tr.OP_GELU])
        self.assertEqual([t.name for t in model.tensors], ["serving_default_input_ids", "weight", "out"])
        self.assertEqual(model.tensors[1].shape, (2, 3))
        self.assertEqual(model.tensors[1].quantization.scales, (0.5, 0.25))
        self.assertEqual(model.tensors[1].quantization.quantized_dimension, 0)
        self.assertEqual(model.tensor_bytes(1), bytes(range(6)))
        self.assertFalse(model.is_constant(0))
        self.assertTrue(model.is_constant(1))
        op = model.operators[0]
        self.assertEqual(op.name, "GELU")
        self.assertEqual(op.inputs, (0, 1))
        self.assertTrue(model.option_bool(op, tr.OPTIONS_GELU, tr.GELU_APPROXIMATE))
        self.assertEqual(model.op_histogram(), {"GELU": 1})

    def test_parses_legacy_buffer_layout(self):
        model = tr.TfliteModel(self.build_model(legacy_buffer=True))
        self.assertEqual(model.tensor_bytes(1), bytes(range(6)))

    def test_wrong_options_type_is_an_error(self):
        model = tr.TfliteModel(self.build_model(legacy_buffer=False))
        with self.assertRaises(tr.FlatBufferError):
            model.option_f32(model.operators[0], tr.OPTIONS_SOFTMAX, tr.SOFTMAX_BETA)

    def test_missing_identifier_is_an_error(self):
        buf = bytearray(self.build_model(legacy_buffer=False))
        buf[4:8] = b"NOPE"
        with self.assertRaises(tr.FlatBufferError):
            tr.TfliteModel(bytes(buf))


if __name__ == "__main__":
    unittest.main()
