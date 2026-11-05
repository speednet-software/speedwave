#!/bin/bash

umask 077

conf_dir="${HOME}/.config/speedwave"
conf_file="${conf_dir}/git-transport.gitconfig"
# shellcheck disable=SC2088
include_path="~/.config/speedwave/git-transport.gitconfig"

warn() {
    echo "git-transport: $*" >&2
}

proxy_url="${SPEEDWAVE_GIT_PROXY_URL%/}"
proxy_auth="${SPEEDWAVE_GIT_PROXY_AUTH:-}"
hosts_raw="${SPEEDWAVE_GIT_HOSTS:-}"

hosts=()
if [ -n "$hosts_raw" ] && [ -n "$proxy_url" ] && [ -n "$proxy_auth" ]; then
    if [[ ! "$proxy_url" =~ ^https?://[A-Za-z0-9._:-]+(/[A-Za-z0-9._~/-]*)?$ ]]; then
        warn "SPEEDWAVE_GIT_PROXY_URL is not a plain http(s) URL, skipping"
    elif [[ ! "$proxy_auth" =~ ^[A-Za-z0-9._~+/=-]+$ ]]; then
        warn "SPEEDWAVE_GIT_PROXY_AUTH has unsupported characters, skipping"
    else
        IFS=',' read -r -a candidates <<< "$hosts_raw"
        for host in ${candidates[@]+"${candidates[@]}"}; do
            [ -n "$host" ] || continue
            if [[ "$host" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
                hosts+=("$host")
            else
                warn "skipping invalid host in SPEEDWAVE_GIT_HOSTS"
            fi
        done
    fi
fi

if [ "${#hosts[@]}" -eq 0 ]; then
    rm -f "$conf_file" 2>/dev/null || warn "could not remove $conf_file"
    exit 0
fi

if ! mkdir -p "$conf_dir" 2>/dev/null; then
    warn "could not create $conf_dir"
    exit 0
fi

tmp="${conf_file}.tmp.$$"
{
    for host in "${hosts[@]}"; do
        printf '[url "%s/%s/"]\n' "$proxy_url" "$host"
        printf '\tinsteadOf = git@%s:\n' "${host%%:*}"
        printf '\tinsteadOf = https://%s/\n' "$host"
    done
    printf '[http "%s/"]\n' "$proxy_url"
    printf '\textraHeader = "x-speedwave-proxy-auth: %s"\n' "$proxy_auth"
} > "$tmp" 2>/dev/null && chmod 600 "$tmp" 2>/dev/null && mv -f "$tmp" "$conf_file" 2>/dev/null
if [ ! -f "$conf_file" ] || [ -e "$tmp" ]; then
    rm -f "$tmp" 2>/dev/null
    warn "could not write $conf_file"
    exit 0
fi

if ! git config --global --get-all include.path 2>/dev/null | grep -Fxq -- "$include_path"; then
    git config --global --add include.path "$include_path" 2>/dev/null || warn "could not add include to ~/.gitconfig"
fi

exit 0
