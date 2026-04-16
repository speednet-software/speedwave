#!/usr/bin/env bash
# Automated plan → review → implement → verify → code-review loop.
#
# Creates an isolated git worktree + branch, then:
# Phase 1: Writer creates plan, reviewer iterates until READY_TO_IMPLEMENT.
# Phase 2: Implementer codes from plan, verifier checks 100% implementation + tests.
# Phase 3: 13-agent code review on the diff. If critical/important issues found,
#           implementer fixes + re-verify, then code-review again.
#
# Usage: plan-loop.sh <task description> [options]
#   --max-iter N          Phase 1: max write→review iterations (default 8)
#   --max-impl-iter N     Phase 2: max implement→verify iterations (default 5)
#   --max-review-iter N   Phase 3: max code-review→fix iterations (default 3)
#                         NOTE: --max-iter, --max-impl-iter, --max-review-iter must be >= 1
#   --plan-name NAME      Plan filename stem and branch suffix (default: YYYY-MM-DD-plan)
#   --plan-only           Run Phase 1 only (no implementation)
#   --impl-only <path>    Run Phase 2 only (plan already exists at <path>)
#   --skip-review         Skip Phase 3 (code review after implementation)
#   --no-worktree         Skip worktree creation, work in current directory
#   --branch NAME         Branch name (default: feat/<plan-name>)
#   --base BRANCH         Base branch for worktree (default: origin/dev)
#
# Requires: claude (Claude Code CLI), jq, perl, git

set -euo pipefail

# --- Parse arguments ---

TASK=""
PLAN_ONLY=false
IMPL_ONLY=""
NO_WORKTREE=false
SKIP_REVIEW=false
BRANCH_NAME=""
BASE_BRANCH="origin/dev"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --max-iter)        MAX_ITERATIONS="$2"; shift 2 ;;
        --max-impl-iter)   MAX_IMPL_ITERATIONS="$2"; shift 2 ;;
        --max-review-iter) MAX_REVIEW_ITERATIONS="$2"; shift 2 ;;
        --plan-name)       PLAN_NAME="$2"; shift 2 ;;
        --plan-only)       PLAN_ONLY=true; shift ;;
        --impl-only)       IMPL_ONLY="$2"; shift 2 ;;
        --skip-review)     SKIP_REVIEW=true; shift ;;
        --no-worktree)     NO_WORKTREE=true; shift ;;
        --branch)          BRANCH_NAME="$2"; shift 2 ;;
        --base)            BASE_BRANCH="$2"; shift 2 ;;
        *)
            if [[ -z "$TASK" ]]; then TASK="$1"; else TASK="$TASK $1"; fi
            shift ;;
    esac
done

if [[ -z "$TASK" && -z "$IMPL_ONLY" ]]; then
    echo "Usage: plan-loop.sh <task> [options]" >&2
    echo "Options: --max-iter N, --max-impl-iter N, --max-review-iter N, --plan-name NAME," >&2
    echo "         --plan-only, --impl-only <path>, --skip-review, --no-worktree," >&2
    echo "         --branch NAME, --base BRANCH" >&2
    exit 1
fi

MAX_ITER="${MAX_ITERATIONS:-8}"
MAX_IMPL_ITER="${MAX_IMPL_ITERATIONS:-5}"
MAX_REVIEW_ITER="${MAX_REVIEW_ITERATIONS:-3}"
PLAN_NAME="${PLAN_NAME:-$(date +%Y-%m-%d-%H%M%S)-plan}"
BRANCH_NAME="${BRANCH_NAME:-feat/${PLAN_NAME}}"
PLAN_DIR="${TMPDIR:-/tmp}/speedwave-plans"
PLAN_PATH="${IMPL_ONLY:-${PLAN_DIR}/${PLAN_NAME}.md}"

# Resolve PROJECT_ROOT and SCRIPT_DIR from the original repo (before worktree)
PROJECT_ROOT="$(git rev-parse --show-toplevel)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REVIEW_SCHEMA_FILE="$SCRIPT_DIR/plan-loop-review-schema.json"
VERIFY_SCHEMA_FILE="$SCRIPT_DIR/plan-loop-verify-schema.json"
CODE_REVIEW_SCHEMA_FILE="$SCRIPT_DIR/plan-loop-code-review-schema.json"

WRITER_SKILL_DIR="$PROJECT_ROOT/.claude/skills/speedwave-write-plan"
REVIEWER_SKILL_DIR="$PROJECT_ROOT/.claude/skills/speedwave-review-plan"
IMPLEMENTER_SKILL_DIR="$PROJECT_ROOT/.claude/skills/speedwave-implement-plan"
VERIFIER_SKILL_DIR="$PROJECT_ROOT/.claude/skills/speedwave-verify-plan"
CODE_REVIEW_SKILL_DIR="$PROJECT_ROOT/.claude/skills/speedwave-code-review"

WORKTREE_DIR="${TMPDIR:-/tmp}/speedwave-loop-${PLAN_NAME}"
WORKTREE_CREATED=false

MAX_RETRY=2
RETRY_WAIT=60

PLANNING_TOOLS='Bash(git *),Bash(make *),Bash(gh *),Read,Glob,Grep,Agent'
VERIFIER_TOOLS='Bash(git *),Bash(make *),Bash(gh *),Read,Glob,Grep,Agent'

# --- Colors ---

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

# --- Dependency freshness ---
#
# Delegates to `make install-deps` (= setup-dev) — the Makefile is the SSOT for
# provisioning the workspace: cargo fetch + npm install in every npm subproject
# including mcp-servers/* sub-packages where tsc lives. A hand-rolled npm-ci
# loop would miss those and fail at build-mcp. The state file caches the
# aggregate hash of all package-lock.json files; reruns skip when nothing
# changed.

LOCK_STATE_FILE=""

# Portable SHA-256: prefer sha256sum (coreutils, default on Linux), fall back
# to shasum -a 256 (macOS / systems shipping Perl's shasum). Resolved once at
# start; the absence of both yields an empty SHA_CMD, which aggregate_lock_hash
# treats as "state unknown → reinstall".
if command -v sha256sum >/dev/null 2>&1; then
    SHA_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
    SHA_CMD="shasum -a 256"
else
    SHA_CMD=""
fi

aggregate_lock_hash() {
    local root="$1"
    [[ -z "$SHA_CMD" ]] && return 0
    find "$root" -name package-lock.json -not -path '*/node_modules/*' -print0 2>/dev/null \
        | xargs -0 $SHA_CMD 2>/dev/null \
        | awk '{print $1}' \
        | sort \
        | $SHA_CMD \
        | awk '{print $1}'
}

ensure_deps_fresh() {
    local root="$1"
    local state_file="$2"

    local agg
    agg=$(aggregate_lock_hash "$root")

    local prev=""
    if [[ -f "$state_file" ]]; then
        prev=$(cat "$state_file")
    fi

    if [[ -n "$agg" && "$agg" == "$prev" ]]; then
        printf "  ${DIM}npm deps unchanged, skipping install${NC}\n"
        return 0
    fi

    printf "  ${CYAN}Running make install-deps (may take a few minutes)...${NC}\n"
    if ! (cd "$root" && make install-deps 2>&1 | tail -12 | sed 's/^/    /'); then
        printf "  ${RED}ERROR: make install-deps failed${NC}\n" >&2
        return 1
    fi
    printf '%s' "$agg" > "$state_file"
    return 0
}

# --- Validate prerequisites ---

for cmd in claude jq perl; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "ERROR: '$cmd' not found in PATH" >&2
        exit 1
    fi
done

if [[ -z "$IMPL_ONLY" ]]; then
    for f in "$WRITER_SKILL_DIR/SKILL.md" "$REVIEWER_SKILL_DIR/SKILL.md" "$REVIEW_SCHEMA_FILE"; do
        if [[ ! -f "$f" ]]; then
            echo "ERROR: Required file not found: $f" >&2
            exit 1
        fi
    done
fi

if [[ "$PLAN_ONLY" != "true" ]]; then
    if [[ ! -f "$VERIFY_SCHEMA_FILE" ]]; then
        echo "ERROR: Required file not found: $VERIFY_SCHEMA_FILE" >&2
        exit 1
    fi
fi

if [[ "$PLAN_ONLY" != "true" && "$SKIP_REVIEW" != "true" ]]; then
    for f in "$CODE_REVIEW_SKILL_DIR/SKILL.md" "$CODE_REVIEW_SCHEMA_FILE"; do
        if [[ ! -f "$f" ]]; then
            echo "ERROR: Required file not found: $f" >&2
            exit 1
        fi
    done
fi

# --- Functions ---

# Extract prompt body from a SKILL.md file.
# For writer/reviewer skills: content is between 3rd and 4th '---' separator.
# For simpler skills (implement/verify): content is after the 2nd '---' (frontmatter end).
# Replaces $ARGUMENTS with task_text.
extract_prompt() {
    local skill_dir="$1"
    local task_text="$2"
    local skill_file="$skill_dir/SKILL.md"

    local dash_count
    dash_count=$(grep -c '^---$' "$skill_file")

    if [[ $dash_count -ge 4 ]]; then
        # Writer/reviewer: content between 3rd and 4th ---
        awk '
            /^---$/ { dc++; next }
            dc == 3 && !done { print; next }
            dc >= 4 { done = 1 }
        ' "$skill_file"
    else
        # Simple skill: content after frontmatter (2nd ---)
        awk '
            /^---$/ { dc++; next }
            dc >= 2 { print }
        ' "$skill_file"
    fi | TASK_TEXT="$task_text" perl -pe 's/\$ARGUMENTS/$ENV{TASK_TEXT}/g'
}

run_claude_stream() {
    local output_file="$1"
    shift
    local attempt=0

    while [[ $attempt -le $MAX_RETRY ]]; do
        claude "$@" --output-format stream-json --verbose 2>/dev/null \
          | jq -r --unbuffered '
              if .type == "result" then "RESULT\t" + (. | tojson)
              elif .type == "assistant" then
                (.message.content[]? | select(.type == "tool_use") |
                  "TOOL\t" + .name + "\t" + (
                    .input |
                    if .file_path then .file_path
                    elif .pattern then .pattern
                    elif .command then (.command | split("\n") | .[0] | .[0:80])
                    else (tostring | .[0:80])
                    end
                  )
                ) // empty
              else empty end
            ' 2>/dev/null \
          | while IFS=$'\t' read -r ev_type ev_data ev_extra; do
            case "$ev_type" in
                RESULT)
                    echo "$ev_data" > "$output_file"
                    ;;
                TOOL)
                    printf "    ${DIM}▸ %s %s${NC}\n" "$ev_data" "$ev_extra"
                    ;;
            esac
        done

        if [[ -f "$output_file" ]] && [[ -s "$output_file" ]]; then
            return 0
        fi

        attempt=$((attempt + 1))
        if [[ $attempt -le $MAX_RETRY ]]; then
            printf "  ${YELLOW}Failed, retrying in ${RETRY_WAIT}s (attempt $attempt/${MAX_RETRY})...${NC}\n" >&2
            sleep "$RETRY_WAIT"
        fi
    done

    printf "  ${RED}Failed after $((MAX_RETRY + 1)) attempts${NC}\n" >&2
    return 1
}

get_session_id() { jq -r '.session_id // empty' "$1" 2>/dev/null; }
get_result_text() { jq -r '.result // empty' "$1" 2>/dev/null | sed -n '/^#/,$p'; }

# --- System prompts ---

if [[ -z "$IMPL_ONLY" ]]; then
    WRITER_PREAMBLE="You are running in headless mode (claude -p). You are READ-ONLY — you have no Write, Edit, or file-creation tools.

CRITICAL INSTRUCTION: Your text response IS the plan. The orchestrator script captures your response and saves it to disk. So you must output the COMPLETE plan as your final text response — every section, every detail, no summaries, no abbreviations.

Do NOT use EnterPlanMode, ExitPlanMode, AskUserQuestion, Write, or Edit.
Do NOT say things like 'I have written the plan' or 'the plan is ready' — just output the plan itself.
Do NOT output anything before or after the plan — no preamble, no summary, just the plan document starting with the first heading."

    REVIEWER_PREAMBLE="You are running in headless mode (claude -p). You are READ-ONLY.
Do NOT use EnterPlanMode, ExitPlanMode, or AskUserQuestion.
Read the plan from the file path specified in the user prompt.
Your output will be captured as structured JSON via --json-schema.
The findings_summary field MUST be detailed enough for the plan writer to fix every issue WITHOUT reading your full analysis. Include specific fix instructions for each finding.
The new_issue_count field must reflect how many issues you are reporting that were NOT mentioned in any previous review context provided in the user prompt. If this is the first review (no previous context), set it equal to the total number of findings."

    WRITER_BODY="$(extract_prompt "$WRITER_SKILL_DIR" "$TASK")"
    REVIEWER_BODY="$(extract_prompt "$REVIEWER_SKILL_DIR" "$TASK")"
    WRITER_SYSTEM_PROMPT="${WRITER_PREAMBLE}

${WRITER_BODY}"
    REVIEWER_SYSTEM_PROMPT="${REVIEWER_PREAMBLE}

${REVIEWER_BODY}"
    REVIEW_SCHEMA="$(cat "$REVIEW_SCHEMA_FILE")"
fi

IMPLEMENTER_PREAMBLE="You are running in headless mode (claude -p). You have full tool access.
Do NOT use AskUserQuestion — it is unavailable."

VERIFIER_PREAMBLE="You are running in headless mode (claude -p). You are READ-ONLY (except for running make check/test).
Do NOT use AskUserQuestion — it is unavailable.
Your output will be captured as structured JSON via --json-schema.
The gaps_summary field MUST be specific enough for the implementer to fix every gap WITHOUT reading your full analysis."

VERIFY_SCHEMA="$(cat "$VERIFY_SCHEMA_FILE")"
CODE_REVIEW_SCHEMA="$(cat "$CODE_REVIEW_SCHEMA_FILE")"

# NOTE: IMPLEMENTER_BODY and VERIFIER_BODY are computed after Phase 0
# (worktree setup) so they read from the correct skill paths.

# --- Temp files & cleanup ---

TMPDIR_LOOP=$(mktemp -d)
RESULT_FILE="$TMPDIR_LOOP/result.json"

WRITER_SESSION_ID=""
IMPL_SESSION_ID=""

cleanup() {
    pkill -P $$ 2>/dev/null || true
    rm -rf "$TMPDIR_LOOP"
    printf "\n"
    echo "Interrupted. Plan: $PLAN_PATH"
    [[ -n "$WRITER_SESSION_ID" ]] && echo "Writer session: $WRITER_SESSION_ID"
    [[ -n "$IMPL_SESSION_ID" ]] && echo "Implementer session: $IMPL_SESSION_ID"
    if [[ "$WORKTREE_CREATED" == "true" ]]; then
        echo "Worktree: $WORKTREE_DIR (branch: $BRANCH_NAME)"
        echo "To resume: cd $WORKTREE_DIR"
        echo "To cleanup: git -C $PROJECT_ROOT worktree remove $WORKTREE_DIR"
    fi
    exit 130
}
trap cleanup INT TERM

mkdir -p "$(dirname "$PLAN_PATH")"

# ═══════════════════════════════════════════════════════════════
# PHASE 0: WORKTREE SETUP
# ═══════════════════════════════════════════════════════════════

if [[ "$NO_WORKTREE" != "true" && -z "$IMPL_ONLY" ]]; then
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║  PHASE 0: WORKTREE SETUP                                    ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""

    # Fetch latest base
    printf "  ${DIM}Fetching $BASE_BRANCH...${NC}\n"
    git -C "$PROJECT_ROOT" fetch origin 2>/dev/null || true

    # Remove stale worktree if exists
    if [[ -d "$WORKTREE_DIR" ]]; then
        printf "  ${YELLOW}Removing stale worktree at $WORKTREE_DIR${NC}\n"
        git -C "$PROJECT_ROOT" worktree remove --force "$WORKTREE_DIR" 2>/dev/null || rm -rf "$WORKTREE_DIR"
    fi

    # Delete branch if it exists (leftover from previous run)
    if git -C "$PROJECT_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH_NAME" 2>/dev/null; then
        if git -C "$PROJECT_ROOT" merge-base --is-ancestor "$BRANCH_NAME" "$BASE_BRANCH" 2>/dev/null; then
            printf "  ${YELLOW}Deleting existing branch $BRANCH_NAME (already merged)${NC}\n"
            git -C "$PROJECT_ROOT" branch -D "$BRANCH_NAME" 2>/dev/null || true
        else
            printf "  ${RED}ERROR: Branch $BRANCH_NAME exists with unmerged commits. Use --branch to pick a different name.${NC}\n" >&2
            exit 1
        fi
    fi

    # Create worktree with new branch
    printf "  ${CYAN}Creating worktree:${NC} $WORKTREE_DIR\n"
    printf "  ${CYAN}Branch:${NC} $BRANCH_NAME (from $BASE_BRANCH)\n"
    git -C "$PROJECT_ROOT" worktree add -b "$BRANCH_NAME" "$WORKTREE_DIR" "$BASE_BRANCH" 2>&1 | sed 's/^/  /'

    WORKTREE_CREATED=true

    # Update PROJECT_ROOT to worktree — all subsequent work happens there
    PROJECT_ROOT="$WORKTREE_DIR"

    # Re-resolve skill dirs relative to new worktree
    WRITER_SKILL_DIR="$PROJECT_ROOT/.claude/skills/speedwave-write-plan"
    REVIEWER_SKILL_DIR="$PROJECT_ROOT/.claude/skills/speedwave-review-plan"
    IMPLEMENTER_SKILL_DIR="$PROJECT_ROOT/.claude/skills/speedwave-implement-plan"
    VERIFIER_SKILL_DIR="$PROJECT_ROOT/.claude/skills/speedwave-verify-plan"
    CODE_REVIEW_SKILL_DIR="$PROJECT_ROOT/.claude/skills/speedwave-code-review"

    echo ""
    printf "  ${GREEN}Worktree ready${NC}\n"
    echo ""

    # Stored inside TMPDIR_LOOP so it doesn't show up as untracked in the
    # worktree — otherwise the implementation agent sees a stray file in
    # git status and may try to clean it up.
    LOCK_STATE_FILE="$TMPDIR_LOOP/lock-hashes"
    printf "  ${CYAN}Checking npm dependencies...${NC}\n"
    if ! ensure_deps_fresh "$PROJECT_ROOT" "$LOCK_STATE_FILE"; then
        rm -rf "$TMPDIR_LOOP" 2>/dev/null || true
        exit 1
    fi
    echo ""
else
    if [[ -n "$IMPL_ONLY" ]]; then
        printf "  ${DIM}Skipping worktree (--impl-only mode)${NC}\n"
    elif [[ "$NO_WORKTREE" == "true" ]]; then
        printf "  ${DIM}Skipping worktree (--no-worktree)${NC}\n"
    fi
fi

# Re-extract prompts after worktree may have changed PROJECT_ROOT
IMPLEMENTER_BODY="$(extract_prompt "$IMPLEMENTER_SKILL_DIR" "$PLAN_PATH")"
VERIFIER_BODY="$(extract_prompt "$VERIFIER_SKILL_DIR" "$PLAN_PATH")"
IMPLEMENTER_SYSTEM_PROMPT="${IMPLEMENTER_PREAMBLE}

${IMPLEMENTER_BODY}"
VERIFIER_SYSTEM_PROMPT="${VERIFIER_PREAMBLE}

${VERIFIER_BODY}"

cd "$PROJECT_ROOT"

# ═══════════════════════════════════════════════════════════════
# PHASE 1: WRITE → REVIEW
# ═══════════════════════════════════════════════════════════════

if [[ -z "$IMPL_ONLY" ]]; then

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  PHASE 1: PLAN — write → review                              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Task:       $TASK"
echo "  Plan:       $PLAN_PATH"
echo "  Max iter:   $MAX_ITER"
echo ""

iteration=0
verdict="UNKNOWN"
REVIEW_FEEDBACK=""
PREV_VERDICT_TABLE=""
PREV_FINDINGS=""
PREV_HIGH_COUNT=0

# Safety cap: accept with warnings when stuck near MAX_ITER.
# Floor at 4 so that low --max-iter values (3, 4) don't trigger on the first iterations.
if [[ $MAX_ITER -gt 4 ]]; then
    SAFETY_CAP=$((MAX_ITER - 2))
else
    SAFETY_CAP=$MAX_ITER
fi

while [[ $iteration -lt $MAX_ITER ]]; do
    iteration=$((iteration + 1))

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    printf "  ${BOLD}Iteration $iteration / $MAX_ITER${NC}\n"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # ===================== WRITER =====================
    echo ""
    rm -f "$RESULT_FILE"
    write_start=$(date +%s)

    if [[ $iteration -eq 1 ]]; then
        printf "  ${CYAN}[writer]${NC} Creating initial plan...\n"

        run_claude_stream "$RESULT_FILE" \
            -p "Write an implementation plan for the following task. Output the COMPLETE plan as your text response.

Task: $TASK" \
            --model opus \
            --effort max \
            --allowed-tools "$PLANNING_TOOLS" \
            --append-system-prompt "$WRITER_SYSTEM_PROMPT" || {
            printf "  ${RED}[writer] FAILED${NC}\n" >&2
            rm -rf "$TMPDIR_LOOP"; exit 1
        }

        WRITER_SESSION_ID="$(get_session_id "$RESULT_FILE")"
        [[ -n "$WRITER_SESSION_ID" ]] && printf "  ${DIM}Session: $WRITER_SESSION_ID${NC}\n"
    else
        printf "  ${CYAN}[writer]${NC} Revising plan (resuming session)...\n"

        local_ok=false
        if [[ -n "$WRITER_SESSION_ID" ]]; then
            if run_claude_stream "$RESULT_FILE" \
                -p "The reviewer found issues. Output the COMPLETE revised plan as text, addressing ALL findings:

$REVIEW_FEEDBACK" \
                --model opus \
                --effort max \
                --resume "$WRITER_SESSION_ID" \
                --allowed-tools "$PLANNING_TOOLS"; then
                local_ok=true
            else
                printf "  ${YELLOW}Resume failed, falling back to new session${NC}\n"
                WRITER_SESSION_ID=""
            fi
        fi

        if [[ "$local_ok" != "true" ]]; then
            rm -f "$RESULT_FILE"
            run_claude_stream "$RESULT_FILE" \
                -p "Revise this implementation plan to address ALL review findings. Read the current plan at $PLAN_PATH, then output the COMPLETE revised plan as text.

Review findings:
$REVIEW_FEEDBACK" \
                --model opus \
                --effort max \
                --allowed-tools "$PLANNING_TOOLS" \
                --append-system-prompt "$WRITER_SYSTEM_PROMPT" || {
                printf "  ${RED}[writer] FAILED${NC}\n" >&2
                rm -rf "$TMPDIR_LOOP"; exit 1
            }
            WRITER_SESSION_ID="$(get_session_id "$RESULT_FILE")"
        fi
    fi

    write_end=$(date +%s)

    plan_text="$(get_result_text "$RESULT_FILE")"
    if [[ -z "$plan_text" ]]; then
        printf "  ${RED}[writer] ERROR: Empty response${NC}\n" >&2
        rm -rf "$TMPDIR_LOOP"; exit 1
    fi
    echo "$plan_text" > "$PLAN_PATH"

    plan_lines=$(wc -l < "$PLAN_PATH")
    printf "  ${GREEN}[writer] Done${NC} ($((write_end - write_start))s, ${plan_lines} lines) → $PLAN_PATH\n"

    # ===================== REVIEWER =====================
    echo ""

    # Build reviewer prompt: verification mode for iteration 3+
    if [[ $iteration -le 2 || -z "$PREV_FINDINGS" ]]; then
        REVIEWER_PROMPT="Review the implementation plan at: $PLAN_PATH"
        printf "  ${CYAN}[reviewer]${NC} Reviewing plan (full scan)...\n"
    else
        REVIEWER_PROMPT="Review the implementation plan at: $PLAN_PATH

IMPORTANT — VERIFICATION MODE (iteration $iteration):
This plan has been reviewed $((iteration - 1)) times. The previous review found these issues:

--- PREVIOUS FINDINGS ---
$PREV_FINDINGS
--- PREVIOUS VERDICT TABLE ---
$PREV_VERDICT_TABLE
---

Primary task: verify whether the issues above have been FIXED.
Only report NEW issues if they are BLOCKER or HIGH severity."
        printf "  ${CYAN}[reviewer]${NC} Reviewing plan (verification mode)...\n"
    fi

    rm -f "$RESULT_FILE"
    review_start=$(date +%s)

    run_claude_stream "$RESULT_FILE" \
        -p "$REVIEWER_PROMPT" \
        --model opus \
        --effort max \
        --no-session-persistence \
        --allowed-tools "$PLANNING_TOOLS" \
        --append-system-prompt "$REVIEWER_SYSTEM_PROMPT" \
        --json-schema "$REVIEW_SCHEMA" || {
        printf "  ${RED}[reviewer] FAILED${NC}\n" >&2
        rm -rf "$TMPDIR_LOOP"; exit 1
    }

    review_end=$(date +%s)

    verdict=$(jq -r '.structured_output.overall_verdict // "UNKNOWN"' "$RESULT_FILE" 2>/dev/null)
    blocker_count=$(jq -r '.structured_output.blocker_count // 0' "$RESULT_FILE" 2>/dev/null)
    high_count=$(jq -r '.structured_output.high_count // 0' "$RESULT_FILE" 2>/dev/null)
    medium_count=$(jq -r '.structured_output.medium_count // 0' "$RESULT_FILE" 2>/dev/null)
    low_count=$(jq -r '.structured_output.low_count // 0' "$RESULT_FILE" 2>/dev/null)
    findings=$(jq -r '.structured_output.findings_summary // ""' "$RESULT_FILE" 2>/dev/null)
    verdict_table=$(jq -r '.structured_output.verdict_table // ""' "$RESULT_FILE" 2>/dev/null)
    full_review=$(jq -r '.result // ""' "$RESULT_FILE" 2>/dev/null)
    # Fallback -1 = "unknown/parse error". The convergence check uses -eq 0,
    # so -1 correctly prevents premature acceptance when extraction fails.
    new_issue_count=$(jq -r '.structured_output.new_issue_count // -1' "$RESULT_FILE" 2>/dev/null)

    printf "  ${GREEN}[reviewer] Done${NC} ($((review_end - review_start))s)\n"
    echo ""
    printf "  ${BOLD}Verdict:  $verdict${NC}\n"
    echo "  Issues:   blockers=$blocker_count  high=$high_count  medium=$medium_count  low=$low_count  new=$new_issue_count"

    [[ -n "$verdict_table" && "$verdict_table" != "null" ]] && echo "" && echo "$verdict_table"

    review_file="${PLAN_PATH%.md}.review-${iteration}.md"
    [[ -n "$full_review" && "$full_review" != "null" ]] && echo "$full_review" > "$review_file" && printf "\n  ${DIM}Review saved: $review_file${NC}\n"

    # Convergence: after iteration 4, accept if no new issues, HIGH count stable and <= 2.
    # Prevents accepting plans that stabilised at many unresolved HIGH issues.
    if [[ $iteration -ge 4 && "$verdict" != "READY_TO_IMPLEMENT" && "$blocker_count" -eq 0 ]]; then
        if [[ "$new_issue_count" -eq 0 && "$high_count" -le "$PREV_HIGH_COUNT" && "$high_count" -le 2 ]]; then
            printf "\n  ${YELLOW}[convergence] No new issues, high_count stable (≤2) — accepting plan${NC}\n"
            verdict="READY_TO_IMPLEMENT"
        fi
    fi

    # Hard safety cap: accept with warnings if no blockers and HIGH issues bounded.
    # SAFETY_CAP is computed before the loop (MAX_ITER - 2, floor 4).
    # Plans with >5 HIGH issues are NOT accepted — they exit with failure at MAX_ITER.
    if [[ $iteration -ge $SAFETY_CAP && "$verdict" != "READY_TO_IMPLEMENT" && "$blocker_count" -eq 0 && "$high_count" -le 5 ]]; then
        printf "\n  ${YELLOW}[convergence] Safety cap at iteration $iteration/$MAX_ITER — accepting with $high_count remaining HIGH issues${NC}\n"
        verdict="READY_TO_IMPLEMENT"
    fi

    # Store review context for next iteration
    PREV_VERDICT_TABLE="$verdict_table"
    PREV_FINDINGS="$findings"
    PREV_HIGH_COUNT="$high_count"

    # Sanity check: reviewer may return READY_TO_IMPLEMENT while also reporting
    # blockers (schema does not enforce the correlation). Reject that combo — a
    # plan with BLOCKERS is never ready to implement regardless of what the
    # model claims in the verdict field.
    if [[ "$verdict" == "READY_TO_IMPLEMENT" && "$blocker_count" -gt 0 ]]; then
        printf "\n  ${RED}[sanity] Reviewer returned READY_TO_IMPLEMENT with $blocker_count blocker(s) — demoting to NEEDS_REVISION${NC}\n"
        verdict="NEEDS_REVISION"
    fi

    if [[ "$verdict" == "READY_TO_IMPLEMENT" ]]; then
        echo ""
        if [[ "$high_count" -gt 0 ]]; then
            printf "${YELLOW}╔══════════════════════════════════════════════════════════════╗${NC}\n"
            printf "${YELLOW}║  PLAN ACCEPTED after $iteration iteration(s) ($high_count HIGH remaining)${NC}\n"
            printf "${YELLOW}║  Plan: $PLAN_PATH${NC}\n"
            printf "${YELLOW}╚══════════════════════════════════════════════════════════════╝${NC}\n"
        else
            printf "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}\n"
            printf "${GREEN}║  PLAN APPROVED after $iteration iteration(s)${NC}\n"
            printf "${GREEN}║  Plan: $PLAN_PATH${NC}\n"
            printf "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}\n"
        fi
        break
    fi

    REVIEW_FEEDBACK="$findings"
    [[ -z "$REVIEW_FEEDBACK" || "$REVIEW_FEEDBACK" == "null" ]] && REVIEW_FEEDBACK="$full_review"
    echo ""
done

if [[ "$verdict" != "READY_TO_IMPLEMENT" ]]; then
    printf "\n${YELLOW}╔══════════════════════════════════════════════════════════════╗${NC}\n"
    printf "${YELLOW}║  Phase 1: MAX ITERATIONS ($MAX_ITER) — verdict: $verdict${NC}\n"
    printf "${YELLOW}║  Plan: $PLAN_PATH${NC}\n"
    printf "${YELLOW}╚══════════════════════════════════════════════════════════════╝${NC}\n"
    rm -rf "$TMPDIR_LOOP"
    exit 1
fi

if [[ "$PLAN_ONLY" == "true" ]]; then
    rm -rf "$TMPDIR_LOOP"
    exit 0
fi

fi # end of Phase 1 (skipped if --impl-only)

# ═══════════════════════════════════════════════════════════════
# PHASE 2: IMPLEMENT → VERIFY
# ═══════════════════════════════════════════════════════════════

if [[ ! -f "$PLAN_PATH" ]]; then
    printf "${RED}ERROR: Plan file not found: $PLAN_PATH${NC}\n" >&2
    rm -rf "$TMPDIR_LOOP"; exit 1
fi

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  PHASE 2: IMPLEMENT → VERIFY                                ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Plan:           $PLAN_PATH"
echo "  Max impl iter:  $MAX_IMPL_ITER"
echo ""

impl_iteration=0
v_verdict="UNKNOWN"
v_steps=0
v_total=0
v_check=false
v_test=false
IMPL_FEEDBACK=""

while [[ $impl_iteration -lt $MAX_IMPL_ITER ]]; do
    impl_iteration=$((impl_iteration + 1))

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    printf "  ${BOLD}Iteration $impl_iteration / $MAX_IMPL_ITER${NC}\n"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # ===================== IMPLEMENTER =====================
    echo ""
    rm -f "$RESULT_FILE"
    impl_start=$(date +%s)

    if [[ $impl_iteration -eq 1 ]]; then
        printf "  ${CYAN}[implementer]${NC} Implementing plan...\n"

        run_claude_stream "$RESULT_FILE" \
            -p "Implement the plan at: $PLAN_PATH
Follow every step exactly. After implementing all steps, run \`make check\` and \`make test\`. Fix any failures." \
            --model sonnet \
            --effort high \
            --dangerously-skip-permissions \
            --append-system-prompt "$IMPLEMENTER_SYSTEM_PROMPT" || {
            printf "  ${RED}[implementer] FAILED${NC}\n" >&2
            rm -rf "$TMPDIR_LOOP"; exit 1
        }

        IMPL_SESSION_ID="$(get_session_id "$RESULT_FILE")"
        [[ -n "$IMPL_SESSION_ID" ]] && printf "  ${DIM}Session: $IMPL_SESSION_ID${NC}\n"
    else
        printf "  ${CYAN}[implementer]${NC} Fixing gaps (resuming session)...\n"

        impl_ok=false
        if [[ -n "$IMPL_SESSION_ID" ]]; then
            if run_claude_stream "$RESULT_FILE" \
                -p "The verifier found gaps in your implementation. Fix ALL of the following issues, then run \`make check\` and \`make test\` again:

$IMPL_FEEDBACK" \
                --model sonnet \
                --effort high \
                --resume "$IMPL_SESSION_ID" \
                --dangerously-skip-permissions; then
                impl_ok=true
            else
                printf "  ${YELLOW}Resume failed, falling back to new session${NC}\n"
                IMPL_SESSION_ID=""
            fi
        fi

        if [[ "$impl_ok" != "true" ]]; then
            rm -f "$RESULT_FILE"
            run_claude_stream "$RESULT_FILE" \
                -p "The plan at $PLAN_PATH was partially implemented but has gaps. Fix ALL of the following issues, then run \`make check\` and \`make test\`:

$IMPL_FEEDBACK" \
                --model sonnet \
                --effort high \
                --dangerously-skip-permissions \
                --append-system-prompt "$IMPLEMENTER_SYSTEM_PROMPT" || {
                printf "  ${RED}[implementer] FAILED${NC}\n" >&2
                rm -rf "$TMPDIR_LOOP"; exit 1
            }
            IMPL_SESSION_ID="$(get_session_id "$RESULT_FILE")"
        fi
    fi

    impl_end=$(date +%s)
    printf "  ${GREEN}[implementer] Done${NC} ($((impl_end - impl_start))s)\n"

    # ===================== VERIFIER =====================
    echo ""

    if [[ -n "$LOCK_STATE_FILE" ]]; then
        printf "  ${CYAN}Checking npm dependencies (post-implementation)...${NC}\n"
        if ! ensure_deps_fresh "$PROJECT_ROOT" "$LOCK_STATE_FILE"; then
            printf "  ${RED}ERROR: dependency sync failed — verifier cannot run${NC}\n" >&2
            rm -rf "$TMPDIR_LOOP"; exit 1
        fi
    fi

    printf "  ${CYAN}[verifier]${NC} Verifying implementation (fresh context)...\n"

    rm -f "$RESULT_FILE"
    verify_start=$(date +%s)

    run_claude_stream "$RESULT_FILE" \
        -p "Verify that the implementation plan at $PLAN_PATH was 100% implemented. Check every step, then run make check and make test." \
        --model opus \
        --effort max \
        --no-session-persistence \
        --allowed-tools "$VERIFIER_TOOLS" \
        --append-system-prompt "$VERIFIER_SYSTEM_PROMPT" \
        --json-schema "$VERIFY_SCHEMA" || {
        printf "  ${RED}[verifier] FAILED${NC}\n" >&2
        rm -rf "$TMPDIR_LOOP"; exit 1
    }

    verify_end=$(date +%s)

    v_verdict=$(jq -r '.structured_output.overall_verdict // "UNKNOWN"' "$RESULT_FILE" 2>/dev/null)
    v_steps=$(jq -r '.structured_output.steps_verified // 0' "$RESULT_FILE" 2>/dev/null)
    v_total=$(jq -r '.structured_output.steps_total // 0' "$RESULT_FILE" 2>/dev/null)
    v_check=$(jq -r '.structured_output.make_check_passed // false' "$RESULT_FILE" 2>/dev/null)
    v_test=$(jq -r '.structured_output.make_test_passed // false' "$RESULT_FILE" 2>/dev/null)
    v_gaps=$(jq -r '.structured_output.gaps_summary // ""' "$RESULT_FILE" 2>/dev/null)

    printf "  ${GREEN}[verifier] Done${NC} ($((verify_end - verify_start))s)\n"
    echo ""
    printf "  ${BOLD}Verdict:    $v_verdict${NC}\n"
    echo "  Steps:      $v_steps / $v_total"
    echo "  make check: $( [[ "$v_check" == "true" ]] && echo "PASS" || echo "FAIL" )"
    echo "  make test:  $( [[ "$v_test" == "true" ]] && echo "PASS" || echo "FAIL" )"

    # Sanity check: demote VERIFIED if model contradicts itself (e.g. reports
    # VERIFIED with missing steps or failing checks). The JSON schema cannot
    # express these correlations, so the orchestrator enforces them.
    if [[ "$v_verdict" == "VERIFIED" ]]; then
        if [[ "$v_check" != "true" || "$v_test" != "true" ]]; then
            printf "\n  ${RED}[sanity] Verifier returned VERIFIED with failing check/test — demoting to GAPS_FOUND${NC}\n"
            v_verdict="GAPS_FOUND"
        elif [[ "$v_total" -gt 0 && "$v_steps" -lt "$v_total" ]]; then
            printf "\n  ${RED}[sanity] Verifier returned VERIFIED with $v_steps/$v_total steps implemented — demoting to GAPS_FOUND${NC}\n"
            v_verdict="GAPS_FOUND"
        fi
    fi

    if [[ "$v_verdict" == "VERIFIED" && "$v_check" == "true" && "$v_test" == "true" ]]; then
        echo ""
        printf "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}\n"
        printf "${GREEN}║  IMPLEMENTATION VERIFIED after $impl_iteration iteration(s)${NC}\n"
        printf "${GREEN}║  Steps: $v_steps/$v_total  check: PASS  test: PASS${NC}\n"
        printf "${GREEN}║  Plan: $PLAN_PATH${NC}\n"
        printf "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}\n"
        break
    fi

    IMPL_FEEDBACK="$v_gaps"
    if [[ -z "$IMPL_FEEDBACK" || "$IMPL_FEEDBACK" == "null" ]]; then
        IMPL_FEEDBACK="Verdict: $v_verdict. Steps verified: $v_steps/$v_total. make check passed: $v_check. make test passed: $v_test. Fix ALL failing checks/tests and any remaining gaps before next verification."
    else
        IMPL_FEEDBACK="$IMPL_FEEDBACK

Additionally: make check passed: $v_check. make test passed: $v_test. Both MUST pass before verification can succeed."
    fi

    echo ""
done

if [[ "$v_verdict" != "VERIFIED" || "$v_check" != "true" || "$v_test" != "true" ]]; then
    printf "\n${YELLOW}╔══════════════════════════════════════════════════════════════╗${NC}\n"
    printf "${YELLOW}║  Phase 2: MAX ITERATIONS ($MAX_IMPL_ITER) — verdict: $v_verdict${NC}\n"
    printf "${YELLOW}║  Steps: $v_steps/$v_total  check: $v_check  test: $v_test${NC}\n"
    printf "${YELLOW}║  Plan: $PLAN_PATH${NC}\n"
    printf "${YELLOW}╚══════════════════════════════════════════════════════════════╝${NC}\n"
    rm -rf "$TMPDIR_LOOP"
    exit 1
fi

# ═══════════════════════════════════════════════════════════════
# PHASE 3: CODE REVIEW
# ═══════════════════════════════════════════════════════════════

if [[ "$SKIP_REVIEW" == "true" ]]; then
    printf "\n  ${DIM}Skipping Phase 3 (--skip-review)${NC}\n"
else

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  PHASE 3: CODE REVIEW                                        ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Max review iter:  $MAX_REVIEW_ITER"
echo ""

CODE_REVIEW_BODY="$(extract_prompt "$CODE_REVIEW_SKILL_DIR" "")"
CODE_REVIEW_PREAMBLE="You are running in headless mode (claude -p). You have full tool access.
Do NOT use AskUserQuestion — it is unavailable.
Your output will be captured as structured JSON via --json-schema.
After completing the code review workflow below and seeing the aggregated summary, produce structured JSON:
- Count issues by severity: Critical, Important, Suggestion
- Set overall_verdict to CLEAN if critical_count == 0 AND important_count == 0
- Set overall_verdict to HAS_ISSUES otherwise
- findings_summary: ALL critical and important findings with file:line references and fix instructions"
CODE_REVIEW_SYSTEM_PROMPT="${CODE_REVIEW_PREAMBLE}

${CODE_REVIEW_BODY}"

review_iteration=0
cr_verdict="UNKNOWN"
phase3_error=false

while [[ $review_iteration -lt $MAX_REVIEW_ITER ]]; do
    review_iteration=$((review_iteration + 1))

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    printf "  ${BOLD}Review iteration $review_iteration / $MAX_REVIEW_ITER${NC}\n"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # ===================== CODE REVIEWER =====================
    echo ""
    rm -f "$RESULT_FILE"
    cr_start=$(date +%s)

    printf "  ${CYAN}[code-review]${NC} Running 13-agent code review...\n"

    run_claude_stream "$RESULT_FILE" \
        -p "Run a comprehensive code review on the changes in this branch. The diff command is: git diff origin/dev...HEAD" \
        --model opus \
        --effort max \
        --dangerously-skip-permissions \
        --append-system-prompt "$CODE_REVIEW_SYSTEM_PROMPT" \
        --json-schema "$CODE_REVIEW_SCHEMA" || {
        printf "  ${RED}[code-review] FAILED${NC}\n" >&2
        printf "  ${YELLOW}Phase 3 aborted: code review tool failed (not an intentional skip)${NC}\n"
        break
    }

    cr_end=$(date +%s)

    cr_verdict=$(jq -r '.structured_output.overall_verdict // "UNKNOWN"' "$RESULT_FILE" 2>/dev/null)
    cr_critical=$(jq -r '.structured_output.critical_count // 0' "$RESULT_FILE" 2>/dev/null)
    cr_important=$(jq -r '.structured_output.important_count // 0' "$RESULT_FILE" 2>/dev/null)
    cr_suggestion=$(jq -r '.structured_output.suggestion_count // 0' "$RESULT_FILE" 2>/dev/null)
    cr_findings=$(jq -r '.structured_output.findings_summary // ""' "$RESULT_FILE" 2>/dev/null)

    printf "  ${GREEN}[code-review] Done${NC} ($((cr_end - cr_start))s)\n"
    echo ""
    printf "  ${BOLD}Verdict:  $cr_verdict${NC}\n"
    echo "  Issues:   critical=$cr_critical  important=$cr_important  suggestions=$cr_suggestion"

    # Sanity: demote CLEAN if critical issues exist
    if [[ "$cr_verdict" == "CLEAN" && "$cr_critical" -gt 0 ]]; then
        printf "\n  ${RED}[sanity] Code review returned CLEAN with $cr_critical critical issue(s) — demoting to HAS_ISSUES${NC}\n"
        cr_verdict="HAS_ISSUES"
    fi

    if [[ "$cr_verdict" == "CLEAN" ]]; then
        echo ""
        printf "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}\n"
        printf "${GREEN}║  CODE REVIEW CLEAN after $review_iteration iteration(s)${NC}\n"
        printf "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}\n"
        break
    fi

    # HAS_ISSUES — feed findings to implementer, then re-verify
    echo ""
    printf "  ${YELLOW}Code review found issues — sending to implementer for fix...${NC}\n"

    # ===================== IMPLEMENTER FIX =====================
    echo ""
    rm -f "$RESULT_FILE"
    fix_start=$(date +%s)

    printf "  ${CYAN}[implementer]${NC} Fixing code review findings...\n"

    impl_fix_ok=false
    if [[ -n "$IMPL_SESSION_ID" ]]; then
        if run_claude_stream "$RESULT_FILE" \
            -p "Code review found issues in your implementation. Fix ALL of the following, then run \`make check\` and \`make test\`:

$cr_findings" \
            --model sonnet \
            --effort high \
            --resume "$IMPL_SESSION_ID" \
            --dangerously-skip-permissions; then
            impl_fix_ok=true
        else
            printf "  ${YELLOW}Resume failed, falling back to new session${NC}\n"
            IMPL_SESSION_ID=""
        fi
    fi

    if [[ "$impl_fix_ok" != "true" ]]; then
        rm -f "$RESULT_FILE"
        run_claude_stream "$RESULT_FILE" \
            -p "Code review found issues in the implementation of the plan at $PLAN_PATH. Fix ALL of the following, then run \`make check\` and \`make test\`:

$cr_findings" \
            --model sonnet \
            --effort high \
            --dangerously-skip-permissions \
            --append-system-prompt "$IMPLEMENTER_SYSTEM_PROMPT" || {
            printf "  ${RED}[implementer] FAILED${NC}\n" >&2
            phase3_error=true
            break
        }
        IMPL_SESSION_ID="$(get_session_id "$RESULT_FILE")"
    fi

    fix_end=$(date +%s)
    printf "  ${GREEN}[implementer] Done${NC} ($((fix_end - fix_start))s)\n"

    # ===================== RE-VERIFY =====================
    echo ""

    if [[ -n "$LOCK_STATE_FILE" ]]; then
        printf "  ${CYAN}Checking npm dependencies (post-fix)...${NC}\n"
        ensure_deps_fresh "$PROJECT_ROOT" "$LOCK_STATE_FILE" || true
    fi

    printf "  ${CYAN}[verifier]${NC} Re-verifying after code review fixes...\n"

    rm -f "$RESULT_FILE"
    rv_start=$(date +%s)

    run_claude_stream "$RESULT_FILE" \
        -p "Verify that the implementation plan at $PLAN_PATH was 100% implemented. Check every step, then run make check and make test." \
        --model opus \
        --effort max \
        --no-session-persistence \
        --allowed-tools "$VERIFIER_TOOLS" \
        --append-system-prompt "$VERIFIER_SYSTEM_PROMPT" \
        --json-schema "$VERIFY_SCHEMA" || {
        printf "  ${RED}[verifier] FAILED${NC}\n" >&2
        phase3_error=true
        break
    }

    rv_end=$(date +%s)

    rv_verdict=$(jq -r '.structured_output.overall_verdict // "UNKNOWN"' "$RESULT_FILE" 2>/dev/null)
    rv_check=$(jq -r '.structured_output.make_check_passed // false' "$RESULT_FILE" 2>/dev/null)
    rv_test=$(jq -r '.structured_output.make_test_passed // false' "$RESULT_FILE" 2>/dev/null)

    printf "  ${GREEN}[verifier] Done${NC} ($((rv_end - rv_start))s)\n"
    echo "  Verdict: $rv_verdict  check: $( [[ "$rv_check" == "true" ]] && echo "PASS" || echo "FAIL" )  test: $( [[ "$rv_test" == "true" ]] && echo "PASS" || echo "FAIL" )"

    if [[ "$rv_verdict" != "VERIFIED" || "$rv_check" != "true" || "$rv_test" != "true" ]]; then
        printf "\n  ${RED}Re-verification failed after code review fixes — stopping Phase 3${NC}\n"
        phase3_error=true
        break
    fi

    echo ""
done

if [[ "$phase3_error" == "true" ]]; then
    printf "\n${RED}╔══════════════════════════════════════════════════════════════╗${NC}\n"
    printf "${RED}║  Phase 3: RE-VERIFICATION FAILED${NC}\n"
    printf "${RED}║  Implementation is in a broken state.${NC}\n"
    printf "${RED}╚══════════════════════════════════════════════════════════════╝${NC}\n"
    rm -rf "$TMPDIR_LOOP"
    exit 1
fi

if [[ "$cr_verdict" != "CLEAN" && "$review_iteration" -ge "$MAX_REVIEW_ITER" ]]; then
    printf "\n${YELLOW}╔══════════════════════════════════════════════════════════════╗${NC}\n"
    printf "${YELLOW}║  Phase 3: MAX ITERATIONS ($MAX_REVIEW_ITER) — review: $cr_verdict${NC}\n"
    printf "${YELLOW}║  Critical: $cr_critical  Important: $cr_important${NC}\n"
    printf "${YELLOW}║  Code was VERIFIED but review issues may remain${NC}\n"
    printf "${YELLOW}╚══════════════════════════════════════════════════════════════╝${NC}\n"
fi

fi # end of Phase 3 (skipped if --skip-review)

# ═══════════════════════════════════════════════════════════════
# DONE — print next steps
# ═══════════════════════════════════════════════════════════════

# Green banner only when code review came back CLEAN or was skipped.
# If Phase 3 ran and ended with HAS_ISSUES (max iter exhausted), use a neutral
# yellow "done with warnings" banner so the prior warning is not visually
# cancelled by a green "ALL PHASES COMPLETE".
if [[ "$SKIP_REVIEW" == "true" || "${cr_verdict:-UNKNOWN}" == "CLEAN" ]]; then
    banner_color="$GREEN"
    banner_title="ALL PHASES COMPLETE"
else
    banner_color="$YELLOW"
    banner_title="DONE WITH WARNINGS — review issues remain"
fi

echo ""
printf "${banner_color}╔══════════════════════════════════════════════════════════════╗${NC}\n"
printf "${banner_color}║  %s${NC}\n" "$banner_title"
printf "${banner_color}║  Plan: $PLAN_PATH${NC}\n"
if [[ "$WORKTREE_CREATED" == "true" ]]; then
printf "${banner_color}║  Worktree: $WORKTREE_DIR${NC}\n"
printf "${banner_color}║  Branch: $BRANCH_NAME${NC}\n"
printf "${banner_color}║${NC}\n"
printf "${banner_color}║  Next steps:${NC}\n"
printf "${banner_color}║    cd $WORKTREE_DIR${NC}\n"
printf "${banner_color}║    git push -u origin $BRANCH_NAME${NC}\n"
printf "${banner_color}║    gh pr create --base dev${NC}\n"
fi
printf "${banner_color}╚══════════════════════════════════════════════════════════════╝${NC}\n"
rm -rf "$TMPDIR_LOOP"
exit 0
