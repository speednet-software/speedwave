# ADR-105: Caller-shaped Jira tools in the Atlassian worker

> **Status:** Accepted
> **Date:** 2026-10-26
> **Context:** Epic SPEED-518 rebuilds the Jira tools of the Atlassian MCP worker (`mcp-servers/atlassian`). The worker has no parent, components, links, issue deletion or issue type change, `updateIssue` silently ignores unknown fields, and descriptions come back as raw ADF. This ADR records that the new API is designed from the caller's side and is not a mirror of the Jira REST shape.

## Context

- The worker has no `parent`, `components`, `issuelinks` or `deleteIssue`; the only delete is `deleteAttachment` (`mcp-servers/atlassian/src/tools/jira-issue-tools.ts`). Each gap forced a manual fix in Jira.
- `updateIssue` accepts parameters it does not know and drops them without an error, so a caller cannot tell a no-op from a typo. `withDeclaredParams` (`mcp-servers/shared/src/tool-validation.ts`) rejects undeclared parameters, but the Atlassian tools did not use it.
- Input names are snake_case in redmine, gitlab, github, slack and os, and camelCase in atlassian and sharepoint.
- Reads return the description as raw ADF (`mcp-servers/atlassian/src/domains/jira-issues.ts`), a JSON tree that Jira stores for comments and textarea fields[^1]. The model has to read and write that tree to change one sentence.
- The hub has no confirmation policy. Annotations only set the audit category (`mcp-servers/hub/src/executor.ts`); the one gate on Jira writes is the project allowlist (`mcp-servers/atlassian/src/scope.ts`, `assertJiraIssueKeyAllowed`).

## Decision

The API is shaped by what a caller wants to say, and the worker maps it to Jira REST. A first draft that copied the REST shape (`parent: {key}`, `components: [{name}]`) was dropped: the model should not need to know `{key}/{id}` objects or which end of a link is inward.

1. **Tools.** `createIssue`, `updateIssue` (with optional `type`), `deleteIssue`, `linkIssues({ issue, relation, target })`, `unlinkIssues({ link_id })`, `listLinkTypes`, `listComponents({ project })`, `listIssueTypes`. All Jira tools (issue, comment, project, agile) are rebuilt; `confluence-*` is unchanged.
2. **snake_case in and out**, like most hub workers. No backward compatibility with the old camelCase parameters.
3. **Identifiers** (`issue`, `parent`, `target`) are one string, a key or a numeric ID; the code tells them apart by shape.
4. **`parent`** omitted leaves the parent alone; `null` detaches it.
5. **Components** are names. In `updateIssue` the list replaces the current one and an empty list clears it.
6. **`assignee`** is an account ID, `"me"` (resolved through `getMyself`) or `null`.
7. **Markdown in both directions** for descriptions and comments, with an ADF escape hatch for content Markdown cannot carry. The converter is our own (`mcp-servers/atlassian/src/adf.ts`). Nodes with no Markdown equivalent come back as explicit markers, so a loss is visible to the model.
8. **`searchIssues` returns no `description`**, but includes parent, components and links. JQL filtering on the description still works because Jira evaluates it.
9. **Jira 400s become teaching errors.** A subtask without a parent, an unknown component, an unknown link type, a non-empty parent on delete and issue type change limits (JRACLOUD-68207[^2]) are sent as requests, and the 400 is translated into a message naming the next tool to call. No pre-flight GET is made before a write.
10. **`withDeclaredParams` wraps every Jira tool**, so unknown parameters are rejected (SPEED-524).
11. **`deleteIssue`** uses `DESTRUCTIVE_ANNOTATIONS` and the allowlist. It has no `deleteSubtasks`; Jira refuses to delete an issue that has subtasks and the worker turns that into a message.
12. **The allowlist covers `parent` and both ends of a link**, not only the issue the call names.
13. **No hub confirmation mechanism.** The epic's "hub policy" is annotations plus the allowlist; nothing new in the hub.

## Consequences

- Callers on the old names break. The `create-jira-issue` skill (`plugin/stallion/claude-resources/skills/create-jira-issue/`) must migrate; SPEED-416 is informed.
- The mapping from caller shape to REST lives in one place, the worker, so a Jira API change does not reach the tool contract.
- Which side of a link `relation` maps to (`inwardIssue` or `outwardIssue`) is verified against a live Jira instance, not assumed from documentation.
- The model-facing text of a description is lossy for nodes without a Markdown form; the markers and the ADF escape hatch bound the loss.
- Confluence and sharepoint keep camelCase until SPEED-870.

## Alternatives rejected

- **One PR per Story.** The stories rewrite the same files (schemas, `ISSUE_FIELDS`, mapper) several times.
- **Jira-REST-shaped input.** See Decision; it pushes REST details onto the model.
- **`marklassian`, `adf-to-md`, `adf2markdown`.** New dependencies in a worker that holds credentials, and silent loss of nodes such as mentions and panels. An own converter controls what is lossy.
- **A confirmation mechanism in the hub.** A cross-cutting change, outside the epic.
- **Reworking Confluence.** Excluded by the epic; snake_case for Confluence and sharepoint is SPEED-870.

## References

[^1]: Atlassian, Atlassian Document Format structure: "An Atlassian Document Format document is a JSON object", used for text in Jira issue comments and `textarea` custom fields: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/

[^2]: Atlassian, JRACLOUD-68207, "Using REST API the issue type can be changed when workflows are completely different"; closed as fixed with validation that fails when only one of the source and target types is a subtask or when the target workflow lacks the issue's current status: https://jira.atlassian.com/browse/JRACLOUD-68207
