#!/usr/bin/env bash

set -uo pipefail

KEEP_PROFILE_DIRS=(.fingerprint build deps)
KEEP_TOP_DIRS=(.tauri)
KEEP_TOP_FILES=(CACHEDIR.TAG)
DEPS_PREFIXES=("" lib)

main() {
  [ "$#" -ge 2 ] || usage
  local target_arg target manifest members tmp before after
  target_arg="$1"
  target="$(to_posix "$target_arg")"
  shift

  [ -d "$target" ] || skip "target directory $target_arg does not exist"
  command -v node >/dev/null 2>&1 || skip "node is not on PATH"

  tmp="$(mktemp -d)" || skip "could not create a temporary directory"
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
  echo "ci-clean-cargo-target: $target_arg went from $((before / 1024)) MiB to $((after / 1024)) MiB (artifacts of $(wc -l <"$members" | tr -d ' ') workspace member names removed)"
}

usage() {
  echo "usage: $0 <target-dir> <Cargo.toml>..." >&2
  exit 2
}

to_posix() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$1"
  else
    printf '%s\n' "$1"
  fi
}

skip() {
  echo "::warning::ci-clean-cargo-target: $*; the target directory is cached uncleaned"
  exit 0
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

size_kb() {
  du -sk "$1" 2>/dev/null | awk '{ print $1 }'
}

clean_target() {
  local dir="$1" members="$2" entry name
  for entry in "$dir"/* "$dir"/.[!.]*; do
    [ -e "$entry" ] || continue
    name="${entry##*/}"
    if [ -d "$entry" ]; then
      in_list "$name" "${KEEP_TOP_DIRS[@]}" && continue
      if is_profile_dir "$entry"; then
        clean_profile "$entry" "$members"
      else
        clean_target "$entry" "$members"
      fi
    elif ! in_list "$name" "${KEEP_TOP_FILES[@]}"; then
      rm -f "$entry"
    fi
  done
}

in_list() {
  local item="$1" entry
  shift
  for entry in "$@"; do
    [ "$entry" = "$item" ] && return 0
  done
  return 1
}

is_profile_dir() {
  [ -d "$1/deps" ] || [ -d "$1/.fingerprint" ] || [ -d "$1/build" ]
}

clean_profile() {
  local dir="$1" members="$2" entry name
  for entry in "$dir"/* "$dir"/.[!.]*; do
    [ -e "$entry" ] || continue
    name="${entry##*/}"
    in_list "$name" "${KEEP_PROFILE_DIRS[@]}" && continue
    rm -rf "$entry"
  done
  remove_members "$dir/build" "$members" ""
  remove_members "$dir/.fingerprint" "$members" ""
  remove_members "$dir/deps" "$members" "${DEPS_PREFIXES[@]}"
}

remove_members() {
  local dir="$1" members="$2" name
  shift 2
  [ -d "$dir" ] || return 0
  while IFS= read -r name; do
    [ -n "$name" ] && rm -rf "${dir:?}/$name"
  done < <(removable_entries "$dir" "$members" "$@")
}

removable_entries() {
  local dir="$1" members="$2" prefixes
  shift 2
  prefixes="$(printf '%s,' "$@")"
  find "$dir" -mindepth 1 -maxdepth 1 | sed 's|^.*/||' | awk -v prefixes="$prefixes" '
    function norm(s) { gsub(/-/, "_", s); return s }
    function strip_ext(s) { sub(/\..*$/, "", s); return s }
    BEGIN { count = split(prefixes, prefix, ",") }
    NR == FNR {
      for (p = 1; p <= count; p++) set[prefix[p] $0] = 1
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

main "$@"
