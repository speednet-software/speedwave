# ADR-012: GitHub as CI/CD and Distribution Platform

## Decision

Speedwave uses GitHub Actions for CI/CD and GitHub Releases for binary distribution and auto-updates.

## Rationale

The project is open-source. GitHub provides:

- Free CI/CD minutes for public repositories (GitHub Actions)[^57]
- Free binary hosting via GitHub Releases (no bandwidth limits for open-source)[^58]
- Built-in release management with tags and changelogs
- Native integration with the open-source community (Issues, Discussions, PRs)

GitHub Releases as an update server eliminates the need for dedicated update infrastructure (no server to maintain, no CDN costs). The Tauri updater protocol is designed specifically for GitHub Releases[^53] — `latest.json` is generated during the release workflow and uploaded as a release artifact.

## Release Artifacts

GitHub Releases hosts the following platform-specific artifacts (see ADR-021):

| Platform | Artifact                    | Contents                                                       |
| -------- | --------------------------- | -------------------------------------------------------------- |
| macOS    | `Speedwave-x.y.z.dmg`       | `.app` bundle with Lima binaries in `Contents/Resources/lima/` |
| Linux    | `speedwave_x.y.z_amd64.deb` | .deb package with nerdctl-full bundled (see ADR-025)           |
| Windows  | `Speedwave-x.y.z-setup.exe` | NSIS installer with WSL2 rootfs and auto-install logic         |

## SHA256 Verification in CI

The CI pipeline verifies all downloaded dependencies using SHA256 checksums:

1. Lima binaries are downloaded from Lima GitHub Releases[^59]
2. The `SHA256SUMS` file is fetched and the checksum of the downloaded tarball is verified
3. If the checksum does not match, the build fails immediately
4. Verified binaries are bundled into the release artifact

This prevents supply-chain attacks where a compromised download could inject malicious code into the application.

## Rejected Alternatives

- **Self-hosted update server** — operational overhead, cost, single point of failure
- **Sparkle (macOS only)** — not cross-platform
- **Custom update mechanism** — reinventing the wheel; Tauri's updater is battle-tested

---

[^53]: [Tauri Updater Plugin](https://v2.tauri.app/plugin/updater/)

[^57]: [GitHub Actions - Billing for public repos](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions)

[^58]: [GitHub Releases - About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)

[^59]: [Lima GitHub Releases](https://github.com/lima-vm/lima/releases)
