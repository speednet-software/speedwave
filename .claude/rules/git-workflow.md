# Git Workflow Rules

## Git Hooks

**NEVER bypass git hooks.** This includes ALL of the following techniques — they are ALL equally forbidden:

- `--no-verify` flag on commit or push
- `core.hooksPath=/dev/null` or pointing `core.hooksPath` to an empty/fake directory
- `HUSKY=0` or any environment variable that disables hooks
- Temporarily renaming, moving, or deleting `.husky/` or `.git/hooks/`
- Any other creative workaround that results in hooks not executing

Git hooks exist to catch problems early. If a hook fails, **fix the underlying issue** (e.g. missing tool in PATH, failing test, lint error). If you cannot fix it, **stop and ask the user** — never silently bypass the hook. There are zero exceptions to this rule.

## Tests

**Every piece of code must be covered by tests.** All functions, methods, branches, and error paths must have corresponding test cases. When writing or modifying code, always write or update tests in the same commit. Never leave code untested — if it's worth writing, it's worth testing.

### Required test coverage categories

Every new or modified function must have tests covering **all four categories** where applicable:

1. **Happy path** — expected inputs produce expected outputs. The basic "it works" case.
2. **Edge cases** — boundary values, empty inputs, `null`/`undefined`/`None`, zero-length collections, maximum values, single-element collections, off-by-one boundaries, Unicode/special characters in strings.
3. **Error paths** — invalid inputs, malformed data, network failures, permission errors, timeouts, missing files, disk full, concurrent access violations. Verify that errors are reported correctly (right error type, message, status code) — not just that "it doesn't crash."
4. **State transitions** — when the function mutates state, test the before/after invariants. For concurrent code, test race conditions and ordering guarantees where applicable.

If a category does not apply (e.g., a pure function has no state transitions), skip it — but document **why** in a brief test comment if it's not obvious.

**NEVER skip tests to work around failures.**

- Do not use `.skip`, `xit`, `xdescribe`, or rename files to `.skip`
- Do not remove or move test files to bypass failing tests
- If a test fails — fix the code or fix the test, never skip it
- Skipping tests masks real problems and leads to regressions
- If a test is for an unimplemented feature — implement the feature or remove the test (no skip!)

## Boy Scout Rule

**Always leave the code in a better state than you found it.**

- If you encounter a bug, typo, inconsistency, or problem in code — fix it immediately
- This applies to: logic errors, wrong types, missing validations, inconsistent names, dead code
- Small fixes "along the way" prevent accumulation of technical debt
- If the fix is too large for the current scope — report it to the user, but never ignore it

## Branch Protection & CI

**NEVER bypass branch protection or CI requirements.** This includes ALL of the following — they are ALL equally forbidden:

- `gh pr merge --admin` to bypass failing status checks
- Merging with `--admin` flag for any reason
- Disabling or weakening branch protection rules to unblock a merge
- Marking failing checks as "expected to fail" without fixing them
- Any other creative workaround that results in unverified code reaching `main`

If CI fails — **fix the CI**, even if the failure is pre-existing or unrelated to your PR. If you cannot fix it, **stop and ask the user**. There are zero exceptions to this rule.

## General

- Never leave `@deprecated` comments in code — rewrite the code instead of adding comments
- Never leave `TODO`, `FIXME`, `HACK`, `XXX`, or similar marker comments in code — either implement the fix now or report it to the user. Marker comments rot and become invisible tech debt.
- Link commits to GitHub issues when they exist
