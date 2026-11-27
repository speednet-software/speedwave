#!/bin/sh

_speedwave_export_secret() {
    secret_file="${SPEEDWAVE_SECRETS_DIR:-/run/speedwave/secrets}/$1"
    [ -f "$secret_file" ] || return 0
    secret_value="$(cat "$secret_file" 2>/dev/null)" || return 0
    [ -n "$secret_value" ] || return 0
    export "$2=$secret_value"
}

speedwave_export_secrets() {
    _speedwave_export_secret anthropic-api-key ANTHROPIC_API_KEY
    _speedwave_export_secret anthropic-auth-token ANTHROPIC_AUTH_TOKEN
    _speedwave_export_secret anthropic-custom-headers ANTHROPIC_CUSTOM_HEADERS
    _speedwave_export_secret caller-token SPEEDWAVE_CALLER_TOKEN
    unset secret_file secret_value
}
