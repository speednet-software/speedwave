#!/usr/bin/env bash
set -euo pipefail

COMMIT="${COMMIT:?COMMIT is required}"
REPO="${REPO:?REPO is required}"

fail() {
  echo "::error::$*" >&2
  exit 1
}

version_cli() {
  if [ -n "${SPEEDWAVE_VERSION_BIN:-}" ]; then
    "$SPEEDWAVE_VERSION_BIN" "$@"
  else
    cargo run --quiet -p speedwave-version --bin speedwave-version --features cli -- "$@"
  fi
}

release_state() {
  gh release view "$1" --repo "$REPO" --json databaseId,isDraft,isPrerelease 2>/dev/null || true
}

line_sha() {
  git rev-parse --verify --quiet "refs/remotes/origin/release/0.$1^{commit}" ||
    git rev-parse --verify --quiet "refs/heads/release/0.$1^{commit}" || true
}

[[ "$COMMIT" =~ ^[0-9a-f]{7,40}$ ]] || fail "commit input must be 7 to 40 lowercase hex characters, got: $COMMIT"

line_has_stable() {
  local tag state
  while IFS= read -r tag; do
    state="$(release_state "$tag")"
    if [ -n "$state" ] && [ "$(jq -r '.isDraft or .isPrerelease' <<<"$state")" = "false" ]; then
      return 0
    fi
  done < <(git tag --list "v0.$1.0" "v0.$1.0+*")
  return 1
}

SHA="$(git rev-parse --verify --quiet "${COMMIT}^{commit}" || true)"
[ -n "$SHA" ] || fail "commit $COMMIT does not exist in this repository"

HIGHEST="$(git for-each-ref --format='%(refname)' refs/heads/release refs/remotes |
  sed -nE 's#.*/release/0\.([0-9]+)$#\1#p' | sort -n | tail -1)"
HIGHEST="${HIGHEST:-0}"

MINOR=$((HIGHEST + 1))
BRANCH_EXISTS=false
if [ "$HIGHEST" -gt 0 ]; then
  HIGHEST_SHA="$(line_sha "$HIGHEST")"
  if [ "$HIGHEST_SHA" = "$SHA" ]; then
    MINOR="$HIGHEST"
    BRANCH_EXISTS=true
  elif ! line_has_stable "$HIGHEST"; then
    fail "release/0.$HIGHEST exists at $HIGHEST_SHA without a stable release; an admin deletes it before promoting another commit."
  fi
fi

mapfile -t TAGS < <(git tag --points-at "$SHA" --list "v0.${MINOR}.0" "v0.${MINOR}.0+*")

FLIPPED=false
RELEASE_JSON=""
if [ "${#TAGS[@]}" -eq 1 ]; then
  RELEASE_JSON="$(release_state "${TAGS[0]}")"
  if [ -n "$RELEASE_JSON" ] && [ "$(jq -r '.isDraft or .isPrerelease' <<<"$RELEASE_JSON")" = "false" ]; then
    FLIPPED=true
  fi
fi

if [ "$FLIPPED" = "false" ]; then
  if ! git merge-base --is-ancestor "$SHA" refs/remotes/origin/dev; then
    fail "commit $SHA is not in the history of dev; promote a commit that dev contains."
  fi

  if [ "${#TAGS[@]}" -eq 0 ]; then
    fail "no beta tag v0.${MINOR}.0+N found on commit $SHA. Pick a commit that has a published beta (the Releases page lists them)."
  fi
  if [ "${#TAGS[@]}" -gt 1 ]; then
    fail "ambiguous beta tags on commit $SHA: ${TAGS[*]}"
  fi

  if [ -z "$RELEASE_JSON" ]; then
    fail "tag ${TAGS[0]} exists but has no GitHub Release; wait for the Beta workflow to publish it and run the promotion again."
  fi
  if [ "$(jq -r '.isDraft' <<<"$RELEASE_JSON")" = "true" ]; then
    fail "the beta release for ${TAGS[0]} is still a draft (build in progress); run the promotion again once it publishes."
  fi
fi

TAG="${TAGS[0]}"
RELEASE_ID="$(jq -r '.databaseId' <<<"$RELEASE_JSON")"

if [ "$FLIPPED" = "false" ]; then
  if ! version_cli validate-promotion --repo "$PWD" --candidate "$SHA" --new-minor "$MINOR"; then
    fail "validate-promotion refused commit $SHA for release line 0.${MINOR}: it is not newer than the previous release line."
  fi

  while IFS= read -r line_tag; do
    state="$(release_state "$line_tag")"
    if [ -n "$state" ] && [ "$(jq -r '.isDraft or .isPrerelease' <<<"$state")" = "false" ]; then
      fail "release line 0.${MINOR} already has a stable release ($line_tag); use a hotfix push to release/0.${MINOR} instead."
    fi
  done < <(git tag --list "v0.${MINOR}.0" "v0.${MINOR}.0+*")

  RUNS_JSON="$(gh api "repos/$REPO/actions/workflows/beta.yml/runs?head_sha=$SHA&per_page=100")"
  BUILD_RUN=""
  while IFS= read -r run; do
    run_id="$(jq -r '.id' <<<"$run")"
    jobs_json="$(gh api "repos/$REPO/actions/runs/$run_id/jobs?per_page=100")"
    if jq -e '[.jobs[] | select((.name | startswith("publish")) and .conclusion != "skipped")] | length > 0' <<<"$jobs_json" >/dev/null; then
      BUILD_RUN="$run"
      break
    fi
  done < <(jq -c '.workflow_runs[] | {id, status, conclusion}' <<<"$RUNS_JSON")

  if [ -z "$BUILD_RUN" ]; then
    fail "no Beta run that built $TAG was found for commit $SHA (never started or still running). Wait for the Beta workflow to finish, then run the promotion again."
  fi
  RUN_ID="$(jq -r '.id' <<<"$BUILD_RUN")"
  if [ "$(jq -r '.status' <<<"$BUILD_RUN")" != "completed" ]; then
    fail "Beta run $RUN_ID for $TAG is still running; run the promotion again when it finishes."
  fi
  CONCLUSION="$(jq -r '.conclusion' <<<"$BUILD_RUN")"
  if [ "$CONCLUSION" != "success" ]; then
    fail "Beta run $RUN_ID for $TAG ended with $CONCLUSION; use Re-run failed jobs on that run until it is green, then run the promotion again."
  fi
fi

echo "minor=$MINOR"
echo "tag=$TAG"
echo "version=${TAG#v}"
echo "release_id=$RELEASE_ID"
echo "commit=$SHA"
echo "branch_exists=$BRANCH_EXISTS"
echo "flipped=$FLIPPED"
