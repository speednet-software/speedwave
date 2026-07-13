---
paths:
  - 'crates/**'
  - 'desktop/**'
  - 'mcp-servers/**'
  - 'containers/**'
  - 'scripts/**'
  - 'native/**'
  - '_tests/**'
  - '.github/**'
---

# SSOT Registry — edit the SSOT, never a call-site copy

Never hand-write a path/value/model-string where an SSOT exists; a wrong literal is fixed by calling the SSOT, not by correcting the string.

- `defaults.rs::ANTHROPIC_MODELS` — Anthropic model catalog (id, family, context window, latest flag); frontend reads it via `list_anthropic_models` + `AnthropicModelsService`. Never hard-code model strings.
- `defaults.rs::CLAUDE_VERSION` — the Claude Code version pin (concrete semver, never `latest`).
- `defaults.rs::BUNDLED_PLUGINS` / `BUNDLED_PLUGIN_MARKETPLACE` — the official Anthropic plugins installed+enabled at container start, rendered into the claude service env by `compose/mod.rs`; never hand-list the plugin set elsewhere.
- `resources.rs` — every container mem/CPU/tmpfs/shm number + Lima VM sizing (`host/2` clamped; macOS-only — WSL2 memory is deliberately unmanaged). Always-on containers: `CLAUDE_RESOURCES` (fixed 6 GiB) / `HUB_RESOURCES` / `PROXY_RESOURCES`; per-worker limits on `consts::McpServiceDescriptor.resources`; plugin envelope in `consts.rs` (`PLUGIN_*`). Limits are ceilings, not reservations — overcommit is OK. Minimum supported host: `MIN_SUPPORTED_HOST_GIB` (16 GiB) — never design or size features for smaller hosts.
- `transcription/model_catalog.rs` — Whisper model catalog (files, pinned URLs, SHA256; frontend via `list_transcription_models`); the live model is auto-selected from compile-time backends (`accel.rs`). Bumping a model = editing one const.
- `usage.rs` + `usage_cost.rs` — final tokens + cost for the dashboard (`get_llm_usage`), chat footer (`get_usage_for_response`/`get_conversation_cost`), and the in-container statusline. Proxy usage JSONL + host-side cost sidecar keyed by `response_id`. Cost enrichment never rewrites the usage JSONL; unpriced stays `null`, never `0.0`; never sum Claude Code's `total_cost_usd` with proxy cost. Full invariants: local-llm rules.
- `log_ts.rs::log_timestamp()` / mcp-shared `ts()` — the one log timestamp format (RFC 3339, millis, local offset with colon). Never `toISOString()` for a log-line prefix.
- `diagnostic_sources.rs::DIAGNOSTIC_SOURCES` — every diagnostic file shown in the /logs UI and packed into the diagnostics ZIP. New log file = new registry entry (non-`displayable` = ZIP-only), never a hand-wired path.
- `engine_path.rs` — all host→engine path handling (`to_engine_path`/`str_to_engine_path`/`vm_path_join`, `strip_extended_length_prefix`).
- `compose/addressing.rs` — `host_bind_address()`/`host_gateway_ip()`: every host TCP listener bind and every container→host gateway IP.
- `runtime/mod.rs::project_has_compose_file(project)` — the one probe for "has this project's compose.yml been rendered". A configured-but-never-initialized project fatally errors per-project `compose_ps` — guard with this helper (or degrade gracefully on `Err`), never a hand-rolled `Path::exists()` on a compose path.
- `url_validation.rs` — the shared SSRF validator (+ `PrivatePolicy`); Desktop re-exports it. One validator — never a second regex or copied constants.
- `build.rs::IMAGES` + `ImageDef.hash_inputs` — image catalog and what rebuilds each image. Full rules: images-builds rules.
- `fs_perms.rs` — owner-only permissions (Unix chmod ↔ Windows DACL) and durable fsync-before-rename writes. `binary.rs` — the only module that constructs process spawns: `system_command` (non-interactive system tools; CREATE_NO_WINDOW + WSL_UTF8), `run_powershell` (deadline-bounded), `command` (bundled binaries), `interactive_command` (TTY-visible spawns); raw `Command::new` outside `binary.rs` is drift-tested (`tests/no_raw_command_spawn.rs`, escape hatch `// SSOT-allow: <reason>`).
- `consts.rs` — ports, names, literals: `HOST_GATEWAY_ALIAS`, `DATA_DIR`, WSL distro name derivation, nerdctl pin, OAuth constants, `RESERVED_ENV_KEYS`, service descriptors (`TOGGLEABLE_MCP_SERVICES`/`TOGGLEABLE_OS_SERVICES`, `BUILT_IN_SERVICE_IDS`), MDM/managed-settings path literals (`MANAGED_CONFIG_VENDOR_DIR`, `MANAGED_CONFIG_FILE`, `CLAUDE_MANAGED_SUBDIR`, `MANAGED_SETTINGS_FILE`).
- `telemetry_env.rs` — the one telemetry-field↔`OTEL_*` env-key table (`TelemetryField` + `env_key_for` + `ENABLE_KEY`), read by both `resolve_telemetry`'s `locked_keys` logic and the env map. Never hand-write an `OTEL_*` key at a call-site; a drift test guards the two readers.
- `config.rs::resolve_telemetry` — the single telemetry merge (defaults → user → MDM per-field, presence-is-lock, master-switch lock, endpoint/header validation, kill-switch). Both the compose renderer and the Tauri command read it, so the UI shows exactly what reaches the container.
- `mcp-servers/policies/templates/*.yaml`: the PII policy template presets (`strict`/`gdpr-art32`/`eu-ai-act-art5`). Not code: `pii_policy.rs` embeds the same files via `include_str!`, the TS `template-loader.ts` reads them at runtime. Never hand-list a template's category mapping in Rust or TS, edit the YAML instead; both sides pick it up.
