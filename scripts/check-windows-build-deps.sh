#!/usr/bin/env bash
# Reports the Windows-only desktop build prerequisites (ADR-085). Advisory by design: the
# hard gates live in `make dev` (stage-vulkan-windows) and whisper-rs-sys's own build script,
# so CLI-only work is never blocked on the Vulkan toolchain.

set -uo pipefail

case "$(uname -s 2>/dev/null)" in
  MINGW* | MSYS* | CYGWIN*) ;;
  *)
    echo "  ⬚  skipped (not Windows)"
    exit 0
    ;;
esac

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

if [ -n "${VULKAN_SDK:-}" ] && [ -d "${VULKAN_SDK:-}" ]; then
  echo "  ✅ VULKAN_SDK $VULKAN_SDK"
else
  echo "  ⬚  VULKAN_SDK unset (whisper-rs-sys needs it for make dev / desktop builds)"
  echo "     Install: make setup-dev-windows, then open a NEW Git Bash"
fi

if command -v ninja >/dev/null 2>&1; then
  echo "  ✅ ninja $(ninja --version)"
else
  echo "  ⬚  ninja not found (CMAKE_GENERATOR=Ninja needs it for whisper-rs-sys)"
  echo "     Install: make setup-dev-windows"
fi

if [ -n "${INCLUDE:-}" ] && [ -n "${LIB:-}" ] && [ "${CMAKE_GENERATOR:-}" = "Ninja" ]; then
  echo "  ✅ MSVC env + CMAKE_GENERATOR (via ~/msvc-env.sh)"
else
  echo "  ⬚  ~/msvc-env.sh not visible in this shell (INCLUDE/LIB/CMAKE_GENERATOR unset)"
  echo "     Open a NEW Git Bash after make setup-dev-windows"
fi

# Print the gate's own verdict: it also fails when the target dir cannot be resolved at all,
# which is a different diagnosis from "too deep".
budget_out="$(bash "$repo_root/scripts/check-vulkan-path-budget.sh" 2>&1)" || true
printf '%s\n' "$budget_out" | sed 's/^/  /'
