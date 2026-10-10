#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"

@test ".husky directory is gone" {
    [ ! -e "$REPO_ROOT/.husky" ]
}

@test ".husky is not tracked by git" {
    run git -C "$REPO_ROOT" ls-files -- .husky
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test ".lintstagedrc.json is gone" {
    [ ! -e "$REPO_ROOT/.lintstagedrc.json" ]
}

@test "package.json has no prepare script and no husky or lint-staged devDependency" {
    run grep -c '"prepare"' "$REPO_ROOT/package.json"
    [ "$output" = "0" ]
    run grep -cE '"(husky|lint-staged)"' "$REPO_ROOT/package.json"
    [ "$output" = "0" ]
}

@test "package-lock.json has no husky or lint-staged package entries" {
    run grep -cE 'node_modules/(husky|lint-staged)"' "$REPO_ROOT/package-lock.json"
    [ "$output" = "0" ]
    run grep -cE '"(husky|lint-staged)": "\^' "$REPO_ROOT/package-lock.json"
    [ "$output" = "0" ]
}

@test "package-lock.json is valid JSON after the edit" {
    run node -e "JSON.parse(require('fs').readFileSync('$REPO_ROOT/package-lock.json', 'utf8'))"
    [ "$status" -eq 0 ]
}

@test "Makefile has no install-hooks target and no husky invocation" {
    run grep -c '^install-hooks:' "$REPO_ROOT/Makefile"
    [ "$output" = "0" ]
    run grep -c 'husky' "$REPO_ROOT/Makefile"
    [ "$output" = "0" ]
    run grep -c 'install-hooks' "$REPO_ROOT/Makefile"
    [ "$output" = "0" ]
}

@test "git-workflow.md drops the Git hooks section" {
    run grep -c '^## Git hooks' "$REPO_ROOT/.claude/rules/git-workflow.md"
    [ "$output" = "0" ]
    run grep -ciE '\.husky|lint-staged|HUSKY=0' "$REPO_ROOT/.claude/rules/git-workflow.md"
    [ "$output" = "0" ]
}

@test "commands.md no longer calls make check-fmt the pre-push hook gate" {
    run grep -c 'pre-push hook' "$REPO_ROOT/.claude/rules/commands.md"
    [ "$output" = "0" ]
    run grep -c '^install-hooks' "$REPO_ROOT/.claude/rules/commands.md"
    [ "$output" = "0" ]
}

@test "CONTRIBUTING.md no longer claims a git hook validates commits or gates push" {
    run grep -c 'pre-push' "$REPO_ROOT/CONTRIBUTING.md"
    [ "$output" = "0" ]
    run grep -c 'via a git hook' "$REPO_ROOT/CONTRIBUTING.md"
    [ "$output" = "0" ]
}

@test "repo CLAUDE.md no longer mentions the pre-push hook and gains the pre-commit-check rule" {
    run grep -c 'pre-push hook' "$REPO_ROOT/CLAUDE.md"
    [ "$output" = "0" ]
    run grep -c 'make check-fmt' "$REPO_ROOT/CLAUDE.md"
    [ "$output" -ge 1 ]
}
