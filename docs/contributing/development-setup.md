# Development Setup

How to set up the Speedwave development environment.

## Prerequisites

- **Rust** — stable toolchain via `rustup`
- **Node.js** — LTS (v20+) with npm
- **Platform tools** — Xcode CLI tools (macOS), Visual Studio Build Tools (Windows)

Run `make setup-dev` to check prerequisites and install all dependencies automatically.

## Building

**Use `Makefile` for all build/test/check operations.** Do not call cargo/npm directly — the Makefile ensures correct working directories and consistent flags.

### Primary targets

```bash
make setup-dev      # first-time: check prerequisites + install all dependencies
make test           # run all tests (Rust + Angular + MCP + entrypoint + desktop)
make check          # lint + clippy + type-check + format
make check-all      # full quality gate: check + test + coverage + audit
make coverage-html  # generate HTML coverage reports and open in browser
make audit          # check dependencies for known vulnerabilities
make dev            # start desktop in dev mode (Tauri + Angular hot reload)
make build          # build everything
make fmt            # format all code
make status         # quick health check
```

### Granular targets

- **Test:** `test-rust`, `test-cli`, `test-angular`, `test-mcp`, `test-os`, `test-desktop`, `test-e2e`, `test-e2e-plugin-tamper-release`, `test-entrypoint`, `test-desktop-build`, `test-e2e-desktop`, `test-e2e-all`, `setup-e2e-vms`
- **Build:** `build-runtime`, `build-cli`, `build-cli-release`, `build-desktop`, `build-native-macos`, `build-os-cli`, `build-mcp`, `build-angular`, `build-tauri`
- **Check:** `check-clippy`, `check-desktop-clippy`, `check-fmt`, `check-mcp`, `check-mcp-lint`, `check-angular`, `check-angular-lint`
- **Coverage:** `coverage-rust`, `coverage-mcp`, `coverage-angular`
- **Audit:** `audit-rust`, `audit-mcp`, `audit-desktop`
- **Download:** `download-lima`, `download-nodejs`, `download-wsl-resources` (+ `clean-*` variants)
- **Other:** `lint`, `install-deps`, `install-hooks`, `clean`

Key build targets related to the CLI:

- `make build-cli` — builds the **debug** CLI binary (`target/debug/speedwave`); used by `make dev`
- `make build-cli-release` — builds the **release** CLI binary (`target/release/speedwave`); the bundled CLI must be release so the debug-only `SPEEDWAVE_ALLOW_UNSIGNED` plugin-signature bypass is compiled out of shipped artifacts (see ADR-051)
- `make build-tauri` — builds the Tauri desktop app; depends on `build-cli-release` and copies the **release** CLI binary into `desktop/src-tauri/cli/` for bundling
- `make build` — full build including CLI, MCP servers, Angular frontend

The `desktop/src-tauri/cli/` directory is in `.gitignore` — it is populated at build time only.

## Running in Dev Mode

`make dev` automatically builds the CLI first and copies it to `desktop/src-tauri/cli/` before starting Tauri dev mode. This ensures the "Open Terminal" feature works during development.

## Windows dev setup

`make dev` works on Windows-native through Git Bash, but the toolchain has several quirks that need addressing. Once configured, the same `make` targets work as on macOS.

### Required tools (one-time)

Install via Chocolatey (run in elevated PowerShell):

```powershell
choco install -y git make rustup.install nodejs-lts cmake llvm `
                  visualstudio2022buildtools visualstudio2022-workload-vctools `
                  bats-core
```

`make` from Chocolatey is GNU Make 4.4 — required because **GnuWin32 make 3.81** (sometimes pre-installed elsewhere) mishandles `$(VAR)` expansion in recipes and `\` line continuations.

### `.cargo/config.local.toml`

Create this file (gitignored) to pin the MSVC linker by absolute path. Without it, cargo on Git Bash finds `/usr/bin/link` (Cygwin's hardlink tool) before MSVC's `link.exe` and the build fails with `LNK1146` / `LNK1170` / `LNK1206`-class errors. Cargo automatically merges `config.local.toml` next to `config.toml`. Replace `<your-version>` with the MSVC version installed by VS Build Tools (find under `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\`):

```toml
# .cargo/config.local.toml — per-machine, NOT checked in
[target.x86_64-pc-windows-msvc]
linker = "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\MSVC\\<your-version>\\bin\\HostX64\\x64\\link.exe"
```

### `~/.bashrc` MSVC env

The MSVC env (`INCLUDE`, `LIB`, `LIBPATH`, Windows SDK paths) must be sourced before cargo. Generate the snapshot once from `vcvars64.bat` and source it from `.bashrc`. Run in PowerShell once:

```powershell
cmd /c '"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" && set' > C:\Users\<you>\msvc-env-raw.txt
```

Then convert to bash-sourceable form (one line per `export KEY='VALUE'`) and save as `~/msvc-env.sh`. Source it from `~/.bashrc`:

```bash
[ -f ~/msvc-env.sh ] && . ~/msvc-env.sh
export PATH="${_VCVARS_PATH:-}:/c/ProgramData/chocolatey/bin:/c/Users/<you>/.cargo/bin:/c/Program Files/nodejs:/c/Program Files/LLVM/bin:/c/Program Files/CMake/bin:/c/Program Files/Git/cmd:/usr/bin:/bin"
```

PATH order matters: MSVC bin must precede `/usr/bin` so cargo's child processes find MSVC `cl.exe` first. The `.cargo/config.local.toml` linker pin makes this less critical for `link.exe` specifically, but other MSVC tools (`cl.exe`, `dumpbin.exe`) still rely on PATH.

### Sherpa-onnx CRT alignment

`make dev` automatically pre-fetches the sherpa-onnx MD-Release prebuilt for Windows (see [ADR-061](../adr/ADR-061-windows-crt-runtime-alignment.md)) and pins `SHERPA_ONNX_LIB_DIR` to a persistent cache under `target/sherpa-onnx-md/`. No manual step needed beyond `make download-sherpa-onnx` (called as a prerequisite of `make dev`).

### Run

Always from **interactive Git Bash** (VSCode terminal or standalone Git Bash window) — not over SSH and not from `cmd.exe` / PowerShell:

```bash
cd ~/Projects/speedwave
make setup-dev
make dev
```

`make setup-dev` over SSH (non-interactive) is known to skip `node_modules/.bin/` symlink creation, breaking `npx ng serve` later. Use an interactive shell.

## Cross-platform Rust gating

`speedwave-desktop` compiles for macOS and Windows. `make check-desktop-clippy` only exercises the host target — Windows-specific compile errors are caught later by the `desktop-windows-check` job in `.github/workflows/test.yml` and the `desktop-build` workflow on push. To stay green:

- **Imports of types used in cross-platform function signatures must be unconditional.** A `#[cfg(any(unix, test))] use std::process::Command;` paired with a public `fn apply_child_env(cmd: &mut Command, …)` will compile on macOS / in tests and silently break the Windows build. If a type appears in any non-gated `fn`/`impl`/`struct`/`type` declaration, import it without a `cfg`.
- **Symmetric platform branches.** When a function has a `#[cfg(unix)]` arm, ensure the `#[cfg(windows)]` arm exists too — or fail the build with `compile_error!` on unsupported targets, rather than letting the call site fall through to a missing symbol.
- **Local Windows pre-flight.** If you are touching gated code (`grep -nRE 'cfg\((unix|windows|target_os)' desktop/src-tauri/src/`), run `cargo check -p speedwave-desktop --target x86_64-pc-windows-msvc` (requires `rustup target add x86_64-pc-windows-msvc` and a Windows-capable linker) before opening the PR. Otherwise rely on the `desktop-windows-check` CI job.

See [`docs/architecture/platform-matrix.md`](../architecture/platform-matrix.md) for the platform-specific runtime/feature breakdown.

## See Also

- [Contributing](../../CONTRIBUTING.md)
