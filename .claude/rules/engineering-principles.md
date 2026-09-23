# Engineering Principles

These govern every decision — from architecture to a single function. When in doubt, apply them.

## KISS

Speedwave is a **thin orchestration layer**, not a reimplementation of Lima, nerdctl, or containerd. Prefer shelling out to the right tool. If you're writing >~100 lines for something an existing CLI already does — stop and reconsider. Prefer obvious code a new contributor understands in 5 minutes.

## YAGNI

Build only what's needed now — no speculative features, flags, or "future extensibility". The `speedwave` CLI stays minimal: start containers, launch Claude, `check`/`init`/`login`/`logout`/`update`/`self-update` and the `plugin` subcommands (`install`/`list`/`remove`/`enable`/`disable`) — nothing more (no `logs`/`status`/`stop`; Desktop handles those).

## DRY / SSOT

`ssot-registry.md` carries the SSOT catalog and `alignments.md` every alignment pair — edit the SSOT, never a call-site copy; never hand-write a path/value/model-string where an SSOT exists; a wrong literal is fixed by calling the SSOT, not by correcting the string. Same logic in two places → extract to `speedwave-runtime` (Rust) or `mcp-servers/shared/` (TS). Generated files (per-project compose, `installer-hooks.nsh`) are never hand-edited — change the template/renderer. Rule of Three for abstractions: one occurrence — inline; two — note it; three — extract.

## SOLID (applied here)

`LockedRuntime` is the public façade over the crate-internal `ContainerRuntime` trait; a new platform = a new trait impl, zero changes to public callers. Keep modules single-purpose; high-level crates depend on the façade, never on Lima/WSL2 directly.

## Code hygiene (hard rules)

- **Write no comments.** This codebase is read by AI agents with full repository context, not scanned line-by-line by a human waiting on prose — a comment explaining what/why is redundant the moment an agent can just read the code, the git history, and the ADRs. Default to zero comments in every language (Rust, TS, Swift, shell, YAML, Makefile, config files — no exceptions by file type). Add one ONLY when something other than a human reader requires it: doc comments consumed by tooling (`///`, `//!`, JSDoc summaries — required by `missing_docs`/`jsdoc/require-jsdoc`, capped at ~2 lines of prose; structured `@param`/`@returns` tags follow the eslint `jsdoc` rules), `// SAFETY:` on every `unsafe` block, `// SSOT-allow: <reason>` drift-test escape hatches, and directives a tool itself parses (shebangs, `# shellcheck disable=...`, `#Requires`, `// swift-tools-version:`, `eslint-disable`/`@ts-expect-error`/`@ts-ignore`). When a linter would otherwise demand a placeholder comment on an intentionally-empty branch (e.g. `no-empty`), restructure the code instead — merge the branches, invert the condition, configure the narrowest lint exception (`allowEmptyCatch`) — never add a comment just to satisfy it. Rationale, trade-offs, and "why this is correct" go in the PR description or an ADR, never in the code.
- **Every code change ships tests in the same commit**, covering four categories where applicable: happy path, edge cases (empty/null/boundary/Unicode), error paths (verify the right error, not just "doesn't crash"), and state transitions (before/after invariants; races for concurrent code). Skipping a non-applicable category is fine. This mandates _writing_ the tests, not running the full suite locally — CI executes them across macOS and Windows (pre-push runs only `make check-fmt`).
- **Never skip or neuter tests** — no `.skip`, `xit`, `xdescribe`, no renaming/moving test files to dodge failures. Fix the code or fix the test.
- **No marker comments** — no `TODO`/`FIXME`/`HACK`/`XXX`, no `@deprecated`. Implement the fix now or report it to the user.
- **No `#[allow(...)]` — a lint deviation is `#[expect(lint, reason = "...")]` on the narrowest item.** `#[expect]` warns when the expectation stops being fulfilled, so dead suppressions surface themselves; enforcement is `clippy::allow_attributes` + `clippy::allow_attributes_without_reason` = deny in all three lint tables (root workspace + desktop + proxy). Sanctioned boundaries, each with a written reason: (1) `unwrap_used`/`expect_used` in test code (`#[cfg(test)] mod tests`, integration-test files); (2) `unsafe_code` on a narrowly-scoped OS-FFI boundary fn/module where every `unsafe` block carries a SAFETY comment (the `job_object.rs` / `fs_perms.rs` / `managed_config.rs` / `mic_permission_cmd.rs` pattern); (3) `print_stdout`/`print_stderr` on the CLI's single output sink (`main.rs::emit`) and cross-process integration-test child binaries reporting failures on stderr (`build_lock_cross_process.rs`, `compose_lock_cross_process.rs`). Anything else: fix the code, not the lint. Cross-platform caution: an expectation is evaluated only when its item compiles — keep `#[expect]` on the cfg-gated item itself, or the other platform's build fails with `unfulfilled_lint_expectations`. Dead code is removed, not silenced: test-only items go behind `#[cfg(test)]`; serde-required-but-unread fields get a `_` prefix + `#[serde(rename = "...")]`.
- **Boy Scout Rule** — fix bugs, typos, and inconsistencies on sight; if too large for the current scope, report them, never ignore them.
- **Documentation = ADRs + rules.** Architectural decision → write an ADR in `docs/adr/`; a change that invalidates a `.claude/rules/` statement → fix the rule in the same commit (see `documentation.md` rules). No other documentation lives in-repo.
