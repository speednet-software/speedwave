---
name: speedwave-write-plan
description: Write a comprehensive implementation plan for a Speedwave task. The plan covers architecture analysis, platform impact, security, upgrade safety, tests, documentation, and git strategy. Use this skill whenever you need to create an implementation plan for any feature, fix, or change in Speedwave.
user-invocable: true
disable-model-invocation: true
model: opus
argument-hint: '<task description>'
allowed-tools: Bash(git *), Bash(make *), Read, Glob, Grep, Agent, EnterPlanMode, ExitPlanMode, AskUserQuestion
---

# Write Implementation Plan

`$ARGUMENTS` contains the task description. If `$ARGUMENTS` is empty, use AskUserQuestion to ask what the user wants to plan.

## Step 0 — Enter Plan Mode

If you are not already in plan mode, call `EnterPlanMode` immediately. All research and plan writing happens in plan mode. Do not write any code — this skill produces a plan, not an implementation.

## Step 1 — Follow the Planning Prompt Below

Everything below this line is the planning prompt. Follow it exactly.

---

You are writing an implementation plan for the Speedwave project. This plan will be reviewed by a hostile reviewer who checks 12 verification axes. Your job is to write a plan that passes ALL of them on the first attempt.

Do not write a plan based on assumptions. Read the code first, understand the architecture, then plan.

## Before You Write Anything

You MUST read and internalize the project context. Plans written without this context fail review.

1. **Read `CLAUDE.md`** (project root) — architecture, SSOT locations, forbidden patterns, plugin contract table, config merge, all NEVER rules

2. **Read ALL files in `.claude/rules/`** — `git-workflow.md`, `engineering-principles.md`, `security.md`, `logging.md`, `rust-style.md`, `mcp-servers.md`, `documentation.md`

3. **Read `docs/architecture/security.md`** — non-negotiable security model, threat model questions, executor sandbox, SSRF protection

4. **Read `docs/architecture/containers.md`** — container topology, compose template, resource limits

5. **Read `docs/architecture/platform-matrix.md`** — macOS/Linux/Windows differences

6. **Read `docs/contributing/testing.md`** — test strategy, coverage thresholds, test patterns

7. **Read `RELEASING.md`** — release flow, squash merge rules

8. **Read relevant ADRs** from `docs/adr/` — check ADR `README.md` index for overlapping topics. Pay special attention to ADR-030 (bundle reconcile), ADR-031 (data dir isolation), and any ADRs related to updates or migration.

9. **Read the actual source code** you plan to modify — the files themselves, their callers, their tests, adjacent modules. Map the dependency graph BEFORE planning changes.

10. **Read the update/reconcile flow** — `updater.rs`, `update_commands.rs`, `bundle-manifest.json` handling, `bundle-state.json` phases, snapshot/rollback logic. Understand what happens when a user updates from version N to version N+1.

## The Task

<task>

$ARGUMENTS

</task>

## Plan Structure

Write the plan using the following structure. Every section is mandatory — a missing section = automatic review failure.

### 1. Context & Goal

- What problem does this solve? Why now?

- Link to GitHub issue if one exists.

- One sentence: what does "done" look like?

### 2. Architecture Analysis

Before proposing changes, demonstrate you understand the current state:

- Which files/modules are affected?

- What is the dependency graph of the affected code? (who calls what, who imports what)

- Which SSOT locations does this touch? (`speedwave-runtime`, `mcp-servers/shared/`, `compose.template.yml`, `build.rs` ↔ `bundle-build-context.sh`, `consts.rs`, `defaults.rs`)

- Which contract surfaces does this touch? (plugin contract table, Tauri ↔ Angular models, `ContainerRuntime` trait)

- Does this touch security boundaries? (token mounts, container hardening, sandbox, SSRF, auth gates)

- Does this affect the update/reconcile pipeline? (bundle manifest, bundle state phases, compose snapshots, image tags)

### 3. Platform Impact

For EVERY change, answer:

- Does this behave differently on macOS / Linux / Windows?

- Container user: does the change assume UID 1000 or handle both 1000:1000 (macOS/Win) and 0:0 (Linux rootless, ADR-026)?

- VM layer: does it need path translation? (Lima `/tmp/lima/`, WSL `\\wsl$\`)

- Does it affect mcp-os? (macOS = AppleScript, Linux = CalDAV/zbus, Windows = WinRT/mapi-rs)

- Does it affect installer artifacts? (.dmg, .deb, .exe)

- Does this change add or modify a bundled macOS binary? If yes, follow the "Adding a new bundled binary" checklist in [`docs/contributing/release-signing.md`](../../../docs/contributing/release-signing.md#adding-a-new-bundled-binary) — it is the authoritative source for SIGN_TARGETS, entitlements plists, `Info.plist` TCC keys, and ADR-037 updates.

- Filesystem case sensitivity? (macOS VirtioFS insensitive, Linux ext4 sensitive)

If the change is platform-independent, state WHY it's platform-independent — don't just skip this section.

### 4. Implementation Steps

Numbered steps. For each step:

- **What:** concrete change (file path, function name, what changes)

- **Why:** why this step is needed (not just "implement feature X")

- **Dependencies:** what must be done before this step

- **Security check:** does this step relax any security principle? If yes — find a different approach or justify with ADR.

- **SSOT check:** is this the right place for this logic? (container logic → `speedwave-runtime`, MCP utilities → `mcp-servers/shared/`, container definitions → `compose.template.yml`)

- **Upgrade safety check:** does this step change persisted state, file formats, config schema, CLI output parsed by scripts, container image tags, or compose structure? If yes — describe the upgrade path from version N to N+1.

Order matters — steps must be executable in sequence. If step 3 fails, what happens to steps 1-2?

### 5. Test Plan

For EACH implementation step, specify concrete tests. "Add tests" is not acceptable.

**Required test categories per step:**

- **Happy path:** expected input → expected output

- **Error paths:** network down, file missing, permission denied, invalid input, timeout — what happens?

- **Edge cases:** empty strings, Unicode, max-length values, special characters, concurrent access

- **Boundary conditions:** 0, 1, max, overflow

- **Platform-specific:** UID differences, path separators, case sensitivity (if applicable)

- **Rollback/recovery:** what if this step fails mid-operation? Is the system left in a consistent state?

- **Stale state:** macOS sleep/resume, container restart, VM recreation (if applicable)

- **Upgrade scenarios:** old config + new binary, new config + old containers, partial update interrupted mid-way (if applicable)

**Test placement:**

- Rust: `#[cfg(test)] mod tests` at bottom of source file

- MCP Hub tools: follow pattern from `.claude/rules/mcp-servers.md` (metadata, execute success, parameter validation with missing/empty/null/undefined/falsy, error handling, edge cases)

- Angular: `MockTauriService`, `data-testid` selectors

- entrypoint.sh: bats tests (`make test-entrypoint`)

- log_sanitizer.rs: positive test (redacted) + false-positive test (unchanged)

**Coverage thresholds that must not drop:**

- Rust: 70% lines

- MCP Hub: 50%/50%/40%/50% (lines/functions/branches/statements)

- MCP workers: 60%/60%/50%/60%

- Angular: 40%/40%/30%/40%

### 6. Security Checklist

Answer EVERY question. "N/A" is acceptable only with justification.

- [ ] New container mounts? → Must be `:ro` (only SharePoint `/tokens` and `/workspace` are `:rw`)

- [ ] New ports or endpoints exposed?

- [ ] Token storage or credential flow changed? → Per-project isolation preserved?

- [ ] New environment variables in containers? → Could they leak secrets?

- [ ] `compose.template.yml` modified? → SecurityCheck threat model questions answered?

- [ ] MCP Hub sandbox/executor touched? → Forbidden pattern denylist, restricted context, prototype chain hardening (ADR-029) intact?

- [ ] SSRF protection touched? → Allowlist, port enforcement, redirect blocking intact?

- [ ] OWASP hardening intact? (`cap_drop: ALL`, `no-new-privileges`, `read_only`, `tmpfs: /tmp:noexec,nosuid`)

- [ ] Linux rootless UID 0 handled? (ADR-026)

- [ ] Secrets in logs/serialization/display? → `log_sanitizer.rs` rules applied?

- [ ] Authentication gates preserved? (backend + frontend)

- [ ] `path-validator.ts` denylist intact? (`.git/`, `.env`, `.speedwave/`)

- [ ] New or modified bundled macOS binary? → satisfies the "Adding a new bundled binary" checklist in [`docs/contributing/release-signing.md`](../../../docs/contributing/release-signing.md#adding-a-new-bundled-binary)

### 7. Documentation Plan

- [ ] New feature → which guide in `docs/guides/` to update?

- [ ] Architectural decision → ADR number and title (with footnoted sources)

- [ ] Configuration change → `docs/getting-started/configuration.md` update?

- [ ] CLI change → `docs/guides/cli.md` update?

- [ ] Plugin contract change → CLAUDE.md contract table update?

- [ ] Container topology change → `docs/architecture/containers.md` update?

- [ ] Security model change → `docs/architecture/security.md` update?

- [ ] Platform behavior change → `docs/architecture/platform-matrix.md` update?

- [ ] New doc file → linked from `docs/README.md`?

- [ ] New ADR → `docs/adr/README.md` index updated?

### 8. Git Strategy

- Branch name: `feat/<name>` or `fix/<name>`

- PR target: `dev` (NEVER `main`)

- Commit format: conventional commits (`feat(scope):`, `fix(scope):`)

- If multiple commits needed: describe the split and order

- Link to GitHub issue(s) if they exist

- Verification before push: `make check` (not just `make test`)

### 9. Upgrade Safety Checklist

This section ensures that after a user updates Speedwave from version N to N+1, everything works correctly without manual intervention. Answer EVERY question. "N/A" is acceptable only with justification.

**Persisted state compatibility:**

- [ ] Does this change the schema or structure of `~/.speedwave/config.json`? → New fields MUST have `#[serde(default)]` so old configs deserialize without error. Removed fields MUST be ignored (`#[serde(deny_unknown_fields)]` must NOT be used). Renamed fields need a migration path or backward-compatible alias.

- [ ] Does this change token paths (`~/.speedwave/tokens/<project>/<service>/`)? → Old tokens must remain valid. New paths must be populated automatically, not require user action.

- [ ] Does this change `compose.template.yml` or `render_compose()` output? → Old running containers will be recreated with new compose on next `update`. Verify the transition is handled by `update_containers()` security gate + snapshot/rollback.

- [ ] Does this change `bundle-manifest.json` or `bundle-state.json` format? → The reconcile pipeline (ADR-030) must handle both old and new format during the transition. A new binary may read an old `bundle-state.json` left by a previous version.

- [ ] Does this add, remove, or rename files in `~/.speedwave/`? → Orphaned files from old version must not cause errors. New required files must be created automatically on first run.

**Container image compatibility:**

- [ ] Does this change container image names or tags? → Images are tagged with `bundle_id`. Old images from previous bundle remain on disk. New containers must use new tags, not assume `:latest`.

- [ ] Does this change Containerfile build context or dependencies? → Image rebuild is handled by reconcile phase 2 (`ImagesBuilt`). Verify the build succeeds with the new context.

- [ ] Does this change environment variables injected into containers? → Running containers from old version won't have new env vars until recreated. Code inside containers must handle missing new env vars gracefully (default values, not crashes).

**CLI and API compatibility:**

- [ ] Does this change CLI subcommand names, flags, or output format? → Scripts or Desktop UI parsing CLI output will break. If changing output format, ensure all consumers are updated in the same release.

- [ ] Does this change Tauri command signatures or return types? → Frontend models (`desktop/src/src/app/models/`) must match. A version mismatch between Tauri backend and Angular frontend causes runtime errors.

- [ ] Does this change MCP Hub tool schemas or worker endpoints? → Claude's cached tool list may reference old schemas. Hub must handle requests for removed/renamed tools gracefully.

**Plugin contract compatibility:**

- [ ] Does this change any element in the plugin contract table (CLAUDE.md)? → Existing installed plugins in `~/.speedwave/plugins/` must continue to work. If breaking — coordinate with `speedwave-plugins` repo or add backward compat.

- [ ] Does this change `entrypoint.sh` plugin loading logic? → Plugins ship `claude-resources/` that are symlinked at container start. Changes must handle both old and new plugin directory structures.

**Interrupted update recovery:**

- [ ] If the update is interrupted mid-way (crash, power loss, kill -9), is the system left in a recoverable state? → Atomic file writes (`.tmp` + rename), persisted reconcile phases, snapshot before compose mutation.

- [ ] Can the user recover by simply running `speedwave update` again? → The update must be idempotent — running it twice produces the same result as running it once.

**Rollback path:**

- [ ] If the new version has a critical bug, can the user downgrade? → Describe what happens if a user installs an older binary. Will it read new-format config/state correctly? Will it fail gracefully or corrupt data?

- [ ] Are compose snapshots preserved so `rollback_containers()` can restore the previous state?

## Rules While Writing

- **No TODO/FIXME/HACK/XXX** — if something can't be done now, say so explicitly, don't leave markers

- **No `#[allow(dead_code)]` or `#[allow(...)]`** — plan the code so it doesn't need suppressions

- **No host `limactl`/`nerdctl`/`docker`** — all through `speedwave-runtime` (`detect_runtime()`)

- **No git hook bypass** — plan must work with hooks enabled

- **No speculative features** — only what the task requires. No "future extensibility", no feature flags, no backward-compatibility shims.

- **KISS** — if >100 lines for something a CLI tool already does, find the tool. Prefer shelling out over reimplementing.

- **DRY** — use existing SSOT locations. Don't duplicate logic from `speedwave-runtime` or `mcp-servers/shared/`.

- **Rule of Three** — don't create abstractions for a pattern seen fewer than three times.

- **Boy Scout Rule** — if you encounter bugs, typos, or inconsistencies in code you're modifying, include fixes in the plan.

- **Upgrade safety** — every change to persisted state, file formats, or inter-component contracts must work when a user updates from any previous release. Assume zero manual intervention by the end user.

---

## Step 2 — Present for Review

When the plan is complete, present it to the user in plan mode. The user will review, ask questions, or request changes. Iterate until approved.

Only call `ExitPlanMode` when the user explicitly approves the plan and you are ready to begin implementation.
