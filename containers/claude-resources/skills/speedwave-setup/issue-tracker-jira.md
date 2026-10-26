# Issue tracker: Jira

Issues and specs for this repo live in a Jira project. Every operation goes through the `atlassian` integration in the MCP Hub: before the first call of a tool in a session, fetch its schema with `search_tools` (`detail_level: "full_schema"`) and pass exactly the parameters it names; never guess them.

## Project

Project key: `PROJ`. Issue type for tickets: `Task`. Both were written by `/speedwave-setup`; edit them here if the team moves.

## Conventions

- **Create an issue**: `atlassian.createIssue` with `project`, `summary`, `type`, `description` (Markdown, converted to Jira's rich format) and `labels`.
- **Read an issue**: `atlassian.getIssue` for the description, labels, status and assignee; `atlassian.getComments` for the comments.
- **List issues**: `atlassian.searchIssues` with JQL, for example `project = PROJ AND statusCategory != Done AND labels = "needs-triage" ORDER BY created ASC`; unlabelled issues are `labels IS EMPTY`.
- **Comment on an issue**: `atlassian.addComment` with `body` (Markdown).
- **Apply / remove labels**: `atlassian.updateIssue` replaces the whole label set, so read the current labels with `atlassian.getIssue`, edit the list, and send it back as `labels`.
- **Close**: post the explanation with `atlassian.addComment`, then `atlassian.getTransitions` to find the transition into the project's done status, then `atlassian.transitionIssue` with its `transition_id`.

## Pull requests as a triage surface

Not applicable: Jira holds no pull requests, so `/speedwave-triage` covers issues only here.

## When a skill says "publish to the issue tracker"

Create a Jira issue with `atlassian.createIssue` in the project above.

## When a skill says "fetch the relevant ticket"

Run `atlassian.getIssue`, then `atlassian.getComments` for its comments.

## Wayfinding operations

Used by `/speedwave-wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `atlassian.createIssue` with `labels: ["wayfinder:map"]`.
- **Child ticket**: `atlassian.createIssue` with `parent: "<MAP-KEY>"` and the label `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Jira accepts only a parent one level above the child type (for example the map as an epic, or a Sub-task type under a Task map); if it rejects the parent, the error says so. Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: native issue links: `atlassian.linkIssues` with `issue: "<BLOCKER-KEY>"`, `relation: "blocks"`, `target: "<TICKET-KEY>"` (relation texts from `atlassian.listLinkTypes`). `atlassian.getIssue` returns a ticket's `links`. A ticket is unblocked when every issue that blocks it is done.
- **Frontier query**: `atlassian.searchIssues` with `project = PROJ AND labels IN ("wayfinder:research", "wayfinder:prototype", "wayfinder:grilling", "wayfinder:task") AND statusCategory != Done AND assignee IS EMPTY AND parent = <MAP-KEY> ORDER BY created ASC`, then drop any with an open blocker in its `links` (check each blocker with `atlassian.getIssue`); first in map order wins.
- **Claim**: `atlassian.assignIssue` with `assignee: "me"` (the session's first write).
- **Resolve**: `atlassian.addComment` with the answer, then transition the ticket to done (`getTransitions` + `transitionIssue`), then append a context pointer (gist + link) to the map's Decisions-so-far: read the map with `atlassian.getIssue`, append, write it back with `atlassian.updateIssue` (`description`).
