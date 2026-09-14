"""Maps the Redact TFLite graph onto HF BERT tensor names by walking its topology."""

from __future__ import annotations

import re
import struct
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

import tflite_reader as tr
from safetensors_writer import TensorSpec

EXPECTED_OPS = {
    "ADD": 58,
    "BATCH_MATMUL": 12,
    "CAST": 1,
    "EMBEDDING_LOOKUP": 1,
    "FULLY_CONNECTED": 37,
    "GATHER_ND": 1,
    "GELU": 6,
    "LOGICAL_AND": 1,
    "MEAN": 26,
    "MUL": 44,
    "RESHAPE": 95,
    "RSQRT": 13,
    "SELECT_V2": 1,
    "SOFTMAX": 6,
    "SQUARED_DIFFERENCE": 13,
    "SUB": 13,
    "TRANSPOSE": 24,
}

INPUT_IDS_NAME = "serving_default_input_ids"
ATTENTION_MASK_NAME = "serving_default_attention_mask"
LAYER_RE = re.compile(r"BertLayer_(\d+)")
PASS_THROUGH_OPS = {tr.OP_RESHAPE, tr.OP_TRANSPOSE, tr.OP_MUL}
LN_PATTERN_OPS = {tr.OP_MUL, tr.OP_SUB, tr.OP_RESHAPE, tr.OP_ADD}


class GraphMapError(ValueError):
    pass


@dataclass
class LayerNormParams:
    gamma: Optional[bytes]
    beta: Optional[bytes]
    eps: float
    folded: bool


@dataclass
class LinearParams:
    weight: bytes
    scales: tuple[float, ...]
    bias: bytes
    out_features: int
    in_features: int


@dataclass
class LayerParams:
    query: Optional[LinearParams] = None
    key: Optional[LinearParams] = None
    value: Optional[LinearParams] = None
    attention_output: Optional[LinearParams] = None
    attention_norm: Optional[LayerNormParams] = None
    intermediate: Optional[LinearParams] = None
    output: Optional[LinearParams] = None
    output_norm: Optional[LayerNormParams] = None
    attention_scale: Optional[float] = None


@dataclass
class MappedModel:
    tensors: dict[str, TensorSpec]
    config: dict
    param_count: int
    notes: list[str] = field(default_factory=list)


class Graph:
    def __init__(self, model: tr.TfliteModel):
        self.model = model
        self.producer: dict[int, tr.Operator] = {}
        self.consumers: dict[int, list[tr.Operator]] = {}
        for op in model.operators:
            for t in op.outputs:
                self.producer[t] = op
            for t in op.inputs:
                if t >= 0:
                    self.consumers.setdefault(t, []).append(op)

    def tensor(self, index: int) -> tr.Tensor:
        return self.model.tensors[index]

    def shape(self, index: int) -> tuple[int, ...]:
        return self.tensor(index).shape

    def is_const(self, index: int) -> bool:
        return index >= 0 and index not in self.producer and self.model.is_constant(index)

    def const_inputs(self, op: tr.Operator) -> list[int]:
        return [t for t in op.inputs if self.is_const(t)]

    def dynamic_inputs(self, op: tr.Operator) -> list[int]:
        return [t for t in op.inputs if t >= 0 and not self.is_const(t)]

    def const_f32(self, index: int) -> list[float]:
        data = self.model.tensor_bytes(index)
        return list(struct.unpack(f"<{len(data) // 4}f", data))

    def const_i32(self, index: int) -> list[int]:
        data = self.model.tensor_bytes(index)
        return list(struct.unpack(f"<{len(data) // 4}i", data))

    def const_with_shape(self, op: tr.Operator, shape: tuple[int, ...]) -> Optional[int]:
        matches = [t for t in self.const_inputs(op) if self.shape(t) == shape]
        if len(matches) > 1:
            raise GraphMapError(f"operator {op.index} has several constants of shape {shape}")
        return matches[0] if matches else None

    def scalar_const(self, op: tr.Operator) -> Optional[float]:
        for t in self.const_inputs(op):
            if self.shape(t) == () and self.tensor(t).dtype == tr.TENSOR_FLOAT32:
                return self.const_f32(t)[0]
        return None

    def trace_back_to_fc(self, index: int, scale_sink: list[float]) -> Optional[tr.Operator]:
        current = index
        for _ in range(12):
            op = self.producer.get(current)
            if op is None:
                return None
            if op.opcode == tr.OP_FULLY_CONNECTED:
                return op
            if op.opcode not in PASS_THROUGH_OPS:
                return None
            if op.opcode == tr.OP_MUL:
                scale = self.scalar_const(op)
                if scale is not None:
                    scale_sink.append(scale)
            dynamic = self.dynamic_inputs(op)
            if len(dynamic) != 1:
                return None
            current = dynamic[0]
        return None

    def find_forward(self, start: int, target_opcode: int, allowed: set[int], max_depth: int,
                     scale_sink: Optional[list[float]] = None) -> Optional[tr.Operator]:
        frontier = deque([(start, 0)])
        seen: set[int] = set()
        while frontier:
            tensor, depth = frontier.popleft()
            for op in self.consumers.get(tensor, []):
                if op.index in seen:
                    continue
                seen.add(op.index)
                if op.opcode == target_opcode:
                    return op
                if op.opcode in allowed and depth < max_depth:
                    if scale_sink is not None and op.opcode == tr.OP_MUL:
                        scale = self.scalar_const(op)
                        if scale is not None:
                            scale_sink.append(scale)
                    for out in op.outputs:
                        frontier.append((out, depth + 1))
        return None


def layer_index_from_name(name: str) -> Optional[int]:
    match = LAYER_RE.search(name)
    return int(match.group(1)) if match else None


def check_sanity(graph: Graph) -> None:
    model = graph.model
    histogram = model.op_histogram()
    if histogram != EXPECTED_OPS:
        raise GraphMapError(f"unexpected operator histogram: {histogram}")
    input_names = {graph.tensor(t).name: t for t in model.inputs}
    for name in (INPUT_IDS_NAME, ATTENTION_MASK_NAME):
        if name not in input_names:
            raise GraphMapError(f"missing input {name}")
        tensor = graph.tensor(input_names[name])
        if tensor.dtype != tr.TENSOR_INT32 or len(tensor.shape) != 2 or tensor.shape[0] != 1:
            raise GraphMapError(f"input {name} has unexpected type/shape {tensor.dtype} {tensor.shape}")
    if len(model.outputs) != 1:
        raise GraphMapError(f"expected one output, found {len(model.outputs)}")
    output = graph.tensor(model.outputs[0])
    if output.dtype != tr.TENSOR_FLOAT32 or len(output.shape) != 3:
        raise GraphMapError(f"output has unexpected type/shape {output.dtype} {output.shape}")


def check_quantization(graph: Graph, index: int) -> tuple[float, ...]:
    tensor = graph.tensor(index)
    quant = tensor.quantization
    if tensor.dtype != tr.TENSOR_INT8 or quant is None:
        raise GraphMapError(f"tensor {index} ({tensor.name}) is not an int8 quantized weight")
    if quant.quantized_dimension != 0:
        raise GraphMapError(f"tensor {index} quantized along dimension {quant.quantized_dimension}")
    if len(quant.scales) != tensor.shape[0]:
        raise GraphMapError(
            f"tensor {index} has {len(quant.scales)} scales for {tensor.shape[0]} rows"
        )
    if any(zp != 0 for zp in quant.zero_points):
        raise GraphMapError(f"tensor {index} has non-zero zero points")
    return quant.scales


def linear_params(graph: Graph, op: tr.Operator) -> LinearParams:
    if len(op.inputs) < 3 or op.inputs[2] < 0:
        raise GraphMapError(f"fully connected op {op.index} has no bias")
    weight_index = op.inputs[1]
    bias_index = op.inputs[2]
    scales = check_quantization(graph, weight_index)
    weight = graph.tensor(weight_index)
    bias = graph.tensor(bias_index)
    if len(weight.shape) != 2:
        raise GraphMapError(f"weight {weight_index} is not a matrix: {weight.shape}")
    if bias.dtype != tr.TENSOR_FLOAT32 or bias.shape != (weight.shape[0],):
        raise GraphMapError(f"bias {bias_index} has shape {bias.shape} for weight {weight.shape}")
    if graph.model.option_i8(op, tr.OPTIONS_FULLY_CONNECTED, tr.FC_FUSED_ACTIVATION) != 0:
        raise GraphMapError(f"fully connected op {op.index} has a fused activation")
    return LinearParams(
        weight=graph.model.tensor_bytes(weight_index),
        scales=scales,
        bias=graph.model.tensor_bytes(bias_index),
        out_features=weight.shape[0],
        in_features=weight.shape[1],
    )


def fc_layer_index(graph: Graph, op: tr.Operator) -> Optional[int]:
    return layer_index_from_name(graph.tensor(op.inputs[2]).name)


def map_embeddings(graph: Graph, hidden: int, seq_len: int) -> tuple[dict[str, TensorSpec], int]:
    lookups = [op for op in graph.model.operators if op.opcode == tr.OP_EMBEDDING_LOOKUP]
    if len(lookups) != 1:
        raise GraphMapError("expected exactly one EMBEDDING_LOOKUP")
    word_index = lookups[0].inputs[1]
    scales = check_quantization(graph, word_index)
    word = graph.tensor(word_index)
    if len(word.shape) != 2 or word.shape[1] != hidden:
        raise GraphMapError(f"word embedding has shape {word.shape}")
    table_shape = (1, seq_len, hidden)
    adds = [
        op for op in graph.model.operators
        if op.opcode == tr.OP_ADD and graph.const_with_shape(op, table_shape) is not None
    ]
    if len(adds) != 2:
        raise GraphMapError(f"expected two embedding table additions, found {len(adds)}")
    tables = [graph.const_with_shape(op, table_shape) for op in adds]
    row_bytes = hidden * 4
    identical = []
    for t in tables:
        data = graph.model.tensor_bytes(t)
        first = data[:row_bytes]
        identical.append(all(data[i:i + row_bytes] == first for i in range(0, len(data), row_bytes)))
    if identical.count(True) != 1:
        raise GraphMapError("could not tell position table from token type table")
    token_type_index = tables[identical.index(True)]
    position_index = tables[identical.index(False)]
    tensors = {
        "bert.embeddings.word_embeddings.weight.int8": TensorSpec(
            "I8", word.shape, graph.model.tensor_bytes(word_index)
        ),
        "bert.embeddings.word_embeddings.weight.scale": TensorSpec(
            "F32", (word.shape[0],), pack_f32(scales)
        ),
        "bert.embeddings.position_embeddings.weight": TensorSpec(
            "F32", (seq_len, hidden), graph.model.tensor_bytes(position_index)
        ),
        "bert.embeddings.token_type_embeddings.weight": TensorSpec(
            "F32", (hidden,), graph.model.tensor_bytes(token_type_index)[:row_bytes]
        ),
    }
    return tensors, word.shape[0]


def pack_f32(values) -> bytes:
    return struct.pack(f"<{len(values)}f", *values)


def layer_norm_input(graph: Graph, rsqrt: tr.Operator) -> tuple[int, float]:
    eps_add = graph.producer.get(rsqrt.inputs[0])
    if eps_add is None or eps_add.opcode != tr.OP_ADD:
        raise GraphMapError(f"RSQRT {rsqrt.index} is not fed by an epsilon ADD")
    eps = graph.scalar_const(eps_add)
    if eps is None:
        raise GraphMapError(f"epsilon ADD {eps_add.index} has no scalar constant")
    variance = graph.producer.get(graph.dynamic_inputs(eps_add)[0])
    if variance is None or variance.opcode != tr.OP_MEAN:
        raise GraphMapError(f"epsilon ADD {eps_add.index} is not fed by a variance MEAN")
    squared = graph.producer.get(variance.inputs[0])
    if squared is None or squared.opcode != tr.OP_SQUARED_DIFFERENCE:
        raise GraphMapError(f"variance MEAN {variance.index} is not fed by SQUARED_DIFFERENCE")
    for candidate in squared.inputs:
        prod = graph.producer.get(candidate)
        if prod is not None and prod.opcode == tr.OP_RESHAPE:
            inner = graph.producer.get(prod.inputs[0])
            if inner is not None and inner.opcode == tr.OP_MEAN:
                continue
        return candidate, eps
    raise GraphMapError(f"SQUARED_DIFFERENCE {squared.index} has no normalized input")


def layer_norm_affine(graph: Graph, rsqrt: tr.Operator, hidden: int) -> tuple[Optional[bytes], Optional[bytes]]:
    frontier = deque([(rsqrt.outputs[0], 0)])
    seen: set[int] = set()
    while frontier:
        tensor, depth = frontier.popleft()
        for op in graph.consumers.get(tensor, []):
            if op.index in seen:
                continue
            seen.add(op.index)
            if op.opcode == tr.OP_MUL:
                gamma_index = graph.const_with_shape(op, (hidden,))
                if gamma_index is not None:
                    beta_ops = [
                        c for c in graph.consumers.get(op.outputs[0], [])
                        if c.opcode == tr.OP_ADD and graph.const_with_shape(c, (hidden,)) is not None
                    ]
                    if len(beta_ops) != 1:
                        raise GraphMapError(f"gamma MUL {op.index} is not followed by a beta ADD")
                    beta_index = graph.const_with_shape(beta_ops[0], (hidden,))
                    return graph.model.tensor_bytes(gamma_index), graph.model.tensor_bytes(beta_index)
            if op.opcode == tr.OP_FULLY_CONNECTED:
                return None, None
            if op.opcode in LN_PATTERN_OPS and depth < 8:
                for out in op.outputs:
                    frontier.append((out, depth + 1))
    raise GraphMapError(f"no affine or consumer found after RSQRT {rsqrt.index}")


def map_layer_norms(graph: Graph, hidden: int, seq_len: int, layers: dict[int, LayerParams]) -> LayerNormParams:
    embeddings_norm: Optional[LayerNormParams] = None
    for rsqrt in (op for op in graph.model.operators if op.opcode == tr.OP_RSQRT):
        x, eps = layer_norm_input(graph, rsqrt)
        gamma, beta = layer_norm_affine(graph, rsqrt, hidden)
        params = LayerNormParams(gamma=gamma, beta=beta, eps=eps, folded=gamma is None)
        producer = graph.producer.get(x)
        if producer is None or producer.opcode != tr.OP_ADD:
            raise GraphMapError(f"LayerNorm input {x} is not produced by an ADD")
        if graph.const_with_shape(producer, (1, seq_len, hidden)) is not None:
            if embeddings_norm is not None:
                raise GraphMapError("found two embedding LayerNorms")
            embeddings_norm = params
            continue
        fc_ops = [
            graph.producer[t] for t in graph.dynamic_inputs(producer)
            if graph.producer.get(t) is not None and graph.producer[t].opcode == tr.OP_FULLY_CONNECTED
        ]
        if len(fc_ops) != 1:
            raise GraphMapError(f"residual ADD {producer.index} has {len(fc_ops)} FC inputs")
        fc = fc_ops[0]
        layer = fc_layer_index(graph, fc)
        if layer is None:
            raise GraphMapError(f"FC {fc.index} feeding a LayerNorm has no layer index")
        weight_shape = graph.shape(fc.inputs[1])
        target = layers.setdefault(layer, LayerParams())
        if weight_shape == (hidden, hidden):
            if target.attention_norm is not None:
                raise GraphMapError(f"layer {layer} has two attention LayerNorms")
            target.attention_norm = params
        elif weight_shape[0] == hidden and weight_shape[1] != hidden:
            if target.output_norm is not None:
                raise GraphMapError(f"layer {layer} has two output LayerNorms")
            target.output_norm = params
        else:
            raise GraphMapError(f"residual FC {fc.index} has unexpected weight shape {weight_shape}")
    if embeddings_norm is None:
        raise GraphMapError("embedding LayerNorm not found")
    return embeddings_norm


def map_attention(graph: Graph, hidden: int, layers: dict[int, LayerParams]) -> tuple[int, int]:
    heads: Optional[tuple[int, int]] = None
    for bmm in (op for op in graph.model.operators if op.opcode == tr.OP_BATCH_MATMUL):
        model = graph.model
        if model.option_bool(bmm, tr.OPTIONS_BATCH_MATMUL, tr.BMM_ADJ_X) or model.option_bool(
            bmm, tr.OPTIONS_BATCH_MATMUL, tr.BMM_ADJ_Y
        ):
            raise GraphMapError(f"BATCH_MATMUL {bmm.index} uses adjoint inputs")
        lhs_producer = graph.producer.get(bmm.inputs[0])
        lhs_from_softmax = (
            lhs_producer is not None
            and lhs_producer.opcode == tr.OP_RESHAPE
            and graph.producer.get(lhs_producer.inputs[0]) is not None
            and graph.producer[lhs_producer.inputs[0]].opcode == tr.OP_SOFTMAX
        )
        if lhs_from_softmax:
            scales: list[float] = []
            value_fc = graph.trace_back_to_fc(bmm.inputs[1], scales)
            if value_fc is None or scales:
                raise GraphMapError(f"context BATCH_MATMUL {bmm.index} rhs does not trace to a plain FC")
            layer = fc_layer_index(graph, value_fc)
            target = layers.setdefault(layer, LayerParams())
            target.value = linear_params(graph, value_fc)
            out_fc = graph.find_forward(bmm.outputs[0], tr.OP_FULLY_CONNECTED, {tr.OP_RESHAPE, tr.OP_TRANSPOSE}, 6)
            if out_fc is None or fc_layer_index(graph, out_fc) != layer:
                raise GraphMapError(f"context BATCH_MATMUL {bmm.index} has no attention output FC")
            target.attention_output = linear_params(graph, out_fc)
            continue
        score_scales: list[float] = []
        softmax = graph.find_forward(
            bmm.outputs[0], tr.OP_SOFTMAX, {tr.OP_MUL, tr.OP_ADD, tr.OP_RESHAPE}, 5, score_scales
        )
        if softmax is None:
            raise GraphMapError(f"BATCH_MATMUL {bmm.index} is neither scores nor context")
        if graph.model.option_f32(softmax, tr.OPTIONS_SOFTMAX, tr.SOFTMAX_BETA) != 1.0:
            raise GraphMapError(f"SOFTMAX {softmax.index} has beta != 1")
        q_scales: list[float] = []
        k_scales: list[float] = []
        query_fc = graph.trace_back_to_fc(bmm.inputs[0], q_scales)
        key_fc = graph.trace_back_to_fc(bmm.inputs[1], k_scales)
        if query_fc is None or key_fc is None:
            raise GraphMapError(f"scores BATCH_MATMUL {bmm.index} inputs do not trace to FCs")
        layer = fc_layer_index(graph, query_fc)
        if fc_layer_index(graph, key_fc) != layer:
            raise GraphMapError(f"query and key of BATCH_MATMUL {bmm.index} belong to different layers")
        all_scales = score_scales + q_scales + k_scales
        if len(all_scales) != 1:
            raise GraphMapError(f"layer {layer} has {len(all_scales)} attention scale constants")
        target = layers.setdefault(layer, LayerParams())
        target.query = linear_params(graph, query_fc)
        target.key = linear_params(graph, key_fc)
        target.attention_scale = all_scales[0]
        reshape = graph.find_forward(query_fc.outputs[0], tr.OP_RESHAPE, set(), 1)
        if reshape is None:
            raise GraphMapError(f"query FC {query_fc.index} is not followed by a head RESHAPE")
        dims = graph.const_i32(reshape.inputs[1])
        if len(dims) != 4 or dims[2] * dims[3] != hidden:
            raise GraphMapError(f"head RESHAPE {reshape.index} has dims {dims}")
        if heads is None:
            heads = (dims[2], dims[3])
        elif heads != (dims[2], dims[3]):
            raise GraphMapError("head layout differs between layers")
    if heads is None:
        raise GraphMapError("no attention layers found")
    return heads


def map_feed_forward(graph: Graph, hidden: int, layers: dict[int, LayerParams]) -> LinearParams:
    classifier: Optional[LinearParams] = None
    for fc in (op for op in graph.model.operators if op.opcode == tr.OP_FULLY_CONNECTED):
        shape = graph.shape(fc.inputs[1])
        layer = fc_layer_index(graph, fc)
        if layer is None:
            if classifier is not None:
                raise GraphMapError("found two classifier heads")
            classifier = linear_params(graph, fc)
            continue
        if shape == (hidden, hidden):
            continue
        target = layers.setdefault(layer, LayerParams())
        if shape[1] == hidden:
            if target.intermediate is not None:
                raise GraphMapError(f"layer {layer} has two intermediate FCs")
            target.intermediate = linear_params(graph, fc)
        elif shape[0] == hidden:
            if target.output is not None:
                raise GraphMapError(f"layer {layer} has two output FCs")
            target.output = linear_params(graph, fc)
        else:
            raise GraphMapError(f"FC {fc.index} has unexpected weight shape {shape}")
    if classifier is None:
        raise GraphMapError("classifier head not found")
    return classifier


def gelu_approximate(graph: Graph) -> bool:
    flags = {
        graph.model.option_bool(op, tr.OPTIONS_GELU, tr.GELU_APPROXIMATE)
        for op in graph.model.operators
        if op.opcode == tr.OP_GELU
    }
    if len(flags) != 1:
        raise GraphMapError(f"GELU approximate flag differs between ops: {flags}")
    return flags.pop()


def linear_tensors(prefix: str, params: LinearParams) -> dict[str, TensorSpec]:
    return {
        f"{prefix}.weight.int8": TensorSpec("I8", (params.out_features, params.in_features), params.weight),
        f"{prefix}.weight.scale": TensorSpec("F32", (params.out_features,), pack_f32(params.scales)),
        f"{prefix}.bias": TensorSpec("F32", (params.out_features,), params.bias),
    }


def layer_norm_tensors(prefix: str, params: LayerNormParams, hidden: int) -> dict[str, TensorSpec]:
    gamma = params.gamma if params.gamma is not None else pack_f32([1.0] * hidden)
    beta = params.beta if params.beta is not None else pack_f32([0.0] * hidden)
    return {
        f"{prefix}.weight": TensorSpec("F32", (hidden,), gamma),
        f"{prefix}.bias": TensorSpec("F32", (hidden,), beta),
    }


def require(value, what: str):
    if value is None:
        raise GraphMapError(f"missing {what}")
    return value


def map_graph(model: tr.TfliteModel) -> MappedModel:
    graph = Graph(model)
    check_sanity(graph)
    input_ids = next(t for t in model.inputs if graph.tensor(t).name == INPUT_IDS_NAME)
    seq_len = graph.shape(input_ids)[1]
    output_shape = graph.shape(model.outputs[0])
    num_labels = output_shape[2]
    lookup = next(op for op in model.operators if op.opcode == tr.OP_EMBEDDING_LOOKUP)
    hidden = graph.shape(lookup.inputs[1])[1]

    layers: dict[int, LayerParams] = {}
    tensors, vocab = map_embeddings(graph, hidden, seq_len)
    embeddings_norm = map_layer_norms(graph, hidden, seq_len, layers)
    heads, head_dim = map_attention(graph, hidden, layers)
    classifier = map_feed_forward(graph, hidden, layers)
    approximate = gelu_approximate(graph)

    layer_indices = sorted(layers)
    if layer_indices != list(range(len(layer_indices))):
        raise GraphMapError(f"layer indices are not contiguous: {layer_indices}")
    eps_values = {embeddings_norm.eps}
    scales = set()
    notes: list[str] = []
    if embeddings_norm.folded:
        raise GraphMapError("embedding LayerNorm has no affine parameters")
    tensors.update(layer_norm_tensors("bert.embeddings.LayerNorm", embeddings_norm, hidden))
    for i in layer_indices:
        layer = layers[i]
        prefix = f"bert.encoder.layer.{i}"
        for name, params in (
            ("attention.self.query", layer.query),
            ("attention.self.key", layer.key),
            ("attention.self.value", layer.value),
            ("attention.output.dense", layer.attention_output),
            ("intermediate.dense", layer.intermediate),
            ("output.dense", layer.output),
        ):
            tensors.update(linear_tensors(f"{prefix}.{name}", require(params, f"{prefix}.{name}")))
        attention_norm = require(layer.attention_norm, f"{prefix}.attention.output.LayerNorm")
        output_norm = require(layer.output_norm, f"{prefix}.output.LayerNorm")
        if attention_norm.folded:
            raise GraphMapError(f"layer {i} attention LayerNorm has no affine parameters")
        if output_norm.folded:
            notes.append(f"layer {i} output LayerNorm affine folded into the classifier; emitting identity")
        tensors.update(layer_norm_tensors(f"{prefix}.attention.output.LayerNorm", attention_norm, hidden))
        tensors.update(layer_norm_tensors(f"{prefix}.output.LayerNorm", output_norm, hidden))
        eps_values.update({attention_norm.eps, output_norm.eps})
        scales.add(require(layer.attention_scale, f"{prefix} attention scale"))
        intermediate = require(layer.intermediate, f"{prefix}.intermediate.dense")
    tensors.update(linear_tensors("classifier", classifier))
    if classifier.out_features != num_labels or classifier.in_features != hidden:
        raise GraphMapError(f"classifier shape {classifier.out_features}x{classifier.in_features} mismatch")
    if len(scales) != 1:
        raise GraphMapError(f"attention scale differs between layers: {sorted(scales)}")
    eps_sorted = sorted(eps_values)
    if eps_sorted[-1] - eps_sorted[0] > 1e-15:
        raise GraphMapError(f"LayerNorm epsilon differs between norms: {eps_sorted}")

    param_count = sum(
        _product(spec.shape)
        for name, spec in tensors.items()
        if not name.endswith(".scale")
    )
    config = {
        "vocab_size": vocab,
        "hidden_size": hidden,
        "num_hidden_layers": len(layer_indices),
        "num_attention_heads": heads,
        "head_dim": head_dim,
        "intermediate_size": intermediate.out_features,
        "max_seq_len": seq_len,
        "layer_norm_eps": eps_sorted[0],
        "attention_scale": scales.pop(),
        "gelu_approximate": approximate,
        "num_labels": num_labels,
        "pad_token_id": 1,
        "cls_token_id": 0,
        "sep_token_id": 2,
    }
    return MappedModel(tensors=tensors, config=config, param_count=param_count, notes=notes)


def _product(shape: tuple[int, ...]) -> int:
    count = 1
    for dim in shape:
        count *= dim
    return count


def dump_ops(model: tr.TfliteModel) -> list[str]:
    graph = Graph(model)
    lines = []
    for op in model.operators:
        parts = []
        for t in op.inputs:
            if t < 0:
                parts.append("-")
                continue
            tensor = graph.tensor(t)
            flag = "C" if graph.is_const(t) else ""
            parts.append(f"{t}{flag}{list(tensor.shape)}")
        lines.append(f"{op.index:4d} {op.name:<18} {' '.join(parts)} -> {list(op.outputs)}")
    return lines
