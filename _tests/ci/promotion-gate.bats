#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/promotion-gate.sh"

setup() {
    STUB_DIR="$BATS_TEST_TMPDIR/bin"
    GH_DIR="$BATS_TEST_TMPDIR/gh"
    mkdir -p "$STUB_DIR" "$GH_DIR"
    cat >"$STUB_DIR/gh" <<'EOF2'
#!/usr/bin/env bash
if [[ "$1" == "release" && "$2" == "view" ]]; then
    file="$GH_DIR/release-$3.json"
    [[ -f "$file" ]] || exit 1
    cat "$file"
elif [[ "$1" == "api" && "$2" == *"/workflows/beta.yml/runs?"* ]]; then
    cat "$GH_DIR/runs.json"
elif [[ "$1" == "api" && "$2" == *"/actions/runs/"*"/jobs"* ]]; then
    id="${2#*/actions/runs/}"
    id="${id%%/*}"
    cat "$GH_DIR/jobs-$id.json"
else
    exit 1
fi
EOF2
    cat >"$STUB_DIR/speedwave-version" <<'EOF2'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$GH_DIR/version.argv"
exit "${VERSION_STUB_EXIT:-0}"
EOF2
    chmod +x "$STUB_DIR/gh" "$STUB_DIR/speedwave-version"

    WORK="$BATS_TEST_TMPDIR/repo"
    git init -q -b dev "$WORK"
    git -C "$WORK" config user.name t
    git -C "$WORK" config user.email t@t
    git -C "$WORK" commit -q --allow-empty -m "init"
    git -C "$WORK" commit -q --allow-empty -m "release 0.20 tip"
    git -C "$WORK" update-ref refs/remotes/origin/release/0.20 HEAD
    git -C "$WORK" tag "v0.20.0"
    git -C "$WORK" commit -q --allow-empty -m "candidate"
    CANDIDATE="$(git -C "$WORK" rev-parse HEAD)"
    git -C "$WORK" tag "v0.21.0+203"
    git -C "$WORK" commit -q --allow-empty -m "later dev commit"
    git -C "$WORK" update-ref refs/remotes/origin/dev HEAD

    export GH_DIR REPO="speednet/speedwave" COMMIT="$CANDIDATE"
    export SPEEDWAVE_VERSION_BIN="$STUB_DIR/speedwave-version"
    export GH_TOKEN=x

    printf '{"databaseId":1,"isDraft":false,"isPrerelease":false}\n' >"$GH_DIR/release-v0.20.0.json"
    beta_release prerelease
    successful_beta_run 501
}

beta_release() {
    local flag=true
    [[ "$1" == "published" ]] && flag=false
    local draft=false
    [[ "$1" == "draft" ]] && draft=true && flag=true
    printf '{"databaseId":777,"isDraft":%s,"isPrerelease":%s}\n' "$draft" "$flag" >"$GH_DIR/release-v0.21.0+203.json"
}

beta_run() {
    local id="$1" status="$2" conclusion="$3" publish="$4"
    printf '{"workflow_runs":[{"id":%s,"status":"%s","conclusion":%s}]}\n' "$id" "$status" "$conclusion" >"$GH_DIR/runs.json"
    printf '{"jobs":[{"name":"compute","conclusion":"success"},{"name":"publish","conclusion":%s}]}\n' "$publish" >"$GH_DIR/jobs-$id.json"
}

successful_beta_run() {
    beta_run "$1" completed '"success"' '"success"'
}

gate() {
    cd "$WORK"
    PATH="$STUB_DIR:$PATH" run bash "$SCRIPT"
}

@test "a green beta run on a fresh commit yields the next minor and asks for the line to be created" {
    gate
    [ "$status" -eq 0 ]
    [[ "$output" == *"minor=21"* ]]
    [[ "$output" == *"tag=v0.21.0+203"* ]]
    [[ "$output" == *"version=0.21.0+203"* ]]
    [[ "$output" == *"release_id=777"* ]]
    [[ "$output" == *"commit=$CANDIDATE"* ]]
    [[ "$output" == *"branch_exists=false"* ]]
    [[ "$output" == *"flipped=false"* ]]
}

@test "validate-promotion gets the candidate and the computed minor" {
    gate
    [ "$status" -eq 0 ]
    run cat "$GH_DIR/version.argv"
    [[ "$output" == *$'validate-promotion'* ]]
    [[ "$output" == *$'--candidate\n'"$CANDIDATE"* ]]
    [[ "$output" == *$'--new-minor\n21'* ]]
}

@test "a commit that is not in dev history is refused" {
    git -C "$WORK" checkout -q -b side
    git -C "$WORK" commit -q --allow-empty -m "side"
    COMMIT="$(git -C "$WORK" rev-parse HEAD)"
    git -C "$WORK" tag "v0.21.0+204"
    cp "$GH_DIR/release-v0.21.0+203.json" "$GH_DIR/release-v0.21.0+204.json"
    gate
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::"*"dev"* ]]
}

@test "an unknown commit is refused" {
    COMMIT="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" gate
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::"* ]]
}

@test "a commit without a beta tag is refused" {
    git -C "$WORK" tag -d "v0.21.0+203" >/dev/null
    gate
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::no beta tag"* ]]
}

@test "a beta tag without a published release is refused" {
    rm "$GH_DIR/release-v0.21.0+203.json"
    gate
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::"*"no GitHub Release"* ]]
}

@test "a draft beta release is refused" {
    beta_release draft
    gate
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::"*"draft"* ]]
}

@test "a promotion older than the previous line is refused by validate-promotion" {
    VERSION_STUB_EXIT=1 gate
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::"*"validate-promotion"* ]]
}

@test "a line that already has a stable release is refused" {
    git -C "$WORK" tag "v0.21.0"
    printf '{"databaseId":1,"isDraft":false,"isPrerelease":false}\n' >"$GH_DIR/release-v0.21.0.json"
    gate
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::"*"already has a stable"* ]]
}

@test "a missing beta run is refused" {
    printf '{"workflow_runs":[]}\n' >"$GH_DIR/runs.json"
    gate
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::no Beta run"* ]]
}

@test "a beta run with skipped publish jobs is ignored" {
    beta_run 502 completed '"success"' '"skipped"'
    gate
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::no Beta run"* ]]
}

@test "a run in progress is refused without waiting" {
    beta_run 503 in_progress null null
    gate
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::"*"still running"* ]]
}

@test "a failed beta run is refused" {
    beta_run 504 completed '"failure"' '"success"'
    gate
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::"*"failure"* ]]
}

@test "the newest run that built the beta decides, older skipped runs are ignored" {
    printf '{"workflow_runs":[{"id":601,"status":"completed","conclusion":"success"},{"id":600,"status":"completed","conclusion":"failure"}]}\n' >"$GH_DIR/runs.json"
    printf '{"jobs":[{"name":"publish","conclusion":"skipped"}]}\n' >"$GH_DIR/jobs-601.json"
    printf '{"jobs":[{"name":"publish / build","conclusion":"success"}]}\n' >"$GH_DIR/jobs-600.json"
    gate
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::"*"failure"* ]]
}

@test "rerunning on the commit the highest line already points at resumes that minor" {
    git -C "$WORK" update-ref refs/remotes/origin/release/0.21 "$CANDIDATE"
    gate
    [ "$status" -eq 0 ]
    [[ "$output" == *"minor=21"* ]]
    [[ "$output" == *"branch_exists=true"* ]]
    run cat "$GH_DIR/version.argv"
    [[ "$output" == *$'--new-minor\n21'* ]]
}

@test "a beta whose prerelease flag is already cleared skips every precondition" {
    git -C "$WORK" update-ref refs/remotes/origin/release/0.21 "$CANDIDATE"
    beta_release published
    rm "$GH_DIR/runs.json"
    VERSION_STUB_EXIT=1 gate
    [ "$status" -eq 0 ]
    [[ "$output" == *"flipped=true"* ]]
    [[ "$output" == *"minor=21"* ]]
    [[ "$output" == *"tag=v0.21.0+203"* ]]
    [[ "$output" == *"release_id=777"* ]]
    [ ! -f "$GH_DIR/version.argv" ]
}

@test "a missing COMMIT is a usage error" {
    cd "$WORK"
    PATH="$STUB_DIR:$PATH" COMMIT="" run bash "$SCRIPT"
    [ "$status" -ne 0 ]
}

@test "a highest line at another commit without a stable release is refused" {
    git -C "$WORK" update-ref refs/remotes/origin/release/0.21 refs/remotes/origin/dev
    gate
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::release/0.21 exists at"* ]]
    [[ "$output" == *"without a stable release"* ]]
    [[ "$output" == *"admin deletes it"* ]]
}

@test "a highest line at another commit with a stable release makes the next minor the fresh case" {
    git -C "$WORK" update-ref refs/remotes/origin/release/0.21 refs/remotes/origin/dev
    git -C "$WORK" tag "v0.21.0" refs/remotes/origin/dev
    printf '{"databaseId":2,"isDraft":false,"isPrerelease":false}\n' >"$GH_DIR/release-v0.21.0.json"
    git -C "$WORK" tag "v0.22.0+203" "$CANDIDATE"
    printf '{"databaseId":888,"isDraft":false,"isPrerelease":true}\n' >"$GH_DIR/release-v0.22.0+203.json"
    gate
    [ "$status" -eq 0 ]
    [[ "$output" == *"minor=22"* ]]
    [[ "$output" == *"branch_exists=false"* ]]
}

@test "the dev ancestry is checked before the beta tag" {
    git -C "$WORK" checkout -q -b side
    git -C "$WORK" commit -q --allow-empty -m "side"
    COMMIT="$(git -C "$WORK" rev-parse HEAD)"
    gate
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::"*"history of dev"* ]]
}

@test "a commit input that is not 7 to 40 lowercase hex characters is refused" {
    for bad in "HEAD" "dev" "ABCDEF1234" "abc12" "$CANDIDATE;id" "--help"; do
        COMMIT="$bad" gate
        [ "$status" -eq 1 ]
        [[ "$output" == *"::error::commit input must be 7 to 40 lowercase hex characters"* ]]
    done
}

@test "a short commit prefix is accepted" {
    COMMIT="${CANDIDATE:0:10}" gate
    [ "$status" -eq 0 ]
    [[ "$output" == *"commit=$CANDIDATE"* ]]
}

@test "a flipped release without its branch asks for the branch to be created" {
    beta_release published
    rm "$GH_DIR/runs.json"
    VERSION_STUB_EXIT=1 gate
    [ "$status" -eq 0 ]
    [[ "$output" == *"flipped=true"* ]]
    [[ "$output" == *"branch_exists=false"* ]]
    [[ "$output" == *"minor=21"* ]]
}
