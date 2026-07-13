# ADR-047: Plugin Install Progress Events

> **Status:** Accepted
> **Context:** Desktop plugin install ran the whole flow in one blocking call with no per-step feedback during multi-minute image builds.

## Decision

`install_plugin` is an `async` Tauri command that runs the synchronous work on `tokio::task::spawn_blocking` and emits structured progress events through a caller-supplied callback. The Tauri command forwards each event to the webview as a `plugin_install_status` event. The frontend renders them through a shared `<app-progress-steps>` component (extracted from the first-run setup wizard). It does not stream `nerdctl build` output line-by-line — the build phase is a single event, and the overlay shows the build step active with the static detail `nerdctl build (may take 2-5 min)` until it finishes.

## Why

- On macOS Tauri runs the command on the main thread[^1], so a synchronous multi-GB build froze the UI (beachball) for minutes; offloading to `spawn_blocking`[^2] keeps the UI responsive.
- A typed sequence of phases lets the overlay show which step is running and surface a build failure distinctly from a fatal install failure.
- A failed image build should not lose the on-disk plugin — it is marked pending and retried on the next launch instead of forcing a reinstall.

## Phases and outcome

- Phase strings (the `plugin_install_status` IPC contract): `verifying`, `extracting`, `building`, `done`, `failed`, `done_with_pending_build`. Resource-only plugins (no `service_id`, no `Containerfile`) skip `building`.
- A failed build emits `done_with_pending_build`; the plugin stays on disk with an `image_pending` marker (now under `plugin-state/<slug>/` per ADR-051, outside the signed tree) and the build retries on next launch via `ensure_plugin_images`.
- `install_plugin` returns `InstallOutcome::Installed` or `InstallOutcome::InstalledPendingBuild`. Desktop auto-enables credential-free plugins only on `Installed`; the toast differs for the pending case. The CLI maps both variants to exit code 0 (a deferred build is not a script failure).
- To know up front whether to render 2 or 3 steps, the frontend first calls `peek_plugin_manifest(zip_path)`, which extracts the ZIP into a scratch temp dir (cleaned up by a drop guard) and reads `plugin.json` without verifying the signature and without writing into the plugins directory. This avoids retroactively mutating the step list.
- The `error` field of every progress event is passed through `log_sanitizer::sanitize` (redacts Bearer tokens, `Authorization` headers, URL userinfo, `api_key|secret|token=` assignments) before emission; a regression test asserts a leaked credential in a `RUN` line is redacted.

## Phase-string sync

The Rust SSOT `ALL_PLUGIN_INSTALL_PHASES` is mirrored by `PLUGIN_INSTALL_PHASES` / `PluginInstallPhase` in TypeScript. Adding, removing, or renaming a phase means editing both; the Rust test `test_all_plugin_install_phases_lists_expected_strings` pins the expected list, and the TS `PluginInstallPhase` union is derived from `PLUGIN_INSTALL_PHASES` (a string typo in the const would fail to type-check at every phase comparison in `plugins.component.ts`). `phase` is a free-form `String`, mirroring the `BundleReconcileStatus { phase }` precedent — six rarely-changing strings did not justify codegen.

## Cleanup on cancel

`spawn_blocking` is not cancellable from the host. If the user quits mid-install, the host-written `image_pending` marker survives and the build retries on next launch. On macOS, app quit runs `limactl stop --force` (VM name derived from `SPEEDWAVE_DATA_DIR` per ADR-031), killing the in-VM build immediately. On Windows the in-WSL `nerdctl` may keep running after the host pipe breaks, but the marker still drives a retry. Explicit kill-on-drop of the in-flight child is left for follow-up.

## Where it lives in code

- Progress event, outcome, phase SSOT, peek, install signature — `crates/speedwave-runtime/src/plugin.rs` (`PluginInstallProgress`, `InstallOutcome`, `ALL_PLUGIN_INSTALL_PHASES`, `peek_plugin_manifest`, `install_plugin`, `ensure_plugin_images`).
- Sanitizer — `crates/speedwave-runtime/src/log_sanitizer.rs` (`sanitize`).
- Tauri commands — `desktop/src-tauri/src/plugin_cmd.rs` (async `install_plugin`, `peek_plugin_manifest`); registered in `desktop/src-tauri/src/main.rs`.
- CLI outcome handling — `crates/speedwave-cli/src/main.rs` (`InstallOutcome` match, exit 0 both variants).
- Shared step UI — `desktop/src/src/app/shared/progress-steps/progress-steps.component.ts`; install overlay in `desktop/src/src/app/plugins/plugins.component.ts`; frontend models in `desktop/src/src/app/models/plugin.ts`.

## Rejected alternatives

- **Codegen for the phase enum** — a build-time generator parsing Rust source to derive the TS union, rejected as overkill for six rarely-changing strings; two pinned tests keep them aligned instead.
- **Exit code 2 for `InstalledPendingBuild`** — rejected as a script-breaking change unsuitable for a `feat` minor release; both outcomes stay exit 0.

## Out of scope (future work)

- Live `nerdctl build` log streaming through the same `plugin_install_status` channel (needs WSL2 UTF-16LE decoding, chunk-boundary line buffering, and per-line vs per-blob sanitization).
- Cancellable installs via a stored child handle and a `cancel_install` command.

[^1]: Tauri v2 docs, "Calling Rust from the Frontend": "Commands without the async keyword are executed on the main thread unless defined with #[tauri::command(async)]." https://v2.tauri.app/develop/calling-rust/

[^2]: Tokio docs, `tokio::task::spawn_blocking`: "This function runs the provided closure on a thread dedicated to blocking operations." https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html
