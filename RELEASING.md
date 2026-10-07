# Releasing Speedwave

Speedwave ships a beta on every merge to `dev` and promotes a tested beta to stable by creating a `release/0.M` branch. There is no `main`, no release-please, and no manual version bump.

## Channels and versions

- **`dev`** is the default and only long-lived integration branch. Every merge produces a beta `GitHub Release` within the hour: `v0.<M+1>.0+N`, flagged `prerelease`, with macOS (Apple Silicon) and Windows installers, CLI archives and `latest.json`. `N` is the number of commits reachable from the tip of `dev` (`git rev-list --count HEAD`); it never resets.
- **`release/0.M`** is the line for stable minor `M`. It is created once, by pushing it at a commit on `dev` that already has a beta release — this is the one manual step in the whole process, open to anyone with write access. The push flips that exact beta's `prerelease` flag to `false` and sets `make_latest`: same build, same tag, same bytes, no rebuild.
- A **hotfix** is a PR to the highest `release/0.M` line. Its merge publishes `0.M.Z` immediately, with no beta stage, and opens a PR that backports it into `dev`.
- The version always comes from git (`crates/speedwave-version`, the `speedwave-version` binary's `version`/`notes-range`/`validate-promotion` subcommands). Every tracked file in the repo stays pinned to `0.0.0` (enforced by `scripts/check-version-pinned.py`, `make test-desktop-config`); nothing about a release is ever written back to a tracked file.

## Files involved

| File                                  | Role                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/beta.yml`          | `push: dev` → computes the version and tag from git, tags the commit, generates notes with git-cliff, calls `build-publish.yml` with `prerelease: true`                                                                                                                                                                                         |
| `.github/workflows/release.yml`       | `push: release/**` → job `promote` on branch creation (audit, flip `prerelease`/`make_latest`, rewrite notes, open the `changelog/0.M` PR); job `hotfix` on every later push (audit, version `0.M.Z`, tag, notes, calls `build-publish.yml` with `prerelease: false`); job `backport` opens the `merge/release-0.M-into-dev` PR with auto-merge |
| `.github/workflows/build-publish.yml` | Reusable (`workflow_call`): creates the draft release, builds macOS (Apple Silicon) + Windows + CLI, verifies assets, publishes, deletes its own draft on failure                                                                                                                                                                               |
| `cliff.toml`                          | git-cliff configuration: section order (Breaking changes, Security, Features, Bug Fixes, Performance), hidden types (`refactor`, `docs`, `ci`, `test`, `chore`, `style`, `build`, `revert`), `security`-labeled PRs routed to the Security section                                                                                              |
| `scripts/verify-release-assets.sh`    | Enumerates every expected asset and `.sig`, validates `latest.json`'s platform keys                                                                                                                                                                                                                                                             |
| `scripts/check-version-pinned.py`     | Asserts every tracked version source stays `0.0.0`; the single list of tracked files (no more `release-please-config.json`)                                                                                                                                                                                                                     |
| `crates/speedwave-version`            | Computes the version, the stable notes range, and rejects an out-of-order promotion                                                                                                                                                                                                                                                             |
| `desktop/src-tauri/src/updater.rs`    | Stable endpoint, channel-aware endpoint selection (SPEED-741/742), version comparator, auto-check loop                                                                                                                                                                                                                                          |

## Secrets, environments and the automation token

- **Environment `release`**: one environment for both channels (beta and stable builds, promote, hotfix, backport PR, changelog PR all run in it). Deployment branch policy: `dev` and `release/*`. No reviewers, no bypass. The existing Azure federated credential (`repo:speednet-software/speedwave:environment:release`) and its 6 `AZURE_*` variables are unchanged — one signing identity serves both channels, because a stable release is the exact same build as its beta, never a rebuild.
- **Environment `e2e`** (SPEED-738/739): policy `dev`, rig secrets. A pull request branch never gets these secrets — only a run from `dev` (the merge queue or a maintainer's `workflow_dispatch`) qualifies. **This is why a PR from a fork never runs the `e2e` lane with real credentials**: a maintainer who wants a fork's PR through the full gate pushes that branch into the main repository and opens the PR from there instead, so it runs as a same-repo branch.
- **`GH_AUTOMATION_PAT`**: one fine-grained personal access token (owner: Mikołaj Kąkol), scoped to this repository only, with Contents: write, Pull requests: write, Workflows: write, Metadata: read — no admin role. It is the credential behind every release write (tag push, draft creation, asset upload, publish, flipping `prerelease`/`make_latest`) and every automated PR (changelog, backport), because a PR opened with the default `GITHUB_TOKEN` does not trigger CI on itself. Issued 2026-10-07; renew before 2027-10-08 (tracked as [SPEED-745](https://speedwave.atlassian.net/browse/SPEED-745)). Replacing it with a GitHub App is [SPEED-746](https://speedwave.atlassian.net/browse/SPEED-746), no deadline.
- **`GITHUB_TOKEN`** stays at its default read scope everywhere in the release workflows; jobs that need to write use `GH_AUTOMATION_PAT` explicitly, and jobs that log into Azure add `id-token: write`. No workflow references `RELEASE_TOKEN` any more; the secret itself is deleted from the repository in phase 5 ([SPEED-737](https://speedwave.atlassian.net/browse/SPEED-737)), once the old workflows that used it are gone.
- The PAT is passed only to the steps that push a branch/tag or call `gh`, never persisted by `actions/checkout` (every checkout is `persist-credentials: false`, no `token:` input), so it never sits in `.git/config` while third-party code (cargo builds, `make audit-*`, `cargo install cargo-audit`) runs in the same job.
- Signing secrets (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, the six `APPLE_*` secrets) stay at the repository level, unchanged, available to same-repo branch builds as before (never to forks or Dependabot).
- Immutable releases are enabled: once a release is published, its assets and tag are frozen (title, notes and flags stay editable, which is how `promote` rewrites the beta's notes). Tags matching `v*` cannot be moved or deleted.

## Creating a stable release

1. Pick a commit on `dev` that already has a beta release (check the Releases page or `gh release list`) — it does not have to be the latest beta; testers may have validated an earlier one.
2. Push a branch at that commit: `git push origin <sha>:refs/heads/release/0.<M>`, where `M` is one more than the current highest `release/0.*` line.
3. The `promote` job runs `make audit` on that commit first. A red advisory without a valid exception fails the job; the beta stays a beta and the branch stays in place — fix with a bump PR to `dev`, let a new beta build, then either move the branch (delete and recreate on the new commit) or push the bump through as a new beta and re-target.
4. On success, the beta's `GitHub Release` loses `prerelease`, gains `make_latest`, and its notes are rewritten to the list of changes since the previous line (hotfixes of that line excluded). A `changelog/0.M` PR to `dev` is opened with the `CHANGELOG.md` section — merge it like any other PR.
5. File a Jira task for the landing "What's new" entry (EN and PL); update `install.mdx` on the landing to drop the macOS Intel row once this is the first stable of the cutover.

**If the job fails because there is no beta release on that commit yet** (the beta build is still running), do nothing to the branch — use "Re-run jobs" once the beta publishes.

**If the job fails because the commit is older than the previous release line's tip**, the new stable would be lower-versioned than the one it is replacing. Delete the branch and recreate it on a commit at or after the previous line's tip.

## Hotfixing a stable release

1. Branch from the tip of the highest `release/0.M`, fix the bug, open a PR against `release/0.M`. It goes through the same gate as a PR to `dev`.
2. On merge, the `hotfix` job runs `make audit` on the squashed commit — a red advisory blocks the publish exactly as it does for a promotion.
3. The audit passing, it tags `v0.M.Z`, builds, and publishes `0.M.Z` immediately — no prerelease stage, because the PR gate is already the bar for stable.
4. A `merge/release-0.M-into-dev` PR opens automatically, with the `CHANGELOG.md` section for `0.M.Z`, auto-merge on, assigned to whoever authored the hotfix. If it shows conflicts, resolve them by pushing to that PR's branch — never push directly to `release/0.M` (that is the next hotfix) and never resolve on the release branch.
5. A second hotfix to the same line may show the same conflict the first one already resolved, in its own backport PR; that is expected.

Only the highest `release/0.*` line takes hotfixes. `release/0.20` (the cutover base marker) never does.

## Beta

Nothing to operate: every merge to `dev` builds and publishes a beta automatically, in commit order (`concurrency: beta`, no cancellation — a run that gets cancelled because three merges landed in close succession gets its beta back via "Re-run jobs"). A beta never blocks on an audit (an environmental advisory already blocked merges once before this process existed, SPEED-674 ticket 20); a stable promotion or hotfix does.

## What's not here yet

The `e2e` environment, the 13-lane merge gate (`ci-gate`), the merge queue and the `dev`/`release/**` ruleset land with [SPEED-739](https://speedwave.atlassian.net/browse/SPEED-739) and [SPEED-740](https://speedwave.atlassian.net/browse/SPEED-740). Until then, `dev` and `release/0.M` PRs go through today's `ci-gate` (`test.yml`) and `validate` (`pr-title.yml`) checks, without a queue. The channel switch, the beta update endpoint and `speedwave self-update`'s channel awareness are [SPEED-741](https://speedwave.atlassian.net/browse/SPEED-741)/[SPEED-742](https://speedwave.atlassian.net/browse/SPEED-742)/[SPEED-743](https://speedwave.atlassian.net/browse/SPEED-743).

## Cutover steps (one-time, phase 2b)

These ran once, when this file replaced the release-please process (SPEED-674 ticket 17):

1. Phase 0 (admin, done 2026-10-07): the `release` environment's deployment branch policy extended to `dev` and `release/*` (`main` stayed until phase 5); `GH_AUTOMATION_PAT` issued; immutable releases turned on; `release/0.20` pushed at the `v0.20.0` commit as a base marker — before this workflow or any ruleset change touched `release/**`, so nothing built from it.
2. Phase 2a ([SPEED-734](https://speedwave.atlassian.net/browse/SPEED-734)): version-from-git landed on `dev`.
3. Phase 2b (this change, [SPEED-735](https://speedwave.atlassian.net/browse/SPEED-735)): `beta.yml`, `release.yml`, `build-publish.yml` and `cliff.toml` added; `desktop-release.yml`, the three `release-please*.yml` workflows, `backmerge.yml`, `merge-strategy-check.yml`, `dependabot-auto-rebase.yml` and their configs and scripts removed. Merging this PR is the cutover: the next merge to `dev` is the first beta of the new process, `0.21.0+N`.
4. Phase 5 (admin, right after 2b): classic `main` branch protection removed, `main` deleted (its tip, `v0.20.0`, is identical to the `release/0.20` marker), `RELEASE_TOKEN` deleted.
5. In parallel: phase 3 (the channel PRs above) and phase 1 (the `e2e` environment and merge-gate PRs above).
6. Phase 4, first stable of the new process: `release/0.21`, after phases 1 and 3 land, so the first stable already carries the channel switch and went through the full gate including rig e2e.

0.20.0 was the last release of the old process. A hotfix needed before the cutover went out as an emergency `0.20.1` through the old `main`-based process; `release/0.20` never receives a hotfix through this process.

## macOS Intel

The new process builds and publishes no `x86_64` artifact for macOS, on any channel — application or CLI. 0.20.0 remains the last release with an Intel build. Installed 0.19.0/0.20.0 on Intel keep running; auto-check logs an error and stays quiet, a manual check shows the raw `TargetsNotFound` error from the updater. This is accepted: no in-app messaging, no changelog entry, no farewell release. The installation page drops the Intel row without a note, starting with the first stable of the new process (until then `releases/latest` still points at 0.20.0, which has it).
