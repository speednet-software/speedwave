# ADR-087: Vendored Matt Pocock Skills as `speedwave-*` Core Skills

> **Status:** Accepted
> **Date:** 2026-09-13
> **Context:** Speedwave users wanted Matt Pocock's engineering and productivity skills (grilling, domain modeling, TDD, bug diagnosis, spec and ticket flows, triage, wayfinder) in every project without installing a foreign plugin in the container. The upstream plugin assumes the `gh` and `glab` CLIs, which the container does not have, so its tracker skills did not work there; the bundled `superpowers` plugin (ADR-077) competed with the same skills for auto-invocation; and the third-party license directory was documented as macOS-only.

## Decision

### Delivery: 23 vendored core skills, no plugin

Speedwave ships 23 skills from `mattpocock/skills`[^1] (plugin `mattpocock-skills` 1.2.3 from the official marketplace[^2], commit `84fdeffd12f2ee307994d1eb6feb48173b6e0502`[^3], MIT[^4]) as core skills in `containers/claude-resources/skills/speedwave-<name>/`. They ride the existing resource mechanism of ADR-022: `containers/entrypoint.sh` links every top-level skill directory into `~/.claude/skills/` on every container start, so delivery needed no compose, Rust or plugin-manifest change. The `speedwave-` prefix separates product skills from a team's own `.claude/skills` and from plugins. The MIT notice ships as `desktop/src-tauri/licenses-static/mattpocock-skills-LICENSE`, copied into `THIRD-PARTY-LICENSES/` by `make bundle-static-licenses`; both platform bundle configurations already carried that directory since ADR-085 (`desktop/src-tauri/tauri.macos.conf.json`, `desktop/src-tauri/tauri.windows.conf.json`, guarded by `_tests/desktop/transcription-bundle.bats`).

Visibility follows upstream exactly: Claude Code's `disable-model-invocation: true` frontmatter keeps a skill out of the model's reach so only the user can start it[^5]. No skill pins a `model`.

| Skill                                     | From upstream                   | Invocation |
| ----------------------------------------- | ------------------------------- | ---------- |
| `speedwave-ask`                           | `ask-matt`                      | user       |
| `speedwave-grill-me`                      | `grill-me`                      | user       |
| `speedwave-grill-with-docs`               | `grill-with-docs`               | user       |
| `speedwave-wait-what`                     | `wait-what`                     | user       |
| `speedwave-handoff`                       | `handoff`                       | user       |
| `speedwave-teach`                         | `teach`                         | user       |
| `speedwave-to-questionnaire`              | `to-questionnaire`              | user       |
| `speedwave-implement`                     | `implement`                     | user       |
| `speedwave-to-spec`                       | `to-spec`                       | user       |
| `speedwave-to-tickets`                    | `to-tickets`                    | user       |
| `speedwave-triage`                        | `triage`                        | user       |
| `speedwave-wayfinder`                     | `wayfinder`                     | user       |
| `speedwave-improve-codebase-architecture` | `improve-codebase-architecture` | user       |
| `speedwave-setup`                         | `setup-matt-pocock-skills`      | user       |
| `speedwave-grilling`                      | `grilling`                      | model      |
| `speedwave-domain-modeling`               | `domain-modeling`               | model      |
| `speedwave-codebase-design`               | `codebase-design`               | model      |
| `speedwave-tdd`                           | `tdd`                           | model      |
| `speedwave-diagnosing-bugs`               | `diagnosing-bugs`               | model      |
| `speedwave-prototype`                     | `prototype`                     | model      |
| `speedwave-research`                      | `research`                      | model      |
| `speedwave-resolving-merge-conflicts`     | `resolving-merge-conflicts`     | model      |
| `speedwave-writing-for-agents`            | `writing-for-agents`            | model      |

Not vendored: Matt's `code-review` (in any form: Speedwave keeps its own `speedwave-code-review` orchestrator, and a second review axis inside it was rejected too), `wizard` with its `template.sh` (a bash-wizard generator with no place in the container flow; the router loses that route), the `misc`, `in-progress` and `deprecated` buckets, `agents/openai.yaml` metadata, bucket READMEs and `docs/`.

### Fidelity: verbatim copies with six adaptation classes

Every copy is upstream text byte for byte, em dashes and punctuation included, except for these classes; `.prettierignore` excludes the vendored directories (native core skills re-included) because the pre-commit prettier pass would otherwise reflow 21 of the copied files. The classes are the whole list to reapply on a re-sync, and `crates/speedwave-runtime/tests/bundled_skills_guards.rs` fails on any upstream leftover (`/grilling`, `/tdd`, `setup-matt-pocock-skills`, `CONTEXT*.md`, `.scratch/`, `gh`, `glab`), on a `/speedwave-<name>` reference without a directory, on a frontmatter `name` that differs from its directory, on a visibility flag that differs from the table above, and on a missing or unpinned license note.

1. **Names and references.** Frontmatter `name`, `/x` to `/speedwave-x`, `/setup-matt-pocock-skills` to `/speedwave-setup`, `/code-review` (and the bare `code-review` reference in `speedwave-tdd`) to `speedwave-code-review`.
2. **Glossary files.** `CONTEXT.md` to `SPEEDWAVE.md`, `CONTEXT-MAP.md` to `SPEEDWAVE-MAP.md`, the format document `CONTEXT-FORMAT.md` to `SPEEDWAVE-FORMAT.md`, so the file a team commits is unambiguously Speedwave's.
3. **Working files under `.speedwave/`.** The local markdown tracker moves from `.scratch/<feature-slug>/` to `.speedwave/scratch/<feature-slug>/` with Matt's inner layout (`spec.md`, `issues/NN-slug.md`, `map.md`); `speedwave-handoff` writes `/workspace/.speedwave/handoffs/<date>-<slug>.md` instead of the OS temp directory, so the document is visible from the host and survives a container restart. Team configuration (`docs/agents/*.md`, `SPEEDWAVE.md`, the `## Agent skills` block) stays where Matt puts it.
4. **Tracker plumbing in `speedwave-setup`.** The tracker section offers only integrations the hub reports through `search_tools` (GitHub, GitLab, Jira via `atlassian`, Redmine) plus Local markdown and Other; the `git remote` hint stays a suggestion. The templates map every operation Matt names (create, read, list, comment, labels, close, PRs or MRs as a request surface, and the wayfinding operations map, child, blocking, frontier, claim, resolve) to a named hub tool, with the schema fetched through `search_tools` before a first call. GitHub and GitLab comments use the shared GitHub issue-comments endpoint[^6] (`createPrComment`/`listPrComments` accept issue numbers) and the new GitLab `createIssueNote`/`listIssueNotes` tools over the GitLab notes API[^7]. Native blocking exists only in the Redmine template (issue relations[^8]); GitHub, GitLab and Jira use the `Blocked by:` body line Matt already defines as the fallback, because the workers expose no link-creation tools. Jira closes through a workflow transition and labels through an issue update; Redmine has no labels, so a triage role is a `[role]` prefix on the subject. The triage-label section always runs because `speedwave-triage` is always present. The one `gh` example in `speedwave-triage/AGENT-BRIEF.md` is rephrased tracker-neutrally.
5. **`speedwave-implement` ending.** Upstream ends by invoking `/code-review`; both skills are user-invoked, so the Skill tool refuses that call. The copy commits, then reports and asks the user to run `/speedwave-code-review`.
6. **`speedwave-ask` router.** Speedwave names throughout, one sentence naming `speedwave-code-review` as the existing orchestrator the user runs, and no route to `wizard`.

### `superpowers` retired from the bundled set

`superpowers` leaves `defaults.rs::BUNDLED_PLUGINS` (ADR-077 keeps the other four). Its skills triggered on the same intents as the vendored set and its `SessionStart` hook ran on every session start[^9]. Because Claude Code loads a native plugin's hooks from the plugin's own `hooks/hooks.json`, uninstalling the plugin removes the hook with it; Speedwave never registered it in `settings.json`. `containers/entrypoint.sh` performs the removal once: only when the v2 bundled-plugins marker records `superpowers@claude-plugins-official` (Speedwave's own install) it checks `claude plugin list --json`, runs `claude plugin uninstall superpowers@claude-plugins-official`[^10] under `timeout`, removes the plugin's cache tree, and drops the marker line; a failure logs a warning and keeps the line for the next start, and a plugin the user installed after the marker line is gone is never touched. Observed on Claude Code 2.1.270 with a throwaway home (not documented upstream): the uninstall removes the `installed_plugins.json` entry and the `enabledPlugins` key but leaves `plugins/cache/claude-plugins-official/superpowers/` in place, hence the explicit cache removal. Test fixtures that used the name as an example plugin now use `example-plugin`.

## Rejected alternatives

- **Bundling `mattpocock-skills` with the ADR-077 mechanism** (`claude plugin install` at container start). Skills would surface as `mattpocock-skills:<name>`, the version would float with upstream, and no adaptation would be possible: the tracker skills would keep calling `gh`/`glab`, the glossary would stay `CONTEXT.md`, and `implement` would keep trying to invoke a user-invoked skill.
- **A `speedwave:` plugin namespace** (a `.claude-plugin/plugin.json` manifest in the skills directory, loaded by Claude Code's native plugin loader). It would replace the resource model of ADR-022 and ADR-078 (per-entry symlinks, integration gating, managed-link cleanup) for a prefix the directory name already provides.
- **Keeping `superpowers` next to the vendored set.** Two skill sets on the same triggers, plus a hook Speedwave does not control, in every session.
- **An automatic re-sync** (script, cron or freshness test). Re-sync is a manual diff against the pinned commit followed by the six classes above (`.claude/rules/bundled-skills.md`); a bump edits the pin in the license note, the rule and an amendment here.

## Consequences

- The Desktop slash menu and the CLI show the 23 skills in every project, always on; teams override any of them by committing a same-named skill under `/workspace/.claude/skills/` (ADR-022 precedence).
- Skill prose stays Matt's, so Speedwave's writing contract does not apply inside the copies; user-visible product text lives only in the adapted classes.
- A repo-wide grep for `superpowers` legitimately hits the entrypoint retirement step, its bats tests, `.claude/rules/bundled-skills.md`, ADR-077 and this ADR, and nothing else.
- The GitLab worker grows two tools (`listIssueNotes`, `createIssueNote`); the GitHub worker's comment tools document that they serve issues too. No new mount, port or credential surface.
- ADR-077 stays historically intact; its index status reads "Accepted (bundled set revised by ADR-087)".

[^1]: Matt Pocock's skills repository: <https://github.com/mattpocock/skills>

[^2]: The `claude-plugins-official` marketplace, which lists `mattpocock-skills` among its external plugins: <https://github.com/anthropics/claude-plugins-official>

[^3]: Pinned upstream commit `84fdeff` (merge of PR #788): <https://github.com/mattpocock/skills/commit/84fdeffd12f2ee307994d1eb6feb48173b6e0502>

[^4]: Upstream MIT license text at the pinned commit: <https://github.com/mattpocock/skills/blob/84fdeffd12f2ee307994d1eb6feb48173b6e0502/LICENSE>

[^5]: Claude Code skills reference, `disable-model-invocation` frontmatter (only the user can invoke the skill): <https://code.claude.com/docs/en/skills>

[^6]: GitHub REST API, issue comments: every pull request is an issue, so pull-request conversation comments are issue comments: <https://docs.github.com/en/rest/issues/comments>

[^7]: GitLab REST API, notes (issue notes and merge-request notes): <https://docs.gitlab.com/api/notes/>

[^8]: Redmine REST API, issue relations (`blocks`/`blocked`): <https://www.redmine.org/projects/redmine/wiki/Rest_IssueRelations>

[^9]: superpowers plugin (MIT), skills plus a `SessionStart` hook: <https://github.com/obra/superpowers>

[^10]: Claude Code plugins reference, `claude plugin` CLI (`install`, `uninstall`, `list`): <https://code.claude.com/docs/en/plugins>
