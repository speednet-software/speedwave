# ADR-019: Git Branching Model and Release Flow

## Decision

Speedwave uses a **dev + main** branching model with **release-please** for automated version bumping and a **single stable update channel**.

## Branching Model

```
feature/* ──PR→ dev           (integration branch, default)
                 │
                 ├── CI: test.yml on every push/PR (lint, typecheck, clippy, tests)
                 │
                 └──merge→ main   (release-ready code only)
                            │
                            ├── release-please PR (automated version bump + CHANGELOG)
                            └── merge PR → Draft Release → Builds → Publish (stable channel)
```

**Branch roles:**

| Branch      | Purpose                                                        | Protected                                              | CI                                                           |
| ----------- | -------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| `dev`       | Integration. All PRs merge here. Default branch.               | Yes — PR required, status checks must pass             | `test.yml` on every push/PR                                  |
| `main`      | Release-ready. Merge from `dev` only when preparing a release. | Yes — PR required, status checks must pass, 1 approval | `test.yml` + `desktop-build.yml` (unsigned artifact preview) |
| `feature/*` | Short-lived feature branches from `dev`                        | No                                                     | CI runs on PR to `dev`                                       |
| `fix/*`     | Short-lived bugfix branches from `dev`                         | No                                                     | CI runs on PR to `dev`                                       |

**Dependabot:** targets `dev` (the default branch). Dependency updates are treated like any other PR — they go through CI on `dev` and reach `main` only during release preparation.[^52]

**Why not staging?** GitHub Draft Releases serve the staging role. Artifacts are built and uploaded but not published — the team reviews them before clicking "Publish". This eliminates a branch without losing quality control.

**Why not trunk-based (main only)?** Speedwave is a monorepo with Rust crates, TypeScript MCP servers, Swift CLIs, and Angular frontend. The `dev` branch provides a stable integration point where all components are tested together before anything reaches `main`. Without `dev`, broken integrations could block release preparation.

## Release Flow

```
1. Development
   feature/foo ──PR→ dev ──CI passes→ merge

2. Release preparation
   dev ──PR→ main ──CI passes + review→ squash merge (PR title = conventional commit)[^60]

3. Automated version bump (release-please)
   Push to main triggers release-please
   └── analyzes conventional commits since last release
   └── opens/updates release PR (version bump + CHANGELOG)
   └── merge release PR → creates draft GitHub Release + tag

4. Build + sign (3-job pattern: create → build → publish)
   release-please.yml calls desktop-release.yml via workflow_call
   └── passes version, tag_name
   └── matrix build (4 platforms) using releaseId to upload to existing draft
   └── code signing (macOS notarization + Windows Authenticode when configured)
   └── updater signing (TAURI_SIGNING_PRIVATE_KEY)
   └── CLI cross-compilation (4 targets)
   └── uploads artifacts + latest.json to the GitHub Release

5. Publish (automatic after all builds succeed)
   publish-release job in desktop-release.yml
   └── validates asset count (expects 17+: ~12 Tauri + 4 CLI + latest.json)
   └── validates latest.json version matches expected version
   └── flips draft → published via GitHub API
   └── /releases/latest/download/latest.json now points to this release
   └── users receive update notification

6. Backmerge (automatic after release is published)
   backmerge.yml triggered by release:published event
   └── merges main → dev (regular merge, not squash)
   └── auto-resolves version file conflicts (main wins)
   └── opens PR with auto-merge enabled
```

## Update Channel

Single stable channel implemented via GitHub Releases:

| Channel  | Audience            | Endpoint                                     | GitHub Release state                   |
| -------- | ------------------- | -------------------------------------------- | -------------------------------------- |
| `stable` | All users (default) | `/releases/latest/download/latest.json`[^47] | Published (non-draft, non-pre-release) |

**How it works:** GitHub's `/releases/latest` endpoint automatically returns only the most recent non-draft, non-pre-release.[^47] Zero infrastructure needed.

**Updater code:**

```rust
// updater.rs — build_updater()
const STABLE_ENDPOINT: &str =
    "https://github.com/speednet-software/speedwave/releases/latest/download/latest.json";
```

The updater uses strict semver comparison (`remote.version > current`) — downgrades are blocked.

## Tag Conventions

| Tag pattern          | Release type      | Example  |
| -------------------- | ----------------- | -------- |
| `v*.*.*` (no suffix) | Draft → Published | `v2.1.0` |

## Version Synchronization

16 files must stay in sync — `release-please-config.json` with `extra-files` handles this automatically. JSON files are updated natively by release-please. TOML files use the `toml` extra-file type with `jsonpath`:

| File                                  | Field                | Method                      |
| ------------------------------------- | -------------------- | --------------------------- |
| `package.json`                        | `"version": "X.Y.Z"` | release-please (native)     |
| `desktop/src/package.json`            | `"version": "X.Y.Z"` | extra-files (JSON)          |
| `mcp-servers/hub/package.json`        | `"version": "X.Y.Z"` | extra-files (JSON)          |
| `mcp-servers/shared/package.json`     | `"version": "X.Y.Z"` | extra-files (JSON)          |
| `mcp-servers/slack/package.json`      | `"version": "X.Y.Z"` | extra-files (JSON)          |
| `mcp-servers/sharepoint/package.json` | `"version": "X.Y.Z"` | extra-files (JSON)          |
| `mcp-servers/redmine/package.json`    | `"version": "X.Y.Z"` | extra-files (JSON)          |
| `mcp-servers/gitlab/package.json`     | `"version": "X.Y.Z"` | extra-files (JSON)          |
| `mcp-servers/os/package.json`         | `"version": "X.Y.Z"` | extra-files (JSON)          |
| `desktop/src-tauri/tauri.conf.json`   | `"version": "X.Y.Z"` | extra-files (JSON)          |
| `crates/speedwave-runtime/Cargo.toml` | `version = "X.Y.Z"`  | extra-files (TOML)          |
| `crates/speedwave-cli/Cargo.toml`     | `version = "X.Y.Z"`  | extra-files (TOML)          |
| `desktop/src-tauri/Cargo.toml`        | `version = "X.Y.Z"`  | extra-files (TOML)          |
| `Cargo.lock`                          | regenerated          | release-please-lockfile.yml |
| `desktop/src-tauri/Cargo.lock`        | regenerated          | release-please-lockfile.yml |

Cargo.lock files cannot be handled by release-please (it does text-based updates, not dependency resolution). A separate workflow (`release-please-lockfile.yml`) regenerates them when Cargo.toml files change on the release-please PR.

## Rollback and Hotfix Strategy

Tauri has no built-in rollback. The updater uses strict semver comparison (`remote > current`) to prevent downgrade attacks. Rollback mechanisms:

1. **Manual re-download** — if the app is completely broken (cannot check for updates), users download the previous version from the GitHub Releases page.

2. **Hotfix release** — publish a new version with the fix (see procedure below). The semver comparator ensures users always move forward.

### Hotfix Procedure

When a critical bug is found in the latest stable release and `dev` contains unverified changes that cannot ship yet:

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

**Steps:**

1. Create `hotfix/<description>` branch from `main` (not from `dev`)
2. Apply the minimal fix on that branch (use `fix(scope): description` commit message)
3. Open PR targeting `main` — CI must pass, review required
4. Merge to `main` — release-please will open a release PR with a patch bump
5. Merge the release PR to trigger the release
6. Cherry-pick the fix commit into `dev` to keep branches in sync:
   `git cherry-pick <commit-sha>` on `dev`, or open a separate PR to `dev`

**Rules:**

- Hotfix branches contain **only** the fix — no unrelated changes
- The conventional commit message determines the version bump (`fix:` → patch)
- The same fix **must** land on both `main` and `dev` to prevent regression on next release

## Rationale

This model is based on the pattern described by Jacob Bolda (Tauri core contributor)[^49] and aligns with Tauri's official `tauri-action` design[^50]:

- `tauri-action` is designed for tag-triggered or release-event-triggered builds
- GitHub Releases provide free CDN for binaries and natural stable/pre-release filtering
- Draft releases provide a staging gate without an extra branch
- The dev + main split matches the project's monorepo complexity (Rust + TypeScript + Swift + Angular)

## Rejected Alternatives

- **GitFlow (dev → staging → main)** — staging branch is redundant; draft releases serve the same purpose with less overhead
- **Trunk-based (main only)** — too risky for a monorepo with 4 languages; broken integration could block releases
- **CrabNebula Cloud** — vendor lock-in; GitHub Releases are free and sufficient for initial release[^51]
- **Custom update server** — YAGNI; GitHub Releases is simpler and free
- **Manual version bumping via workflow_dispatch** — error-prone (operator must choose release type, fill in pre-release tag), requires maintaining complex version computation logic in shell scripts, and disconnects the version from the commit history. release-please derives the version automatically from conventional commits.
- **GitHub Gist for beta channel** — over-engineering; requires `GIST_TOKEN` and `BETA_GIST_ID` secrets, compile-time `option_env!`, and a separate infrastructure dependency
- **Dual update channels (stable + beta)** — added significant complexity (permanent `latest-beta` release, beta-update CI job, channel selection UI, extra endpoint constant) for minimal benefit at current project maturity

## GitHub Actions Workflows

```
.github/workflows/
├── test.yml                    # CI: typecheck, lint, tests on every push/PR
├── desktop-build.yml           # Build Tauri app on push to main and PR to main (unsigned artifact preview)
├── release-please.yml          # Runs release-please, triggers desktop-release.yml on release
├── release-please-lockfile.yml # Regenerates Cargo.lock on release-please PRs
├── desktop-release.yml         # Build + sign + publish binaries (called via workflow_call)
├── backmerge.yml               # Automated main → dev backmerge after release publish
└── merge-strategy-check.yml    # Enforces conventional commit PR titles on PRs to main
```

**Flow:**

```
Push / PR to dev
  └── test.yml          → TypeCheck MCP servers, ESLint, Clippy, tests

PR to main / Push to main
  └── test.yml          → full CI suite
  └── desktop-build.yml → Linux build on PR, full matrix (4 platforms) on push

Push to main (after merge)
  └── release-please.yml
      ├── job: release-please
      │   ├── analyzes conventional commits
      │   └── opens/updates release PR OR creates draft release + tag
      └── job: build-and-publish (when release created)
          └── calls desktop-release.yml via workflow_call
              ├── job: resolve (look up draft release ID)
              ├── job: publish-tauri (matrix build, 4 platforms)
              │   ├── build macOS arm64     (.dmg + .app.tar.gz + .sig)
              │   ├── build macOS x86_64    (.dmg + .app.tar.gz + .sig)
              │   ├── build Linux x86_64    (.deb)
              │   ├── build Windows x86_64  (.msi + .nsis.zip + .sig)
              │   ├── sign bundles with TAURI_SIGNING_PRIVATE_KEY
              │   └── upload artifacts + latest.json via releaseId
              ├── job: cli (cross-compile CLI for 4 targets)
              └── job: publish-release (validate 17+ assets + latest.json version, draft → published)

Release published
  └── backmerge.yml
      └── merge main → dev (regular merge)
      └── auto-resolve version file conflicts (main wins)
      └── open PR with auto-merge

PR to main
  └── merge-strategy-check.yml
      └── validate PR title follows conventional commits
      └── exempt: release-please and backmerge PRs
```

## Build Matrix

| Runner           | Platform | Arch                  | Output                |
| ---------------- | -------- | --------------------- | --------------------- |
| `macos-latest`   | macOS    | arm64 (Apple Silicon) | `.dmg`, `.app.tar.gz` |
| `macos-latest`   | macOS    | x86_64 (Intel)        | `.dmg`, `.app.tar.gz` |
| `ubuntu-22.04`   | Linux    | x86_64                | `.deb`                |
| `windows-latest` | Windows  | x86_64                | `.msi`, `.nsis.zip`   |

## Tauri Auto-Update Protocol

Tauri's built-in updater[^53] checks a `latest.json` endpoint on startup and when the user triggers a manual update check.

**latest.json format:**

```json
{
  "version": "2.1.0",
  "notes": "Bug fixes and performance improvements",
  "pub_date": "2026-02-18T12:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "url": "https://github.com/speednet-software/speedwave/releases/download/v2.1.0/Speedwave_2.1.0_aarch64.app.tar.gz",
      "signature": "<base64-encoded-minisign-signature>"
    },
    "darwin-x86_64": {
      "url": "https://github.com/speednet-software/speedwave/releases/download/v2.1.0/Speedwave_2.1.0_x64.app.tar.gz",
      "signature": "<base64-encoded-minisign-signature>"
    },
    "linux-x86_64": {
      "url": "https://github.com/speednet-software/speedwave/releases/download/v2.1.0/speedwave_2.1.0_amd64.deb",
      "signature": "<base64-encoded-minisign-signature>"
    },
    "windows-x86_64": {
      "url": "https://github.com/speednet-software/speedwave/releases/download/v2.1.0/Speedwave_2.1.0_x64-setup.nsis.zip",
      "signature": "<base64-encoded-minisign-signature>"
    }
  }
}
```

## Updater Signing

All update bundles are signed with a **Minisign** ed25519 keypair[^54]:

```bash
cargo tauri signer generate -w ~/.tauri/speedwave.key
```

- **Private key** → stored as `TAURI_SIGNING_PRIVATE_KEY` GitHub Secret (never committed)
- **Public key** → embedded in `tauri.conf.json` (committed, visible to all users)

Tauri verifies the signature before applying any update. A tampered binary will be rejected.[^55]

## CLI Update System

The CLI (`speedwave` binary) uses a separate update mechanism — it checks GitHub Releases directly:

```bash
speedwave update
# → checks https://api.github.com/repos/speednet-software/speedwave/releases/latest
# → compares version with current binary
# → downloads and replaces binary if newer
```

On macOS the CLI is symlinked from inside `Speedwave.app` — updating the Desktop app automatically updates the CLI. On Linux/Windows (standalone CLI install), the binary updates itself in-place.

## GitHub Secrets Required

| Secret / Variable                    | Purpose                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `RELEASE_TOKEN`                      | PAT or GitHub App token — used by release-please and to push to branch-protected `main` |
| `TAURI_SIGNING_PRIVATE_KEY`          | Sign update bundles (minisign private key)                                              |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the private key                                                            |
| `GITHUB_TOKEN`                       | Auto-provided by GitHub Actions for releases                                            |
| `APPLE_CERTIFICATE`                  | macOS code signing (.p12, base64)                                                       |
| `APPLE_CERTIFICATE_PASSWORD`         | Passphrase for macOS certificate                                                        |
| `APPLE_SIGNING_IDENTITY`             | Developer ID Application identity                                                       |
| `APPLE_ID`                           | Apple ID for notarization                                                               |
| `APPLE_PASSWORD`                     | App-specific password for notarization                                                  |
| `APPLE_TEAM_ID`                      | Apple Developer Team ID                                                                 |
| `WINDOWS_CERTIFICATE`                | Windows code signing (.pfx, base64)                                                     |
| `WINDOWS_CERTIFICATE_PASSWORD`       | Passphrase for Windows certificate                                                      |

## CI/CD Security Hardening

All workflow `run:` blocks follow these security practices:

- **No `${{ }}` interpolation in `run:` blocks** — all GitHub context values (`inputs.*`, `github.event.*`) are passed via `env:` to prevent shell injection[^59]
- **Version format validation** — `desktop-release.yml` validates version strings against `^[0-9]+\.[0-9]+\.[0-9]+$` before use
- **`set -e` in all multi-command steps where early exit is appropriate** — ensures early exit on command failure
- **Least-privilege `permissions:`** — `desktop-build.yml` uses `contents: read` (CI-only, no write needed)
- **Pinned action SHAs** — all actions are pinned to full commit SHAs, not mutable tags
- **Secret masking** — all code-signing secrets are explicitly masked with `::add-mask::` before writing to `GITHUB_ENV`

## No macOS Notarization (Initial Release)

macOS notarization[^56] requires an Apple Developer account ($99/year). For the initial open-source release, notarization is skipped. Users on macOS will need to right-click → Open on first launch to bypass Gatekeeper. Notarization will be added in a future release once the project is established.

## Distribution Channels

| Channel         | Platform | Format                          | Notes                            |
| --------------- | -------- | ------------------------------- | -------------------------------- |
| GitHub Releases | All      | `.dmg`, `.msi`, `.deb`          | Primary channel                  |
| Homebrew Cask   | macOS    | `brew install --cask speedwave` | Community tap initially          |
| winget          | Windows  | `winget install speedwave`      | After first stable release       |
| apt repo        | Linux    | `.deb`                          | Future — GitHub Releases for now |

## Addendum: Backmerge Automation and Merge Strategy (2026-03-20)

### Backmerge automation

After the v0.3.0 incident (wrong-version artifacts due to manual dispatch from dev branch), two new workflows were added:

- **`backmerge.yml`** — triggered on `release: [published]`. Merges `main` → `dev` using regular merge (not squash). Version file conflicts are auto-resolved using main's version (main always has the latest release version). Creates a PR with auto-merge enabled.

- **`merge-strategy-check.yml`** — triggered on PRs to `main`. Validates that the PR title follows conventional commits format. Release-please and backmerge PRs are exempt.

### Merge strategy clarification

| PR direction                | Strategy      | Rationale                                                                |
| --------------------------- | ------------- | ------------------------------------------------------------------------ |
| Any → `dev`                 | Squash merge  | Clean dev history                                                        |
| `dev` → `main`              | Squash merge  | PR title becomes the conventional commit that release-please parses      |
| `main` → `dev` (backmerge)  | Regular merge | Preserves main's commit identity; squash would cause phantom release PRs |
| release-please PR on `main` | Squash merge  | Compatible with `force-tag-creation: true` + manifest tracking           |

### Release validation improvements

- `publish-release` job now validates `latest.json` version matches expected version. If mismatch, release is reverted to draft.
- Asset count threshold raised from 9 to 17 (error, not warning). With 9, half the platforms could be missing without detection.
- Tag-aware checkout: `resolve` job checks if the release tag exists. When it does, all build jobs check out the tag (not branch HEAD), ensuring correct version in artifacts.

---

[^47]: [GitHub REST API — Get the latest release (non-prerelease, non-draft only)](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)

[^49]: [Setting Up CI/CD for Tauri — Jacob Bolda (Tauri core contributor)](https://www.jacobbolda.com/setting-up-ci-and-cd-for-tauri/)

[^50]: [tauri-apps/tauri-action — GitHub Action for Tauri releases](https://github.com/tauri-apps/tauri-action)

[^51]: [CrabNebula Cloud — managed Tauri distribution](https://docs.crabnebula.dev/cloud/)

[^52]: [GitHub Docs — Dependabot target-branch configuration](https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/configuration-options-for-the-dependabot.yml-file#target-branch)

[^53]: [Tauri Updater Plugin](https://v2.tauri.app/plugin/updater/)

[^54]: [Tauri Code Signing - Key Generation](https://v2.tauri.app/distribute/sign/linux/)

[^55]: [Tauri Updater Security - Signature Verification](https://v2.tauri.app/plugin/updater/#security)

[^56]: [Apple Developer Program - Notarization](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)

[^59]: [GitHub Security Lab — Script injection in GitHub Actions](https://securitylab.github.com/resources/github-actions-untrusted-input/)

[^60]: [release-please — Commit parsing uses `--first-parent` traversal](https://github.com/googleapis/release-please/blob/main/docs/design.md) — release-please walks `--first-parent` commits on the target branch and parses each message as a conventional commit. Regular merge commits (`Merge pull request #N`) are not conventional commits and are ignored. Squash merge ensures the PR title (which must be a conventional commit) becomes the first-parent commit message.
