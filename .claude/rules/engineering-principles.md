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

- **Comments: max 2 lines, written for the developer.** A comment states a behavior or constraint the code itself cannot show. Never narrate what the next line does, why your change is correct, review/audit context, or change history — that is noise the moment it merges. Doc comments (`//!`, `///`, JSDoc) also stay short (≤2 lines); if you feel the need for a paragraph, the content belongs in an ADR, not the code.
- **Every code change ships tests in the same commit**, covering four categories where applicable: happy path, edge cases (empty/null/boundary/Unicode), error paths (verify the right error, not just "doesn't crash"), and state transitions (before/after invariants; races for concurrent code). Skipping a non-applicable category is fine. This mandates _writing_ the tests, not running the full suite locally — CI executes them across macOS and Windows (pre-push runs only `make check-fmt`).
- **Never skip or neuter tests** — no `.skip`, `xit`, `xdescribe`, no renaming/moving test files to dodge failures. Fix the code or fix the test.
- **No marker comments** — no `TODO`/`FIXME`/`HACK`/`XXX`, no `@deprecated`. Implement the fix now or report it to the user.
- **No `#[allow(...)]` — a lint deviation is `#[expect(lint, reason = "...")]` on the narrowest item.** `#[expect]` warns when the expectation stops being fulfilled, so dead suppressions surface themselves; enforcement is `clippy::allow_attributes` + `clippy::allow_attributes_without_reason` = deny in both lint tables (root workspace + desktop). Sanctioned boundaries, each with a written reason: (1) `unwrap_used`/`expect_used` in test code (`#[cfg(test)] mod tests`, integration-test files); (2) `unsafe_code` on a narrowly-scoped OS-FFI boundary fn/module where every `unsafe` block carries a SAFETY comment (the `job_object.rs` / `fs_perms.rs` / `managed_config.rs` / `mic_permission_cmd.rs` pattern); (3) `print_stdout`/`print_stderr` on the CLI's single output sink (`main.rs::emit`) and the Desktop panic-hook last-resort fallback. Anything else: fix the code, not the lint. Cross-platform caution: an expectation is evaluated only when its item compiles — keep `#[expect]` on the cfg-gated item itself, or the other platform's build fails with `unfulfilled_lint_expectations`. Dead code is removed, not silenced: test-only items go behind `#[cfg(test)]`; serde-required-but-unread fields get a `_` prefix + `#[serde(rename = "...")]`.
- **Boy Scout Rule** — fix bugs, typos, and inconsistencies on sight; if too large for the current scope, report them, never ignore them.
- **Documentation = ADRs + rules.** Architectural decision → write an ADR in `docs/adr/`; a change that invalidates a `.claude/rules/` statement → fix the rule in the same commit (see `documentation.md` rules). No other documentation lives in-repo.
