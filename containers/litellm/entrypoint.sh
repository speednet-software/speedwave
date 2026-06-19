#!/bin/sh
# Entrypoint for the Speedwave LiteLLM proxy container.
# Exports /tokens/<provider_id>_api_key as SPW_KEY_<PROVIDER_ID>, then execs litellm.
# INVARIANT (ADR-073): keys are NEVER exported under canonical provider names.
set -eu

TOKENS_DIR="${SPW_TOKENS_DIR:-/tokens}"

if [ -d "$TOKENS_DIR" ]; then
    for token_file in "$TOKENS_DIR"/*_api_key; do
        [ -f "$token_file" ] || continue
        base="$(basename "$token_file")"
        provider_id="${base%_api_key}"
        # Skip names that fail the host-side slug shape `^[a-z][a-z0-9-]{0,63}$`.
        [ -n "$provider_id" ] || continue
        case "$(printf '%s' "$provider_id" | cut -c1)" in
            [abcdefghijklmnopqrstuvwxyz]) ;;
            *) continue ;;
        esac
        leftover="$(printf '%s' "$provider_id" | LC_ALL=C tr -d 'a-z0-9-')"
        [ -z "$leftover" ] || continue
        # Slug max length is 64 (^[a-z][a-z0-9-]{0,63}$); printf adds no newline.
        [ "$(printf '%s' "$provider_id" | wc -c)" -le 64 ] || continue
        env_name="SPW_KEY_$(printf '%s' "$provider_id" | tr 'a-z-' 'A-Z_')"
        value="$(cat "$token_file")"
        [ -n "$value" ] || continue
        export "$env_name=$value"
    done
fi

exec litellm --config /config/config.yaml --host 0.0.0.0 --port 4000
