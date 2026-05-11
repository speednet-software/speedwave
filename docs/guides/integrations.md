# Integrations

Speedwave connects Claude Code with external services through MCP (Model Context Protocol) servers.

## Available Integrations

| Integration | Service            | Container                            | Token Path                                  |
| ----------- | ------------------ | ------------------------------------ | ------------------------------------------- |
| Slack       | Messaging          | `speedwave_<project>_mcp_slack`      | `~/.speedwave/tokens/<project>/slack/`      |
| SharePoint  | Documents          | `speedwave_<project>_mcp_sharepoint` | `~/.speedwave/tokens/<project>/sharepoint/` |
| GitLab      | Code hosting       | `speedwave_<project>_mcp_gitlab`     | `~/.speedwave/tokens/<project>/gitlab/`     |
| GitHub      | Code hosting       | `speedwave_<project>_mcp_github`     | `~/.speedwave/tokens/<project>/github/`     |
| Atlassian   | Jira & Confluence  | `speedwave_<project>_mcp_atlassian`  | `~/.speedwave/tokens/<project>/atlassian/`  |
| Redmine     | Issue tracking     | `speedwave_<project>_mcp_redmine`    | `~/.speedwave/tokens/<project>/redmine/`    |
| Playwright  | Browser automation | `speedwave_<project>_mcp_playwright` | N/A (no credentials)                        |
| OS          | Host services      | mcp-os (host process)                | N/A (runs on host)                          |

OS sub-integrations (Reminders, Calendar, Mail, Notes) run via mcp-os on the host — they access native APIs directly (EventKit on macOS, CalDAV/zbus on Linux, WinRT/MAPI on Windows).

#### macOS Permission Check

When you enable an OS integration on macOS, Speedwave checks and requests the required system permission before enabling the integration:

- **Reminders / Calendar** — triggers the macOS Privacy & Security permission dialog (TCC). The system asks whether Speedwave is allowed to access your Reminders or Calendar data.
- **Notes / Mail** — triggers the macOS Automation permission dialog. The system asks whether Speedwave is allowed to control the Notes or Mail application.
- **Cloud storage workspaces** (OneDrive, iCloud Drive, Dropbox, Google Drive) — if your project directory lives under `~/Library/CloudStorage/`, macOS treats it as a protected FileProvider domain. The Lima VM inherits Speedwave's TCC attribution, so on first access macOS shows a Privacy & Security consent dialog for that specific cloud provider. If the VM reports "operation not permitted" when reading your workspace, grant access in **System Settings > Privacy & Security > Files and Folders** (or **Full Disk Access**) for Speedwave. This applies regardless of which integrations are enabled — the mount itself is TCC-gated.

If you deny the permission, the toggle reverts and an error message explains how to grant access. To grant permission after denial, go to **System Settings > Privacy & Security > [Reminders | Calendars | Automation | Files and Folders]**, find Speedwave in the list, and enable it.

The Reminders integration supports tags stored as `[#tag]` markers in the notes field. Use `tags: ["idea", "work"]` in `createReminder` to assign tags; `listReminders` and `getReminder` extract tags from notes and return them separately in the `tags` field. Apple's EventKit API does not expose a dedicated tags property, so tags are persisted in notes using the `[#tag]` convention.

### OS Tools Parameter Reference

#### Reminders

| Tool                | Parameter        | Type     | Default | Description                                      |
| ------------------- | ---------------- | -------- | ------- | ------------------------------------------------ |
| `listReminderLists` | _(none)_         |          |         | Lists all reminder lists — no parameters         |
| `listReminders`     | `list_id`        | string   | —       | Filter by reminder list ID or name               |
| `listReminders`     | `show_completed` | boolean  | false   | Include completed reminders                      |
| `listReminders`     | `limit`          | number   | 20      | Max reminders to return                          |
| `getReminder`       | `id`             | string   | —       | Reminder ID (**required**)                       |
| `createReminder`    | `name`           | string   | —       | Reminder title (**required**)                    |
| `createReminder`    | `list_id`        | string   | —       | Target list ID or name (default list if omitted) |
| `createReminder`    | `due_date`       | string   | —       | ISO 8601 date                                    |
| `createReminder`    | `priority`       | number   | 0       | 0=none, 1=high, 5=medium, 9=low                  |
| `createReminder`    | `notes`          | string   | —       | Additional notes                                 |
| `createReminder`    | `tags`           | string[] | —       | Tags (stored as `[#tag]` in notes)               |
| `completeReminder`  | `id`             | string   | —       | Reminder ID (**required**)                       |

#### Calendar

| Tool            | Parameter     | Type    | Default | Description                                     |
| --------------- | ------------- | ------- | ------- | ----------------------------------------------- |
| `listCalendars` | _(none)_      |         |         | Lists all calendars — no parameters             |
| `listEvents`    | `calendar_id` | string  | —       | Filter by calendar ID or name                   |
| `listEvents`    | `start`       | string  | now     | Start date (ISO 8601)                           |
| `listEvents`    | `end`         | string  | +7 days | End date (ISO 8601)                             |
| `listEvents`    | `limit`       | number  | 20      | Max events to return                            |
| `getEvent`      | `id`          | string  | —       | Event ID (**required**)                         |
| `createEvent`   | `summary`     | string  | —       | Event title (**required**)                      |
| `createEvent`   | `start`       | string  | —       | Start time ISO 8601 (**required**)              |
| `createEvent`   | `end`         | string  | —       | End time ISO 8601 (**required**)                |
| `createEvent`   | `calendar_id` | string  | —       | Target calendar ID or name (default if omitted) |
| `createEvent`   | `location`    | string  | —       | Event location                                  |
| `createEvent`   | `description` | string  | —       | Event description (stored as notes in EventKit) |
| `createEvent`   | `all_day`     | boolean | false   | All-day event                                   |
| `updateEvent`   | `id`          | string  | —       | Event ID (**required**)                         |
| `updateEvent`   | `summary`     | string  | —       | New event title                                 |
| `updateEvent`   | `start`       | string  | —       | New start time (ISO 8601)                       |
| `updateEvent`   | `end`         | string  | —       | New end time (ISO 8601)                         |
| `updateEvent`   | `location`    | string  | —       | New location                                    |
| `updateEvent`   | `description` | string  | —       | New description                                 |
| `deleteEvent`   | `id`          | string  | —       | Event ID (**required**)                         |

`list_id` and `calendar_id` accept either an identifier (UUID) or a display name. The CLI resolves by ID first, falling back to name match.

Mail and Notes tools use AppleScript-based automation and have different parameter conventions — see the tool `inputSchema` via MCP `search_tools` for details.

### Credential Requirements

Each MCP integration requires specific credentials to function. Fields marked as optional do not block the "Configured" status — the integration works without them.

| Integration | Required Fields                                                 | Optional Fields                                      |
| ----------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| Slack       | `bot_token`, `user_token`                                       | —                                                    |
| SharePoint  | `client_id`, `tenant_id`, `site_id`, `base_path` + OAuth tokens | —                                                    |
| GitLab      | `token`, `host_url`                                             | —                                                    |
| GitHub      | `token`                                                         | —                                                    |
| Atlassian   | `site_url`, `email`, `api_token`                                | `jira_project_keys`, `confluence_space_keys` (allowlists; empty = all) |
| Redmine     | `api_key`, `host_url`                                           | `project_id` (scope operations to a default project) |
| Playwright  | _(none — no credentials required)_                              | —                                                    |

### GitHub — Code Hosting

The GitHub integration is a built-in MCP worker that talks to **GitHub.com** through the official Octokit REST client. It is the GitHub-side counterpart to the GitLab worker — repositories, pull requests, branches, commits, GitHub Actions, issues, labels, tags, and releases.

#### Authentication — fine-grained Personal Access Token

GitHub uses a single credential: a **fine-grained Personal Access Token**. Create one in GitHub under **Settings → Developer settings → Fine-grained tokens → Generate new token**, then scope it to exactly the repositories you want Claude to reach (or "All repositories" if you trust the worker with your whole account — not recommended). Paste the `github_pat_...` value into the GitHub integration's `token` field in the Desktop app; it is stored at `~/.speedwave/tokens/<project>/github/token` with `0o600` permissions and mounted read-only into the worker.

Classic (`ghp_...`) tokens also work, but fine-grained tokens are strongly preferred because they let you grant the minimum permission per repository.

#### Per-tool permission matrix

A fine-grained token only carries the repository permissions you tick when creating it. Map the tools you want Claude to use to the permissions the token needs:

| Capability                                                     | Token permission                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------- |
| Read issues                                                    | Issues: Read                                                     |
| Create / update / close issues, labels                         | Issues: Read and write                                           |
| Read pull requests, diffs, reviews, comments                   | Pull requests: Read                                              |
| Create / update / merge PRs, post reviews                      | Pull requests: Read and write                                    |
| Read file contents, branches, commits, trees                   | Contents: Read                                                   |
| Push files, create / delete branches and tags, create releases | Contents: Read and write                                         |
| Read GitHub Actions runs, logs, artifacts, CI status           | Actions: Read **and** Checks: Read **and** Commit statuses: Read |
| Trigger / re-run workflows                                     | Actions: Read and write                                          |

If a token is missing a permission, the worker returns the GitHub `403` body verbatim along with a hint naming the permission to add — so a failed call tells you exactly which checkbox to tick rather than failing silently.

#### Scope and limitations vs GitLab

- **GitHub.com only.** GitHub Enterprise Server (a self-hosted instance) is not supported in v1 — there is no `host_url` field. (GitLab, by contrast, lets you point at a self-hosted instance.)
- **No REST blame API.** GitHub does not expose line-level blame over REST, so there is no `getBlame`-style tool (GitLab has one).
- **GitHub Actions ≠ GitLab Pipelines.** Run logs and artifacts are per-run ZIP archives; the worker returns short-lived download URLs for them rather than streaming log text inline the way the GitLab worker does for pipeline jobs. Plan for an extra fetch step.
- **Comment APIs are split.** General issue/PR conversation comments (`createPrComment`) and inline PR review comments anchored to a diff line (`createPrReviewComment`) are separate GitHub endpoints with different payloads — pick the one matching what you want to post.

#### Tool surface

`listRepos`, `getRepo`, `searchCode`, `listPullRequests`, `getPullRequest`, `createPullRequest`, `mergePullRequest`, `updatePullRequest`, `getPrDiff`, `getPrFiles`, `listPrCommits`, `listPrReviews`, `createPrReview`, `listPrComments`, `createPrComment`, `createPrReviewComment`, `listBranches`, `getBranch`, `createBranch`, `deleteBranch`, `compareBranches`, `listCommits`, `listBranchCommits`, `searchCommits`, `getCommitDiff`, `getTree`, `getFileContents`, `createOrUpdateFile`, `listWorkflowRuns`, `getWorkflowRun`, `getRunLogs`, `rerunWorkflow`, `triggerWorkflow`, `listWorkflowRunArtifacts`, `downloadArtifact`, `listIssues`, `getIssue`, `createIssue`, `updateIssue`, `closeIssue`, `listLabels`, `createLabel`, `createTag`, `deleteTag`, `createRelease`.

### Atlassian — Jira & Confluence

The Atlassian integration is a built-in MCP worker for **Atlassian Cloud** — Jira (issues, comments, worklog, projects, and Agile boards/sprints) and Confluence (spaces, pages, comments, labels, attachments). It is built on a thin `axios` HTTP client over the Jira Cloud REST v3 + Agile 1.0 APIs and the Confluence Cloud REST v2 API; CQL search and bulk label-add use the v1 endpoints (which have no v2 equivalent).

#### Authentication

Atlassian Cloud uses HTTP Basic auth: the worker sends `Authorization: Basic base64(email:api_token)`. Create an API token at <https://id.atlassian.com/manage-profile/security/api-tokens> ("Create API token"). In the Desktop app's Atlassian integration, fill in:

- **`site_url`** — your site, e.g. `https://your-domain.atlassian.net` (must be `https://` and `*.atlassian.net`).
- **`email`** — the account the token belongs to.
- **`api_token`** — the `ATATT3x...` value. Stored at `~/.speedwave/tokens/<project>/atlassian/api_token` with `0o600` permissions, mounted read-only into the worker; it never appears in responses or logs.

Two optional allowlist fields narrow what the worker may touch:

- **`jira_project_keys`** — comma-separated project keys (e.g. `PROJ,OPS`). When set, any operation whose project key is outside the list is rejected. Empty = unrestricted.
- **`confluence_space_keys`** — comma-separated space keys (e.g. `DEV,DOCS`). Same semantics. Empty = unrestricted.

Because the worker authenticates as a real account, it can reach everything that account can — using a dedicated service account with the narrowest workable permissions, plus these allowlists, keeps the blast radius small.

#### Content formats

- **Jira write payloads use ADF.** `createIssue` / `updateIssue` (description) and `addComment` / `addWorklog` (comment) accept either `bodyText` — plain text the worker converts to a minimal Atlassian Document Format document (one paragraph per line) — or `bodyAdf` / `commentAdf`, a pre-built ADF object for rich content.
- **Confluence bodies use the storage representation.** `createPage` / `updatePage` / `addPageComment` accept either `bodyText` (wrapped in a single escaped `<p>`) or `bodyStorage` (raw storage-format XHTML you provide). `updatePage` fetches the current version and increments it automatically — you never pass a version number.

#### Scope and limitations

- **Atlassian Cloud only.** Jira Data Center / Server (self-hosted) is not supported — there is no on-prem PAT field.
- **Enhanced JQL search.** `searchIssues` uses `POST /rest/api/3/search/jql` with an opaque `nextPageToken` cursor (the old `startAt`-based `/rest/api/3/search` is being removed by Atlassian).
- **CQL search is best-effort for scoping.** The v1 `/content/search` endpoint that backs `searchPages` returns less metadata than v2 reads; when a space allowlist is set, results whose space can't be resolved are dropped.
- **Per-request retry.** Read / idempotent calls retry transient `5xx` (and `429`, honouring `Retry-After`); write calls retry only `429`, never `5xx`, so a server error mid-write surfaces rather than risking a duplicated side effect.

#### Why a thin worker, not the official Atlassian Rovo MCP

Atlassian publishes a hosted **Rovo MCP Server** (`mcp.atlassian.com`), but it is a cloud-hosted bridge: it has no self-hostable container, and using it headless means sending the credential to an Atlassian-operated endpoint and depending on that service's availability — incompatible with Speedwave's token-free hub model (the hub holds zero tokens; each worker holds only its own credential, mounted read-only). The ADR-053 "wrap an official upstream MCP server" gate is not met (it is not distributed as an npm package, and integrating with the Atlassian API is a domain integration, not generic infrastructure), so Atlassian gets its own thin worker — the `mcp-servers/gitlab` / `mcp-servers/github` pattern.

#### Why a thin HTTP client, not `jira.js` / `confluence.js`

Inside a worker, Speedwave's convention is: use the service's official SDK (or a large, well-maintained community SDK) when one exists — Slack uses `@slack/web-api`, GitHub uses `@octokit/rest`, GitLab uses `@gitbeaker/rest` — and otherwise write a thin `axios` client like the Redmine worker. Atlassian publishes no official Node SDK, and the popular community libraries (`jira.js`, `confluence.js`) are single-maintainer projects (~489★ / ~110★, no sponsorship); a bus-factor-1 dependency that holds the account credential inside the worker is a risk this security-first repo declines. Jira Basic auth is a single header, JQL pagination is a `nextPageToken` loop, and rate limiting is `429 + Retry-After` — well within the "thin client" envelope.

#### Tool surface

35 tools. Jira: `searchIssues`, `getIssue`, `createIssue`, `updateIssue`, `getTransitions`, `transitionIssue`, `assignIssue`, `getMyself`, `addComment`, `getComments`, `addWorklog`, `listProjects`, `getProject`, `listIssueTypes`, `listBoards`, `getBoard`, `getBoardConfiguration`, `listSprints`, `getSprint`, `moveIssuesToSprint`.
Confluence: `listSpaces`, `getSpace`, `searchPages`, `getPage`, `getPageByTitle`, `createPage`, `updatePage`, `getPageChildren`, `addPageComment`, `getPageComments`, `addPageLabels`, `getPageLabels`, `listAttachments`.

### Redmine Configuration Wizard

The Desktop app provides an auto-configuration wizard for Redmine:

1. **Enter credentials** — provide `host_url` and `api_key`, then click Validate. The Desktop app verifies the credentials against the Redmine API (`GET /users/current.json`).
2. **Select project and mappings** — on success, the wizard fetches available projects, statuses, trackers, priorities, and activities from the Redmine API. Select a project from the dropdown (or "All projects" to work with all projects), then confirm ID mappings for each category. Mappings are auto-matched by comparing English names (e.g., a Redmine status named "In Progress" auto-matches the `status_in_progress` mapping key). Non-English Redmine instances require manual selection from the dropdowns.
3. **Save** — credentials and mappings are saved. Restart containers to apply.

The wizard shows up to 100 projects. For Redmine instances with more projects, find the project slug in the Redmine web UI (visible in the project URL) and set `project_id` directly in `~/.speedwave/tokens/<project>/redmine/config.json`.

Existing configurations with `project_name` in `config.json` continue to work — the MCP server reads it if present and auto-fetches it from the API when absent. Manual `config.json` editing remains supported for power users.

**Troubleshooting:** Corporate environments with custom certificate authorities or HTTP proxies may see TLS or connection errors during credential validation. This is a known limitation shared with SharePoint OAuth — the Desktop app uses bundled CA roots (`rustls-tls`), not the OS certificate store, and does not auto-detect system proxy settings.

### Playwright — Browser Automation

Playwright runs a headless Chromium inside a hardened container and exposes it through Microsoft's official [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) server. It is a **shared service**: both Claude directly and any plugin can use the same browser — Chromium is not duplicated per plugin.

#### When to use Playwright vs `WebFetch`

- `WebFetch` is built into Claude and suits **static HTML** — a GET + HTML-to-markdown conversion. Use it for docs, READMEs, blog posts, anything server-rendered.
- Playwright runs a real browser and suits **dynamic pages** — JavaScript-rendered SPAs, pages behind a login flow, pages that require waiting for XHR-driven content, or any task that needs screenshots, accessibility snapshots, DOM interaction, or computed styles.

Prefer `WebFetch` when it works; drop to Playwright only when it does not. A Chromium context is an order of magnitude more expensive than a `WebFetch` call.

#### Security profile

Playwright is unique among the built-in integrations in three ways:

- **No credentials.** It accesses only public URLs; there is no `/tokens` mount and no credential file. Enabling the integration requires no configuration.
- **No `/workspace` mount.** Screenshots, PDFs, and page dumps are returned to Claude as base64 payloads rather than written to the project. This keeps a compromised Chromium from exfiltrating repo contents.
- **Higher resource limits.** `shm_size: 2g` (Chromium IPC needs it), `tmpfs /tmp: 1g` (Chromium caches heavily), `cpus: 2.0`, `memory: 2048m` — noticeably larger than the 128 MiB budget given to HTTP-only workers.

Container hardening is otherwise identical to every other MCP worker: `cap_drop: ALL`, `no-new-privileges:true`, `read_only: true` root filesystem, `noexec,nosuid` on `/tmp`. Chromium runs with `--no-sandbox` because the Lima/WSL2 VM + container capability-drop layer replaces its in-process sandbox (see [ADR-004](../adr/ADR-004-wsl2-and-nerdctl-on-windows.md)). Each container restart wipes `/tmp` (tmpfs-backed), giving the same ephemeral-profile guarantee as `--isolated` — no cookies, no storage state persist between invocations.

#### Tool surface

`@playwright/mcp` exposes roughly 70 tools grouped into:

- **Navigation** — `browser_navigate`, `browser_navigate_back`, `browser_tabs`.
- **Extraction** — `browser_snapshot` (accessibility tree, token-efficient), `browser_take_screenshot`, `browser_pdf_save`, `browser_evaluate`, `browser_network_requests`, `browser_console_messages`.
- **Interaction** — `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_press_key`, `browser_hover`, `browser_drag`.
- **Assertions and codegen** — `browser_verify_element_visible`, `browser_verify_text_visible`, `browser_generate_locator`, `browser_pick_locator`.
- **Tracing** — `browser_start_tracing`, `browser_start_video`, `browser_stop_tracing` (gated behind `--caps devtools` when explicitly enabled).

Refer to the [upstream README](https://github.com/microsoft/playwright-mcp) for the full list and parameter schemas.

## MCP Hub Architecture

The MCP Hub (`speedwave_<project>_mcp_hub`, port 4000) is the **only** MCP server Claude sees:

- **`search_tools`** — discovers available tools across all enabled integrations, including OS tools
- **`execute_code`** — routes tool execution requests to the appropriate worker (e.g., `os.listReminders()`, `os.createEvent()`)
- **HTTP bridge** — communicates with mcp-os on the host via `WORKER_OS_URL`

The Hub has **zero tokens** — it acts as a router. Each worker container mounts only its own service credentials.

## Workspace Mount

MCP service containers (both built-in SharePoint and plugins) mount the project directory as `/workspace:rw`:

```
{project_dir}:/workspace:rw
```

This allows MCP workers and Claude to share files through identical paths — `/workspace/...` is valid for both. No path translation needed and no separate context directory is required.

The path validator blocks access to sensitive paths within the workspace: `.git/`, `.env`, and `.speedwave/`. These entries are enforced by a denylist in `path-validator.ts`, ensuring that MCP workers cannot read or write protected files even though the full project directory is mounted.

## Adding New Integrations

Speedwave supports extending integrations via the plugin system:

- `speedwave plugin install <path.zip>` verifies the Ed25519 signature and extracts the plugin to `~/.speedwave/plugins/<slug>/`
- Each plugin contains a `plugin.json` manifest, an optional MCP service (`src/`, `Containerfile`), and optional claude-resources (`skills/`, `commands/`)
- `compose.rs` generates plugin service containers via `apply_plugins()`
- Plugin services get injected `WORKER_<PLUGIN>_URL` in the hub environment
- Plugin images are automatically rebuilt if missing (e.g. after a VM reset or `nerdctl system prune`) — you do not need to reinstall the plugin

### Install progress overlay (Desktop)

The Desktop install dialog reports progress through the `plugin_install_status` Tauri event. The flow has up to four phases:

1. `verifying` — Ed25519 signature check
2. `extracting` — unpack the ZIP into `~/.speedwave/plugins/<slug>/`
3. `building` — `nerdctl build` for plugins with a `service_id` (skipped for resource-only plugins; can take 2–5 minutes for heavy dependencies)
4. `done` — terminal success

If the image build fails, the overlay shows the failure inline and emits a final `done_with_pending_build` event. The plugin is left on disk; the build retry marker now lives at `~/.speedwave/plugin-state/<slug>/image_pending` (outside the signed plugin tree, see [ADR-051](../adr/ADR-051-plugin-signature-runtime-verification.md)) and `ensure_all_plugin_images` retries the build automatically on the next launch. See [ADR-047](../adr/ADR-047-plugin-install-progress-events.md) for the event payload and per-platform cleanup behaviour.

### Plugin verification & recovery

Speedwave verifies each plugin's Ed25519 signature **on every load**, not just at install time. If a file inside `~/.speedwave/plugins/<slug>/` changes after install — even by accident — the next launch refuses to start until the affected plugin is removed or reinstalled. See [ADR-051](../adr/ADR-051-plugin-signature-runtime-verification.md) for the threat model.

The Desktop app shows an error dialog listing every failed plugin and the recovery commands. The CLI prints the same list and exits with code 2. Recovery commands (`speedwave plugin remove`, `speedwave plugin install`, `speedwave plugin list`) bypass the audit so you can always reach them, even when another plugin is failing.

To recover from a verification failure:

```bash
# 1. List all installed plugins and their verification status
speedwave plugin list

# 2. Remove the failed plugin
speedwave plugin remove <slug>

# 3. Reinstall a fresh signed plugin
speedwave plugin install /path/to/plugin.zip
```

If the CLI is unavailable, manual recovery also works:

```bash
rm -rf ~/.speedwave/plugins/<slug>
rm -rf ~/.speedwave/plugin-state/<slug>      # mutable per-plugin state, if any
```

After cleanup, restart Speedwave. The Desktop app will start normally if no other plugin fails verification.

See [ADR-015](../adr/ADR-015-plugin-system.md) for the plugin system design and [ADR-036](../adr/ADR-036-self-declaring-worker-policy.md) for the tool policy model.

### Tool Policy via `_meta`

Workers (both built-in and plugins) control how the hub presents their tools by declaring a `_meta` field on each tool definition:

```typescript
const myTool: Tool = {
  name: 'myTool',
  description: '...',
  inputSchema: { type: 'object', properties: { ... } },
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    deferLoading: false,    // show this tool to Claude immediately (default: true)
    timeoutMs: 60000,       // custom timeout in ms (default: global WORKER_REQUEST_MS)
    timeoutClass: 'long',   // 'standard' or 'long' (default: 'standard')
    osCategory: 'calendar', // OS sub-integration routing (only for mcp-os)
  },
};
```

**Default behavior**: tools without `_meta` default to `deferLoading: true` — they are discoverable via `search_tools` but not shown upfront to Claude. This keeps token usage low when many tools are registered. To make a tool visible immediately, set `_meta: { deferLoading: false }`.

When a bundle update triggers image rebuilds, container restart operations (including plugin containers) automatically wait for builds to complete before proceeding.

Plugins that declare `requires_integrations` (e.g. `["sharepoint"]`) display the required integration status on the plugin dashboard. The Desktop UI indicates whether required integrations are configured, linking to the Integrations tab when they are not.

Plugin authors should set `speedwave_compat` in `plugin.json` to declare which Speedwave versions the plugin supports — for example, `"speedwave_compat": ">=0.8, <1"` for plugins targeting the 0.8 series. If the field is present and the running Speedwave version does not satisfy the declared range, installation is rejected with a clear error. Omit the field to disable the check. See [ADR-015](../adr/ADR-015-plugin-system.md) for details on the enforcement model and version-requirement syntax.

**Line endings (Windows authors).** If you author plugins on Windows, add a `.gitattributes` file at the root of your plugin repo with at minimum:

```
* text=auto eol=lf
*.sh text eol=lf
```

This prevents `core.autocrlf=true` (the default on Windows-hosted Git) from rewriting `*.sh` line endings to CRLF on checkout. A plugin `Containerfile` that runs a CRLF `*.sh` will fail with `exit code: 127` (`/bin/sh: 1: …: not found`) when Buildkit invokes the kernel's shebang resolver — see Speedwave issue #603 for context.

## Local LLM Setup

You can run Claude Code inside Speedwave against a local LLM server instead of Anthropic's cloud API. Go to **Settings → LLM Provider** to select a provider.

### Ollama (requires 0.14.0+)

1. Install Ollama and pull a model:

   ```bash
   OLLAMA_HOST=0.0.0.0 ollama serve   # must bind to 0.0.0.0, not 127.0.0.1
   ollama pull llama3.3
   ```

   > **Important:** Ollama binds to `127.0.0.1` by default. The `claude` container cannot reach the loopback interface — set `OLLAMA_HOST=0.0.0.0` before starting `ollama serve`.

2. In Speedwave Settings → LLM Provider → select **Ollama**
3. The Settings UI fetches the model list from Ollama's `/api/tags` endpoint and pre-selects one automatically. You only need to type the model name manually if the Ollama server is offline when you open Settings.
4. Leave **Base URL** empty to use the default (`http://host.docker.internal:11434`)
5. Restart containers

### LM Studio (requires 0.4.1+)

1. In LM Studio, load a model and enable the **Local Server**
2. In Speedwave Settings → LLM Provider → select **LM Studio**
3. Leave Base URL empty for the default port (`http://host.docker.internal:1234`)
4. Restart containers

### llama.cpp (requires January 2026 build or later)

1. Start `llama-server` with the Anthropic API server enabled
2. Select **llama.cpp** in Settings → LLM Provider
3. Default port: `http://host.docker.internal:8080`

### Non-standard addresses

The `custom` provider no longer exists. If your LLM server is at a non-standard address (e.g. another machine on your LAN at `http://192.168.1.100:11434`), pick the closest matching provider (Ollama, LM Studio, or llama.cpp) and override the **Base URL** field to point at your server. The URL must use `http://` or `https://` and must not include a path.

## See Also

- [ADR-010: mcp-os as Host Process Per Platform](../adr/ADR-010-mcp-os-as-host-process-per-platform.md)
- [ADR-013: mcp-os as Host Process — Implementation Details](../adr/ADR-013-mcp-os-as-host-process-implementation.md)
- [ADR-015: Plugin System](../adr/ADR-015-plugin-system.md)
- [ADR-036: Self-Declaring Worker Policy](../adr/ADR-036-self-declaring-worker-policy.md)
- [ADR-040: Remove LiteLLM — Direct Local Provider Injection](../adr/ADR-040-remove-litellm-direct-provider-injection.md)
- [ADR-041: Local LLM Model Discovery and SSRF Policy](../adr/ADR-041-local-llm-model-discovery.md)
