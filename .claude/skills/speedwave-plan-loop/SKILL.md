---
name: speedwave-plan-loop
description: Automated plan → review → implement → verify loop in an isolated git worktree. Creates a fresh branch, writes/reviews plan, implements code, verifies 100% completion. All agents run in isolated headless contexts (claude -p).
user-invocable: true
disable-model-invocation: true
argument-hint: '<task description> [--plan-only] [--no-worktree] [--branch NAME] [--base BRANCH] [--max-iter N] [--max-impl-iter N] [--plan-name NAME]'
allowed-tools: Bash
---

# Automated Plan → Review → Implement → Verify Loop

Runs `.claude/scripts/plan-loop.sh` which creates an isolated worktree and orchestrates `claude -p` sessions:

**Phase 0: SETUP** — creates git worktree + branch from `origin/dev`

**Phase 1: PLAN** — writer creates plan, hostile reviewer iterates until approved

**Phase 2: IMPLEMENT → VERIFY** — implementer codes from plan, verifier checks completeness + tests

## Usage

`$ARGUMENTS` is passed directly to `plan-loop.sh`.

```
/speedwave-plan-loop add healthcheck endpoint to MCP Hub
/speedwave-plan-loop --plan-only add healthcheck endpoint to MCP Hub
/speedwave-plan-loop --plan-name hub-healthcheck --branch feat/hub-health add healthcheck
/speedwave-plan-loop --no-worktree --impl-only /tmp/speedwave-plans/plan.md
```

## Options

- `--max-iter N` — Phase 1: max write-review iterations (default: 12)
- `--max-impl-iter N` — Phase 2: max implement-verify iterations (default: 5)
- `--plan-name NAME` — plan filename stem and branch suffix (default: YYYY-MM-DD-plan)
- `--plan-only` — run Phase 1 only (plan writing, no implementation)
- `--impl-only <path>` — run Phase 2 only (plan already exists at path)
- `--no-worktree` — skip worktree creation, work in current directory
- `--branch NAME` — branch name (default: feat/<plan-name>)
- `--base BRANCH` — base branch for worktree (default: origin/dev)

Run the script now:

```bash
bash .claude/scripts/plan-loop.sh $ARGUMENTS
```
