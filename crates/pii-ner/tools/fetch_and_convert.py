"""Downloads the pinned Redact release files, converts the TFLite graph to the Speedwave artifact."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import urllib.request
from pathlib import Path

import graph_map
import tflite_reader as tr
from safetensors_writer import read_safetensors_header, write_safetensors

TOOLS_DIR = Path(__file__).resolve().parent
PINS_PATH = TOOLS_DIR / "pins.json"
ARTIFACT_FORMAT_VERSION = 1
WEIGHTS_FILE = "redact-bert.safetensors"
TOKENIZER_FILE = "tokenizer.json"
MANIFEST_FILE = "manifest.json"
PIPELINE_DEFAULTS = {"max_content": 254, "stride": 64, "min_score": 0.6, "low_score": 0.3}
EXPECTED_LABEL_COUNT = 89


class ConvertError(RuntimeError):
    pass


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_pins() -> dict:
    with open(PINS_PATH, encoding="utf-8") as handle:
        pins = json.load(handle)
    for name, pin in pins["files"].items():
        if not re.fullmatch(r"[0-9a-f]{64}", pin["sha256"]):
            raise ConvertError(f"pins.json: {name} sha256 is not 64 lowercase hex characters")
    return pins


def default_cache_dir(pins: dict) -> Path:
    return Path.home() / ".cache" / "speedwave" / "pii-ner" / pins["revision"]


def source_url(pins: dict, name: str) -> str:
    return f"https://huggingface.co/{pins['repo']}/resolve/{pins['revision']}/{name}"


def verify_source(path: Path, name: str, pin: dict) -> None:
    actual = sha256_of(path)
    if actual != pin["sha256"]:
        raise ConvertError(f"{name}: sha256 {actual} does not match pinned {pin['sha256']}")
    if "size" in pin and path.stat().st_size != pin["size"]:
        raise ConvertError(f"{name}: size {path.stat().st_size} does not match pinned {pin['size']}")


def ensure_sources(pins: dict, cache: Path, skip_download: bool) -> dict[str, Path]:
    cache.mkdir(parents=True, exist_ok=True)
    paths = {}
    for name, pin in pins["files"].items():
        path = cache / name
        if not path.exists() or sha256_of(path) != pin["sha256"]:
            if skip_download:
                raise ConvertError(f"{name} missing or stale in {cache} and downloads are disabled")
            download(source_url(pins, name), path)
        verify_source(path, name, pin)
        paths[name] = path
    return paths


def download(url: str, dest: Path) -> None:
    tmp = dest.with_suffix(dest.suffix + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": "speedwave-pii-ner-converter"})
    with urllib.request.urlopen(request, timeout=120) as response, open(tmp, "wb") as out:
        shutil.copyfileobj(response, out, 1 << 20)
    tmp.replace(dest)


def load_labels(path: Path) -> list[str]:
    with open(path, encoding="utf-8") as handle:
        id2label = json.load(handle)["id2label"]
    labels = [id2label[str(i)] for i in range(len(id2label))]
    if len(labels) != EXPECTED_LABEL_COUNT or labels[0] != "O":
        raise ConvertError(f"unexpected label set: {len(labels)} labels, first {labels[0]!r}")
    return labels


def check_meta(path: Path) -> None:
    with open(path, encoding="utf-8") as handle:
        meta = json.load(handle)
    recommended = meta.get("recommended", {})
    expected = {"min_score": PIPELINE_DEFAULTS["min_score"], "max_length": 256, "stride": PIPELINE_DEFAULTS["stride"]}
    for key, value in expected.items():
        if recommended.get(key) != value:
            raise ConvertError(f"redact_meta.json recommended.{key}={recommended.get(key)!r}, expected {value!r}")


def artifact_is_current(out: Path, pins: dict) -> bool:
    manifest_path = out / MANIFEST_FILE
    weights_path = out / WEIGHTS_FILE
    if not manifest_path.exists() or not weights_path.exists() or not (out / TOKENIZER_FILE).exists():
        return False
    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    return (
        manifest.get("artifact_format_version") == ARTIFACT_FORMAT_VERSION
        and manifest.get("model", {}).get("source_tflite_sha256") == pins["files"]["redact.tflite"]["sha256"]
        and manifest.get("files", {}).get("weights_sha256") == sha256_of(weights_path)
    )


def convert(pins: dict, sources: dict[str, Path], out: Path) -> dict:
    model = tr.TfliteModel(sources["redact.tflite"].read_bytes())
    mapped = graph_map.map_graph(model)
    labels = load_labels(sources["labels.json"])
    check_meta(sources["redact_meta.json"])
    if mapped.config["num_labels"] != len(labels):
        raise ConvertError(f"model emits {mapped.config['num_labels']} classes, labels.json has {len(labels)}")
    out.mkdir(parents=True, exist_ok=True)
    weights_sha = write_safetensors(
        out / WEIGHTS_FILE,
        mapped.tensors,
        {"format": "speedwave-pii-ner", "format_version": str(ARTIFACT_FORMAT_VERSION), "linear_layout": "out_in"},
    )
    shutil.copyfile(sources["tokenizer.json"], out / TOKENIZER_FILE)
    manifest = {
        "artifact_format_version": ARTIFACT_FORMAT_VERSION,
        "model": {
            "name": pins["repo"],
            "revision": pins["revision"],
            "version": pins["model_version"],
            "source_tflite_sha256": pins["files"]["redact.tflite"]["sha256"],
            "source_tflite_size": pins["files"]["redact.tflite"]["size"],
            "param_count": mapped.param_count,
        },
        "files": {
            "weights": WEIGHTS_FILE,
            "weights_sha256": weights_sha,
            "tokenizer": TOKENIZER_FILE,
            "tokenizer_sha256": pins["files"]["tokenizer.json"]["sha256"],
        },
        "config": mapped.config,
        "labels": labels,
        "pipeline": PIPELINE_DEFAULTS,
        "notes": mapped.notes,
    }
    with open(out / MANIFEST_FILE, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")
    return manifest


def verify_artifact(out: Path, pins: dict) -> list[str]:
    problems = []
    manifest_path = out / MANIFEST_FILE
    if not manifest_path.exists():
        return [f"{manifest_path} missing"]
    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    if manifest.get("artifact_format_version") != ARTIFACT_FORMAT_VERSION:
        problems.append("artifact_format_version mismatch")
    if manifest["model"]["source_tflite_sha256"] != pins["files"]["redact.tflite"]["sha256"]:
        problems.append("source tflite sha256 differs from pins.json")
    weights_path = out / manifest["files"]["weights"]
    if sha256_of(weights_path) != manifest["files"]["weights_sha256"]:
        problems.append("weights sha256 differs from manifest")
    if sha256_of(out / manifest["files"]["tokenizer"]) != manifest["files"]["tokenizer_sha256"]:
        problems.append("tokenizer sha256 differs from manifest")
    header = read_safetensors_header(weights_path)
    tensor_names = {k for k in header if k != "__metadata__"}
    cfg = manifest["config"]
    expected = {
        "bert.embeddings.word_embeddings.weight.int8",
        "bert.embeddings.word_embeddings.weight.scale",
        "bert.embeddings.position_embeddings.weight",
        "bert.embeddings.token_type_embeddings.weight",
        "bert.embeddings.LayerNorm.weight",
        "bert.embeddings.LayerNorm.bias",
        "classifier.weight.int8",
        "classifier.weight.scale",
        "classifier.bias",
    }
    for i in range(cfg["num_hidden_layers"]):
        prefix = f"bert.encoder.layer.{i}"
        for linear in (
            "attention.self.query", "attention.self.key", "attention.self.value",
            "attention.output.dense", "intermediate.dense", "output.dense",
        ):
            expected.update({f"{prefix}.{linear}.weight.int8", f"{prefix}.{linear}.weight.scale", f"{prefix}.{linear}.bias"})
        for norm in ("attention.output.LayerNorm", "output.LayerNorm"):
            expected.update({f"{prefix}.{norm}.weight", f"{prefix}.{norm}.bias"})
    if tensor_names != expected:
        problems.append(f"tensor set mismatch: missing {sorted(expected - tensor_names)}, extra {sorted(tensor_names - expected)}")
    if len(manifest["labels"]) != cfg["num_labels"]:
        problems.append("label count differs from num_labels")
    if header["bert.embeddings.word_embeddings.weight.int8"]["shape"] != [cfg["vocab_size"], cfg["hidden_size"]]:
        problems.append("word embedding shape mismatch")
    if header["classifier.weight.int8"]["shape"] != [cfg["num_labels"], cfg["hidden_size"]]:
        problems.append("classifier shape mismatch")
    if header["bert.embeddings.position_embeddings.weight"]["shape"] != [cfg["max_seq_len"], cfg["hidden_size"]]:
        problems.append("position embedding shape mismatch")
    return problems


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True, help="artifact output directory")
    parser.add_argument("--cache", type=Path, help="directory holding the pinned source files")
    parser.add_argument("--skip-download", action="store_true", help="fail instead of downloading missing sources")
    parser.add_argument("--verify", action="store_true", help="verify the artifact after conversion")
    parser.add_argument("--dump", action="store_true", help="print the operator list and exit")
    parser.add_argument("--force", action="store_true", help="convert even if the artifact is current")
    args = parser.parse_args(argv)

    pins = load_pins()
    cache = args.cache or default_cache_dir(pins)
    try:
        if args.dump:
            sources = ensure_sources(pins, cache, args.skip_download)
            model = tr.TfliteModel(sources["redact.tflite"].read_bytes())
            print("\n".join(graph_map.dump_ops(model)))
            return 0
        if not args.force and artifact_is_current(args.out, pins):
            print(f"pii-ner artifact in {args.out} is current")
        else:
            sources = ensure_sources(pins, cache, args.skip_download)
            manifest = convert(pins, sources, args.out)
            print(
                f"pii-ner artifact written to {args.out}: {manifest['model']['param_count']} parameters, "
                f"{manifest['config']['num_hidden_layers']} layers, attention scale {manifest['config']['attention_scale']}"
            )
            for note in manifest["notes"]:
                print(f"note: {note}")
        if args.verify:
            problems = verify_artifact(args.out, pins)
            if problems:
                for problem in problems:
                    print(f"verify: {problem}", file=sys.stderr)
                return 1
            print("verify: ok")
        return 0
    except (ConvertError, graph_map.GraphMapError, tr.FlatBufferError, OSError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
