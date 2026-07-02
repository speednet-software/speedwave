# Engineering Principles

These govern every decision — from architecture to a single function. When in doubt, apply them.

## KISS

Speedwave is a **thin orchestration layer**, not a reimplementation of Lima, nerdctl, or containerd. Prefer shelling out to the right tool. If you're writing >~100 lines for something an existing CLI already does — stop and reconsider. Prefer obvious code a new contributor understands in 5 minutes.

## YAGNI

Build only what's needed now — no speculative features, flags, or "future extensibility". The `speedwave` CLI stays minimal: start containers, launch Claude, `check`/`init`/`login`/`logout`/`update`/`self-update` and the `plugin` subcommands (`install`/`list`/`remove`/`enable`/`disable`) — nothing more (no `logs`/`status`/`stop`; Desktop handles those).

## DRY / SSOT

CLAUDE.md carries the SSOT registry and every alignment pair — edit the SSOT, never a call-site copy; never hand-write a path/value/model-string where an SSOT exists; a wrong literal is fixed by calling the SSOT, not by correcting the string. Same logic in two places → extract to `speedwave-runtime` (Rust) or `mcp-servers/shared/` (TS). Generated files (per-project compose, `installer-hooks.nsh`) are never hand-edited — change the template/renderer. Rule of Three for abstractions: one occurrence — inline; two — note it; three — extract.

## SOLID (applied here)

`LockedRuntime` is the public façade over the crate-internal `ContainerRuntime` trait; a new platform = a new trait impl, zero changes to public callers. Keep modules single-purpose; high-level crates depend on the façade, never on Lima/WSL2 directly.

## Code hygiene (hard rules)

- **Comments: max 2 lines, written for the developer.** A comment states a behavior or constraint the code itself cannot show. Never narrate what the next line does, why your change is correct, review/audit context, or change history — that is noise the moment it merges. Doc comments (`//!`, `///`, JSDoc) also stay short (≤2 lines); if you feel the need for a paragraph, the content belongs in an ADR, not the code.
- **Every code change ships tests in the same commit**, covering four categories where applicable: happy path, edge cases (empty/null/boundary/Unicode), error paths (verify the right error, not just "doesn't crash"), and state transitions (before/after invariants; races for concurrent code). Skipping a non-applicable category is fine.
- **Never skip or neuter tests** — no `.skip`, `xit`, `xdescribe`, no renaming/moving test files to dodge failures. Fix the code or fix the test.
- **No marker comments** — no `TODO`/`FIXME`/`HACK`/`XXX`, no `@deprecated`. Implement the fix now or report it to the user.
- **No lint suppression** — no `#[allow(...)]` anywhere; fix the underlying issue. Sole exception: `#[allow(clippy::unwrap_used, clippy::expect_used)]` on `#[cfg(test)] mod tests`. Dead code is removed, not silenced: test-only items go behind `#[cfg(test)]`; serde-required-but-unread fields get a `_` prefix + `#[serde(rename = "...")]`.
- **Boy Scout Rule** — fix bugs, typos, and inconsistencies on sight; if too large for the current scope, report them, never ignore them.
- **Documentation is a delivery requirement**, same as tests — new feature → update the guide; architectural decision → write an ADR (see `documentation.md` rules).
