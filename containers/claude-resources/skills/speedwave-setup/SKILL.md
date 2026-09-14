---
name: speedwave-setup
description: Configure this repo for the engineering skills — set up its issue tracker, triage label vocabulary, and domain doc layout. Run once before first use of the other engineering skills.
disable-model-invocation: true
---

# Setup Speedwave's engineering skills

Scaffold the per-repo configuration that the engineering skills assume:

- **Issue tracker** — where issues live (one of the tracker integrations enabled for this project, or local markdown)
- **Triage labels** — the strings used for the five canonical triage roles
- **Domain docs** — where `SPEEDWAVE.md` and ADRs live, and the consumer rules for reading them

This is a prompt-driven skill, not a deterministic script. Explore, present what you found, confirm with the user, then write.

## Process

### 1. Explore

Look at the current repo to understand its starting state. Read whatever exists; don't assume:

- `git remote -v` and `.git/config` — is this a GitHub or GitLab repo? Which one?
- Which tracker integrations this project has enabled: call `search_tools` with query `"*"` and `detail_level: "names_only"` and note which of the services `github`, `gitlab`, `atlassian` (Jira) and `redmine` appear. Only those can be offered in Section A; a remote pointing at a host whose integration is not enabled is a hint for the user, not an option.
- `AGENTS.md` and `CLAUDE.md` at the repo root — does either exist? Is there already an `## Agent skills` section in either?
- `SPEEDWAVE.md` and `SPEEDWAVE-MAP.md` at the repo root
- `docs/adr/` and any `src/*/docs/adr/` directories
- `docs/agents/` — does this skill's prior output already exist?
- `.speedwave/scratch/` — sign that a local-markdown issue tracker convention is already in use
- Monorepo signals — a `pnpm-workspace.yaml`, a `workspaces` field in `package.json`, or a populated `packages/*` with its own `src/`. Present only in a genuinely large multi-package repo; their absence means single-context, which is almost every repo.

### 2. Present findings and ask

Summarise what's present and what's missing. Then take the sections in order — one section, one answer, then the next.

Lead each section with the recommended answer so the user can accept it in a word. Give a one-line explainer only when the choice genuinely branches; skip the section entirely when exploration already settled it (Section C when there's no monorepo).

**Section A — Issue tracker.**

> Explainer: The "issue tracker" is where issues live for this repo. Skills like `speedwave-to-tickets`, `speedwave-triage`, and `speedwave-to-spec` read from and write to it — they need to know whether to call a tracker integration's tools through the MCP Hub, write a markdown file under `.speedwave/scratch/`, or follow some other workflow you describe. Pick the place you actually track work for this repo.

Offer only the trackers whose integration exploration found enabled, plus the two that need none. If a `git remote` points at GitHub and `github` is enabled, propose GitHub; if it points at GitLab (`gitlab.com` or a self-hosted host) and `gitlab` is enabled, propose GitLab. Otherwise lead with the one enabled tracker, or with Local markdown when none is enabled:

- **GitHub** — issues live in the repo's GitHub Issues (the `github` integration through the hub)
- **GitLab** — issues live in the repo's GitLab Issues (the `gitlab` integration through the hub)
- **Jira** — issues live in a Jira project (the `atlassian` integration through the hub). Also ask for the project key and the issue type to use for tickets; `atlassian.listProjects` and `atlassian.listIssueTypes` give the choices.
- **Redmine** — issues live in a Redmine project (the `redmine` integration through the hub). Also ask for the project identifier and the tracker to use for tickets; `redmine.listProjectIds` and `redmine.getMappings` give the choices.
- **Local markdown** — issues live as files under `.speedwave/scratch/<feature>/` in this repo (good for solo projects or repos without a remote)
- **Other** (Linear, etc.) — ask the user to describe the workflow in one paragraph; the skill will record it as freeform prose

Record the choice in `docs/agents/issue-tracker.md`. The GitHub and GitLab templates carry a "PRs as a request surface" flag, defaulted **off** — leave it off and don't raise it; a user who wants external PRs in the triage queue can flip the flag in the file later.

**Section B — Triage label vocabulary.** Ask exactly one question:

> Do you want to keep the default triage labels? (recommended: **yes**)

The defaults are the five canonical roles, each label string equal to its name: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. On **yes**, write them as-is. Only if the user says no — usually because their tracker already uses other names (e.g. `bug:triage` for `needs-triage`) — collect the overrides so `speedwave-triage` applies existing labels instead of creating duplicates. On Redmine a label is a `[role]` prefix in the issue subject (see the Redmine template); the vocabulary question is the same.

**Section C — Domain docs.** Default to **single-context** — one `SPEEDWAVE.md` + `docs/adr/` at the repo root. This fits almost every repo; write it without asking.

Offer **multi-context** — a root `SPEEDWAVE-MAP.md` pointing to per-context `SPEEDWAVE.md` files — only when exploration found monorepo signals. Then confirm which layout they want.

### 3. Confirm and edit

Show the user a draft of:

- The `## Agent skills` block to add to whichever of `CLAUDE.md` / `AGENTS.md` is being edited (see step 4 for selection rules)
- The contents of `docs/agents/issue-tracker.md`, `docs/agents/domain.md`, and `docs/agents/triage-labels.md`

Let them edit before writing.

### 4. Write

**Pick the file to edit:**

- If `CLAUDE.md` exists, edit it.
- Else if `AGENTS.md` exists, edit it.
- If neither exists, ask the user which one to create — don't pick for them.

Never create `AGENTS.md` when `CLAUDE.md` already exists (or vice versa) — always edit the one that's already there.

If an `## Agent skills` block already exists in the chosen file, update its contents in-place rather than appending a duplicate. Don't overwrite user edits to the surrounding sections.

The block:

```markdown
## Agent skills

### Issue tracker

[one-line summary of where issues are tracked]. See `docs/agents/issue-tracker.md`.

### Triage labels

[one-line summary of the label vocabulary]. See `docs/agents/triage-labels.md`.

### Domain docs

[one-line summary of layout — "single-context" or "multi-context"]. See `docs/agents/domain.md`.
```

Always include the `### Triage labels` sub-block and write `docs/agents/triage-labels.md`: `speedwave-triage` ships with Speedwave, so its label vocabulary is always needed.

Then write the docs files using the seed templates in this skill folder as a starting point:

- [issue-tracker-github.md](./issue-tracker-github.md) — GitHub issue tracker
- [issue-tracker-gitlab.md](./issue-tracker-gitlab.md) — GitLab issue tracker
- [issue-tracker-jira.md](./issue-tracker-jira.md) — Jira issue tracker (fill in the project key and issue type from Section A)
- [issue-tracker-redmine.md](./issue-tracker-redmine.md) — Redmine issue tracker (fill in the project identifier and tracker from Section A)
- [issue-tracker-local.md](./issue-tracker-local.md) — local-markdown issue tracker
- [triage-labels.md](./triage-labels.md) — label mapping
- [domain.md](./domain.md) — domain doc consumer rules + layout

For "other" issue trackers, write `docs/agents/issue-tracker.md` from scratch using the user's description.

### 5. Done

Tell the user the setup is complete and which engineering skills will now read from these files. Mention they can edit `docs/agents/*.md` directly later — re-running this skill is only necessary if they want to switch issue trackers or restart from scratch.
