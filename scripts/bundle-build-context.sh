#!/usr/bin/env bash
# Copies container build context, mcp-os, and oauth into desktop/src-tauri/ for Tauri bundling
# (IMAGES/MCP_SERVICES aligned; os/oauth as host processes, bundle.rs::COMMON_BUNDLED_ASSETS).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Default to the in-repo Tauri resource dir; tests override via BUNDLE_DEST so concurrent
# `make test`/`make dev` don't race (_tests/desktop/bundle-build-context.bats).
DEST="${BUNDLE_DEST:-$REPO_ROOT/desktop/src-tauri}"
mkdir -p "$DEST"

LOCK_DIR="$DEST/.bundle.lock"
# mcp-servers/policies/wasm-pkg is a single shared source-tree location (not under $DEST) —
# a second lock guards it from concurrent writers across different $BUNDLE_DEST invocations.
WASM_PKG_DIR="$REPO_ROOT/mcp-servers/policies/wasm-pkg"
WASM_LOCK_DIR="$REPO_ROOT/mcp-servers/policies/.wasm-build.lock"

# acquire_lock <dir>: mkdir-based mutex, atomic cross-platform; a lock whose holder PID is
# dead is reclaimed. Arms trap before PID write to prevent deadlock if PID write fails.
_LOCK_CLEANUP=""
acquire_lock() {
  local dir="$1" holder
  while ! mkdir "$dir" 2>/dev/null; do
    holder="$(cat "$dir/pid" 2>/dev/null || true)"
    # Reclaim only when we can prove the holder is gone; a blank PID means the owner is
    # mid-acquiring — treat as alive and wait rather than delete it.
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
      rm -rf "$dir"  # holder process is dead — reclaim the stale lock
      continue
    fi
    sleep 0.3
  done
  # Trap exits before PID write: mkdir succeeded, lock is ours. Stack cleanup commands.
  _LOCK_CLEANUP="rm -rf '$dir' 2>/dev/null || true; $_LOCK_CLEANUP"
  trap 'eval "$_LOCK_CLEANUP"' EXIT INT TERM
  echo "$$" >"$dir/pid"
}

# Serialize concurrent runs on DEST (non-atomic body can bake a 0-byte package.json into a worker
# image otherwise). Acquire both locks; trap stacks cleanup in LIFO order.
acquire_lock "$LOCK_DIR"
acquire_lock "$WASM_LOCK_DIR"

# Clean destination to prevent stale files from previous runs
rm -rf "$DEST/build-context" "$DEST/mcp-os" "$DEST/oauth"

# -- PII engine wasm artifact (crates/pii-engine-wasm) ------------------------
# Built fresh on every run that stages policies — no prebuilt/placeholder fallback. A local
# `make dev`/`make build` also builds the hub image from this same build-context, so this
# cannot be gated behind --ci: whichever path stages policies must produce a real engine.
if ! bash "$REPO_ROOT/crates/pii-engine-wasm/build-wasm.sh" "$WASM_PKG_DIR"; then
  echo "ERROR: failed to build the PII engine wasm artifact (crates/pii-engine-wasm)." >&2
  echo "Install the toolchain with 'make setup-dev' (rustup target wasm32-unknown-unknown + wasm-pack) and retry." >&2
  exit 1
fi
shopt -s nullglob
wasm_artifacts=("$WASM_PKG_DIR"/*_bg.wasm)
shopt -u nullglob
if [ "${#wasm_artifacts[@]}" -eq 0 ] || [ ! -s "${wasm_artifacts[0]}" ]; then
  echo "ERROR: PII engine wasm artifact missing or empty in $WASM_PKG_DIR after build (expected *_bg.wasm)." >&2
  exit 1
fi

# -- Build context (containers + MCP server sources) --------------------------

mkdir -p "$DEST/build-context"
cp -r "$REPO_ROOT/containers" "$DEST/build-context/"

# Vendor crates/pii-engine into the context: Containerfile.proxy COPYs it to recreate the
# repo's `../../crates/pii-engine` relative layout (proxy/Cargo.toml, ADR-073 F4) since the
# proxy image builds from the `containers/` context alone.
mkdir -p "$DEST/build-context/containers/crates"
cp -r "$REPO_ROOT/crates/pii-engine" "$DEST/build-context/containers/crates/pii-engine"

# Host build outputs (e.g. a dirty containers/proxy/target) are never image
# content — prune bundle.rs::HOST_BUILD_OUTPUT_DIRS (alignment test-enforced).
find "$DEST/build-context/containers" -type d \
    \( -name target -o -name dist -o -name node_modules \) -prune -exec rm -rf {} +

# Linux kernel rejects #!/bin/bash\r with exit 127 (issue #603).
# `sed -i.bak` preserves perms in place; `.bak` suffix is the portable form across BSD and GNU.
find "$DEST/build-context/containers" -type f -name '*.sh' -print0 |
    xargs -0 sed -i.bak 's/\r//g'
find "$DEST/build-context/containers" -type f -name '*.sh.bak' -delete

mkdir -p "$DEST/build-context/mcp-servers"
cp "$REPO_ROOT/mcp-servers/tsconfig.base.json" "$DEST/build-context/mcp-servers/"

# os is intentionally excluded — it runs on the host and is bundled separately as mcp-os/
# playwright has no own src/ — the image installs @playwright/mcp from npm at build time.
MCP_SERVICES="shared policies hub slack sharepoint redmine gitlab github atlassian office playwright context7"

for svc in $MCP_SERVICES; do
  svc_src="$REPO_ROOT/mcp-servers/$svc"
  svc_dest="$DEST/build-context/mcp-servers/$svc"
  mkdir -p "$svc_dest"
  cp "$svc_src/package.json" "$svc_dest/"
  [ -f "$svc_src/package-lock.json" ] && cp "$svc_src/package-lock.json" "$svc_dest/"
  # Some services (e.g. playwright) have no own src/ — they wrap an upstream npm package.
  [ -d "$svc_src/src" ] && cp -r "$svc_src/src" "$svc_dest/"
  [ -f "$svc_src/tsconfig.json" ] && cp "$svc_src/tsconfig.json" "$svc_dest/"
  # policies: template YAMLs the hub Containerfile COPYs and reads at runtime.
  [ -d "$svc_src/templates" ] && cp -r "$svc_src/templates" "$svc_dest/"
  # policies: wasm-pkg was just built fresh above — stage it as a real artifact, never a
  # placeholder (the hub Containerfile's COPY policies/wasm-pkg expects real content).
  if [ "$svc" = "policies" ]; then
    cp -r "$svc_src/wasm-pkg" "$svc_dest/wasm-pkg"
  fi
  # office: exclude test_*.py — not in runtime image; must match bundle-build-context.ps1.
  if [ -d "$svc_src/scripts" ]; then
    mkdir -p "$svc_dest/scripts"
    find "$svc_src/scripts" -maxdepth 1 -type f ! -name 'test_*.py' -exec cp {} "$svc_dest/scripts/" \;
  fi
  [ -f "$svc_src/requirements.txt" ] && cp "$svc_src/requirements.txt" "$svc_dest/"
  for f in Dockerfile Containerfile; do
    [ -f "$svc_src/$f" ] && cp "$svc_src/$f" "$svc_dest/"
  done
done

# -- mcp-os + oauth (host-side TypeScript workers) ---------------------------

if [[ "${1:-}" == "--ci" ]]; then
  # CI mode: build from clean checkout (no pre-built dist/) and install production-only deps
  (cd "$REPO_ROOT/mcp-servers" && npm ci \
    && npm run build --workspace=shared \
    && npm run build --workspace=os \
    && npm run build --workspace=oauth)
fi

# stage_host_worker <worker-dir-name> <bundle-dir-name>: stages <worker>/dist + mcp-shared into
#   $DEST/<bundle>/; cp -r not symlink (Tauri's bundler doesn't preserve symlinks).
stage_host_worker() {
  local worker="$1" bundle="$2"
  mkdir -p "$DEST/$bundle/$worker" "$DEST/$bundle/shared"
  cp -r "$REPO_ROOT/mcp-servers/$worker/dist" "$DEST/$bundle/$worker/"
  cp -r "$REPO_ROOT/mcp-servers/shared/dist" "$DEST/$bundle/shared/"
  # Production deps only; the workspace package-lock.json has workspace-relative entries
  # that don't resolve in isolation, hence standalone lockfile then deterministic npm ci.
  cp "$REPO_ROOT/mcp-servers/shared/package.json" "$DEST/$bundle/shared/"
  (cd "$DEST/$bundle/shared" && npm install --package-lock-only --ignore-scripts && npm ci --omit=dev --ignore-scripts)
  mkdir -p "$DEST/$bundle/$worker/node_modules/@speedwave"
  cp -r "$DEST/$bundle/shared" "$DEST/$bundle/$worker/node_modules/@speedwave/mcp-shared"
}

stage_host_worker os mcp-os
stage_host_worker oauth oauth
