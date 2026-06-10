# ADR-054: `host_exec` — Per-Project Host-Side MCP Worker for the Project Toolchain

> **Status:** Accepted (implemented)
> **Context:** Claude runs in a token-free container with only Node + git. It cannot use the user's real toolchain (JDK, Gradle, Go, .NET, Python, the host's Docker stack) to build/test/run the project — the most-requested gap, and one users were already filling unsafely with hand-rolled agents on `0.0.0.0` with tokens committed to the repo.

## Decision

Add `host_exec`: a **per-project, host-side** MCP worker, sitting behind each project's MCP hub, that runs **only the commands the user explicitly whitelists** in the Desktop UI (Integrations), in the project directory, with `shell:false`, no per-call confirmation, and returns exit code + capped stdout/stderr + status to Claude. One worker process per enabled project, each on its own dynamic `127.0.0.1` port. Enabling it for a project is a deliberate, gated act (a blocking danger modal) — that consent covers the whole whitelist; there is no per-recipe prompt.

This is a deliberate, scoped weakening of Speedwave's container-isolation model: a whitelisted build/test recipe runs repo-controlled code (`./gradlew test` runs `build.gradle`, `npm run test` runs `package.json` scripts, `docker compose up` runs `docker-compose.yml`) on the host with the user's privileges. Because Claude can write `/workspace`, a prompt-injected Claude could author a malicious script and then invoke a whitelisted recipe over it. That residual risk is accepted and bounded by: opt-in, empty by default, per-project, **user-local config only** (the repo's `.speedwave.json` cannot inject it), the enable-time danger modal, and a host-side audit log.

## Why

- Ships a safe, official path before more `agent.js`-on-`0.0.0.0` workarounds (or "install the toolchain into the container's writable `$HOME`") become the de-facto norm.
- Reuses the proven host-process mechanics already used by the `os` worker (`mcp-os`) — `127.0.0.1`-only bind, container→host reach via the `host.docker.internal` gateway, `WORKER_<NAME>_URL` injected into the hub, per-session bearer token — adding little new surface.
- Correctly **per-project** (own worker, port, token, config, log) where `mcp-os` is a single global instance, so two projects never cross-talk and each gets its own (or empty) whitelist.
- A **separate** worker, not part of `mcp-os`: different responsibility (arbitrary dev commands vs. fixed system-API tools), and it must **not** inherit `mcp-os`'s macOS PIM (Calendar/Mail) TCC entitlements — a build script must not reach the user's mailbox.
- The service id is `host_exec` (underscore), so the hub derives `WORKER_HOST_EXEC_URL` and exposes recipes as `host_exec.recipeName()` in the JS sandbox; a hyphen would break both. Recipe names are `snake_case` for the same reason.

## Where it lives in code

- Config schema (SSOT) — `HostExecConfig` / `HostExecRecipe` / `HostExecParam` and `ResolvedIntegrationsConfig.host_exec`, with the repo layer explicitly ignoring `hostExec`, in `crates/speedwave-runtime/src/config.rs`.
- Validation — `validate_host_exec_config` (snake_case names, ban-list `exec`, `{name}`↔`params`, `cwdSub` safety, the parameterised-meta-invocation rule) and `is_container_lifecycle_recipe` in `crates/speedwave-runtime/src/host_exec.rs`.
- Constants (SSOT) — `HOST_EXEC_SHELL_LAUNCHERS`, `HOST_EXEC_META_TOOLS`, the timeout/cap constants, `HOST_EXEC_CONFIG_KEY`, and `host_exec` in `BUILT_IN_SERVICE_IDS`, in `crates/speedwave-runtime/src/consts.rs`.
- Process manager — `HostExecProcess` (a thin alias over the shared `HostMcpProcess<HostExecSpec>`), `spawn_in`, and `write_host_exec_config_snapshot` in `crates/speedwave-runtime/src/host_exec_process.rs`; the generic host-process mechanics live in `crates/speedwave-runtime/src/host_mcp_process/`.
- Hub/compose wiring — `apply_host_exec_config_in`, `host_exec_gateway_url`, the `WORKER_HOST_EXEC_URL` env + per-project bearer-token mount, and adding `host_exec` to `ENABLED_SERVICES` when enabled, in `crates/speedwave-runtime/src/compose.rs`.
- Worker — the TypeScript MCP server (`shell:false`, detached own process group, per-stream output cap with ANSI strip, per-command timeout → process-group `SIGKILL`, full-argv audit log with `env` values redacted) in `mcp-servers/host_exec/`.
- Desktop — Tauri commands `get_host_exec` / `set_host_exec_enabled` / `host_exec_save_settings` / `host_exec_load_settings` / `host_exec_resolve_executable` in `desktop/src-tauri/src/host_exec_cmd.rs`; lifecycle (`ensure_host_exec_running`, login-shell `PATH` recovery, the per-project worker map + watchdog) in `desktop/src-tauri/src/main.rs`; teardown in `desktop/src-tauri/src/reconcile.rs`.
- CLI — does **not** spawn the worker. The Desktop app (a hard CLI prerequisite) is the sole spawner; the CLI reads the Desktop-held `lock.json` + bearer-map from disk via `apply_host_exec_config_in` during render. Two supervisors racing one worker caused the dual-supervisor exit-137 cycle — see ADR-068 §"Not every exit 137 is OOM".
- Frontend — `desktop/src/src/app/models/host-exec.ts` and the gated-toggle card in `desktop/src/src/app/integrations/host-exec-config/`.

## Rejected alternatives

- **One global worker with bearer-token→project routing.** More complex (the worker would have to be project-aware) and weaker isolation; per-process-per-project is cleaner and matches how Speedwave already runs per-project stacks. Kept as the documented fallback only if per-project memory cost ever bites.
- **Extending `mcp-os` instead of a new worker.** Mixes concerns and would let a build script inherit `mcp-os`'s Calendar/Mail TCC consent — rejected on blast-radius and SRP grounds.
- **Per-call human-in-the-loop confirmation.** Claude Code runs `--dangerously-skip-permissions` inside the container, so a per-call prompt could only be a parallel side channel — Desktop-only, no CLI coverage, and architecturally awkward (the original fd-3 design). The enable-time consent + whitelist + per-recipe regex params + audit log replaces it.
- **A configurable shell.** No `shell:true`, no `exec:"bash"`. The shell/eval-launcher ban (`HOST_EXEC_SHELL_LAUNCHERS`) is defense in depth only — it cannot stop a build tool from running repo code, and is matched by basename so a renamed/path-qualified interpreter can bypass it; this is a documented residual, not a guarantee.

## PATH

A GUI-launched Desktop process on macOS inherits only a stunted `PATH` (no login-shell rc files run), so the worker would fail to find a user's real toolchain (`/opt/homebrew/bin`, language version managers, etc.). The Desktop recovers the login-shell `PATH` once at startup via `$SHELL -ilc 'printf %s "$PATH"'` on a background thread (bounded by a short timeout, falling back to the inherited `PATH` plus the Homebrew bin dirs on any failure), caches it, and injects it into every spawned `host_exec` worker. On Windows the process `PATH` is authoritative — there is no login-shell probe. See `desktop/src-tauri/src/host_path.rs`.

## Negative

- The whole point of the worker is a scoped weakening of container isolation: a whitelisted recipe runs repo-controlled code (`build.gradle`, `package.json` scripts, `docker-compose.yml`) on the host with the user's privileges. A prompt-injected Claude that authors a malicious script in `/workspace` and then invokes a whitelisted recipe over it is the accepted residual — bounded by opt-in, empty-by-default, per-project scope, user-local config only, the enable-time danger modal, and the host-side audit log.
- The shell/eval-launcher and meta-tool bans are matched by **basename**, so a path-qualified or renamed interpreter (`./node_modules/.bin/node`) is not caught. This is intentional — the recipe author chose it — and pinned by tests so any future tightening is a conscious change.
- Container-lifecycle recipes (`docker`/`docker-compose`/`podman` + a lifecycle verb) are accepted by validation and only surfaced as a UI warning; the enable consent and the audit log are the controls.
- DNS rebinding against a user-supplied target is accepted as residual, consistent with ADR-041's host-side HTTP posture.

## Related

- ADR-010, ADR-013 — `mcp-os` host-process mechanics (bind policy, gateway routing, hub wiring); `host_exec` is the per-project variant.
- ADR-036 — self-declaring worker policy via `_meta` (`host_exec` declares `timeoutClass:'long'`).
- ADR-038 — single internal worker port; `host_exec` is a host process, so it gets a dynamic loopback port + `WORKER_HOST_EXEC_URL` instead (the documented exception in the hub-port test).
- ADR-009 — per-project isolation preserved (`host_exec` has no `/tokens` mount).
- ADR-041 — host-side HTTP hardening; precedent for accepting DNS-rebinding-against-user-targets as residual risk.
- ADR-049 — why `mcp-os` carries PIM entitlements and why `host_exec` must not.
- ADR-007 — the IDE Bridge is a host-side proxy that never grants Claude host filesystem or code-execution access; `host_exec` is the first such channel, and it is opt-in and whitelisted.
- ADR-001 — Speedwave does not use Docker Desktop; "the host's Docker" is a separate user install a `docker` recipe targets.
