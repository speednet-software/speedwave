# ADR-090: MDM-managed LLM egress — the organisation's gateway as the only AI route

**Status:** Proposed

**Date:** 2026-10-05

## Context

Organisations increasingly put an LLM gateway between developers and the model provider: the provider credential stays server-side, usage is attributed per developer or team, budgets and rate limits are enforced in one place and every request can be audit-logged.[^1] Claude Code supports this through `ANTHROPIC_BASE_URL` plus a gateway credential, distributed with managed settings.[^1]

Inside Speedwave that variable is not the organisation's to set. Claude Code runs in the project's container and its `ANTHROPIC_BASE_URL` always points at the per-project proxy (ADR-073), which scans for PII, logs usage and forwards to the provider. Anthropic's server-managed settings do not reach it either: they are bypassed for any non-default `ANTHROPIC_BASE_URL`.[^2] An organisation that wants every Speedwave request to go through its gateway therefore needs a Speedwave-level policy, and the person at the machine must not be able to pick another provider or route around it.

ADR-076 established the channel for organisation-forced policy (`managed-config.json`, fail-closed, presence is the lock, a native `managed-settings.json` mounted `:ro` as the hard control). This ADR reuses it.

## Decision

**An `llm_egress` block in `managed-config.json` makes the organisation's gateway the only AI route of the machine.** Its fields (`ManagedLlmEgressConfig` in `crates/speedwave-runtime/src/config.rs`):

- `anthropic_base_url` (required) — the proxy's `anthropic` route forwards to `{base}/v1/messages` instead of `api.anthropic.com` (`compose::proxy::render_proxy_config_with`). It passes the shared SSRF validator with the policy the OTLP collector uses (`validate_collector_url`, `AllowLoopback`).
- `headers` — headers the proxy adds to every forwarded request: the gateway credential. Hop-by-hop, framing, `anthropic-version` and the proxy's own caller-auth header are refused.
- `project_header` — a header the proxy sets to the project name, so the gateway can attribute usage to a project.
- `claude_env` — model selection locked in the container (`ANTHROPIC_MODEL`, the `ANTHROPIC_DEFAULT_*_MODEL` family, `ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`; `consts::LLM_EGRESS_LOCKABLE_ENV`). Any other key is refused: a credential or a runtime switch never comes from this block.
- `ca_certs` — PEM certificates trusted for the gateway on top of the built-in roots, for a gateway behind the organisation's internal PKI: the proxy's forward client adds them as roots[^3], Claude Code in the container gets them through `NODE_EXTRA_CA_CERTS`[^4][^5] (its telemetry goes to the gateway directly), and the desktop's gateway client adds them too.

**The credential never enters the container.** Under the policy the proxy's Anthropic route uses a `gateway` auth mode: it drops the inbound `authorization` and `x-api-key`, keeps `anthropic-beta`, `anthropic-version` and `content-type`, and adds the policy's `headers` (`containers/proxy/src/forward.rs`). Claude Code in the container carries only the placeholder bearer the local-model route already uses (`compose::llm::NO_KEY_AUTH_TOKEN`), so it needs no sign-in and holds nothing of value.

**Presence is the lock.** While the block is present:

- only the Anthropic route is rendered, through the proxy (`lock_llm_to_policy` drops other providers and clears `proxy_enabled`), and the managed settings pin `ANTHROPIC_BASE_URL` to the proxy, so neither process env nor the container's user-writable `settings.json` points Claude Code elsewhere;
- every project adopts the organisation's route; the LLM provider settings are read-only, and the desktop and CLI refuse sign-in, sign-out, key entry and provider changes (`config::LLM_ROUTE_LOCKED_MSG`);
- no model is chosen on the machine: the policy's `ANTHROPIC_MODEL` applies; a model the person pins among those the gateway allows is passed as `--model`;
- telemetry names the project it came from (`speedwave.project` in `OTEL_RESOURCE_ATTRIBUTES`) — only under this policy.

**Invalid is fatal, at boot and at render.** `config::check_llm_egress_policy_at_boot` hard-stops Desktop and CLI on a block that fails `validate()`, like the telemetry and PII gates. Every render loads the policy fail-closed: an unreadable or invalid file stops the start instead of dropping the route.

**The Auditor integration.** The first gateway this is built with is Auditor (Speednet's AI governance product). On a managed machine the desktop asks Auditor, with the policy's headers, what it applies to the machine and each project — allowed models, the project's use case and compliance status, the deployment, the agent version (`desktop/src-tauri/src/auditor_cmd.rs`) — and shows it, marked with Auditor's logo, in the model selector, the chat header, the LLM provider settings and Integrations. Under the policy the gateway is the source of the composer's model rows (there is no signed-in account whose list Claude Code could report); every label still goes through `ModelPickerService.label`. This is display only: an unreachable Auditor changes nothing about where requests go.

## Consequences

- **Speedwave must understand the block before a machine gets it.** `managed-config.json` is strict (unknown keys are a hard error, ADR-076), so an older Speedwave refuses to start on a machine whose policy carries `llm_egress`. Roll out Speedwave first, then the policy.
- **The gateway credential sits in `managed-config.json` and the proxy config, not in the container.** Both are host files (the proxy config is `0o600` in the owner-only data dir); `ManagedLlmEgressConfig` and the proxy's `Route` print header names, never values, and `log_sanitizer` redacts `X-…-Token`/`-Key`/`-Secret` headers. A telemetry credential in the policy's `telemetry` block is still visible in the container, as ADR-076 accepted; a gateway should give telemetry its own, ingest-only credential.
- **Integrity is regenerate-on-render, as in ADR-076.** The proxy config, the managed settings and the CA bundle are re-rendered from the policy on every start; `fs_security` holds the CA bundle to `0o600`; `ManagedSettingsMount` and the claude volume profile accept the bundle only `:ro` from `<data_dir>/claude-managed/<project>/`.
- **Tests never read the machine's real policy.** `load_managed_config` returns `None` under `cfg(test)` and the runtime's `test-support` feature, which only dependents' dev-dependencies enable.
- **Future option.** Claude Code v2.1.285 can pin `allowedProviders` to a custom endpoint in managed settings,[^1] which would let the native layer refuse any other endpoint as well. In Speedwave that endpoint is the per-project proxy, so the pin would add defence in depth, not a new route; it is not part of this decision.

## Footnotes

[^1]: https://code.claude.com/docs/en/llm-gateway.md - Claude Code "Other LLM gateways": what a gateway provides (credentials, usage tracking, cost controls, audit logging, provider switching); roll-out through a managed settings file with `ANTHROPIC_BASE_URL` and a credential; `allowedProviders: ["customEndpoint"]` pins the gateway, requires Claude Code v2.1.285 or later.

[^2]: https://code.claude.com/docs/en/server-managed-settings.md - Claude Code server-managed settings are bypassed when a non-default `ANTHROPIC_BASE_URL` is configured; endpoint-managed settings (`managed-settings.json`) are the MDM alternative.

[^3]: https://docs.rs/reqwest/0.12.28/reqwest/struct.ClientBuilder.html#method.add_root_certificate - reqwest `ClientBuilder::add_root_certificate` adds a custom root; `tls_built_in_root_certs` defaults to `true`, so the built-in roots stay in use.

[^4]: https://code.claude.com/docs/en/network-config.md - Claude Code enterprise network configuration: a custom CA is trusted with `NODE_EXTRA_CA_CERTS=/path/to/ca-cert.pem`, on top of the bundled Mozilla set and the OS store.

[^5]: https://nodejs.org/api/cli.html#node_extra_ca_certsfile - Node.js `NODE_EXTRA_CA_CERTS`: extends the well-known root CAs with the certificates in the file, read at process startup.
