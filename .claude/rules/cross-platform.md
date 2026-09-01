---
paths:
  - 'crates/**/*.rs'
  - 'desktop/src-tauri/**'
  - 'desktop/src/**'
  - 'mcp-servers/**'
  - 'containers/**'
  - 'scripts/**'
  - 'native/**'
---

# Cross-Platform Rules (macOS Lima ↔ Windows WSL2)

Every change must work on **both** platforms. `make check` compiles the host target only — `cfg(unix)`/`cfg(windows)`-gated code must be hand-reviewed for the other platform; the Windows CI job is the first thing that compiles Windows-only paths, so a green local check proves nothing about them.

## Paths

- Never `PathBuf::join` or hand-build a path that reaches the container engine — on Windows it silently mangles `/`-rooted WSL paths. Use `engine_path::{to_engine_path, str_to_engine_path, vm_path_join}` (drift-tested).
- On Windows `fs::canonicalize` returns `\\?\`-prefixed paths that break config/UI/script consumers — strip via `engine_path::strip_extended_length_prefix` before storing or displaying.
- **Never `canonicalize` a WSL UNC path** (`\\wsl.localhost\…`, `\\wsl$\…`) — behavior is undocumented and varies by Windows build. Classify via `runtime::wsl::is_wsl_unc_path`, check existence with `fs::metadata`, store the raw UNC string.
- Plugin signature digests hash POSIX `/`-separated relative paths on every host — a native `\` separator in digest input fails verification only on Windows.

## Network

- Never bind or dial `127.0.0.1` in production code — WSL2 mirrored networking breaks container↔host loopback on Windows. Use `compose::host_bind_address()` / `host_gateway_ip()` (drift-tested). On macOS they split (bind 127.0.0.1, gateway 192.168.5.2); on Windows **NAT** both equal the WSL adapter IP, while **mirrored** mode (the VPN-compat default, ADR-067) splits them — bind `127.0.0.1`, gateway `10.200.0.1` fronted by a guest `socat` relay (`mirror_relay_port`, ADR-080).
- Never cache the Windows bind/gateway IP in a `OnceLock`/const — the WSL adapter IP changes across `wsl --shutdown`. Re-read `host_bind_address()` and handle `EADDRNOTAVAIL` by re-detect + rebind (pattern: `bridges/host_bridge.rs::bind_with_retry`, Desktop crate).
- Addressing is a pluggable strategy (`compose/addressing.rs`, ADR-067): the `HostAddressingComputer` trait (`LimaStatic`/`WslDetector`/`Unsupported`) behind two `RwLock`s — a value cache and a strategy slot; the resolved `HostAddressing` carries an explicit `AddressingMode` (never inferred from the gateway IP). In tests pin via the RAII helpers `pin_direct_addressing`/`pin_mirrored_addressing` (or `set_host_addressing_computer_for_test`) under `#[serial_test::serial(host_addressing)]`; never mutate a raw cached IP. Under `cfg(test)`/the `test-support` feature the default computer is a deterministic fixture — desktop tests never spawn `wsl.exe` through addressing.
- `MCP_LISTEN_HOST` is the only channel telling a Node host-worker which interface to bind: Rust sets it from `host_bind_address()` (`host_mcp_process/process.rs`), TS reads it with a `127.0.0.1` fallback (`server.ts`). Under mirrored mode loopback is the _intended_ bind (the ADR-080 relay bridges container→host); the hazard is **NAT** mode, where `host_bind_address()` is the WSL adapter IP and a Rust↔TS mismatch silently falls back to loopback, breaking container→host. No cross-read test guards it.

## Filesystem

- Durable writes go through `fs_perms` helpers only: fsync-before-rename is mandatory (APFS/virtiofs tear otherwise — the torn-compose.yml class of bugs), macOS needs `F_FULLFSYNC` with fsync fallback, and directory fsync must stay `#[cfg(unix)]` — Windows has no equivalent.
- Never set file modes directly — `fs_perms::set_owner_only{_dir}` is the SSOT (Unix chmod 0o600/0o700 ↔ Windows DACL). `PermissionsExt` does not compile on Windows; mode bits mean nothing on NTFS.
- Windows drvfs automount needs `metadata,uid=1000,gid=1000,umask=022` (written by `provision::ensure_wsl_distro_metadata` via `consts::wsl_automount_options()`) — containers run as UID 1000; `EACCES` on `/workspace` means missing automount metadata, not a container bug ("cannot exec in a stopped state" is the symptom).
- macOS: `EPERM` from `read_dir` under `~/Library/CloudStorage` or `~/OneDrive*` is a TCC permission gap, not an fs error — route through `cloudstorage.rs` detection so the remediation modal surfaces.
- macOS virtiofs can serve the guest a stale or torn view of a just-written host file — field-specific compose schema errors (`networks.X.driver must be a string`, `…limits.cpus must be a number or string`, or a bare `yaml:` parse error) and ENOENT on the freshly renamed compose file (fragment `compose.yml: no such file or directory` — a stale guest dentry, the file exists host-side) go through the `is_propagation_error` retry heuristic (`runtime/mod.rs`); never shrink its retry window or treat these as fatal without a retry. A _bare_ `must be a string` is deliberately NOT retried, ENOENT on any other path is deliberately NOT retried (a missing token/binary is a real error), and network-reference integrity is a render-time check (`validate_compose_network_refs` in compose/mod.rs), not a retry class.

## Processes & encodings

- Spawn processes only via the `binary.rs` helpers (`system_command` for non-interactive system tools — it applies `CREATE_NO_WINDOW` (no console flash) and `WSL_UTF8=1`; `interactive_command` for TTY-visible spawns; `command` for bundled binaries); raw `Command::new("wsl")` yields UTF-16LE output that breaks parsing (`runtime/wsl.rs::decode_wsl_output` still carries a UTF-16LE output-decode fallback). Drift-tested by `tests/no_raw_command_spawn.rs`.
- Invoke PowerShell only via `binary::run_powershell` (absolute System32 `WindowsPowerShell` path; a bare `powershell` PATH lookup can resolve wrongly) — the API requires an explicit kill deadline; short probes get seconds, long operations (WSL install, rootfs download) generous minutes, nothing runs unbounded.
- Validate shell command strings via `shlex::split`, never by shelling to `bash -n` — Git Bash on Windows mangles UTF-8 (claude-code#31295); a bash-based validator regresses Windows only.
- Never hand-concatenate `PATH` entries with `:` — Windows uses `;`; use the cfg-gated `binary::PATH_SEP` separator (the pattern in `binary.rs::command`), never a hardcoded `:`.
- CRLF is three-sided: preserve the user's line endings (and bail on UTF-16 from PowerShell `Out-File`) when merging `.wslconfig`/`wsl.conf`; reject control chars incl. `\r\n` in any secret/token value (header injection); repo files are LF-only via `.gitattributes` — a CRLF shebang exits 127 in the container (issue #603; CI re-clones with `autocrlf=true` to assert it).
- BOM polarity is asymmetric: `.ps1` files must be UTF-8 **with** BOM (PowerShell falls back to the system locale reading a BOM-less `.ps1`; editing one requires `make generate-installer-nsh`); `.vbs` and `.sh` must be BOM-**free** (wscript and shebangs choke on it). Note: `sweep.ps1`, `setup-dev-windows.ps1`, and `install-vulkan-sdk.ps1` carry the BOM in-repo; nothing test-pins `.ps1` BOMs (only `run-hidden.vbs`'s BOM-freeness is pinned).

## Platform asymmetries to keep in mind

- VM sizing (`resources.rs`, host/2) applies to Lima on macOS only — WSL2 memory/CPU is deliberately unmanaged and Windows RAM detection falls back to 16 GiB; never assume symmetric VM capacity or add Windows-side sizing.
- The whisper Vulkan build (ADR-085) adds two Windows-only build hazards: (1) the ggml-vulkan shader ExternalProject nests ~250 chars of CMake scratch below the cargo target dir (248 measured: the MSBuild-generator TryCompile's `cmTC_*.tlog\ParallelCustomBuild.command.1.tlog`; ninja is shallower), and neither `cl.exe`'s front-end nor MSBuild's `GetOutOfDateItems` can handle >260-char paths **even with `LongPathsEnabled`** (which `setup-dev-windows` still enables — ninja needs it; symptoms: `ninja: GetLastError() = 3` then `C1083`, or `error MSB4018` `GetOutOfDateItems`/`%(FullPath)` in a CMake TryCompile). `scripts/check-vulkan-path-budget.sh` gates the bundle-producing paths (the CI `prepare-desktop-bundle` action and the `stage-vulkan-windows` make targets); jobs that pin a short `CARGO_TARGET_DIR` directly (`test.yml`'s `desktop-windows-check` `D:\st`, the e2e rig's `C:\cb`) rely on that escape instead of the gate. The escapes are a short `CARGO_TARGET_DIR`, a short crate-local `desktop/src-tauri/.cargo/config.toml` `target-dir` (gitignored), or a shorter clone path. (2) Every Windows build with `audio-transcription` needs the pinned Vulkan SDK (`VULKAN_SDK` env; `scripts/install-vulkan-sdk.ps1` is the only install path — CI and setup-dev both call it). The shipped exe carries a load-time `vulkan-1.dll` import, so the bundled loader (staged by `scripts/stage-vulkan-runtime.sh`) must never be dropped from the Windows resources.
- Windows MSVC links the dynamic CRT (`/MD`) everywhere — never set `-C target-feature=+crt-static` or `CMAKE_MSVC_RUNTIME_LIBRARY`. Any new native prebuilt dependency must ship an MD/dynamic-CRT variant; an `/MT` static-lib in the link is a hard LNK2038 failure, invisible from a macOS host until Windows CI runs (it kept the Windows CI matrix failing; sherpa-onnx removal, ADR-075, eliminated the last CRT workaround).
- Desktop UI runs on two engines: WebView2 (Chromium — strict CSP; `blob:`/`data:` images need explicit `img-src`) vs WKWebView (lenient CSP, own SVG/CSS quirks). A feature verified on macOS is not verified on Windows.
- nerdctl versions move in lockstep (macOS via `.lima-version`, Windows via `consts::NERDCTL_FULL_VERSION`) — but they are NOT string-equal (e.g. Lima 2.1.2 ships nerdctl 2.2.2); alignment is via the known lima→nerdctl table in `consts.rs`, test-guarded. The SHA256 values stay manual.
- Host TZ detection (`tz.rs::detect_host_timezone`) splits by platform: Unix reads `$TZ`/`/etc/localtime` validated against an IANA-shape allowlist; Windows shells `(Get-TimeZone).Id` via `binary::run_powershell_capture` (5s kill deadline) and maps through the ~140-entry `WINDOWS_TO_IANA` table (no freshness guard — adding/renaming a Windows zone is a Windows-only correctness surface). Failure degrades to `Etc/UTC` with a warn, never a hard error; "container clocks in UTC" points here first. The injected `TZ` needs `tzdata` in every image or it collapses to a numeric offset.
