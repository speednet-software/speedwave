# ADR-058: Beta Features Toggle in the Tray Menu

> **Status:** Accepted
> **Context:** Work-in-progress Desktop UI surfaces need a runtime switch a developer or early adopter can flip without a rebuild, while staying hidden from ordinary users.
>
> **Amendment (2026-11-04):** Meeting transcription left beta (ADR-056, Amendment 25, SPEED-957). It was the only route behind `beta-enabled.guard.ts`, so the guard was removed; no route is beta-gated today, and the remaining beta surfaces are hidden by `BetaService` alone. The "Frontend" entry below describes the guard as it was.
>
> **Amendment (2026-11-27, SPEED-719):** The single "Beta features" switch is replaced by a registry of feature flags. The word "beta" meant two things in the code, the update channel (SPEED-674) and this switch, and one switch hid unrelated features: users without it had no chat tabs, no system notifications and no PII protection, although those features are stable, and the "Beta" badge showed after a switch to the stable channel because it reflected the switch, not the channel. What changed:
>
> - `speedwave_runtime::feature_flags::Feature` (`crates/speedwave-runtime/src/feature_flags.rs`) lists the flags: `office` and `telemetry_settings`. Each is stored under `ui.features` in the user config (user-only, as before), and an absent entry means off. `SpeedwaveUserConfig::feature_enabled` reads one. Removing a feature from behind its flag is removing one enum variant; the compiler names every use.
> - A stored `ui.beta_enabled: true` migrates on read to both flags on; `false` or no key leaves both off, and an existing `ui.features` entry wins over the old key. The old key disappears at the next config save.
> - `get_feature_flags` returns the whole map, `set_feature_flag` changes one flag (an unknown name fails with `unknown feature flag: <name>`) and the `feature-flags-changed` event carries the whole map (`desktop/src-tauri/src/ui_prefs_cmd.rs`). `get_beta_enabled`, `beta-changed` and the tray item `toggle_beta` are gone, so the tray menu has Open, Check for updates, an optional Install update and Quit.
> - `FeatureFlagsService` (`desktop/src/src/app/services/feature-flags.service.ts`) replaces `BetaService`; the UI asks `enabled('office')` or `enabled('telemetry_settings')`. Settings has an "Experimental features" section with one switch per flag; a switch takes effect at once.
> - Behind a flag: the Office row in Integrations (`office`) and the Telemetry section in Settings (`telemetry_settings`). A configured Office integration keeps working with the flag off, and MDM-forced telemetry does not read the flag. Not behind any flag any more: chat tabs and their shortcuts, system notifications, the Security section and PII tokenization (with its start-up policy check). The "Beta" badge is removed.
> - The update channel does not read the flags, and the flags do not change the channel.
>
> The flags stay a UI visibility gate, never a security boundary. The sections below describe the tray switch as it was; the "Hidden before setup completion" reasoning no longer applies because no tray item remains.

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
