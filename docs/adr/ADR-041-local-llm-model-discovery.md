# ADR-041: Local LLM Model Discovery and SSRF Policy

**Status:** Accepted
**Date:** 2026-04-20

## Context

After ADR-040 removed the LiteLLM proxy and wired Claude Code directly to a local LLM server (`ollama`, `lmstudio`, or `llamacpp`), a UX failure surfaced during integration testing: `llama.cpp` silently ignores the `model` field in an Anthropic `/v1/messages` request and answers with whatever model the user loaded at server startup.[^15] If the user typed a model name in Settings that did not match the server's loaded model, requests still went through — on the wrong model, with no visible error. Chat UI appeared to hang while a 35 B reasoning model ran; the session_stats field showed a model name the user never asked for.

At the same time, the Settings save path (`containers_cmd::update_llm_config`) validated only URL syntax (scheme, no path, no query). A user could save `http://169.254.169.254` and Speedwave would render it into `ANTHROPIC_BASE_URL` on the claude container, causing every Claude Code request to hit the cloud metadata endpoint — a textbook SSRF primitive.[^11][^16]

Both problems had one solution in common: query the server's advertised model list, and apply a uniform SSRF policy to both the discovery probe and the save path.

## Decision

Add a Tauri command `discover_llm_models(provider, base_url) -> Vec<DiscoveredModel>` that probes the local LLM server and returns the list of available models, so Settings can render a `<select>` instead of a free-text input. Introduce a shared URL validator `validate_llm_base_url` used by **both** the discovery command and `update_llm_config`. The validator follows the existing Redmine pattern (`validate_redmine_host_url`[^18]) but allows loopback — required because Speedwave's `default_base_url` for every local provider uses `host.docker.internal`, which the Desktop host-side code rewrites to `127.0.0.1` before probing.

**Single SSRF policy, two callsites:**

| Address class                            | Policy      | Rationale                                                                         |
| ---------------------------------------- | ----------- | --------------------------------------------------------------------------------- |
| Loopback (127.0.0.0/8, ::1)              | Allow, warn | `default_base_url` resolves here after container-alias rewrite                    |
| RFC 1918 private (IPv4)[^3]              | Allow, warn | LAN LLM servers, self-hosted Ollama on a private address                          |
| RFC 6598 CGNAT (100.64.0.0/10)[^7]       | Allow, warn | Tailscale / carrier NAT shared address space; functionally equivalent to RFC 1918 |
| IPv6 ULA (`fc00::/7`, RFC 4193)[^4]      | Allow, warn | Same rationale as RFC 1918 for IPv6 networks                                      |
| Link-local (169.254.0.0/16, `fe80::/10`) | Block       | Cloud metadata endpoints[^11][^12] live here; never a legitimate LLM host         |
| RFC 5737 TEST-NET[^5], RFC 2544[^6]      | Block       | Reserved documentation/benchmarking ranges                                        |
| RFC 3849 IPv6 documentation prefix[^8]   | Block       | Reserved documentation range                                                      |
| RFC 6666 IPv6 discard prefix[^9]         | Block       | Reserved                                                                          |
| Multicast, unspecified (`0.0.0.0`, `::`) | Block       | Not valid HTTP destinations                                                       |
| Public IP / public domain                | Allow, warn | User-written URL is user's threat; same as Redmine                                |
| `http://` scheme on private address      | Allow, warn | Local LAN; cleartext on loopback/RFC1918 is acceptable                            |
| Embedded credentials (`user:pass@`)      | Block       | Credentials do not belong in base URLs                                            |
| Query string / fragment                  | Block       | LLM endpoints are canonical paths                                                 |
| Non-`http`/`https` scheme                | Block       | `file://`, `javascript:`, `ssh://`, `ftp://`, `data:` all rejected                |

IPv6-mapped IPv4 bypasses (`::ffff:169.254.169.254`) are handled by the underlying `url_validation::validate_url`, which checks `Ipv6Addr::to_ipv4_mapped()` against the same classifier.[^16]

**Layered HTTP hardening for the discovery probe:**

1. `reqwest::ClientBuilder::redirect(Policy::none())`[^1] — prevents `302 Location: http://169.254.169.254/` bypass.
2. 5-second request timeout[^2] — a stuck model load should fall back to the free-text input, not freeze Settings.
3. Response body capped at 5 MiB via `http_util::read_body_limited` (shared with Redmine) — prevents OOM from a hostile endpoint.
4. Case-insensitive prefix check on `Content-Type`: `text/html` responses are rejected (user pointed at Grafana/a 404 page instead of an LLM server).

**Endpoint selection:**

- `ollama` → `GET {base}/api/tags`[^13] for the id list, then a parallel fan-out of `POST {base}/api/show` per id to read `model_info.<arch>.context_length` (falls back to the first numeric `*.context_length` field for unrecognised archs). Individual `/api/show` failures degrade silently — the model still appears in the list, but with `context_tokens: None`.
- `lmstudio` → `GET {base}/api/v0/models`[^14] (extended listing carrying `max_context_length` per entry). The previous OpenAI-compat `/v1/models` fallback was removed: id-only listings forced a second round-trip and a duplicate parser without delivering the per-model context window the UI now consumes.
- `llamacpp` → `GET {base}/v1/models`[^15] reading `meta.n_ctx_train` per entry. The runtime `--ctx-size` flag may constrain the live limit lower (visible via `/props`); we report the trained value as the best-available approximation rather than racing a slot-config change.

The Tauri command signature is `discover_llm_models(provider, base_url) -> Vec<DiscoveredModel>` where `DiscoveredModel = { id: String, context_tokens: Option<u32> }`. `context_tokens` stays `None` when the provider does not advertise a window — the chat fallback chain takes over rather than guessing. Empty model lists return `Err("empty")` so the UI falls back to the free-text input. A `404` (or any other non-2xx response) triggers the same graceful fallback. Discovered models with empty `id` strings are dropped before the response is returned.

**Container-host alias rewrite.** The `host.*.internal` aliases injected into `extra_hosts` (`compose.template.yml`) do not resolve from the Desktop host process — Speedwave does not bundle Docker Desktop, so Docker's /etc/hosts injection does not happen. A new helper `speedwave_runtime::compose::rewrite_container_alias_to_loopback` rewrites `host.docker.internal`, `host.lima.internal`, `host.containers.internal`, `host.speedwave.internal` to `127.0.0.1` before the probe. All four aliases live in a single `CONTAINER_HOST_ALIASES` constant composed from the existing per-platform `LIMA_HOST`, `NERDCTL_LINUX_HOST`, `WSL_HOST`, `CONTAINERS_HOST` named consts — one SSOT.

**Delta vs Redmine policy.** Two differences between `validate_redmine_host_url` (ADR sibling documented at[^18]) and the new `validate_llm_base_url`:

1. **Loopback** — `AllowLoopback` for LLM (default base URLs resolve to 127.0.0.1), `BlockLoopback` for Redmine (a self-hosted Redmine on 127.0.0.1 is an unusual config likely to indicate a mistake). Implemented via `PrivatePolicy::{BlockLoopback, AllowLoopback}` on the shared helper.
2. **CGNAT (100.64.0.0/10)** — classified as on-premise for **both** paths. Previously the Redmine-local `is_private_on_premise` used `ipv4.is_private()` which covers only RFC 1918, so CGNAT fell through to `validate_url` → `is_private_or_reserved` → rejected. The new shared helper explicitly accepts CGNAT because it is non-routable on the public internet and legitimate for Tailscale-hosted instances.

## Consequences

### Positive

- Silent model-name mismatch bug eliminated at the UX layer: the select cannot contain a name the server doesn't know.
- Save path gains SSRF protection symmetric to the discovery probe. Historical configs containing `http://169.254.169.254` log a warning on load and are rejected on the next save.
- `is_private_on_premise` logic consolidated — Redmine and LLM discovery share one policy function; a future tightening (e.g. new IPv6 bypass) automatically reaches both.
- `read_body_limited` + `MAX_RESPONSE_BODY_BYTES` extracted to `http_util.rs` (Rule of Three — second concrete consumer).

### Neutral

- ~400 new lines of Rust code + ~100 lines of Angular. Largely test harness (53 Rust unit/integration tests in `llm_cmd` + 16 policy-branch tests in `url_validation` + 9 save-path tests in `containers_cmd` + 10 Angular tests + 8 alias / template guards).
- Frontend adds a discriminated-union `DiscoveryState` with a monotonic counter for stale-response discard. Replaces an earlier design that used 5 loose booleans — fewer invariants to reason about.

### Negative (residual risks, accepted)

1. **DNS rebinding in the discovery probe.** `Policy::none()` eliminates the redirect vector, but a user-written hostname (`http://attacker.example.com`) whose DNS returns a public IP on first resolve and `169.254.169.254` on a subsequent connect can still bypass the IP classifier. Mitigations: (a) discovery output is a typed `Vec<String>` rendered as `<option>` text — attacker cannot pivot from reading an internal service, (b) user-initiated only (per click/blur), (c) 5-second total request timeout.[^17] We explicitly do not use `reqwest::ClientBuilder::resolve()` pre-resolve — that mitigation is architecturally partial (redirect + idle-connection reconnect + IDN re-lookup all reintroduce the race) and gives a false sense of immunity.

2. **Save-path public-domain SSRF.** A user can save `http://my-ollama.company.com` whose DNS later resolves to `169.254.169.254`. Every Claude Code request would then hit metadata. Decision: this is user-originated input; we apply the same threat model as Redmine (`validate_redmine_host_url` accepts public domains).[^18] If a future codepath adds a way for an attacker to inject URLs into the config without user consent, this decision must be revisited.

3. **Rust-style constraint.** The SSRF policy lives in `desktop/src-tauri/src/url_validation.rs`, not in `speedwave-runtime`. Runtime is pure Rust with no Tauri coupling (per `.claude/rules/rust-style.md`) — networking policy must not leak there. The host-alias rewrite helper lives in runtime because it is a pure string→string mapping (no I/O, no policy).

## Known Limitations

- Discovery does not cache results. Every trigger re-probes. Localhost is fast enough; over a LAN the latency is bounded by the 5-second timeout.
- Discovery does not validate that the chosen model actually serves Anthropic-compatible `/v1/messages`. Upstream compatibility errors surface only on the first chat message.
- `rustls-tls` uses bundled CA roots, inherited from Redmine[^18]. Corporate users with custom CAs may see TLS errors on public-domain HTTPS endpoints.

## References

[^1]: reqwest `redirect::Policy` — https://docs.rs/reqwest/latest/reqwest/redirect/enum.Policy.html

[^2]: reqwest `ClientBuilder::timeout` — https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html#method.timeout

[^3]: RFC 1918 — "Address Allocation for Private Internets" — https://www.rfc-editor.org/rfc/rfc1918

[^4]: RFC 4193 — "Unique Local IPv6 Unicast Addresses" — https://www.rfc-editor.org/rfc/rfc4193

[^5]: RFC 5737 — "IPv4 Address Blocks Reserved for Documentation" — https://www.rfc-editor.org/rfc/rfc5737

[^6]: RFC 2544 — "Benchmarking Methodology for Network Interconnect Devices" — https://www.rfc-editor.org/rfc/rfc2544

[^7]: RFC 6598 — "IANA-Reserved IPv4 Prefix for Shared Address Space" (CGNAT) — https://www.rfc-editor.org/rfc/rfc6598

[^8]: RFC 3849 — "IPv6 Address Prefix Reserved for Documentation" — https://www.rfc-editor.org/rfc/rfc3849

[^9]: RFC 6666 — "A Discard Prefix for IPv6" — https://www.rfc-editor.org/rfc/rfc6666

[^10]: RFC 1122 — "Requirements for Internet Hosts" (incl. 0.0.0.0/8 "this host") — https://www.rfc-editor.org/rfc/rfc1122

[^11]: AWS EC2 Instance Metadata Service — https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-service.html

[^12]: Google Cloud Metadata server — https://cloud.google.com/compute/docs/metadata/overview

[^13]: Ollama API — `/api/tags` list local models — https://github.com/ollama/ollama/blob/main/docs/api.md#list-local-models

[^14]: LM Studio — REST API (extended `/api/v0/models` listing with `max_context_length`) — https://lmstudio.ai/docs/app/api/endpoints/rest

[^15]: llama.cpp — HTTP server — https://github.com/ggml-org/llama.cpp/tree/master/examples/server

[^16]: OWASP — Server-Side Request Forgery Prevention Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

[^17]: OWASP — DNS Rebinding — https://owasp.org/www-community/attacks/DNS_rebinding

[^18]: Speedwave Redmine SSRF policy — `../architecture/security.md#redmine-api-proxy-commands`

[^19]: ADR-040 — Remove LiteLLM, direct provider injection — `./ADR-040-remove-litellm-direct-provider-injection.md`
