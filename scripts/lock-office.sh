#!/usr/bin/env bash
set -euo pipefail

UV_VERSION="0.13.6"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKERFILE="$REPO_ROOT/mcp-servers/office/Dockerfile"

lock_in_container() {
    local venv
    venv="$(mktemp -d)/uv-venv"
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 python3-venv ca-certificates
    python3 -m venv "$venv"
    "$venv/bin/pip" install --no-cache-dir "uv==$UV_VERSION"
    cd "$REPO_ROOT/mcp-servers/office"
    "$venv/bin/uv" pip compile --generate-hashes --python-version 3.11 --python-platform linux --output-file=requirements.txt requirements.in
    chown --reference=requirements.in requirements.txt
}

find_engine() {
    if [ -n "${CONTAINER_ENGINE:-}" ]; then
        echo "$CONTAINER_ENGINE"
        return
    fi
    local candidate
    for candidate in docker podman nerdctl; do
        if command -v "$candidate" >/dev/null 2>&1; then
            echo "$candidate"
            return
        fi
    done
    echo "lock-office: no container engine found. Install docker, podman or nerdctl, or set CONTAINER_ENGINE." >&2
    exit 1
}

base_image() {
    local image
    image="$(sed -n 's/^FROM \(node:[^ ]*-bookworm-slim@sha256:[0-9a-f]*\)$/\1/p' "$DOCKERFILE")"
    if [ -z "$image" ]; then
        echo "lock-office: no digest-pinned bookworm-slim runtime base found in $DOCKERFILE" >&2
        exit 1
    fi
    echo "$image"
}

if [ "${1:-}" = "--in-container" ]; then
    lock_in_container
    exit 0
fi

ENGINE="$(find_engine)"
IMAGE="$(base_image)"
"$ENGINE" run --rm -v "$REPO_ROOT:$REPO_ROOT" "$IMAGE" bash "$REPO_ROOT/scripts/lock-office.sh" --in-container
