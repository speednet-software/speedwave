#!/usr/bin/env bash

_LOCK_CLEANUP=""
acquire_lock() {
  local dir="$1" holder
  while ! mkdir "$dir" 2>/dev/null; do
    holder="$(cat "$dir/pid" 2>/dev/null || true)"
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
      rm -rf "$dir"
      continue
    fi
    sleep 0.3
  done
  _LOCK_CLEANUP="rm -rf '$dir' 2>/dev/null || true; $_LOCK_CLEANUP"
  trap 'eval "$_LOCK_CLEANUP"' EXIT INT TERM
  echo "$$" >"$dir/pid"
}
