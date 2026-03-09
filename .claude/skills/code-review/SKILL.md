---
name: code-review
description: Comprehensive code review using specialized skills
disable-model-invocation: true
model: opus
---

# Comprehensive PR Review

Run a comprehensive pull request review using multiple specialized skills, each focusing on a different aspect of code quality.

## Architecture

You (the main agent) directly launch 13 review agents in parallel, wait for all results, then launch 1 aggregator agent to produce a concise summary.

**Why not an orchestrator agent?** Sub-agents are LLMs — they optimize and may skip launching child agents, doing the review themselves instead. By launching all 13 directly from the main context, you guarantee each skill actually runs.

## Review Workflow

### Step 1 — Determine Review Scope

- Check `git status` and `git branch --show-current` to identify changed files
- Determine the diff command (`DIFF_CMD`), e.g.:
  - `git diff` (unstaged changes)
  - `git diff --cached` (staged changes)
  - `git diff HEAD~N..HEAD` (last N commits)
  - `git diff main...HEAD` (branch vs main)
- If unclear, ask the user what to review

### Step 2 — Launch 13 Review Agents in Parallel

In a **single message**, launch exactly 13 Task agents using these parameters for each:

- `subagent_type: "general-purpose"`
- `run_in_background: true`
- `model: "sonnet"` (fast, sufficient for individual reviews)
- `name: "review-SKILL_NAME"` (for identification)

Use this prompt template for each (replace `SKILL_NAME` and `DIFF_CMD`):

```
Use the Skill tool to invoke 'SKILL_NAME'. Review changes from: DIFF_CMD
```

The 13 skills to launch (ALL in one message, no exceptions):

1. `code-review-basic`
2. `code-review-documentation-checker`
3. `code-review-duplication-detector`
4. `code-review-kiss-detector`
5. `code-review-yagni-detector`
6. `code-review-solid-detector`
7. `code-review-test-analyzer`
8. `code-review-comment-analyzer`
9. `code-revew-silent-failure-hunter`
10. `code-review-type-design-analyzer`
11. `code-review-simplifier`
12. `code-review-security-checker`
13. `code-review-ssot-detector`

### Step 3 — Wait for All Results

All 13 agents run in background. You will be notified as each completes. Wait until all 13 have finished before proceeding.

### Step 4 — Launch Aggregator Agent

Once all 13 are done, launch 1 final Task agent (`subagent_type: "general-purpose"`, `run_in_background: false`, `model: "sonnet"`) with this prompt:

````
You are a code review aggregator. Below are 13 review reports from specialized skills. Produce a single summary.

## Reports

PASTE_ALL_13_RESULTS_HERE

## Output Format

```markdown
# PR Review Summary

## Critical Issues (X found)
- [skill-name]: Issue description [file:line]

## Important Issues (X found)
- [skill-name]: Issue description [file:line]

## Suggestions (X found)
- [skill-name]: Suggestion [file:line]

## Skills That Found No Issues
- skill-name-1, skill-name-2, ...
```

Rules:
- Deduplicate: if multiple skills flag the same issue, mention it once with all skill names
- Categorize by severity: Critical > Important > Suggestion
- Include file:line references where available
- Keep descriptions concise (1-2 sentences each)
- List skills that found no issues at the bottom
- Return ONLY the markdown summary, nothing else
````

Replace `PASTE_ALL_13_RESULTS_HERE` with the actual text output from each of the 13 agents, clearly labeled with the skill name.

### Step 5 — Display Results

Show the aggregator's summary directly to the user.
