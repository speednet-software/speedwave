# ADR-012: GitHub as CI/CD and Distribution Platform

> **Status:** Accepted
> **Context:** Open-source project needs CI/CD, binary hosting, and an auto-update channel without standing up dedicated infrastructure.

## Decision

Speedwave uses GitHub Actions for CI/CD and GitHub Releases for binary distribution and auto-updates. The Tauri updater consumes a `latest.json` manifest published as a release asset.

## Why

- Free CI/CD minutes[^1] and free binary hosting[^2] for public repositories — no server to run, no CDN to pay for.
- GitHub Releases doubles as the update server: the Tauri updater protocol is built around it[^3] (`latest.json` is generated during the release workflow and uploaded as a release artifact).
- Native integration with the open-source workflow (Issues, Discussions, PRs, tags, changelogs).
- Release versioning is automated by release-please; the desktop release workflow uploads platform artifacts to the release it manages.

## Release Artifacts

Only macOS and Windows are built — Linux was dropped as a host platform (see [ADR-059](ADR-059-drop-linux-support.md)). The Tauri bundle targets are `nsis`, `msi`, `app`, and `dmg`; there is no `.deb` target and no Linux entry in the release build matrix.

| Platform            | Artifact                                  | Contents                                                          |
| ------------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| macOS Apple Silicon | `Speedwave_<ver>_macOS_Apple_Silicon.dmg` | `.app` bundle with Lima binaries under `Contents/Resources/lima/` |
| macOS Intel         | `Speedwave_<ver>_macOS_Intel.dmg`         | same `.app` layout, x86_64 build                                  |
| Windows (NSIS)      | `Speedwave_<ver>_x64-setup.exe`           | NSIS installer with WSL2 setup logic                              |
| Windows (MSI)       | `Speedwave_<ver>_x64_en-US.msi`           | MSI installer (same payload, MSI packaging)                       |

The two macOS DMGs are produced from one matrix per arch (`aarch64-apple-darwin`, `x86_64-apple-darwin`) with arch labels applied via the release workflow's `assetNamePattern`. The Windows job produces both the NSIS and MSI installers under Tauri's default naming. See [ADR-021](ADR-021-bundled-dependencies-and-zero-install-strategy.md) for what gets bundled into each artifact.

## SHA256 Verification in CI

Bundled dependencies are verified by SHA256 before they go into a release artifact. For Lima (macOS), the build fetches the upstream `SHA256SUMS` from the Lima GitHub release[^4], verifies the downloaded tarball against it, and fails the build immediately on mismatch — preventing a compromised download from injecting code into the app.

## Where it lives in code

- Bundle targets (`nsis`, `msi`, `app`, `dmg`) — `desktop/src-tauri/tauri.conf.json`
- Release build matrix + per-arch asset naming — `.github/workflows/desktop-release.yml`
- macOS Lima bundling into `Contents/Resources/lima/` — `desktop/src-tauri/tauri.macos.conf.json`
- Lima SHA256 download verification — `.github/actions/download-lima/action.yml` and the `download-lima` target in `Makefile`
- Automated version bumps / release PRs — `.github/workflows/release-please.yml`, `release-please-config.json`

## Rejected alternatives

- **Self-hosted update server** — operational overhead, cost, single point of failure.
- **Sparkle (macOS only)** — not cross-platform.
- **Custom update mechanism** — reinventing the wheel; Tauri's updater is battle-tested.

---

## References

[^1]: [GitHub Actions - billing for public repos](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions)

[^2]: [GitHub Releases - about releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)

[^3]: [Tauri Updater Plugin](https://v2.tauri.app/plugin/updater/)

[^4]: [Lima GitHub Releases](https://github.com/lima-vm/lima/releases)
