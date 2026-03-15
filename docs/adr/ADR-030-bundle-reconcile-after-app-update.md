# ADR-030: Bundle Reconcile After App Update

> **Status:** Accepted
> **Context:** Keep desktop updates, bundled resources, built-in images, and restored projects consistent after an app upgrade

---

## Context

Before this change, the desktop app update and the runtime container update were only loosely coupled. The desktop bundle could change while local compose files still referenced shared `speedwave-*:latest` image tags, and `~/.speedwave/claude-resources` could remain older than the installed app bundle.[^1][^2]

That created two gaps:

1. Installing a desktop update did not, by itself, prove that the user's local built-in images matched the new app bundle.[^1][^3]
2. Bundled `claude-resources` were mounted from a stable host path, but there was no bundle-level contract for when that directory had to be refreshed after an app upgrade.[^2]

Speedwave needs one deterministic rule for "the installed app bundle and the local runtime are in sync."

## Decision

Speedwave uses a generated `bundle-manifest.json` plus a persisted `bundle-state.json` to reconcile the local runtime after every app upgrade.[^2][^4]

### 1. Bundle identity is explicit

Desktop builds generate `build-context/bundle-manifest.json` with:

- `app_version`
- `bundle_id`
- `build_context_hash`
- `claude_resources_hash`[^2]

`bundle_id` becomes the compatibility contract for built-in images and synced resources.[^2][^4]

### 2. Built-in images are versioned by `bundle_id`

Built-in images are rendered and built as `speedwave-*:<bundle_id>`, not `speedwave-*:latest`.[^3][^5]

`speedwave update` and compose rendering both use the current bundle manifest, so the CLI and desktop agree on which built-in images are valid for the installed app bundle.[^3][^5]

### 3. Startup reconcile is the source of truth

On desktop startup, the backend compares the current bundle manifest with `~/.speedwave/bundle-state.json`.[^2][^4]

If the applied bundle differs from the installed bundle, the backend runs reconcile phases in order:

1. `pending`
2. `resources_synced`
3. `images_built`
4. `projects_restored`
5. `done`[^2][^4]

The reconcile performs:

1. Atomic sync of bundled `claude-resources` into `~/.speedwave/claude-resources`
2. Rebuild of built-in images for the current `bundle_id`
3. Recreate of only the projects that were running before the update, if any were recorded[^2][^4]

### 4. Desktop update becomes a single backend flow

The desktop UI no longer installs the update and then asks the frontend to issue a separate restart command. Instead it calls `install_update_and_reconcile(expectedVersion)`.[^4]

That backend flow:

1. Verifies the expected update version
2. Saves `pending_running_projects`
3. Stops running project containers
4. Installs the app update
5. Restarts the app immediately[^4][^6]

If installation fails before restart, the backend restores previously stopped projects and clears the pending bundle state.[^4]

### 5. Linux keeps manual app installation

Linux `.deb` still does not support in-place app installation through the Tauri updater. The desktop UI therefore keeps the download flow on Linux, but the next launch of the newer app still runs the same startup reconcile for resources and images.[^6][^7]

## Consequences

### Positive

- The installed app bundle has a concrete runtime identity (`bundle_id`) instead of relying on a mutable shared tag.[^2][^3]
- Desktop startup can recover from interrupted updates because reconcile phases are persisted in `bundle-state.json`.[^2][^4]
- Manual app upgrades and UI-triggered app upgrades use the same runtime reconcile path.[^4][^6]

### Negative

- Startup after an app upgrade can take longer because it may rebuild built-in images before restoring projects.[^3][^4]
- Failed reconcile is explicit user-visible state that needs retry handling instead of silently continuing with stale images or resources.[^4]

### Non-goals

- Roll back to the previous app version automatically
- Roll back to previously tagged built-in images automatically
- Keep using shared `:latest` tags for built-in images[^3][^4]

## Rejected Alternatives

### 1. Keep `speedwave-*:latest` and rebuild opportunistically

Rejected because a mutable shared tag does not prove compatibility with the installed desktop bundle, especially after interrupted or partial updates.[^3][^5]

### 2. Sync `claude-resources` directly from the app bundle on every container start

Rejected because compose mounts a stable host path and the update boundary belongs at bundle reconcile time, not at every individual container start.[^2][^5]

### 3. Keep a two-step frontend flow (`install_update` then `restart_app`)

Rejected because the backend needs to own the full sequence of saving running projects, stopping containers, installing the update, and triggering the restart.[^4][^6]

---

[^1]: [`crates/speedwave-runtime/src/update.rs` — Speedwave repository](https://github.com/speednet-software/speedwave/blob/main/crates/speedwave-runtime/src/update.rs)
[^2]: [`crates/speedwave-runtime/src/bundle.rs` — Speedwave repository](https://github.com/speednet-software/speedwave/blob/main/crates/speedwave-runtime/src/bundle.rs)
[^3]: [`crates/speedwave-runtime/src/build.rs` — Speedwave repository](https://github.com/speednet-software/speedwave/blob/main/crates/speedwave-runtime/src/build.rs)
[^4]: [`desktop/src-tauri/src/reconcile.rs` — Speedwave repository](https://github.com/speednet-software/speedwave/blob/main/desktop/src-tauri/src/reconcile.rs)
[^5]: [`crates/speedwave-runtime/src/compose.rs` — Speedwave repository](https://github.com/speednet-software/speedwave/blob/main/crates/speedwave-runtime/src/compose.rs)
[^6]: [`desktop/src-tauri/src/update_commands.rs` — Speedwave repository](https://github.com/speednet-software/speedwave/blob/main/desktop/src-tauri/src/update_commands.rs)
[^7]: [`desktop/src-tauri/src/updater.rs` — Speedwave repository](https://github.com/speednet-software/speedwave/blob/main/desktop/src-tauri/src/updater.rs)
