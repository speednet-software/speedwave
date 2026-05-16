# ADR-047: Plugin Install Progress Events

**Status:** Accepted
**Date:** 2026-05-04

> **Update (ADR-051):** the deferred-build marker referred to below as
> `~/.speedwave/plugins/<slug>/.image_pending` now lives at
> `~/.speedwave/plugin-state/<slug>/image_pending` — a sibling of
> `plugins/`, outside the signed plugin tree, so writing it never changes
> a plugin's content digest. The lifecycle (host-side create/remove,
> retry on next launch) is unchanged.

## Context

Issue [#400](https://github.com/speednet-software/speedwave/issues/400) reports that plugin installation in the Desktop UI shows no visible feedback during the multi-minute work it performs. The previous implementation registered `install_plugin` as a synchronous Tauri command and ran the entire flow — Ed25519 signature verification, ZIP extraction, manifest validation, container image build via `nerdctl build`, and on-disk side-effects — in one blocking call. On macOS, where Tauri runs on the main thread, the user sees the system spinning beachball for 2-5 minutes when installing a heavy plugin with multi-GB build dependencies (e.g. ML libraries) and only learns about a build error after the freeze ends.

The Desktop already had a small overlay rendered via `installing = true`, but it only displayed a static spinner and "Installing plugin…" string. Nothing communicated which step was running, and there was no way to surface a build failure separately from a fatal install failure.

## Decision

`install_plugin` is converted to an `async` Tauri command that delegates the synchronous work to `tokio::task::spawn_blocking`, and the Rust function emits structured progress events through a caller-supplied callback. The Tauri command forwards each event to the frontend as a `plugin_install_status` Tauri event[^1], cloning `AppHandle` into the blocking closure (`AppHandle: Send + Sync + Clone`[^2]). The frontend renders the events through a shared `<app-progress-steps>` component extracted from the first-run setup wizard.

This MVP **does not** stream the contents of `nerdctl build` line-by-line. The "building" phase is reported as a single event when the build starts; the Desktop overlay shows the step active with a static "Building image (may take 2-5 min)" detail until the build completes (success → `done`, failure → `failed` followed by `done_with_pending_build`). Live build-log streaming is left for a follow-up PR; see "Out of scope" below.

### Event shape

```rust
// crates/speedwave-runtime/src/plugin.rs
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "snake_case")]
pub struct PluginInstallProgress {
    pub phase: String,
    pub message: String,
    pub error: Option<String>,
}

pub const ALL_PLUGIN_INSTALL_PHASES: &[&str] = &[
    "verifying", "extracting", "building",
    "done", "failed", "done_with_pending_build",
];
```

The `phase` field is a free-form string rather than a typed enum. This mirrors the precedent set by `BundleReconcileStatus { phase: String }` in `desktop/src-tauri/src/reconcile.rs`. The frontend declares an aligned union type in `desktop/src/src/app/models/plugin.ts::PluginInstallPhase`. Adding/removing/renaming a phase requires editing both files; a Rust unit test (`test_all_plugin_install_phases_lists_expected_strings`) and a TS test in `plugins.component.spec.ts` each pin the expected list to keep the two in sync. We considered codegen and rejected it: six rarely-changing strings do not justify a build-time generator that parses Rust source via regex.

### Phase semantics

| Phase                     | When emitted                                                                                | Terminal?                      |
| ------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------ |
| `verifying`               | Before signature check                                                                      | No                             |
| `extracting`              | After signature OK, before copying into `~/.speedwave/plugins/<slug>/`                      | No                             |
| `building`                | After extract, before `runtime.build_image()` (only for plugins with `service_id`)          | No                             |
| `done`                    | All phases completed without errors                                                         | Yes                            |
| `failed`                  | A step errored. Includes a sanitized `error` string                                         | Yes (when extract/verify fail) |
| `done_with_pending_build` | After `failed` from the building phase. The plugin is on disk and will retry on next launch | Yes                            |

A resource-only plugin (no `service_id`, no `Containerfile`) emits `verifying → extracting → done` and skips `building`. The frontend learns about this **before** invoking `install_plugin` by calling a new lightweight Tauri command `peek_plugin_manifest(zip_path)` that reads `plugin.json` from the ZIP without verifying the signature, extracting to a permanent location, or running any side-effect. The frontend then renders 2 or 3 steps as appropriate. This avoids retroactive UI mutation (e.g. removing a "building" step after the fact) and keeps the manifest as the single source of truth.

### `InstallOutcome` enum

`install_plugin` now returns `Result<InstallOutcome, anyhow::Error>` instead of `Result<PluginManifest, _>`:

```rust
pub enum InstallOutcome {
    Installed(PluginManifest),
    InstalledPendingBuild(PluginManifest),
}
```

Callers must distinguish between "fully installed" and "installed but image build failed". The Desktop Tauri command auto-enables credentials-free plugins only when `Installed(_)` is returned; for `InstalledPendingBuild(_)` the toast text changes to inform the user that the build will retry on next launch. The CLI maps both variants to **exit code 0** (non-breaking change): scripts using `speedwave plugin install foo.zip && echo OK` continue to work after the upgrade. Users discover deferred builds by reading stderr or by inspecting `~/.speedwave/plugins/<slug>/.image_pending`. We considered exit code 2 for `InstalledPendingBuild` and rejected it as a script-breaking change unsuitable for a `feat` minor release — see [Future work](#future-work) for the follow-up.

### Sanitization

The `error` field is always passed through `speedwave_runtime::log_sanitizer::sanitize` before being included in a `PluginInstallProgress`. `sanitize` already covers Bearer tokens, `Authorization` headers, URL userinfo, and `api_key|secret|token=…` assignments. A regression test (`test_install_plugin_emits_failed_with_sanitized_error`) installs a plugin against a mock `ContainerRuntime` whose `build_image` errors with `RUN curl https://user:tok@registry.example.com/foo failed`, then asserts that the emitted `error` contains `***REDACTED***` and does **not** contain `tok`.

`build_args` passed to `runtime.build_image` from `build_single_plugin_image` is hard-coded to `&[]`. Plugin manifests have no field that injects build-args. This is a structural property, not a runtime check — the sanitizer is a defense-in-depth net for the cases where stderr leaks credentials embedded in `RUN` commands inside a Containerfile.

### Cleanup-on-cancel

`spawn_blocking` is not cancellable from the host side. If the user closes the Plugins view or quits the app mid-install, behaviour is platform-specific:

- **macOS Lima:** on app quit, `LimaRuntime::stop_vm()` runs `limactl stop --force <vm>` (where `<vm>` is derived from `SPEEDWAVE_DATA_DIR` per [ADR-031](ADR-031-data-dir-env-var-for-instance-isolation.md)[^4]) which poweroffs the VM, killing any in-VM `nerdctl build` immediately. The `.image_pending` marker on the host survives. On the next launch, `ensure_all_plugin_images` retries the build silently.
- **Windows WSL2:** `wsl.exe -- nerdctl build` is a child of the desktop process; when the desktop exits, the host pipe breaks, but the in-WSL `nerdctl` may continue. The host-written `.image_pending` marker survives across the desktop exit; on the next launch, `ensure_all_plugin_images` retries the build silently.

Explicit `kill_on_drop` of the in-flight child via a stored `Child` handle is left for follow-up; see "Out of scope".

## Critical files

- `crates/speedwave-runtime/src/plugin.rs` — `PluginInstallProgress`, `InstallOutcome`, `ALL_PLUGIN_INSTALL_PHASES`, `peek_plugin_manifest`, `install_plugin` signature change.
- `desktop/src-tauri/src/plugin_cmd.rs` — async `install_plugin` Tauri command, async `peek_plugin_manifest` Tauri command.
- `desktop/src-tauri/src/main.rs` — registers `peek_plugin_manifest` in `invoke_handler`.
- `crates/speedwave-cli/src/main.rs` — matches on `InstallOutcome`, exit 0 in both variants.
- `desktop/src/src/app/shared/progress-steps/progress-steps.component.ts` — new shared component extracted from setup-wizard.
- `desktop/src/src/app/setup/setup-wizard.component.ts` — refactored to delegate the step list to `<app-progress-steps>`.
- `desktop/src/src/app/plugins/plugins.component.ts` — overlay rebuilt on `<app-progress-steps>`, `peek_plugin_manifest`-then-listen-then-invoke flow, phase event mapping.
- `desktop/src/src/app/models/plugin.ts` — `PluginInstallProgress`, `PluginInstallPhase`, `PLUGIN_INSTALL_PHASES`, `PluginManifestSummary`.

## Out of scope (future work)

- **Live build-log streaming.** A future PR may add `CommandRunner::run_streaming` (or an equivalent) and stream `nerdctl build` stdout/stderr line-by-line through the same `plugin_install_status` channel. That work needs to address: WSL2 UTF-16LE decoding from `wsl.exe -- nerdctl`, line buffering at chunk boundaries, sanitization per-line vs per-blob, and whether to merge stderr into stdout at the process level.
- **Cancellable installs.** Storing the spawned child and providing a `cancel_install` Tauri command that signals it to terminate, with a documented per-platform cleanup path.
- **CLI exit code semantics.** Distinguishing `InstalledPendingBuild` from `Installed` at the exit-code level is useful for scripts that need to detect deferred builds. A follow-up issue should propose exit 2 (or similar) under a `BREAKING CHANGE:` trailer; see [Future work](#future-work).

## Footnotes

[^1]: Tauri v2 events from Rust to the webview: `AppHandle::emit("event-name", payload)`. Source: <https://docs.rs/tauri/2.1.1/tauri/struct.AppHandle.html#method.emit>.

[^2]: `AppHandle` thread-safety: `Clone + Send + Sync` for any `R: Runtime`. Source: <https://docs.rs/tauri/2.1.1/tauri/struct.AppHandle.html> ("impl<R: Runtime> Clone for AppHandle<R>", "impl<R> Send for AppHandle<R>", "impl<R> Sync for AppHandle<R>"). Verified 2026-05-04.

[^3]: `prctl(PR_SET_PDEATHSIG)` is Linux-only. Source: <https://man7.org/linux/man-pages/man2/prctl.2.html> (since Linux 2.1.57). macOS does not provide an equivalent; child processes are reparented to `launchd` after parent exit.

[^4]: ADR-031 — `SPEEDWAVE_DATA_DIR` env var derives a unique `lima_vm_name()` so `make dev` (`~/.speedwave-dev`) and production (`~/.speedwave`) can coexist on one host. Implementation: `crates/speedwave-runtime/src/consts.rs::derive_instance_name_from`.

[^5]: ADR-026 — On Linux rootless setups, the container runs as UID 0 in a user namespace mapped to the host desktop UID. Files written by the host (such as `.image_pending`) are owned by the desktop user and remain writable across container restarts. The `.image_pending` marker is created and removed on the host side (in `install_plugin` and `build_single_plugin_image` respectively), never inside the container, so user-namespace mapping is not load-bearing for the marker's lifecycle.
