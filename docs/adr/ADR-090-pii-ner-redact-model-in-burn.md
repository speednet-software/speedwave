# ADR-090: Neural PII Detection with the Redact Model Ported to burn

> **Status:** Accepted
> **Date:** 2026-09-15
> **Context:** Speedwave's PII protection was rule-based only (`crates/pii-engine`: regex rules from the policy, AES-SIV tokenization). Names, addresses and cities have no reliable regex. SPEED-521 evaluated Desert Ant Labs' Redact, an on-device multilingual token classifier for PII, and the team decided (Slack, 2026-09-14) to build a proof of concept that integrates the model itself rather than the vendor SDKs, keeping Speedwave's own tokenization.

## Decision

### The model, taken from the vendor's public weights

Redact is published on Hugging Face as `desert-ant-labs/redact`[^1]: `redact.tflite` (24 529 472 bytes), `tokenizer.json`, `labels.json` and `redact_meta.json`, tagged `v0.4.0`. It is a `BertForTokenClassification`[^2] with 6 layers, hidden size 384, 12 heads of 32, intermediate size 1536, a 31 475-entry XLM-R Unigram vocabulary[^3] and 89 BIOES classes over 22 entity labels (`GIVEN_NAME`, `SURNAME`, `EMAIL`, `PHONE`, `TAX_ID`, `GOVERNMENT_ID`, `CITY`, ...). All weight matrices are int8 with one symmetric scale per output row; biases, LayerNorm parameters and the pre-expanded position and token-type embeddings are float32. The vendor SDKs (Swift, Node) are not used: they bundle their own runtime, their placeholder scheme competes with `pii-engine` tokens, and they carry usage telemetry the license forbids tampering with.

The SHA-256 of every pinned file lives in `crates/pii-ner/tools/pins.json`; the Rust loader refuses an artifact whose recorded source hash differs from `crates/pii-ner/src/artifact/mod.rs::SOURCE_TFLITE_SHA256`.

### Conversion at build time, with the standard library only

`crates/pii-ner/tools/fetch_and_convert.py` (run by `make prepare-pii-ner-model`, a prerequisite of `build-tauri` and `dev`) downloads the pinned files, verifies them and reads the FlatBuffer[^4] directly with `tflite_reader.py`. `graph_map.py` recovers every parameter from graph topology, not from tensor names: Q/K/V by their position around the two `BATCH_MATMUL` ops, LayerNorm gamma/beta as the `MUL`/`ADD` constants after the `RSQRT` pattern, the attention scale as the scalar `MUL` constant (observed 1/sqrt(32)), GELU as exact. Two properties of the export are asserted, because the Rust model depends on them:

- linear layers read each LayerNorm before gamma/beta, which the exporter folded into their weights, while the residual stream carries the affine output;
- the last LayerNorm has no affine step of its own (folded into the classifier), so the converter emits identity parameters for it.

The output `desktop/src-tauri/pii-ner/` holds `redact-bert.safetensors`[^5] (int8 + scale per row for all matrices, float32 for the rest, HF BERT key names, about 23.5 MB), the vendor `tokenizer.json` byte for byte and `manifest.json` (format version, source hashes, observed configuration, labels, pipeline defaults). Fixtures for the end-to-end test are produced by `tools/gen_fixtures.py` from the original model through `ai-edge-litert`[^6]; the same script runs a numpy forward pass of the artifact against the original logits (argmax agreement 0.996 to 1.0, max probability difference below 0.05 on the reference texts).

### Inference in pure Rust with burn, GPU first, CPU fallback

`crates/pii-ner` (`speedwave-pii-ner`) reimplements the classifier with burn 0.21[^7]: `Embedding`, `Linear` and a custom split LayerNorm assembled into `BertTokenClassifier`, built directly from the dequantized tensors. Two backends compile into one crate: `NdArray<f32>` for the CPU and `Wgpu<f32, i32>`, which reaches Metal on macOS and Vulkan or DX12 on Windows through wgpu[^8]. `load_auto` probes for a GPU adapter on a helper thread and falls back to the CPU with a log line. Tokenization uses the `tokenizers` crate with the `fancy-regex` feature, so no C++ (`onig`, `esaxx`) enters the build[^9]. Offsets are UTF-8 bytes; the vendor uses UTF-16.

The pipeline follows the vendor's Swift `Pipeline.swift`: windows of 254 content tokens with a stride of 64, softmax and argmax, a 0.3 floor on tags, BIOES decoding, cross-window dedupe by best score, a 0.6 default threshold, same-label merge and snapping to word boundaries (`-`, `'`, `'` connectors). Deferred from the PoC: name hysteresis, gap bridging, particles, building-number and US street heuristics, ALL-CAPS title-casing and the vendor's deterministic regex layer (Speedwave's own rules cover that).

### Verification

- Unit tests without weights on both CI platforms (labels, windows, BIOES, merge, snapping with Polish text, dequantization, manifest and checksum errors, a tiny random BERT for padding and batch invariance, a full `Detector` on a synthetic artifact).
- `make test-pii-ner-model`: converts the pinned model and compares the burn port with the recorded tflite outputs per window (argmax agreement at least 0.98, probability tolerance 0.08) and the final spans byte for byte.
- `make bench-pii-ner ARGS="--device cpu|gpu"`: load time, first call (shader compilation on GPU), p50/p95 and windows per second.

### License

Redact is distributed under the Desert Ant Labs Source-Available License 1.0[^10]: free below 100 000 monthly active devices per platform and model, source available but not open source, embedding in an application allowed, standalone redistribution of the models not allowed, a visible "Powered by Desert Ant Labs" attribution required, no training of competing models on outputs, audit rights, Dutch law. Speedwave therefore ships the converted artifact only inside the Desktop bundle (never as a separate download), keeps the license text in `desktop/src-tauri/licenses-static/redact-model-LICENSE` (copied into `THIRD-PARTY-LICENSES/` by `make bundle-static-licenses`) and records the attribution obligation here. The legal review of the license is with the product owner; the placement of the attribution line in the UI is decided after it.

## Alternatives rejected

- **Vendor SDKs (Swift, Node)** and the raw LiteRT runtime through C bindings: a second inference runtime in the product, no GPU path we control, telemetry we may not disable, and placeholder text that would have to be undone before `pii-engine` tokenization.
- **ONNX Runtime (`ort`)**: needs a converted ONNX graph and a prebuilt C++ runtime per platform (the sherpa-onnx removal in ADR-075 was the last CRT workaround of that kind).
- **candle**: Metal and CUDA only, no Vulkan or DX12 for Windows without an NVIDIA card.
- **Re-quantizing in Rust or unfolding gamma/beta into float weights**: loses the vendor's exact int8 values; the artifact keeps them and dequantizes at load.

## Consequences

- The Desktop build grows by burn, cubecl and wgpu, and by about 25 MB of model artifact; the proxy image is unchanged (it only calls the host, ADR-091). Root `make check-clippy` compiles `speedwave-pii-ner`.
- Python 3 (standard library) becomes a build prerequisite for the Desktop bundle on both platforms; the CI bundle action runs the converter before `verify-bundled-assets`.
- A new Redact release means: update `pins.json`, rerun the converter, regenerate fixtures, re-check the two graph invariants (the converter fails loudly if the export layout changed), and bump `SOURCE_TFLITE_SHA256`.
- CI runners have no GPU: the wgpu path is exercised only by the bench on developer machines.

[^1]: https://huggingface.co/desert-ant-labs/redact

[^2]: https://huggingface.co/docs/transformers/model_doc/bert#transformers.BertForTokenClassification

[^3]: https://arxiv.org/abs/1911.02116

[^4]: https://github.com/google-ai-edge/LiteRT

[^5]: https://github.com/huggingface/safetensors

[^6]: https://pypi.org/project/ai-edge-litert/

[^7]: https://github.com/tracel-ai/burn

[^8]: https://github.com/gfx-rs/wgpu

[^9]: https://github.com/huggingface/tokenizers/tree/main/tokenizers

[^10]: https://license.desertant.com/
