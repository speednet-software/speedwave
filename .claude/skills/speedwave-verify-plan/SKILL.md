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

Do not praise what works. Only report what's wrong or missing.

## Step 2 — Run Tests

1. Run `make check` — report pass/fail
2. Run `make test` — report pass/fail

## Step 3 — Report

Report your findings:

- Total plan steps and how many are fully implemented
- Whether `make check` passed
- Whether `make test` passed
- For each gap found: which plan step, what's missing, what needs to be done to fix it

**Hard verdict rules — these are non-negotiable:**

- `overall_verdict: "VERIFIED"` is allowed ONLY if ALL THREE conditions hold:
  - every plan step is fully implemented (`steps_verified == steps_total`)
  - `make_check_passed: true`
  - `make_test_passed: true`
- If ANY of the three fails, `overall_verdict` MUST be `"GAPS_FOUND"`.
- `gaps_summary` MUST contain concrete, actionable fix instructions whenever the verdict is `GAPS_FOUND`, or whenever `make_check_passed`/`make_test_passed` is false. Paste the actual failing output from make — do not summarize vaguely.

Returning `VERIFIED` with a failing check or test is a critical bug in your output and will cause the orchestrator to ship broken code. Double-check the booleans before emitting the structured result.
