#!/usr/bin/env bats
# Pins the real-nerdctl semantics Speedwave's cleanup/heal relies on.
# ENGINE_EXEC runs argv as root in the engine namespace (set by the make target).

# 1935db59 = sha256("/run/containerd/containerd.sock")[0:8]; drift is caught by
# the Rust pin `consts::tests::nerdctl_addr_hash_matches_default_socket_digest`.
STORE=/var/lib/nerdctl/1935db59/names/default
NAME=spwcontract_ghost
DEAD=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef

setup_file() {
  # ENGINE_EXEC may be legitimately EMPTY (Task 5b runs in-namespace); the marker
  # var distinguishes "unset" (config error) from "empty on purpose".
  [ "${ENGINE_EXEC+set}" = "set" ] || { echo "ENGINE_EXEC must be set (may be empty for in-namespace runs)" >&2; return 1; }
  $ENGINE_EXEC true || { echo "engine executor unreachable: '$ENGINE_EXEC'" >&2; return 1; }
  # Deterministic image pick: a tagged Speedwave image, never <none>.
  IMG=$($ENGINE_EXEC nerdctl images --format '{{.Repository}}:{{.Tag}}' | grep '^speedwave-' | grep -v '<none>' | head -1)
  [ -n "$IMG" ] || { echo "no tagged speedwave-* image in engine — provision first" >&2; return 1; }
  export IMG
}

teardown() {
  # Container first (a live spwcontract container must never be orphaned by
  # deleting its reservation), the stray reservation second.
  $ENGINE_EXEC sh -c "nerdctl rm -f $NAME >/dev/null 2>&1; rm -f $STORE/$NAME; true"
}

@test "rm -f on a missing name exits 0 (cleanup relies on this)" {
  run $ENGINE_EXEC nerdctl rm -f definitely-absent-spwcontract
  [ "$status" -eq 0 ]
  [[ "$output" == *"no such container"* ]]
}

@test "a planted reservation blocks create with the exact classifier phrases" {
  $ENGINE_EXEC sh -c "printf '%s' $DEAD > $STORE/$NAME && chmod 600 $STORE/$NAME"
  run $ENGINE_EXEC nerdctl create --name "$NAME" "$IMG"
  [ "$status" -ne 0 ]
  [[ "$output" == *"name-store error"* ]]
  [[ "$output" == *"is already used by ID"* ]]
}

@test "inspect of a dead id fails non-zero with 'no such object <id>'" {
  run $ENGINE_EXEC nerdctl inspect "$DEAD"
  [ "$status" -ne 0 ]
  [[ "$output" == *"no such object $DEAD"* ]]
}

@test "flock on the names dir blocks nerdctl create (TOCTOU guard basis)" {
  # Wait until the holder provably owns the lock, and surface create's rc+stderr —
  # a fast-failing create must fail THIS test loudly, not fake a missing block.
  run $ENGINE_EXEC sh -c "flock $STORE sleep 6 & i=0; while flock -n $STORE true 2>/dev/null; do i=\$((i+1)); [ \$i -ge 20 ] && { echo holder-never-acquired; exit 1; }; sleep 0.2; done; start=\$(date +%s); nerdctl create --name $NAME $IMG >/dev/null 2>/tmp/spwcontract_create.err; rc=\$?; end=\$(date +%s); nerdctl rm -f $NAME >/dev/null 2>&1; echo create_rc=\$rc; sed 's/^/create_err: /' /tmp/spwcontract_create.err; rm -f /tmp/spwcontract_create.err; echo blocked=\$((end-start))"
  [ "$status" -eq 0 ]
  [[ "$output" == *"create_rc=0"* ]]
  [ "${output##*blocked=}" -ge 2 ]
}
