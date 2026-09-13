# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Every operation goes through the `github` integration in the MCP Hub: before the first call of a tool in a session, fetch its schema with `search_tools` (`detail_level: "full_schema"`) and pass exactly the parameters it names; never guess them. Resolve `owner` and `repo` from `git remote -v` once per session.

## Conventions

- **Create an issue**: `github.createIssue` with `title`, `body` (Markdown) and `labels`.
- **Read an issue**: `github.getIssue` for the body, labels and assignees; `github.listPrComments` with the issue `number` for the comments (GitHub serves issue and pull-request comments from one endpoint, so the tool accepts an issue number).
- **List issues**: `github.listIssues` with `state` and comma-separated `labels` filters. It returns issues only; pull requests are filtered out.
- **Comment on an issue**: `github.createPrComment` with the issue `number` (the same shared endpoint).
- **Apply / remove labels**: `github.updateIssue` replaces the whole label set, so read the current labels with `github.getIssue`, edit the list, and send it back as `labels`. Create a missing label with `github.createLabel`.
- **Close**: post the explanation with `github.createPrComment`, then `github.closeIssue`.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/speedwave-triage` reads this flag.)_

When set to `yes`, also list the internal author logins in this file (owners, members and collaborators): the hub reports a PR's author `login` but not its repository association, so a PR is external when its author is not on that list. PRs then run through the same labels and states as issues:

- **Read a PR**: `github.getPullRequest` for body, author and branches, `github.getPrDiff` for the diff, `github.listPrComments` for the conversation.
- **List external PRs for triage**: `github.listPullRequests` with `state: "open"`, then drop PRs whose author is on the internal list.
- **Comment / label / close**: `github.createPrComment`; `github.updateIssue` with the PR `number` for labels (a pull request is an issue to GitHub's label API); `github.updatePullRequest` with `state: "closed"`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `github.getPullRequest` and fall back to `github.getIssue`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue with `github.createIssue`.

## When a skill says "fetch the relevant ticket"

Run `github.getIssue`, then `github.listPrComments` for its comments.

## Wayfinding operations

Used by `/speedwave-wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `github.createIssue` with `labels: ["wayfinder:map"]`.
- **Child ticket**: `github.createIssue` with `Part of #<map>` as the first line of the body and the label `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`); add the child to a task list in the map body with `github.updateIssue`. GitHub's native sub-issues are not reachable through the hub. Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: a `Blocked by: #<n>, #<n>` line at the top of the child body. GitHub's native issue dependencies are not reachable through the hub, so this line is the canonical representation. A ticket is unblocked when every blocker is closed (`github.getIssue` on each).
- **Frontier query**: `github.listIssues` with `state: "open"`, keep the issues whose body starts with `Part of #<map>`, drop any with an open blocker in its `Blocked by` line or with an assignee; first in map order wins.
- **Claim**: `github.getCurrentUser` for your `login`, then `github.updateIssue` with `assignees: [<login>]` — the session's first write.
- **Resolve**: `github.createPrComment` with the answer, then `github.closeIssue`, then append a context pointer (gist + link) to the map's Decisions-so-far with `github.updateIssue` on the map body.
