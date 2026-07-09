#!/usr/bin/env bash
# bundle-build-context.sh — Copies container build context, mcp-os, and the
# oauth worker into desktop/src-tauri/ for Tauri resource bundling.
#
# Defines which MCP services are bundled into the Tauri app resource directory.
# NOTE: Container image definitions live in crates/speedwave-runtime/src/build.rs (IMAGES constant).
#       The IMAGES list and MCP_SERVICES list must stay aligned for overlapping services.
#       os and oauth are NOT in IMAGES (they are host processes, not containers) —
#       they are bundled as mcp-os/ and oauth/ here, and listed in
#       crates/speedwave-runtime/src/bundle.rs::COMMON_BUNDLED_ASSETS.
# Called from: Makefile (dev target), CI workflows (desktop-build, desktop-release).
#
# Usage:
#   scripts/bundle-build-context.sh        # default: copies pre-built mcp-os / oauth dist
#   scripts/bundle-build-context.sh --ci   # CI mode: builds mcp-os + oauth from source first

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Default to the in-repo Tauri resource dir for production. Tests override via
# BUNDLE_DEST so concurrent `make test` and `make dev` do not race on the same
# files (see _tests/desktop/bundle-build-context.bats).
DEST="${BUNDLE_DEST:-$REPO_ROOT/desktop/src-tauri}"
mkdir -p "$DEST"

# Serialize concurrent runs on the same DEST. The body does `rm -rf` + non-atomic
# copies; a parallel image build (e.g. `make dev` while `make test` bundles) can
# read a half-written tree and bake a 0-byte mcp-shared/package.json into a worker
# image (ERR_INVALID_PACKAGE_CONFIG, exit 1). `mkdir` is an atomic create-or-fail
# on macOS/Windows/Linux with no external tool (unlike flock) — the second runner
# spins until the first releases. The lock stores its holder PID so a run killed
# with SIGKILL (untrappable) cannot deadlock future bundles: a lock whose PID is
# gone is reclaimed. The trap clears our own lock on any exit incl. signals.
LOCK_DIR="$DEST/.bundle.lock"
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  # Reclaim only when we can prove the holder is gone. A blank PID means the
  # owner created the dir but has not written its PID yet — treat as alive and
  # wait, so we never delete a lock another run is mid-acquiring.
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
    rm -rf "$LOCK_DIR"  # holder process is dead — reclaim the stale lock
    continue
  fi
  sleep 0.3
done
# Arm the release trap BEFORE writing the PID: if the `echo` fails (e.g. disk
# full), `set -e` exits and the trap still removes the lock — no deadlock.
trap 'rm -rf "$LOCK_DIR" 2>/dev/null || true' EXIT INT TERM
echo "$$" >"$LOCK_DIR/pid"

# Clean destination to prevent stale files from previous runs
rm -rf "$DEST/build-context" "$DEST/mcp-os" "$DEST/oauth"

# -- Build context (containers + MCP server sources) --------------------------

mkdir -p "$DEST/build-context"
cp -r "$REPO_ROOT/containers" "$DEST/build-context/"

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

# stage_host_worker <worker-dir-name> <bundle-dir-name>
#   Stages mcp-servers/<worker-dir-name>/dist + the @speedwave/mcp-shared
#   dependency tree into $DEST/<bundle-dir-name>/, mirroring how mcp-os has
#   always been bundled. The bundle layout is <bundle-dir-name>/<worker>/dist
#   plus <bundle-dir-name>/shared (so Node resolves @speedwave/mcp-shared from
#   <worker>/dist/index.js). Tauri's resource bundler doesn't reliably preserve
#   symlinks in .dmg/.deb/NSIS packages, hence the cp -r of the shared tree.
stage_host_worker() {
  local worker="$1" bundle="$2"
  mkdir -p "$DEST/$bundle/$worker" "$DEST/$bundle/shared"
  cp -r "$REPO_ROOT/mcp-servers/$worker/dist" "$DEST/$bundle/$worker/"
  cp -r "$REPO_ROOT/mcp-servers/shared/dist" "$DEST/$bundle/shared/"
  # Install production deps only. Cannot use the workspace-scoped
  # package-lock.json directly — it has workspace-relative entries that don't
  # resolve in isolation. Two-step: standalone lockfile, then deterministic npm ci.
  cp "$REPO_ROOT/mcp-servers/shared/package.json" "$DEST/$bundle/shared/"
  (cd "$DEST/$bundle/shared" && npm install --package-lock-only --ignore-scripts && npm ci --omit=dev --ignore-scripts)
  mkdir -p "$DEST/$bundle/$worker/node_modules/@speedwave"
  cp -r "$DEST/$bundle/shared" "$DEST/$bundle/$worker/node_modules/@speedwave/mcp-shared"
}

stage_host_worker os mcp-os
stage_host_worker oauth oauth
