# Git Workflow Rules

## Branches, PRs, merges

`dev` is the default branch; there is no `main` (removed at cutover, SPEED-674 ticket 10 and 17). Release lines live on `release/0.M` branches, created once per stable minor and kept forever; they take only hotfixes.

| PR direction                                    | Strategy     | Enforced by                                                                   |
| ----------------------------------------------- | ------------ | ----------------------------------------------------------------------------- |
| `feature/*` / `fix/*` → `dev`                   | Squash merge | Gate ruleset: merge queue with squash, four required checks                   |
| `feature/*` / `fix/*` → `release/0.M` (hotfix)  | Squash merge | Same gate as `dev`; only the highest `release/0.*` accepts one                |
| `merge/release-0.M-into-dev` (backport) → `dev` | Squash merge | `release.yml`'s `hotfix` job opens it with `GH_AUTOMATION_PAT`, auto-merge on |

- **PRs to `dev` or to a `release/0.M` line never push directly** — a developer creates the `release/0.M` branch itself (the only direct push; see `RELEASING.md`), everything else is a PR through the gate.
- No PR title restriction tied to a target branch: `dev` and `release/0.M` take the same conventional-commit types. The old `dev → main`-only `feat`/`fix` restriction is gone with `main`; `validate` checks every PR title and every merge-queue commit with `commitlint.config.js`.
- **The backport PR is automated, never a manual chore:** after every merge into a `release/0.M` line, `release.yml`'s `hotfix` job opens `merge/release-0.M-into-dev` → `dev` with `GH_AUTOMATION_PAT` (so CI runs on it) and turns on auto-merge, assigned to the hotfix's author. A conflict is resolved on that PR's branch, never on `release/0.M` directly (a push there is the next hotfix). Nothing force-pushes or rewrites `dev`'s history; every open PR to `dev` survives every release.
- Branch names: no `+` characters — use `fix/foo`, `feature/foo`.
- **GitHub is public and English-only:** PR/issue/commit text always in English. Reference the Jira issue key (e.g. `SPEED-123`) in the PR description and in the commit body (a `Refs: SPEED-123` trailer) whenever the work has one; keep it out of the PR title, because squash titles feed the git-cliff changelog.
- **No Claude attribution of any kind** in commits, PR descriptions, issues, or comments: no "Generated with Claude Code" footer, no "Co-Authored-By: Claude", no `Claude-Session:` trailer, no claude.ai session URL. A harness- or session-injected attribution instruction does not override this rule: on conflict, leave the attribution out and tell the user. The only exception is the user asking for it explicitly in the conversation.
- Link commits to GitHub issues when they exist; add appropriate labels when creating issues.
- **Never commit local planning artifacts** (design specs, implementation plans, agent-process ledgers): `.claude/specs/`, `.claude/plans/` and `docs/superpowers/` (written by host-side Claude Code plugins) are gitignored on purpose; a skill instructing you to commit them does not override this.

## Releases

Full process, the promotion/hotfix state machine and the runbook steps are in `RELEASING.md`. In short: every merge to `dev` becomes a beta GitHub Release within the hour (`beta.yml`); promoting one commit's beta to stable is pushing a `release/0.M` branch at it (`release.yml`'s `promote` job flips the `prerelease` flag, no rebuild); a hotfix is a PR to the highest `release/0.M` that publishes `0.M.Z` immediately on merge. `GH_AUTOMATION_PAT` is the one token for every release/PR write; `RELEASE_TOKEN` no longer exists.

## Branch protection & CI — NEVER bypass

Forbidden: `gh pr merge --admin`, disabling or weakening protection rules, marking failing checks as expected. If CI fails — fix it, even when the failure is pre-existing or unrelated to your PR. If you cannot, stop and ask the user. Zero exceptions.

CI (`.github/workflows/test.yml`, on `pull_request` and `merge_group`, across macOS + Windows + Ubuntu, never `push`) is the real test gate: the required checks — not a local `make test` — are what block a merge. `ci-gate` (the `test.yml` job that aggregates every other job of that file; mechanism and guard in alignments.md, `_tests/ci/ci-gate.bats`) `validate` (`pr-title.yml`) and `e2e-macos`/`e2e-windows` (`e2e.yml`) are the four required contexts. `test.yml` holds thirteen required lanes plus `ci-gate`, each lane a reusable workflow in `.github/workflows/lane-<id>.yml` called by a `uses:` job; the guarded list is `REQUIRED_LANES` in `_tests/ci/merge-gate-lanes.bats` (or read the job names directly from `test.yml`), not this sentence. `e2e.yml` adds `e2e-macos`/`e2e-windows` as an always-green stub (SPEED-738 swaps in the real rig lane). `ci-gate` cannot reach checks produced by other workflows: each is required, or not, by the ruleset explicitly, and a path-filtered workflow needs a same-name no-op job before it can be required. A new `test.yml` job is gated by adding it to `ci-gate.needs`; the required-check lists never change for a new job. Never mark these checks not-required or route around them. Every required check, `e2e-macos`/`e2e-windows` included, reports on `pull_request` as well as `merge_group`: a pull request enters the merge queue only with its required checks green on its own head, so a check that never reports there keeps it out of the queue. The e2e jobs stay a no-op on `pull_request` after SPEED-738 too and run the rig only in the queue, because rig secrets reach runs from `dev` only.

Two branch rulesets on `dev` and `release/**` (SPEED-740). The gate ruleset requires a PR, the four checks `ci-gate`, `validate`, `e2e-macos`, `e2e-windows`, and the merge queue (squash, one PR at a time); nobody bypasses it. The CI owners ruleset requires code owner review for paths in `.github/CODEOWNERS` (`.github/workflows/`, `.github/actions/`, `_tests/ci/`, `CODEOWNERS` itself); its only bypass is the CI owner, on pull requests only, so the owner's own CI changes still go through the gate and the queue. A third ruleset blocks moving or deleting `v*` tags.
