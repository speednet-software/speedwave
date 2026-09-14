# Issue tracker: GitLab

Issues and specs for this repo live as GitLab issues. Every operation goes through the `gitlab` integration in the MCP Hub: before the first call of a tool in a session, fetch its schema with `search_tools` (`detail_level: "full_schema"`) and pass exactly the parameters it names; never guess them. Resolve `project_id` (the `group/project` path) from `git remote -v` once per session.

## Conventions

- **Create an issue**: `gitlab.createIssue` with `title`, `description` (Markdown) and comma-separated `labels`.
- **Read an issue**: `gitlab.getIssue` for the description, labels and assignees; `gitlab.listIssueNotes` for the comments. GitLab calls comments "notes".
- **List issues**: `gitlab.listIssues` with `state: "opened"` and comma-separated `labels` filters.
- **Comment on an issue**: `gitlab.createIssueNote` with `body`.
- **Apply / remove labels**: `gitlab.updateIssue` replaces the whole label set, so read the current labels with `gitlab.getIssue`, edit the list, and send it back as comma-separated `labels`. Create a missing label with `gitlab.createLabel`.
- **Close**: `gitlab.closeIssue` takes no closing comment, so post the explanation first with `gitlab.createIssueNote`, then close.
- **Merge requests**: GitLab calls PRs "merge requests". `gitlab.getMrFull`, `gitlab.listMrIds`, `gitlab.createMrNote`, `gitlab.updateMergeRequest` are the MR counterparts of the issue tools above.

## Merge requests as a triage surface

**MRs as a request surface: no.** _(Set to `yes` if this repo treats external merge requests as feature requests; `/speedwave-triage` reads this flag.)_

When set to `yes`, also list the internal author usernames in this file (project members and owners): the hub reports an MR's author but not its membership, so an MR is external when its author is not on that list. MRs then run through the same labels and states as issues:

- **Read an MR**: `gitlab.getMrFull` for the description, author and labels, `gitlab.getMrChanges` for the diff, `gitlab.listMrNotes` for the discussion.
- **List external MRs for triage**: `gitlab.listMrIds` with `state: "opened"` (iids and titles only), then `gitlab.getMrFull` on each to read the author and drop MRs whose author is on the internal list.
- **Comment / label / close**: `gitlab.createMrNote`; `gitlab.updateMergeRequest` with comma-separated `labels` (replaces the set); `gitlab.updateMergeRequest` with `state_event: "close"`.

Unlike GitHub, GitLab numbers issues and MRs separately, so `#42` is unambiguous once you know which surface the maintainer means.

## When a skill says "publish to the issue tracker"

Create a GitLab issue with `gitlab.createIssue`.

## When a skill says "fetch the relevant ticket"

Run `gitlab.getIssue`, then `gitlab.listIssueNotes` for its notes.

## Wayfinding operations

Used by `/speedwave-wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gitlab.createIssue` with `labels: "wayfinder:map"`.
- **Child ticket**: `gitlab.createIssue` with `Part of #<map>` as the first line of the description and the label `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: a `Blocked by: #<n>, #<n>` line at the top of the description. GitLab's native blocking links are not reachable through the hub, so this line is the canonical representation. A ticket is unblocked when every blocker is closed (`gitlab.getIssue` on each).
- **Frontier query**: `gitlab.listIssues` with `state: "opened"`, keep the issues whose description starts with `Part of #<map>`, drop any with an open blocker in its `Blocked by` line or with an assignee; first in map order wins.
- **Claim**: `gitlab.getCurrentUser` for your numeric `id`, then `gitlab.updateIssue` with `assignee_ids: [<id>]` — the session's first write.
- **Resolve**: `gitlab.createIssueNote` with the answer, then `gitlab.closeIssue`, then append a context pointer (gist + link) to the map's Decisions-so-far with `gitlab.updateIssue` on the map description.
