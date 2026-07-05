---
name: speedwave-code-review
description: Comprehensive multi-dimensional code review — runs every specialized code-review skill in parallel and aggregates verified results
argument-hint: [diff-scope]
disable-model-invocation: true
---

# Comprehensive Code Review

Run a comprehensive review of a changeset using the specialized worker skills below, each focusing on a different dimension of code quality.

## Worker Skills

This list is the single source of truth for what to launch — one review agent per entry, no exceptions:

- code-review-basic
- code-review-change-impact
- code-review-comment-analyzer
- code-review-documentation-checker
- code-review-duplication-detector
- code-review-kiss-detector
- code-review-performance-concurrency
- code-review-security-checker
- code-review-silent-failure-hunter
- code-review-solid-detector
- code-review-ssot-detector
- code-review-test-analyzer
- code-review-type-design-analyzer
- code-review-yagni-detector

## Architecture

You (the main agent) launch all review agents in parallel directly, wait for the results, then launch one aggregator agent. Do not delegate the launching to an orchestrator sub-agent: sub-agents are LLMs — they optimize and may skip launching child agents, doing the review themselves instead. Launching every worker from the main context guarantees each skill actually runs.

Never pass a `model` parameter to any agent launch — every agent inherits the session's model.

## Step 1 — Determine and Materialize the Review Scope

Scope argument (empty if none was given): `$ARGUMENTS`

If a scope argument was given, treat it as the scope — a git range, a diff command, or a path to a patch file. Otherwise determine the scope:

- Check `git status --porcelain` and `git branch --show-current`.
- Choose the diff command, e.g.:
  - `git diff HEAD` (staged + unstaged — the usual "review my working tree")
  - `git diff` / `git diff --cached` (unstaged only / staged only)
  - `git diff <base>...HEAD` (branch review — resolve `<base>` first, e.g. via `git symbolic-ref refs/remotes/origin/HEAD`, or ask the user; do not assume it is named `main`)
  - `git diff HEAD~N..HEAD` (last N commits)
- Include untracked files: for each untracked file listed by `git status --porcelain`, run `git add -N <file>` so it appears in the diff (tell the user you did this), or pass the files for full-file review.
- If unclear, ask the user what to review.

Materialize the scope once: run the chosen command a single time and write its output to a temporary file outside the repository (e.g. under `/tmp`). Every agent reads this snapshot instead of re-running the diff, so edits made while the review runs cannot skew the results.

- **Empty diff:** report that there is nothing to review and stop — do not launch any agents.
- **Very large diff:** tell the user, and split the review into consecutive runs by directory or subsystem instead of overflowing every agent with one giant snapshot.

## Step 2 — Launch the Review Agents in Parallel

In a single message, launch one Task agent per worker skill listed above:

- `subagent_type: "general-purpose"`
- `run_in_background: true`
- `name: "review-SKILL_NAME"` (for identification)
- no `model` parameter

Use this prompt template for each (replace `SKILL_NAME` and `DIFF_FILE`):

```
Use the Skill tool to invoke 'SKILL_NAME' and follow that skill exactly.
Review the changes in the diff file at DIFF_FILE — read that file; do not re-run git diff. Read surrounding code from the working tree as needed for context.
Your final message must be exactly the skill's report, starting with its '# SKILL_NAME report' heading. If you could not load or apply the skill, reply with 'FAILED: <reason>' instead.
```

## Step 3 — Collect Results and Handle Failures

Wait for the agents to finish, handling failures instead of stalling:

- If an agent errors, replies `FAILED`, or returns something that is not a report (empty output, an error trace, a missing report heading), retry it once; if it fails again, record that skill as FAILED and move on.
- If one agent is still running long after all the others have finished, stop it and record that skill as TIMED OUT — never block the whole review on a single straggler.
- Never paste invalid output into the aggregation step.

## Step 4 — Aggregate and Verify

Launch one final Task agent (`subagent_type: "general-purpose"`, `run_in_background: false`, no `model` parameter) with this prompt:

````
You are a code review aggregator. Below are review reports from specialized skills, one per skill, each labeled with its skill name. Produce a single summary.

## Reports

PASTE_ALL_RESULTS_HERE

## Rules

- Deduplicate: if multiple skills flag the same issue, mention it once with all skill names.
- Verify before publishing: for every Critical and Important finding, read the referenced file at the referenced line; drop any finding that does not match the actual code.
- Keep descriptions concise (1-2 sentences each) with `file:line` references.

## Output Format

```markdown
# Review Summary

## Critical (X found)

- [skill-name]: Issue description [file:line]

## Important (X found)

- [skill-name]: Issue description [file:line]

## Suggestions (X found)

- [skill-name]: Suggestion [file:line]

## Skills With No Findings

- skill-name-1, skill-name-2, ...

## Skills That Did Not Complete

- skill-name: FAILED or TIMED OUT — <reason> (omit this section when every skill completed)
```

Return ONLY the markdown summary, nothing else.
````

Replace `PASTE_ALL_RESULTS_HERE` with the valid reports, each preceded by its skill name. List failed or timed-out skills yourself in the final section — never paste their raw output.

## Step 5 — Display Results

Show the aggregator's summary directly to the user.
