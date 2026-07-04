# Git Workflow Rules

## Branches, PRs, merges

| PR direction                  | Strategy            | Enforced by                         |
| ----------------------------- | ------------------- | ----------------------------------- |
| `feature/*` / `fix/*` → `dev` | Squash merge        | Convention                          |
| `dev` → `main`                | Squash merge        | `merge-strategy-check.yml`          |
| `main` → `dev` (backmerge)    | Force-push dev=main | `backmerge.yml` (automated)         |
| release-please PR on `main`   | Squash merge        | `merge-strategy-check.yml` (exempt) |

- **PRs always target `dev`** — never open a PR directly to `main`.
- **PR titles `dev → main`: ONLY `feat` or `fix`** (conventional commit form). Everything else — `chore`, `perf`, `refactor`, `docs`, `ci`, `test`, `build`, `style`, `revert` — is rejected by `scripts/validate-pr-title-main.sh` (via `merge-strategy-check.yml`), because only `feat`/`fix` guarantee a release-please version bump; a non-release type strands merged code outside the updater path. All types remain valid for PRs to `dev`. Release-please and backmerge PRs are exempt.
- **Backmerge is automated:** on release publish, `backmerge.yml` resets dev to main (force-push); if dev has new commits it falls back to a merge PR. Its version-file lists are derived from `release-please-config.json` `extra-files` — never hand-sync them; a new versioned artifact (e.g. a new worker's `package.json`) only needs adding to `extra-files`.
- Branch names: no `+` characters (rejected by the review action) — use `fix/foo`, `feature/foo`.
- **GitHub is public and English-only:** PR/issue/commit text always in English; never include internal issue-tracker keys or links (e.g. Jira) in PRs, commits, or code.
- No "Generated with Claude Code" / "Co-Authored-By: Claude" footers unless explicitly requested.
- Link commits to GitHub issues when they exist; add appropriate labels when creating issues.

## Git hooks — NEVER bypass

All of these are equally forbidden: `--no-verify`, `HUSKY=0` or any hook-disabling env var, repointing/renaming/deleting `.husky/` or `.git/hooks/`, `core.hooksPath` tricks. If a hook fails, fix the underlying issue; if you cannot, stop and ask the user. Zero exceptions.

Editing a committed hook body (`.husky/*`) in a reviewed PR is NOT a bypass — it passes the same PR + CI + branch-protection gates. But removed coverage must move to a required CI check, never be dropped: this is why pre-push runs only `make check-fmt` while the full suite is the required CI gate.

Caution: the pre-commit stash/pop (lint-staged) can drop uncommitted work when committing repeatedly — commit generated/edited files promptly rather than accumulating a dirty tree across multiple commits.

## Branch protection & CI — NEVER bypass

Forbidden: `gh pr merge --admin`, disabling or weakening protection rules, marking failing checks as expected. If CI fails — fix it, even when the failure is pre-existing or unrelated to your PR. If you cannot, stop and ask the user. Zero exceptions.

CI (`.github/workflows/test.yml`, on every PR to `dev`/`main` across macOS + Windows) is the real test gate: the required checks — not a local `make test` — are what block a merge. Never mark them not-required or route around them.
