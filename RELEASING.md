# Releasing Speedwave

This document describes how releases are created, how to troubleshoot build failures, and how the update system works. For architectural decisions behind this flow, see [ADR-019](docs/adr/ADR-019-git-branching-model-and-release-flow.md).

## Prerequisites

Before your first release, ensure these GitHub repository secrets are configured:

| Secret                               | Required | Purpose                                                                                                    |
| ------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------- |
| `RELEASE_TOKEN`                      | Yes      | PAT or GitHub App token — used by release-please to create release PRs and push to branch-protected `main` |
| `TAURI_SIGNING_PRIVATE_KEY`          | Yes      | Ed25519 private key for Tauri updater signatures                                                           |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Yes      | Passphrase for the signing key (can be empty string)                                                       |
| `APPLE_CERTIFICATE`                  | No       | macOS code signing (.p12, base64)                                                                          |
| `APPLE_CERTIFICATE_PASSWORD`         | No       | Passphrase for macOS certificate                                                                           |
| `APPLE_SIGNING_IDENTITY`             | No       | Developer ID Application identity                                                                          |
| `APPLE_ID`                           | No       | Apple ID email for notarization                                                                            |
| `APPLE_PASSWORD`                     | No       | App-specific password for notarization                                                                     |
| `APPLE_TEAM_ID`                      | No       | Apple Developer Team ID                                                                                    |
| `WINDOWS_CERTIFICATE`                | No       | Windows code signing (.pfx, base64)                                                                        |
| `WINDOWS_CERTIFICATE_PASSWORD`       | No       | Passphrase for Windows certificate                                                                         |

Generate the Tauri signing keypair (one-time setup):

```bash
cargo tauri signer generate -w ~/.tauri/speedwave.key
```

Store the private key as `TAURI_SIGNING_PRIVATE_KEY`. The public key is already embedded in `desktop/src-tauri/tauri.conf.json`.

**What happens when secrets are missing:**

- `RELEASE_TOKEN` missing — release-please cannot create PRs or push to `main`. The workflow fails with a permissions error.
- `TAURI_SIGNING_PRIVATE_KEY` missing — tauri-action produces unsigned bundles. The Tauri updater will **refuse to install** them (signature verification fails). Users cannot auto-update.
- Apple/Windows signing secrets missing — builds succeed but produce unsigned binaries. macOS Gatekeeper blocks the app (users must right-click > Open). Windows SmartScreen shows a warning.
- Entitlements plists missing — builds and notarization succeed, but binaries crash at runtime when they attempt to use restricted platform APIs (Virtualization.framework, Apple Events, EventKit for Calendars/Reminders). This is NOT caught by CI — only by manual testing. The accompanying `Info.plist` TCC usage-description keys (`NSFileProviderDomainUsageDescription`, `NSAppleEventsUsageDescription`, `NSCalendarsUsageDescription`, etc.) are equally critical — without them macOS silently blocks the API without displaying a consent dialog.

**Operational setup for Apple signing** (certificate generation, Keychain import, notary configuration, rotation) is documented in [Release Signing Guide](docs/contributing/release-signing.md). The architectural rationale — including why every Mach-O binary in `Contents/Resources/` is signed individually — is in [ADR-037](docs/adr/ADR-037-code-signing-and-bundled-binary-signing.md).

## How release-please Works

Speedwave uses [release-please](https://github.com/googleapis/release-please) to automate version bumping and release creation from [Conventional Commits](https://www.conventionalcommits.org/) (already enforced via commitlint).

**How version bumps are determined:**

| Commit type       | Version bump                                             | Example                  |
| ----------------- | -------------------------------------------------------- | ------------------------ |
| `fix(...): ...`   | Patch (`0.3.0` → `0.3.1`)                                | `fix(cli): handle ...`   |
| `feat(...): ...`  | Minor (`0.3.0` → `0.4.0`)                                | `feat(runtime): add ...` |
| `BREAKING CHANGE` | Minor while `0.x` (`0.3.0` → `0.4.0`), Major after `1.0` | footer in any commit     |

**The flow:**

1. Developers merge PRs into `dev` (conventional commits)
2. When ready to release, merge `dev` → `main` via PR
3. On push to `main`, release-please analyzes new commits since the last release
4. If there are releasable changes, release-please opens (or updates) a **release PR** on `main`
5. The release PR updates `CHANGELOG.md`, bumps version in all 16 files, and shows a summary of changes
6. **Merge the release PR** — this triggers release-please to create a draft GitHub Release + tag
7. The draft release triggers `desktop-release.yml` to build all platforms
8. After all builds succeed, `publish-release` flips the release from draft → published

## Pipeline Overview

```
                        RELEASE PIPELINE
 ═══════════════════════════════════════════════════════════════

  Push to main (merge dev → main)
        │
        ▼
  ┌────────────── release-please.yml ──────────────────────────┐
  │                                                             │
  │  [job: release-please]                                      │
  │    analyzes conventional commits since last release          │
  │    opens/updates release PR (version bump + CHANGELOG)      │
  │                                                             │
  └──────────────────────────┬──────────────────────────────────┘
                             │
  Merge the release PR       │
        │                    │
        ▼                    ▼
  ┌────────────── release-please.yml ──────────────────────────┐
  │                                                             │
  │  [job: release-please]                                      │
  │    creates draft GitHub Release + tag (vX.Y.Z)              │
  │        │                                                    │
  │        ▼                                                    │
  │  [job: build-and-publish]                                   │
  │    calls desktop-release.yml via workflow_call               │
  │    passes: version, tag_name                                │
  │                                                             │
  └──────────────────────────┬──────────────────────────────────┘
                             │
                             ▼
  ┌──────────────────────── desktop-release.yml ──────────────────────────────────┐
  │                                                                               │
  │  [job: resolve]  validate inputs, look up draft release ID                    │
  │        │                                                                      │
  │        ▼                                                                      │
  │  [job: publish-tauri]  matrix build (4 runners in parallel)                   │
  │    ├─ macOS arm64    ─► macOS_Apple_Silicon .dmg + .app.tar.gz + .sig  (3)    │
  │    ├─ macOS x86_64   ─► macOS_Intel .dmg + .app.tar.gz + .sig  (3)           │
  │    ├─ Linux x86_64   ─► .deb + .sig  (3)                                     │
  │    └─ Windows x86_64 ─► .msi + .nsis.zip + .sig  (3)                         │
  │        │                                                                      │
  │        ▼                                                                      │
  │  [job: cli]  cross-compile CLI binary (4 targets)                             │
  │    ├─ aarch64-apple-darwin     ─► .tar.gz                                     │
  │    ├─ x86_64-apple-darwin      ─► .tar.gz                                     │
  │    ├─ x86_64-unknown-linux-gnu ─► .tar.gz                                     │
  │    └─ x86_64-pc-windows-msvc   ─► .zip                                       │
  │        │                                                                      │
  │        ▼                                                                      │
  │  [job: publish-release]                                                       │
  │    verify-release-assets.sh: 20 assets, 6 .sig companions, latest.json       │
  │    draft ─► live ─► verify-release-assets.sh (post-publish safety net)       │
  │                                                                               │
  └──────────────────────────┬────────────────────────────────────────────────────┘
                             │
                             ▼
  ┌──────────────── backmerge.yml ───────────────────────────────┐
  │                                                              │
  │  Triggered by: release published event                       │
  │  Resets dev to main (force-push) to prevent ghost commits     │
  │  Falls back to regular merge PR if dev has new commits       │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
```

```
                        CI PIPELINE (every PR/push)
 ═══════════════════════════════════════════════════════════════

  push / PR to dev or main
        │
        ├──► test.yml
        │      ├─ lint (clippy, rustfmt, eslint, prettier, typecheck)
        │      ├─ test (rust tests, mcp tests, bats tests)
        │      ├─ desktop (desktop clippy, angular eslint, angular tests)
        │      └─ audit (cargo-audit, npm audit)
        │
        └──► desktop-build.yml  (push/PR to main only, when desktop/** crates/** Cargo.toml Cargo.lock change)
               ├─ PR to main:   Linux only ($0.008/min vs macOS $0.08/min)
               └─ push to main: all 4 platforms (unsigned)
```

## How to Create a Release

1. Merge all changes from `dev` to `main` via PR — **use squash merge** (see below)
2. Wait for CI to pass on `main`
3. Release-please automatically opens (or updates) a release PR
4. Review the release PR — it shows the changelog and version bump
5. **Merge the release PR** — use **squash merge** (same as all PRs to main)
6. Release-please creates a draft GitHub Release and tag
7. Builds run automatically on all platforms
8. After all builds succeed, the release is published

That's it — no manual version bumping, no workflow dispatch, no release type selection.

### Why squash merge matters

**All PRs to `main` must use squash merge** — this includes `dev` → `main` PRs and release-please PRs. Release-please is compatible with squash merge thanks to `force-tag-creation: true` and manifest-based version tracking. This is because:

- Release-please uses `--first-parent` commit traversal and parses each commit's message as a conventional commit
- Regular merge commits have messages like `Merge pull request #N from speednet-software/dev` — this is **not** a conventional commit and release-please ignores it
- Release-please also backfills file lists per commit — empty commits (`--allow-empty`) return 0 files and are excluded from path-based detection
- Squash merge produces a single commit with the PR title as the message — if the PR title follows conventional commits (e.g. `feat(runtime): add logging`), release-please picks it up correctly

#### What happens if you accidentally use a regular merge

A regular merge brings the entire `dev` commit history onto `main` as a merge commit with two parents. Release-please walks both parents and sees all historical commits from `dev` — including ones already released in previous versions — as "new" commits. This causes **phantom release PRs**: release-please opens a new release PR containing duplicate changelog entries for already-released features.

This is a known issue: [release-please#2476](https://github.com/googleapis/release-please/issues/2476).

#### Recovery procedure after an accidental regular merge

1. **Close the phantom release PR** that release-please opened (it contains duplicate commits).
2. **Create the missing tag** for the last actual release, if it doesn't exist (draft releases don't create tags unless `force-tag-creation` is enabled):

   ```bash
   # Find the merge commit SHA of the last release PR
   git log --oneline main | head -20

   # Create and push the tag
   git tag v<VERSION> <COMMIT_SHA>
   git push origin v<VERSION>
   ```

3. **Verify** that release-please does not reopen the phantom PR on the next push to `main`. If it does, check that the tag exists on the remote: `git ls-remote --tags origin | grep v<VERSION>`.
4. **Prevent future accidents** by disabling "Allow merge commits" in GitHub repo settings for the `main` branch (Settings → General → Pull Requests), leaving only "Allow squash merging" enabled.

### Version examples

| Commits since last release           | Version bump      |
| ------------------------------------ | ----------------- |
| `fix(cli): handle missing config`    | `0.3.0` → `0.3.1` |
| `feat(runtime): add nerdctl support` | `0.3.0` → `0.4.0` |
| `feat!: redesign config format`      | `0.3.0` → `0.4.0` |
| Multiple `fix` + one `feat`          | `0.3.0` → `0.4.0` |

**Note:** While at `0.x`, `BREAKING CHANGE` bumps minor (not major). After `1.0.0`, breaking changes will bump major.

## Update Channel

Users receive updates through a single stable channel served from GitHub Releases:

```
  GitHub Releases
  ├─ v0.3.0  (published)
  ├─ v0.3.1  (published)  ◄── latest stable
  └─ ...

  Speedwave.app ──► /releases/latest/download/latest.json
                    (GitHub auto-resolves to latest non-draft, non-prerelease)
                        │
                        ▼
                    remote.version > current? ──► download + install
```

The updater (`desktop/src-tauri/src/updater.rs`) uses strict semver comparison (`remote.version > current`) — downgrades are blocked.

## What to Do When a Build Fails

```
                        FAILURE DECISION TREE
 ═══════════════════════════════════════════════════════════════

  Build failed
    │
    ├─ Single platform failed?
    │    └─ YES ──► "Re-run failed jobs" in Actions UI
    │               (release stays draft, re-run is safe)
    │
    ├─ publish-release failed?
    │    └─ YES ──► Re-run job, or publish manually:
    │               gh api --method PATCH .../releases/<ID> -f draft=false
    │
    ├─ All builds OK but release stuck as draft?
    │    └─ YES ──► publish-release was skipped ──► publish manually
    │
    └─ Fundamental problem (wrong version, bad code)?
         └─ YES ──► Abort: delete release + tag + revert commit
```

### Single platform fails in `publish-tauri`

The matrix uses `fail-fast: false` — other platforms continue building. After the run completes:

1. Check which platform failed in the Actions log
2. Fix the issue (usually a missing dependency or signing problem)
3. **Re-run the failed job** from the Actions UI (click "Re-run failed jobs")

The release stays as draft until `publish-release` runs. Tauri-action uploads to the existing release via `releaseId`, so re-runs are safe.

### CLI cross-compilation fails

Same approach — re-run the failed job. CLI builds run after `publish-tauri` and upload to the same release.

### `publish-release` fails

The release remains as draft. Check the log — it usually means the `gh api PATCH` call failed (network issue). Re-run the job.

### All builds succeed but release stays draft

This means `publish-release` was skipped or failed silently. You can publish manually:

```bash
# Find the release ID
gh release list --repo speednet-software/speedwave

# Publish the draft
gh api --method PATCH repos/speednet-software/speedwave/releases/<RELEASE_ID> -f draft=false
```

### Need to abort a release entirely

If something is fundamentally wrong and you need to delete the release:

```bash
# Delete the GitHub Release (also deletes uploaded assets)
gh release delete v0.3.1 --repo speednet-software/speedwave --yes

# Delete the remote tag
git push origin --delete v0.3.1

# Revert the release commit on main
git revert <commit-sha>
git push origin main
```

## Hotfix Procedure

When a critical bug is in the latest stable release but `dev` has unreleased work:

```
main (v1.2.0 — buggy)         dev (has unreleased work)
  │                              │
  ├── hotfix/fix-critical ───┐   │
  │   (branch from main)     │   │
  │   fix the bug             │   │
  │   PR → main               │   │
  │◄──────────────────────────┘   │
  │                               │
  ├── release-please PR opens     │
  │   (merge to create v1.2.1)    │
  │                               │
  └── cherry-pick fix ──────────► │
```

1. `git checkout main && git checkout -b hotfix/fix-critical`
2. Apply the minimal fix (use `fix(scope): description` commit message)
3. Open PR targeting `main` — CI must pass
4. Merge — release-please will open a release PR with a patch bump
5. Merge the release PR to trigger the release
6. Cherry-pick the fix into `dev`: `git cherry-pick <commit-sha>` or open a PR

## Backmerge (main → dev)

After every release, `main` has commits that `dev` doesn't (version bumps, CHANGELOG updates, hotfixes). The `backmerge.yml` workflow automatically keeps `dev` in sync:

1. **Trigger:** fires on `release: [published]` event
2. **Guard:** skips if `dev` already contains all `main` commits
3. **Reset (default):** force-pushes `main` to `dev` so they are identical — this prevents ghost commits from accumulating due to SHA divergence from squash merges
4. **Fallback:** if `dev` has new commits not yet on `main` (someone merged between release and backmerge), falls back to a regular merge via PR with auto-merge enabled

**Why force-push instead of regular merge?** Squash merge from `dev` → `main` creates new commit SHAs. A regular backmerge preserves the original SHAs on `dev`, so Git sees them as "unmerged" — these ghost commits accumulate over time and pollute future PR diffs. Force-pushing `dev = main` eliminates this divergence entirely.

**Branch protection:** The `dev` branch uses a GitHub Repository Ruleset (not legacy branch protection) that grants admin role bypass for force-push. The `RELEASE_TOKEN` (admin PAT) used by `backmerge.yml` can force-push; regular users cannot.

**Prerequisite:** the repository must have **"Allow auto-merge"** enabled in GitHub Settings > General > Pull Requests. Without this, `gh pr merge --auto` silently does nothing and fallback backmerge PRs will require manual merge.

## Known Pitfalls

### Version mismatch between code and release

**Symptom:** Desktop app shows wrong version (e.g., release is v0.3.0 but app says 0.2.0).

**Cause:** `workflow_dispatch` on `desktop-release.yml` checked out branch HEAD instead of the release tag. The branch had old version files.

**Fix:** The `resolve` job now checks if the tag exists and conditionally sets the checkout `ref`. When a tag exists, builds always use tagged code. Falls back to branch HEAD only when no tag exists (testing scenarios).

### Release-please labeling race condition

**Symptom:** Release-please creates a PR but the `autorelease: pending` label is missing. When the PR is merged, `release_created` is never set to `true` because `findMergedReleasePullRequests()` filters by label.

**Cause:** GitHub's API returns the PR before the node ID is fully propagated. The labeling API call inside release-please fails silently.

**Fix:** `release-please.yml` has an idempotent label-ensure step that retries label application with backoff after every release-please run that produces a PR.

### Manual dispatch requires existing tag for correct builds

When using `workflow_dispatch` on `desktop-release.yml` to re-build an existing release, the tag must exist on the remote. The `resolve` job checks for the tag and warns if it doesn't exist. Without a tag, the build uses branch HEAD which may have different code than expected.

### `workflow_dispatch` uses workflow YAML from the default branch, not `main`

**Symptom:** Manual re-trigger of `desktop-release.yml` via `gh workflow run` or Actions UI fails on steps that were recently hotfixed on `main`, even though `actions/checkout` checks out the correct tag.

**Cause:** GitHub Actions `workflow_dispatch` reads the **workflow YAML file** (steps, `run:` blocks, `if:` guards) from the **default branch** — which is `dev` in this repo, not `main`[^wd-ref]. The `actions/checkout` step inside the workflow checks out the correct tag/ref for **source code**, but `run:` blocks are baked into the YAML at dispatch time. If `dev` has an older version of the workflow YAML than `main`, the build executes stale step logic.

This is a two-path problem: **workflow definition** comes from the default branch, **repo source** comes from the checkout ref. They can diverge when hotfixes land on `main` but haven't been cherry-picked to `dev` yet.

**Fix:** When manually dispatching, always pass `--ref main` to source the workflow YAML from `main`:

```bash
gh workflow run desktop-release.yml --ref main -f version=0.7.2
```

In the Actions UI, select `main` from the branch dropdown before clicking "Run workflow".

**Prevention:** When hotfixing any workflow YAML file (`.github/workflows/`) on `main`, always cherry-pick the same change to `dev` in the same session. This keeps both branches' workflow definitions in sync and avoids the `--ref` footgun entirely.

[^wd-ref]: GitHub docs: "This event will only trigger a workflow run if the workflow file exists on the default branch." `gh workflow run --ref` overrides which branch's YAML is used. See `gh workflow run --help`.

## Manual Desktop Build (without release)

To trigger a desktop build without creating a release (e.g. for testing):

```bash
# Re-build an existing release (YAML from main, not dev):
gh workflow run desktop-release.yml --ref main -f version=0.3.0

# From Actions UI: select "main" branch, run "Desktop Release" with version "0.3.0"
```

**Note:** `workflow_dispatch` now checks whether the tag exists. If `v0.3.0` tag exists, the build checks out that tag (builds from tagged code with correct version). If no tag exists, falls back to branch HEAD (for testing only — version in artifacts will match whatever the branch has).

Or use `desktop-build.yml` which runs automatically on PRs to `main` (Linux only) and on push to `main` (all platforms). These builds are unsigned.

## Files Involved

| File                                            | Role                                                           |
| ----------------------------------------------- | -------------------------------------------------------------- |
| `release-please-config.json`                    | release-please configuration — extra-files, changelog sections |
| `.release-please-manifest.json`                 | Current version tracker for release-please                     |
| `.github/workflows/release-please.yml`          | Runs release-please on push to main, triggers builds           |
| `.github/workflows/release-please-lockfile.yml` | Regenerates Cargo.lock on release-please PRs                   |
| `.github/workflows/desktop-release.yml`         | Matrix build, code signing, CLI cross-compile, publish         |
| `.github/workflows/desktop-build.yml`           | PR/push CI build (unsigned)                                    |
| `.github/workflows/backmerge.yml`               | Automated main → dev backmerge after release publish           |
| `.github/workflows/merge-strategy-check.yml`    | Enforces conventional commit PR titles on PRs to main          |
| `desktop/src-tauri/src/updater.rs`              | Stable endpoint, version comparator, auto-check loop           |
| `desktop/src-tauri/tauri.conf.json`             | Tauri config — updater pubkey, default stable endpoint         |

## Verifying a Release

After a release is published:

```bash
# Check the release exists and has all assets
gh release view v0.3.1 --repo speednet-software/speedwave

# Verify the updater endpoint works
curl -sL https://github.com/speednet-software/speedwave/releases/latest/download/latest.json | jq .version
```

Expected assets per release (20 assets, of which 6 require companion .sig files):

| Asset                                            | Needs .sig? |
| ------------------------------------------------ | ----------- |
| `latest.json`                                    | no          |
| `Speedwave_<V>_macOS_Apple_Silicon.app.tar.gz`   | **yes**     |
| `Speedwave_<V>_macOS_Apple_Silicon.dmg`          | no          |
| `Speedwave_<V>_macOS_Intel.app.tar.gz`           | **yes**     |
| `Speedwave_<V>_macOS_Intel.dmg`                  | no          |
| `Speedwave_<V>_amd64.deb`                        | no          |
| `Speedwave_<V>_x64-setup.exe`                    | **yes**     |
| `Speedwave_<V>_x64-setup.nsis.zip`               | **yes**     |
| `Speedwave_<V>_x64_en-US.msi`                    | **yes**     |
| `Speedwave_<V>_x64_en-US.msi.zip`                | **yes**     |
| `speedwave-v<V>-aarch64-apple-darwin.tar.gz`     | no          |
| `speedwave-v<V>-x86_64-apple-darwin.tar.gz`      | no          |
| `speedwave-v<V>-x86_64-unknown-linux-gnu.tar.gz` | no          |
| `speedwave-v<V>-x86_64-pc-windows-msvc.zip`      | no          |

Breakdown by platform:

- macOS (per arch): `.dmg` (no sig) + `.app.tar.gz` + `.app.tar.gz.sig` × 2 archs = 6 assets
- Linux: `.deb` (no sig) = 1 asset
- Windows: `.exe` + `.exe.sig` + `.nsis.zip` + `.nsis.zip.sig` + `.msi` + `.msi.sig` + `.msi.zip` + `.msi.zip.sig` = 8 assets
- CLI archives: 4 (`.tar.gz` / `.zip` per target, no sig)
- `latest.json`: 1

**Total: 20 assets, 6 `.sig` companions.**

Asset names use `assetNamePattern: [name]_[version]_{arch_label}[setup][ext]` from `tauri-apps/tauri-action` (see `.github/workflows/desktop-release.yml`). The `publish-release` job runs `scripts/verify-release-assets.sh` before and after publishing, which checks every named asset and downloads each `.sig` to confirm it is non-empty. It also validates that `latest.json` reports the expected bare semver version (no `v` prefix).

### Changing release artifact naming or target set

When changing `bundle.targets` in `tauri.conf.json`, bumping `tauri-action`, or modifying `assetNamePattern` in `desktop-release.yml`:

1. Update the expected-asset list in `scripts/verify-release-assets.sh`.
2. Regenerate the happy-case fixture `_tests/desktop/fixtures/verify-release-assets/assets-happy.json`.
3. Update the three BATS "missing-asset" fixtures to stay valid deletions of the happy set.
4. If `latest.json.version` format changes (e.g., gains a `v` prefix), update both the Python assertion in `verify-release-assets.sh` and the `latest-v-prefix.json` fixture case.
