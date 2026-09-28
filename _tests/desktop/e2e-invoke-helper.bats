#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
E2E_DIR="$REPO_ROOT/desktop/e2e"

_script_result_error_keys() {
    python3 - "$1" <<'EOF'
import pathlib, re, sys

call = re.compile(r"\b(?:done|execute|executeAsync)\s*\(")
key = re.compile(r"[{,]\s*(error|stacktrace|stackTrace)\s*[:,}]")
root = pathlib.Path(sys.argv[1])
calls = 0
hits = set()
for path in sorted(root.rglob("*.ts")):
    if "node_modules" in path.parts:
        continue
    text = path.read_text()
    for m in call.finditer(text):
        depth, end = 0, m.end() - 1
        while end < len(text):
            depth += {"(": 1, ")": -1}.get(text[end], 0)
            if depth == 0:
                break
            end += 1
        calls += 1
        for hit in key.finditer(text[m.start() : end + 1]):
            line = text.count("\n", 0, m.start() + hit.start(1)) + 1
            hits.add((str(path.relative_to(root)), line, hit.group(1)))
for file, line, name in sorted(hits):
    print(f"{file}:{line}: {name}")
print(f"calls={calls}")
EOF
}

@test "no object an e2e script hands back to WebDriver carries an error key" {
    run _script_result_error_keys "$E2E_DIR"

    [ "$status" -eq 0 ]
    hits="$(printf '%s\n' "$output" | grep -v '^calls=' || true)"
    if [ -n "$hits" ]; then
        echo "WebdriverIO reads a script result whose value has an error, stacktrace or stackTrace"
        echo "key as a W3C WebDriver error response (webdriver isSuccessfulResponse) and throws"
        echo "WebDriverError instead of returning it; carry a failure under another key, e.g. reason:"
        echo "$hits"
        return 1
    fi
    calls="$(printf '%s\n' "$output" | sed -n 's/^calls=//p')"
    [ "$calls" -ge 3 ]
}

@test "the check flags an error key in a done payload, an execute result and a shorthand" {
    mkdir -p "$BATS_TEST_TMPDIR/bad"
    cat >"$BATS_TEST_TMPDIR/bad/helper.ts" <<'EOF'
browser.executeAsync((cmd, done) => {
  run(cmd).catch((e: unknown) => done({ ok: false, error: String(e) }));
});
const ui = browser.execute(() => ({
  overlay: true,
  stacktrace: document.title,
}));
const error = 'x';
done({ ok: false, error });
EOF

    run _script_result_error_keys "$BATS_TEST_TMPDIR/bad"

    [ "$status" -eq 0 ]
    [ "$(printf '%s\n' "$output" | grep -c ': \(error\|stacktrace\)$')" -eq 3 ]
    [[ "$output" == *"helper.ts:2: error"* ]]
    [[ "$output" == *"helper.ts:6: stacktrace"* ]]
    [[ "$output" == *"helper.ts:9: error"* ]]
}

@test "the check leaves a reason key and an error parameter alone" {
    mkdir -p "$BATS_TEST_TMPDIR/good"
    cat >"$BATS_TEST_TMPDIR/good/helper.ts" <<'EOF'
browser.executeAsync((cmd, done) => {
  run(cmd).catch((error: unknown) => done({ ok: false, reason: String(error) }));
});
EOF

    run _script_result_error_keys "$BATS_TEST_TMPDIR/good"

    [ "$status" -eq 0 ]
    [ "$output" = "calls=2" ]
}
