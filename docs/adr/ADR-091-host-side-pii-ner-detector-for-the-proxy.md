# ADR-091: Host-Side PII NER Detector Serving the Proxy

> **Status:** Accepted
> **Date:** 2026-09-15
> **Context:** ADR-090 gives Speedwave a neural PII detector in pure Rust. It has to run where a GPU is reachable (the host), while PII tokenization has to stay where the per-project AES-SIV key lives (the proxy container, ADR-073). This ADR records how the two meet without moving the key or widening the container's mounts.

## Decision

### Inference on the host, sealing in the proxy

The Desktop app hosts the model in-process (`desktop/src-tauri/src/pii_ner_service.rs`) and exposes `POST /v1/detect` over plain HTTP on `host_bind_address()` (ADR-067). The proxy, before forwarding `/v1/messages`, sends the string leaves of each `messages[].content` (the order of `pii::collect_scan_leaves`) in one request and receives one span list per leaf: UTF-8 byte offsets, label, confidence. It then seals those spans with the existing engine (`pii-engine::scan_json_with_external`) under the same category-scoped tokens as rule hits. The key never leaves the container; the host sees request text, which it already saw as the user typed it.

HTTP rather than a `HostBridge`: the bridge skeleton is WebSocket-only and the exchange is one request, one reply. The service reuses the audited pieces of the skeleton instead of reimplementing them: `bind_with_retry` (EADDRNOTAVAIL re-detect), `load_or_create_persistent_token` (0600 UUID token), `constant_time_eq`, the Windows firewall `Once`, and the mirrored-relay lifecycle (ensure after bind, remove on stop, periodic re-ensure, ADR-080).

### Discovery through the lock schema the renderer already trusts

The service writes `<data_dir>/pii-ner.lock.json` in the host worker lock schema (`host_mcp_process::lock`, `LockService::PiiNer`) with its PID, port and token, and keeps it alive with a watchdog; the token persists in `<data_dir>/pii-ner-auth-token`, so a rendered config only changes when the port does. `compose::pii_ner::live_service_in` reads the lock and requires a live PID. `write_proxy_config_in` adds a `ner` section to `proxy.json` only then, and only when the project's switch (below) is on:

```json
"ner": {"url": "http://host.docker.internal:<port>", "token": "...", "min_confidence": 0.6, "labels": [...]}
```

The URL goes through `compose::container_facing_port`, so under WSL2 mirrored mode it names the guest relay port. No new mount: `proxy.json` already sits in the `config:ro` volume, and `SPW_CONFIG_DIGEST` covers it, so a port change recreates the proxy. Desktop's `reconcile_compose_port` now also compares `proxy.json` with the live detector (`compose::ner_url_state`) and treats a missing mcp-os lock as absent instead of returning early.

### Precedence, failure and audit

- Existing tokens win over rules, rules win over detector spans: a span is sealed only when it lies entirely inside text no rule and no earlier token claimed; overlapping spans keep the earliest, then the longest. Observation-mode categories from the policy count detector hits without sealing them.
- Default labels (`compose::DEFAULT_NER_LABELS`) omit `ORG`, `IMEI`, `URL` and `IP_ADDRESS`: routine technical content in a coding assistant, and tokenized URLs would break tool calls. The proxy filters by label and by `min_confidence` on top of the detector's own 0.6 pipeline threshold.
- An unavailable detector (503 while the model loads, timeout, malformed answer, wrong list count, oversized request above 4 MiB) degrades the request to rules only, logs at most once per minute and writes one `NER_UNAVAILABLE` / `passed` audit row with `source: "ner"`. Timeouts: 2 s connect, 15 s total, no redirects. A send that got no answer at all is repeated once before degrading, because `/v1/detect` is pure inference and the failures seen in practice were transport failures on the container-to-host hop under a burst of parallel sessions, not a detector that was down.
- Audit rows of sealed detector spans carry `source: "ner"`; rule rows are unchanged, so the hub's audit consumers see the same shape as before.

### What the detector is asked to look at

The detector sees the conversation, never the client's scaffolding. `messages[].content` is what a user typed, what a tool returned and what the assistant said: content, and the thing this feature exists to protect. `system` is written by the client (Claude Code, the Agent SDK) and is protocol — it must reach the provider byte for byte.

This boundary was learned the hard way. The first version treated both alike, and the detector reads "Claude" in "You are a Claude agent, built on Anthropic's Claude Agent SDK" as a `GIVEN_NAME` at 0.95 (0.74-1.00 across the preamble and in ordinary sentences). Every request therefore went upstream with a sealed preamble, and Anthropic rejected the OAuth leg with `rate_limit_error` and an empty message — which reads as an account limit and cost two days of looking in the wrong place. Measured on 2026-09-16, one session and one account: `GIVEN_NAME` in `ner.labels` gave 429 on every attempt, removing it gave 200 on every attempt, with `system` block 0 logged as sealed and unsealed respectively. The rule engine still scans `system`; its patterns match values (an e-mail, a PESEL), not words, so they leave the scaffolding intact.

The cost is accepted knowingly: identity that a user keeps in `CLAUDE.md` or in memory is injected into `system`, and the detector no longer sees it. Whether a never-seal term list (`Claude`, `Anthropic`, model names) should bring part of that back is a separate question, recorded for its own issue rather than settled here — it is needed for message text too, where sealing the assistant's own name confuses the agent.

Three filters sit in front of the round trip; all keep one slot per leaf, so the per-leaf answer still lands on the right string.

- Every `system` leaf is blanked, whole, per the boundary above.
- Leaves that are not prose are blanked: `type`, `id`, `tool_use_id`, `media_type`, `data`, `signature`, `url`, `file_id` (`pii::NON_PROSE_LEAF_KEYS`). The rule engine still scans them. Without this an attached image sends megabytes of base64 through the model — thousands of windows, or the 4 MiB cap, which would drop the whole request to rules only.
- Spans already detected for a text are cached in the proxy for the process lifetime, keyed by the text's length and two per-process randomly seeded hashes, so the cache holds offsets and never request text. Two generations bound it (2048 entries each, a hit promotes the entry back into the young one). A continued conversation therefore pays for its new leaves only, and a client that retries the same body — Claude Code backs off and retries through upstream 429s, dozens of times — pays once.
- One detector call at a time per proxy (`NerClient::gate`): the host serializes inference anyway, and the caller that waits usually finds its leaves already cached by the call ahead of it. The cache is re-read after the gate for exactly that reason.

### The switch, and who holds it

The detector is off until someone turns it on. Settings, Security carries one checkbox per project next to the policy list (`projects[].policy.ner` in the user config); an absent value is off, so an upgrade never starts sending conversation text to a host process on its own. The whole PII feature gate (ADR-058 beta, or any MDM-forced policy) still sits above it: with PII off, the switch resolves off.

An organization sets `pii_policy.ner_enabled` in `managed-config.json`. Presence is the lock, as everywhere in that file: `true` forces the detector on and enables the PII feature the way a forced policy id does, `false` is a kill-switch for an organization that does not want conversation text leaving the container at all, and an absent key leaves the choice with the user. The resolved pair (`pii_policy::resolve_pii_ner`) drives three things: the checkbox and its lock in Settings, the `ner` section of `proxy.json`, and whether the Desktop runs the detector service at all. The last one matters because loading the model costs memory and a GPU init: `apply_desired_state` starts the service when a project asks for it and stops it when the last one stops, at boot and on every Settings save. `reconcile_compose_port` reads the same resolved switch, so a project with the detector off reconciles against no detector instead of treating the live lock as a stale render.

### Security gates

- `SecurityRule::SpeedwaveProxyNerUrl`: a rendered `ner.url` must be exactly `http://<HOST_GATEWAY_ALIAS>:<port>` (no other host, scheme, path, query or userinfo); the proxy applies the same check when it loads `proxy.json` and exits on violation.
- The header name `x-speedwave-pii-ner-auth` is mirrored between `consts::PII_NER_AUTH_HEADER` and `containers/proxy/src/ner.rs::NER_AUTH_HEADER` by a cross-read test.
- The service's `/health` returns only `{"status":"ok"}`; `/v1/detect` answers 401 without the token, 413 above 8 MiB, 503 with `Retry-After` while loading or after a failed load. Inference is serialized on one blocking thread behind a bounded queue (32), so a burst cannot oversubscribe the CPU or the GPU.

## Out of scope

The hub (`mcp-hub`, Node, wasm engine) keeps rules only for now; tool results flowing through it are not sent to the detector. Extending it means a Node client of the same endpoint and `scan_json_with_external` exposed through `crates/pii-engine-wasm`.

## Consequences

- Every `/v1/messages` gains one host round trip before forwarding, carrying the `messages[].content` leaves that are new to this proxy. The CPU budget for a long conversation (about 100 KB of text, several hundred windows) is measured with `make bench-pii-ner`; that full price is paid on a session's first turn, after which the cache leaves only the new message.
- The cache is per proxy process: restarting the project's containers re-detects the conversation from scratch.
- Request text now leaves the proxy container to a second process on the same machine. It is the user's own machine and the same text the Desktop UI displayed; the gate above pins the destination to the host gateway.
- The CLI (`speedwave`) never starts the service: exactly one supervisor, the Desktop app, as for mcp-os and oauth. A CLI-only session renders `proxy.json` without `ner` and keeps rule-based protection.
