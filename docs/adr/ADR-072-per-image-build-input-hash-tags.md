# ADR-072: Per-image build-input hash tags + BuildKit cache retention

## Status

Accepted

## Context

This ADR partially supersedes
[ADR-030](ADR-030-bundle-reconcile-after-app-update.md): the reconcile phase
machine and atomicity it defines stay intact; what changes is image tagging and
the rebuild decision.

Until this ADR, every container image was tagged with a single `bundle_id` — one
SHA-256 over `app_version` + the entire `containers/` and `mcp-servers/` trees +
`claude-resources/` + the pinned Claude Code version. Consequences:

- A change to **one file** in **one worker** retagged and rebuilt **all ~11
  images** on the user's machine during update reconciliation.
- Bumping the **app version alone** (every release) changed `bundle_id`, so a
  release with zero container changes still rebuilt everything.
- `prune_old_bundle_images()` unconditionally ran `nerdctl builder prune --all
--force` after every bundle change, discarding the BuildKit cache — so even
  the layers that could have been reused (apt installs, `--mount=type=cache`
  npm caches[^1]) were rebuilt from scratch.

Update reconciliation was therefore the slowest user-facing path in the app.

## Decision

### Two separate decisions instead of one `bundle_id`

The single id conflated two questions that have different correct answers:

1. **`needs_image_build`** — decided **per image**, by tag presence. Each image
   is tagged `name:<hash16>` where the hash covers the image's **declared build
   inputs**: `ImageDef.hash_inputs` (paths relative to the build root) plus its
   `--build-arg` values. A present tag is exactly the build that manifest needs;
   `build_missing_images` skips it. This also makes interrupted builds resume
   cheaply — completed tags survive the crash.
2. **`needs_reconcile`** (resources sync + project restore) — decided by the
   aggregate `bundle_id` = SHA-256(`app_version` + sorted per-image hashes +
   `claude_resources_hash`). `app_version` stays in this id **deliberately**:
   the compose template is embedded in the binary (`compose/mod.rs`
   `include_str!`) and all render logic (resource limits, env injectors) is
   code — only the app version honestly covers "the rendered compose or the
   delivery pipeline may have changed". A release therefore still re-renders
   compose and force-recreates containers (seconds), but builds **zero** images
   unless their inputs changed.

### Hash-input declarations are test-enforced

`ImageDef.hash_inputs` is the SSOT for what feeds each image's hash:

- `speedwave-claude`: the four files its Containerfile uses (explicit list —
  `containers/` also holds `claude-resources/` (synced + mounted, never baked)
  and `compose.template.yml`; neither may rebuild claude).
- Workers: own directory + `mcp-servers/shared` + `mcp-servers/tsconfig.base.json`
  (a `shared/` change rebuilds every worker — it is baked into each via
  multi-stage COPY).

The mapping is kept honest by `hash_inputs_cover_copy_sources`: it parses every
`COPY`/`ADD` in every Containerfile (excluding `--from=` stage copies) and fails
if any source is not covered by the image's declared inputs — an undeclared
source would ship stale code without a rebuild.

**Terminology:** this is a hash of **build inputs**, not image content. Base
images (`node:24-*` etc.) remain external and mutable, exactly as before
(playwright pins its base by digest; the rest float).

### State, migration, pruning

- `BundleState` gains `applied_image_hashes` (`#[serde(default)]`, additive).
  Old state files parse with an empty map → one full rebuild (same cost as any
  pre-ADR update), and the legacy `name:<old_bundle_id>` tags are pruned once.
  Downgrade is safe: old releases ignore unknown fields, see an id mismatch,
  and rebuild fully.
- The applied map and id are written **atomically, only after every project is
  restored** — unchanged from the pre-ADR atomicity invariant (pinned by
  `reconcile_partial_build_failure_does_not_mutate_applied_bundle_id`).
- Routine pruning is a **diff against this install's own applied history**
  (`prune_replaced_images`): for each image whose hash changed, remove
  `name:old_hash`. It never sweeps by repository name — repo names are global
  across data dirs/worktrees and rollback snapshots may reference old tags.
- An unchanged reconcile id with non-empty `pending_running_projects` (projects
  stopped by an update that turned out to be a no-op, e.g. a same-version
  reinstall) now **restores those projects** instead of clearing the list —
  previously a latent stranding bug masked by `app_version` always changing
  the id.

### BuildKit cache is no longer pruned on update

The unconditional `prune_buildkit_cache` call is removed from the prune path.
Cache is pruned only by the recovery ladder in `with_build_recovery` (shared by
bundle and plugin builds), in two unrecoverable states — disk-full and
containerd snapshotter corruption (`failed to stat parent`) — where cache reuse
is impossible anyway; `nerdctl system prune` does not clear BuildKit cache
mounts, so both branches call `builder prune` explicitly. Routine updates never
prune the cache. Bounded cache growth is accepted: nerdctl exposes no
`--keep-storage` budget for `builder prune` (only `--all`/`--force`)[^2], so a
threshold-based prune is deferred.

### Cross-process build lock

Image builds + tag prunes are serialised by `<data_dir>/build.lock`
(`build::with_build_lock`, same `fs2` pattern as the per-project compose lock).
Desktop reconcile, CLI update and project-switch lazy builds previously raced
freely (BuildKit serialises internally, but concurrent identical builds wasted
work and a prune could race a build). The lock is held around build+prune
sequences, never around `compose up` — consistent with ADR-066 (builds stay
outside compose locks). The CLI remains a **non-writer** of `bundle-state.json`
(test-pinned); Desktop reconcile and the setup wizard are the only writers.

## Alternatives considered

- **Separate `compose_template_hash` as the restore trigger** — rejected: the
  rendered compose also depends on `resources.rs` limits, env injectors and
  every other piece of render code in the binary; only `app_version` covers all
  of it without enumerating code paths.
- **Keep-set sweep GC** (remove every `speedwave-*` tag not in applied ∪
  current) — rejected for this change: repo names are shared across installs /
  worktrees and update rollback snapshots reference old tags; a safe sweep
  needs ownership labels. Orphans from abandoned bundles are reclaimed by the
  existing disk-full prune ladder.
- **`nerdctl builder prune --keep-storage <N>`** — not available in nerdctl
  (Docker-only flag)[^2]; revisit if upstream adds it.
- **Content-addressed plugin image tags** — deferred at first, implemented
  since: plugin tag = `<version|image_tag>-<digest16>` from the ADR-051
  signed-tree digest, previous tag recorded in
  `plugin-state/<slug>/applied_image_tag` and pruned when superseded. No
  plugins-repository change needed — the tag is produced and consumed
  entirely by this repo.

## Consequences

- A release with no container changes builds **0 images**; a one-worker change
  builds **1** (plus all workers when `mcp-servers/shared` changes — correct).
- apt/npm cache layers survive updates; rebuild time for a changed image drops
  to the layers its change actually invalidated.
- Every install pays one full rebuild on the release that introduces this ADR
  (legacy state has no per-image map).
- A hash that changes twice across a _failed_ reconcile can leave one orphan
  tag until the disk-full ladder reclaims it — accepted (bounded, rare).
- `nerdctl compose up` without `--force-recreate` will NOT recreate a container
  whose image was rebuilt under an unchanged tag. Per-image content-addressed
  tags remove that hazard: a changed image always gets a new tag, so plain
  config-hash convergence (nerdctl ≥ 2.2.0[^3]) recreates exactly what changed.
  Combined with the nerdctl 2.2.2 parity bump, this let the project-switch path
  drop `--force-recreate` (idempotent `compose_up`) — unchanged containers are
  left in place on switch. Bundle reconcile restore still uses `--force-recreate`
  (it crosses image-tag changes and must guarantee a fresh entrypoint).

[^1]:
    BuildKit `RUN --mount=type=cache` documentation — cache mounts persist
    outside image layers: <https://docs.docker.com/reference/dockerfile/#run---mounttypecache>

[^2]:
    nerdctl command reference, `nerdctl builder prune` — flags are limited to
    `--all`/`--force`; `--keep-storage` is not implemented:
    <https://github.com/containerd/nerdctl/blob/main/docs/command-reference.md#nerdctl-builder-prune>

[^3]:
    nerdctl PR #4550 "compose: align convergence with Docker Compose"
    (config-hash label `com.docker.compose.config-hash`, first released in
    v2.2.0): <https://github.com/containerd/nerdctl/pull/4550>
