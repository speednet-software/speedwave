"""Minimal stdlib reader for the TFLite flatbuffer tables the converter needs."""

from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Optional

FILE_IDENTIFIER = b"TFL3"

TENSOR_FLOAT32 = 0
TENSOR_INT32 = 2
TENSOR_BOOL = 6
TENSOR_INT8 = 9

OP_ADD = 0
OP_EMBEDDING_LOOKUP = 7
OP_FULLY_CONNECTED = 9
OP_MUL = 18
OP_RESHAPE = 22
OP_SOFTMAX = 25
OP_TRANSPOSE = 39
OP_MEAN = 40
OP_SUB = 41
OP_CAST = 53
OP_RSQRT = 76
OP_LOGICAL_AND = 86
OP_SQUARED_DIFFERENCE = 99
OP_GATHER_ND = 107
OP_SELECT_V2 = 123
OP_BATCH_MATMUL = 126
OP_GELU = 150

OP_NAMES = {
    OP_ADD: "ADD",
    OP_EMBEDDING_LOOKUP: "EMBEDDING_LOOKUP",
    OP_FULLY_CONNECTED: "FULLY_CONNECTED",
    OP_MUL: "MUL",
    OP_RESHAPE: "RESHAPE",
    OP_SOFTMAX: "SOFTMAX",
    OP_TRANSPOSE: "TRANSPOSE",
    OP_MEAN: "MEAN",
    OP_SUB: "SUB",
    OP_CAST: "CAST",
    OP_RSQRT: "RSQRT",
    OP_LOGICAL_AND: "LOGICAL_AND",
    OP_SQUARED_DIFFERENCE: "SQUARED_DIFFERENCE",
    OP_GATHER_ND: "GATHER_ND",
    OP_SELECT_V2: "SELECT_V2",
    OP_BATCH_MATMUL: "BATCH_MATMUL",
    OP_GELU: "GELU",
}

OPTIONS_FULLY_CONNECTED = 8
OPTIONS_SOFTMAX = 9
OPTIONS_BATCH_MATMUL = 101
OPTIONS_GELU = 116

MODEL_VERSION = 0
MODEL_OPERATOR_CODES = 1
MODEL_SUBGRAPHS = 2
MODEL_BUFFERS = 4

SUBGRAPH_TENSORS = 0
SUBGRAPH_INPUTS = 1
SUBGRAPH_OUTPUTS = 2
SUBGRAPH_OPERATORS = 3

TENSOR_SHAPE = 0
TENSOR_TYPE = 1
TENSOR_BUFFER = 2
TENSOR_NAME = 3
TENSOR_QUANTIZATION = 4

QUANT_SCALE = 2
QUANT_ZERO_POINT = 3
QUANT_QUANTIZED_DIMENSION = 6

BUFFER_DATA = 0
BUFFER_OFFSET = 1
BUFFER_SIZE = 2

OPERATOR_OPCODE_INDEX = 0
OPERATOR_INPUTS = 1
OPERATOR_OUTPUTS = 2
OPERATOR_BUILTIN_OPTIONS_TYPE = 3
OPERATOR_BUILTIN_OPTIONS = 4

OPCODE_DEPRECATED_BUILTIN_CODE = 0
OPCODE_BUILTIN_CODE = 3

GELU_APPROXIMATE = 0
BMM_ADJ_X = 0
BMM_ADJ_Y = 1
FC_FUSED_ACTIVATION = 0
SOFTMAX_BETA = 0


class FlatBufferError(ValueError):
    pass


class Reader:
    def __init__(self, buf: bytes):
        self.buf = buf

    def _unpack(self, fmt: str, pos: int):
        size = struct.calcsize(fmt)
        if pos < 0 or pos + size > len(self.buf):
            raise FlatBufferError(f"read of {size} bytes at {pos} is out of bounds")
        return struct.unpack_from(fmt, self.buf, pos)[0]

    def u8(self, pos: int) -> int:
        return self._unpack("<B", pos)

    def i8(self, pos: int) -> int:
        return self._unpack("<b", pos)

    def u16(self, pos: int) -> int:
        return self._unpack("<H", pos)

    def i32(self, pos: int) -> int:
        return self._unpack("<i", pos)

    def u32(self, pos: int) -> int:
        return self._unpack("<I", pos)

    def i64(self, pos: int) -> int:
        return self._unpack("<q", pos)

    def u64(self, pos: int) -> int:
        return self._unpack("<Q", pos)

    def f32(self, pos: int) -> float:
        return self._unpack("<f", pos)

    def root(self) -> int:
        return self.u32(0)

    def field_pos(self, table: int, field: int) -> Optional[int]:
        vtable = table - self.i32(table)
        vtable_size = self.u16(vtable)
        slot = 4 + 2 * field
        if slot + 2 > vtable_size:
            return None
        offset = self.u16(vtable + slot)
        if offset == 0:
            return None
        return table + offset

    def scalar(self, table: int, field: int, fmt: str, default):
        pos = self.field_pos(table, field)
        if pos is None:
            return default
        return self._unpack(fmt, pos)

    def indirect(self, table: int, field: int) -> Optional[int]:
        pos = self.field_pos(table, field)
        if pos is None:
            return None
        return pos + self.u32(pos)

    def vector_len(self, pos: int) -> int:
        return self.u32(pos)

    def vector_scalars(self, pos: Optional[int], fmt: str) -> list:
        if pos is None:
            return []
        count = self.u32(pos)
        size = struct.calcsize(fmt)
        start = pos + 4
        end = start + count * size
        if end > len(self.buf):
            raise FlatBufferError(f"vector of {count} elements at {pos} is out of bounds")
        return list(struct.unpack_from(f"<{count}{fmt}", self.buf, start))

    def vector_bytes(self, pos: Optional[int]) -> bytes:
        if pos is None:
            return b""
        count = self.u32(pos)
        start = pos + 4
        if start + count > len(self.buf):
            raise FlatBufferError(f"byte vector of {count} at {pos} is out of bounds")
        return self.buf[start : start + count]

    def vector_tables(self, pos: Optional[int]) -> list[int]:
        if pos is None:
            return []
        count = self.u32(pos)
        tables = []
        for i in range(count):
            element = pos + 4 + 4 * i
            tables.append(element + self.u32(element))
        return tables

    def string(self, pos: Optional[int]) -> str:
        if pos is None:
            return ""
        return self.vector_bytes(pos).decode("utf-8")


@dataclass(frozen=True)
class Quantization:
    scales: tuple[float, ...]
    zero_points: tuple[int, ...]
    quantized_dimension: int


@dataclass(frozen=True)
class Tensor:
    index: int
    name: str
    shape: tuple[int, ...]
    dtype: int
    buffer: int
    quantization: Optional[Quantization]

    @property
    def element_count(self) -> int:
        count = 1
        for dim in self.shape:
            count *= dim
        return count


@dataclass(frozen=True)
class Operator:
    index: int
    opcode: int
    inputs: tuple[int, ...]
    outputs: tuple[int, ...]
    options_type: int
    options_table: Optional[int]

    @property
    def name(self) -> str:
        return OP_NAMES.get(self.opcode, f"OP_{self.opcode}")


class TfliteModel:
    def __init__(self, buf: bytes):
        if buf[4:8] != FILE_IDENTIFIER:
            raise FlatBufferError("missing TFL3 file identifier")
        self.reader = Reader(buf)
        root = self.reader.root()
        self.version = self.reader.scalar(root, MODEL_VERSION, "<I", 0)
        self.operator_codes = [
            self._effective_opcode(table)
            for table in self.reader.vector_tables(self.reader.indirect(root, MODEL_OPERATOR_CODES))
        ]
        self._buffer_tables = self.reader.vector_tables(self.reader.indirect(root, MODEL_BUFFERS))
        subgraphs = self.reader.vector_tables(self.reader.indirect(root, MODEL_SUBGRAPHS))
        if len(subgraphs) != 1:
            raise FlatBufferError(f"expected exactly one subgraph, found {len(subgraphs)}")
        subgraph = subgraphs[0]
        self.tensors = [
            self._tensor(i, table)
            for i, table in enumerate(
                self.reader.vector_tables(self.reader.indirect(subgraph, SUBGRAPH_TENSORS))
            )
        ]
        self.inputs = self.reader.vector_scalars(self.reader.indirect(subgraph, SUBGRAPH_INPUTS), "i")
        self.outputs = self.reader.vector_scalars(
            self.reader.indirect(subgraph, SUBGRAPH_OUTPUTS), "i"
        )
        self.operators = [
            self._operator(i, table)
            for i, table in enumerate(
                self.reader.vector_tables(self.reader.indirect(subgraph, SUBGRAPH_OPERATORS))
            )
        ]

    def _effective_opcode(self, table: int) -> int:
        deprecated = self.reader.scalar(table, OPCODE_DEPRECATED_BUILTIN_CODE, "<b", 0)
        builtin = self.reader.scalar(table, OPCODE_BUILTIN_CODE, "<i", 0)
        return max(deprecated, builtin)

    def _tensor(self, index: int, table: int) -> Tensor:
        r = self.reader
        shape = tuple(r.vector_scalars(r.indirect(table, TENSOR_SHAPE), "i"))
        quant_table = r.indirect(table, TENSOR_QUANTIZATION)
        quantization = None
        if quant_table is not None:
            scales = r.vector_scalars(r.indirect(quant_table, QUANT_SCALE), "f")
            if scales:
                quantization = Quantization(
                    scales=tuple(scales),
                    zero_points=tuple(
                        r.vector_scalars(r.indirect(quant_table, QUANT_ZERO_POINT), "q")
                    ),
                    quantized_dimension=r.scalar(quant_table, QUANT_QUANTIZED_DIMENSION, "<i", 0),
                )
        return Tensor(
            index=index,
            name=r.string(r.indirect(table, TENSOR_NAME)),
            shape=shape,
            dtype=r.scalar(table, TENSOR_TYPE, "<b", TENSOR_FLOAT32),
            buffer=r.scalar(table, TENSOR_BUFFER, "<I", 0),
            quantization=quantization,
        )

    def _operator(self, index: int, table: int) -> Operator:
        r = self.reader
        opcode_index = r.scalar(table, OPERATOR_OPCODE_INDEX, "<I", 0)
        if opcode_index >= len(self.operator_codes):
            raise FlatBufferError(f"operator {index} references opcode {opcode_index}")
        return Operator(
            index=index,
            opcode=self.operator_codes[opcode_index],
            inputs=tuple(r.vector_scalars(r.indirect(table, OPERATOR_INPUTS), "i")),
            outputs=tuple(r.vector_scalars(r.indirect(table, OPERATOR_OUTPUTS), "i")),
            options_type=r.scalar(table, OPERATOR_BUILTIN_OPTIONS_TYPE, "<B", 0),
            options_table=r.indirect(table, OPERATOR_BUILTIN_OPTIONS),
        )

    def buffer_bytes(self, buffer_index: int) -> bytes:
        if buffer_index >= len(self._buffer_tables):
            raise FlatBufferError(f"buffer index {buffer_index} out of range")
        table = self._buffer_tables[buffer_index]
        offset = self.reader.scalar(table, BUFFER_OFFSET, "<Q", 0)
        size = self.reader.scalar(table, BUFFER_SIZE, "<Q", 0)
        if offset > 1 and size > 0:
            if offset + size > len(self.reader.buf):
                raise FlatBufferError(f"buffer {buffer_index} points past end of file")
            return self.reader.buf[offset : offset + size]
        return self.reader.vector_bytes(self.reader.indirect(table, BUFFER_DATA))

    def tensor_bytes(self, tensor_index: int) -> bytes:
        return self.buffer_bytes(self.tensors[tensor_index].buffer)

    def is_constant(self, tensor_index: int) -> bool:
        return len(self.tensor_bytes(tensor_index)) > 0

    def option_bool(self, op: Operator, expected_type: int, field: int) -> bool:
        self._require_options(op, expected_type)
        return bool(self.reader.scalar(op.options_table, field, "<B", 0))

    def option_i8(self, op: Operator, expected_type: int, field: int) -> int:
        self._require_options(op, expected_type)
        return self.reader.scalar(op.options_table, field, "<b", 0)

    def option_f32(self, op: Operator, expected_type: int, field: int) -> float:
        self._require_options(op, expected_type)
        return self.reader.scalar(op.options_table, field, "<f", 0.0)

    def _require_options(self, op: Operator, expected_type: int) -> None:
        if op.options_type != expected_type or op.options_table is None:
            raise FlatBufferError(
                f"operator {op.index} ({op.name}) carries options type {op.options_type}, "
                f"expected {expected_type}"
            )

    def op_histogram(self) -> dict[str, int]:
        histogram: dict[str, int] = {}
        for op in self.operators:
            histogram[op.name] = histogram.get(op.name, 0) + 1
        return histogram
