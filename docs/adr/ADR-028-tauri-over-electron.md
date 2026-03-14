# ADR-028: Tauri v2 over Electron for Desktop Shell

> **Status:** Accepted

---

## Context

Speedwave Desktop needs a cross-platform shell that hosts the Angular Chat UI, the Setup Wizard, the IDE Bridge, and a system tray. The two dominant frameworks for building desktop apps with web frontends are **Electron** and **Tauri**.

Electron pioneered the category. It bundles a full Chromium browser engine and a Node.js runtime into every application, giving developers a consistent, self-contained environment across Windows, macOS, and Linux.[^1] The trade-off is size (~150 MB for Chromium alone), memory consumption (each BrowserWindow spawns a dedicated renderer process[^2]), and a JavaScript-only backend.

Tauri v2 takes the opposite approach. It delegates rendering to the operating system's native WebView — WKWebView on macOS, WebKitGTK on Linux, WebView2 (Edge/Chromium) on Windows — via the WRY abstraction layer.[^3] The backend is Rust, communicating with the frontend through an asynchronous IPC layer (commands + events).[^4] A minimal Tauri app can be under 600 KB.[^5]

Speedwave already has a Rust codebase (`speedwave-runtime`) that implements all container orchestration logic. The Desktop app needs to call this library directly.

## Decision

Use **Tauri v2** as the Desktop shell framework. Do not use Electron.

### Rationale

#### 1. Native Rust backend — zero FFI overhead

Speedwave's core logic lives in `crates/speedwave-runtime/` (Rust). Tauri's backend is Rust — the Desktop app imports `speedwave-runtime` as a direct Cargo dependency with zero FFI, zero serialization overhead, and full type safety at compile time.

With Electron, the runtime crate would need to be exposed via `napi-rs` (Rust → Node.js N-API bindings) or a sidecar process. Both approaches add build complexity, runtime overhead, and a second language boundary to maintain.

#### 2. Bundle size — no bundled browser engine

Tauri uses the OS-native WebView, so it does not ship a browser engine.[^3] A minimal Tauri app is under 600 KB.[^5] Electron bundles Chromium (~150 MB uncompressed) plus Node.js in every application.[^1]

Speedwave already bundles Lima (~50 MB), nerdctl-full (~200 MB on Linux), and Node.js (for mcp-os). Adding Chromium would push the total installer past 500 MB — undermining the "download one file" promise (ADR-000).

#### 3. Memory footprint — shared WebView vs. dedicated Chromium

Electron spawns a main process (Node.js) plus a renderer process (Chromium) per window.[^2] Each renderer carries the full V8 JavaScript engine and Blink rendering engine in memory.

Tauri delegates rendering to the system WebView, which shares resources with the OS and other WebView-using applications. For a single-window app like Speedwave, this means significantly lower baseline memory consumption.

#### 4. Security model — granular capabilities

Tauri v2 enforces a trust boundary between the Rust backend (full system access) and the WebView frontend (restricted).[^6] The capabilities system controls exactly which IPC commands the frontend may call, with configurable scopes per window and per plugin.[^7] This aligns with Speedwave's security-first architecture (CLAUDE.md § Security).

Electron's security model relies on `contextIsolation`, `nodeIntegration: false`, and `contextBridge` — effective when configured correctly, but permissive by default. Tauri's model is deny-by-default.

#### 5. Built-in updater with mandatory signing

The Tauri updater plugin supports auto-update via a static JSON endpoint (compatible with GitHub Releases) with **mandatory cryptographic signature verification** — it cannot be disabled.[^8] Speedwave already uses this for all three platforms (ADR-012). Electron's `autoUpdater` also supports code-signed updates, but signature verification is not enforced by the framework.

#### 6. Independent security audit

Tauri v2 underwent an independent security audit by Radically Open Security (funded by NLNet). All findings were resolved and retested. One CVE was discovered and patched (CVE-2024-35222).[^9][^10]

### What Does Not Change

- Angular frontend code — Tauri serves it via a WebView, same as Electron would serve it via BrowserWindow
- `speedwave-runtime` crate — framework-agnostic by design (no Tauri imports in the runtime)
- `compose.template.yml`, container architecture, security model — all independent of the desktop framework
- MCP servers (TypeScript) — running in containers, unaffected by the host-side framework choice

## Consequences

### Positive

- **Smaller installer.** No bundled Chromium — final `.dmg` / `.exe` / `.deb` are ~150 MB smaller than an equivalent Electron build.
- **Lower memory usage.** System WebView shares resources with the OS instead of running a dedicated Chromium process.
- **Direct Rust integration.** `speedwave-runtime` is imported as a Cargo dependency — no N-API bindings, no sidecar, no IPC serialization boundary.
- **Deny-by-default security.** Frontend capabilities are explicitly declared — no accidental exposure of Node.js APIs.
- **Mandatory update signing.** Tampered updates are rejected by the framework, not by application code.

### Negative

- **WebView inconsistency across platforms.** WebKit (macOS), WebKitGTK (Linux), and WebView2 (Windows) have different CSS/JS engine behavior. Web APIs available in Chromium may not exist in WebKit. Testing must cover all three platforms.[^3]
- **Smaller ecosystem.** Electron has a larger ecosystem of plugins, example apps, and community resources.[^11] Tauri's ecosystem is growing but smaller.
- **WebKitGTK as Linux dependency.** On Linux, `libwebkit2gtk-4.1` is a system dependency (not bundled). Most desktop Linux distributions ship it, but minimal server installs may not have it.[^3] This is documented in the .deb package requirements.
- **Rust learning curve.** Contributors to the Desktop backend must know Rust. However, Speedwave's entire backend (`speedwave-runtime`, `speedwave-cli`) is already Rust, so this is not an incremental cost.

## Rejected Alternatives

### 1. Electron

Rejected for the reasons detailed above: bundled Chromium adds ~150 MB, memory overhead from dedicated renderer processes, JavaScript-only backend requires N-API bindings to call `speedwave-runtime`, and a more permissive default security model.

Electron remains the right choice for apps that need pixel-perfect cross-platform rendering consistency or deep Node.js ecosystem integration. Speedwave needs neither — its frontend is a single-window Chat UI, and its backend is Rust.

### 2. Neutralinojs

A lightweight alternative that uses the system WebView (like Tauri) but with a C++ backend.[^12] Rejected because:

- C++ backend would require FFI to call `speedwave-runtime` (Rust)
- Smaller community and fewer production deployments than Tauri
- No built-in updater with mandatory signing
- No independent security audit

### 3. Flutter (desktop)

Dart-based UI toolkit with its own rendering engine (Skia).[^13] Rejected because:

- Dart backend — same FFI problem as Electron (would need `dart:ffi` to call Rust)
- Ships its own rendering engine (~20-30 MB), not as heavy as Chromium but still redundant
- Web integration (Angular frontend) would require rewriting the UI in Dart/Flutter widgets
- Desktop support (Windows, macOS, Linux) is stable but less mature than Tauri for "web-frontend-in-native-shell" use cases

### 4. Native toolkit (SwiftUI + WinUI + GTK)

Three separate native codebases — one per platform. Rejected because:

- Triples development and maintenance effort
- Cannot share the Angular frontend across platforms
- Violates DRY — the same Chat UI, Setup Wizard, and tray logic would exist in three languages
- `speedwave-runtime` Rust crate would still need per-platform FFI (Swift, C#, C)

---

[^1]: [Electron documentation — "By embedding Chromium and Node.js into its binary"](https://www.electronjs.org/docs/latest/)

[^2]: [Electron process model — main process, renderer processes, preload scripts](https://www.electronjs.org/docs/latest/tutorial/process-model)

[^3]: [WRY — cross-platform WebView rendering library (WebKit, WebKitGTK, WebView2)](https://github.com/tauri-apps/wry)

[^4]: [Tauri IPC — asynchronous commands and events between Rust and WebView](https://tauri.app/concept/inter-process-communication/)

[^5]: [Tauri — "a minimal Tauri app can be less than 600KB in size"](https://tauri.app/start/)

[^6]: [Tauri security — trust boundaries between Rust Core and WebView](https://tauri.app/security/)

[^7]: [Tauri capabilities — fine-grained permissions and scopes per window](https://tauri.app/security/capabilities/)

[^8]: [Tauri updater plugin — auto-update with mandatory cryptographic signing](https://tauri.app/plugin/updater/)

[^9]: [Tauri v2 RC announcement — security audit by Radically Open Security](https://tauri.app/blog/tauri-2-0-0-release-candidate/)

[^10]: [CVE-2024-35222 — Tauri security advisory (fixed)](https://github.com/tauri-apps/tauri/security/advisories/GHSA-57fm-592m-34r7)

[^11]: [Electron GitHub repository — MIT license](https://github.com/electron/electron)

[^12]: [Neutralinojs — lightweight cross-platform desktop framework](https://neutralino.js.org/)

[^13]: [Flutter desktop support](https://docs.flutter.dev/platform-integration/desktop)
