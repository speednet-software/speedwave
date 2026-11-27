#!/bin/sh

_speedwave_export_secret() {
    secret_file="${SPEEDWAVE_SECRETS_DIR:-/run/speedwave/secrets}/$1"
    [ -f "$secret_file" ] || return 0
    secret_value="$(cat "$secret_file" 2>/dev/null)" || return 0
    [ -n "$secret_value" ] || return 0
    export "$2=$secret_value"
}

# The proxy URL the credential helper is scoped to, validated and without a
# trailing slash. Prints nothing and fails when the variable is unset or not a
# plain http(s) URL. Read by git-transport.sh and by speedwave_export_git_credential_config.
speedwave_git_proxy_url() {
    git_proxy_url="${SPEEDWAVE_GIT_PROXY_URL:-}"
    git_proxy_url="${git_proxy_url%/}"
    case "$git_proxy_url" in
        '' | *[!A-Za-z0-9._~:/-]*) return 1 ;;
    esac
    printf '%s\n' "$git_proxy_url" | grep -Eq '^https?://[A-Za-z0-9._:-]+(/[A-Za-z0-9._~/-]*)?$' || return 1
    printf '%s' "$git_proxy_url"
}

# Puts the credential helper of the git proxy in command-line config scope,
# which git reads after every file and so after every credential.helper a user
# or a repository sets. The empty first value clears the helpers read before it
# (store would write the token to ~/.git-credentials), the second names the
# speedwave helper. Appends after GIT_CONFIG_COUNT entries that already exist.
speedwave_export_git_credential_config() {
    [ -n "${SPEEDWAVE_GIT_HOSTS:-}" ] || return 0
    git_proxy_url="$(speedwave_git_proxy_url)" || return 0
    git_config_count="${GIT_CONFIG_COUNT:-0}"
    case "$git_config_count" in
        '' | *[!0-9]*) git_config_count=0 ;;
    esac
    git_config_key="credential.${git_proxy_url}/.helper"
    export "GIT_CONFIG_KEY_${git_config_count}=${git_config_key}"
    export "GIT_CONFIG_VALUE_${git_config_count}="
    git_config_count=$((git_config_count + 1))
    export "GIT_CONFIG_KEY_${git_config_count}=${git_config_key}"
    export "GIT_CONFIG_VALUE_${git_config_count}=${SPEEDWAVE_GIT_CREDENTIAL_HELPER:-/usr/local/bin/git-credential-speedwave.sh}"
    export GIT_CONFIG_COUNT=$((git_config_count + 1))
    unset git_proxy_url git_config_count git_config_key
}

speedwave_export_secrets() {
    _speedwave_export_secret anthropic-api-key ANTHROPIC_API_KEY
    _speedwave_export_secret anthropic-auth-token ANTHROPIC_AUTH_TOKEN
    _speedwave_export_secret anthropic-custom-headers ANTHROPIC_CUSTOM_HEADERS
    _speedwave_export_secret caller-token SPEEDWAVE_CALLER_TOKEN
    unset secret_file secret_value
    speedwave_export_git_credential_config
}
