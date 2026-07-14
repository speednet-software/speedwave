#!/usr/bin/env bats
# `speedwave update` must self-heal planted name-store debris (the 0.16.0 field failure).
load setup

# 1935db59: pinned by consts::tests::nerdctl_addr_hash_matches_default_socket_digest.
STORE=/var/lib/nerdctl/1935db59/names/default
DEAD=db0da85287aa1119f5ef5483d7585c28ef721cf946111cf8d5369d308ecf450e

setup_file() {
  [ -n "$SPW_E2E_PROJECT" ] || { echo "SPW_E2E_PROJECT required" >&2; return 1; }
  [ "${ENGINE_EXEC+set}" = "set" ] || { echo "ENGINE_EXEC required" >&2; return 1; }
  $ENGINE_EXEC true || return 1
  # Container names are <compose_prefix>_<project>_<service>; the prefix is the
  # data-dir basename sans leading dot (dev VM: "speedwave-dev") — never a literal.
  PREFIX=$(basename "${SPEEDWAVE_DATA_DIR:-$HOME/.speedwave}"); PREFIX=${PREFIX#.}
  export PREFIX
}

plant_ghost() {
  $ENGINE_EXEC sh -c "nerdctl rm -f $1 >/dev/null 2>&1; printf '%s' $DEAD > $STORE/$1; chmod 600 $STORE/$1"
}

ghost_count() {
  $ENGINE_EXEC sh -c "grep -l $DEAD $STORE/* 2>/dev/null | wc -l" | tr -d '[:space:]'
}

teardown() {
  # Never leave debris for later suites, even on failure…
  $ENGINE_EXEC sh -c "grep -l $DEAD $STORE/* 2>/dev/null | xargs -r rm -f; true"
  # …and keep setup.bash's tempdir contract (this teardown SHADOWS the loaded one).
  rm -rf "$TEST_TEMP_DIR"
}

@test "update heals a single planted ghost and completes" {
  plant_ghost "${PREFIX}_${SPW_E2E_PROJECT}_mcp_hub"
  # Precondition: a silently failed plant would make the heal assertions vacuous.
  [ "$(ghost_count)" -eq 1 ]
  run "$SPEEDWAVE_BIN" update --project "$SPW_E2E_PROJECT"
  assert_exit_code 0
  assert_output_contains "Updated"
  [ "$(ghost_count)" -eq 0 ]
}

@test "update heals three ghosts in a single pass" {
  for svc in mcp_hub claude proxy; do plant_ghost "${PREFIX}_${SPW_E2E_PROJECT}_${svc}"; done
  [ "$(ghost_count)" -eq 3 ]
  run "$SPEEDWAVE_BIN" update --project "$SPW_E2E_PROJECT"
  assert_exit_code 0
  [ "$(ghost_count)" -eq 0 ]
  # `speedwave check` does NOT inspect containers — assert liveness per planted
  # name: fresh ID (!= DEAD), inspect succeeds, and State.Running is true.
  for svc in mcp_hub claude proxy; do
    n="${PREFIX}_${SPW_E2E_PROJECT}_${svc}"
    id=$($ENGINE_EXEC sh -c "cat $STORE/$n" | tr -d '[:space:]')
    [ -n "$id" ] && [ "$id" != "$DEAD" ]
    run $ENGINE_EXEC nerdctl inspect --format '{{.State.Running}}' "$id"
    assert_exit_code 0
    assert_output_contains "true"
  done
}
