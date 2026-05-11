#!/bin/bash
# Clipboard wrapper — five symlinks (pbcopy/xclip/xsel/wl-copy/clip.exe)
# point here. Two channels (both write-only):
#   1. Bridge file: stdin → ~/.clipboard-bridge (the Tauri desktop process
#      watches it and copies to the host clipboard). Works in any terminal.
#      NOTE: the filename ".clipboard-bridge" must match BRIDGE_FILENAME in
#      desktop/src-tauri/src/clipboard_bridge.rs (cross-checked by a test in
#      _tests/entrypoint/osc52-copy.bats).
#   2. OSC 52: emits ESC]52;c;<base64>BEL on /dev/tty for terminals that honor
#      it (iTerm2, Alacritty, Windows Terminal, etc.). No-op on Apple Terminal.
# Errors on either channel are reported to stderr (Claude Code shows it in the
# TTY) but the script always exits 0 so Claude's "press c" detection keeps
# working. See ADR-052.

# `set -f` disables filename globbing so the base64 blob and the raw input are
# never expanded as shell patterns.
set -f

input=$(cat)

# Channel 1: bridge file (atomic write via temp + mv).
bridge="${HOME}/.clipboard-bridge"
tmp="${bridge}.tmp.$$"
if ! printf '%s' "$input" > "$tmp" 2>/dev/null || ! mv "$tmp" "$bridge" 2>/dev/null; then
    echo "osc52-copy: failed to write clipboard bridge file at $bridge" >&2
fi
rm -f "$tmp" 2>/dev/null

# Channel 2: OSC 52 on TTY.
encoded=$(printf '%s' "$input" | (base64 -w 0 2>/dev/null || base64))
seq=$'\033]52;c;'"${encoded}"$'\007'
if (exec 9>/dev/tty) 2>/dev/null; then
    printf '%s' "$seq" > /dev/tty
fi

exit 0
