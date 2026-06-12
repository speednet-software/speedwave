#!/bin/sh
# Entrypoint for the Speedwave LiteLLM proxy container.
#
# Exports per-provider API keys from the read-only /tokens mount as
# SPW_KEY_<PROVIDER_ID> environment variables, then execs litellm.
#
# Token files are written by speedwave-runtime as
# ~/.speedwave/tokens/<project>/llm/<provider_id>_api_key (0600) and mounted
# at /tokens:ro. provider_id is slug-validated host-side
# (^[a-z][a-z0-9-]{0,63}$); hyphens map to underscores in the env name,
# mirroring derive_worker_env.
#
# INVARIANT (ADR-073): keys must NEVER be exported under canonical provider
# names (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, OPENAI_API_KEY, ...).
# The /anthropic passthrough route forwards the client's Authorization header
# (subscription OAuth) only while the proxy holds no Anthropic credential of
# its own — a canonical name would silently override every passthrough call.
set -eu

TOKENS_DIR="${SPW_TOKENS_DIR:-/tokens}"

if [ -d "$TOKENS_DIR" ]; then
    for token_file in "$TOKENS_DIR"/*_api_key; do
        [ -f "$token_file" ] || continue
        base="$(basename "$token_file")"
        provider_id="${base%_api_key}"
        # Defense in depth: skip names that would not have passed the
        # host-side slug validation (also guards the env-name injection
        # surface). LC_ALL=C because pattern ranges in `case` are
        # locale-collation-dependent and would accept uppercase.
        [ -n "$provider_id" ] || continue
        leftover="$(printf '%s' "$provider_id" | LC_ALL=C tr -d 'a-z0-9-')"
        [ -z "$leftover" ] || continue
        env_name="SPW_KEY_$(printf '%s' "$provider_id" | tr 'a-z-' 'A-Z_')"
        value="$(cat "$token_file")"
        [ -n "$value" ] || continue
        export "$env_name=$value"
    done
fi

exec litellm --config /config/config.yaml --host 0.0.0.0 --port 4000
