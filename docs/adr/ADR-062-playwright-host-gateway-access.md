# ADR-062: Playwright host-gateway access via static extra_hosts

> **Status:** Accepted (updates [ADR-039](ADR-039-playwright-shared-browser-service.md))
> **Context:** The built-in `mcp-playwright` worker could not reach host-loopback services (a local dev server, a host-side MCP endpoint) because it lacked the `host.docker.internal` alias every other container already had.

## Decision

Give `mcp-playwright` a static `extra_hosts` entry mapping `host.docker.internal` to the platform gateway IP in `containers/compose.template.yml`, exactly like the `claude` service. The same edit formally records that the shipped Playwright Containerfile launches with `--allowed-hosts "*"` (not the `mcp-hub` value ADR-039 originally documented).

## Why

- Plugin authors and end users want Claude-driven Playwright to inspect a host-bound dev server (e.g. an Angular app on `host.docker.internal:4200`) or a host-side MCP endpoint. Without the alias, Chromium fails name resolution with `ERR_NAME_NOT_RESOLVED`.
- The only prior workaround was hardcoding the per-platform gateway IP, which breaks portability: on macOS the gateway is the Lima vzNAT static `192.168.5.2`, but on Windows it is discovered at runtime from the WSL default route and is not a fixed value.
- The canonical alias keeps plugin Containerfiles and project configs free of per-platform IP branches.
- ADR-039 § Decision 2 claimed `--allowed-hosts mcp-hub`; the code shipped `--allowed-hosts "*"`. This ADR resolves that drift in favour of the code: built-in workers publish no ports (enforced in compose), and any container already on the compose network can forge a `Host` header, so a hostname pin authenticates nothing. Real isolation comes from `cap_drop: ALL`, `read_only`, and the network boundary.

## Where it lives in code

- Static `extra_hosts` entry on `mcp-playwright` — `containers/compose.template.yml` (the `${HOST_GATEWAY}` placeholder, mirroring the `claude` service)
- Host gateway alias constant — `crates/speedwave-runtime/src/consts.rs` (`HOST_GATEWAY_ALIAS`)
- macOS gateway IP (static Lima vzNAT) — `crates/speedwave-runtime/src/consts.rs` (`LIMA_VZ_HOST_IP`)
- Windows gateway IP (detected at runtime from the WSL default route, no compile-time constant) — `crates/speedwave-runtime/src/compose.rs` (`host_addressing_impls::WslDetector::detect_wsl_gateway_ip` / `parse_default_route_gateway`); see [ADR-067](ADR-067-host-addressing-ssot-windows-wsl2-mirrored.md)
- `${HOST_GATEWAY}` substitution at render time — `crates/speedwave-runtime/src/compose.rs` (`host_gateway_ip`, reading `host_addressing`)
- Toggle-off removes the whole `mcp-playwright` block (including the new entry) — `crates/speedwave-runtime/src/compose.rs` (`apply_integrations_filter`)
- `--allowed-hosts "*"` choice with the threat-model rationale in comments — `mcp-servers/playwright/Containerfile`
- Tests — `crates/speedwave-runtime/src/compose.rs`: `test_render_compose_playwright_service_present`, `mcp_playwright_section_has_extra_hosts_in_template`, `compose_template_extra_hosts_contains_only_canonical_alias`, `test_apply_integrations_filter_disables_playwright`

## Consequences

- No new low-level route to the host is opened — every container on the project network already reaches the gateway, and Lima/WSL2 forward gateway traffic to host loopback. What changes is that Playwright can now use the canonical hostname instead of a per-platform IP, which improves attack ergonomics in a compromise scenario without adding a new packet path.
- Users running unauthenticated services on `127.0.0.1` (passwordless Postgres, a Redis with no `requirepass`, a loopback dev server) must know Playwright — and thus Claude — can reach them via this alias. The "loopback is private" assumption was already invalidated by Lima/WSL2 forwarding for every Speedwave container; this only formalises it for Playwright.

## Rejected alternatives

- **Dynamic injection via `ensure_host_gateway_extra_host()`.** Used for `mcp-hub` and OAuth-consumer services because their presence is conditional. Rejected here: `mcp-playwright` always needs the alias when present, so the static `claude`-style pattern is simpler and keeps the test surface smaller.
- **A plugin manifest field for host access (e.g. an endpoint allowlist).** Rejected for this ADR: it needs a consent-flow UI and manifest schema work, and does not cover the Claude-driven case (Claude is not a plugin). Left as a possible follow-up, not blocking.
- **Allowlist URL/port validation inside Playwright tool calls.** Rejected: would require wrapping the upstream [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) server, adding maintenance cost on every version bump, and gives no defence against the real threat (a compromised container can reach the gateway IP regardless of aliasing).
- **Disable the Lima/WSL2 catch-all forwarder.** Rejected: it would break IDE Bridge, host_exec, mcp-os, and OAuth workers, which all depend on the same forwarder.
