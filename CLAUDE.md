# Speedwave

Security-first AI platform connecting Claude Code with external services (Slack, SharePoint, GitLab, GitHub, Atlassian, Redmine, Context7 docs, Playwright browser; native Mail, Calendar, Reminders, Notes) plus a built-in Office documents worker (Word/Excel/PowerPoint/PDF) and host-side meeting transcription (Whisper). Claude runs in a hardened, token-free container — every service credential is isolated in its own worker. VM-level isolation: Lima on macOS, WSL2 on Windows — the only supported host platforms (Linux hosts were deliberately dropped; do not re-add). Ships as a single installable app (.dmg, .exe) without Docker Desktop. Two interfaces: CLI (terminal) and Desktop (Tauri chat UI).

Every change must work on **both macOS and Windows**.

## How to work in this repo

- **Commands run through the Makefile**, never `cargo`/`npm` directly. Write tests alongside every change and run the targets you touched (e.g. `make test-rust`); the pre-push hook runs `make check-fmt`, and the required CI checks (macOS + Windows) are the real test gate. Full command list: `.claude/rules/commands.md`.
- **This file stays thin on purpose.** The real guidance lives in `.claude/rules/` — the SSOT registry, architecture map, alignment pairs, and per-area pitfalls are there, kept next to the code they describe. When a rule and the code disagree, trust the code and fix the rule.
- If a needed guideline is missing, add it as a new file in `.claude/rules/` — never as a link out to `docs/` or an ADR. These rule files must stay self-contained.

## Rules index (`.claude/rules/`)

**Always loaded** (read every session — the non-negotiables and the maps you need before touching anything):

- `engineering-principles.md` — KISS/YAGNI/DRY/SSOT/SOLID + code hygiene (comments, tests, dead code, no marker comments, no lint suppression).
- `security.md` — the non-negotiable security invariants; every change must preserve or improve them.
- `git-workflow.md` — branches, PR titles (`dev→main` is `feat`/`fix` only), merges, hooks and CI you must never bypass.
- `architecture.md` — the system map: runtime handle, compose renderer, hub/proxy/workers, config merge, updates/rollback, Claude-in-container.
- `commands.md` — the Makefile targets.

**Path-scoped** (auto-load when you touch matching files — consult proactively when working in that area):

- `ssot-registry.md` — the single-source-of-truth catalog; edit the SSOT, never a call-site copy.
- `alignments.md` — every paired-source alignment, split into test-guarded (a failing test names the fix) and manual (update both sides yourself).
- `cross-platform.md` — the macOS/Windows pitfall list (paths, networking, filesystem, processes, BOM/CRLF, TZ, CRT).
- `plugins.md` — the full plugin contract (sibling repo `speedwave-plugins`).
- `local-llm.md` — LLM provider/proxy invariants and usage/cost SSOT.
- `mcp-servers.md` — worker policy + the new-worker checklist.
- `native-macos.md` — native Swift OS integrations (Mail/Calendar/Reminders/Notes via AppleEvents), TCC permission gates, host-side Whisper transcription (macOS-only invariants).
- `images-builds.md` — image build/rebuild rules (content-addressed tags, lazy builds, tzdata).
- `host-workers.md` — host-side worker/bridge rules (single supervisor, firewall, exit 137).
- `desktop-ui.md` — Angular/Tauri UI rules (zoneless signals, Rust↔TS mirrors, CSP).
- `logging.md` — the `log` facade, sanitizer SSOT, diagnostics registry.
- `documentation.md` — when a change requires a doc/ADR update.
- `rust-style.md` — Rust-specific conventions.
