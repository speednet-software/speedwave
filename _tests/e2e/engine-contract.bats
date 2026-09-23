#!/usr/bin/env bats

STORE=/var/lib/nerdctl/1935db59/names/default
TASKS=/run/containerd/io.containerd.runtime.v2.task/default
NAME=spwcontract_ghost
DEAD=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef

setup_file() {
  [ "${ENGINE_EXEC+set}" = "set" ] || { echo "ENGINE_EXEC must be set (may be empty for in-namespace runs)" >&2; return 1; }
  $ENGINE_EXEC true || { echo "engine executor unreachable: '$ENGINE_EXEC'" >&2; return 1; }
  IMG=$($ENGINE_EXEC nerdctl images --format '{{.Repository}}:{{.Tag}}' | grep '^speedwave-' | grep -v '<none>' | head -1)
  [ -n "$IMG" ] || { echo "no tagged speedwave-* image in engine — provision first" >&2; return 1; }
  export IMG
}

teardown() {
  $ENGINE_EXEC sh -c "nerdctl unpause $NAME >/dev/null 2>&1; nerdctl rm -f $NAME >/dev/null 2>&1; rm -f $STORE/$NAME; true"
  if [ -n "${BUNDLE_ID:-}" ]; then
    $ENGINE_EXEC rmdir "$TASKS/$BUNDLE_ID" 2>/dev/null || true
  fi
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
  [[ "$output" == *"name-store error"* ]] || false
  [[ "$output" == *"is already used by ID"* ]]
}

@test "inspect of a dead id fails non-zero with 'no such object <id>'" {
  run $ENGINE_EXEC nerdctl inspect "$DEAD"
  [ "$status" -ne 0 ]
  [[ "$output" == *"no such object $DEAD"* ]]
}

@test "image inspect of a present tag exits 0 (image_exists reads success as present)" {
  run $ENGINE_EXEC nerdctl image inspect "$IMG"
  [ "$status" -eq 0 ]
}

@test "image inspect of a missing tag fails non-zero with 'no such image' (the only absent verdict)" {
  run $ENGINE_EXEC nerdctl image inspect speedwave-spwcontract-absent:0
  [ "$status" -ne 0 ]
  [[ "$output" == *"no such image: speedwave-spwcontract-absent:0"* ]]
}

@test "flock on the names dir blocks nerdctl create (TOCTOU guard basis)" {
  script=$(cat <<EOF
flock $STORE sleep 6 &
i=0
while flock -n $STORE true 2>/dev/null; do
  i=\$((i+1))
  [ "\$i" -ge 20 ] && { echo holder-never-acquired; exit 1; }
  sleep 0.2
done
start=\$(date +%s)
nerdctl create --name $NAME $IMG >/dev/null 2>/tmp/spwcontract_create.err
rc=\$?
end=\$(date +%s)
nerdctl rm -f $NAME >/dev/null 2>&1
echo create_rc=\$rc
sed 's/^/create_err: /' /tmp/spwcontract_create.err
rm -f /tmp/spwcontract_create.err
echo blocked=\$((end-start))
EOF
  )
  b64=$(printf '%s' "$script" | base64 | tr -d '\n')
  run $ENGINE_EXEC sh -c "echo $b64 | base64 -d | sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"create_rc=0"* ]] || false
  [ "${output##*blocked=}" -ge 2 ]
}

@test "an existing task bundle fails task create with the collision classifier phrases" {
  BUNDLE_ID=$($ENGINE_EXEC nerdctl create --name "$NAME" "$IMG" | tr -d '\r\n')
  [[ "$BUNDLE_ID" =~ ^[0-9a-f]{64}$ ]] || false
  $ENGINE_EXEC mkdir -p "$TASKS/$BUNDLE_ID"
  $ENGINE_EXEC test -d "$TASKS/$BUNDLE_ID"
  run $ENGINE_EXEC nerdctl start "$NAME"
  [ "$status" -ne 0 ]
  [[ "$output" == *"mkdir "* ]] || false
  [[ "$output" == *"$TASKS/$BUNDLE_ID: file exists"* ]]
}

@test "starting a paused container fails with the registered-task classifier phrase" {
  PAUSED_ID=$($ENGINE_EXEC nerdctl run -d --name "$NAME" --entrypoint sleep "$IMG" 300 | tr -d '\r\n')
  [[ "$PAUSED_ID" =~ ^[0-9a-f]{64}$ ]] || false
  $ENGINE_EXEC nerdctl pause "$NAME"
  run $ENGINE_EXEC nerdctl inspect --format '{{.State.Status}}' "$NAME"
  [ "$(printf '%s' "$output" | tr -d '\r\n')" = "paused" ]
  run $ENGINE_EXEC nerdctl start "$NAME"
  [ "$status" -ne 0 ]
  [[ "$output" == *"task $PAUSED_ID: already exists"* ]]
}

@test "timeout --signal=KILL stops a TERM-ignoring child at once (compose up deadline classifier basis)" {
  script='(trap "" TERM; exec sleep 30) & sleep 20'
  b64=$(printf '%s' "$script" | base64 | tr -d '\n')
  started=$SECONDS
  run $ENGINE_EXEC sh -c "echo $b64 | base64 -d | timeout --signal=KILL --verbose 1 sh"
  [ "$status" -ne 0 ]
  [ $((SECONDS - started)) -lt 10 ]
  [[ "$output" == *"timeout: sending signal KILL to command"* ]]
}
