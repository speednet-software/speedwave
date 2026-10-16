#!/usr/bin/env bats

SCRIPT="$BATS_TEST_DIRNAME/../../scripts/e2e-vm.sh"

@test "ps_squote doubles single quotes for PowerShell literals" {
    eval "$(sed -n '/^ps_squote()/,/^}/p' "$SCRIPT")"
    [ "$(ps_squote "plain")" = "plain" ]
    [ "$(ps_squote "")" = "" ]
    [ "$(ps_squote "o'brien")" = "o''brien" ]
    [ "$(ps_squote "a'b'c")" = "a''b''c" ]
    [ "$(ps_squote "'; calc; '")" = "''; calc; ''" ]
}
