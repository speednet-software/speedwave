# ADR-076: MDM-enforceable OTLP Telemetry

**Status:** Accepted

**Date:** 2026-07-04

## Context

Claude Code has a built-in OpenTelemetry (OTLP) exporter driven by environment variables: `CLAUDE_CODE_ENABLE_TELEMETRY` turns it on, `OTEL_EXPORTER_OTLP_ENDPOINT` + exporter/protocol vars route it, and `OTEL_EXPORTER_OTLP_HEADERS` authenticates it.[^1] Speedwave previously only injected `CLAUDE_CODE_ENABLE_TELEMETRY=0` as a compiled default, with no way to configure a collector.

Two capabilities were wanted:

1. **User self-service** — a user points the in-container Claude Code at their own OTLP collector from Settings.
2. **Organization enforcement** — an organization pushes a policy the user **cannot bypass**: force telemetry on/off, force the endpoint, force the privacy gates off.

The hard part is (2). A threat-model pass found that a user could override any Speedwave-forced env var by adding the same key to `claude.env` in `~/.speedwave/config.json` — the user config is the last, unfiltered merge layer. Enforcement therefore needs a mechanism above the user's reach.

This is the **first MDM/policy mechanism** in Speedwave and establishes the pattern for future org-forced policy.

## Decision

**Add a three-layer telemetry config (compiled defaults → user `telemetry` block → MDM system file, per-field, highest) and enforce MDM locks with two mechanisms.**

### MDM channel

An admin/MDM writes a system-level `managed-config.json` at a location only an administrator can write: macOS `/Library/Application Support/Speedwave/managed-config.json`, Windows `%ProgramData%\Speedwave\managed-config.json`.[^2] Speedwave reads it fail-closed — a malformed file is a hard error, never a silent no-op, so an org policy cannot vanish on a typo. **Presence is the lock:** any field the MDM file sets is authoritative; to leave a field user-editable, the MDM omits it. There is no separate `locked` flag, because the merge always gives MDM precedence, so an "editable default" state would be incoherent.

### Dual enforcement

The mandatory hard control is a **native Claude Code `managed-settings.json`**, generated from the MDM-locked keys and mounted read-only at `/etc/claude-code/managed-settings.json`. Claude Code reads that path at the highest precedence — above both process env and user `settings.json` — in every version.[^3] In a `read_only` + `no-new-privileges` + `cap_drop: ALL` container running as UID 1000, a `:ro` mount of a host-owned file cannot be edited, remounted, or out-precedenced from inside. A new `SecurityCheck` rule (`MANAGED_SETTINGS_MOUNT`) enforces that the mount is `:ro`, at the exact target, and sourced only from `<data_dir>/claude-managed/<project>/`.

The managed-settings mount is the load-bearing control because the relative precedence of a process env var versus a user `settings.json` `env` block is **version-dependent and unreliable**: the docs say process env wins, but a documented regression (issue #8500, v2.0.1) had `settings.json env` winning, closed "not planned" with no fix confirmation.[^4] Since the in-container `~/.claude/settings.json` is a user-writable host mount, we do not rely on "process env beats settings.json" for enforcement.

The **env layer** is defense-in-depth and process-env consistency, not the boundary: MDM-locked `OTEL_*` keys are re-forced after the user merge layer (stripped from the user layer, then re-inserted), so `claude.env` cannot weaken them. The master switch `CLAUDE_CODE_ENABLE_TELEMETRY` is treated as a locked key whenever MDM sets `enabled`, so an MDM kill-switch or force-on wins over a user's `claude.env` master-switch value.

A **fail-closed boot check is the single detection point**, mirroring the plugin-signature audit. Because the policy is machine-global (`SpeedwaveUserConfig.telemetry` is top-level, not per-project), both Desktop and CLI resolve the whole policy once at startup via `config::check_telemetry_policy_at_boot()` (`load_user_config` tolerated with defaults, `load_managed_config` + `resolve_telemetry` fatal), catching every error class: malformed/unknown-key/ProgramData and `enabled`+invalid-endpoint/header/interval. Desktop shows the same native `blocking_show` dialog as a bad plugin signature (titled "Organization policy error") then `process::exit`; the CLI prints the error and exits non-zero. The renderer therefore never has to surface a telemetry-policy error: an unresolvable policy resolves to `disabled()` and simply writes no managed-settings mount (fail-closed), so there is no in-app error banner for MDM policy.

### Privacy and secrets

The privacy gates that send conversation/code content (`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_RAW_API_BODIES`) default off and require an explicit user confirmation to enable; MDM can force any of them off (or on, for compliance audit).[^5] `OTEL_LOG_TOOL_CONTENT` is intentionally not modelled: it only takes effect with the traces/spans beta, out of scope here — the effective tool-content gate for a metrics+logs export is `OTEL_LOG_TOOL_DETAILS`.[^1] The auth-headers secret rides `OTEL_EXPORTER_OTLP_HEADERS`; its value is masked in the UI, never returned to the frontend (only a `has_headers` boolean), and redacted from logs/diagnostics by a dedicated sanitizer rule.

## Consequences

- **Enforcement is regenerate-on-render, not a tamper-proof store.** The host `managed-settings.json` under `<data_dir>/claude-managed/` is user-writable between renders; every container start re-renders and overwrites it from the current policy, and `fs_security` enforces `0o700`/`0o600` on it. Integrity comes from re-rendering on every start path, not from the file being unmodifiable on disk.
- **A broken policy file blocks the whole app at boot, not just a project.** Because the boot check runs before project selection, a malformed `managed-config.json` fails Desktop and CLI startup outright (native dialog / non-zero exit). An admin typo cannot let the app run with the policy silently dropped, but it also means a bad push blocks every user until corrected.
- **Org-policy interaction is a known limitation.** A Claude Team/Enterprise org telemetry policy set in the Claude console (server-managed settings) never reaches Claude Code inside Speedwave: server-managed settings are bypassed for any non-default `ANTHROPIC_BASE_URL`, which the per-project proxy always sets.[^7] Speedwave delivers policy through the endpoint-managed channel (`/etc/claude-code/managed-settings.json`) generated from `managed-config.json` instead; admins must be told to use that channel, not the Claude console. This ADR's telemetry `env` block does not conflict with plugin policy; a sibling effort that also writes `/etc/claude-code/managed-settings.json` for plugin policy must merge into a single writer.
- **DISABLE_TELEMETRY is untouched.** Anthropic's own Statsig-backed operational telemetry is independent of OTLP and out of scope; disabling it breaks feature flags and killswitches, so this feature never sets it.[^6]

## Amendment (2026-10-08): the boot check covers every managed section; `custom_mcp` key

**Context.** `managed_config.rs::ManagedConfig` rejects unknown root keys (`deny_unknown_fields`), so that an admin typo fails closed. The same rule means a binary that does not know a key refuses to boot once an admin deploys it. Custom MCP servers will be governed by an MDM key `custom_mcp`. If the key shipped together with the feature, an admin rolling the policy out to a fleet with older binaries would stop every machine that has not upgraded yet.

**Decision.**

- `ManagedConfig` gains `custom_mcp: Option<ManagedCustomMcpConfig>` (`custom_mcp/model.rs`, `deny_unknown_fields`) now, before the feature. Its fields are `enabled`, `host_servers_enabled`, `allowed_scopes`, `allowed_domains`, `max_workspace_mode` (`none`/`read_only`/`read_write`), `force_pii_mode` (`tokens`/`plaintext`) and `min_release_age_days`. Presence is the lock, as for telemetry.
- The key is parsed and validated, and nothing else reads it yet. `ManagedCustomMcpConfig::validate` rejects an `allowed_scopes` entry that is not `@` followed by lowercase letters, digits, `-`, `.`, `_` or `~`; an `allowed_domains` entry that is not a lowercase hostname, optionally prefixed with `*.`, or that carries a scheme, port, path or IP literal; and a `min_release_age_days` above `consts.rs::CUSTOM_MCP_MAX_MIN_RELEASE_AGE_DAYS` (3650). Each error names the field.
- `config::check_telemetry_policy_at_boot` becomes `config::check_managed_policy_at_boot`, a thin loader over the pure `config::check_managed_policy`, which runs the telemetry check unchanged and then validates `custom_mcp`. Desktop (`desktop/src-tauri/src/main.rs`) and CLI (`crates/speedwave-cli/src/main.rs`) call it at the same point as before and hard-stop the same way: the "Organization policy error" dialog and exit on Desktop, stderr and exit code 2 on the CLI. Every `custom_mcp` error is MDM-implicated, because the key has no user layer, so there is no degraded path for it.

**Consequences.** Admins can deploy `custom_mcp` once the fleet runs a release that contains this amendment; an older binary still refuses to boot on it. An invalid `custom_mcp` value blocks startup on every machine that receives it, like an invalid telemetry policy. The feature phase that enforces the key changes only what reads it, not its shape.

**Status note.** That phase is ADR-100: `custom_mcp/effective.rs::resolve_effective` now reads and enforces the key, so "nothing else reads it yet" above describes the state when this amendment was written.

## Footnotes

[^1]: https://code.claude.com/docs/en/monitoring-usage.md - Claude Code monitoring & telemetry: `CLAUDE_CODE_ENABLE_TELEMETRY`, the `OTEL_*` exporter/endpoint/header variables, and the privacy gates including `OTEL_LOG_TOOL_DETAILS` (works with logs export) vs `OTEL_LOG_TOOL_CONTENT` (traces/spans only).

[^2]: https://learn.microsoft.com/en-us/windows/win32/msi/programfilesfolder - Microsoft: `%ProgramData%` / `CommonAppDataFolder` is the machine-wide, admin-writable application-data location on Windows; the macOS `/Library/Application Support` analogue is likewise admin-writable only.

[^3]: https://code.claude.com/docs/en/settings.md - Claude Code settings precedence: enterprise-managed settings (`managed-settings.json`) rank above command-line args, project/local settings, and user settings.

[^4]: https://github.com/anthropics/claude-code/issues/8500 - "Environment Variables No Longer Override settings.json in v2.0.1": documented regression where a `settings.json` `env` value out-precedenced an inline shell variable, closed "not planned" with no fix confirmation; the process-env-vs-settings.json order is therefore version-dependent.

[^5]: https://code.claude.com/docs/en/data-usage.md - Claude Code data usage: prompt/response/tool/API-body content is included in telemetry only when the corresponding `OTEL_LOG_*` gate is explicitly enabled; defaults are off.

[^6]: https://code.claude.com/docs/en/data-usage.md - Claude Code data usage: `DISABLE_TELEMETRY` controls Anthropic's own operational telemetry (Statsig), independent of the OTLP exporter; it also gates feature-flag/killswitch evaluation.

[^7]: https://code.claude.com/docs/en/server-managed-settings.md - Claude Code server-managed settings: "Server-managed settings are bypassed" when the user configures a third-party model provider, including "a non-default `ANTHROPIC_BASE_URL`"; endpoint-managed settings (a `managed-settings.json` file) are the MDM alternative.
