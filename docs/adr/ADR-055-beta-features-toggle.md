# ADR-055: Beta Features Toggle in the Tray Menu

**Status:** Accepted

**Date:** 2026-05-12

## Context

Work-in-progress UI surfaces (new views, experimental panels) need a way to ship behind a switch that a developer or early user can flip at runtime, without rebuilding the app and without exposing the surface to every user. The Desktop app already has a system tray icon with a context menu (`Open / Check for Updates / Quit`) built in `desktop/src-tauri/src/tray.rs`. Putting the switch there keeps it out of the way for ordinary users while remaining a single click away.

The tray menu's variable parts already include an `Install Update vX` item driven by a `Arc<Mutex<Option<String>>>` threaded through two closures (`check_update` handler, `update_available` listener). Adding a second variable input (the beta flag) the same way would mean two parallel ad-hoc states and a real risk that rebuilding the menu for one input drops the other.

## Decision

### State

A single `TrayMenuState` struct, managed via `app.manage(...)`, holds both variable inputs:

```rust
pub(crate) struct TrayMenuState {
    pub update_version: Mutex<Option<String>>,
    pub beta_enabled: Mutex<bool>,
}
```

`refresh_tray_menu(app)` reads both fields plus `setup_wizard::is_setup_complete()` and rebuilds the whole menu. Any callsite that has an `AppHandle` mutates the relevant field then calls `refresh_tray_menu(app)` — there is one rebuild path, so no input can be silently dropped. The `update_version` `Arc` previously threaded through `main.rs` is removed.

### Menu composition

The visible menu shape is produced by a pure function `tray_menu_spec(update_version, beta_enabled, setup_complete) -> Vec<TrayItemSpec>`, so composition is unit-testable without an `AppHandle`. `build_tray_menu` maps the spec onto Tauri builders.[^1] The beta entry is a `CheckMenuItem`[^2] with id `toggle_beta`, checked when the flag is on.

### Persistence

The flag lives in top-level user-config: `SpeedwaveUserConfig.ui.beta_enabled: Option<bool>` (new `UiPrefsConfig` struct), defaulting to `false`. It is **user-only** — a checked-in repo `.speedwave.json` cannot set it, consistent with how privacy- and behaviour-sensitive flags are handled elsewhere. Reads/writes go through the existing `config::with_config_lock` + `tokio::task::spawn_blocking` pattern (same as `set_log_level`), so the UI thread never does synchronous config I/O.

### Write path

`ui_prefs_cmd::apply_beta_toggle_inner(app, enabled)` is the single internal write path: it persists the flag under the config lock, updates `TrayMenuState.beta_enabled`, calls `refresh_tray_menu(app)`, and emits a `beta-changed` Tauri event. Both the `set_beta_enabled` Tauri command and the tray menu's `toggle_beta` arm call this function — the tray arm does **not** call the command handler. The tray arm spawns the call on the async runtime because the `on_menu_event` closure is synchronous.

### Frontend

`BetaService` (`providedIn: 'root'`) holds an Angular `signal<boolean>`, seeded from `get_beta_enabled` on construction and updated by the `beta-changed` event. UI surfaces gate hidden sections with `@if (beta.enabled()) { ... }`. The `ShellComponent` renders a discreet `BETA` badge in the corner whenever the flag is on. When running outside Tauri (Karma unit tests), `invoke` throws and the signal stays `false`.

### Hidden before setup completion

The `toggle_beta` item is **not added** to the tray menu while `is_setup_complete()` is `false`. The toggle writes to user-config, and `save_user_config` creates `~/.speedwave/` if it is missing — showing the switch on a fresh install (or after factory reset) before the setup wizard owns that directory would let a tray click race the wizard. `create_project` (the last wizard step) calls `refresh_tray_menu(app)` after it succeeds, so the item appears once setup is genuinely complete. We chose "hide" over "disable" because a developer-only switch has no reason to be visible on an unconfigured app.

## Consequences

- **Positive:** simple mechanism — no telemetry, no per-project state, no plugin-facing API. `TrayMenuState` centralises the tray menu's variable inputs, replacing the previously scattered `Arc<Mutex>` for the update version. The beta state survives restarts (read from user-config on startup).
- **Negative — global, not per-project:** the flag is user-wide. Beta surfaces are developer/early-adopter features, not project-scoped configuration, so this is deliberate.
- **Negative — not a security boundary:** this toggle is purely a UI surface gate. Nothing that requires a real permission check (host capability, credential access, network policy) may be hidden behind it; those must keep their own enforcement regardless of the flag.
- **Negative — invisible on fresh install:** the tray item does not appear until the setup wizard finishes. A user mid-setup cannot enable beta features; that is the trade-off for not letting a tray click recreate the data dir out from under the wizard.

[^1]: Tauri v2 menu builder API (`MenuBuilder`, `MenuItemBuilder`): https://docs.rs/tauri/latest/tauri/menu/struct.MenuBuilder.html

[^2]: Tauri v2 `CheckMenuItem` — a menu item with a checkmark that toggles: https://docs.rs/tauri/latest/tauri/menu/struct.CheckMenuItem.html
