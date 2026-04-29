# ADR-021: Bundled Dependencies and Zero-Install Strategy

> **Status:** Accepted
> **Context:** Fulfilling the "zero dependencies" promise from ADR-000

---

## Context

The "zero dependencies beyond Speedwave" principle (ADR-000) was not fully realized in the initial implementation. On macOS, users were required to run `brew install lima` before using Speedwave. On Linux, users had to manually `apt install podman`. On Windows, the `init_vm()` function was an empty stub with no WSL2 provisioning logic.

This violated the core product principle: the user downloads one file and everything works.

## Decision

Each platform uses the most idiomatic approach to ensure runtime dependencies are available without manual user intervention:

### macOS: Bundle Lima in the Application

Lima is bundled inside the application at `.app/Contents/Resources/lima/`. The `LIMA_HOME` environment variable is set to `~/.speedwave/lima` to isolate Speedwave's VM from any user-installed Lima instance.

```
Speedwave.app/
└── Contents/
    └── Resources/
        └── lima/
            ├── bin/
            │   ├── limactl
            │   └── lima
            └── share/
                └── lima/
```

Binary resolution order:

1. `SPEEDWAVE_RESOURCES_DIR` environment variable (if set — used in development)
2. `~/.speedwave/resources-dir` marker file (written by the Desktop app, read by the CLI to discover bundled resources when `SPEEDWAVE_RESOURCES_DIR` is not set)
3. `.app/Contents/Resources/lima/bin/` (production, resolved via `std::env::current_exe()`)
4. System PATH fallback (development mode only)

### Linux: Bundle nerdctl-full in .deb

nerdctl-full is bundled inside the .deb package at `/usr/lib/Speedwave/nerdctl-full/`. On first launch, Speedwave runs `containerd-rootless-setuptool.sh install` to start containerd as a systemd --user service.

System requirements (not bundled):

- `uidmap` package (`newuidmap` / `newgidmap`) — for rootless user namespace mapping[^3]
- `systemd --user` — for the containerd service unit
- `/etc/subuid` + `/etc/subgid` configured for the user

Binary resolution order:

1. `SPEEDWAVE_RESOURCES_DIR` environment variable (development mode)
2. `<resources>/nerdctl-full/bin/` (production, from extracted bundle)
3. System PATH fallback (development mode only)

### Windows: Auto-install WSL2 via Setup Wizard

The Setup Wizard detects whether WSL2 is available and, if missing, installs it:

1. Check: `wsl --status` to detect WSL2 availability
2. Install: `wsl --install --no-distribution` with UAC elevation[^4]
3. Reboot: prompt user to reboot (required for WSL2 kernel installation)
4. Import: `wsl --import Speedwave <install-dir> <rootfs.tar.gz>` creates an isolated named distribution[^5]

Minimum requirement: Windows 10 version 21H2 (Build 19044) or later[^6].

For offline installation, the Windows installer (NSIS) bundles both the nerdctl-full tarball and the Ubuntu rootfs inside the `.exe`. The Setup Wizard checks for bundled files before attempting network downloads, enabling fully offline setup on air-gapped machines.

### CLI = Thin Client (Bundled in Desktop)

The CLI (`speedwave`) is a thin client that requires a running Desktop application with completed setup. The CLI does not bundle runtime dependencies (Lima, nerdctl, WSL2) — it connects to the already-provisioned environment managed by the Desktop app.

The CLI binary itself is bundled inside the Desktop app at build time:

- macOS: `.app/Contents/Resources/cli/speedwave`
- Linux: `<exe_dir>/resources/cli/speedwave`
- Windows: `<exe_dir>/resources/cli/speedwave.exe`

On every Desktop startup (and during initial setup), `setup_wizard::link_cli()` copies the bundled CLI to the user's PATH (`~/.local/bin/` on Unix, `~/.speedwave/bin/` on Windows). This ensures version alignment between CLI and Desktop — a Desktop update automatically distributes the matching CLI version. See ADR-016 for PATH details.

### All Platforms: Bundle Node.js for mcp-os

The mcp-os TypeScript worker (`mcp-servers/os/dist/index.js`) runs on the host via `node`. On a clean macOS install, Node.js is not available in PATH, causing `mcp_os_process.rs` to fail with "No such file or directory". To maintain the zero-dependency promise, the Node.js runtime binary is bundled inside the app.

Only the `node` binary is bundled — npm and other tools are not needed at runtime. The version is pinned in `.node-version` at the repository root (SSOT, same pattern as `.lima-version`).

```
Resources/
└── nodejs/
    └── bin/
        └── node          # Unix (macOS, Linux)
    └── node.exe          # Windows
```

Binary resolution in `resolve_binary()` checks `<resources>/nodejs/bin/<cmd>` (Unix) or `<resources>/nodejs/<cmd>.exe` (Windows) after Lima and nerdctl-full paths. If the bundled binary is not found, it falls back to system PATH — enabling development without downloading Node.js into the resource directory.

SHA256 integrity is verified at download time against the official `SHASUMS256.txt` published alongside each Node.js release[^13]. Node.js is licensed under the MIT License[^14], which permits bundling and redistribution. The LICENSE file is included in `THIRD-PARTY-LICENSES/nodejs-LICENSE`.

## Rationale

### Why bundle Lima on macOS?

GUI applications on macOS do not inherit the user's shell PATH[^7]. A `.app` launched from Finder or Spotlight has a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), which does not include Homebrew's `/opt/homebrew/bin`. Requiring `brew install lima` would mean the Desktop app cannot find `limactl` without PATH hacks.

Bundling is the established pattern for macOS GUI apps. Rancher Desktop (CNCF sandbox project) bundles Lima in the same way[^8]. The isolation via `LIMA_HOME=~/.speedwave/lima` prevents any conflict with a user-installed Lima instance.

### Why bundle nerdctl-full on Linux?

The previous approach (Podman as .deb dependency) added external dependency management burden. Bundling nerdctl-full inside the .deb package makes Linux self-contained — matching the macOS and Windows experience. All three platforms now use the same container runtime (nerdctl), reducing the maintenance surface from three runtime implementations to two (LimaRuntime wraps nerdctl-in-VM, NerdctlRuntime and WslRuntime call nerdctl directly).

### Why auto-install WSL2 on Windows?

WSL2 is a built-in Windows feature that can be enabled programmatically[^4]. The `wsl --install` command is the Microsoft-recommended way to set up WSL2. Using `wsl --import` to create a named distribution (`Speedwave`) isolates Speedwave from any user-configured WSL distributions.

## Rejected Alternatives

### 1. CLI as standalone tool with bundled Lima

Rejected. This would duplicate setup logic between CLI and Desktop, complicate self-update (two separate bundles to update), and violate the "CLI = thin client" principle from ADR-005.

### 2. Auto-download Lima on first Desktop launch

Rejected. This requires an internet connection after installation, which is a worse user experience than bundling. Users in corporate environments may have restricted internet access. The download could also fail silently, leading to a broken first-run experience.

### 3. Podman as package dependency (.deb only)

Previously used (see ADR-003 history). Rejected because it added external dependency management burden. Also requires maintaining a separate container runtime alongside nerdctl used on macOS/Windows.

### 4. Flatpak instead of .deb

Rejected. Flatpak's sandbox model conflicts with rootless container management[^10]. containerd/nerdctl needs direct access to cgroups, namespaces, and the container storage directory — all of which are restricted by Flatpak's Bubblewrap sandbox.

### 5. CLI with own `speedwave setup` command

Rejected. This would duplicate the Setup Wizard logic that already exists in the Desktop app. Per YAGNI, the CLI delegates all setup to the Desktop. Adding a separate setup path increases maintenance burden and creates a second code path to test.

## License Compliance

Lima is licensed under Apache License 2.0[^11], which permits bundling and redistribution. The following files are included in the release artifacts under `THIRD-PARTY-LICENSES/`:

- `LICENSE` (Apache 2.0 full text)
- `NOTICE` (Lima copyright notice)

## Supply-Chain Security

Lima binaries are downloaded during the build process (CI) with SHA256 verification:

1. Download Lima release tarball from GitHub Releases[^12]
2. Verify SHA256 checksum against the published `SHA256SUMS` file
3. Bundle verified binaries into the `.app` or installer

The Makefile and CI pipeline enforce checksum verification — builds fail if checksums do not match. The Lima version is pinned in `.lima-version` at the repository root (SSOT for both Makefile and CI).

---

[^3]: [rootless containers — subuid/subgid + newuidmap/newgidmap requirement](https://rootlesscontaine.rs/getting-started/common/subuid/)

[^4]: [Install WSL - Microsoft Learn](https://learn.microsoft.com/en-us/windows/wsl/install)

[^5]: [Import a Linux distribution - wsl --import](https://learn.microsoft.com/en-us/windows/wsl/use-custom-distro)

[^6]: [WSL2 requirements - Windows 10 version 21H2](https://learn.microsoft.com/en-us/windows/wsl/install-manual#step-2---check-requirements-for-running-wsl-2)

[^7]: [Apple Developer - About the PATH environment in macOS apps](https://developer.apple.com/library/archive/qa/qa1067/_index.html)

[^8]: [Rancher Desktop - Lima integration (CNCF sandbox)](https://github.com/rancher-sandbox/rancher-desktop/tree/main/src/go/wsl-helper)

[^10]: [Flatpak sandbox permissions](https://docs.flatpak.org/en/latest/sandbox-permissions.html)

[^11]: [Lima LICENSE - Apache 2.0](https://github.com/lima-vm/lima/blob/master/LICENSE)

[^12]: [Lima GitHub Releases](https://github.com/lima-vm/lima/releases)

[^13]: [Node.js SHASUMS256.txt for releases](https://nodejs.org/dist/)

[^14]: [Node.js LICENSE — MIT](https://github.com/nodejs/node/blob/main/LICENSE)
