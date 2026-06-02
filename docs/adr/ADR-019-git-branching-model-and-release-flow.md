# ADR-019: Git Branching Model and Release Flow

> **Status:** Accepted
> **Context:** Speedwave is a multi-language monorepo (Rust crates, TypeScript MCP servers, Swift CLIs, Angular frontend) that ships as signed Desktop bundles plus standalone CLI binaries via GitHub Releases.

## Decision

Use a **dev + main** branching model with **release-please** for automated version bumping, a **single stable update channel** served from GitHub Releases, and a draft-release staging gate instead of a separate staging branch.

## Why

- `dev` is the default integration branch — every feature/fix PR merges there and runs full CI before anything reaches `main`. Without it, broken cross-language integrations could block release prep.
- Draft GitHub Releases provide a review gate (artifacts built and uploaded, published manually) without the overhead of a staging branch.
- release-please derives the version from conventional commits, so the version is never manually chosen and stays tied to commit history.
- GitHub Releases give free CDN hosting plus automatic stable/pre-release filtering, so no custom update server is needed.

## How releases flow

1. `feature/*` → squash-merge to `dev` (CI: `test.yml`).
2. `dev` → squash-merge to `main`; the PR title must be a conventional commit (release-please parses the squash-merge commit message). `chore(...)` titles are rejected — release-please omits `chore` from `changelog-sections`, so they would produce no version bump.
3. Push to `main` runs release-please, which opens/updates a release PR (version bump + CHANGELOG). Merging that PR creates a draft GitHub Release plus tag.
4. The release event triggers `desktop-release.yml` (via `workflow_call` from `release-please.yml`): a 3-platform Tauri matrix build, CLI cross-compilation for 3 targets, Tauri updater signing, and asset upload to the draft.
5. The `publish-release` job runs `scripts/verify-release-assets.sh` to confirm every expected named asset exists, then flips the draft to published. A post-publish safety net re-runs the verifier and reverts to draft on failure.
6. On `release: published`, `backmerge.yml` resets `dev` to `main` via force-push (falling back to a regular merge PR if `dev` has new commits).

## Build & update surface

- **Platforms:** macOS and Windows only — Linux was dropped (ADR-059). The `publish-tauri` matrix has exactly three entries: `macos-latest --target aarch64-apple-darwin`, `macos-latest --target x86_64-apple-darwin`, and `windows-latest`. The `cli` matrix mirrors these three targets. No `.deb`, no Ubuntu build job (the `ubuntu-latest` runners only host the orchestration jobs `resolve`/`publish-release`).
- **Outputs:** macOS `.dmg` + `.app.tar.gz`; Windows `.msi` + `.msi.zip` + NSIS `-setup.exe` + `.nsis.zip`. Updater bundles are minisign-signed; `.sig` files accompany the signed assets.
- **Asset verification** is exact named-asset matching, not a numeric threshold: 6 signed + 6 unsigned (one being `latest.json`) + 6 `.sig` files, each checked by name — `scripts/verify-release-assets.sh`.
- **`latest.json` platform keys required by the verifier:** `darwin-aarch64`, `darwin-aarch64-app`, `darwin-x86_64`, `darwin-x86_64-app`, `windows-x86_64`, `windows-x86_64-msi`, `windows-x86_64-nsis` (each must have a non-empty signature and a URL under the releases path).
- **macOS notarization is wired in.** `desktop-release.yml` consumes `APPLE_ID`/`APPLE_PASSWORD` for notarization, and `scripts/sign-bundled-binaries.sh` signs every bundled Mach-O so the bundle passes the Apple Notary Service.

## Update channels

- **Desktop:** Tauri's updater checks `https://github.com/speednet-software/speedwave/releases/latest/download/latest.json` on startup and on manual check — `desktop/src-tauri/src/updater.rs` (`STABLE_ENDPOINT`, `build_updater`). It uses strict semver comparison (remote > current), so downgrades are blocked, and verifies the minisign signature before applying any update.
- **CLI:** `speedwave self-update` downloads the latest GitHub release and replaces the binary in place — `crates/speedwave-cli/src/main.rs` (`run_self_update`, via the `self_update` crate). On macOS the CLI is bundled inside `Speedwave.app` (`Contents/Resources/cli/speedwave`) and copied to `~/.local/bin/speedwave` by `desktop/src-tauri/src/setup_wizard.rs` (`link_cli` → `copy_cli_binary`), so updating the Desktop app re-copies the fresh CLI; a binary that detects it is itself running from inside an `.app` bundle (`is_app_bundle`) refuses self-update and points the user at the Desktop app instead.

## Version synchronization

29 files stay in sync per release. `release-please-config.json` lists 27 `extra-files` entries — 19 JSON files (root `package.json`, `desktop/src/package.json`, `desktop/src/package-lock.json`, `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/oauth/shared/package.json`, plus the 14 MCP server `package.json` files: hub, shared, slack, sharepoint, redmine, gitlab, github, atlassian, office, os, host_exec, oauth, context7, playwright), 3 TOML `Cargo.toml` files, and 5 generic `native/macos/*/Resources/Info.plist` files. The 2 `Cargo.lock` files (root + `desktop/src-tauri/Cargo.lock`) cannot be text-bumped by release-please and are regenerated separately on the release PR.

## Hotfix strategy

For a critical bug in the latest release while `dev` holds unshippable work: branch `hotfix/<desc>` from `main`, apply only the fix with a `fix(scope): …` commit, PR to `main`, merge to let release-please open a patch-bump PR, then cherry-pick the fix back into `dev` so both branches stay in sync. The semver version comparator guarantees users only move forward (no rollback API exists; a broken build is recovered by manual re-download of the prior release or by shipping a higher version).

## Rejected alternatives

- **GitFlow with a staging branch** — redundant; draft releases serve the same review gate with less overhead.
- **Trunk-based (main only)** — too risky for a four-language monorepo; a broken integration could block releases.
- **CrabNebula Cloud / custom update server** — vendor lock-in or YAGNI; GitHub Releases is free and sufficient.
- **Manual version bumping via `workflow_dispatch`** — error-prone (operator picks the type) and disconnects version from commit history; a wrong-version build (release tag and app-reported version disagreeing) is the kind of mismatch the automated backmerge + `merge-strategy-check.yml` guard exists to prevent.
- **Dual stable+beta channels / GitHub Gist beta channel** — over-engineering for current maturity (extra release, CI job, channel-selection UI, secrets) with minimal benefit.

## References

- [GitHub REST API — get the latest release](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)
- [Tauri Updater Plugin](https://v2.tauri.app/plugin/updater/) and [signature verification](https://v2.tauri.app/plugin/updater/#security)
- [tauri-apps/tauri-action](https://github.com/tauri-apps/tauri-action)
- ADR-059 (drop Linux support), ADR-066 (LockedRuntime per-project compose lock)
