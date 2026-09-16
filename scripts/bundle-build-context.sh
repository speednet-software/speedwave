#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${BUNDLE_DEST:-$REPO_ROOT/desktop/src-tauri}"
mkdir -p "$DEST"
MCP_SERVERS_DIR="${BUNDLE_MCP_SERVERS_DIR:-$REPO_ROOT/mcp-servers}"
CONTAINERS_DIR="${BUNDLE_CONTAINERS_DIR:-$REPO_ROOT/containers}"
if [ ! -d "$MCP_SERVERS_DIR" ]; then
  echo "ERROR: mcp-servers tree not found at $MCP_SERVERS_DIR (BUNDLE_MCP_SERVERS_DIR)." >&2
  exit 1
fi
if [ ! -d "$CONTAINERS_DIR" ]; then
  echo "ERROR: containers tree not found at $CONTAINERS_DIR (BUNDLE_CONTAINERS_DIR)." >&2
  exit 1
fi

LOCK_DIR="$DEST/.bundle.lock"
WASM_PKG_DIR="${BUNDLE_WASM_PKG_DIR:-$REPO_ROOT/mcp-servers/policies/wasm-pkg}"
WASM_LOCK_DIR="$(dirname "$WASM_PKG_DIR")/.wasm-build.lock"
mkdir -p "$(dirname "$WASM_PKG_DIR")"

# shellcheck source=mkdir-lock.sh
source "$REPO_ROOT/scripts/mkdir-lock.sh"

acquire_lock "$LOCK_DIR"
acquire_lock "$WASM_LOCK_DIR"

rm -rf "$DEST/build-context" "$DEST/mcp-os" "$DEST/oauth"

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


copy_tree() {
  local src="$1" dest="$2"
  mkdir -p "$dest"
  (cd "$src" && find . -type d \
      \( -name target -o -name dist -o -name node_modules \) -prune -o ! -type d -print0 |
    tar -cf - --null -T -) | tar -xpmf - -C "$dest"
}

copy_tree "$CONTAINERS_DIR" "$DEST/build-context/containers"

copy_tree "$REPO_ROOT/crates/pii-engine" "$DEST/build-context/containers/crates/pii-engine"

mkdir -p "$DEST/build-context/containers/mcp-servers/policies"
cp "$MCP_SERVERS_DIR/policies/rules.yaml" "$DEST/build-context/containers/mcp-servers/policies/"

find "$DEST/build-context/containers" -type f -name '*.sh' -print0 |
    xargs -0 sed -i.bak 's/\r//g'
find "$DEST/build-context/containers" -type f -name '*.sh.bak' -delete

mkdir -p "$DEST/build-context/mcp-servers"
cp "$MCP_SERVERS_DIR/tsconfig.base.json" "$DEST/build-context/mcp-servers/"

MCP_SERVICES="shared policies hub slack sharepoint redmine gitlab github atlassian office playwright context7"

for svc in $MCP_SERVICES; do
  svc_src="$MCP_SERVERS_DIR/$svc"
  svc_dest="$DEST/build-context/mcp-servers/$svc"
  mkdir -p "$svc_dest"
  cp "$svc_src/package.json" "$svc_dest/"
  [ -f "$svc_src/package-lock.json" ] && cp "$svc_src/package-lock.json" "$svc_dest/"
  [ -d "$svc_src/src" ] && cp -r "$svc_src/src" "$svc_dest/"
  [ -f "$svc_src/tsconfig.json" ] && cp "$svc_src/tsconfig.json" "$svc_dest/"
  [ -d "$svc_src/templates" ] && cp -r "$svc_src/templates" "$svc_dest/"
  if [ "$svc" = "policies" ]; then
    cp -r "$WASM_PKG_DIR" "$svc_dest/wasm-pkg"
  fi
  if [ -d "$svc_src/scripts" ]; then
    mkdir -p "$svc_dest/scripts"
    find "$svc_src/scripts" -maxdepth 1 -type f ! -name 'test_*.py' -exec cp {} "$svc_dest/scripts/" \;
  fi
  [ -f "$svc_src/requirements.txt" ] && cp "$svc_src/requirements.txt" "$svc_dest/"
  for f in Dockerfile Containerfile; do
    [ -f "$svc_src/$f" ] && cp "$svc_src/$f" "$svc_dest/"
  done
done


if [[ "${1:-}" == "--ci" ]]; then
  (cd "$MCP_SERVERS_DIR" && npm ci \
    && npm run build --workspace=shared \
    && npm run build --workspace=os \
    && npm run build --workspace=oauth)
fi

stage_host_worker() {
  local worker="$1" bundle="$2"
  mkdir -p "$DEST/$bundle/$worker" "$DEST/$bundle/shared"
  cp -r "$MCP_SERVERS_DIR/$worker/dist" "$DEST/$bundle/$worker/"
  cp -r "$MCP_SERVERS_DIR/shared/dist" "$DEST/$bundle/shared/"
  cp "$MCP_SERVERS_DIR/shared/package.json" "$DEST/$bundle/shared/"
  (cd "$DEST/$bundle/shared" && npm pkg delete devDependencies && npm install --package-lock-only --ignore-scripts && npm ci --omit=dev --ignore-scripts)
  mkdir -p "$DEST/$bundle/$worker/node_modules/@speedwave"
  cp -r "$DEST/$bundle/shared" "$DEST/$bundle/$worker/node_modules/@speedwave/mcp-shared"
}

stage_host_worker os mcp-os
stage_host_worker oauth oauth
