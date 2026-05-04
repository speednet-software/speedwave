#!/usr/bin/env bash
# Stop hook — selective self-review pass before Claude finalizes its response.
#
# Reads the hook input JSON from stdin, locates the conversation transcript
# (JSONL pointed at by `transcript_path`), and decides whether the response
# is worth a second-pass verification:
#
#  1. `stop_hook_active=true` (second attempt) → always allow stop. Without
#     this guard the loop would never terminate.
#  2. Transcript missing or unparseable → fall back to a blocking decision
#     so we err on the side of review.
#  3. Last assistant message already contains an epistemic label
#     (`[Inference]`, `[Speculation]`, `[Unverified]`, `[Verified]`, or their
#     Polish equivalents) → assume the model already applied the discipline
#     and let it stop.
#  4. Otherwise scan for claim-like content: numbers with units (`$15`, `47%`,
#     `v0.40.0`, `200 ms`), absolute terms in English/Polish ("always",
#     "guarantees", "zawsze", "gwarantuje"), or URLs. If any are present and
#     the message is not labelled, block with a review prompt.
#  5. Trivial responses (greetings, short status updates) fall through to
#     `exit 0` — no second pass, no token cost.
#
# Pure bash — no jq dependency, since the claude container does not ship jq
# and adding it just for one hook is wasted image weight.
set -euo pipefail

INPUT=$(cat)

# 1. Loop guard
case "$INPUT" in
    *'"stop_hook_active":true'*|*'"stop_hook_active": true'*)
        exit 0
        ;;
esac

# Helper: emit a `block` decision with the supplied reason and exit.
block() {
    local reason="$1"
    printf '{"decision":"block","reason":"%s"}\n' "$reason"
    exit 0
}

GENERIC_REASON='Self-review before finalizing: re-check each non-trivial claim against the epistemic discipline rules — labels for uncertain content, tool-based verification, two-source rule for external claims, real citations.'

# 2. Extract transcript path. Regex stays restricted to `[^"]*` so a
#    transcript path that itself contains a quote would short-circuit and
#    fall through to the generic block below — fail-safe, not fail-open.
TRANSCRIPT=""
if [[ "$INPUT" =~ \"transcript_path\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    TRANSCRIPT="${BASH_REMATCH[1]}"
fi

if [[ -z "$TRANSCRIPT" || ! -f "$TRANSCRIPT" ]]; then
    block "$GENERIC_REASON"
fi

# 3. Last assistant message line from the JSONL transcript. Claude Code
#    writes one JSON object per line; we don't need to parse the structure
#    fully — a substring match on `"role":"assistant"` is enough to find
#    the candidate line, and the heuristics below run on the raw line.
LAST_ASSISTANT=$(grep '"role":"assistant"' "$TRANSCRIPT" 2>/dev/null | tail -n1 || true)

if [[ -z "$LAST_ASSISTANT" ]]; then
    # No assistant message yet — nothing to review.
    exit 0
fi

# 4. Self-aware short-circuit. If the message already carries an epistemic
#    label, the model has done the work; don't force another pass.
case "$LAST_ASSISTANT" in
    *'[Inference]'*|*'[Speculation]'*|*'[Unverified]'*|*'[Verified]'*)
        exit 0
        ;;
    *'[Wnioskowanie]'*|*'[Spekulacja]'*|*'[Niezweryfikowane]'*|*'[Zweryfikowane]'*)
        exit 0
        ;;
esac

# 5. Heuristic warning signs.
warn=false

# Numbers with units or version/version-like context. Plain digits inside
# words (e.g. JSON keys, hex hashes) don't trigger; we want quantitative
# claims — currency, percentages, version strings, byte/time/token counts.
if [[ "$LAST_ASSISTANT" =~ \\\"\\\$[0-9] ]] \
    || echo "$LAST_ASSISTANT" | grep -qE '\$[0-9]+|[0-9]+(\.[0-9]+)?%|v[0-9]+\.[0-9]+|[0-9]+[[:space:]]*(ms|s|MB|GB|KB|tokens?|tokenów|users|userów|userzy|requests|users/s|req/s)\b'; then
    warn=true
fi

# Absolute / overconfident terms (EN + PL). The output style already bans
# these without citation, so their presence in an unlabelled response is a
# strong signal the model didn't self-edit.
if echo "$LAST_ASSISTANT" | grep -qiE '\b(always|never|guarantees?|ensures?|prevents?|eliminates?|will never|fixes)\b'; then
    warn=true
fi
if echo "$LAST_ASSISTANT" | grep -qE '\b(zawsze|nigdy|gwarantuje|gwarantują|zapewnia|zapewniają|zapobiega|zapobiegają|eliminuje|eliminują)\b'; then
    warn=true
fi

# URLs. Real or hallucinated — both deserve verification.
if echo "$LAST_ASSISTANT" | grep -qE 'https?://[^[:space:]\"]+' ; then
    warn=true
fi

if $warn; then
    block 'Self-review: response contains claim-like content (numbers, absolutes, or URLs). Verify each is supported, label uncertainty, cite per-claim, and apply the two-source rule for non-trivial external claims.'
fi

exit 0
