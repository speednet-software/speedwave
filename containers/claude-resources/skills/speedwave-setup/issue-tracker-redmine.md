# Issue tracker: Redmine

Issues and specs for this repo live in a Redmine project. Every operation goes through the `redmine` integration in the MCP Hub: before the first call of a tool in a session, fetch its schema with `search_tools` (`detail_level: "full_schema"`) and pass exactly the parameters it names; never guess them.

## Project

Project identifier: `my-project`. Tracker for tickets: `Task`. Both were written by `/speedwave-setup`; edit them here if the team moves. Status and tracker names come from `redmine.getMappings`.

## Conventions

Redmine has no labels. A triage role is a `[role]` prefix on the issue subject: `[needs-triage] Login fails on Safari`. An issue carries at most one role prefix; applying a role replaces the previous one.

- **Create an issue**: `redmine.createIssue` with `project_id`, `subject` (role prefix included), `description` and `tracker`.
- **Read an issue**: `redmine.getIssueFull` with `include: ["journals", "relations"]`; journals are the comments.
- **List issues**: `redmine.listIssueIds` with `project_id` and `status: "open"` returns ids, subjects and statuses; keep the issues whose subject starts with the role you want. Unprefixed subjects are the untriaged bucket. `redmine.searchIssueIds` with the role word narrows a large project first.
- **Comment on an issue**: `redmine.commentIssue` with `notes`.
- **Apply / remove a role**: `redmine.updateIssue` with a new `subject`: strip the existing `[role]` prefix, then prepend the new one (or none).
- **Close**: `redmine.commentIssue` with the explanation, then `redmine.updateIssue` with `status` set to the project's closing status (`Closed` in a default Redmine).

## Pull requests as a triage surface

Not applicable: Redmine holds no pull requests, so `/speedwave-triage` covers issues only here.

## When a skill says "publish to the issue tracker"

Create a Redmine issue with `redmine.createIssue` in the project above.

## When a skill says "fetch the relevant ticket"

Run `redmine.getIssueFull` with `include: ["journals", "relations"]`.

## Wayfinding operations

Used by `/speedwave-wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue whose subject starts with `[wayfinder:map]`, holding the Notes / Decisions-so-far / Fog body. `redmine.createIssue`.
- **Child ticket**: `redmine.createIssue` with `parent_issue_id` set to the map's id (Redmine's native parent) and the subject prefix `[wayfinder:<type>]` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: Redmine's **native relation** — the canonical, UI-visible representation. `redmine.createRelation` with `issue_id: <blocker>`, `issue_to_id: <child>`, `relation_type: "blocks"`. A ticket is unblocked when every issue blocking it is closed (`redmine.getIssueFull` with `include: ["relations"]` lists them).
- **Frontier query**: `redmine.listIssueIds` with `status: "open"` scoped to the project, keep the children of the map (their `parent` is the map), drop any with an open blocker or an assignee; first in map order wins.
- **Claim**: `redmine.updateIssue` with `assigned_to: "me"` — the session's first write.
- **Resolve**: `redmine.commentIssue` with the answer, then `redmine.updateIssue` with the closing `status`, then append a context pointer (gist + link) to the map's Decisions-so-far: read the map with `redmine.getIssueFull`, append, write it back with `redmine.updateIssue` (`description`).
