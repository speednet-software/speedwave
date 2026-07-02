# ADR-030: Bundle Reconcile After App Update

> **Status:** Accepted — superseded in part by [ADR-072](ADR-072-per-image-build-input-hash-tags.md): images are now tagged per-image (`speedwave-*:<build-input-hash>`), `bundle_id` remains only the reconcile trigger, and `build_context_hash` was replaced by the per-image `image_hashes` map. The phase machine, atomicity, and resume semantics described here are unchanged.
> **Context:** After a desktop app upgrade the bundled resources, built-in images, and previously-running projects must be brought back into a known-good state deterministically.

## Decision

Speedwave ties the installed desktop bundle to the local runtime via two files: a generated `bundle-manifest.json` (shipped with the app) and a persisted `bundle-state.json` (in `~/.speedwave`). On every desktop startup the backend compares the manifest's `bundle_id` against the applied id in `bundle-state.json`; if they differ it runs a phased reconcile that syncs resources, rebuilds built-in images tagged by `bundle_id`, and restarts the projects that need to be running. Built-in images are tagged `speedwave-*:<bundle_id>` rather than the mutable `:latest`, so the CLI and Desktop agree on which images belong to the installed app.

## Why

- A mutable `:latest` tag never proves the local images match the installed app bundle — `bundle_id` is a concrete compatibility contract derived from `app_version`, `build_context_hash`, and `claude_resources_hash` (plus the pinned Claude Code version mixed in).
- Reconcile phases (`Pending` → `ResourcesSynced` → `ImagesBuilt` → `ProjectsRestored` → `Done`) are persisted, so an interrupted update resumes from where it stopped on the next launch instead of redoing finished work.
- The previous bundle's images are pruned only after every phase succeeds, so a failure mid-reconcile leaves the last-known-good image set on disk to fall back to.
- Manual upgrades and UI-triggered upgrades funnel through the same backend reconcile, so behaviour does not diverge between the two.

## How it behaves

- The UI-triggered upgrade is a single backend call: verify the expected version, record the currently-running projects into `pending_running_projects`, stop their containers, install the app update, then restart immediately. If install fails before the restart, the backend restores the stopped projects and clears the pending state.
- At reconcile time the set of projects to restart is the **union** of (a) the projects recorded in `pending_running_projects` before the update and (b) any projects found currently running when reconcile queries the runtime — the lists are merged, sorted, and de-duplicated. It is not limited to the recorded list.
- When `bundle_id` is unchanged but the expected built-in images are missing (e.g. after a containerd reinstall or VM recreation), reconcile forces a rebuild anyway.

## Where it lives in code

- Bundle manifest/state types, id derivation, and atomic resource sync — `crates/speedwave-runtime/src/bundle.rs` (`BundleManifest`, `BundleState`, `BundleReconcilePhase`, `sync_claude_resources`)
- Image tagging by `bundle_id` and bundle-scoped build/prune — `crates/speedwave-runtime/src/build.rs` (`image_ref`, `build_images_for_bundle`, `should_prune_bundle`)
- Startup reconcile state machine and project-restore union logic — `desktop/src-tauri/src/reconcile.rs` (`reconcile_bundle_update`, `list_running_projects`, `restore_projects`)
- The single-flow upgrade command and failure-restore path — `desktop/src-tauri/src/update_commands.rs` (`install_update_and_reconcile`)
- Compose rendering consumes the current bundle manifest so images match the installed app — `crates/speedwave-runtime/src/compose.rs`
- Container-level update/rollback (separate from bundle reconcile) — `crates/speedwave-runtime/src/update.rs`

## Rejected alternatives

- Keep `speedwave-*:latest` and rebuild opportunistically — a shared mutable tag cannot prove compatibility with the installed bundle, especially after a partial or interrupted update.
- Sync `claude-resources` from the app bundle on every container start — compose mounts a stable host path; the update boundary belongs at reconcile time, not on each individual container start.
- Keep a two-step frontend flow (`install_update` then `restart_app`) — the backend must own the whole sequence (record running projects, stop containers, install, restart) so an interruption leaves recoverable state instead of an orphaned half-update.
