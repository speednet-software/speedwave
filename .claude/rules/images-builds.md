---
paths:
  - 'containers/**'
  - 'mcp-servers/**/Dockerfile*'
  - 'mcp-servers/**/Containerfile*'
  - 'crates/speedwave-runtime/src/build.rs'
  - 'crates/speedwave-runtime/src/bundle.rs'
  - 'scripts/bundle-build-context.sh'
  - 'scripts/bundle-build-context.ps1'
---

# Container Images & Builds

- **Catalog SSOT:** `build.rs::IMAGES` — one `ImageDef` per image. Compose references images via `${IMAGE_*}` placeholders (alignment test-guarded), bundle scripts carry the matching service list (test-guarded).
- **Rebuilds are content-addressed:** tags are `name:<16-hex>` over the image's declared `ImageDef.hash_inputs`. Rules:
  - Every file a Containerfile `COPY`s must be listed in that image's `hash_inputs` (test-guarded by `hash_inputs_cover_copy_sources`) — otherwise it ships stale after edits.
  - Do NOT over-declare inputs (e.g. `claude-resources/`, `compose.template.yml` for the claude image) — over-declaration is NOT test-caught and forces a rebuild on every unrelated edit.
  - Never rebuild under an unchanged tag: `nerdctl compose up` will not recreate the container. A content change must produce a new tag.
  - Builds and tag-prunes serialize via `build::with_build_lock`; never run builds inside a compose transaction lock.
  - `bundle_id` gates bundle reconcile only — it does not trigger image rebuilds.
- **Lazy builds:** images build per enabled integration — `build::enabled_images(integrations)` / `build_missing_images`, plugins via `plugin::ensure_plugin_images(rt, enabled_ids)`. Never build or existence-check the full catalog (phantom rebuilds, multi-minute startups); orphan pruning is per-project.
- **No routine `builder prune`** — pruning shared BuildKit state invalidates caches for every project.
- **New image checklist:** `IMAGES` entry with `hash_inputs` + `${IMAGE_*}` placeholder + bundle-script list entry (all test-guarded) · **`tzdata`** installed (apk/apt) or zoneinfo COPY'd for scratch images — MANUAL, nothing catches a miss, and without it the injected `TZ` degrades to a numeric offset · `DEBIAN_FRONTEND=noninteractive` on every `apt-get install` (test-guarded — an interactive tzdata prompt hangs BuildKit forever) · SHA256-verify any downloaded binary · resource entry on the service descriptor, never a literal in the template.
- **Claude-resources are not baked** into the claude image — they sync to the data dir and mount at start; editing a skill in the repo does not reach a running container without sync/restart.
