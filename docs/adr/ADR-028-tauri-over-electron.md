# ADR-028: Tauri v2 over Electron for Desktop Shell

> **Status:** Accepted
> **Context:** Speedwave Desktop needs a cross-platform shell hosting the Angular Chat UI, Setup Wizard, IDE Bridge, and tray; Electron vs. Tauri.

## Decision

Use Tauri v2 as the Desktop shell framework. Do not use Electron. Tauri's backend is Rust, so the Desktop app imports the existing `speedwave-runtime` crate directly; rendering is delegated to each OS's native WebView (WKWebView on macOS, WebView2/Edge-Chromium on Windows) rather than a bundled browser engine.

## Why

- **Native Rust backend, zero FFI.** `crates/speedwave-runtime/` is consumed as a direct Cargo dependency — no `napi-rs` bindings or sidecar process, no second language boundary. Electron would force one of those because its backend is JavaScript-only.
- **No bundled browser engine.** Tauri uses the OS WebView; Electron bundles a full Chromium build plus Node.js per app. Speedwave already bundles Lima (macOS), nerdctl-full + WSL2 rootfs (Windows), and Node.js; adding Chromium would bloat every download and undermine the single-download promise (ADR-000).
- **Lower memory footprint.** The system WebView shares resources with the OS, versus Electron's dedicated per-window Chromium renderer.
- **Deny-by-default security.** Tauri v2's capabilities system declares exactly which IPC commands the WebView may call, per window and per plugin — aligning with Speedwave's security-first model. Speedwave's `desktop/src-tauri/capabilities/default.json` enumerates a minimal allow-list of permissions. Electron secures the renderer differently: with `contextIsolation` on and `nodeIntegration` off (the defaults since Electron 12), the developer must still hand-build the exposed IPC surface via `contextBridge`, and any mistake there re-exposes Node primitives to the page.
- **Mandatory update signing.** The Tauri updater plugin verifies cryptographic signatures and cannot disable that check; Speedwave consumes a `latest.json` release manifest (ADR-012). Electron's `autoUpdater` does not enforce signature verification at the framework level.
- **Independent audit.** Tauri v2 underwent an independent penetration test by Radically Open Security (NLnet-funded); its findings were resolved before the v2 release, including the IPC origin-check bypass tracked as CVE-2024-35222 (remote-origin iframes reaching IPC endpoints), patched in Tauri.

## What does not change

- Angular frontend code, served via WebView instead of a Chromium BrowserWindow.
- `speedwave-runtime` stays framework-agnostic (no Tauri imports in the runtime).
- `containers/compose.template.yml`, container architecture, and the security model are independent of the desktop framework.
- MCP servers (TypeScript) run in containers, unaffected by the host-side framework choice.

## Where it lives in code

- Tauri config + bundle targets (`nsis`, `msi`, `app`, `dmg`) — `desktop/src-tauri/tauri.conf.json`
- macOS-specific bundle (Lima resources) — `desktop/src-tauri/tauri.macos.conf.json`
- Rust backend / Tauri commands — `desktop/src-tauri/src/`
- Runtime crate imported by the backend — `crates/speedwave-runtime/`

## Consequences

- **Positive.** Smaller installer (no bundled Chromium — the `.dmg` and `.exe`/`.msi` are well under an equivalent Electron build); lower memory use; direct Rust integration; deny-by-default frontend capabilities; framework-enforced update signing.
- **Negative — WebView inconsistency.** WKWebView (macOS) and WebView2 (Windows) have different CSS/JS engine behavior; APIs available in Chromium may be missing in WKWebView. Testing must cover both supported platforms.
- **Negative — smaller ecosystem.** Electron has more plugins and community resources; Tauri's is growing but smaller.
- **Negative — Rust learning curve.** Desktop-backend contributors must know Rust — but the entire backend (`speedwave-runtime`, `speedwave-cli`) is already Rust, so this is not an incremental cost.

> Linux was a supported host platform when this ADR was written; it was dropped later (ADR-059, 2026-05-15). The WebKitGTK Linux WebView dependency and the `.deb` bundle target no longer apply — only macOS and Windows ship.

## Rejected alternatives

- **Electron.** Bundled Chromium, per-renderer memory overhead, JavaScript-only backend requiring N-API bindings to reach `speedwave-runtime`, and an IPC surface the developer must lock down by hand. Right choice for pixel-perfect cross-platform rendering or deep Node.js integration — Speedwave needs neither.
- **Neutralinojs.** System WebView but a C++ backend (needs FFI to call Rust); smaller community; no built-in mandatory-signing updater; no independent security audit.
- **Flutter (desktop).** Dart backend (same FFI problem as Electron); ships its own Skia rendering engine; the Angular frontend would have to be rewritten as Flutter widgets.
- **Native toolkit (SwiftUI + WinUI).** Separate native codebases per platform — triples maintenance, cannot share the Angular frontend, violates DRY, and `speedwave-runtime` would still need per-platform FFI.
