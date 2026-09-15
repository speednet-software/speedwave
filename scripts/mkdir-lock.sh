#!/usr/bin/env bash
# mkdir-lock.sh — acquire_lock, sourced by bundle-build-context.sh and crates/pii-engine-wasm/build-wasm.sh
# so every writer of a wasm out dir waits on the same .wasm-build.lock beside it.

# acquire_lock <dir>: mkdir-based mutex, atomic cross-platform; a lock whose holder PID is
# dead is reclaimed. Arms trap before PID write to prevent deadlock if PID write fails.
_LOCK_CLEANUP=""
acquire_lock() {
  local dir="$1" holder
  while ! mkdir "$dir" 2>/dev/null; do
    holder="$(cat "$dir/pid" 2>/dev/null || true)"
    # Reclaim only when we can prove the holder is gone; a blank PID means the owner is
    # mid-acquiring — treat as alive and wait rather than delete it.
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
      rm -rf "$dir"  # holder process is dead — reclaim the stale lock
      continue
    fi
    sleep 0.3
  done
  # Trap exits before PID write: mkdir succeeded, lock is ours. Stack cleanup commands.
  _LOCK_CLEANUP="rm -rf '$dir' 2>/dev/null || true; $_LOCK_CLEANUP"
  trap 'eval "$_LOCK_CLEANUP"' EXIT INT TERM
  echo "$$" >"$dir/pid"
}
