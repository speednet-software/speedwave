#!/bin/sh
instance="${1:?instance name required}"
mode="${2:-loop}"
tag="speedwave-egress:${instance}"
cni_dir="${SPW_EGRESS_CNI_DIR:-/etc/cni/net.d}"
tables_file="${SPW_EGRESS_TABLES_FILE:-/proc/net/ip_tables_names}"
ipt="${SPW_EGRESS_IPTABLES:-iptables-legacy}"

valid_bridge() {
    case "$1" in
        '' | *[!A-Za-z0-9_.-]*) return 1 ;;
    esac
    [ "${#1}" -le 15 ]
}

wanted_bridges() {
    for conf in "$cni_dir"/nerdctl-*.conflist; do
        [ -f "$conf" ] || continue
        grep -q '"isGateway"[[:space:]]*:[[:space:]]*true' "$conf" || continue
        name=$(sed -n 's/.*"bridge"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$conf" | head -n 1)
        valid_bridge "$name" && printf '%s\n' "$name"
    done
}

tagged_bridges() {
    "$ipt" -w -S FORWARD 2>/dev/null | while IFS= read -r line; do
        set -f
        # shellcheck disable=SC2086
        set -- $line
        set +f
        own=0
        bridge=""
        prev=""
        for tok in "$@"; do
            case "$tok" in
                "$tag" | "\"$tag\"") own=1 ;;
            esac
            case "$prev" in
                -i | -o) bridge="$tok" ;;
            esac
            prev="$tok"
        done
        if [ "$own" = 1 ] && valid_bridge "$bridge"; then
            printf '%s\n' "$bridge"
        fi
    done
}

ensure_rule() {
    "$ipt" -w -C FORWARD "$@" 2>/dev/null || "$ipt" -w -I FORWARD "$@"
}

remove_rule() {
    "$ipt" -w -D FORWARD "$@" 2>/dev/null || true
}

apply_bridge() {
    ensure_rule -i "$1" -m comment --comment "$tag" -j ACCEPT
    ensure_rule -o "$1" -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment "$tag" -j ACCEPT
}

drop_bridge() {
    remove_rule -i "$1" -m comment --comment "$tag" -j ACCEPT
    remove_rule -o "$1" -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment "$tag" -j ACCEPT
}

pass() {
    grep -qx 'filter' "$tables_file" 2>/dev/null || return 0
    wanted=$(wanted_bridges | sort -u)
    for bridge in $wanted; do
        apply_bridge "$bridge"
    done
    for bridge in $(tagged_bridges | sort -u); do
        case "
$wanted
" in
            *"
$bridge
"*) ;;
            *) drop_bridge "$bridge" ;;
        esac
    done
}

if [ "$mode" = once ]; then
    pass
    exit 0
fi

while true; do
    pass
    sleep 10
done
