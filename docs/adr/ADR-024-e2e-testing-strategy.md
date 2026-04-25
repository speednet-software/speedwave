# ADR-024: Desktop E2E Testing Strategy

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

5. **Parallels Desktop VMs (originally chosen, later evolved)** — 3 VMs (Ubuntu, Windows, macOS) managed by Parallels Desktop Pro[^9] with clean snapshots. Each VM runs a real OS with full systemd, kernel, and virtualization support. Tests exercise the complete user experience from first launch through container orchestration. This approach was the initial decision but evolved to use SSH-based orchestration to real machines (see Decision).

## Decision

We use **SSH-based orchestration to real machines** with per-platform WebDriver mechanisms and **WebdriverIO**[^4] for desktop E2E testing.

> **Evolution note:** This ADR originally described Parallels Desktop VMs with `prlctl snapshot-switch` for state management. The implementation evolved to use SSH connections to real machines (physical or VM) reachable via the network, as this proved more flexible across all three platforms and did not require Parallels Desktop on the orchestrating host.

### Machine Configuration

- **3 target machines**: Ubuntu (latest LTS), Windows 11, macOS — connected via SSH (configured via `SPEEDWAVE_LINUX_HOST`, `SPEEDWAVE_WINDOWS_HOST`, `SPEEDWAVE_MACOS_HOST` environment variables)
- **Clean state before each run**: Platform-specific clean-state functions (`linux_clean_state`, `windows_clean_state`, `macos_clean_state`) uninstall any previous Speedwave installation and remove user data (`~/.speedwave/`, built binaries, tokens), guaranteeing zero state leakage between runs
- **Repo access**: The repository is copied to the remote machine via `rsync` (Linux/macOS) or `scp` (Windows) before building

### Per-Platform WebDriver

| Platform       | WebDriver mechanism                      | Display                     | Notes                                                                                                                                                                 |
| -------------- | ---------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux (Ubuntu) | `tauri-driver`[^1] (official)            | `xvfb-run`[^7] for headless | `webkit2gtk-driver` required                                                                                                                                          |
| Windows        | `tauri-driver`[^1] (official)            | Native desktop              | Uses `msedgedriver` for WebView2                                                                                                                                      |
| macOS          | `tauri-plugin-webdriver`[^3] (community) | Native desktop              | `tauri-driver` does not work on WKWebView[^2]; plugin compiled only when `--features e2e` is passed; production releases omit the feature, so zero attack surface[^5] |

All platforms use **WebdriverIO**[^4] as the test runner, connecting via the W3C WebDriver protocol[^6].

### Orchestration

- **`scripts/e2e-vm.sh`**: Orchestrates the full cycle per platform via SSH — clean previous state, copy repo to remote machine, build the full release artifact (.deb / NSIS / .dmg), install, launch app, run WebdriverIO tests, collect results
- **`make test-e2e-all`**: Runs `scripts/e2e-vm.sh` for all 3 platforms in parallel (requires SSH access to each target machine)
- **`make test-e2e-desktop`**: Runs E2E tests on the current machine only (no SSH orchestration) — useful for local development on any platform

### Selectors

- `data-testid` attributes on all interactive Angular elements
- Convention: `data-testid="<component>-<element>"` (e.g., `setup-start-btn`, `chat-send`, `nav-settings`)

### Security

- **Full OS-level isolation**: Each target machine has its own kernel, filesystem, and network stack — a compromised test cannot affect the orchestrating host or other target machines
- **Clean-state reset**: Platform-specific clean-state functions remove all Speedwave state (binaries, `~/.speedwave/`, tokens, container images) before every test run, ensuring no state leakage between runs
- **`tauri-plugin-webdriver` gated behind a Cargo feature flag**: The `#[cfg(feature = "e2e")]`[^5] gate ensures the embedded WebDriver server is never included in production releases — only builds with `--features e2e` include it. Only macOS targets use this plugin; Linux and Windows use the external `tauri-driver` process which is never shipped
- **No token access**: WebDriver commands operate in the webview context only — they cannot access Tauri backend state, tokens, or host filesystem
- **Standard protocol**: Uses the well-audited W3C WebDriver specification[^6] rather than a custom wire protocol

## Consequences

- **Requires SSH access** to target machines (Linux, Windows, macOS) for cross-platform testing. Machines can be physical, cloud VMs, or local VMs reachable via the network — no dependency on a specific hypervisor
- **First run per machine takes ~15–20 minutes** due to full Rust compilation of the Tauri app from source. Subsequent runs take ~5 minutes with incremental compilation (Cargo build cache persists on the target machine between runs)
- **Full user experience tested**: clean state → build → install artifact → setup wizard → runtime install (Lima/nerdctl/WSL2) → container lifecycle → chat UI — the complete Speedwave flow that no other testing approach can cover
- **3 platforms tested in parallel**: `make test-e2e-all` runs tests on Ubuntu, Windows, and macOS machines concurrently via SSH
- **`make test-e2e-desktop`** runs on the current machine without SSH orchestration — available on any platform for local development iteration
- Tests are NOT part of the default `make test` target due to requiring SSH-accessible target machines and a full Tauri build
- All Angular component templates include `data-testid` attributes on interactive elements

## References

[^1]: Tauri v2 — WebDriver Testing guide. https://v2.tauri.app/develop/tests/webdriver/

[^2]: WebKit Bug 237767 — WKWebView does not support WebDriver for embedded webviews. https://bugs.webkit.org/show_bug.cgi?id=237767

[^3]: tauri-plugin-webdriver — W3C WebDriver implementation for Tauri applications. https://lib.rs/crates/tauri-plugin-webdriver

[^4]: WebdriverIO — Next-gen WebDriver test framework for Node.js. https://webdriver.io/

[^5]: Cargo features — conditional compilation via feature flags. https://doc.rust-lang.org/cargo/reference/features.html

[^6]: W3C WebDriver specification. https://www.w3.org/TR/webdriver2/

[^7]: Xvfb — X virtual framebuffer for headless display. https://www.x.org/releases/current/doc/man/man1/Xvfb.1.xhtml

[^8]: nerdctl rootless mode — requires systemd or similar init system. https://github.com/containerd/nerdctl/blob/main/docs/rootless.md

[^9]: Parallels Desktop for Mac — Pro and Business editions. https://www.parallels.com/products/desktop/pro/
