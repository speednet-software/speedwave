---
name: speedwave-review-plan
description: Hostile review of a Speedwave implementation plan. Checks 12 verification axes — security, architecture, platform coverage, tests, upgrade safety, CLAUDE.md compliance, and more. Use this skill to verify any implementation plan before starting work.
user-invocable: true
disable-model-invocation: true
model: opus
argument-hint: '<path to plan file>'
allowed-tools: Bash(git *), Bash(make *), Read, Glob, Grep, Agent, EnterPlanMode, ExitPlanMode, AskUserQuestion
---

# Review Implementation Plan

`$ARGUMENTS` contains the path to the plan file. If `$ARGUMENTS` is empty, use AskUserQuestion to ask for the plan path.

## Step 0 — Enter Plan Mode

If you are not already in plan mode, call `EnterPlanMode` immediately. Plan review happens in plan mode.

## Step 1 — Follow the Review Prompt Below

Everything below this line is the review prompt. Follow it exactly.

---

Your job is NOT to validate the plan. Your job is to find gaps, assumptions, and shortcuts that will cause problems in production.
Do not praise what works. Only report what's wrong, missing, or dangerous. If something is fine — skip it silently.

## Setup

Before analyzing the plan, you MUST read and internalize the project context. Do not skip any of these — each one contains rules that plans routinely violate:

1. **Read `CLAUDE.md`** (project root) — architecture overview, key gotchas, SSOT locations, forbidden patterns, plugin contract table, config merge hierarchy, all NEVER rules

2. **Read ALL files in `.claude/rules/`** — `git-workflow.md`, `engineering-principles.md`, `security.md`, `logging.md`, `rust-style.md`, `mcp-servers.md`, `documentation.md`

3. **Read `docs/architecture/security.md`** — non-negotiable security model, threat model questions, executor sandbox, SSRF protection, SecurityCheck validation

4. **Read `docs/architecture/containers.md`** — container topology, compose template, resource limits, stale container recovery

5. **Read `docs/architecture/platform-matrix.md`** — macOS/Linux/Windows differences that plans forget

6. **Read `docs/contributing/testing.md`** — test strategy, coverage thresholds, E2E structure, test patterns

7. **Read `RELEASING.md`** — release flow, squash merge rules, backmerge implications

8. **Read relevant ADRs** from `docs/adr/` — any ADR whose topic overlaps with the plan's scope. Read the ADR `README.md` index first to identify which ones apply. Pay special attention to ADR-030 (bundle reconcile), ADR-031 (data dir isolation), and any ADRs related to updates or migration.

9. **Read the actual source code** touched by the plan — not just the files listed, but their callers, their tests, and adjacent modules. Understand the dependency graph before judging the plan.

10. **Read the update/reconcile flow** — `updater.rs`, `update_commands.rs`, `bundle-manifest.json` handling, `bundle-state.json` phases, snapshot/rollback logic. Understand what happens when a user updates from version N to version N+1, and what can break during that transition.

Only after completing ALL reads above, begin analysis.

## The Plan to Analyze

Read the plan file at path `$ARGUMENTS` using the Read tool. If the file does not exist, use AskUserQuestion to ask for the correct path. Analyze the full content of that file against the Verification Axes below.

## Iteration Context (if provided)

If the user prompt includes a "PREVIOUS FINDINGS" section, this is a FOLLOW-UP review. The plan has been revised to address previously-identified issues. In this mode:

1. **Primary task:** Verify each previously-identified issue. Report whether it is RESOLVED or STILL PRESENT.
2. **New issues:** Only report NEW findings in detail if they are BLOCKER or HIGH severity. Suppress new MEDIUM and LOW finding details from the output.
3. **new_issue_count:** Set this to the number of ALL genuinely NEW issues (including suppressed MEDIUM/LOW ones). This counter drives convergence logic — undercounting causes premature acceptance. A previously-reported issue that is STILL PRESENT does NOT count as new.
4. **Convergence bias:** If all previously-identified HIGH and BLOCKER issues have been resolved, and you only have MEDIUM or LOW new findings, return READY_TO_IMPLEMENT.

If the user prompt does NOT include previous findings, this is a FIRST review. Run the full scan as described below.

## Verification Axes

Work through EVERY axis below. For each one, report ONLY problems. No "looks good", no "well done", no "correctly handles", no "the plan appropriately...". If an axis has zero issues, write **"No issues found."** and move on.

### 0. CLAUDE.md FULL COMPLIANCE

This is a line-by-line audit. Go through every section of CLAUDE.md and every file in `.claude/rules/` and verify the plan does not violate any rule.

**CLAUDE.md — Key Architecture section.** For each bullet point, check:

- Does the plan respect all SSOT locations? (`speedwave-runtime`, `mcp-servers/shared/`, `compose.template.yml`, `build.rs` ↔ `bundle-build-context.sh`)

- Does it respect per-project isolation? (`~/.speedwave/tokens/<project>/<service>/`, `speedwave_<project>_network`)

- Does it go through `Box<dyn ContainerRuntime>` for container operations?

- Does it respect MCP Hub as the ONLY server Claude sees (port 4000, zero tokens)?

- Does it preserve the IDE Bridge mapping? (`~/.speedwave/ide-bridge/<port>.lock` → `~/.claude/ide/`)

- Does it respect config merge hierarchy? (defaults → repo `.speedwave.json` → user `~/.speedwave/config.json`)

- Does it handle Claude Code installation contract? (installed inside container by `entrypoint.sh`, not bundled)

**CLAUDE.md — Commands section:**

- Does the plan use `Makefile` for all build/test/check operations? Does it ever call `cargo` or `npm` directly?

**CLAUDE.md — Git Workflow section:**

- PRs target `dev`, not `main`?

- Conventional commit format?

- Squash merge strategy respected?

- Link to GitHub issues where they exist?

**CLAUDE.md — Plugins section:**

- If the plan touches any of the 15 contract elements in the plugin contract table — does it maintain backward compatibility with `speedwave-plugins`?

- Does it follow the breaking-change rule? (check impact first, coordinate if breaking)

- Does it respect plugin types, lifecycle, and toggle mechanism?

**CLAUDE.md — Key Principles section:**

- KISS, YAGNI, DRY, SOLID, Boy Scout Rule, Rule of Three — each checked individually (detailed checks in axes 6-8 below)

**CLAUDE.md — Key Gotchas section.** Every NEVER rule checked:

- No host `limactl`/`nerdctl`/`docker` — all through `speedwave-runtime` or `speedwave` CLI?

- No git hook bypass (`--no-verify`, `HUSKY=0`, `core.hooksPath`)?

- No skipped tests (`.skip`, `xit`, `xdescribe`)?

- No bypassed branch protection or CI (`--admin`, disabling checks)?

- No TODO/FIXME/HACK/XXX markers left behind?

- No `@deprecated` comments — code rewritten instead?

- No `#[allow(dead_code)]`? (If test-only: `#[cfg(test)]`. If serde: `_` prefix + `#[serde(rename)]`)

- No `#[allow(...)]` to suppress lints? (Only exception: `#[allow(clippy::unwrap_used, clippy::expect_used)]` on `#[cfg(test)] mod tests`)

- Tests included in the same commit as code changes?

- SharePoint `:rw` exception — only this exception, no new ones?

- Linux rootless UID 0 accounted for (ADR-026)?

- Documentation included as delivery requirement?

**`.claude/rules/logging.md`:**

- Does the plan use `log` crate facade (not `eprintln!`/`println!` for logging)?

- Correct log levels? (`error!`, `warn!`, `info!`, `debug!`, `trace!`)

- No prefixes in log messages (except multi-subsystem modules)?

- No secrets in log output? Structs with secrets — no `derive(Debug)`, manual redacting `Debug` impl?

- Container/external logs passed through `sanitize()` before frontend?

- New secret patterns → rule in `log_sanitizer.rs` with positive + false-positive tests?

**`.claude/rules/mcp-servers.md`:**

- `mcp-servers/shared/` used for MCP protocol utilities (no duplication in servers)?

- Hub = only MCP server Claude sees?

- Each worker mounts only its own `/tokens` read-only?

- Hub has zero tokens?

- Test pattern followed? (metadata, execute success, parameter validation, error handling, edge cases)

**`.claude/rules/rust-style.md`:**

- `speedwave-runtime` has no Tauri coupling?

**`.claude/rules/documentation.md`:**

- New feature → guide updated?

- Architectural decision → ADR written with footnoted sources?

- New doc → linked from `docs/README.md`?

- Placeholder `<!-- Content to be written -->` filled if feature now implemented?

**`.claude/rules/engineering-principles.md`:**

- Cross-check with axes 6-8 below (KISS, YAGNI, DRY + SOLID, Rule of Three)

**`.claude/rules/git-workflow.md`:**

- Cross-check with axis 9 below

**`.claude/rules/security.md`:**

- Cross-check with axis 1 below

**Severity: Any CLAUDE.md or rules violation = BLOCKER. These are non-negotiable project rules.**

### 1. SECURITY MODEL VIOLATIONS

The security model is non-negotiable. Any relaxation is a blocker.

Check:

- Does the plan introduce new mounts into containers? Are they `:ro`? (Only SharePoint `/tokens` and all `/workspace` mounts are `:rw` — everything else MUST be `:ro`)

- Does it expose new ports, endpoints, or attack surfaces?

- Does it touch token storage, token paths, or credential flow? Verify per-project isolation is preserved (`~/.speedwave/tokens/<project>/<service>/`)

- Does it add environment variables to containers? Could they leak secrets?

- Does it modify `compose.template.yml`? Run the SecurityCheck threat model questions:
  - Does this require relaxing any security principle?

  - Does this add a new attack surface?

  - Does this require mounting host filesystem?

- Does it touch the MCP Hub executor/sandbox? Verify forbidden pattern denylist, restricted context, and prototype chain hardening (ADR-029) are not weakened

- Does it touch SSRF protection (`getWorkerUrl()`)? Verify allowlist, port enforcement, redirect blocking

- Does it respect OWASP container hardening (`cap_drop: ALL`, `no-new-privileges`, `read_only`, `tmpfs: /tmp:noexec,nosuid`)?

- Does it handle the Linux rootless UID 0 case (ADR-026)? Plans that assume UID 1000 everywhere will break Linux.

- Does it log, serialize, or display anything that could contain secrets? Check against `log_sanitizer.rs` rules.

- Does the plan touch authentication flow? Verify both backend and frontend gates are preserved.

- Does it touch `path-validator.ts` denylist? Verify `.git/`, `.env`, `.speedwave/` are still blocked.

- Does it touch OS prerequisite checks (`os_prereqs.rs`)? Verify violations still block container start.

- If the plan adds a new bundled binary: does it include entitlements analysis? Is `SIGN_TARGETS` in `sign-bundled-binaries.sh` updated? Is the entitlements plist created in `desktop/src-tauri/entitlements/` if needed? Is ADR-037 updated? Does the plan account for Hardened Runtime restrictions (Virtualization.framework, Apple Events/osascript, JIT, other restricted APIs)?

**Severity: Any security relaxation without an ADR justification = BLOCKER.**

### 2. ARCHITECTURAL INTEGRITY & SSOT

Speedwave has strict single-sources-of-truth. Violating them creates drift that causes production bugs.

Check:

- **`crates/speedwave-runtime/`** — is the plan putting container logic elsewhere (CLI, Desktop, scripts)? All container logic belongs in the runtime crate. CLI and Desktop import it as a Cargo dependency.

- **`mcp-servers/shared/`** — is the plan duplicating MCP protocol utilities in a specific server instead of using shared?

- **`containers/compose.template.yml`** — is the plan hand-editing generated compose files instead of modifying the template? Is `render_compose()` the generation path?

- **`scripts/bundle-build-context.sh` ↔ `build.rs`** — if the plan adds/removes/renames a container image, does it update BOTH the IMAGES list in `build.rs` AND the script? Misalignment = broken builds.

- **`ContainerRuntime` trait** — does the plan respect `Box<dyn ContainerRuntime>`? New platform = new impl, zero changes to existing code. No platform-specific `if/else` in callers.

- **Config merge** — does the plan respect the hierarchy: defaults → repo `.speedwave.json` → user `~/.speedwave/config.json`? Is it reading config at the right level?

- **Plugin contract** — if the plan touches anything in the plugin contract table (see CLAUDE.md), does it maintain backward compatibility with the `speedwave-plugins` repo? Breaking changes require coordination.

- **IDE Bridge** — `~/.speedwave/ide-bridge/<port>.lock` on host, mounted as `~/.claude/ide/` in container. Plan must not break this mapping.

- **entrypoint.sh symlink strategy** — core resources symlinked from `/speedwave/resources/`; with plugins, individual symlinks; without, whole-directory symlinks. Plan must not break this logic.

- **`log_sanitizer.rs`** — SSOT for secret redaction. Any new log output that could contain secrets must use it.

- **`consts.rs` / `defaults.rs`** — hardcoded values that should be constants? Values that duplicate existing constants?

**Severity: SSOT violation = HIGH. Creates silent drift that manifests as production bugs weeks later.**

### 3. PLATFORM COVERAGE (macOS / Linux / Windows)

Plans that work on the developer's macOS laptop and break on Linux/Windows are the #1 source of release blockers.

Check:

- Does the plan assume a specific platform? Identify every platform-dependent assumption.

- **Container user:** macOS/Windows = `1000:1000`, Linux = `0:0` (rootless user namespace, ADR-026). File permission logic, volume mounts, and `chown` calls must handle both.

- **VM layer:** macOS = Lima + Apple VZ, Windows = WSL2 + Hyper-V, Linux = native nerdctl (no VM). Path translation differs: Lima uses `/tmp/lima/` prefix, WSL uses `\\wsl$\` or `/mnt/c/`.

- **mcp-os:** macOS = AppleScript + EventKit, Linux = CalDAV (EDS via zbus), Windows = WinRT + mapi-rs. Changes to mcp-os must account for all three.

- **Installer:** .dmg (macOS), .deb (Linux, ADR-025), .exe NSIS (Windows). Does the plan affect any installer artifact?

- **Filesystem:** macOS VirtioFS is case-insensitive by default, Linux ext4 is case-sensitive. Path comparisons must handle this.

- **Host commands:** NEVER call host `limactl`, `nerdctl`, or `docker` directly. All operations through `speedwave-runtime` (`detect_runtime()`).

- **OS prerequisites:** Does the plan add requirements? Check against `os_prereqs.rs` — Windows needs WSL2, Linux needs `newuidmap`, macOS has no prerequisites.

- **Desktop log paths:** `~/Library/Logs/` (macOS) vs `~/.local/share/.../logs/` (Linux). Plan must not assume one.

- **Build context:** `prepare_build_context()` handles path translation for VMs. Does the plan respect this?

- **Resource limits:** Adaptive on macOS/Linux (formulas in `resources.rs`), fixed on Windows. Does the plan change memory/CPU assumptions?

- **macOS code signing:** If the plan adds a new bundled binary: is it added to `SIGN_TARGETS` in `sign-bundled-binaries.sh`? Does it need entitlements under Hardened Runtime (Virtualization.framework, Apple Events/osascript, JIT, other restricted APIs)? Is the entitlements plist in `desktop/src-tauri/entitlements/` created? Is ADR-037 entitlements inventory table updated?

**Severity: Platform blindness = HIGH. Silent failures on platforms the developer didn't test on.**

### 4. TEST PLAN ADEQUACY

"Every code change must include tests in the same commit" is not a suggestion. A plan without a concrete test strategy is incomplete.

Check:

- Does the plan specify WHAT tests will be written? Vague "add tests" is not acceptable — name the test cases or at minimum describe the categories of tests.

- **Happy path is not enough.** Verify the plan covers:
  - Error paths and failure modes (network down, file missing, permission denied, invalid input, timeout)

  - Edge cases (empty strings, Unicode, max-length values, concurrent access, special characters)

  - Boundary conditions (0, 1, max, overflow)

  - Platform-specific behavior (UID differences, path separators, case sensitivity)

  - Rollback/recovery scenarios (what happens when step 3 of 5 fails mid-operation?)

  - Stale state (macOS sleep/resume, container restart, VM recreation)

  - Upgrade scenarios (old config + new binary, new config + old containers, partial update interrupted mid-way — if the plan touches persisted state or inter-component contracts)

- Does the plan respect **coverage thresholds**?
  - Rust: 70% lines

  - MCP Hub: 50%/50%/40%/50% (lines/functions/branches/statements)

  - MCP workers: 60%/60%/50%/60%

  - Angular: 40%/40%/30%/40%

- If the plan touches MCP Hub tools, does it follow the test pattern from `.claude/rules/mcp-servers.md`? (metadata tests, execute success, parameter validation with missing/empty/null/undefined/falsy, error handling with Error objects/non-Error/strings/undefined, edge cases with special chars/nested paths/large IDs)

- If the plan touches Angular, does it use `MockTauriService` and `data-testid` selectors?

- If the plan touches Rust, are tests in `#[cfg(test)] mod tests` at the bottom of the source file?

- Does the plan affect E2E flows? Should existing E2E specs be updated? Does it respect spec execution order?

- **NEVER skip tests** — no `.skip`, `xit`, `xdescribe`. If a test needs to change, the plan must say how.

- Does the plan add `#[allow(dead_code)]` or `#[allow(...)]`? Forbidden.

- If the plan touches `entrypoint.sh` — does it include bats tests (`make test-entrypoint`)?

- If the plan touches `log_sanitizer.rs` — positive test (secret redacted) + false-positive test (normal text unchanged)?

**Severity: Missing error/edge case tests = HIGH. Missing test plan entirely = BLOCKER.**

### 5. DEPENDENCY ANALYSIS

Plans that modify a file without understanding its callers create cascading breakage.

Check:

- For each file the plan modifies, has the author identified ALL callers and dependents?

- If the plan changes a public function signature, struct, or trait — who else uses it? List the impact.

- If the plan modifies `compose.template.yml` — does it account for `render_compose()`, `SecurityCheck::run()`, `SecurityExpectedPaths`, and all tests that validate compose output?

- If the plan modifies `entrypoint.sh` — does it account for the `test-entrypoint` bats tests and the symlink strategy (with/without plugins)?

- If the plan modifies a Tauri command — does the Angular frontend model match? (`desktop/src/src/app/models/`)

- If the plan modifies MCP shared utilities — does every server that imports them still work?

- If the plan modifies the plugin manifest schema (`PluginManifest` in `plugin.rs`) — is the `speedwave-plugins` repo compatible?

- If the plan modifies resource limits or memory formulas — check `resources.rs` and all three platform paths.

- If the plan modifies `consts.rs` or `defaults.rs` — who reads those constants?

- Does the plan introduce new dependencies (crates, npm packages)? Will `make audit` pass? Are they MIT/Apache-2.0 compatible?

- If the plan modifies CI workflows (`.github/workflows/`) — does it account for all jobs (lint, test, desktop, audit, swift)?

- If the plan modifies the `ContainerRuntime` trait — does every implementation (`LimaRuntime`, `NerdctlRuntime`, `WslRuntime`) need updating?

**Severity: Unanalyzed dependency = HIGH. Cascade failures are the hardest bugs to diagnose.**

### 6. KISS — Complexity Check

Speedwave is a thin orchestration layer, not a framework.

Check:

- Is the plan reimplementing something that a CLI tool or existing library already does? (>100 lines for something that exists = red flag)

- Does it introduce unnecessary abstractions, wrappers, or indirection layers?

- Could the same result be achieved with fewer files, fewer functions, fewer lines?

- Does it add configuration options nobody asked for?

- Will a new contributor understand this change in 5 minutes?

- Does it add new CLI subcommands that should be Desktop-only? (Desktop handles `logs`, `status`, `stop` — CLI only has `check`/`update`/`self-update`/`addon install` + start)

**Severity: Over-engineering = MEDIUM.**

### 7. YAGNI — Speculative Features

Check:

- Does the plan include features not explicitly required by the task?

- Does it add "future extensibility" hooks, feature flags, or backward-compatibility shims?

- Does it add observability/logging beyond what's needed?

- Does it build token migration tools, status dashboards, or other features explicitly called out as YAGNI in CLAUDE.md?

- When tempted by a feature — does any user need this TODAY?

**Severity: Speculative feature = MEDIUM. Speculative feature that complicates security model = HIGH.**

### 8. DRY — Duplication Check

Check:

- Does the plan duplicate logic that already exists in `speedwave-runtime`?

- Does it duplicate MCP utilities that exist in `mcp-servers/shared/`?

- Does it hardcode values that are already defined as constants in `consts.rs`, `defaults.rs`, or config?

- Does it create a new abstraction for something the Rule of Three hasn't justified yet? (One occurrence: inline. Two: note. Three: extract.)

- Does it duplicate the SOLID pattern? (`Box<dyn ContainerRuntime>` — new platform = new impl, no `if/else` in callers)

**Severity: Duplication of SSOT logic = HIGH. Minor duplication = LOW.**

### 9. GIT WORKFLOW & RELEASE COMPATIBILITY

Check:

- Does the plan create commits following conventional commit format? (`feat(scope):`, `fix(scope):`, etc.)

- Does the plan's branch/PR target `dev` (not `main`)?

- If the plan involves multiple PRs, is the merge order correct?

- Does the plan affect `release-please` configuration or version files?

- Does the plan modify CI workflows (`.github/workflows/`)? Could it break existing checks?

- Will `make check` pass? (clippy + lint + type-check + format — not just `make test`)

- Does the plan leave TODO/FIXME/HACK/XXX markers? Forbidden.

- Does the plan leave `@deprecated` comments? Forbidden — rewrite the code.

- Does the plan bypass git hooks? (`--no-verify`, `HUSKY=0`, `core.hooksPath`) Forbidden.

- Does the plan bypass branch protection or CI? (`--admin`, disabling checks) Forbidden.

- Does the plan affect the squash merge requirement for PRs to `main`? (merge-strategy-check.yml)

- Does the plan affect the backmerge flow? (`main` → `dev`, regular merge, automated)

**Severity: CI-breaking change = HIGH. Convention violation = MEDIUM.**

### 10. DOCUMENTATION REQUIREMENTS

"Documentation is a delivery requirement — same as tests."

Check:

- Does the plan add a new feature? Is there a corresponding guide update in `docs/guides/`?

- Does the plan make an architectural decision? Is there an ADR in `docs/adr/` with footnoted sources?

- Does the plan change configuration options? Is `docs/getting-started/configuration.md` updated?

- Does the plan change CLI commands? Is `docs/guides/cli.md` updated?

- Does the plan change the plugin contract? Is CLAUDE.md's contract table updated?

- Does the plan change container topology? Is `docs/architecture/containers.md` updated?

- Does the plan change the security model? Is `docs/architecture/security.md` updated?

- Does the plan change platform behavior? Is `docs/architecture/platform-matrix.md` updated?

- Does the plan fill a placeholder `<!-- Content to be written -->`? Verify it replaces the placeholder with real content.

- Is every new doc file linked from `docs/README.md`?

- Is the ADR index (`docs/adr/README.md`) updated if a new ADR is added?

**Severity: Missing docs for user-facing change = HIGH. Missing ADR for architectural decision = HIGH.**

### 11. UPGRADE SAFETY

Users update Speedwave via Desktop auto-update or CLI `self-update`. After update, the new binary reads old persisted state. Plans that change persisted formats, inter-component contracts, or container structure without considering the N → N+1 transition break users silently.

Check:

**Persisted state compatibility:**

- Does the plan change the schema or structure of `~/.speedwave/config.json`? → New fields MUST use `#[serde(default)]`. Removed fields MUST be silently ignored (no `deny_unknown_fields`). Renamed fields need a migration path or backward-compatible alias. A new binary reading an old config must not crash or lose data.

- Does the plan change token paths (`~/.speedwave/tokens/<project>/<service>/`)? → Old tokens must remain valid after update. New path structure must be populated automatically, not require manual user action.

- Does the plan change `compose.template.yml` or `render_compose()` output? → Old running containers will be recreated with new compose on next `update`. Does `update_containers()` handle the transition (security gate + snapshot/rollback)? Will the new compose work with old container images that haven't been rebuilt yet?

- Does the plan change `bundle-manifest.json` or `bundle-state.json` format? → The reconcile pipeline (ADR-030) persists phases to disk. A new binary may read an old `bundle-state.json` left mid-reconcile by the previous version. Both old-format-read-by-new-binary and new-format-read-by-old-binary (downgrade) must be considered.

- Does the plan add, remove, or rename files in `~/.speedwave/`? → Orphaned files from old version must not cause errors or confusing behavior. New required files must be created automatically on first run, not assumed to exist.

**Container image compatibility:**

- Does the plan change container image names or tags? → Images are tagged with `bundle_id`, not `:latest`. Old images from previous bundle remain on disk. New containers must reference new tags. Mixed state (some images rebuilt, some not) during interrupted reconcile must not break the system.

- Does the plan change Containerfile build context or dependencies? → Image rebuild happens in reconcile phase 2 (`ImagesBuilt`). Does the build succeed with the new context? What if build fails — is the old image still usable?

- Does the plan change environment variables injected into containers? → Running containers from the old version won't have new env vars until recreated. Code inside containers must handle missing new env vars gracefully (default values, not crashes). Removing an env var that old container code depends on will break running containers during the transition window.

**CLI and API compatibility:**

- Does the plan change CLI subcommand names, flags, or output format? → Desktop UI or user scripts may parse CLI output. If the Desktop app updates before the container CLI, or vice versa, will both versions interoperate?

- Does the plan change Tauri command signatures or return types? → Tauri backend and Angular frontend are bundled together, so they update atomically. But verify the models in `desktop/src/src/app/models/` match. A mismatch causes runtime TypeScript errors.

- Does the plan change MCP Hub tool schemas or worker endpoints? → Claude may have cached the old tool list. The Hub must handle requests for tools that were removed or renamed in the new version without crashing.

**Plugin contract compatibility:**

- Does the plan change any element in the plugin contract table (CLAUDE.md)? → Existing installed plugins in `~/.speedwave/plugins/` were built against the old contract. After update, these plugins must continue to work. If the change is breaking — the plan must describe the coordination strategy with `speedwave-plugins` repo.

- Does the plan change `entrypoint.sh` plugin loading logic (symlinks, `SPEEDWAVE_PLUGINS` env var, `claude-resources/` directory)? → Old plugins ship with a specific `claude-resources/` layout. New entrypoint must handle both old and new layouts.

**Interrupted update recovery:**

- If the update is interrupted mid-way (crash, power loss, `kill -9`), is the system left in a recoverable state? → Check for atomic file writes (`.tmp` + rename pattern), persisted reconcile phases, snapshot before compose mutation. A partially-written config or compose file = corrupted system.

- Can the user recover by simply running `speedwave update` again? → The update flow must be idempotent. Running it twice must produce the same result as running it once. No "already migrated" flags that prevent retry.

**Rollback path:**

- If the new version has a critical bug, can the user install an older binary? → Describe what happens when an old binary reads state written by the new version. Will it fail gracefully (ignore unknown fields, skip unknown files) or corrupt data (overwrite new-format files with old format, delete unknown entries)?

- Are compose snapshots preserved so `rollback_containers()` can restore the previous container state?

**Severity: Persisted state incompatibility that crashes on update = BLOCKER. Missing env var defaults in containers = HIGH. No rollback consideration for state-changing feature = HIGH. Minor format change with `serde(default)` coverage = LOW.**

## Output Format

<analysis>

### BLOCKERS (must fix before implementation starts)

For each blocker:

- **[AXIS] Title** — concrete description of the problem

- **Evidence:** exact quote or reference from the plan

- **Risk:** what breaks on production if this is ignored

- **Fix:** specific action required to resolve

### HIGH SEVERITY

Same format as blockers.

### MEDIUM SEVERITY

Same format as blockers.

### LOW SEVERITY

Same format as blockers.

If there are no findings at a given severity level, omit that section entirely.

</analysis>

<verdict>

| Axis                              | Status      | Issues |
| --------------------------------- | ----------- | ------ |
| 0. CLAUDE.md Full Compliance      | PASS / FAIL | count  |
| 1. Security Model                 | PASS / FAIL | count  |
| 2. Architectural Integrity & SSOT | PASS / FAIL | count  |
| 3. Platform Coverage              | PASS / FAIL | count  |
| 4. Test Plan Adequacy             | PASS / FAIL | count  |
| 5. Dependency Analysis            | PASS / FAIL | count  |
| 6. KISS                           | PASS / FAIL | count  |
| 7. YAGNI                          | PASS / FAIL | count  |
| 8. DRY                            | PASS / FAIL | count  |
| 9. Git Workflow & Release         | PASS / FAIL | count  |
| 10. Documentation                 | PASS / FAIL | count  |
| 11. Upgrade Safety                | PASS / FAIL | count  |

**Overall: READY TO IMPLEMENT / NEEDS REVISION / REJECT**

- **READY TO IMPLEMENT** — zero blockers, zero high severity issues

- **NEEDS REVISION** — zero blockers, but high severity issues exist that must be addressed in the plan before implementation

- **REJECT** — at least one blocker exists; plan cannot proceed until blockers are resolved

If NEEDS REVISION or REJECT: list the specific items that must be addressed, in priority order.

**`new_issue_count`:** Include in structured output. Set to the total number of ALL genuinely new issues found in this review (including suppressed MEDIUM/LOW in verification mode). On the first review, equals the total issue count. On follow-up reviews, only count issues NOT present in the previous review context. This field drives convergence logic in the automated loop.

</verdict>

---

## Step 2 — Present Review Results

Present the full analysis and verdict to the user. If the verdict is NEEDS REVISION or REJECT, offer to help fix the plan.
