# ADR-024: Desktop E2E Testing Strategy

> **Status:** Accepted
> **Context:** The Tauri v2 + Angular desktop app had no end-to-end tests exercising the real built binary against a real OS (Lima on macOS, WSL2 on Windows) — unit tests cover layers in isolation but never the full first-launch → setup wizard → runtime install → containers → chat flow.

## Decision

Drive the real, installed desktop binary on a real machine via SSH orchestration, using WebdriverIO[^1] over the W3C WebDriver protocol[^2]. Both supported platforms (macOS and Windows) embed the same community crate `tauri-plugin-webdriver`[^3], which runs a W3C WebDriver server on `127.0.0.1:4445`[^4] inside the app — no external driver process. The crate is compiled only when the `e2e` Cargo feature is set, so production releases never include it.

## Why

- A faithful test needs Lima/WSL2, which cannot be reproduced in a plain container (no systemd for nerdctl rootless, no nested VMs), so we run against real machines reachable over SSH.
- An embedded in-app WebDriver server works identically on macOS (WKWebView) and Windows (WebView2) with zero external dependencies — Apple's WKWebView does not expose a WebDriver interface, so the official external `tauri-driver` could not be used on macOS, and one mechanism for both platforms is simpler than two[^5].
- Gating the WebDriver server behind the `e2e` feature flag (`#[cfg(feature = "e2e")]`) means the crate is not compiled or linked into production builds — zero added attack surface. The gate is platform-agnostic; both platforms get it only with `--features e2e`.
- WebDriver commands operate in the webview context only — they cannot reach Tauri backend state, tokens, or the host filesystem, since JavaScript in the webview can only invoke Rust commands explicitly declared in a capability grant[^6].
- Per-machine OS-level isolation (own kernel, filesystem, network) plus a clean-state reset before each run means a compromised test cannot affect the orchestrating host or another target machine.

## Where it lives in code

- WebDriver plugin registration (feature-gated, both platforms) — `desktop/src-tauri/src/main.rs` (`#[cfg(feature = "e2e")]` block registering `tauri_plugin_webdriver::init()`)
- `e2e` Cargo feature (optional `tauri-plugin-webdriver` dependency, no platform conditioning) — `desktop/src-tauri/Cargo.toml` (`[features] e2e = ["dep:tauri-plugin-webdriver"]`)
- SSH orchestration per platform (clean state, copy repo, build release artifact, install, launch, run WebdriverIO) — `scripts/e2e-vm.sh` (`windows_clean_state` / `macos_clean_state` reset machine state; both platforms build the release artifact with the `e2e` feature enabled — Windows runs `cargo tauri build --features e2e` directly, macOS goes through `make test-e2e-desktop-build`)
- Shared SSH/host helpers — `scripts/e2e-common.sh`
- Test runner specs and config — `desktop/e2e/`
- `make test-e2e-all` (both platforms in parallel via SSH) and `make test-e2e-desktop` (build + local run; the `_e2e-run` recipe is **macOS-only** — Windows local E2E must go through `scripts/e2e-vm.sh windows`) — `Makefile`
- Target machines configured via `SPEEDWAVE_WINDOWS_HOST` and `SPEEDWAVE_MACOS_HOST`; only two host platforms are supported (Linux was dropped — see [ADR-059](ADR-059-drop-linux-support.md))

## Selectors

- `data-testid` attributes on interactive Angular elements, convention `data-testid="<component>-<element>"` (e.g. `setup-start-btn`, `chat-send`, `nav-settings`).

## Rejected alternatives

- **Custom debug WebSocket bridge** — a hand-rolled WebSocket server with JS-eval round-trips. Rejected as too complex: needed global mutable state, conditional command stubs, and a bespoke TypeScript driver instead of a standard, well-audited protocol.
- **Container with an external WebDriver + headless display** — gives filesystem isolation but cannot run nested VMs (Lima, WSL2) or nerdctl rootless mode, so setup wizard, runtime install, and container lifecycle stay untestable — the very paths E2E exists to cover.

## Notes

- First run per machine takes longer due to a full Rust compile of the Tauri app from source; later runs reuse the persisted Cargo build cache.
- E2E is intentionally NOT part of `make test` — it needs SSH-accessible target machines and a full Tauri build.

## References

[^1]: WebdriverIO - https://webdriver.io/

[^2]: W3C WebDriver specification - https://www.w3.org/TR/webdriver2/

[^3]: tauri-plugin-webdriver crate - https://lib.rs/crates/tauri-plugin-webdriver

[^4]: tauri-plugin-webdriver README, default WebDriver server address - https://github.com/Choochmeque/tauri-plugin-webdriver

[^5]: Tauri v2 WebDriver Testing guide, "macOS has no WKWebView driver tool available" - https://v2.tauri.app/develop/tests/webdriver/

[^6]: Tauri v2 Inter-Process Communication guide, capability-gated command dispatch - https://v2.tauri.app/concept/inter-process-communication/
