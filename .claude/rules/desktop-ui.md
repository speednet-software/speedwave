---
paths:
  - 'desktop/src/**'
  - 'desktop/src-tauri/src/main.rs'
  - 'desktop/src-tauri/src/chat.rs'
  - 'desktop/src-tauri/src/tray.rs'
  - 'desktop/src-tauri/src/transcription_cmd.rs'
  - 'desktop/src-tauri/tauri.conf.json'
---

# Desktop UI Rules (Angular + Tauri)

- **Zoneless + OnPush: service state read by a template MUST be a signal.** A template reading a plain service property renders stale — nothing schedules change detection. New service fields consumed by templates are signals (or computed) from day one.
- **Rust ↔ TS model mirrors are silent-failure surfaces:** Tauri command return types and their `models/*.ts` counterparts must match exactly — the JSON deserializer silently drops unknown/mismatched fields. Update both sides in the same commit; for a new mirrored constant/union add an `include_str!` cross-read test on the Rust side (grep `_matches_ts` for the pattern).
- **State-tree rendering:** a new `MessageBlock` variant lands in Rust first, then `models/state-tree.ts::MessageBlockState`, then a renderer arm in `chat-state.service.ts::stateBlocksToMessageBlocks` — its default arm surfaces unknown kinds as error blocks in front of the user, which is the only drift catch.
- **Model catalog:** Anthropic model strings come from `AnthropicModelsService` (backed by `list_anthropic_models`) — never hard-code a model id in Angular.
- **Beta gate:** work-in-progress Desktop surfaces ship behind the beta toggle — `BetaService` signal + the beta-enabled route guard. The flag (`ui.beta_enabled`) is user-config-only (repo `.speedwave.json` cannot set it) and is a UI visibility gate, never a security boundary. A surface that must stay usable with beta off (a running recording keeps its Stop control) needs the exception on the route guard and the keyboard shortcut too, not only on nav-rail visibility — `transcriptionRouteGuard` is the pattern.
- **Tray menu:** any new variable input to the tray menu goes into `TrayMenuState` and rebuilds through the single `refresh_tray_menu` path — a second rebuild path silently drops the other inputs.
- **Tray Icon Rules:**
  - **State Authority:** Icon is not a `TrayMenuState` input. `tray::refresh_tray_icon` queues a repaint and `apply_recording_state` re-derives icon and tooltip from live state (`transcription_cmd::DriversHandle` via `is_recording`) so both stay correct when the window is closed onto the tray. Callers only signal registry changes.
  - **Four Constraints:**
    1. Apply icon via `set_icon_with_as_template(.., true)`. Standard `set_icon` hard-resets the macOS template flag to false, breaking menu-bar adaptation (guarded by `the_repaint_reasserts_the_macos_template_flag`).
    2. Execute sampling and both applies in one `run_on_main_thread` task to prevent concurrent repaints from landing out of order. The badge pulse follows the same rule: it re-reads its generation and the registry inside its main-thread closure (guarded by `the_pulse_loop_exits_on_a_stale_generation_and_a_stopped_recording`).
    3. Route every registry mutation through `register_driver_and_repaint_tray` or `unregister_driver_and_repaint_tray` (guarded by `every_registry_mutation_repaints_the_tray`).
    4. macOS recording variant is a template image (badge renders in menu-bar tint); Windows renders a static red badge.
  - **Motion vs. Color:** macOS uses a pulsing badge (`BADGE_PULSES`, 35%-opacity second frame swapped on timer) because template rendering discards color. Windows keeps its colored badge static. Motion is used only where color is unavailable. Exactly one pulse loop may paint: every repaint bumps `BADGE_PULSE_GENERATION`, which retires the previous loop (guarded by `every_repaint_retires_the_previous_pulse_loop`).
  - **Theming:** Never derive tray appearance from `Window::theme()`. `NativeThemeAdapter.syncWindowTheme` pins it to in-app Appearance mode; Windows reads app theme rather than notification area theme.
  - **Reference:** Rationale and rejected animated indicator in ADR-056 Amendment 18.
- **CSP:** the webview CSP in `tauri.conf.json` is load-bearing on Windows (WebView2 enforces strictly; WKWebView is lenient) — e.g. `img-src 'self' blob: data:` is what makes pasted images render; changes are pinned by a test in `main.rs`.
- **TypeScript in `desktop/src` is capped by Angular's peer range** (`@angular/compiler-cli` declares it, e.g. `>=6.0 <6.1` for v22): a TypeScript bump beyond that range cannot install, so Dependabot majors for `typescript` here are rejected until an Angular major lifts the cap (`ignore` rule in `dependabot.yml`). Angular packages peer-pin each other to the exact version — bump the whole set in one PR via `ng update`, never one package.
- **`ng serve` gives a `PORT` env var priority over `angular.json` (Angular 22+)** while Tauri's `devUrl` stays fixed at the same port — `make dev` therefore launches Tauri under `env -u PORT` (guard: `_tests/desktop/dev-server-port.bats`, which also pins `angular.json` serve port ↔ `tauri.conf.json` `devUrl`).
- **`~/.claude/settings.json` in the container must stay a writable copy, not a symlink into a read-only mount** — Claude Code writes to it (`/effort`, `/model`).
