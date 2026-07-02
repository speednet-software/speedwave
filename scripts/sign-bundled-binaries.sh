#!/usr/bin/env bash
# Signs Mach-O binaries in Speedwave.app/Contents/Resources/ for Apple notarization.
# Requires APPLE_SIGNING_IDENTITY env; no-op on Windows.

set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  exit 0
fi

if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "APPLE_SIGNING_IDENTITY not set — skipping bundled binary signing (unsigned dev build)"
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# SRC_TAURI is overridable by tests; defaults to desktop/src-tauri/.
SRC_TAURI="${SRC_TAURI:-$REPO_ROOT/desktop/src-tauri}"
NODE_ENTITLEMENTS="$SRC_TAURI/entitlements/node.plist"
VIRTUALIZATION_ENTITLEMENTS="$SRC_TAURI/entitlements/virtualization.plist"
CALENDARS_ENTITLEMENTS="$SRC_TAURI/entitlements/calendars.plist"
REMINDERS_ENTITLEMENTS="$SRC_TAURI/entitlements/reminders.plist"
APPLE_EVENTS_ENTITLEMENTS="$SRC_TAURI/entitlements/apple-events.plist"
AUDIO_CAPTURE_ENTITLEMENTS="$SRC_TAURI/entitlements/audio-capture.plist"

# Paths tauri.macos.conf.json copies to .app/Contents/Resources/.
# Source: desktop/src-tauri/tauri.macos.conf.json → bundle.resources (keep in sync).
# Format: "<source-path>:<entitlements-path>" (entitlements optional; see ADR-037).
SIGN_TARGETS=(
  "$SRC_TAURI/cli/speedwave:"
  "$SRC_TAURI/reminders-cli:$REMINDERS_ENTITLEMENTS"
  "$SRC_TAURI/calendar-cli:$CALENDARS_ENTITLEMENTS"
  "$SRC_TAURI/mail-cli:$APPLE_EVENTS_ENTITLEMENTS"
  "$SRC_TAURI/notes-cli:$APPLE_EVENTS_ENTITLEMENTS"
  "$SRC_TAURI/audio-capture-cli:$AUDIO_CAPTURE_ENTITLEMENTS"
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

  # codesign -v --strict is the authoritative validator.
  if ! codesign -v --strict "$path"; then
    echo "ERROR: signature verification failed for $path" >&2
    exit 1
  fi

  if [[ -z "$entitlements" ]]; then
    echo "  verified: signature valid"
    return
  fi

  # Cross-check plist keys against the binary's embedded entitlements.
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

# Verifies the Mach-O's CFBundleIdentifier matches the __info_plist section.
# Only for native macOS CLIs with TCC bindings (others use fixed or no identifiers).
verify_identifier() {
  local path="$1"
  local expected="$2"

  local actual
  actual="$(codesign -dvvv "$path" 2>&1 | grep -E '^Identifier=' | head -1 | cut -d'=' -f2)"
  if [[ "$actual" != "$expected" ]]; then
    echo "ERROR: $path codesign Identifier='$actual', expected '$expected'" >&2
    echo "  The embedded CFBundleIdentifier is wrong (or missing). Check that" >&2
    echo "  native/macos/<svc>/Resources/Info.plist has CFBundleIdentifier=$expected" >&2
    echo "  and that scripts/build-native-macos.sh ran the linker with" >&2
    echo "  -sectcreate __TEXT __info_plist Resources/Info.plist." >&2
    exit 1
  fi
  echo "  verified: identifier=$expected"
}

# Maps SRC_TAURI-relative basename to expected sub-identifier. Empty value
# means no identifier check (e.g. speedwave, limactl, node).
get_expected_identifier() {
  case "$(basename "$1")" in
    calendar-cli) echo "pl.speedwave.desktop.calendar" ;;
    reminders-cli) echo "pl.speedwave.desktop.reminders" ;;
    mail-cli) echo "pl.speedwave.desktop.mail" ;;
    notes-cli) echo "pl.speedwave.desktop.notes" ;;
    audio-capture-cli) echo "pl.speedwave.desktop.audio-capture" ;;
    *) echo "" ;;
  esac
}

echo "Signing bundled binaries with $APPLE_SIGNING_IDENTITY"

for entry in "${SIGN_TARGETS[@]}"; do
  path="${entry%%:*}"
  entitlements="${entry#*:}"
  sign_macho "$path" "$entitlements"
  verify_macho "$path" "$entitlements"
  expected_id="$(get_expected_identifier "$path")"
  if [[ -n "$expected_id" ]]; then
    verify_identifier "$path" "$expected_id"
  fi
done

echo "Bundled binaries signed successfully"
