#!/bin/bash
# Clipboard wrapper (ADR-052). Five symlinks (pbcopy/xclip/xsel/wl-copy/clip.exe)
# point here; routes by -o/--out/--paste flag presence.
#
# Write: stdin → ~/.clipboard-bridge (Tauri watcher relays to host) + OSC 52 on /dev/tty.
# Read:  serve /workspace/.speedwave/pastes/clip.png to xclip -t TARGETS/-t image/png -o.

set -f

is_read=0
for arg in "$@"; do
    case "$arg" in
        -o|--out|-out|--output|--paste) is_read=1; break ;;
    esac
done

CLIP_FILE="${SPEEDWAVE_CLIP_FILE:-/workspace/.speedwave/pastes/clip.png}"

if [ "$is_read" -eq 1 ]; then
    mime=""
    prev=""
    for arg in "$@"; do
        if [ "$prev" = "-t" ] || [ "$prev" = "--type" ]; then
            mime="$arg"
        fi
        prev="$arg"
    done

    case "$mime" in
        TARGETS|targets)
            if [ -s "$CLIP_FILE" ]; then printf 'image/png\n'; exit 0; fi
            exit 1
            ;;
        image/png|"")
            if [ -s "$CLIP_FILE" ]; then exec cat -- "$CLIP_FILE"; fi
            echo "osc52-copy: no image in host clipboard ($CLIP_FILE)" >&2
            exit 1
            ;;
        *)
            echo "osc52-copy: unsupported read mime '$mime'" >&2
            exit 1
            ;;
    esac
fi

# Write path.
input=$(cat)

bridge="${HOME}/.clipboard-bridge"
tmp="${bridge}.tmp.$$"
if ! printf '%s' "$input" > "$tmp" 2>/dev/null || ! mv "$tmp" "$bridge" 2>/dev/null; then
    echo "osc52-copy: failed to write clipboard bridge file at $bridge" >&2
fi
rm -f "$tmp" 2>/dev/null

encoded=$(printf '%s' "$input" | (base64 -w 0 2>/dev/null || base64))
seq=$'\033]52;c;'"${encoded}"$'\007'
if (exec 9>/dev/tty) 2>/dev/null; then
    printf '%s' "$seq" > /dev/tty
fi

exit 0
