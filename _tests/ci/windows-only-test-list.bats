#!/usr/bin/env bats
# Drift guard: every Windows-cfg-gated #[test] in desktop/src-tauri/src must be
# named in test.yml's windows-only cargo invocation, or it silently never runs.

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/test.yml"
DESKTOP_SRC="$REPO_ROOT/desktop/src-tauri/src"

# Test names passed after `--` to the windows-only cargo test invocation.
_workflow_windows_test_names() {
    awk '
        /cargo test speedwave-desktop \(windows-only\)/ { found=1 }
        found && /cargo test --bins --/ { capture=1; next }
        capture && /^\s*run:/ { next }
        capture && /^\s*$/ { next }
        capture && /^[[:space:]]*#/ { next }
        capture && /^      - name:/ { exit }
        capture { gsub(/^[ \t]+|[ \t]+$/, ""); if ($0) print }
    ' "$WORKFLOW"
}

# #[test] fns excluded from non-Windows compilation: cfg directly on the fn,
# or on an enclosing mod — never a cfg on an unrelated sibling item.
_crate_windows_only_test_names() {
    python3 - "$DESKTOP_SRC" <<'PY'
import re
import sys
from pathlib import Path

windows_cfg = re.compile(r'^\s*#!?\[cfg\(\s*(target_os\s*=\s*"windows"|windows)\s*\)\]\s*$')
attr_line = re.compile(r'^\s*#!?\[[^]]*\]\s*$')
test_attr = re.compile(r'^\s*#\[test\]\s*$')
fn_decl = re.compile(r'^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*\(')
mod_decl = re.compile(r'^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*\{')

def preceding_attr_chain(lines, idx):
    """Attribute lines directly above lines[idx] (contiguous, no blank/code gap)."""
    j = idx - 1
    chain = []
    while j >= 0 and attr_line.match(lines[j]):
        chain.append(lines[j])
        j -= 1
    return chain

def is_windows_gated(lines, idx):
    return any(windows_cfg.match(a) for a in preceding_attr_chain(lines, idx))

names = set()

for path in Path(sys.argv[1]).rglob("*.rs"):
    lines = path.read_text(encoding="utf-8").splitlines()
    n = len(lines)

    # Directly-gated: cfg in the attribute chain preceding a #[test] fn.
    for i, line in enumerate(lines):
        m = fn_decl.match(line)
        if not m:
            continue
        chain = preceding_attr_chain(lines, i)
        if any(test_attr.match(a) for a in chain) and any(
            windows_cfg.match(a) for a in chain
        ):
            names.add(m.group(1))

    # mod-gated: every #[test] fn inside a windows-cfg'd `mod NAME { ... }`.
    for i, line in enumerate(lines):
        if not mod_decl.match(line):
            continue
        if not is_windows_gated(lines, i):
            continue
        brace_count = 0
        block = []
        k = i
        while k < n:
            block.append(lines[k])
            brace_count += lines[k].count("{") - lines[k].count("}")
            if brace_count == 0 and "{" in "".join(block):
                break
            k += 1
        block_text = "\n".join(block)
        for fn in re.findall(r'#\[test\]\s*\n\s*fn\s+(\w+)', block_text):
            names.add(fn)

for name in sorted(names):
    print(name)
PY
}

@test "every Windows-cfg-gated test in desktop crate is named in the workflow's windows-only invocation" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"

    mapfile -t workflow_names < <(_workflow_windows_test_names)
    mapfile -t crate_names < <(_crate_windows_only_test_names)

    [ "${#crate_names[@]}" -gt 0 ]

    missing=()
    for name in "${crate_names[@]}"; do
        found=0
        for wf in "${workflow_names[@]}"; do
            if [ "$wf" = "$name" ]; then
                found=1
                break
            fi
        done
        if [ "$found" -eq 0 ]; then
            missing+=("$name")
        fi
    done

    if [ "${#missing[@]}" -ne 0 ]; then
        echo "Windows-cfg-gated tests missing from .github/workflows/test.yml windows-only invocation:"
        printf '  %s\n' "${missing[@]}"
        return 1
    fi
}

@test "workflow windows-only test list is non-empty" {
    mapfile -t workflow_names < <(_workflow_windows_test_names)
    [ "${#workflow_names[@]}" -gt 0 ]
}
