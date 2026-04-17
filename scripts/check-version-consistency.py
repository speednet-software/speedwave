#!/usr/bin/env python3
# Verifies every version-bearing file listed in release-please-config.json
# agrees with .release-please-manifest.json["."].
#
# Usage:
#   python3 scripts/check-version-consistency.py             # checks repo root
#   python3 scripts/check-version-consistency.py <path>      # checks a fixture tree
#   REPO_ROOT_OVERRIDE=<path> python3 scripts/check-version-consistency.py
#
# Exits 0 on full match; non-zero on first drift. Drift lines go to stderr.
import json
import os
import pathlib
import re
import sys


def find_errors(root: pathlib.Path) -> list[str]:
    manifest = json.loads((root / ".release-please-manifest.json").read_text())
    expected = manifest["."]
    config = json.loads((root / "release-please-config.json").read_text())
    extra_files = config["packages"]["."]["extra-files"]

    errors: list[str] = []
    for entry in extra_files:
        if isinstance(entry, str):
            path = root / entry
            try:
                data = json.loads(path.read_text())
            except Exception as e:
                errors.append(f"{path}: failed to parse JSON: {e}")
                continue
            actual = data.get("version", "")
            if actual != expected:
                errors.append(
                    f"{path}: version '{actual}' != manifest '{expected}'"
                )
        elif isinstance(entry, dict) and entry.get("type") == "toml":
            pattern = entry["path"]
            matches = list(root.glob(pattern))
            if not matches:
                errors.append(f"no matches for glob: {pattern}")
                continue
            for toml_path in matches:
                try:
                    content = toml_path.read_text()
                except Exception as e:
                    errors.append(f"{toml_path}: read error: {e}")
                    continue
                # Extract [package].version with regex — keeps support for
                # Python < 3.11 (no tomllib).
                pkg = re.search(r"\[package\](.*?)(?:\n\[|\Z)", content, re.DOTALL)
                if not pkg:
                    errors.append(f"{toml_path}: no [package] section found")
                    continue
                m = re.search(
                    r'^version\s*=\s*"([^"]*)"', pkg.group(1), re.MULTILINE
                )
                if not m:
                    errors.append(f"{toml_path}: no version field in [package]")
                    continue
                actual = m.group(1)
                if not actual:
                    errors.append(f"{toml_path}: empty version string")
                    continue
                if actual != expected:
                    errors.append(
                        f"{toml_path}: version '{actual}' != manifest '{expected}'"
                    )
    return errors


def resolve_root() -> pathlib.Path:
    if len(sys.argv) > 1:
        return pathlib.Path(sys.argv[1])
    override = os.environ.get("REPO_ROOT_OVERRIDE")
    if override:
        return pathlib.Path(override)
    return pathlib.Path(__file__).resolve().parent.parent


def main() -> int:
    errors = find_errors(resolve_root())
    if errors:
        for e in errors:
            print(e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
