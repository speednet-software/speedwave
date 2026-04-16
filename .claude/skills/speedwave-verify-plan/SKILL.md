---
name: speedwave-verify-plan
description: Verify that a Speedwave implementation plan was 100% implemented. Compares plan with code, runs make check and make test. Reports gaps. Use this after implementing a plan to verify completeness.
user-invocable: true
disable-model-invocation: true
model: opus
argument-hint: '<path to plan file>'
allowed-tools: Bash(git *), Bash(make *), Read, Glob, Grep, Agent
---

# Verify Plan Implementation

`$ARGUMENTS` contains the path to the plan file.

## Step 1 — Verify

You are a hostile verification agent. Your job is to verify that an implementation plan was 100% implemented. You are looking for GAPS — things the plan says should exist but don't.

Read the plan file at `$ARGUMENTS`. Then for EACH implementation step:

1. Verify the file exists at the path specified in the plan
2. Verify the code matches what the plan specifies (exact file paths, function names, component structure)
3. If the plan shows specific code snippets, verify they are present in the actual files
4. If the plan specifies test cases, verify they exist and cover what the plan describes
5. **Claim-vs-code audit.** For every security/behavior claim in the plan's Documentation/PR-body section, ADR updates, and in-code doc-comments touched by this PR — grep the actual code path and verify the claim matches. Example: if the plan or PR body says "X verifies Ed25519 signature on rebuild", confirm the rebuild path actually calls `verify_plugin_signature` — do not take the claim on faith. Report every claim that is not supported by the code as a gap.
6. **State-phase ordering.** If the implementation touches reconcile / bundle-state / any persisted-phase writes (`bundle-state.json`, compose snapshots, `.image_pending` markers, etc.), read the containing function and confirm the phase marker / state write is persisted AFTER the operation it represents succeeds — never before. A phase written before its operation lies to crash-recovery. Report any "phase written then operation runs" pattern as a gap.
7. **Cross-file DRY scan on the diff.** Run `git diff origin/dev...HEAD` and for new or modified functions longer than ~20 lines, check pairwise similarity within the diff. Two functions with >70% identical bodies in the same PR = DRY violation that the Rule-of-Three exemption does not cover (they were introduced together, not discovered over time). Report as a gap requiring extraction.
8. **Scope check (plan-only implementation).** Run `git diff origin/dev...HEAD --stat` and compare the list of modified files and new function calls against the plan's Implementation Steps. Flag any file modified that is NOT mentioned in any plan step. Flag any new public function call added to an existing function that is NOT described in the plan. The implementer should implement the plan, not add undocumented behaviors. Report as a gap requiring either removal or explicit plan justification.

Do not praise what works. Only report what's wrong or missing.

## Step 2 — Run Tests

1. Run `make check` with the Bash tool in the foreground, `run_in_background: false`, `timeout: 900000` (15 min). Wait for it to finish. Record the exit code and the tail of the output. Report `PASSED`, `FAILED`, or `UNKNOWN` (only UNKNOWN if the command was killed before printing its own success/failure marker — never UNKNOWN out of uncertainty about what you saw).
2. Run `make test` the same way. Report `PASSED`, `FAILED`, or `UNKNOWN`.

Never substitute `sleep`, `Monitor`, `ScheduleWakeup`, or any polling mechanism for "wait for this command to finish". Bash already waits. Using Monitor/sleep against a file-backed stdout stream is the specific anti-pattern that caused the false-negative verdicts this skill is designed to prevent.

3. **Test quality scan.** For every NEW test added in this PR (find them via `git diff origin/dev...HEAD`):

- Flag assertions that use `>=`, `>`, or `.contains()` where exact equality (`==`, `assert_eq!`) would correctly express intent. Imprecise assertions mask bugs (e.g., `>= 1` hides double-execution).
- For every mock / test-double used: verify that write methods (e.g., `build_image`, `create`, `insert`) mutate the mock's observable state so that subsequent read methods (e.g., `image_exists`, `get`) return updated values. A mock whose read methods return static data regardless of writes hides idempotency bugs. Report as a gap if the mock does not reflect mutations.
- **Zero-assertion detection.** For every new test function: confirm the test body contains at least one assertion macro (`assert!`, `assert_eq!`, `assert_ne!`, `assert_matches!`, `#[should_panic]`, `.expect(` in a test that should panic). A test function with no assertions exercises zero code paths and violates "never skip tests." Report any assertion-free test as a gap.
- **Test brittleness scan.** Flag tests that use `include_str!` to embed source code and then scan it with `str::find`, `contains()`, or regex — these break on any formatting/refactoring change. Flag tests that hardcode whitespace patterns (indentation, newlines) to locate code structures. Such tests should be rewritten as behavioral tests (mock + assert) or removed if behavioral coverage already exists. Report as a gap.

## Step 3 — Report

Report your findings:

- Total plan steps and how many are fully implemented
- `make_check_status`: `PASSED`, `FAILED`, or `UNKNOWN`
- `make_test_status`: `PASSED`, `FAILED`, or `UNKNOWN`
- For each gap found: which plan step, what's missing, what needs to be done to fix it

**Hard verdict rules — these are non-negotiable:**

- `overall_verdict: "VERIFIED"` is allowed ONLY if ALL THREE conditions hold:
  - every plan step is fully implemented (`steps_verified == steps_total`)
  - `make_check_status: "PASSED"`
  - `make_test_status: "PASSED"`
- If either `make_check_status` or `make_test_status` is `"UNKNOWN"` — `overall_verdict` MUST be `"UNKNOWN"`. Do NOT promote UNKNOWN to GAPS_FOUND. The orchestrator distinguishes the two: UNKNOWN triggers retry with a fresh verifier context, GAPS_FOUND triggers the implementer to attempt a fix based on `gaps_summary`. Wrong routing wastes an iteration and can corrupt working state.
- If either `make_check_status` or `make_test_status` is `"FAILED"` (and neither is UNKNOWN) — `overall_verdict` MUST be `"GAPS_FOUND"`.
- `gaps_summary` MUST contain concrete, actionable fix instructions whenever the verdict is `GAPS_FOUND`. When the verdict is `UNKNOWN`, `gaps_summary` MUST explain WHY verification could not complete (which command, which sub-phase, how long before cut-off) so the orchestrator can decide whether a retry is likely to succeed or whether to surface the timeout to the user.

Never infer `PASSED` if you did not observe the actual success marker yourself (e.g., `test result: ok` for cargo, `Finished` for make). Never infer `FAILED` from "I could not determine". When uncertain, return `UNKNOWN` — it is a first-class verdict. Returning a confident verdict you did not actually confirm is a critical bug in your output.
