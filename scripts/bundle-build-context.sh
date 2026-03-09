#!/usr/bin/env bash
# bundle-build-context.sh — Copies container build context and mcp-os into
# desktop/src-tauri/ for Tauri resource bundling.
#
# Defines which MCP services are bundled into the Tauri app resource directory.
# NOTE: Container image definitions live in crates/speedwave-runtime/src/build.rs (IMAGES constant).
#       The IMAGES list and MCP_SERVICES list must stay aligned for overlapping services.
# Called from: Makefile (dev target), CI workflows (desktop-build, desktop-release).
#
# Usage:
#   scripts/bundle-build-context.sh        # default: copies pre-built mcp-os dist
#   scripts/bundle-build-context.sh --ci   # CI mode: builds mcp-os from source first

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$REPO_ROOT/desktop/src-tauri"

# Clean destination to prevent stale files from previous runs
rm -rf "$DEST/build-context" "$DEST/mcp-os"

# -- Build context (containers + MCP server sources) --------------------------

mkdir -p "$DEST/build-context"
cp -r "$REPO_ROOT/containers" "$DEST/build-context/"

mkdir -p "$DEST/build-context/mcp-servers"
cp "$REPO_ROOT/mcp-servers/tsconfig.base.json" "$DEST/build-context/mcp-servers/"

# os is intentionally excluded — it runs on the host and is bundled separately as mcp-os/
MCP_SERVICES="shared hub slack sharepoint redmine gitlab gemini"

for svc in $MCP_SERVICES; do
  svc_src="$REPO_ROOT/mcp-servers/$svc"
  svc_dest="$DEST/build-context/mcp-servers/$svc"
  mkdir -p "$svc_dest"
  cp "$svc_src/package.json" "$svc_dest/"
  [ -f "$svc_src/package-lock.json" ] && cp "$svc_src/package-lock.json" "$svc_dest/"
  cp -r "$svc_src/src" "$svc_dest/"
  [ -f "$svc_src/tsconfig.json" ] && cp "$svc_src/tsconfig.json" "$svc_dest/"
  for f in Dockerfile Containerfile; do
    [ -f "$svc_src/$f" ] && cp "$svc_src/$f" "$svc_dest/"
  done
done

# -- mcp-os (host-side TypeScript worker) -------------------------------------

if [[ "${1:-}" == "--ci" ]]; then
  # CI mode: build from clean checkout (no pre-built dist/) and install production-only deps
  (cd "$REPO_ROOT/mcp-servers" && npm ci && npm run build --workspace=shared && npm run build --workspace=os)
fi

mkdir -p "$DEST/mcp-os/os" "$DEST/mcp-os/shared"
cp -r "$REPO_ROOT/mcp-servers/os/dist" "$DEST/mcp-os/os/"
cp -r "$REPO_ROOT/mcp-servers/shared/dist" "$DEST/mcp-os/shared/"

if [[ "${1:-}" == "--ci" ]]; then
  # Install production-only dependencies for shared (lockfile is at workspace root)
  cp "$REPO_ROOT/mcp-servers/shared/package.json" "$DEST/mcp-os/shared/"
  cp "$REPO_ROOT/mcp-servers/package-lock.json" "$DEST/mcp-os/shared/"
  (cd "$DEST/mcp-os/shared" && npm ci --omit=dev)
else
  # Dev mode: copy existing node_modules if available
  if [ -d "$REPO_ROOT/mcp-servers/shared/node_modules" ]; then
    cp -r "$REPO_ROOT/mcp-servers/shared/node_modules" "$DEST/mcp-os/shared/"
  else
    echo "warning: mcp-servers/shared/node_modules not found — run 'make build-mcp' first" >&2
  fi
fi
