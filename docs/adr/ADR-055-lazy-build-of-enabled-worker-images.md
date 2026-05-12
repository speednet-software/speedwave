# ADR-055: Lazy build of enabled worker container images

## Status

Accepted

## Context

`crates/speedwave-runtime/src/build.rs::build_all_images*` built the entire `IMAGES` catalogue (9 built-in images today: claude, mcp-hub, slack, sharepoint, redmine, gitlab, github, atlassian, playwright) plus **every installed MCP plugin image** at every setup and every bundle reconcile, regardless of which integrations were enabled. Plugin builds were partially lazy at compose render time (`plugin::ensure_plugin_images(rt, enabled_ids)`, ADR-015), but reconcile called `ensure_all_plugin_images` which rebuilt all installed plugins.

The heavy images amplify the cost:

- `speedwave-mcp-playwright` ~2.5 GB (Chromium)[^1]
- the upcoming `speedwave-mcp-office` ~700 MB–1 GB (Debian + LibreOffice + Python venv: markitdown / weasyprint / pdfminer / onnxruntime / pandas / …)
- plugin `presale` and similar ML plugins multiple GB (docling, embeddings)

Effects on the user:

- "Starting containers…" blocks several minutes on first run and on every app update (ADR-030 [^2] explicitly accepts longer startup post-upgrade — but it was accepting the wrong amount).
- The Lima VM disk fills with images the user never touches (SPW-119, SPW-157 prune accumulators only mask the symptom).
- New worker images and plugins make the picture worse over time, not better.

Verified during investigation: **no prior ADR or comment justifies eager builds**. The pattern dates back to v0.0.1 (6 small Alpine images) and was never revisited.

## Decision

Build only the images that the user actually needs:

1. **Per-project predicate.** `build::enabled_images(integrations)` returns `claude` + `mcp-hub` always, plus the worker image for each enabled built-in MCP integration. Plugin images are handled by `plugin::ensure_plugin_images(rt, enabled_ids)`.
2. **One shared SSOT.** `compose::enabled_hub_service_ids(integrations)` returns the IDs the hub expects in `ENABLED_SERVICES`; `build::enabled_images` derives the worker subset from the same `is_service_enabled` predicate via the `speedwave-mcp-<config_key>` naming rule. Build- and compose-filtering can no longer drift.
3. **Setup and reconcile build the active project's enabled set.** Reconcile resolves `user_config.active_project` and builds its enabled integrations (claude + mcp-hub + workers). On a fresh setup (no active project yet) only claude + mcp-hub are built. **Project switch triggers a lazy build for the destination project** — `switch_project` (and `recreate_project_containers`) calls `integrations_cmd::ensure_project_images_built` before `compose_up`, emitting `worker_image_build_status` events so the shell overlay shows progress regardless of trigger (toggle or switch).
4. **Reconcile plugin pass is scoped.** `ensure_all_plugin_images` (which rebuilt every installed MCP plugin regardless of project) is removed; reconcile now calls `ensure_plugin_images(rt, &active_integrations.enabled_plugin_service_ids())`, still warn-only.
5. **On-demand build on enable.** When the user toggles an integration on, `restart_integration_containers` builds only the _missing_ images for the current project (`build::build_missing_images`), emitting per-image progress on a new `worker_image_build_status` Tauri event. The frontend renders a blocking modal mirroring the plugin install overlay (ADR-047). A failed build rolls the just-enabled integration back to `enabled: false` and the prior containers keep running with their prior configuration.
6. **`images_exist` is integration-aware.** The reconcile fast-path "bundle unchanged but images missing → rebuild" checks only the images that _should_ exist for the active project, not the full catalogue. Disabled integrations have no image under lazy builds, so checking them would force a phantom rebuild on every start.
7. **Pruning is two-layered.** `prune_old_bundle_images` force-removes every catalogue tag for the old bundle id on each bundle change (`--force` because stopped containers from the previous session block plain `rmi`). `prune_orphan_current_bundle_images` runs at the end of each reconcile and force-removes tags of the current bundle id that are no longer in `enabled_images(active)` — cleans up after the user disables an integration without bumping the bundle.
8. **Cancel is deferred.** `ContainerRuntime::build_image` is blocking and uncancellable; functional Cancel would need a trait method plus child-process kill in each runtime impl (Lima / nerdctl / WSL2). v1 ships without a Cancel button on the build overlay; the fast-follow adds `build_image_cancellable` + an `AtomicBool`.
9. **Build-time context bundling is unchanged.** `scripts/bundle-build-context.sh` still copies every Containerfile + context into the Tauri resources; the filter is purely runtime. The SSOT-alignment pair from CLAUDE.md (`bundle-build-context.sh::MCP_SERVICES` ↔ `build.rs::IMAGES`) stays intact.

## Consequences

**Positive:**

- First-start of a project with one enabled integration builds 3 images (`claude` + `mcp-hub` + that worker) instead of 9 (and instead of 10+ once `mcp-office` lands). Cold build of `mcp-playwright` (~5–10 min) and the future `mcp-office` (~3–7 min) only happens for users who actually use them.
- Lima VM disk pressure drops accordingly — disabled integrations occupy no space.
- Reconcile after an app update rebuilds only what the user actually runs.
- Snapshotter and transient retry logic (ADR-032 [^3]) operates on a smaller slice and on single-image builds — same code path, parametrised.

**Negative:**

- First enable of an integration in a running project now blocks on a build. Mitigated by:
  - A blocking modal with per-image progress (mirroring ADR-047 [^4]).
  - A static estimate table (`ImageDef.estimated_build_seconds`, surfaced through `list_worker_image_build_estimates`).
  - Build failure rolls the integration back to disabled rather than leaving the UI lying.
- Project switch may incur a build if the destination project enables an integration whose worker hasn't been built yet. Mitigated by the same overlay+estimate UX as toggle-driven builds, and by the fact that the active project's images are always pre-built by reconcile.
- `images_exist` becomes integration-aware. Forgetting to pass the per-project set would force phantom rebuilds — caught by `test_images_exist_ignores_disabled_integration_images` / `test_images_exist_false_when_an_enabled_worker_image_missing`.

## Relation to other ADRs

- **ADR-015 (Plugin System)** [^5] established lazy plugin builds via `ensure_plugin_images`; this ADR extends the same pattern to built-in workers and makes reconcile honour the per-project scope rather than rebuilding every installed plugin.
- **ADR-030 (Bundle reconcile)** [^2] — refines the "Build Images" step: still atomic per bundle, but the atom shrinks from the catalogue to the union of enabled.
- **ADR-032 (Snapshotter resilience)** [^3] — unchanged; the retry/prune/restart-engine wrapper now operates on the filtered slice and on single-image builds.
- **ADR-047 (Plugin install progress events)** [^4] — the on-demand build overlay mirrors the plugin install modal's event/payload contract (one event name per flow, snake_case phases, per-step transitions, retry on error).
- **SPW-119 / SPW-157** — old-bundle prune still runs unchanged; this ADR makes the _current_ bundle smaller.

## Future work

- **Functional Cancel.** Add `ContainerRuntime::build_image_cancellable(&self, …, cancel: &AtomicBool)` polling an atomic flag and killing the underlying `nerdctl build` child process group, implemented for Lima / nerdctl / WSL2; wire a `cancel_worker_image_build` Tauri command and enable the modal's Cancel button.
- **`PluginManifest.estimated_build_time`.** Plugin builds today get a generic estimate; once the plugin manifest schema gains an `estimated_build_time` field (plugin contract change, requires `speedwave-plugins` coordination — see `.claude/rules/plugins.md`), the modal can surface accurate per-plugin estimates the same way it does for built-ins.

---

[^1]: [Microsoft Playwright Docker image size — Chromium dependencies](https://playwright.dev/docs/docker)

[^2]: [docs/adr/ADR-030-bundle-reconcile-after-app-update.md](ADR-030-bundle-reconcile-after-app-update.md)

[^3]: [docs/adr/ADR-032-nested-virtualization-resilience.md](ADR-032-nested-virtualization-resilience.md)

[^4]: [docs/adr/ADR-047-plugin-install-progress-events.md](ADR-047-plugin-install-progress-events.md)

[^5]: [docs/adr/ADR-015-plugin-system.md](ADR-015-plugin-system.md)
