---
name: gitlab
description: Use GitLab integration to query and manage projects, merge requests, issues, pipelines, branches, commits, files, and releases on the configured GitLab instance. Use whenever the user asks about GitLab, listing MRs, reviewing diffs, opening or merging MRs, creating/closing issues, comparing branches, reading pipeline status, fetching files, searching code, checking "my open MRs" or "my assigned issues", etc. Use even when you think you know the answer, repository state is dynamic and only the live API reflects current MR status, pipeline runs, or issue assignments. Do not use for plain git operations on the local checkout, GitHub.com (use github), general code review questions, or anything outside the configured GitLab instance.
user-invocable: false
allowed-tools: mcp__speedwave-hub__search_tools mcp__speedwave-hub__execute_code
---

# GitLab

GitLab access goes through MCP Hub. Claude does not see `gitlab__*` tools directly: use `search_tools` to discover them and `execute_code` with the injected `gitlab` global to invoke. `host_url` and `token` are pre-configured at the worker; never pass them, never ask the user for a GitLab token.

## Workflow

1. `search_tools({ query: "<keywords>", detail_level: "names_only", service: "gitlab" })`: discover what is available.
2. `search_tools({ query: "<toolName>", detail_level: "full_schema", service: "gitlab" })`: get the exact parameter schema.
3. `execute_code`: call the tool using the parameter names from the schema.

Always run step 1-2 before guessing a tool name. The live schema is the source of truth.

## Pitfalls

- **IID vs DB ID.** Issues and MRs use per-project `issue_iid` / `mr_iid`, the numbers users see in URLs (`/-/issues/42`, `/-/merge_requests/42`). Not the internal database ID. Accepts a plain number or a string, with or without a leading `#` (e.g. `42` or `"#42"`).
- **Project paths.** Pass `group/subgroup/project` as a plain string. The tool URL-encodes slashes for you; do not pre-encode `%2F`.
- **Identity ("my MRs"/"my issues"/"my projects").** Use `listMrIds`/`listIssues` with `scope: "assigned_to_me"` or `"created_by_me"`, or `listProjectIds` with `owned: true`, these resolve identity server-side without needing a username. Call `getCurrentUser` first when you need the caller's own numeric ID or username directly (e.g. to compare against an `author_id` field returned by another tool).
- **Pipeline triggers cost CI minutes.** Confirm before retrying or triggering a pipeline.
- **Search beats tree-walking.** When looking for a symbol or file, reach for `searchCode` before listing directories blindly.
- **Job IDs come from pipelines.** `getJobLog`, `downloadArtifact`, and `deleteArtifacts` take a `job_id`, get valid values from `getPipelineFull`'s `jobs` array, not by guessing.
- **`downloadArtifact` returns a job log, not the CI artifact zip.** This worker cannot fetch raw artifact bundle contents.
- **Write/delete confirmation.** Per `claude-resources/CLAUDE.md`, every create/update/close/merge/delete needs explicit user approval before execution. Read operations (list/get/search/compare/diff/blame) never need confirmation.

## When NOT to use

- Plain git operations on the local checkout (clone, commit, push): use the shell, not this integration.
- GitHub.com repositories: use the github integration instead.
- Anything outside the single GitLab instance configured for this project.
