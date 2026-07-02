# ADR-058: Beta Features Toggle in the Tray Menu

> **Status:** Accepted
> **Context:** Work-in-progress Desktop UI surfaces need a runtime switch a developer or early adopter can flip without a rebuild, while staying hidden from ordinary users.

## Decision

Add a single global "Beta features" check item to the Desktop system-tray menu. Both of the tray menu's variable inputs — the optional "Install Update" version and the beta flag — live in one `TrayMenuState` struct managed by Tauri, and any callsite that changes either mutates the field and then calls one rebuild function. The flag is persisted in user-config only and gates hidden Angular sections behind a signal.

## Why

- One rebuild path (`refresh_tray_menu`) reading all variable inputs from `TrayMenuState` means a menu rebuild for one input can never silently drop the other — the prior pattern threaded a separate `Arc<Mutex<Option<String>>>` for the update version through two closures.
- A tray check item keeps the switch out of the way for normal users but one click away for developers/early adopters.
- Menu shape is produced by a pure spec function so composition is unit-testable without an `AppHandle`.
- The flag is a UI surface gate only, not a security boundary: anything needing a real permission check (host capability, credential access, network policy) keeps its own enforcement regardless of the flag.
- It is global (user-wide), not per-project, because beta surfaces are developer/early-adopter features rather than project-scoped configuration.

## Where it lives in code

- **Tray state + menu** — `desktop/src-tauri/src/tray.rs`: `TrayMenuState` (`update_version`, `beta_enabled`), the pure `tray_menu_spec(update_version, beta_enabled, setup_complete)`, `build_tray_menu` (maps the spec onto Tauri's menu builders, emitting a check item with id `toggle_beta`), and the single `refresh_tray_menu(app)` rebuild path.
- **Write path** — `desktop/src-tauri/src/ui_prefs_cmd.rs`: `apply_beta_toggle_inner(app, enabled)` is the shared internal write path. It persists the flag under the config lock, updates `TrayMenuState`, calls `refresh_tray_menu`, and emits a `beta-changed` event. Both the `set_beta_enabled` Tauri command and the tray's `toggle_beta` arm call this function; the read path is `get_beta_enabled`. It no-ops when the value is unchanged.
- **Persistence** — `crates/speedwave-runtime/src/config.rs`: `UiPrefsConfig.beta_enabled: Option<bool>` under `SpeedwaveUserConfig.ui`, read via the `beta_enabled()` getter (defaults to `false`). User-only — a checked-in repo `.speedwave.json` cannot set it. Reads/writes go through `config::with_config_lock` on a blocking task so the UI thread never does synchronous config I/O.
- **Frontend** — `desktop/src/src/app/services/beta.service.ts`: `BetaService` (`providedIn: 'root'`) holds an Angular signal seeded from `get_beta_enabled` and updated by the `beta-changed` event. Outside Tauri (Karma unit tests) `invoke` throws and the signal stays `false`. `desktop/src/src/app/shell/shell.component.ts` renders a discreet BETA badge when the flag is on; `desktop/src/src/app/guards/beta-enabled.guard.ts` gates beta-only routes.

## Hidden before setup completion

The `toggle_beta` item is not added while `setup_wizard::is_setup_complete()` (`desktop/src-tauri/src/setup_wizard.rs`) is `false`. Showing the switch on a fresh install — where a tray click could write user-config and create `~/.speedwave/` — would race the setup wizard for ownership of that directory.

`create_project` is step 4 of the wizard and does **not** refresh the tray. `start_containers` is the final step (step 5): it flips `is_setup_complete()` by persisting `containers_started`, and its Tauri wrapper in `desktop/src-tauri/src/containers_cmd.rs` calls `refresh_tray_menu(app)` right after the wizard's `start_containers` succeeds, so the item appears once setup is genuinely complete. Two structural tests in `containers_cmd.rs` pin this: `start_containers_refreshes_tray_after_setup_completes` asserts `start_containers` calls `refresh_tray_menu`, and `create_project_does_not_refresh_tray_prematurely` asserts `create_project` does not (a premature refresh would rebuild the menu while `is_setup_complete()` is still `false` and drop the toggle).

We chose "hide" over "disable" because a developer-only switch has no reason to be visible on an unconfigured app. The trade-off: a user mid-setup cannot enable beta features until the wizard finishes.

## Rejected alternatives

- **Disable instead of hide before setup** — rejected; a developer-only switch has no reason to be visible on an unconfigured app, and hiding avoids any tray click racing the wizard for the data dir.
- **Per-project flag** — rejected; beta surfaces are developer/early-adopter features, not project configuration, so a single user-wide flag is intentional.
