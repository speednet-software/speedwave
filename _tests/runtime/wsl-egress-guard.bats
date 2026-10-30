#!/usr/bin/env bats

GUARD="$BATS_TEST_DIRNAME/../../crates/speedwave-runtime/src/runtime/wsl_egress_guard.sh"

setup() {
    TMP=$(mktemp -d)
    mkdir -p "$TMP/cni" "$TMP/bin"
    printf 'filter\nnat\n' > "$TMP/tables"
    : > "$TMP/state"
    : > "$TMP/calls"
    cat > "$TMP/bin/iptables-legacy" <<'STUB'
#!/bin/sh
[ "$1" = "-w" ] && shift
op="$1"
shift
[ "$1" = "FORWARD" ] && shift
rule="$*"
echo "$op $rule" >> "$STUB_DIR/calls"
case "$op" in
    -C) grep -qxF -- "$rule" "$STUB_DIR/state" ;;
    -I) printf '%s\n' "$rule" > "$STUB_DIR/state.new"; cat "$STUB_DIR/state" >> "$STUB_DIR/state.new"; mv "$STUB_DIR/state.new" "$STUB_DIR/state" ;;
    -D) grep -vxF -- "$rule" "$STUB_DIR/state" > "$STUB_DIR/state.new"; mv "$STUB_DIR/state.new" "$STUB_DIR/state" ;;
    -S) while IFS= read -r l; do printf -- '-A FORWARD %s\n' "$l"; done < "$STUB_DIR/state" ;;
esac
STUB
    chmod +x "$TMP/bin/iptables-legacy"
    export STUB_DIR="$TMP"
    export SPW_EGRESS_CNI_DIR="$TMP/cni"
    export SPW_EGRESS_TABLES_FILE="$TMP/tables"
    export SPW_EGRESS_IPTABLES="$TMP/bin/iptables-legacy"
}

teardown() {
    rm -rf "$TMP"
}

conflist() {
    printf '{"cniVersion":"1.0.0","name":"%s","plugins":[{\n  "type": "bridge",\n  "bridge": "%s",\n  %s\n  "hairpinMode": true\n},{"type":"tuning"}]}\n' "$1" "$2" "$3" > "$TMP/cni/nerdctl-$1.conflist"
}

run_guard() {
    run sh "$GUARD" "${1:-speedwave}" once
    [ "$status" -eq 0 ]
}

inserts() {
    grep -c '^-I ' "$TMP/calls" || true
}

@test "no filter table: no iptables calls" {
    printf 'nat\n' > "$TMP/tables"
    conflist net_a br-0123456789ab '"isGateway": true,'
    run_guard
    [ ! -s "$TMP/calls" ]
}

@test "missing tables file: no iptables calls" {
    rm "$TMP/tables"
    conflist net_a br-0123456789ab '"isGateway": true,'
    run_guard
    [ ! -s "$TMP/calls" ]
}

@test "gateway bridge gets both rules" {
    conflist net_a br-0123456789ab '"isGateway": true,'
    run_guard
    [ "$(inserts)" -eq 2 ]
    grep -qxF -- '-I -i br-0123456789ab -m comment --comment speedwave-egress:speedwave -j ACCEPT' "$TMP/calls"
    grep -qxF -- '-I -o br-0123456789ab -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment speedwave-egress:speedwave -j ACCEPT' "$TMP/calls"
}

@test "internal network gets no rules" {
    conflist net_i br-aaaaaaaaaaaa '"isGateway": false,'
    run_guard
    [ "$(inserts)" -eq 0 ]
    [ ! -s "$TMP/state" ]
}

@test "second pass does not insert duplicates" {
    conflist net_a br-0123456789ab '"isGateway": true,'
    run_guard
    run_guard
    [ "$(inserts)" -eq 2 ]
    [ "$(wc -l < "$TMP/state" | tr -d ' ')" -eq 2 ]
}

@test "stale bridge with own tag is deleted" {
    conflist net_a br-0123456789ab '"isGateway": true,'
    printf '%s\n' \
        '-i br-stale0000000 -m comment --comment speedwave-egress:speedwave -j ACCEPT' \
        '-o br-stale0000000 -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment speedwave-egress:speedwave -j ACCEPT' > "$TMP/state"
    run_guard
    ! grep -q 'br-stale0000000' "$TMP/state"
    grep -q 'br-0123456789ab' "$TMP/state"
}

@test "rules of another instance are untouched" {
    conflist net_a br-0123456789ab '"isGateway": true,'
    printf '%s\n' \
        '-i br-other000000 -m comment --comment speedwave-egress:speedwave-speed-902 -j ACCEPT' \
        '-o br-other000000 -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment speedwave-egress:speedwave-speed-902 -j ACCEPT' > "$TMP/state"
    run_guard
    [ "$(grep -c 'br-other000000' "$TMP/state")" -eq 2 ]
    ! grep -q '^-D ' "$TMP/calls"
}

@test "invalid bridge name is skipped" {
    conflist net_bad 'br;reboot' '"isGateway": true,'
    conflist net_long br-0123456789abcdef '"isGateway": true,'
    run_guard
    [ "$(inserts)" -eq 0 ]
}
