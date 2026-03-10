# ADR-024: Desktop E2E Testing via Parallels VMs

## Status

Accepted

## Context

Speedwave's desktop application (Tauri v2 + Angular) lacked end-to-end tests exercising the real built binary. Existing tests cover individual layers:

- **Rust unit tests** (327 in runtime + CLI) verify backend logic
- **Angular unit tests** (214, vitest + MockTauriService) verify UI component behavior in isolation
- **CLI E2E** (bats) verify command-line argument parsing

None of these validate the full stack: Angular frontend communicating with the Rust backend through Tauri IPC in a real window on the real OS.

A critical gap is that Speedwave relies on platform-specific infrastructure — Lima VMs on macOS, rootless nerdctl with systemd --user on Linux, WSL2 on Windows — that cannot be faithfully reproduced in a container. Testing the complete user experience (first launch → setup wizard → runtime install → containers → chat) requires a real OS environment on each platform.

### Approaches considered

1. **tauri-driver + WebdriverIO (native)** — Tauri's official WebDriver approach[^1]. Requires Linux (webkit2gtk-driver) or Windows (msedgedriver). Does not work on macOS because Apple's WKWebView does not expose a WebDriver interface[^2].

2. **Custom debug WebSocket bridge** — A hand-rolled WebSocket server in the Tauri backend with JS eval round-trips and oneshot channels. Rejected as too complex: required global mutable state, `std::mem::forget`, conditional Tauri command stubs, and a custom TypeScript driver.

3. **tauri-plugin-webdriver + WebdriverIO on host** — A community crate that embeds a W3C WebDriver server directly inside the Tauri application[^3]. Works on macOS (WKWebView), Linux (WebKitGTK), and Windows (WebView2) with zero external dependencies. Tests use standard WebdriverIO[^4] syntax. Rejected as primary approach: while it works cross-platform, it does not provide full isolation — tests share host state (`~/.speedwave/`) and require refactoring 42 call sites for environment variable override to prevent host contamination. Used as the macOS WebDriver mechanism inside VMs (see Decision).

4. **Docker container with tauri-driver** — Builds the Tauri application inside a clean Ubuntu container with `webkit2gtk-driver` and `xvfb`[^7], then runs `tauri-driver`[^1] + WebdriverIO[^4] tests against the built binary. Rejected: while it provides filesystem isolation, it cannot test the full Speedwave flow — Docker containers lack systemd, which is required for nerdctl rootless mode[^8], and cannot run nested VMs (Lima, WSL2). This means setup wizard, runtime installation, and container lifecycle are untestable.

5. **Parallels Desktop VMs (chosen)** — 3 VMs (Ubuntu, Windows, macOS) managed by Parallels Desktop Pro[^9] with clean snapshots. Each VM runs a real OS with full systemd, kernel, and virtualization support. Tests exercise the complete user experience from first launch through container orchestration. See Decision for details.

## Decision

We use **Parallels Desktop VMs**[^9] with per-platform WebDriver mechanisms and **WebdriverIO**[^4] for desktop E2E testing:

### VM Configuration

- **3 VMs**: Ubuntu (latest LTS), Windows 11, macOS (matching host major version)
- **"tests-ready" snapshots**: Each VM has a saved snapshot containing a clean OS installation plus development toolchain (Rust, Node.js, system dependencies for Tauri[^1]) but no Speedwave state — no `~/.speedwave/`, no built binaries, no tokens
- **Before each test run**: `prlctl snapshot-switch`[^10] restores the VM to its clean snapshot state, guaranteeing zero state leakage between runs
- **Repo access**: The host repository is shared via Parallels Shared Folders[^11], then copied to the VM's local disk before build to avoid filesystem performance overhead from the shared mount

### Per-Platform WebDriver

| Platform       | WebDriver mechanism                      | Display                     | Notes                                                                                                                  |
| -------------- | ---------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Linux (Ubuntu) | `tauri-driver`[^1] (official)            | `xvfb-run`[^7] for headless | `webkit2gtk-driver` required                                                                                           |
| Windows        | `tauri-driver`[^1] (official)            | Native desktop              | Uses `msedgedriver` for WebView2                                                                                       |
| macOS          | `tauri-plugin-webdriver`[^3] (community) | Native desktop              | `tauri-driver` does not work on WKWebView[^2]; plugin compiled only in debug builds via `#[cfg(debug_assertions)]`[^5] |

All platforms use **WebdriverIO**[^4] as the test runner, connecting via the W3C WebDriver protocol[^6].

### Orchestration

- **`scripts/e2e-vm.sh`**: Orchestrates the full cycle per VM — snapshot restore via `prlctl snapshot-switch`[^10], copy repo to local disk via `prlctl exec`[^10], build the Tauri app, start the WebDriver, run WebdriverIO tests, collect results
- **`make test-e2e-all`**: Runs `scripts/e2e-vm.sh` for all 3 VMs in parallel (requires Parallels Desktop Pro/Business[^9] on macOS host)
- **`make test-e2e-desktop`**: Runs E2E tests on the current machine only (no VM orchestration) — useful for local development on any platform

### Selectors

- `data-testid` attributes on all interactive Angular elements
- Convention: `data-testid="<component>-<element>"` (e.g., `setup-start-btn`, `chat-send`, `nav-settings`)

### Security

- **Full OS-level isolation**: Each VM has its own kernel, filesystem, and network stack — a compromised test cannot affect the host or other VMs
- **Snapshot-based state reset**: `prlctl snapshot-switch`[^10] restores VMs to a known-clean state before every test run, ensuring no state leakage (tokens, configuration, container images) between runs
- **`tauri-plugin-webdriver` compiled only in debug builds**: The `#[cfg(debug_assertions)]`[^5] gate ensures the embedded WebDriver server is never included in release binaries. Only macOS VMs use this plugin; Linux and Windows use the external `tauri-driver` process which is never shipped
- **No token access**: WebDriver commands operate in the webview context only — they cannot access Tauri backend state, tokens, or host filesystem
- **Standard protocol**: Uses the well-audited W3C WebDriver specification[^6] rather than a custom wire protocol

## Consequences

- **Requires Parallels Desktop Pro/Business**[^9] on the macOS host machine for cross-platform testing. Parallels Pro is needed for `prlctl` CLI access and headless VM operation
- **First run per VM takes ~15–20 minutes** due to full Rust compilation of the Tauri app from source. Subsequent runs take ~5 minutes with incremental compilation (Cargo build cache persists within the VM between snapshot restores if snapshots are taken post-toolchain-install)
- **Full user experience tested**: fresh OS → build → setup wizard → runtime install (Lima/nerdctl/WSL2) → container lifecycle → chat UI — the complete Speedwave flow that no other testing approach can cover
- **3 platforms tested in parallel**: `make test-e2e-all` runs Ubuntu, Windows, and macOS VMs concurrently, limited only by host hardware resources
- **`make test-e2e-desktop`** runs on the current machine without VMs — available on any platform for local development iteration
- Tests are NOT part of the default `make test` target due to requiring Parallels and a full Tauri build
- All Angular component templates include `data-testid` attributes on interactive elements

## References

[^1]: Tauri v2 — WebDriver Testing guide. https://v2.tauri.app/develop/tests/webdriver/

[^2]: WebKit Bug 237767 — WKWebView does not support WebDriver for embedded webviews. https://bugs.webkit.org/show_bug.cgi?id=237767

[^3]: tauri-plugin-webdriver — W3C WebDriver implementation for Tauri applications. https://lib.rs/crates/tauri-plugin-webdriver

[^4]: WebdriverIO — Next-gen WebDriver test framework for Node.js. https://webdriver.io/

[^5]: Rust conditional compilation — cfg(debug_assertions). https://doc.rust-lang.org/reference/conditional-compilation.html#debug_assertions

[^6]: W3C WebDriver specification. https://www.w3.org/TR/webdriver2/

[^7]: Xvfb — X virtual framebuffer for headless display. https://www.x.org/releases/current/doc/man/man1/Xvfb.1.xhtml

[^8]: nerdctl rootless mode — requires systemd or similar init system. https://github.com/containerd/nerdctl/blob/main/docs/rootless.md

[^9]: Parallels Desktop for Mac — Pro and Business editions. https://www.parallels.com/products/desktop/pro/

[^10]: Parallels prlctl command-line reference — snapshot and exec operations. https://download.parallels.com/desktop/v19/docs/en_US/Parallels%20Desktop%20Pro%20Edition%20Command-Line%20Reference.pdf

[^11]: Parallels Shared Folders — sharing files between Mac and VM. https://www.parallels.com/blogs/share-files-folders-mac-vm/
