# ADR-020: Legal Compliance & License Analysis

> **Last reviewed:** 2026-02-18

---

## Critical Finding: Claude Code Cannot Be Bundled

**Claude Code is proprietary software — All Rights Reserved.**[^1]

The `LICENSE.md` of Claude Code reads verbatim:

> "Copyright Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial Terms of Service."

This has significant architectural implications for Speedwave. See Section 1 for details.

---

## 1. Anthropic / Claude Code

### What is prohibited

| Action                                              | Status        | Reason                                                                                 |
| --------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------- |
| Bundle Claude Code binary in Speedwave installer    | 🔴 PROHIBITED | All Rights Reserved, no redistribution grant                                           |
| Route user OAuth tokens (Pro/Max) through Speedwave | 🔴 PROHIBITED | Explicitly prohibited in Consumer Terms[^2]; enforced against OpenCode in Jan 2026[^3] |
| Offer "Claude Max access" as a Speedwave feature    | 🔴 PROHIBITED | Cannot route subscription credentials on behalf of users                               |
| Resell Claude API capacity                          | 🔴 PROHIBITED | Commercial Terms prohibit reselling without express approval                           |
| Build competing AI model using Claude outputs       | 🔴 PROHIBITED | Both Consumer and Commercial Terms                                                     |

### What is permitted

| Action                                                          | Status       | Condition                                                            |
| --------------------------------------------------------------- | ------------ | -------------------------------------------------------------------- |
| Call Anthropic API with your own API key                        | 🟢 PERMITTED | Commercial Terms allow powering products for your customers[^4]      |
| Users install Claude Code themselves, Speedwave orchestrates it | 🟢 PERMITTED | Users agree to Anthropic ToS directly; Speedwave is a workflow layer |
| Use `--dangerously-skip-permissions` in isolated containers     | 🟢 PERMITTED | Must use proper isolation (Lima VM, container); no harm to users     |
| Implement the `stream-json` protocol directly                   | 🟢 PERMITTED | Wire protocols are not copyrightable                                 |
| Build automation pipelines with Agent SDK (API key auth)        | 🟢 PERMITTED | Under Commercial Terms with API key, not OAuth                       |

### Architectural Decision Required

**Speedwave MUST NOT bundle Claude Code.** The required approach:

```
User installs Speedwave
  └── Speedwave builds the Claude container image with a pinned version:
        install-claude.sh <version> (SSOT script, uses official installer)
      The official installer (bootstrap.sh) verifies binary SHA256 via GCS manifest
      User authenticates directly with Anthropic (their own account/API key)
      Speedwave orchestrates their local Claude Code instance as a subprocess
```

**Note on the deprecated npm method:** As of early 2026, `npm install -g @anthropic-ai/claude-code` is officially deprecated by Anthropic.[^5a] The native installer (`curl https://claude.ai/install.sh`) is now the recommended and supported method. It self-updates automatically. Speedwave's setup wizard MUST use the native installer.

This is legally clean because:

- The user has a direct contractual relationship with Anthropic
- Speedwave is a workflow orchestration layer, not a credential router
- Speedwave never handles Anthropic credentials

### MCP Protocol

MCP was donated by Anthropic to the Linux Foundation's Agentic AI Foundation (AAIF) in December 2025.[^5] It is licensed under Apache 2.0. Building MCP-compatible servers (including IDE Bridge) is the exact intended use. No restrictions.

---

## 2. Infrastructure Components

### Lima + nerdctl + containerd (macOS)

All three are **Apache 2.0** — fully permissive.[^6][^7][^8]

| Requirement           | Detail                                   |
| --------------------- | ---------------------------------------- |
| Commercial use        | ✅ Allowed                               |
| Binary redistribution | ✅ Allowed                               |
| Source disclosure     | ❌ Not required                          |
| Attribution           | ✅ Required — LICENSE text + NOTICE file |

**QEMU Warning:** QEMU (Lima's fallback VM backend) is **GPL v2**.[^9] Speedwave MUST force `vmType: vz` (Apple Virtualization Framework) to avoid QEMU entirely. This limits support to macOS 13.5+ (Ventura), which is acceptable.

**Required attribution** (in `LICENSES/THIRD-PARTY-NOTICES.txt`):

- The Lima Authors
- containerd / Docker, Inc. (2012–2015)
- Docker/Moby components

### nerdctl-full (Linux)

nerdctl is **Apache 2.0**.[^10] Same requirements as Lima + nerdctl + containerd above — attribution required, binary redistribution permitted, no source disclosure needed. nerdctl-full is bundled inside the .deb package (see ADR-003, ADR-021, and ADR-025).

**crun note:** containerd defaults to runc (Apache 2.0) as its OCI runtime, so there is no GPL exposure from the bundled nerdctl-full. If the system has crun installed, containerd may use it as a subprocess — this is **not a licensing concern** for Speedwave: invoking a GPL binary as a subprocess does not trigger copyleft obligations.[^10a] This is analogous to any application calling `/usr/bin/bash` (GPL v3) — the caller is not a derivative work.

### WSL2 + windows-rs + mapi-rs (Windows)

| Component  | License                          | Notes                                         |
| ---------- | -------------------------------- | --------------------------------------------- |
| WSL2       | MIT (open-sourced May 2025)[^11] | User needs valid Windows 10/11 license        |
| windows-rs | MIT (Microsoft)[^12]             | No restrictions                               |
| mapi-rs    | MIT (Microsoft)[^13]             | User needs valid Outlook for MAPI to function |

Calling `wsl.exe` programmatically has no documented restrictions.

### Apple Virtualization Framework

Not a separate license — part of macOS. Requires:[^14]

- Apple Developer Program membership ($99/year)
- `com.apple.security.virtualization` entitlement (self-serve in Xcode)
- Notarized distribution (not Mac App Store required)
- Bridged networking needs additional DTS request from Apple

### Tauri

Dual-licensed **MIT + Apache 2.0**.[^15] Fully commercial-friendly.

**Windows build note:** Use MinGW toolchain instead of MSVC to avoid potential Microsoft Build Tools licensing concerns.[^16]

---

## 3. Open Source Dependencies

### Rust Ecosystem

All standard Rust crates are MIT or MIT/Apache-2.0 dual-licensed:

| Crate              | License           |
| ------------------ | ----------------- |
| tokio              | MIT               |
| serde / serde_json | MIT OR Apache-2.0 |
| zbus               | MIT               |
| axum, hyper        | MIT               |
| clap               | MIT OR Apache-2.0 |
| anyhow, thiserror  | MIT OR Apache-2.0 |

**Action:** Add `cargo-deny` to CI to automatically audit transitive dependencies.[^17]

### vibe-kanban (reference study)

Licensed Apache 2.0.[^18] Speedwave studied their architecture only — no code was copied. Ideas and architectural patterns are not copyrightable. Zero legal exposure.

### GitHub Actions

Permitted for building and shipping Speedwave.[^19] The prohibition applies only to reselling GitHub Actions itself as a product. Using it for CI/CD of our own product is fully permitted.

---

## 4. Required Actions Before Public Release

### Immediate

- [ ] **Remove any assumption of bundling Claude Code** — update architecture to require user self-install
- [ ] **Force `vmType: vz` in Lima config** — eliminates QEMU GPL issue (macOS 13.5+ only)
- [x] ~~**Use `runc` explicitly on Linux**~~ — **resolved: not needed.** containerd defaults to runc (Apache 2.0) in the bundled nerdctl-full; no GPL OCI runtime is bundled or distributed. No copyleft risk.
- [ ] **Use MinGW toolchain for Windows builds** — avoids MSVC license ambiguity

### Before First Release

- [ ] **Create `LICENSES/` directory** in installer with:
  - Apache 2.0 full text
  - `THIRD-PARTY-NOTICES.txt` (Lima, nerdctl, containerd NOTICE files)
  - MIT notices for windows-rs, mapi-rs, Tauri
- [ ] **Add "Open Source Licenses" to About dialog** in Desktop app
- [ ] **Add `cargo-deny` to GitHub Actions CI** for dependency license auditing
- [x] **Publish LICENSE** (Apache-2.0 chosen for Speedwave) at repo root
- [ ] **Obtain Apple Developer Program membership** for notarization + VZ entitlement
- [ ] **Embed `com.apple.security.virtualization` entitlement** via codesign during bundle signing (self-serve, no Apple approval needed) — see [ADR-037](ADR-037-code-signing-and-bundled-binary-signing.md)

### Ongoing

- [ ] **Contact Anthropic** if any architecture requires routing user credentials — get explicit written approval
- [ ] **Monitor Anthropic ToS** — they have updated enforcement without prior notice (January 2026 precedent)

---

## 5. License for Speedwave Itself

**Decision: Apache License 2.0**

Rationale:

- Patent protection — explicit patent grant protects Speednet and users
- Trademark protection — covers "Speedwave" name
- Compatible with all dependencies (Apache 2.0, MIT, BSD, ISC)
- Consistent with infrastructure ecosystem (Lima, nerdctl, containerd, Docker — all Apache 2.0)
- Professional signal — standard for company-backed open-source projects

The `presale` MCP server (private business component) remains proprietary and is NOT included in the open-source repo.[^20]

---

## 6. Risk Summary

| Risk                        | Severity  | Mitigation                                               |
| --------------------------- | --------- | -------------------------------------------------------- |
| Bundling Claude Code binary | 🔴 HIGH   | Require user self-install via npm                        |
| OAuth credential routing    | 🔴 HIGH   | API key only; users authenticate directly with Anthropic |
| QEMU GPL on macOS           | 🟡 MEDIUM | Force `vmType: vz`, require macOS 13.5+                  |
| crun GPL on Linux           | 🟢 LOW    | Not bundled — subprocess invocation, no copyleft risk    |
| MSVC license on Windows     | 🟡 MEDIUM | Use MinGW toolchain in GitHub Actions                    |
| Missing attribution         | 🟡 MEDIUM | Create LICENSES/ directory before release                |
| Apple VZ entitlement        | 🟡 MEDIUM | Apply via Apple Developer portal                         |
| Anthropic ToS changes       | 🟡 MEDIUM | Monitor; no bundling = lower exposure                    |

---

[^1]: [Claude Code LICENSE.md](https://github.com/anthropics/claude-code/blob/main/LICENSE.md)

[^2]: [Claude Code Legal and Compliance - Official Docs](https://code.claude.com/docs/en/legal-and-compliance)

[^3]: [Anthropic Blocks Claude Max in OpenCode - VentureBeat](https://venturebeat.com/technology/anthropic-cracks-down-on-unauthorized-claude-usage-by-third-party-harnesses)

[^4]: [Anthropic Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms)

[^5]: [MCP donated to Linux Foundation AAIF](https://www.anthropic.com/news/model-context-protocol)

[^5a]: [Claude Code Getting Started - NPM installation deprecated](https://code.claude.com/docs/en/getting-started#npm-installation-deprecated)

[^6]: [Lima LICENSE - Apache 2.0](https://github.com/lima-vm/lima/blob/master/LICENSE)

[^7]: [nerdctl LICENSE - Apache 2.0](https://github.com/containerd/nerdctl/blob/main/LICENSE)

[^8]: [containerd LICENSE - Apache 2.0](https://github.com/containerd/containerd/blob/main/LICENSE)

[^9]: [QEMU License - GPL v2](https://wiki.qemu.org/License)

[^10]: [nerdctl LICENSE - Apache 2.0](https://github.com/containerd/nerdctl/blob/main/LICENSE)

[^10a]: [GPL FAQ — "mere aggregation" vs derivative works](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation) — invoking a program as a separate process (pipes, sockets, command-line) does not make the caller a derivative work.

[^11]: [WSL open-sourced under MIT - May 2025](https://blogs.windows.com/windowsdeveloper/2025/05/19/the-windows-subsystem-for-linux-is-now-open-source/)

[^12]: [windows-rs LICENSE-MIT](https://github.com/microsoft/windows-rs/blob/master/license-mit)

[^13]: [mapi-rs LICENSE](https://github.com/microsoft/mapi-rs/blob/main/LICENSE)

[^14]: [com.apple.security.virtualization entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.virtualization)

[^15]: [Tauri LICENSE - MIT + Apache 2.0](https://github.com/tauri-apps/tauri/blob/dev/LICENSE_APACHE-2.0)

[^16]: [Tauri Windows MinGW toolchain discussion](https://github.com/tauri-apps/tauri/discussions/11536)

[^17]: [cargo-deny - dependency license auditing](https://github.com/EmbarkStudios/cargo-deny)

[^18]: [vibe-kanban LICENSE - Apache 2.0](https://github.com/BloopAI/vibe-kanban/blob/main/LICENSE)

[^19]: [GitHub Terms for Additional Products - Actions](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features)

[^20]: Internal architectural decision — no public source available. The presale MCP server is a proprietary component maintained in a separate private repository, not included in the open-source Speedwave distribution. [unverified — internal decision, no external URL]
