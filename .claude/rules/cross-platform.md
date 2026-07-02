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

- Never bind or dial `127.0.0.1` in production code — WSL2 mirrored networking breaks container↔host loopback on Windows. Use `compose::host_bind_address()` / `host_gateway_ip()` (drift-tested). On Windows both equal the runtime-detected WSL adapter IP; on macOS they split (bind 127.0.0.1, gateway 192.168.5.2).
- Never cache the Windows bind/gateway IP in a `OnceLock`/const — the WSL adapter IP changes across `wsl --shutdown`. Re-read `host_bind_address()` and handle `EADDRNOTAVAIL` by re-detect + rebind (pattern: `host_bridge::bind_with_retry`).

## Filesystem

- Durable writes go through `fs_perms` helpers only: fsync-before-rename is mandatory (APFS/virtiofs tear otherwise — the torn-compose.yml class of bugs), macOS needs `F_FULLFSYNC` with fsync fallback, and directory fsync must stay `#[cfg(unix)]` — Windows has no equivalent.
- Never set file modes directly — `fs_perms::set_owner_only{_dir}` is the SSOT (Unix chmod 0o600/0o700 ↔ Windows DACL). `PermissionsExt` does not compile on Windows; mode bits mean nothing on NTFS.
- Windows drvfs automount needs `metadata,uid=1000,gid=1000` (written by `provision::ensure_wsl_distro_metadata`) — containers run as UID 1000; `EACCES` on `/workspace` means missing automount metadata, not a container bug ("cannot exec in a stopped state" is the symptom).
- macOS: `EPERM` from `read_dir` under `~/Library/CloudStorage` or `~/OneDrive*` is a TCC permission gap, not an fs error — route through `cloudstorage.rs` detection so the remediation modal surfaces.

## Processes & encodings

- Spawn system processes only via `binary::system_command` — it applies `CREATE_NO_WINDOW` (no console flash) and `WSL_UTF8=1`; raw `Command::new("wsl")` yields UTF-16LE output that breaks parsing.
- CRLF is three-sided: preserve the user's line endings (and bail on UTF-16) when merging `.wslconfig`/`wsl.conf`; reject `\r\n` in any secret/token value (header injection); repo files are LF-only via `.gitattributes` — a CRLF shebang exits 127 in the container.
- BOM polarity is asymmetric: `.ps1` files must be UTF-8 **with** BOM (and editing one requires `make generate-installer-nsh`); `.vbs` must be BOM-**free** (wscript chokes on it).

## Platform asymmetries to keep in mind

- VM sizing (`resources.rs`, host/2) applies to Lima on macOS only — WSL2 memory/CPU is deliberately unmanaged; never assume symmetric VM capacity or add Windows-side sizing.
- Desktop UI runs on two engines: WebView2 (Chromium — strict CSP; `blob:`/`data:` images need explicit `img-src`) vs WKWebView (lenient CSP, own SVG/CSS quirks). A feature verified on macOS is not verified on Windows.
- nerdctl versions move in lockstep (macOS via `.lima-version`, Windows via `consts::NERDCTL_FULL_VERSION`) — divergence changes compose-up recreation semantics per platform (test-guarded; the SHA256 values stay manual).
