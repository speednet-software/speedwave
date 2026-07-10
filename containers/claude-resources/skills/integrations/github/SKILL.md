---
name: github
description: Use GitHub integration to query and manage GitHub.com repositories, pull requests, issues, branches, commits, Actions workflow runs, labels, tags, and releases. Use whenever the user asks about GitHub, opening or reviewing PRs, getting PR diffs, listing or commenting on issues, comparing branches, reading workflow logs, creating releases, searching code, checking "my open PRs" or "my assigned issues", etc. Use even when you think you know the answer, repository state is dynamic, only the live API reflects current PR status, workflow runs, or issue assignments. Do not use for plain git operations on the local checkout, GitLab or self-hosted GitHub Enterprise (out of scope), general code review questions, or any repo not on GitHub.com.
user-invocable: false
allowed-tools: mcp__speedwave-hub__search_tools mcp__speedwave-hub__execute_code
---

# GitHub

GitHub access goes through MCP Hub. You do not see `github__*` tools directly: they are discovered at call time via `search_tools` and invoked through `execute_code` using the injected `github` global. The token is normally obtained via GitHub OAuth App device flow (or a manually-provided fine-grained PAT as an advanced fallback); it is pre-configured at the worker and mounted read-only: never pass it, ask the user for it, or shell out to `gh` or the raw REST API.

## Workflow

1. **Discover**: `search_tools({ query: "github <keywords>", detail_level: "names_only" })` to see what fits.
2. **Inspect**: `search_tools({ query: "...", detail_level: "full_schema", service: "github" })` for the exact parameter names of the tool you need.
3. **Execute**: `execute_code` with dot notation: `await github.getPullRequest({ owner, repo, number })`.

Always do steps 1-2 before calling a tool for the first time in a conversation.

## Pitfalls

**Identity ("my issues/PRs/commits")**: none of GitHub's REST filters accept a literal `'me'` except `searchCommits`'s `query`, which documents `author:@me` as built-in shorthand for the authenticated user, use that directly instead of resolving a login first. Every other identity-scoped filter (`listRepos`'s default owner, `listIssues`' `assignee`/`creator`, `createIssue`/`updateIssue`'s `assignees`, `listCommits`' `author`) needs the resolved login; the tool description names the current-user tool to call first. `listPullRequests` has no author filter at all: resolve the login, then match it against `pr.user` yourself, bounding the scan (stop once you have paged through enough results) rather than walking every open PR in a large repo. If you cannot resolve a login and the user asks about "mine", ask them rather than guessing or silently returning unscoped results.

**Repo identifier**: every tool takes `owner` and `repo` as two separate strings, but a combined `owner/repo` passed in `repo` (e.g. a `full_name` value from `listRepos`) is split automatically when `owner` is omitted. Decompose a URL (`https://github.com/foo/bar/pull/1` → `owner: "foo"`, `repo: "bar"`, `number: 1`). Never pass the full URL or include the `.git` suffix.

**GitHub.com only**: GitHub Enterprise Server (self-hosted, `*.ghe.com`, custom domains) is not supported. There is no `host_url` field. If the user mentions a self-hosted instance, say so and stop.

**No line-level blame**: the GitHub REST API has no blame endpoint, so no blame tool exists. Pivot to `getFileContents` plus `searchCommits` when the user wants to know who changed a line.

**Actions log URLs**: `getRunLogs` returns a short-lived ZIP download URL, not inline log text. Fetch and parse the archive if the user needs specific failure output.

**Two PR comment endpoints**: one posts a general conversation comment on the PR; the other anchors to a specific file and diff line. The live schema distinguishes them; pick the right one, the payloads differ and mixing them causes API errors or misdirected comments.

**Rate limit**: authenticated calls share a 5 000/hour budget per token. On a `403 rate limit exceeded`, stop and tell the user; do not retry in a loop.

**Write/delete confirmation**: follow the global rule in `claude-resources/CLAUDE.md`: always restate the action and wait for explicit user go-ahead before any create, update, merge, close, delete, trigger, or comment operation.

**Token scope**: OAuth App tokens carry the scopes granted during the device-flow authorization; a manually supplied fine-grained PAT carries only the repository permissions selected at creation. A `403` from a tool includes the GitHub error body; surface the missing-permission hint rather than retrying.

## When NOT to use

- GitHub Enterprise Server / self-hosted instances: not supported; tell the user.
- Repo admin operations (webhooks, branch protection rules, collaborator management, repository settings): the worker does not expose admin tools; direct the user to the GitHub UI.
