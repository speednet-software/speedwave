#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/prepend-changelog-entry.sh"

setup() {
  WORK="$BATS_TEST_TMPDIR/work"
  git init -q "$WORK"
  git -C "$WORK" config user.name t
  git -C "$WORK" config user.email t@t
  cd "$WORK"
}

_seed_changelog() {
  cat > CHANGELOG.md <<'EOF'
# Changelog

## [0.1.0](https://example.com/compare/a...b) (2020-01-01)

- old entry
EOF
}

@test "entry lands at the top and existing content is preserved" {
  _seed_changelog
  run bash -c "printf 'first note\nsecond note\n' | bash \"$SCRIPT\" 0.2.0 https://example.com/compare/b...c"
  [ "$status" -eq 0 ]

  [ "$(head -n 1 CHANGELOG.md)" = "# Changelog" ]
  grep -qF '## [0.2.0](https://example.com/compare/b...c)' CHANGELOG.md
  grep -qF 'first note' CHANGELOG.md
  grep -qF 'second note' CHANGELOG.md
  grep -qF '## [0.1.0](https://example.com/compare/a...b) (2020-01-01)' CHANGELOG.md
  grep -qF -- '- old entry' CHANGELOG.md

  new_line="$(grep -n '## \[0.2.0\]' CHANGELOG.md | cut -d: -f1)"
  old_line="$(grep -n '## \[0.1.0\]' CHANGELOG.md | cut -d: -f1)"
  [ "$new_line" -lt "$old_line" ]

  [ "$(git log -1 --pretty=%s)" = "chore(release): changelog 0.2.0" ]
}

@test "missing CHANGELOG.md fails without creating a commit" {
  run bash -c "printf 'note\n' | bash \"$SCRIPT\" 0.2.0 https://example.com/compare/b...c"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "CHANGELOG.md" ]]
  [ ! -f CHANGELOG.md ]
  run git log -1
  [ "$status" -ne 0 ]
}

@test "missing version argument fails with the usage message" {
  run bash -c "printf 'note\n' | bash \"$SCRIPT\""
  [ "$status" -ne 0 ]
  [[ "$output" =~ "usage: prepend-changelog-entry.sh" ]]
}

@test "missing compare-url argument fails with the usage message" {
  run bash -c "printf 'note\n' | bash \"$SCRIPT\" 0.2.0"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "usage: prepend-changelog-entry.sh" ]]
}
