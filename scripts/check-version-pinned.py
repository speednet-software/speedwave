#!/usr/bin/env python3
import argparse
import json
import os
import pathlib
import re
import subprocess
import sys

PINNED_VERSION = "0.0.0"
STANDALONE_PINNED_TOML_FILES = ("crates/speedwave-version/Cargo.toml",)


def _load_json_from_text(text: str, path_for_errors: pathlib.Path) -> dict:
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        sys.exit(f"{path_for_errors}: invalid JSON: {e}")


def _load_json(path: pathlib.Path) -> dict:
    if not path.exists():
        sys.exit(f"{path}: file not found")
    return _load_json_from_text(path.read_text(), path)


def _is_staged(root: pathlib.Path, rel_path: str) -> bool:
    result = subprocess.run(
        ["git", "-C", str(root), "diff", "--cached", "--name-only", "--", rel_path],
        capture_output=True,
        text=True,
        check=False,
    )
    return bool(result.stdout.strip())


def _read_staged_text(root: pathlib.Path, rel_path: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(root), "show", f":{rel_path}"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise FileNotFoundError(f"{rel_path}: not found in the git index")
    return result.stdout


def _read_text(root: pathlib.Path, rel_path: str, staged: bool) -> str:
    if staged:
        return _read_staged_text(root, rel_path)
    return (root / rel_path).read_text()


def _check_toml_path(
    root: pathlib.Path,
    rel_path: str,
    display_path: pathlib.Path,
    staged: bool,
    errors: list[str],
) -> None:
    try:
        content = _read_text(root, rel_path, staged)
    except Exception as e:
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
    staged: bool,
    errors: list[str],
) -> None:
    try:
        content = _read_text(root, rel_path, staged)
    except Exception as e:
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


def find_errors(root: pathlib.Path, staged: bool = False) -> list[str]:
    errors: list[str] = []

    manifest_rel = ".release-please-manifest.json"
    manifest_path = root / manifest_rel
    if not staged or _is_staged(root, manifest_rel):
        try:
            manifest_text = _read_text(root, manifest_rel, staged)
        except FileNotFoundError:
            sys.exit(f"{manifest_path}: file not found")
        manifest = _load_json_from_text(manifest_text, manifest_path)
        if "." not in manifest:
            sys.exit(f"{manifest_path}: missing '.' root-package key")
        manifest_version = manifest["."]
        if manifest_version != PINNED_VERSION:
            errors.append(
                f"{manifest_path}: root package version '{manifest_version}' "
                f"is not pinned to {PINNED_VERSION}"
            )

    config = _load_json(root / "release-please-config.json")
    try:
        extra_files = config["packages"]["."]["extra-files"]
    except KeyError as e:
        sys.exit(f"release-please-config.json: missing key {e}")

    for entry in extra_files:
        if isinstance(entry, str):
            rel_path = entry
            path = root / rel_path
            if staged and not _is_staged(root, rel_path):
                continue
            try:
                content = _read_text(root, rel_path, staged)
                data = json.loads(content)
            except Exception as e:
                errors.append(f"{path}: failed to parse JSON: {e}")
                continue
            actual = data.get("version", "")
            if actual != PINNED_VERSION:
                errors.append(
                    f"{path}: version '{actual}' is not pinned to {PINNED_VERSION}"
                )
        elif isinstance(entry, dict) and entry.get("type") == "toml":
            pattern = entry["path"]
            matches = list(root.glob(pattern))
            if not matches:
                errors.append(f"no matches for glob: {pattern}")
                continue
            for toml_path in matches:
                rel_path = toml_path.relative_to(root).as_posix()
                if staged and not _is_staged(root, rel_path):
                    continue
                _check_toml_path(root, rel_path, toml_path, staged, errors)
        elif isinstance(entry, dict) and entry.get("type") == "generic":
            rel_path = entry["path"]
            path = root / rel_path
            if staged and not _is_staged(root, rel_path):
                continue
            _check_generic_path(root, rel_path, path, staged, errors)
        elif isinstance(entry, dict):
            errors.append(
                f"unsupported extra-file type '{entry.get('type')}' for "
                f"path '{entry.get('path')}': extend "
                f"check-version-pinned.py to cover it"
            )

    for rel_path in STANDALONE_PINNED_TOML_FILES:
        if staged:
            if not _is_staged(root, rel_path):
                continue
        elif not (root / rel_path).exists():
            continue
        _check_toml_path(root, rel_path, root / rel_path, staged, errors)

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
    parser.add_argument(
        "--staged",
        action="store_true",
        help="check only files staged for commit, reading their staged blob "
        "via 'git show' instead of the working tree",
    )
    return parser.parse_args(argv)


def main() -> int:
    args = parse_cli_args(sys.argv[1:])
    errors = find_errors(resolve_root(args.root), staged=args.staged)
    if errors:
        for e in errors:
            print(e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
