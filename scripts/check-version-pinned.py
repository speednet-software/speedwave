#!/usr/bin/env python3
import argparse
import json
import os
import pathlib
import re
import sys

PINNED_VERSION = "0.0.0"

PINNED_JSON_FILES = (
    "package.json",
    "desktop/src/package.json",
    "desktop/src-tauri/tauri.conf.json",
    "desktop/src/package-lock.json",
    "mcp-servers/hub/package.json",
    "mcp-servers/shared/package.json",
    "mcp-servers/policies/package.json",
    "mcp-servers/slack/package.json",
    "mcp-servers/sharepoint/package.json",
    "mcp-servers/redmine/package.json",
    "mcp-servers/gitlab/package.json",
    "mcp-servers/github/package.json",
    "mcp-servers/atlassian/package.json",
    "mcp-servers/office/package.json",
    "mcp-servers/os/package.json",
    "mcp-servers/oauth/package.json",
    "mcp-servers/context7/package.json",
    "mcp-servers/playwright/package.json",
)

PINNED_TOML_FILES = (
    "crates/speedwave-runtime/Cargo.toml",
    "crates/speedwave-cli/Cargo.toml",
    "desktop/src-tauri/Cargo.toml",
)

PINNED_GENERIC_FILES = (
    "native/macos/calendar/Resources/Info.plist",
    "native/macos/reminders/Resources/Info.plist",
    "native/macos/mail/Resources/Info.plist",
    "native/macos/notes/Resources/Info.plist",
    "native/macos/audio-capture/Resources/Info.plist",
)

STANDALONE_PINNED_TOML_FILES = ("crates/speedwave-version/Cargo.toml",)


def _check_toml_path(
    root: pathlib.Path,
    rel_path: str,
    display_path: pathlib.Path,
    errors: list[str],
) -> None:
    try:
        content = (root / rel_path).read_text()
    except (OSError, UnicodeDecodeError) as e:
        errors.append(f"{display_path}: read error: {e}")
        return
    pkg = re.search(r"\[package\](.*?)(?:\n\[|\Z)", content, re.DOTALL)
    if not pkg:
        errors.append(f"{display_path}: no [package] section found")
        return
    m = re.search(r'^version\s*=\s*"([^"]*)"', pkg.group(1), re.MULTILINE)
    if not m:
        errors.append(f"{display_path}: no version field in [package]")
        return
    actual = m.group(1)
    if not actual:
        errors.append(f"{display_path}: empty version string")
        return
    if actual != PINNED_VERSION:
        errors.append(
            f"{display_path}: version '{actual}' is not pinned to {PINNED_VERSION}"
        )


def _check_generic_path(
    root: pathlib.Path,
    rel_path: str,
    display_path: pathlib.Path,
    errors: list[str],
) -> None:
    try:
        content = (root / rel_path).read_text()
    except (OSError, UnicodeDecodeError) as e:
        errors.append(f"{display_path}: read error: {e}")
        return
    marked = [
        line for line in content.splitlines() if "x-release-please-version" in line
    ]
    if not marked:
        errors.append(f"{display_path}: no 'x-release-please-version' marker found")
        return
    for line in marked:
        m = re.search(r"<string>([^<]*)</string>", line)
        if not m:
            errors.append(
                f"{display_path}: cannot extract <string> version from marked "
                f"line: {line.strip()}"
            )
            continue
        actual = m.group(1)
        if actual != PINNED_VERSION:
            errors.append(
                f"{display_path}: version '{actual}' is not pinned to {PINNED_VERSION}"
            )


def _check_json_path(root: pathlib.Path, rel_path: str, errors: list[str]) -> None:
    path = root / rel_path
    try:
        content = path.read_text()
        data = json.loads(content)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        errors.append(f"{path}: failed to parse JSON: {e}")
        return
    actual = data.get("version", "")
    if actual != PINNED_VERSION:
        errors.append(f"{path}: version '{actual}' is not pinned to {PINNED_VERSION}")


def find_errors(root: pathlib.Path) -> list[str]:
    errors: list[str] = []

    for rel_path in PINNED_JSON_FILES:
        _check_json_path(root, rel_path, errors)

    for rel_path in PINNED_TOML_FILES:
        toml_path = root / rel_path
        if not toml_path.exists():
            errors.append(f"{toml_path}: file not found")
            continue
        _check_toml_path(root, rel_path, toml_path, errors)

    for rel_path in PINNED_GENERIC_FILES:
        _check_generic_path(root, rel_path, root / rel_path, errors)

    for rel_path in STANDALONE_PINNED_TOML_FILES:
        if not (root / rel_path).exists():
            continue
        _check_toml_path(root, rel_path, root / rel_path, errors)

    return errors


def resolve_root(root_arg: str | None) -> pathlib.Path:
    if root_arg:
        return pathlib.Path(root_arg)
    override = os.environ.get("REPO_ROOT_OVERRIDE")
    if override:
        return pathlib.Path(override)
    return pathlib.Path(__file__).resolve().parent.parent


def parse_cli_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?")
    return parser.parse_args(argv)


def main() -> int:
    args = parse_cli_args(sys.argv[1:])
    errors = find_errors(resolve_root(args.root))
    if errors:
        for e in errors:
            print(e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
