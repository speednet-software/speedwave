#!/bin/bash
# Clipboard wrapper — five symlinks (pbcopy/xclip/xsel/wl-copy/clip.exe)
# point here. Two channels (both write-only):
#   1. Bridge file: stdin → ~/.clipboard-bridge (Tauri watches and copies to
#      host clipboard). Works in any terminal.
#   2. OSC 52: emits ESC]52;c;<base64>BEL on /dev/tty for terminals that honor
#      it (iTerm2, Alacritty, Windows Terminal, etc.). No-op on Apple Terminal.
# See ADR-051.

set -f

input=$(cat)

# Channel 1: bridge file (atomic write via temp + mv).
bridge="${HOME}/.clipboard-bridge"
tmp="${bridge}.tmp.$$"
printf '%s' "$input" > "$tmp" 2>/dev/null && mv "$tmp" "$bridge" 2>/dev/null
rm -f "$tmp" 2>/dev/null

# Channel 2: OSC 52 on TTY.
encoded=$(printf '%s' "$input" | (base64 -w 0 2>/dev/null || base64))
seq=$'\033]52;c;'"${encoded}"$'\007'
if (exec 9>/dev/tty) 2>/dev/null; then
    printf '%s' "$seq" > /dev/tty
fi

exit 0
