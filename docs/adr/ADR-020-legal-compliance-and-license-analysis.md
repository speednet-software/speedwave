# ADR-020: Legal Compliance & License Analysis

> **Status:** Accepted
> **Context:** Speedwave ships as an installable app combining Anthropic's Claude Code, container infrastructure (Lima/nerdctl/containerd, WSL2), and many open-source crates — each carries license obligations that shape the architecture and the release checklist.

## Decision

Speedwave never bundles or redistributes Claude Code and never routes Anthropic credentials — the user installs and authenticates Claude themselves, and Speedwave only orchestrates it. All bundled infrastructure is permissively licensed (Apache 2.0 / MIT); GPL exposure is avoided by forcing Apple's Virtualization framework on macOS and relying on runc (not crun) as the OCI runtime. Speedwave itself is licensed Apache 2.0.

## Why

- **Claude Code is All Rights Reserved.** Its `LICENSE.md` grants no redistribution right[^1], so bundling the binary is prohibited. Speedwave instead builds the Claude container image with a pinned version using the official native installer, and the user authenticates directly with Anthropic.
- **No credential routing.** Routing user OAuth (Pro/Max) tokens through a third-party harness is explicitly prohibited by Anthropic's Consumer Terms[^2] and has been enforced against other tools (unverified). Speedwave only supports the user's own API key / direct auth, so it never handles Anthropic credentials.
- **Wire protocols are not copyrightable.** Implementing the `stream-json` protocol and MCP servers (incl. the IDE bridge) is the intended use. MCP is Apache 2.0 under the Linux Foundation's AAIF[^3].
- **Avoid GPL copyleft.** QEMU (Lima's fallback VM backend) is GPL v2[^4], so Speedwave forces `vmType: vz` (Apple Virtualization framework) on macOS to never invoke QEMU — limiting support to macOS 13.5+[^7]. containerd defaults to runc (Apache 2.0)[^5] inside the bundled nerdctl-full, so no GPL OCI runtime is bundled. If a host's WSL2 distro happens to use crun, that is a separate-process invocation (mere aggregation) and does not trigger copyleft[^6].
- **Apache 2.0 for Speedwave** gives an explicit patent grant, trademark coverage for the "Speedwave" name, and compatibility with the Apache/MIT/BSD/ISC dependency tree.

## Where it lives in code

- Claude Code installer (native `install.sh`, SHA256-verified, pinned version — not npm) — `containers/install-claude.sh`, invoked by `containers/Containerfile.claude` and `containers/entrypoint.sh`.
- Forced Apple Virtualization backend (`vmType: vz`) in the generated Lima config — `desktop/src-tauri/src/setup_wizard.rs`.
- Speedwave's own license — `LICENSE` at the repo root (Apache 2.0).
- Apple `com.apple.security.virtualization` entitlement embedded during bundle signing — see [ADR-037](ADR-037-code-signing-and-bundled-binary-signing.md).
- Windows nerdctl-full bundling rationale — see [ADR-021](ADR-021-bundled-dependencies-and-zero-install-strategy.md).

## Component license summary

- **Apache 2.0** (attribution required, redistribution allowed, no source disclosure): Lima, nerdctl, containerd, runc[^5], Docker/Moby NOTICE components (unverified), Tauri (dual MIT/Apache) (unverified), MCP[^3].
- **MIT**: WSL2 (open-sourced May 2025; user still needs a valid Windows license)[^8], windows-rs, mapi-rs (user needs Outlook for MAPI) (unverified), and most Rust crates (`tokio`, `axum`, `hyper`, `zbus`); `serde`, `clap`, `anyhow`, `thiserror` are MIT OR Apache-2.0 (unverified).
- **GPL v2 — avoided**: QEMU (never used; `vmType: vz` is forced)[^4].
- **GitHub Actions** is permitted for building/shipping Speedwave; only reselling Actions itself is prohibited (unverified).

## Correction (was wrong)

Earlier drafts of this ADR called for using a **MinGW** toolchain for Windows builds to dodge Microsoft Build Tools licensing. The shipped Windows target is `x86_64-pc-windows-msvc` (MSVC) — the only Windows target in `.github/workflows/desktop-release.yml`. Using GitHub's standard `windows-latest` MSVC toolchain carries no licensing concern, so the MinGW recommendation is withdrawn.

## Open compliance actions before public release

- Create a `LICENSES/` directory in the installer (Apache 2.0 full text + `THIRD-PARTY-NOTICES.txt` for Lima/nerdctl/containerd, plus MIT notices for windows-rs, mapi-rs, Tauri) and surface "Open Source Licenses" in the Desktop About dialog.
- Add automated dependency-license auditing (e.g. `cargo-deny`) to CI — not yet wired up.
- Maintain the Apple Developer Program membership for notarization and the virtualization entitlement.
- Monitor Anthropic's Terms; contact Anthropic for written approval before any architecture that would route user credentials.

## Rejected alternatives

- **Bundling the Claude Code binary** — no redistribution grant (All Rights Reserved); rejected outright.
- **Routing user Pro/Max OAuth tokens** — prohibited by Consumer Terms and actively enforced; API-key / direct auth only.
- **QEMU as the macOS VM backend** — GPL v2; replaced by forced Apple Virtualization (`vmType: vz`).
- **MinGW toolchain for Windows** — unnecessary; MSVC on `windows-latest` is used instead (see Correction above).

## References

- [Claude Code legal & compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [com.apple.security.virtualization entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.virtualization)
- [Tauri LICENSE (Apache 2.0)](https://github.com/tauri-apps/tauri/blob/dev/LICENSE-APACHE-2.0) (unverified: MIT-dual claim)
- [windows-rs LICENSE (MIT)](https://github.com/microsoft/windows-rs/blob/master/license-mit) · [mapi-rs LICENSE (MIT)](https://github.com/microsoft/mapi-rs/blob/main/LICENSE)
- [cargo-deny](https://github.com/EmbarkStudios/cargo-deny)
- [GitHub Terms for Additional Products — Actions](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features) (unverified against the specific "no reselling" claim)

## Footnotes

[^1]: [Claude Code LICENSE.md](https://github.com/anthropics/claude-code/blob/main/LICENSE.md) - "All Rights Reserved", no redistribution grant.

[^2]: [Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms).

[^3]: [Model Context Protocol announcement](https://www.anthropic.com/news/model-context-protocol); the MCP specification repository is licensed Apache 2.0 under the Linux Foundation.

[^4]: [QEMU License - GPL v2](https://wiki.qemu.org/License).

[^5]: [Lima LICENSE](https://github.com/lima-vm/lima/blob/master/LICENSE) · [nerdctl LICENSE](https://github.com/containerd/nerdctl/blob/main/LICENSE) · [containerd LICENSE](https://github.com/containerd/containerd/blob/main/LICENSE) · [runc LICENSE](https://github.com/opencontainers/runc/blob/main/LICENSE) (all Apache 2.0).

[^6]: [GPL FAQ - mere aggregation](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation).

[^7]: [Lima VZ vmType docs](https://lima-vm.io/docs/config/vmtype/vz/) - VZ requires macOS >= 13.0, and Lima defaults to VZ on macOS >= 13.5.

[^8]: [Open Source WSL - Microsoft Learn](https://learn.microsoft.com/en-us/windows/wsl/opensource) - WSL source released under the MIT License, announced May 19, 2025.
