#!/usr/bin/env bats
# Drift guards for the meeting-transcription bundle wiring (ADR-056).

REPO_ROOT="$BATS_TEST_DIRNAME/../.."
MACOS_CONF="$REPO_ROOT/desktop/src-tauri/tauri.macos.conf.json"
SIGN_SCRIPT="$REPO_ROOT/scripts/sign-bundled-binaries.sh"
ENTITLEMENTS="$REPO_ROOT/desktop/src-tauri/entitlements/audio-capture.plist"
LICENSES_STATIC="$REPO_ROOT/desktop/src-tauri/licenses-static"
MAKEFILE="$REPO_ROOT/Makefile"

@test "audio-capture-cli is a bundle resource on macOS" {
    run python3 -c "
import json
c = json.load(open('$MACOS_CONF'))
res = c.get('bundle', {}).get('resources', {})
assert 'audio-capture-cli' in res, f'audio-capture-cli not in macOS bundle resources: {list(res)}'
"
    [ "$status" -eq 0 ]
}

@test "audio-capture-cli has a SIGN_TARGETS entry with the audio-capture entitlement" {
    grep -qF 'audio-capture-cli:$AUDIO_CAPTURE_ENTITLEMENTS' "$SIGN_SCRIPT" || \
    grep -qF 'audio-capture-cli:$SRC_TAURI/entitlements/audio-capture.plist' "$SIGN_SCRIPT"
}

@test "sign-bundled-binaries defines AUDIO_CAPTURE_ENTITLEMENTS pointing at the plist" {
    grep -qF 'AUDIO_CAPTURE_ENTITLEMENTS="$SRC_TAURI/entitlements/audio-capture.plist"' "$SIGN_SCRIPT"
}

@test "sign-bundled-binaries knows the audio-capture sub-identifier" {
    grep -qF 'pl.speedwave.desktop.audio-capture' "$SIGN_SCRIPT"
}

@test "audio-capture entitlements plist exists and grants only audio-input" {
    [ -f "$ENTITLEMENTS" ]
    run python3 - "$ENTITLEMENTS" <<'PY'
import plistlib, sys
d = plistlib.load(open(sys.argv[1], "rb"))
assert d == {"com.apple.security.device.audio-input": True}, f"unexpected entitlements: {d}"
PY
    [ "$status" -eq 0 ]
}

@test "static transcription licenses are present in licenses-static/" {
    for f in whisper-cpp-LICENSE sherpa-onnx-LICENSE onnxruntime-LICENSE cpal-LICENSE transcription-models-LICENSE; do
        [ -f "$LICENSES_STATIC/$f" ] || { echo "Missing $LICENSES_STATIC/$f" >&2; return 1; }
    done
}

@test "Makefile has a bundle-static-licenses target wired into build-tauri" {
    grep -qE '^bundle-static-licenses:' "$MAKEFILE"
    # build-tauri must invoke bundle-static-licenses.
    grep -qF 'bundle-static-licenses' "$MAKEFILE"
}

@test "build-native-macos and bundle-native-assets include the audio-capture package" {
    grep -qF 'audio-capture' "$REPO_ROOT/scripts/build-native-macos.sh"
    grep -qF 'audio-capture' "$REPO_ROOT/scripts/bundle-native-assets.sh"
}

@test "verify-bundled-assets requires audio-capture-cli on macOS" {
    grep -qF 'audio-capture-cli' "$REPO_ROOT/scripts/verify-bundled-assets.sh"
}

@test "audio-capture-cli has a stub in create-desktop-stubs.sh" {
    grep -qF 'audio-capture-cli' "$REPO_ROOT/scripts/create-desktop-stubs.sh"
}
