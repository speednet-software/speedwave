#!/usr/bin/env bash

set -uo pipefail

KEEP_PROFILE_DIRS=".fingerprint build deps"
KEEP_TOP_DIRS=".tauri"

usage() {
  echo "usage: $0 <target-dir> <Cargo.toml>..." >&2
  exit 2
}

skip() {
  echo "::warning::ci-clean-cargo-target: $*; the target directory is cached uncleaned"
  exit 0
}

to_posix() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$1"
  else
    printf '%s\n' "$1"
  fi
}

size_kb() {
  du -sk "$1" 2>/dev/null | awk '{ print $1 }'
}

member_names() {
  node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => {
      const names = new Set();
      for (const pkg of JSON.parse(raw).packages) {
        names.add(pkg.name);
        for (const target of pkg.targets) {
          if (!target.kind.includes("custom-build")) names.add(target.name);
        }
      }
      for (const name of names) console.log(name.replace(/-/g, "_"));
    });
  '
}

removable_entries() {
  local dir="$1" members="$2" with_lib="$3"
  find "$dir" -mindepth 1 -maxdepth 1 | sed 's|^.*/||' | awk -v with_lib="$with_lib" '
    function norm(s) { gsub(/-/, "_", s); return s }
    function strip_ext(s) { sub(/\..*$/, "", s); return s }
    NR == FNR {
      set[$0] = 1
      if (with_lib == "1") set["lib" $0] = 1
      next
    }
    {
      name = $0
      base = strip_ext(name)
      cut = 0
      for (i = length(name); i > 0; i--) {
        if (substr(name, i, 1) == "-") { cut = i; break }
      }
      if (cut > 0) {
        hash = strip_ext(substr(name, cut + 1))
        if (length(hash) == 16 && hash ~ /^[0-9a-f]+$/) base = substr(name, 1, cut - 1)
      }
      if ((norm(base) in set) || (norm(name) in set)) print name
    }
  ' "$members" -
}

remove_members() {
  local dir="$1" members="$2" with_lib="$3" name
  [ -d "$dir" ] || return 0
  while IFS= read -r name; do
    [ -n "$name" ] && rm -rf "${dir:?}/$name"
  done < <(removable_entries "$dir" "$members" "$with_lib")
}

is_profile_dir() {
  [ -d "$1/deps" ] || [ -d "$1/.fingerprint" ] || [ -d "$1/build" ]
}

in_list() {
  local item="$1" entry
  shift
  for entry in "$@"; do
    [ "$entry" = "$item" ] && return 0
  done
  return 1
}

clean_profile() {
  local dir="$1" members="$2" entry name
  for entry in "$dir"/* "$dir"/.[!.]*; do
    [ -e "$entry" ] || continue
    name="${entry##*/}"
    # shellcheck disable=SC2086
    in_list "$name" $KEEP_PROFILE_DIRS && continue
    rm -rf "$entry"
  done
  remove_members "$dir/build" "$members" 0
  remove_members "$dir/.fingerprint" "$members" 0
  remove_members "$dir/deps" "$members" 1
}

clean_target() {
  local dir="$1" members="$2" entry name
  for entry in "$dir"/* "$dir"/.[!.]*; do
    [ -e "$entry" ] || continue
    name="${entry##*/}"
    if [ -d "$entry" ]; then
      # shellcheck disable=SC2086
      in_list "$name" $KEEP_TOP_DIRS && continue
      if is_profile_dir "$entry"; then
        clean_profile "$entry" "$members"
      else
        clean_target "$entry" "$members"
      fi
    elif [ "$name" != "CACHEDIR.TAG" ]; then
      rm -f "$entry"
    fi
  done
}

main() {
  [ "$#" -ge 2 ] || usage
  local target manifest members tmp before after
  target="$(to_posix "$1")"
  shift

  [ -d "$target" ] || skip "target directory $1 does not exist"
  command -v node >/dev/null 2>&1 || skip "node is not on PATH"

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  members="$tmp/members"
  : >"$members"

  for manifest in "$@"; do
    cargo metadata --no-deps --format-version 1 --manifest-path "$manifest" >"$tmp/metadata.json" ||
      skip "cargo metadata failed for $manifest"
    member_names <"$tmp/metadata.json" >>"$members" ||
      skip "could not read the cargo metadata of $manifest"
  done
  [ -s "$members" ] || skip "no workspace members found"
  sort -u "$members" -o "$members"

  before="$(size_kb "$target")"
  clean_target "$target" "$members"
  after="$(size_kb "$target")"
  echo "ci-clean-cargo-target: $1 went from $((before / 1024)) MiB to $((after / 1024)) MiB (artifacts of $(wc -l <"$members" | tr -d ' ') workspace member names removed)"
}

main "$@"
