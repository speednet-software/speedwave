# ADR-041: Local LLM Model Discovery and SSRF Policy

> **Status:** Accepted
> **Context:** After ADR-040 wired Claude Code directly to a local LLM server, users could type a model name the server didn't actually have loaded (silent wrong-model answers), and the Settings save path validated only URL syntax — letting a user save a cloud-metadata IP into `ANTHROPIC_BASE_URL`, an SSRF primitive.

## Decision

Add a Tauri command `discover_llm_models` that probes the configured local LLM server and returns its advertised model list, so Settings renders a `<select>` instead of free text. Both the discovery probe and the config save path share one SSRF-aware URL validator, so a metadata-endpoint or malformed URL is rejected uniformly. Discovery never guesses a context window — when the server doesn't advertise one, the value stays `None` and the UI hides the used/max ratio rather than fabricating it.

## Why

- Eliminates the silent model-name mismatch: a `<select>` cannot hold a model the server doesn't know.
- Symmetric SSRF guard: the save path and the discovery probe run the same classifier, so a config containing a link-local / metadata address is rejected on both.
- Loopback is intentionally allowed for LLM discovery (the default base URL resolves to `127.0.0.1` after alias rewrite) but blocked for Redmine — a self-hosted Redmine on loopback is almost always a mistake. Both share one `PrivatePolicy`-parameterised classifier, so a future tightening reaches both at once.

## Address policy (single classifier, two callsites)

- **Allow (with warn):** loopback (LLM only), RFC 1918 private, RFC 6598 CGNAT (Tailscale / carrier NAT), IPv6 ULA (`fc00::/7`), public IP / public domain (user-written URL is the user's own threat surface), and cleartext `http://` on private addresses.
- **Block:** link-local / cloud metadata (`169.254.0.0/16`, `fe80::/10`), RFC 5737 / RFC 2544 / RFC 3849 / RFC 6666 reserved ranges, unspecified (`0.0.0.0`, `::`), embedded `user:pass@` credentials, query strings / fragments, and any non-`http(s)` scheme (`file:`, `javascript:`, `ssh:`, `ftp:`, `data:`). IPv6-mapped IPv4 bypasses (e.g. `::ffff:169.254.169.254`) are caught by mapping back to the v4 classifier.

## Probe behavior

- Unified `discover_local` path: one `GET /v1/models` request returns the model list; the per-model context window is read inline from `meta.n_ctx_train` (llama.cpp / vLLM / Unsloth shape) or `max_context_length` (LM Studio). If an entry lacks inline metadata, a single `POST /api/show` sanity call decides whether to fan out (Ollama) or leave the rest as `None`. Legacy `ollama` / `lmstudio` / `llamacpp` provider names still route through this path for two release cycles.
- A `POST /v1/messages` 1-token sanity probe detects whether the server implements the Anthropic Messages endpoint: 200 or 4xx (other than 404/405) means present, 404/405 means missing, transport error means unknown. No OPTIONS preflight — local servers often answer 405 to OPTIONS even when the endpoint exists.
- All HTTP calls (model list, `/api/show`, and the `/v1/messages` sanity probe) share **one** request timeout — `DISCOVERY_TIMEOUT_SECS = 5` — passed once into the transport. There is no separate per-request 3-second timeout.
- Host-side hardening: no redirects (`Policy::none()`, blocks a `302` to a metadata IP), response body capped at 5 MiB, and `text/html` responses rejected (user pointed at a 404 page or dashboard instead of an LLM server). Empty model lists and any non-2xx response fall back to the free-text input; models with empty `id` strings are dropped.

## Where it lives in code

- Discovery command, transport, probes, and the LLM-specific URL guard `validate_llm_base_url` — `desktop/src-tauri/src/llm_cmd.rs` (`do_discover_llm_models`, `discover_local`, `probe_messages_endpoint`, `normalize_and_validate_discovery_url`).
- Shared SSRF classifier (`is_private_on_premise`, `PrivatePolicy::{AllowLoopback, BlockLoopback}`, `validate_url`) — `crates/speedwave-runtime/src/url_validation.rs`. Hoisted into the runtime crate (ADR-069) so plugin-manifest OAuth-URL validation and the host-side Tauri commands share one SSOT; `desktop/src-tauri/src/url_validation.rs` re-exports it. The classifier is pure URL/IP policy with no Tauri or networking dependency, so it lives cleanly in the runtime crate. The LLM-specific wrapper `validate_llm_base_url` stays in `llm_cmd.rs`.
- Body-size cap and shared HTTP helpers (`read_body_limited`, `MAX_RESPONSE_BODY_BYTES = 5 MiB`) — `desktop/src-tauri/src/http_util.rs`.
- Container-host alias rewrite (`rewrite_container_alias_to_loopback`, maps `host.docker.internal` → `127.0.0.1` before probing) — `desktop/src-tauri/src/http_util.rs`. It is a pure string→string mapping in the Desktop crate; the canonical alias itself is the SSOT `consts::HOST_GATEWAY_ALIAS` in `crates/speedwave-runtime/src/consts.rs`.
- Save-path enforcement (calls `validate_llm_base_url` before writing the base URL) — `desktop/src-tauri/src/containers_cmd.rs`.

## Residual risks (accepted)

- **DNS rebinding** in the discovery probe: a hostname that resolves public first and metadata on a later connect can bypass the IP classifier. Mitigations: discovery output is only rendered as `<option>` text (no internal-service exfil pivot), it is user-initiated only, and the request timeout bounds the window. `reqwest`'s `resolve()` pre-resolve is deliberately NOT used — it is only architecturally partial (redirect, idle-connection reconnect, and IDN re-lookup all reintroduce the race) and would give a false sense of immunity.
- **Save-path public-domain SSRF:** a user can save a public hostname that later resolves to a metadata IP. This is treated as user-originated input, the same threat model as Redmine. If a future codepath ever lets an attacker inject URLs into config without explicit user action, this decision must be revisited.
- Discovery does not cache — every trigger re-probes (localhost is fast; LAN is bounded by the timeout). TLS uses `rustls-tls` with bundled CA roots (inherited from Redmine), so corporate custom CAs may fail on public HTTPS endpoints. Ollama doesn't implement `count_tokens`, so Claude Code's token counts can be approximate (tracked at [ollama/ollama#13949](https://github.com/ollama/ollama/issues/13949)).

## References

- ADR-040 — Remove LiteLLM, direct provider injection — `./ADR-040-remove-litellm-direct-provider-injection.md`
- Redmine SSRF policy (sibling pattern) — `../architecture/security.md#redmine-api-proxy-commands`
- OWASP — Server-Side Request Forgery Prevention — https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
