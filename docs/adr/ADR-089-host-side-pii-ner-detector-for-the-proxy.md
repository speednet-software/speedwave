# ADR-089: Host-Side PII NER Detector Serving the Proxy

> **Status:** Accepted
> **Date:** 2026-09-15
> **Context:** ADR-088 gives Speedwave a neural PII detector in pure Rust. It has to run where a GPU is reachable (the host), while PII tokenization has to stay where the per-project AES-SIV key lives (the proxy container, ADR-073). This ADR records how the two meet without moving the key or widening the container's mounts.

## Decision

### Inference on the host, sealing in the proxy

The Desktop app hosts the model in-process (`desktop/src-tauri/src/pii_ner_service.rs`) and exposes `POST /v1/detect` over plain HTTP on `host_bind_address()` (ADR-067). The proxy, before forwarding `/v1/messages`, sends every string leaf it is about to scan (`system`, then each `messages[].content`, the order of `pii::collect_scan_leaves`) in one request and receives one span list per leaf: UTF-8 byte offsets, label, confidence. It then seals those spans with the existing engine (`pii-engine::scan_json_with_external`) under the same category-scoped tokens as rule hits. The key never leaves the container; the host sees request text, which it already saw as the user typed it.

HTTP rather than a `HostBridge`: the bridge skeleton is WebSocket-only and the exchange is one request, one reply. The service reuses the audited pieces of the skeleton instead of reimplementing them: `bind_with_retry` (EADDRNOTAVAIL re-detect), `load_or_create_persistent_token` (0600 UUID token), `constant_time_eq`, the Windows firewall `Once`, and the mirrored-relay lifecycle (ensure after bind, remove on stop, periodic re-ensure, ADR-080).

### Discovery through the lock schema the renderer already trusts

The service writes `<data_dir>/pii-ner.lock.json` in the host worker lock schema (`host_mcp_process::lock`, `LockService::PiiNer`) with its PID, port and token, and keeps it alive with a watchdog; the token persists in `<data_dir>/pii-ner-auth-token`, so a rendered config only changes when the port does. `compose::pii_ner::live_service_in` reads the lock and requires a live PID. `write_proxy_config_in` adds a `ner` section to `proxy.json` only then:

```json
"ner": {"url": "http://host.docker.internal:<port>", "token": "...", "min_confidence": 0.6, "labels": [...], "required": false}
```

The URL goes through `compose::container_facing_port`, so under WSL2 mirrored mode it names the guest relay port. No new mount: `proxy.json` already sits in the `config:ro` volume, and `SPW_CONFIG_DIGEST` covers it, so a port change recreates the proxy. Desktop's `reconcile_compose_port` now also compares `proxy.json` with the live detector (`compose::ner_url_state`) and treats a missing mcp-os lock as absent instead of returning early.

### Precedence, failure and audit

- Existing tokens win over rules, rules win over detector spans: a span is sealed only when it lies entirely inside text no rule and no earlier token claimed; overlapping spans keep the earliest, then the longest. Observation-mode categories from the policy count detector hits without sealing them.
- Default labels (`compose::DEFAULT_NER_LABELS`) omit `ORG`, `IMEI`, `URL` and `IP_ADDRESS`: routine technical content in a coding assistant, and tokenized URLs would break tool calls. The proxy filters by label and by `min_confidence` on top of the detector's own 0.6 pipeline threshold.
- An unavailable detector (503 while the model loads, timeout, malformed answer, wrong list count, oversized request above 4 MiB) degrades the request to rules only, logs at most once per minute and writes one `NER_UNAVAILABLE` / `passed` audit row with `source: "ner"`; `ner.required: true` turns that into a 503 to the caller. Timeouts: 500 ms connect, 5 s total, no redirects.
- Audit rows of sealed detector spans carry `source: "ner"`; rule rows are unchanged, so the hub's audit consumers see the same shape as before.

### Security gates

- `SecurityRule::SpeedwaveProxyNerUrl`: a rendered `ner.url` must be exactly `http://<HOST_GATEWAY_ALIAS>:<port>` (no other host, scheme, path, query or userinfo); the proxy applies the same check when it loads `proxy.json` and exits on violation.
- The header name `x-speedwave-pii-ner-auth` is mirrored between `consts::PII_NER_AUTH_HEADER` and `containers/proxy/src/ner.rs::NER_AUTH_HEADER` by a cross-read test.
- The service's `/health` returns only `{"status":"ok"}`; `/v1/detect` answers 401 without the token, 413 above 8 MiB, 503 with `Retry-After` while loading or after a failed load. Inference is serialized on one blocking thread behind a bounded queue (32), so a burst cannot oversubscribe the CPU or the GPU.

## Out of scope

The hub (`mcp-hub`, Node, wasm engine) keeps rules only for now; tool results flowing through it are not sent to the detector. Extending it means a Node client of the same endpoint and `scan_json_with_external` exposed through `crates/pii-engine-wasm`.

## Consequences

- Every `/v1/messages` gains one host round trip before forwarding. The CPU budget for a long conversation (about 100 KB of text, several hundred windows) is measured with `make bench-pii-ner` before anyone sets `required: true`.
- Request text now leaves the proxy container to a second process on the same machine. It is the user's own machine and the same text the Desktop UI displayed; the gate above pins the destination to the host gateway.
- The CLI (`speedwave`) never starts the service: exactly one supervisor, the Desktop app, as for mcp-os and oauth. A CLI-only session renders `proxy.json` without `ner` and keeps rule-based protection.
