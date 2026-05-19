# ADR-062: Playwright host-gateway access via static extra_hosts

**Status:** Accepted

**Date:** 2026-05-19

**Updates:** [ADR-039](ADR-039-playwright-shared-browser-service.md) (supersedes the `--allowed-hosts mcp-hub` fragment in § Decision 2 — see [Decision](#decision) below).

## Context

The `mcp-playwright` worker is a built-in MCP server that exposes Microsoft's `@playwright/mcp` browser automation tooling to Claude and plugins.[^1] When ADR-039 introduced the worker, the use case framed in that ADR was "browser access to public URLs" — Chromium fetching arbitrary sites on behalf of Claude.

Subsequent product use cases have diverged from that framing:

- Plugin authors want to point Playwright at a Figma Desktop MCP endpoint (`http://127.0.0.1:3845`) on the host.
- Speedwave end users want to ask Claude to inspect their local dev server (`http://localhost:4200` for an Angular project, similar for Vite / Next.js).

Both cases require the `mcp-playwright` container to reach a service bound to the host's loopback interface. The mechanism that makes this work (Lima's catch-all port forwarder on macOS, WSL2 NAT/mirrored networking on Windows) was clarified in [PR #704](https://github.com/speednet-software/speedwave/pull/704)[^2] and lives in [`ide_bridge.rs`](https://github.com/speednet-software/speedwave/blob/dev/desktop/src-tauri/src/ide_bridge.rs) — but every other container that uses it (`claude`, `mcp-hub`, OAuth-consumer services) was already configured for that path, while `mcp-playwright` was not.

**The gap.** `mcp-playwright` lacks an `extra_hosts` entry resolving `host.docker.internal` to the platform gateway IP. Without it, Chromium inside the container fails name resolution and returns `ERR_NAME_NOT_RESOLVED`. The only workaround for a plugin author or user today is to hardcode the per-platform gateway IP (`192.168.5.2` on macOS, `192.168.65.1` on Windows) — duplicating SSOT data that already lives in [`consts.rs::LIMA_VZ_HOST_IP` / `WSL_HOST_IP`](https://github.com/speednet-software/speedwave/blob/dev/crates/speedwave-runtime/src/consts.rs)[^3] and breaking platform portability.

**Drift with ADR-039.** ADR-039 § Decision 2 documents `--allowed-hosts mcp-hub` for the Playwright Containerfile, justifying it as a defence against pivoting from a compromised plugin container to the browser service. The currently shipped [`mcp-servers/playwright/Containerfile`](https://github.com/speednet-software/speedwave/blob/dev/mcp-servers/playwright/Containerfile) uses `--allowed-hosts "*"` instead, with a multi-line comment explaining why (lines 75–90, 123):[^4] (a) the container exposes no published ports (enforced by `check_no_ports_on_workers` in `compose.rs`), so no browser can reach it; (b) any container on the compose network can set an arbitrary `Host` header and bypass the check in one line — the flag does not authenticate the caller; (c) real isolation comes from `cap_drop: ALL` + `read_only` + the network boundary, not from a string match. The behavioural divergence with ADR-039 is intentional and well-reasoned in code, but the ADR was never updated, so the corpus contains conflicting guidance.

## Decision

### 1 — Add `extra_hosts` statically to `mcp-playwright` in `compose.template.yml`

The `mcp-playwright:` service block declares:

```yaml
extra_hosts:
  - 'host.docker.internal:${HOST_GATEWAY}'
```

`${HOST_GATEWAY}` is substituted at render time by `compose::host_gateway_ip()` — `192.168.5.2` on macOS (Lima vzNAT static gateway), `192.168.65.1` on Windows (WSL2 NAT).[^3]

**Static placement (not dynamic via `ensure_host_gateway_extra_host()`).** `mcp-playwright` is a stable built-in worker — when present in compose at all, it always needs the alias. `apply_integrations_filter` (`compose.rs`) removes the entire `mcp-playwright:` block when the toggle is disabled, so the static `extra_hosts` entry never reaches a disabled worker. Dynamic injection makes sense for `mcp-hub` (which only needs the alias when OAuth-consumer services are present) and for OAuth-consumer services themselves (their presence depends on enabled integrations); neither condition applies here. The `claude` service in the same template uses the same static pattern.

### 2 — Update ADR-039 § Decision 2 to match shipped behaviour

ADR-039 § Decision 2 currently states `--allowed-hosts mcp-hub`. This ADR formally records that the shipped Containerfile uses `--allowed-hosts "*"`, with the threat-model justification embedded in the Containerfile comment.[^4] ADR-039 is not rewritten — it gains an `**Updated by:** ADR-062` header — but readers should treat that paragraph as superseded by the comment in the source file. The behaviour itself is unchanged by this ADR; only the documentation is brought into alignment with the code.

## Consequences

### Positive

- **Cross-platform plugin authoring.** Plugin Containerfiles and Speedwave projects can call `host.docker.internal:PORT` from Playwright without per-platform IP branches. The same code path works on macOS (Lima) and Windows (WSL2).
- **Documentation alignment with code.** The ADR-039 / Containerfile disagreement on `--allowed-hosts` is resolved in favour of the code, with the rationale captured in a single place.
- **Test coverage.** A new assertion in `test_render_compose_playwright_service_present` enforces the rendered-compose entry; an additional template guard catches removal of the line from `compose.template.yml`.

### Negative

- **Normalized access to host loopback for Playwright.** This change does not add a new low-level route to the host — every container on the project network already has IP-level reachability to the gateway, and Lima/WSL2 already forward gateway traffic to the host's loopback. What changes is that Playwright callers can now reach host-local services through a well-known canonical hostname instead of a per-platform IP. In a compromise scenario where an attacker controls Playwright, the practical attack ergonomics improve (`host.docker.internal:5432` vs `192.168.5.2:5432`), even though no new packet path is opened. The container's hardening profile (`cap_drop: ALL`, `read_only`, no `/tokens` mount, network bound to the project compose network, no published ports) is unchanged.
- **User expectation calibration.** Users running unauthenticated services on `127.0.0.1` (e.g. Postgres without password, a Redis with no `requirepass`, a dev server bound to loopback) must be aware that Playwright — and by extension Claude — can reach them under this alias. The "loopback is private" assumption is already invalidated by Lima/WSL2 catch-all forwarding for every Speedwave container; this ADR formalises it for Playwright specifically.

### Neutral

- **`--allowed-hosts "*"` is retained.** This ADR does not change Playwright's Host-header policy. The Containerfile comment[^4] explains why `mcp-hub` is not a useful pin in this deployment shape. If a future design adds a transport that depends on Host-header validation (e.g. WebSocket origin checks), that decision will land in a separate ADR.

## Alternatives considered

**A. Dynamic injection via `ensure_host_gateway_extra_host()`.** Rejected because it diverges from the static pattern used by `claude`, adds code with no benefit (no conditional presence), and complicates the test surface.

**B. Plugin manifest field (e.g. `host_access: { endpoints: [...] }`).** Considered for the broader "plugins reach host services" problem.[^5] Rejected for this ADR because (a) it requires a consent-flow UI, manifest schema change, and `PluginManifest` deserialisation work; (b) it does not solve the immediate Claude-Playwright case (Claude is not a plugin); (c) Playwright's `extra_hosts` is needed regardless of whether plugins eventually gain their own opt-in mechanism. Documented as a follow-up, not blocking.

**C. Allowlist URL/port validation inside Playwright tool calls.** Rejected — would require a wrapper around the upstream `@playwright/mcp` server,[^1] increase maintenance cost on every upstream version bump, and provide no defence against the genuine threats (a compromised Playwright container can still reach the gateway IP regardless of any aliasing).

**D. Disable Lima/WSL2 catch-all forwarder.** Rejected — would break IDE Bridge, host_exec, mcp-os, and OAuth workers, all of which depend on the same forwarder.[^6]

## Verification

- `cargo test --package speedwave-runtime --lib -- test_render_compose_playwright_service_present` — verifies the rendered compose contains `extra_hosts: ["host.docker.internal:<gateway-ip>"]` after `${HOST_GATEWAY}` substitution.
- `cargo test --package speedwave-runtime --lib -- mcp_playwright_section_has_extra_hosts_in_template` — guards the template against accidental removal of the entry.
- `cargo test --package speedwave-runtime --lib -- compose_template_extra_hosts_contains_only_canonical_alias` — pre-existing inverse guard ensuring no deprecated `host.lima.internal` / `host.containers.internal` / `host.speedwave.internal` aliases creep back in.
- `cargo test --package speedwave-runtime --lib -- test_apply_integrations_filter_disables_playwright` — pre-existing test confirming the entire `mcp-playwright:` block (including the new `extra_hosts`) is removed when the toggle is disabled.
- **Manual E2E (step 1, DNS + routing only).** On macOS: `python3 -m http.server 4200 --bind 127.0.0.1`; in Speedwave Desktop with Playwright enabled, ask Claude to `playwright_navigate http://host.docker.internal:4200` and take a screenshot. Expected: screenshot of the directory listing. Without this ADR's change: `ERR_NAME_NOT_RESOLVED`.
- **Manual E2E (step 2, framework dev server).** Repeat with `ng serve` (Angular) or `vite` (default bind 127.0.0.1). A failure at this step on a framework-specific `Host`-header policy is a framework concern, not a Speedwave one — step 1 isolates DNS and routing from application-layer host validation.

## References

[^1]: https://github.com/microsoft/playwright-mcp — Microsoft's official MCP server for Playwright browser automation; the upstream package bundled in `mcp-servers/playwright`.

[^2]: https://github.com/speednet-software/speedwave/pull/704 — PR documenting Lima/WSL2 catch-all forwarder mechanism for IDE Bridge; adds source-code comments and `docs/guides/ide-bridge.md` explanation.

[^3]: https://github.com/speednet-software/speedwave/blob/dev/crates/speedwave-runtime/src/consts.rs — `HOST_GATEWAY_ALIAS`, `LIMA_VZ_HOST_IP`, `WSL_HOST_IP` SSOT constants.

[^4]: https://github.com/speednet-software/speedwave/blob/dev/mcp-servers/playwright/Containerfile — `--allowed-hosts "*"` choice with embedded threat-model comment (lines 75–90, 123).

[^5]: https://github.com/speednet-software/speedwave/blob/dev/crates/speedwave-runtime/src/plugin.rs — `PluginManifest` schema; does not currently include a `host_access` or equivalent field.

[^6]: https://lima-vm.io/docs/config/port/ — Lima port-forwarding documentation; the default catch-all rule for non-privileged loopback ports is the mechanism this ADR relies on.
