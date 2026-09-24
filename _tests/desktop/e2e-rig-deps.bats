#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
PKG="$REPO_ROOT/desktop/e2e/package.json"
LOCK="$REPO_ROOT/desktop/e2e/package-lock.json"

@test "extract-zip is not installed anywhere in the e2e rig tree" {
    python3 -c "
import json, sys
with open('$LOCK') as f:
    lock = json.load(f)
bad = [k for k in lock['packages'] if k.split('/')[-1] == 'extract-zip']
if bad:
    print('extract-zip resolved in the lockfile:', bad)
    sys.exit(1)
"
}

@test "package.json overrides pin @puppeteer/browsers to an extract-zip-free major" {
    python3 -c "
import json, re, sys
with open('$PKG') as f:
    pkg = json.load(f)
spec = pkg.get('overrides', {}).get('@puppeteer/browsers', '')
if not re.match(r'\^?([3-9]|[1-9][0-9])\.', spec):
    print('overrides[@puppeteer/browsers] missing or allows 2.x:', repr(spec))
    sys.exit(1)
"
}

@test "no @puppeteer/browsers 2.x resolves in the lockfile" {
    python3 -c "
import json, sys
with open('$LOCK') as f:
    lock = json.load(f)
bad = {k: v.get('version') for k, v in lock['packages'].items()
       if k.split('/')[-1] == 'browsers' and '@puppeteer' in k
       and v.get('version', '').startswith('2.')}
if bad:
    print('@puppeteer/browsers 2.x resolved in the lockfile:', bad)
    sys.exit(1)
"
}
