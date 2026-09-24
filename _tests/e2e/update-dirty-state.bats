#!/usr/bin/env bats
load setup

STORE=/var/lib/nerdctl/1935db59/names/default
DEAD=db0da85287aa1119f5ef5483d7585c28ef721cf946111cf8d5369d308ecf450e

setup_file() {
  [ -n "$SPW_E2E_PROJECT" ] || { echo "SPW_E2E_PROJECT required" >&2; return 1; }
  [ "${ENGINE_EXEC+set}" = "set" ] || { echo "ENGINE_EXEC required" >&2; return 1; }
  $ENGINE_EXEC true || return 1
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
  $ENGINE_EXEC sh -c "grep -l $DEAD $STORE/* 2>/dev/null | xargs -r rm -f; true"
  rm -rf "$TEST_TEMP_DIR"
}

@test "update heals a single planted ghost and completes" {
  plant_ghost "${PREFIX}_${SPW_E2E_PROJECT}_mcp_hub"
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
  for svc in mcp_hub claude proxy; do
    n="${PREFIX}_${SPW_E2E_PROJECT}_${svc}"
    id=$($ENGINE_EXEC sh -c "cat $STORE/$n" | tr -d '[:space:]')
    [ -n "$id" ] && [ "$id" != "$DEAD" ]
    running=""
    for _ in $(seq 1 30); do
      running=$($ENGINE_EXEC nerdctl inspect --format '{{.State.Running}}' "$id" 2>/dev/null | tr -d '[:space:]')
      [ "$running" = "true" ] && break
      sleep 1
    done
    [ "$running" = "true" ] || { echo "container $n ($id) never reached Running=true (last: $running)"; false; }
  done
}
