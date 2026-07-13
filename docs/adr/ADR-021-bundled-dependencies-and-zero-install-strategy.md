# ADR-021: Bundled Dependencies and Zero-Install Strategy

> **Status:** Accepted
> **Context:** Fulfilling the "zero dependencies beyond Speedwave" promise from ADR-000 — the user downloads one file and everything works, with no `brew install` or manual WSL2 setup.

## Decision

Each supported platform makes its container runtime available without manual user intervention. macOS bundles Lima inside the `.app`; Windows auto-provisions an isolated WSL2 distribution via the Setup Wizard (with an offline fallback shipped in the installer). Both platforms bundle a pinned Node.js `node` binary for the host-side MCP workers. The CLI is a thin client bundled inside the Desktop app and copied onto the user's PATH at startup. (Linux as a host platform was dropped — see ADR-059.)

## Why

- macOS GUI apps launched from Finder/Spotlight do not inherit the shell PATH, so a Homebrew-installed `limactl` would be invisible.[^1] Bundling Lima inside the `.app` and isolating its VM under `~/.speedwave/lima` (via `LIMA_HOME`[^2]) avoids PATH hacks and conflicts with any user-installed Lima.
- Auto-provisioning WSL2 with a named, isolated distribution keeps Speedwave out of the way of any WSL distros the user already runs.
- Offline / air-gapped installs work: the Windows installer bundles the nerdctl-full tarball and the Ubuntu rootfs, and the Setup Wizard prefers bundled files before any network download.
- A clean macOS install has no `node` in PATH, which would break the host-side MCP workers; bundling the pinned `node` binary keeps the zero-dependency promise.
- Bundling the CLI inside Desktop and re-linking it on every startup guarantees the CLI and Desktop versions stay aligned — a Desktop update distributes the matching CLI automatically.

## Where it lives in code

- Bundled-asset manifest (Lima, Node.js, CLI, native helpers, per platform) — `crates/speedwave-runtime/src/bundle.rs` (`MACOS_BUNDLED_ASSETS`, `WINDOWS_BUNDLED_ASSETS`, `COMMON_BUNDLED_ASSETS`).
- Binary resolution order (env override, then `resources-dir` marker, then the bundle layout, then PATH fallback for dev) — `crates/speedwave-runtime/src/binary.rs` (`resolve_binary`). The bundled-resources env var and marker constants are `BUNDLE_RESOURCES_ENV` (`SPEEDWAVE_RESOURCES_DIR`) and `RESOURCES_MARKER` in `crates/speedwave-runtime/src/consts.rs`.
- Node.js subdir name (SSOT) — `crates/speedwave-runtime/src/consts.rs` (`NODEJS_SUBDIR` = `nodejs`). Under that directory the macOS layout is `nodejs/bin/node` and the Windows layout is `nodejs/node.exe` — siblings, not nested; `resolve_binary` checks `<resources>/nodejs/bin/<cmd>` on Unix and `<resources>/nodejs/<cmd>.exe` on Windows.
- Host-side MCP worker spawn (the consumer that needs `node` on the host) — `crates/speedwave-runtime/src/host_mcp_process/process.rs`.
- Windows WSL2 provisioning + offline-tarball detection — `desktop/src-tauri/src/setup_wizard.rs`.
- CLI linking into the user's PATH (`~/.local/bin/` on macOS, `~/.speedwave/bin/` on Windows) — `desktop/src-tauri/src/setup_wizard.rs` (`link_cli`, `link_cli_from`). The CLI is bundled as `cli/speedwave` (macOS) / `cli/speedwave.exe` (Windows) per `desktop/src-tauri/tauri.macos.conf.json` and `desktop/src-tauri/tauri.windows.conf.json`. See ADR-016 for the cross-platform PATH details.
- Pinned versions (SSOT) — `.lima-version` and `.node-version` at the repo root, consumed by the Makefile and CI; downloads are SHA256-verified at build time.

## Rejected alternatives

- **CLI as a standalone tool with its own bundled Lima** — would duplicate setup logic, complicate self-update (two bundles), and break the "CLI = thin client" principle from ADR-005.
- **Auto-download Lima on first launch** — requires post-install internet, fails in restricted/corporate networks, and risks a silently broken first run.
- **CLI with its own `speedwave setup` command** — would duplicate the Desktop Setup Wizard. Per YAGNI, the CLI delegates all setup to Desktop.
- **Podman as a package dependency / Flatpak packaging** — both were tied to the dropped Linux host path (ADR-059). Podman added a second runtime to maintain alongside nerdctl; Flatpak's sandbox conflicts with rootless container management (containerd needs direct cgroup/namespace/storage access) (unverified). Retained here only as historical rationale.

## License compliance

Lima (Apache 2.0)[^3] and Node.js (MIT)[^4] both permit bundling and redistribution; their license texts ship under `THIRD-PARTY-LICENSES/` in the release artifacts.

[^1]: [Setting PATH and other environment variables for GUI apps launched from Finder](https://developer.apple.com/forums/thread/74371) - Apple DTS engineer confirms GUI apps do not inherit shell-configured PATH and get their environment from `launchd`.

[^2]: [Lima docs: Environment Variables - `LIMA_HOME`](https://lima-vm.io/docs/config/environment-variables/) - specifies the Lima home directory (defaults to `~/.lima`).

[^3]: [lima-vm/lima LICENSE](https://github.com/lima-vm/lima/blob/master/LICENSE) - Apache License, Version 2.0.

[^4]: [nodejs/node LICENSE](https://raw.githubusercontent.com/nodejs/node/main/LICENSE) and [Node.js README](https://github.com/nodejs/node) - "Node.js is licensed under the MIT License."
