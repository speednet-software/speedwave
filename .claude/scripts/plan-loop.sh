#!/usr/bin/env bash
# Automated plan → review → implement → verify loop.
#
# Creates an isolated git worktree + branch, then:
# Phase 1: Writer creates plan, hostile reviewer iterates until READY_TO_IMPLEMENT.
# Phase 2: Implementer codes from plan, verifier checks 100% implementation + tests.
#
# Usage: plan-loop.sh <task description> [options]
#   --max-iter N          Phase 1: max write→review iterations (default 12)
#   --max-impl-iter N     Phase 2: max implement→verify iterations (default 5)
#   --plan-name NAME      Plan filename stem and branch suffix (default: YYYY-MM-DD-plan)
#   --plan-only           Run Phase 1 only (no implementation)
#   --impl-only <path>    Run Phase 2 only (plan already exists at <path>)
#   --no-worktree         Skip worktree creation, work in current directory
#   --branch NAME         Branch name (default: feat/<plan-name>)
#   --base BRANCH         Base branch for worktree (default: origin/dev)
#
# Requires: claude (Claude Code CLI), jq, git

set -euo pipefail

# --- Parse arguments ---

TASK=""
PLAN_ONLY=false
IMPL_ONLY=""
NO_WORKTREE=false
BRANCH_NAME=""
BASE_BRANCH="origin/dev"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --max-iter)        MAX_ITERATIONS="$2"; shift 2 ;;
        --max-impl-iter)   MAX_IMPL_ITERATIONS="$2"; shift 2 ;;
        --plan-name)       PLAN_NAME="$2"; shift 2 ;;
        --plan-only)       PLAN_ONLY=true; shift ;;
        --impl-only)       IMPL_ONLY="$2"; shift 2 ;;
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
    echo "Options: --max-iter N, --max-impl-iter N, --plan-name NAME, --plan-only," >&2
    echo "         --impl-only <path>, --no-worktree, --branch NAME, --base BRANCH" >&2
    exit 1
fi

MAX_ITER="${MAX_ITERATIONS:-12}"
MAX_IMPL_ITER="${MAX_IMPL_ITERATIONS:-5}"
PLAN_NAME="${PLAN_NAME:-$(date +%Y-%m-%d-%H%M%S)-plan}"
BRANCH_NAME="${BRANCH_NAME:-feat/${PLAN_NAME}}"
PLAN_DIR="${HOME}/.speedwave/plans"
PLAN_PATH="${IMPL_ONLY:-${PLAN_DIR}/${PLAN_NAME}.md}"

# Resolve PROJECT_ROOT and SCRIPT_DIR from the original repo (before worktree)
PROJECT_ROOT="$(git rev-parse --show-toplevel)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REVIEW_SCHEMA_FILE="$SCRIPT_DIR/plan-loop-review-schema.json"
VERIFY_SCHEMA_FILE="$SCRIPT_DIR/plan-loop-verify-schema.json"

WRITER_SKILL_DIR="$PROJECT_ROOT/.claude/skills/speedwave-write-plan"
REVIEWER_SKILL_DIR="$PROJECT_ROOT/.claude/skills/speedwave-review-plan"
IMPLEMENTER_SKILL_DIR="$PROJECT_ROOT/.claude/skills/speedwave-implement-plan"
VERIFIER_SKILL_DIR="$PROJECT_ROOT/.claude/skills/speedwave-verify-plan"

WORKTREE_DIR="${TMPDIR:-/tmp}/speedwave-loop-${PLAN_NAME}"
WORKTREE_CREATED=false

MAX_RETRY=2
RETRY_WAIT=60

PLANNING_TOOLS='Bash(git *),Bash(make *),Read,Glob,Grep,Agent'
VERIFIER_TOOLS='Bash(git *),Bash(make *),Read,Glob,Grep,Agent'

# --- Colors ---

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

# --- Validate prerequisites ---

for cmd in claude jq; do
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
    fi | awk -v rep="$task_text" '{ gsub(/\$ARGUMENTS/, rep); print }'
}

SPINNER_PID=""
start_spinner() {
    local label="$1"
    (
        local chars='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
        local start=$SECONDS
        local i=0
        while true; do
            local elapsed=$(( SECONDS - start ))
            local min=$(( elapsed / 60 ))
            local sec=$(( elapsed % 60 ))
            printf "\r    ${DIM}%s %s (%d:%02d)${NC}  " "${chars:i%10:1}" "$label" "$min" "$sec"
            i=$(( i + 1 ))
            sleep 0.2
        done
    ) &
    SPINNER_PID=$!
}
stop_spinner() {
    if [[ -n "$SPINNER_PID" ]]; then
        kill "$SPINNER_PID" 2>/dev/null
        wait "$SPINNER_PID" 2>/dev/null
        SPINNER_PID=""
        printf "\r\033[K"
    fi
}

run_claude_stream() {
    local output_file="$1"
    shift
    local attempt=0

    while [[ $attempt -le $MAX_RETRY ]]; do
        start_spinner "working"

        claude "$@" --output-format stream-json --verbose 2>/dev/null | while IFS= read -r line; do
            local msg_type
            msg_type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null) || continue

            case "$msg_type" in
                result)
                    echo "$line" > "$output_file"
                    ;;
                assistant)
                    local tool_name
                    tool_name=$(echo "$line" | jq -r '.message.content[]? | select(.type == "tool_use") | .name // empty' 2>/dev/null) || true
                    if [[ -n "$tool_name" ]]; then
                        local tool_input
                        tool_input=$(echo "$line" | jq -r '.message.content[]? | select(.type == "tool_use") | .input | if .file_path then .file_path elif .pattern then .pattern elif .command then (.command | split("\n") | .[0] | .[0:80]) else (tostring | .[0:80]) end // empty' 2>/dev/null) || true
                        stop_spinner
                        printf "    ${DIM}▸ %s %s${NC}\n" "$tool_name" "$tool_input"
                        start_spinner "working"
                    fi
                    ;;
            esac
        done

        stop_spinner

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
The findings_summary field MUST be detailed enough for the plan writer to fix every issue WITHOUT reading your full analysis. Include specific fix instructions for each finding."

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

VERIFY_SCHEMA="$(cat "$VERIFY_SCHEMA_FILE" 2>/dev/null || echo '{}')"

# NOTE: IMPLEMENTER_BODY and VERIFIER_BODY are computed after Phase 0
# (worktree setup) so they read from the correct skill paths.

# --- Temp files & cleanup ---

TMPDIR_LOOP=$(mktemp -d)
RESULT_FILE="$TMPDIR_LOOP/result.json"

WRITER_SESSION_ID=""
IMPL_SESSION_ID=""

cleanup() {
    stop_spinner
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
trap stop_spinner EXIT

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

    echo ""
    printf "  ${GREEN}Worktree ready${NC}\n"
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
echo "║  PHASE 1: PLAN — write → hostile review                     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Task:       $TASK"
echo "  Plan:       $PLAN_PATH"
echo "  Max iter:   $MAX_ITER"
echo ""

iteration=0
verdict="UNKNOWN"
REVIEW_FEEDBACK=""

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
    printf "  ${CYAN}[reviewer]${NC} Reviewing plan (fresh context)...\n"

    rm -f "$RESULT_FILE"
    review_start=$(date +%s)

    run_claude_stream "$RESULT_FILE" \
        -p "Review the implementation plan at: $PLAN_PATH" \
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

    printf "  ${GREEN}[reviewer] Done${NC} ($((review_end - review_start))s)\n"
    echo ""
    printf "  ${BOLD}Verdict:  $verdict${NC}\n"
    echo "  Issues:   blockers=$blocker_count  high=$high_count  medium=$medium_count  low=$low_count"

    [[ -n "$verdict_table" && "$verdict_table" != "null" ]] && echo "" && echo "$verdict_table"

    review_file="${PLAN_PATH%.md}.review-${iteration}.md"
    [[ -n "$full_review" && "$full_review" != "null" ]] && echo "$full_review" > "$review_file" && printf "\n  ${DIM}Review saved: $review_file${NC}\n"

    if [[ "$verdict" == "READY_TO_IMPLEMENT" ]]; then
        echo ""
        printf "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}\n"
        printf "${GREEN}║  PLAN APPROVED after $iteration iteration(s)${NC}\n"
        printf "${GREEN}║  Plan: $PLAN_PATH${NC}\n"
        printf "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}\n"
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

    if [[ "$v_verdict" == "VERIFIED" ]]; then
        echo ""
        printf "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}\n"
        printf "${GREEN}║  IMPLEMENTATION VERIFIED after $impl_iteration iteration(s)${NC}\n"
        printf "${GREEN}║  Steps: $v_steps/$v_total  check: PASS  test: PASS${NC}\n"
        printf "${GREEN}║  Plan: $PLAN_PATH${NC}\n"
        if [[ "$WORKTREE_CREATED" == "true" ]]; then
        printf "${GREEN}║  Worktree: $WORKTREE_DIR${NC}\n"
        printf "${GREEN}║  Branch: $BRANCH_NAME${NC}\n"
        printf "${GREEN}║${NC}\n"
        printf "${GREEN}║  Next steps:${NC}\n"
        printf "${GREEN}║    cd $WORKTREE_DIR${NC}\n"
        printf "${GREEN}║    git push -u origin $BRANCH_NAME${NC}\n"
        printf "${GREEN}║    gh pr create --base dev${NC}\n"
        fi
        printf "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}\n"
        rm -rf "$TMPDIR_LOOP"
        exit 0
    fi

    IMPL_FEEDBACK="$v_gaps"
    if [[ -z "$IMPL_FEEDBACK" || "$IMPL_FEEDBACK" == "null" ]]; then
        IMPL_FEEDBACK="Steps verified: $v_steps/$v_total. make check: $v_check. make test: $v_test. Review the plan and fix all remaining gaps."
    fi

    echo ""
done

printf "\n${YELLOW}╔══════════════════════════════════════════════════════════════╗${NC}\n"
printf "${YELLOW}║  Phase 2: MAX ITERATIONS ($MAX_IMPL_ITER) — verdict: $v_verdict${NC}\n"
printf "${YELLOW}║  Steps: $v_steps/$v_total  check: $v_check  test: $v_test${NC}\n"
printf "${YELLOW}║  Plan: $PLAN_PATH${NC}\n"
printf "${YELLOW}╚══════════════════════════════════════════════════════════════╝${NC}\n"
rm -rf "$TMPDIR_LOOP"
exit 1
