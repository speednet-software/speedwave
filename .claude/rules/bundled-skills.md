---
paths:
  - 'containers/claude-resources/skills/**'
  - 'containers/entrypoint.sh'
  - 'crates/speedwave-runtime/tests/bundled_skills_guards.rs'
  - 'crates/speedwave-runtime/src/defaults.rs'
  - 'desktop/src-tauri/licenses-static/**'
---

# Bundled Skills

Rules for the Claude Code skills Speedwave ships in the container: `containers/claude-resources/skills/`, linked into `~/.claude/skills/` by `containers/entrypoint.sh` on every start (ADR-022). The decisions behind the vendored set are in ADR-087.

## Vocabulary

- **Core skill**: a directory directly under `containers/claude-resources/skills/`, always linked. User-facing core skills are named `speedwave-<name>`; the review workers are `code-review-<dimension>` and are reached only through `speedwave-code-review`.
- **Integration skill**: `skills/integrations/<config_key>/`, linked only while that integration is enabled (dir name = `config_key`, test-guarded in `consts.rs`).
- **Vendored skill**: a core skill copied from an external open-source set with a pinned upstream version. Today: the 23 `speedwave-*` skills from `mattpocock/skills` (plugin `mattpocock-skills` 1.2.3, commit `84fdeff`, MIT; license note `desktop/src-tauri/licenses-static/mattpocock-skills-LICENSE`, shipped in `THIRD-PARTY-LICENSES/` on macOS and Windows by `make bundle-static-licenses`).
- **`SPEEDWAVE.md`**: the project glossary the vendored skills read and maintain at the workspace root (`SPEEDWAVE-MAP.md` in a multi-context repo, format in `speedwave-domain-modeling/SPEEDWAVE-FORMAT.md`). Upstream calls it `CONTEXT.md`; that name never appears in a bundled skill. The Speedwave repo itself has no `SPEEDWAVE.md`.

## Conventions

- Directory name = frontmatter `name` = slash command, for every skill in the tree (guard). A vendored skill keeps its upstream name behind the `speedwave-` prefix; the two renamed ones are `speedwave-ask` (from `ask-matt`) and `speedwave-setup` (from `setup-matt-pocock-skills`).
- Every reference to another skill is written `/speedwave-<name>` and must resolve to an existing core skill directory (guard). Claude Code built-ins (`/compact`, `/clear`) are not skills and stay as they are.
- No `model:` in any frontmatter: skills inherit the session model (guard). Visibility follows upstream: `disable-model-invocation: true` on the 14 user-invoked skills, no flag on the 9 model-invoked ones, never `user-invocable: false`.
- Working files a skill creates in the user's project live under `/workspace/.speedwave/`: `.speedwave/scratch/<feature-slug>/` for the local markdown tracker (Matt's inner layout `spec.md`, `issues/NN-slug.md`, `map.md` kept) and `.speedwave/handoffs/<date>-<slug>.md` for handoff documents. Team configuration written by `/speedwave-setup` (`docs/agents/*.md`, `SPEEDWAVE.md`, the `## Agent skills` block in `CLAUDE.md` or `AGENTS.md`) is a team document, not a working file.
- Tracker access goes through hub tools: `search_tools` with `full_schema` before the first call of a tool, parameters never guessed. Host CLIs (`gh`, `glab`) never appear in a bundled skill (guard).
- Adding a vendored skill = a new directory plus, for a new source, a license note in `licenses-static/` and an ADR delta. No compose or Rust change is needed for delivery.
- Formatting of a vendored copy belongs to upstream: `.prettierignore` excludes `containers/claude-resources/skills/speedwave-*/` (native core skills re-included) so the pre-commit `lint-staged` prettier pass never rewrites a copy. A new native `speedwave-*` skill needs its own `!` re-include line there.
- `speedwave-implement` never invokes `speedwave-code-review` (both are user-invoked, so the Skill tool refuses); it ends by asking the user to run it.

## Fidelity: the only differences from upstream

A vendored copy is upstream text byte for byte, punctuation and em dashes included, except for these classes. After a re-sync they are the whole list to reapply.

1. Names and references: frontmatter `name`; `/x` to `/speedwave-x`; `/setup-matt-pocock-skills` to `/speedwave-setup`; `/code-review` and the bare `code-review` skill reference to `speedwave-code-review` (Speedwave's own orchestrator; Matt's `code-review` is not vendored).
2. Glossary files: `CONTEXT.md` to `SPEEDWAVE.md`, `CONTEXT-MAP.md` to `SPEEDWAVE-MAP.md`, `CONTEXT-FORMAT.md` to `SPEEDWAVE-FORMAT.md` (file and links).
3. Working-file paths: `.scratch/` to `.speedwave/scratch/`; `speedwave-handoff` saves to `/workspace/.speedwave/handoffs/` instead of the OS temp dir.
4. Tracker plumbing in `speedwave-setup`: trackers offered only for integrations found through `search_tools` (GitHub, GitLab, Jira, Redmine) plus Local markdown and Other; templates map every operation to a named hub tool; Jira and Redmine templates added; the triage-label section always runs. The single `gh` example in `speedwave-triage/AGENT-BRIEF.md` is rephrased to a tracker-neutral one.
5. `speedwave-implement` ending: report and ask for `/speedwave-code-review` instead of invoking it.
6. `speedwave-ask` router: Speedwave names, `speedwave-code-review` in place of Matt's `code-review` with one sentence saying it is the existing orchestrator the user runs, and no route to `wizard`.

Not copied: `agents/openai.yaml`, bucket READMEs, `docs/`, Matt's `code-review` (in any form), `wizard` with `template.sh`, the `misc`, `in-progress` and `deprecated` buckets.

## Re-sync procedure

1. Check out the new upstream tag next to the pinned commit; `diff -r` `skills/engineering` and `skills/productivity` between the two.
2. Apply the upstream diff to the copies, then reapply the six classes above and nothing else. Verify by reversing the class-1 to class-3 replacements on the copy and diffing against upstream: the diff must be empty outside classes 4 to 6.
3. Bump the pin in the license note, in this rule and in an ADR-087 amendment; run `make test-rust` (guard) and `make test-entrypoint`.

There is deliberately no re-sync script, cron or freshness test (ADR-087).

## Retired bundled plugins

`superpowers` left `defaults.rs::BUNDLED_PLUGINS` with ADR-087 because its skills and SessionStart hook competed with the vendored set. `containers/entrypoint.sh` uninstalls it once, only when the v2 bundled-plugins marker records that Speedwave installed it, then drops the marker line; a user's own install is never touched. The uninstall is bounded by `timeout` and non-fatal. Because the uninstall step has to name the plugin, the repo-wide grep for that name legitimately hits the entrypoint, its bats tests, this rule and ADR-077/087, nothing else.
