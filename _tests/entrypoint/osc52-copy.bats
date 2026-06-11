#!/usr/bin/env bats
# Tests for containers/osc52-copy.sh — host-side, no container required.
# Wrapper has two output channels: ~/.clipboard-bridge file (always written)
# and OSC 52 sequence on /dev/tty (TTY-only, skipped under bats).

OSC52="$BATS_TEST_DIRNAME/../../containers/osc52-copy.sh"
CONTAINERFILE="$BATS_TEST_DIRNAME/../../containers/Containerfile.claude"

setup() {
    TMP_HOME=$(mktemp -d)
    BRIDGE="$TMP_HOME/.clipboard-bridge"
}

teardown() {
    rm -rf "$TMP_HOME"
}

# ── Bridge file channel (verified everywhere) ───────────────────────────────

@test "writes stdin to ~/.clipboard-bridge" {
    run bash -c "printf 'hello' | HOME='$TMP_HOME' bash '$OSC52'"
    [ "$status" -eq 0 ]
    [ -f "$BRIDGE" ]
    [ "$(cat "$BRIDGE")" = "hello" ]
}

@test "round-trips OAuth-shaped URL (~300 bytes) byte-faithfully" {
    local url="https://claude.ai/oauth/authorize?client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=DEADBEEF_abcdefghij_1234567890&code_challenge_method=S256&state=xyz"
    run bash -c "printf '%s' '$url' | HOME='$TMP_HOME' bash '$OSC52'"
    [ "$status" -eq 0 ]
    [ "$(cat "$BRIDGE")" = "$url" ]
}

@test "empty stdin produces empty bridge file, exit 0" {
    run bash -c "HOME='$TMP_HOME' bash '$OSC52' < /dev/null"
    [ "$status" -eq 0 ]
    [ -f "$BRIDGE" ]
    [ -z "$(cat "$BRIDGE")" ]
}

@test "exit 0 when /dev/tty is not writable" {
    run bash -c "echo test | HOME='$TMP_HOME' bash '$OSC52' 2>/dev/null"
    [ "$status" -eq 0 ]
}

@test "UTF-8 input is byte-faithful" {
    local payload="żółć"
    run bash -c "printf '%s' '$payload' | HOME='$TMP_HOME' bash '$OSC52'"
    [ "$status" -eq 0 ]
    [ "$(cat "$BRIDGE")" = "$payload" ]
}

@test "8 KB payload round-trips" {
    local payload
    payload=$(printf 'A%.0s' {1..8192})
    [ "${#payload}" -eq 8192 ]
    run bash -c "printf '%s' '$payload' | HOME='$TMP_HOME' bash '$OSC52'"
    [ "$status" -eq 0 ]
    local actual_len
    actual_len=$(wc -c < "$BRIDGE" | tr -d ' ')
    [ "$actual_len" -eq 8192 ]
}

@test "atomic write — temp file is removed on success" {
    run bash -c "printf 'hello' | HOME='$TMP_HOME' bash '$OSC52'"
    [ "$status" -eq 0 ]
    # No leftover .tmp.* files
    local leftovers
    leftovers=$(ls "$TMP_HOME"/.clipboard-bridge.tmp.* 2>/dev/null | wc -l | tr -d ' ')
    [ "$leftovers" -eq 0 ]
}

@test "second write overwrites first" {
    bash -c "printf 'first' | HOME='$TMP_HOME' bash '$OSC52'"
    bash -c "printf 'second' | HOME='$TMP_HOME' bash '$OSC52'"
    [ "$(cat "$BRIDGE")" = "second" ]
}

# ── Claude Code ≥2.1.161 write argv shapes (each must hit the write path) ───

@test "wl-copy --primary writes stdin to the bridge" {
    run bash -c "printf 'primary-sel' | HOME='$TMP_HOME' bash '$OSC52' --primary"
    [ "$status" -eq 0 ]
    [ "$(cat "$BRIDGE")" = "primary-sel" ]
}

@test "xclip -selection clipboard (no -o) writes stdin to the bridge" {
    run bash -c "printf 'clip-sel' | HOME='$TMP_HOME' bash '$OSC52' -selection clipboard"
    [ "$status" -eq 0 ]
    [ "$(cat "$BRIDGE")" = "clip-sel" ]
}

@test "xclip -selection primary (no -o) writes stdin to the bridge" {
    run bash -c "printf 'xprim' | HOME='$TMP_HOME' bash '$OSC52' -selection primary"
    [ "$status" -eq 0 ]
    [ "$(cat "$BRIDGE")" = "xprim" ]
}

@test "xsel --primary --input writes stdin to the bridge" {
    run bash -c "printf 'xsel-prim' | HOME='$TMP_HOME' bash '$OSC52' --primary --input"
    [ "$status" -eq 0 ]
    [ "$(cat "$BRIDGE")" = "xsel-prim" ]
}

@test "xsel --clipboard --input writes stdin to the bridge" {
    run bash -c "printf 'xsel-clip' | HOME='$TMP_HOME' bash '$OSC52' --clipboard --input"
    [ "$status" -eq 0 ]
    [ "$(cat "$BRIDGE")" = "xsel-clip" ]
}

# ── powershell.exe interop (Claude Code platform "wsl" on Windows hosts) ────

@test "powershell.exe Set-Clipboard command writes stdin to the bridge" {
    local ps='[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())'
    run bash -c "printf 'ps-copy' | HOME='$TMP_HOME' bash '$OSC52' -NoProfile -NonInteractive -Command \"\$0\"" "$ps"
    [ "$status" -eq 0 ]
    [ "$(cat "$BRIDGE")" = "ps-copy" ]
}

@test "powershell.exe Get-Clipboard command exits 1 without touching the bridge" {
    printf 'before' > "$BRIDGE"
    local ps='[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Raw'
    run bash -c "HOME='$TMP_HOME' bash '$OSC52' -NoProfile -NonInteractive -Command \"\$0\" </dev/null" "$ps"
    [ "$status" -eq 1 ]
    [ -z "$output" ]
    [ "$(cat "$BRIDGE")" = "before" ]
}

@test "powershell.exe ContainsImage probe exits 1 (no false-positive image)" {
    # The WSL image-check chain falls back to powershell after xclip; a 0 exit
    # with no payload would make Claude treat an empty clipboard as an image.
    run bash -c "HOME='$TMP_HOME' bash '$OSC52' -NoProfile -Command 'ContainsImage check' </dev/null"
    [ "$status" -eq 1 ]
    [ -z "$output" ]
}

@test "command mentioning BOTH Set-Clipboard and Get-Clipboard takes the write path" {
    # case patterns are tested per-arg in order: Set-Clipboard precedes the
    # Get-Clipboard arm, so a single -Command token containing both resolves
    # deterministically to a write (a copy command that also names the reader).
    local ps='Set-Clipboard -Value ([Console]::In.ReadToEnd()); Get-Clipboard'
    run bash -c "printf 'both' | HOME='$TMP_HOME' bash '$OSC52' -NoProfile -Command \"\$0\"" "$ps"
    [ "$status" -eq 0 ]
    [ "$(cat "$BRIDGE")" = "both" ]
}

@test "invoking via the powershell.exe symlink name routes Set-Clipboard to write" {
    # Claude Code reaches the shim by name (powershell.exe), not by calling
    # osc52-copy.sh directly — exercise that resolution path, not just the
    # script. A symlink mirrors the image-time `ln -s` in Containerfile.claude.
    local bindir="$TMP_HOME/bin"
    mkdir -p "$bindir"
    ln -s "$OSC52" "$bindir/powershell.exe"
    local ps='Set-Clipboard -Value ([Console]::In.ReadToEnd())'
    run bash -c "printf 'via-symlink' | HOME='$TMP_HOME' '$bindir/powershell.exe' -NoProfile -Command \"\$0\"" "$ps"
    [ "$status" -eq 0 ]
    [ "$(cat "$BRIDGE")" = "via-symlink" ]
}

# ── Containerfile integration ───────────────────────────────────────────────

@test "Containerfile.claude COPYs osc52-copy.sh to /usr/local/bin" {
    grep -q 'COPY --chmod=755 osc52-copy.sh /usr/local/bin/osc52-copy.sh' "$CONTAINERFILE"
}

@test "Containerfile.claude creates symlinks for all six clipboard names" {
    grep -q 'ln -s osc52-copy.sh /usr/local/bin/pbcopy' "$CONTAINERFILE"
    grep -q 'ln -s osc52-copy.sh /usr/local/bin/xclip' "$CONTAINERFILE"
    grep -q 'ln -s osc52-copy.sh /usr/local/bin/xsel' "$CONTAINERFILE"
    grep -q 'ln -s osc52-copy.sh /usr/local/bin/wl-copy' "$CONTAINERFILE"
    grep -q 'ln -s osc52-copy.sh /usr/local/bin/clip.exe' "$CONTAINERFILE"
    grep -q 'ln -s osc52-copy.sh /usr/local/bin/powershell.exe' "$CONTAINERFILE"
}

@test "osc52-copy.sh is installed AFTER the heavy claude COPY layer" {
    # Cache invariant: editing osc52-copy.sh must not invalidate the ~210MB
    # claude binary layer. Verify Dockerfile line order.
    local osc_line claude_line
    osc_line=$(grep -n 'osc52-copy.sh' "$CONTAINERFILE" | head -1 | cut -d: -f1)
    claude_line=$(grep -n 'cp "\$CLAUDE_BIN" /usr/local/bin/claude' "$CONTAINERFILE" | head -1 | cut -d: -f1)
    [ -n "$osc_line" ]
    [ -n "$claude_line" ]
    [ "$osc_line" -gt "$claude_line" ]
}

# ── SSOT cross-check with the host watcher ──────────────────────────────────

@test "bridge filename matches BRIDGE_FILENAME in clipboard_bridge.rs" {
    # The shell wrapper writes ~/.clipboard-bridge; the Rust watcher looks for
    # the same name. If one side is renamed without the other, the bridge
    # silently stops working — this test catches that.
    local rs="$BATS_TEST_DIRNAME/../../desktop/src-tauri/src/clipboard_bridge.rs"
    grep -q 'BRIDGE_FILENAME: &str = ".clipboard-bridge"' "$rs"
    grep -q '\.clipboard-bridge' "$OSC52"
}

# ── Error reporting ─────────────────────────────────────────────────────────

@test "reports a stderr error when the bridge file cannot be written" {
    # HOME points at a path whose parent is not a directory → cannot create
    # ~/.clipboard-bridge. The wrapper must still exit 0 (so Claude's "press c"
    # detection keeps working) but print a diagnostic to stderr.
    local notadir="$TMP_HOME/regular-file"
    printf 'x' > "$notadir"
    run bash -c "printf 'hello' | HOME='$notadir' bash '$OSC52'"
    [ "$status" -eq 0 ]
    [[ "$output" == *"failed to write clipboard bridge file"* ]]
}

# ── Read path (host → container paste, ADR-065) ─────────────────────────────

@test "read -o without clip file → exit 1, empty stdout, stderr message" {
    run bash -c "SPEEDWAVE_CLIP_FILE='$TMP_HOME/clip.png' bash '$OSC52' -o"
    [ "$status" -eq 1 ]
    [[ "$output" == *"no image in host clipboard"* ]]
}

@test "read -t TARGETS -o → emits image/png when clip file exists" {
    printf '\x89PNG\r\n\x1a\n' > "$TMP_HOME/clip.png"
    run bash -c "SPEEDWAVE_CLIP_FILE='$TMP_HOME/clip.png' bash '$OSC52' -t TARGETS -o"
    [ "$status" -eq 0 ]
    [ "$output" = "image/png" ]
}

@test "read -t TARGETS -o → exit 1 when clip file absent" {
    run bash -c "SPEEDWAVE_CLIP_FILE='$TMP_HOME/clip.png' bash '$OSC52' -t TARGETS -o"
    [ "$status" -eq 1 ]
}

@test "read -t image/png -o → cats clip file bytes" {
    printf 'BINARY\x00DATA' > "$TMP_HOME/clip.png"
    local out="$TMP_HOME/out.bin"
    SPEEDWAVE_CLIP_FILE="$TMP_HOME/clip.png" bash "$OSC52" -t image/png -o > "$out"
    cmp -s "$TMP_HOME/clip.png" "$out"
}

@test "read with unsupported mime → exit 1 with diagnostic" {
    run bash -c "SPEEDWAVE_CLIP_FILE='$TMP_HOME/clip.png' bash '$OSC52' -t image/jpeg -o"
    [ "$status" -eq 1 ]
    [[ "$output" == *"unsupported read mime"* ]]
}

@test "read direction does NOT touch ~/.clipboard-bridge" {
    printf 'before' > "$BRIDGE"
    printf 'PNG' > "$TMP_HOME/clip.png"
    bash -c "SPEEDWAVE_CLIP_FILE='$TMP_HOME/clip.png' HOME='$TMP_HOME' bash '$OSC52' -t image/png -o" >/dev/null
    [ "$(cat "$BRIDGE")" = "before" ]
}

@test "xsel-style --output flag is also recognised as read" {
    printf 'PNG' > "$TMP_HOME/clip.png"
    run bash -c "SPEEDWAVE_CLIP_FILE='$TMP_HOME/clip.png' bash '$OSC52' --output"
    [ "$status" -eq 0 ]
    [ "$output" = "PNG" ]
}

@test "cat uses -- delimiter so dash-prefixed CLIP_FILE is not parsed as option" {
    # Adversarial CLIP_FILE override: filename starts with `-`. Without
    # `cat -- "$file"` this would be interpreted as an unknown cat option.
    local f="$TMP_HOME/-rfile"
    printf 'OK' > "$f"
    run bash -c "SPEEDWAVE_CLIP_FILE='$f' bash '$OSC52' -t image/png -o"
    [ "$status" -eq 0 ]
    [ "$output" = "OK" ]
}

# ── Security ────────────────────────────────────────────────────────────────

@test "script has no curl, wget, secrets, or anthropic touchpoints" {
    ! grep -qE '\bcurl\b|\bwget\b|/tokens|\.credentials\.json|api\.anthropic' "$OSC52"
}

@test "script does not query terminal via OSC 52 ?" {
    ! grep -qE '52;c;\?' "$OSC52"
}

@test "script does not source any external file" {
    ! grep -qE '^\s*source\b|^\s*\.\s' "$OSC52"
}
