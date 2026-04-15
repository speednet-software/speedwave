#!/usr/bin/env bash
# sign-bundled-binaries.sh — Signs Mach-O binaries that ship inside
# Speedwave.app/Contents/Resources/ so the bundle passes Apple notarization.
#
# Apple Notary Service rejects bundles that contain unsigned Mach-O files,
# even if the outer .app is signed. Tauri signs only Contents/MacOS/<main>;
# every Mach-O listed in tauri.macos.conf.json under bundle.resources that
# ends up as an executable must be signed here, before tauri bundles them.
#
# macOS only. On Linux/Windows exits 0 — those platforms do not require
# OS-level code signing today (Linux updater integrity is covered by Tauri's
# Ed25519 signature). If Windows signing is added (issue #376), a separate
# branch in this script will handle it.
#
# Required env when signing is active:
#   APPLE_SIGNING_IDENTITY — "Developer ID Application: Name (TEAMID)"
# When unset, the script is a no-op (unsigned dev build).

set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  exit 0
fi

if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "APPLE_SIGNING_IDENTITY not set — skipping bundled binary signing (unsigned dev build)"
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# SRC_TAURI can be overridden by tests to point at a sandbox directory.
# In production, this resolves to desktop/src-tauri/ within the repo.
SRC_TAURI="${SRC_TAURI:-$REPO_ROOT/desktop/src-tauri}"
NODE_ENTITLEMENTS="$SRC_TAURI/entitlements/node.plist"
VIRTUALIZATION_ENTITLEMENTS="$SRC_TAURI/entitlements/virtualization.plist"
CALENDARS_ENTITLEMENTS="$SRC_TAURI/entitlements/calendars.plist"
APPLE_EVENTS_ENTITLEMENTS="$SRC_TAURI/entitlements/apple-events.plist"

# Paths that tauri.macos.conf.json copies into .app/Contents/Resources/.
# Source: desktop/src-tauri/tauri.macos.conf.json → bundle.resources.
# Must stay in sync with that file — when a new executable resource is added
# there, add its source path here.
#
# Format: "<source-path>:<entitlements-path>" — entitlements optional.
# Binaries using restricted platform APIs under Hardened Runtime must carry
# entitlements plists to opt back in. See ADR-037 for the full inventory
# (virtualization for limactl, Apple Events for mail/notes CLIs, calendars
# for calendar/reminders CLIs, JIT for Node.js).
SIGN_TARGETS=(
  "$SRC_TAURI/cli/speedwave:"
  "$SRC_TAURI/reminders-cli:$CALENDARS_ENTITLEMENTS"
  "$SRC_TAURI/calendar-cli:$CALENDARS_ENTITLEMENTS"
  "$SRC_TAURI/mail-cli:$APPLE_EVENTS_ENTITLEMENTS"
  "$SRC_TAURI/notes-cli:$APPLE_EVENTS_ENTITLEMENTS"
  "$SRC_TAURI/lima/bin/limactl:$VIRTUALIZATION_ENTITLEMENTS"
  "$SRC_TAURI/nodejs/bin/node:$NODE_ENTITLEMENTS"
)

sign_macho() {
  local path="$1"
  local entitlements="$2"

  if [[ ! -f "$path" ]]; then
    echo "ERROR: expected binary does not exist: $path" >&2
    echo "  If tauri.macos.conf.json added or renamed a resource, update SIGN_TARGETS." >&2
    exit 1
  fi
  if ! file "$path" 2>/dev/null | grep -q "Mach-O"; then
    echo "ERROR: $path is not a Mach-O binary (file reports: $(file "$path"))" >&2
    exit 1
  fi
  if [[ -n "$entitlements" && ! -f "$entitlements" ]]; then
    echo "ERROR: entitlements plist does not exist: $entitlements" >&2
    echo "  Create it under desktop/src-tauri/entitlements/ and reference it in SIGN_TARGETS." >&2
    exit 1
  fi

  if [[ -n "$entitlements" ]]; then
    echo "  signing (with entitlements $entitlements): $path"
    codesign --force \
      --options runtime \
      --timestamp \
      --entitlements "$entitlements" \
      --sign "$APPLE_SIGNING_IDENTITY" \
      "$path"
  else
    echo "  signing: $path"
    codesign --force \
      --options runtime \
      --timestamp \
      --sign "$APPLE_SIGNING_IDENTITY" \
      "$path"
  fi
}

verify_macho() {
  local path="$1"
  local entitlements="$2"

  # codesign -v --strict is the authoritative signature validator. It verifies
  # every resource in the signature, including that the embedded entitlements
  # match the plist passed at signing time.
  if ! codesign -v --strict "$path"; then
    echo "ERROR: signature verification failed for $path" >&2
    exit 1
  fi

  if [[ -z "$entitlements" ]]; then
    echo "  verified: signature valid"
    return
  fi

  # Explicitly cross-check every <key> in the plist against the signed binary's
  # embedded entitlements. This is belt-and-braces — codesign -v --strict should
  # already catch mismatches — but it produces a clearer error if, say, a
  # future codesign version relaxes that check.
  local key_count
  key_count="$(grep -c '<key>' "$entitlements")"
  if [[ "$key_count" -eq 0 ]]; then
    echo "ERROR: entitlements plist $entitlements contains no <key> entries" >&2
    echo "  The plist is malformed, empty, or uses an unexpected format." >&2
    exit 1
  fi

  local ent_stderr
  ent_stderr="$(mktemp "${TMPDIR:-/tmp}/codesign-d.XXXXXX")"
  local ent_output
  if ! ent_output="$(codesign -d --entitlements - "$path" 2>"$ent_stderr")"; then
    echo "ERROR: codesign -d failed for $path:" >&2
    cat "$ent_stderr" >&2
    rm -f "$ent_stderr"
    exit 1
  fi
  rm -f "$ent_stderr"

  local all_verified=true
  while IFS= read -r expected_key; do
    if ! echo "$ent_output" | grep -qF "$expected_key"; then
      echo "ERROR: entitlement '$expected_key' not found in signed binary $path" >&2
      all_verified=false
    fi
  done < <(grep '<key>' "$entitlements" | sed 's/.*<key>\(.*\)<\/key>.*/\1/')
  if [[ "$all_verified" != "true" ]]; then
    exit 1
  fi
  echo "  verified: signature valid, $key_count entitlement(s) present"
}

echo "Signing bundled binaries with $APPLE_SIGNING_IDENTITY"

for entry in "${SIGN_TARGETS[@]}"; do
  path="${entry%%:*}"
  entitlements="${entry#*:}"
  sign_macho "$path" "$entitlements"
  verify_macho "$path" "$entitlements"
done

echo "Bundled binaries signed successfully"
