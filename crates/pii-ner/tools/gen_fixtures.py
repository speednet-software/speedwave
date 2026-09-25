"""Reference fixtures for tests/model_e2e.rs and a numeric check of the converted weights.

Dev-only: needs numpy, tokenizers and ai-edge-litert (tools/requirements-dev.txt).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from ai_edge_litert.interpreter import Interpreter
from tokenizers import Tokenizer

from safetensors_writer import read_safetensors_header, read_safetensors_tensor

SEQ_LEN = 256
MAX_CONTENT = SEQ_LEN - 2
WINDOW_STEP = MAX_CONTENT - 64
LOW_SCORE = 0.3
CONNECTORS = {"-", "'", "’"}
NAME_FAMILY = {"GIVEN_NAME", "SURNAME"}

DEFAULT_TEXTS = [
    "Jan Kowalski, PESEL 44051401359, mieszka przy ul. Długiej 5, 00-001 Warszawa, tel. 601 234 567, jan.kowalski@example.com.",
    "Anna Nowak-Wiśniewska pracuje w firmie Speednet w Gdańsku; jej NIP to 583-000-00-00, a konto PL61 1090 1014 0000 0712 1981 2874.",
    "Please ship the parcel to Michael O'Brien, 221B Baker Street, London NW1 6XE, United Kingdom, and call +44 20 7946 0958 on arrival.",
    "fn main() { let user = User { name: \"anna\", email: \"anna@example.org\" }; println!(\"{}\", user.name); }",
    "2026-09-14T10:15:32.412+02:00 [INFO][proxy] request from 10.0.0.12 forwarded to https://api.anthropic.com/v1/messages in 812 ms",
    "ZAMÓWIENIE DLA MARKA ZIELIŃSKIEGO, UL. KRÓTKA 7, 31-001 KRAKÓW, TELEFON 500 100 200.",
]


def load_labels(artifact: Path) -> list[str]:
    with open(artifact / "manifest.json", encoding="utf-8") as handle:
        return json.load(handle)["labels"]


def byte_offsets(text: str, encoding) -> list[tuple[int, int]]:
    """HF Python bindings report char offsets; the Rust crate works in UTF-8 bytes."""
    prefix = [0]
    for ch in text:
        prefix.append(prefix[-1] + len(ch.encode("utf-8")))
    return [(prefix[s], prefix[e]) for s, e in encoding.offsets]


def window_ranges(n: int) -> list[tuple[int, int]]:
    if n == 0:
        return []
    ranges = []
    start = 0
    while True:
        end = min(start + MAX_CONTENT, n)
        ranges.append((start, end))
        if end == n:
            return ranges
        start += WINDOW_STEP


def encode_window(ids: list[int]) -> tuple[np.ndarray, np.ndarray, int]:
    row = [0] + ids + [2]
    real_len = len(row)
    row += [1] * (SEQ_LEN - real_len)
    mask = [1] * real_len + [0] * (SEQ_LEN - real_len)
    return np.array([row], dtype=np.int32), np.array([mask], dtype=np.int32), real_len


class TfliteRunner:
    def __init__(self, path: Path):
        self.interp = Interpreter(model_path=str(path))
        self.interp.allocate_tensors()
        details = {d["name"]: d["index"] for d in self.interp.get_input_details()}
        self.ids_index = next(i for n, i in details.items() if "input_ids" in n)
        self.mask_index = next(i for n, i in details.items() if "attention_mask" in n)
        self.out_index = self.interp.get_output_details()[0]["index"]

    def logits(self, ids: np.ndarray, mask: np.ndarray) -> np.ndarray:
        self.interp.set_tensor(self.ids_index, ids)
        self.interp.set_tensor(self.mask_index, mask)
        self.interp.invoke()
        return self.interp.get_tensor(self.out_index)[0].astype(np.float32)


def softmax(x: np.ndarray) -> np.ndarray:
    z = x - x.max(axis=-1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=-1, keepdims=True)


class NumpyPort:
    """Float32 forward pass mirroring crates/pii-ner/src/model, fed from the artifact."""

    def __init__(self, artifact: Path):
        with open(artifact / "manifest.json", encoding="utf-8") as handle:
            manifest = json.load(handle)
        self.cfg = manifest["config"]
        self.path = artifact / manifest["files"]["weights"]
        self.header = read_safetensors_header(self.path)

    def f32(self, name: str) -> np.ndarray:
        dtype, shape, data = read_safetensors_tensor(self.path, name)
        assert dtype == "F32", name
        return np.frombuffer(data, dtype=np.float32).reshape(shape)

    def dequant(self, base: str) -> np.ndarray:
        dtype, shape, data = read_safetensors_tensor(self.path, f"{base}.weight.int8")
        assert dtype == "I8", base
        q = np.frombuffer(data, dtype=np.int8).reshape(shape).astype(np.float32)
        scale = self.f32(f"{base}.weight.scale")
        return q * scale[:, None]

    def linear(self, x: np.ndarray, base: str) -> np.ndarray:
        return x @ self.dequant(base).T + self.f32(f"{base}.bias")

    def layer_norm(self, x: np.ndarray, base: str) -> tuple[np.ndarray, np.ndarray]:
        """Returns (normalized, affine): the exporter feeds the next linear layers with the
        un-scaled normalization and keeps gamma/beta only on the residual stream."""
        mean = x.mean(axis=-1, keepdims=True)
        var = ((x - mean) ** 2).mean(axis=-1, keepdims=True)
        normalized = (x - mean) / np.sqrt(var + self.cfg["layer_norm_eps"])
        return normalized, normalized * self.f32(f"{base}.weight") + self.f32(f"{base}.bias")

    def gelu(self, x: np.ndarray) -> np.ndarray:
        from math import erf, sqrt
        vec = np.vectorize(lambda v: 0.5 * v * (1.0 + erf(v / sqrt(2.0))))
        return vec(x).astype(np.float32)

    def forward(self, ids: np.ndarray, mask: np.ndarray) -> np.ndarray:
        cfg = self.cfg
        h, heads, dh = cfg["hidden_size"], cfg["num_attention_heads"], cfg["head_dim"]
        seq = ids.shape[1]
        word = self.dequant("bert.embeddings.word_embeddings")[ids[0]]
        pos = self.f32("bert.embeddings.position_embeddings.weight")[:seq]
        tt = self.f32("bert.embeddings.token_type_embeddings.weight")
        normed, x = self.layer_norm(word + pos + tt, "bert.embeddings.LayerNorm")
        pad = mask[0] == 0
        for i in range(cfg["num_hidden_layers"]):
            p = f"bert.encoder.layer.{i}"
            q = self.linear(normed, f"{p}.attention.self.query").reshape(seq, heads, dh).transpose(1, 0, 2)
            k = self.linear(normed, f"{p}.attention.self.key").reshape(seq, heads, dh).transpose(1, 0, 2)
            v = self.linear(normed, f"{p}.attention.self.value").reshape(seq, heads, dh).transpose(1, 0, 2)
            scores = (q @ k.transpose(0, 2, 1)) * cfg["attention_scale"]
            scores[:, :, pad] = -1.0e9
            probs = softmax(scores)
            ctx = (probs @ v).transpose(1, 0, 2).reshape(seq, h)
            normed, x = self.layer_norm(x + self.linear(ctx, f"{p}.attention.output.dense"), f"{p}.attention.output.LayerNorm")
            inter = self.gelu(self.linear(normed, f"{p}.intermediate.dense"))
            normed, x = self.layer_norm(x + self.linear(inter, f"{p}.output.dense"), f"{p}.output.LayerNorm")
        return self.linear(normed, "classifier")


def decode_bioes(tags: list[str], offsets: list[tuple[int, int]]) -> list[tuple[int, int, str]]:
    out: list[tuple[int, int, str]] = []
    open_span: list | None = None

    def close():
        nonlocal open_span
        if open_span and open_span[1] > open_span[0]:
            out.append(tuple(open_span))
        open_span = None

    for tag, (a, b) in zip(tags, offsets):
        if b <= a:
            continue
        if tag == "O":
            close()
            continue
        prefix, label = tag.split("-", 1)
        if prefix == "S":
            close()
            out.append((a, b, label))
        elif prefix == "B":
            close()
            open_span = [a, b, label]
        elif prefix == "I":
            if open_span and open_span[2] == label:
                open_span[1] = b
            else:
                close()
                open_span = [a, b, label]
        elif prefix == "E":
            if open_span and open_span[2] == label:
                open_span[1] = b
                close()
            else:
                close()
                out.append((a, b, label))
    close()
    return out


def snap(text_bytes: bytes, start: int, end: int) -> tuple[int, int]:
    text = text_bytes.decode("utf-8")

    def char_index(byte_pos: int) -> int:
        return len(text_bytes[:byte_pos].decode("utf-8", errors="ignore"))

    s = char_index(start)
    e = char_index(end)
    while s > 0:
        c = text[s - 1]
        if c.isalnum():
            s -= 1
        elif c in CONNECTORS and s - 2 >= 0 and text[s - 2].isalnum():
            s -= 1
        else:
            break
    while e < len(text):
        c = text[e]
        if c.isalnum():
            e += 1
        elif c in CONNECTORS and e + 1 < len(text) and text[e + 1].isalnum():
            e += 1
        else:
            break
    return len(text[:s].encode("utf-8")), len(text[:e].encode("utf-8"))


def merge_same_label(spans: list[dict]) -> list[dict]:
    ordered = sorted(spans, key=lambda s: (s["start"], -(s["end"] - s["start"]), s["label"]))
    out: list[dict] = []
    for s in ordered:
        if out and out[-1]["label"] == s["label"] and s["start"] <= out[-1]["end"]:
            out[-1]["end"] = max(out[-1]["end"], s["end"])
            out[-1]["confidence"] = max(out[-1]["confidence"], s["confidence"])
        elif not out or s["start"] >= out[-1]["end"]:
            out.append(dict(s))
    return out


def expected_spans(text: str, windows: list[dict], offsets: list[tuple[int, int]], labels: list[str], min_score: float) -> list[dict]:
    low = min(LOW_SCORE, min_score)
    scored: dict[tuple, float] = {}
    order: list[tuple] = []
    for w in windows:
        a, b = w["token_range"]
        win_offsets = [(0, 0)] + offsets[a:b] + [(0, 0)]
        tags = [labels[c] if p >= low else "O" for c, p in zip(w["argmax"], w["max_prob"])]
        for s, e, label in decode_bioes(tags, win_offsets):
            score = max(p for (ts, te), p in zip(win_offsets, w["max_prob"]) if te > ts and ts < e and s < te)
            key = (s, e, label)
            if key not in scored:
                order.append(key)
                scored[key] = score
            else:
                scored[key] = max(scored[key], score)
    kept = [{"start": s, "end": e, "label": l, "confidence": scored[(s, e, l)]} for (s, e, l) in order if scored[(s, e, l)] >= min_score]
    merged = merge_same_label(kept)
    text_bytes = text.encode("utf-8")
    snapped = []
    for s in merged:
        start, end = snap(text_bytes, s["start"], s["end"])
        snapped.append({**s, "start": start, "end": end})
    final = merge_same_label(snapped)
    final.sort(key=lambda s: (s["start"], s["end"], s["label"]))
    return [{"start": s["start"], "end": s["end"], "label": s["label"], "confidence": round(s["confidence"], 4)} for s in final]


def build_fixture(text: str, tokenizer: Tokenizer, runner: TfliteRunner, labels: list[str], min_score: float, port: NumpyPort | None) -> tuple[dict, list[str]]:
    encoding = tokenizer.encode(text, add_special_tokens=False)
    offsets = byte_offsets(text, encoding)
    ids = list(encoding.ids)
    windows = []
    notes = []
    for a, b in window_ranges(len(ids)):
        win_ids, win_mask, real_len = encode_window(ids[a:b])
        logits = runner.logits(win_ids, win_mask)[:real_len]
        probs = softmax(logits)
        windows.append({
            "token_range": [a, b],
            "real_len": real_len,
            "argmax": [int(c) for c in probs.argmax(axis=-1)],
            "max_prob": [round(float(p), 5) for p in probs.max(axis=-1)],
        })
        if port is not None:
            ours = port.forward(win_ids, win_mask)[:real_len]
            our_probs = softmax(ours)
            agree = float((our_probs.argmax(axis=-1) == probs.argmax(axis=-1)).mean())
            notes.append(
                f"window {a}-{b}: max |logit diff| {float(np.abs(ours - logits).max()):.4f}, "
                f"argmax agreement {agree:.3f}, max |prob diff| {float(np.abs(our_probs.max(axis=-1) - probs.max(axis=-1)).max()):.4f}"
            )
    fixture = {
        "text": text,
        "min_score": min_score,
        "tokens": [{"id": int(i), "start": s, "end": e} for i, (s, e) in zip(ids, offsets)],
        "windows": windows,
        "expected_spans": expected_spans(text, windows, offsets, labels, min_score),
    }
    return fixture, notes


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True, help="directory holding redact.tflite")
    parser.add_argument("--out", type=Path, help="fixture directory to write (omit to only print)")
    parser.add_argument("--texts", type=Path, help="JSON array of texts (defaults to built-in samples)")
    parser.add_argument("--min-score", type=float, default=0.6)
    parser.add_argument("--check-port", action="store_true", help="compare the numpy port of the artifact against tflite")
    args = parser.parse_args(argv)

    texts = json.loads(args.texts.read_text(encoding="utf-8")) if args.texts else list(DEFAULT_TEXTS)
    if not args.texts:
        texts.append(" ".join(DEFAULT_TEXTS[:3] * 4))
    tokenizer = Tokenizer.from_file(str(args.artifact / "tokenizer.json"))
    runner = TfliteRunner(args.cache / "redact.tflite")
    labels = load_labels(args.artifact)
    port = NumpyPort(args.artifact) if args.check_port else None
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
    for index, text in enumerate(texts):
        fixture, notes = build_fixture(text, tokenizer, runner, labels, args.min_score, port)
        spans = ", ".join(f"{s['label']}={text.encode()[s['start']:s['end']].decode()!r}@{s['confidence']}" for s in fixture["expected_spans"])
        print(f"[{index}] {len(fixture['tokens'])} tokens, {len(fixture['windows'])} windows: {spans}")
        for note in notes:
            print(f"    {note}")
        if args.out:
            path = args.out / f"{index:02d}.json"
            path.write_text(json.dumps(fixture, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
