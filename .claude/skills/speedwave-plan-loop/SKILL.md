---
name: speedwave-plan-loop
description: Automated plan → review → implement → verify loop. Phase 1 writes and reviews plans until approved. Phase 2 implements the plan and verifies 100% implementation with tests. All agents run in isolated headless contexts (claude -p).
user-invocable: true
disable-model-invocation: true
argument-hint: '<task description> [--plan-only] [--impl-only <path>] [--max-iter N] [--max-impl-iter N] [--plan-name NAME]'
allowed-tools: Bash
---

# Automated Plan → Review → Implement → Verify Loop

Runs `scripts/plan-loop.sh` which orchestrates isolated `claude -p` sessions:

**Phase 1: PLAN**

1. **Writer** (persistent session, read-only) creates/revises an implementation plan
2. **Reviewer** (fresh context, read-only) hostilely reviews against 12 verification axes
3. Repeats until `READY_TO_IMPLEMENT` or `--max-iter`

**Phase 2: IMPLEMENT → VERIFY** 4. **Implementer** (persistent session, full permissions) codes from the approved plan 5. **Verifier** (fresh context) checks 100% implementation + runs `make check` + `make test` 6. Repeats until `VERIFIED` or `--max-impl-iter`

## Usage

`$ARGUMENTS` is passed directly to `plan-loop.sh`.

```
/speedwave-plan-loop add healthcheck endpoint to MCP Hub
/speedwave-plan-loop --plan-only add healthcheck endpoint to MCP Hub
/speedwave-plan-loop --impl-only .claude/plans/2026-04-01-plan.md
/speedwave-plan-loop --plan-name hub-healthcheck --max-iter 6 --max-impl-iter 3 add healthcheck
```

## Options

- `--max-iter N` — Phase 1: max write-review iterations (default: 12)
- `--max-impl-iter N` — Phase 2: max implement-verify iterations (default: 5)
- `--plan-name NAME` — plan filename stem (default: YYYY-MM-DD-plan)
- `--plan-only` — run Phase 1 only (plan writing, no implementation)
- `--impl-only <path>` — run Phase 2 only (plan already exists at path)

Run the script now:

```bash
bash .claude/scripts/plan-loop.sh $ARGUMENTS
```
