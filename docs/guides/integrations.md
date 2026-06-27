# Integrations

Speedwave connects Claude Code with external services through MCP (Model Context Protocol) servers.

## Available Integrations

| Integration | Service            | Container                            | Token Path                                           |
| ----------- | ------------------ | ------------------------------------ | ---------------------------------------------------- |
| Slack       | Messaging          | `speedwave_<project>_mcp_slack`      | `~/.speedwave/tokens/<project>/slack/`               |
| SharePoint  | Documents          | `speedwave_<project>_mcp_sharepoint` | `~/.speedwave/tokens/<project>/sharepoint/`          |
| GitLab      | Code hosting       | `speedwave_<project>_mcp_gitlab`     | `~/.speedwave/tokens/<project>/gitlab/`              |
| GitHub      | Code hosting       | `speedwave_<project>_mcp_github`     | `~/.speedwave/tokens/<project>/github/`              |
| Atlassian   | Jira & Confluence  | `speedwave_<project>_mcp_atlassian`  | `~/.speedwave/tokens/<project>/atlassian/`           |
| Redmine     | Issue tracking     | `speedwave_<project>_mcp_redmine`    | `~/.speedwave/tokens/<project>/redmine/`             |
| Office      | Word/Excel/PPT/PDF | `speedwave_<project>_mcp_office`     | N/A (no credentials)                                 |
| Playwright  | Browser automation | `speedwave_<project>_mcp_playwright` | N/A (no credentials)                                 |
| Context7    | Library docs       | `speedwave_<project>_mcp_context7`   | `~/.speedwave/tokens/<project>/context7/` (optional) |
| OS          | Host services      | mcp-os (host process)                | N/A (runs on host)                                   |

OS sub-integrations (Reminders, Calendar, Mail, Notes) run via mcp-os on the host — they access native APIs directly (EventKit on macOS, WinRT/MAPI on Windows).

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

| Integration | Required Fields                                    | Optional Fields                                                        |
| ----------- | -------------------------------------------------- | ---------------------------------------------------------------------- |
| Slack       | `access_token` (via **Sign in with Slack**)        | —                                                                      |
| SharePoint  | `client_id`, `tenant_id`, `site_id` + OAuth tokens | —                                                                      |
| GitLab      | `token`, `host_url`                                | —                                                                      |
| GitHub      | `token`                                            | —                                                                      |
| Atlassian   | `site_url`, `email`, `api_token`                   | `jira_project_keys`, `confluence_space_keys` (allowlists; empty = all) |
| Redmine     | `api_key`, `host_url`                              | `project_id` (scope operations to a default project)                   |
| Office      | _(none — no credentials required)_                 | —                                                                      |
| Playwright  | _(none — no credentials required)_                 | —                                                                      |
| Context7    | _(none — anonymous mode works)_                    | `api_key` (higher rate limits; anonymous is per-IP rate-limited)       |

### Enabling an integration — first build on demand

When you toggle an integration on for the first time in a project, Speedwave builds its worker container image on demand (ADR-057). The build is part of the "Restarting containers…" wait. First builds of heavy images (e.g. `playwright`, which pulls Chromium; `office`, which pulls LibreOffice + a Python venv) noticeably extend that wait; subsequent toggles are near-instant because the build is cached.

If the build fails (network, disk), the integration row reverts to disabled — your running containers keep their prior configuration. Disabling an integration drops its worker image; re-enabling rebuilds.

### Slack — Messaging

The Slack integration is a built-in MCP worker that acts **as you** — messages sent by Claude carry your name and avatar, not a bot identity. Authentication is a single **Sign in with Slack** button ([ADR-071](../adr/ADR-071-slack-oauth-pkce-user-tokens.md)); there is nothing to type and no Slack app to create.

**Signing in:**

1. Open **Integrations → Slack** in Speedwave Desktop and click **Sign in with Slack**.
2. Your browser opens Slack's consent screen — pick the workspace and click **Allow**. Workspaces with app approval enabled need a one-time admin approval of the Speedwave app.
3. The browser redirects to `http://localhost:41739/callback` on your machine; Speedwave exchanges the code locally (PKCE — no client secret exists anywhere) and the card shows **Connected to <workspace>**.
4. Click **Restart** when prompted so the worker picks up the credentials.

**What is stored where:**

- `~/.speedwave/tokens/<project>/slack/access_token` — the short-lived access token (about 12 hours), the only file the worker container can see (`:ro`).
- `~/.speedwave/oauth/<project>/slack.json` — host-only state: the rotating refresh token plus workspace identity. Never mounted into any container.

The host-side `oauth` worker ([ADR-060](../adr/ADR-060-host-side-oauth-refresh-worker.md)) refreshes the access token on demand; each refresh also rotates the refresh token. Two caveats follow from the token model:

- **Refresh tokens expire after 30 days.** If a project sits idle past that, the card shows a re-authorise banner — sign in again to restore access.
- **Refresh runs in Speedwave Desktop.** With Desktop closed and only the CLI running, the current access token keeps working until it expires (up to 12 hours), then tool calls ask you to reconnect from Desktop.

**Requested user scopes** (the integration can do exactly this, nothing more): `chat:write` (send messages as you — channels and DMs), `channels:read` + `groups:read` (list public/private channels you are in), `channels:history` + `groups:history` (read history of those channels), `im:read` + `mpim:read` (list your direct-message conversations), `im:history` + `mpim:history` (read those conversations), `im:write` + `mpim:write` (open a DM conversation — sending itself uses `chat:write`), `files:read` (read and download files shared with you), `users:read` + `users:read.email` (show real names instead of user IDs; find people by name or e-mail). You can only read conversations **you are a member of** — the integration never sees anything your account cannot.

**Files shared in channels.** Text files (markdown, code, logs, JSON) are read inline. Binary files (PDF, Word/Excel, images) are downloaded into the project workspace at `/workspace/.speedwave/slack/` — when the **Office** integration is also enabled, Claude can then read PDFs and documents from there.

**Direct messages.** Claude can read and send 1:1 DMs and group DMs, find people by name, and shows author names instead of raw user IDs. Sending is deliberately friction-full: the bundled skill requires Claude to show you the exact recipient and the verbatim message text and wait for your explicit go-ahead before sending **anything** — channel post or DM, no exceptions.

**Connected before a permission was added?** The scope list grows as features ship (files in channels, direct messages). When your existing sign-in lacks a now-required permission, the integration card shows a re-authorise banner — sign in again once to grant the full set.

Disconnecting (**Remove Credentials**) deletes the local tokens and state. To revoke the grant on Slack's side as well, remove the Speedwave app under your Slack profile's **Settings → Apps**.

### GitHub — Code Hosting

The GitHub integration is a built-in MCP worker that talks to **GitHub.com** through the official Octokit REST client. It is the GitHub-side counterpart to the GitLab worker — repositories, pull requests, branches, commits, GitHub Actions, issues, labels, tags, and releases.

#### Authentication — OAuth App device flow

The Desktop app authorizes GitHub via the **Speedwave GitHub OAuth App** (registered by Speednet on github.com) using the **device flow** — the same UX as `gh auth login`:

1. Click **Sign in with GitHub** on the integration card.
2. The Desktop app shows a short user code (e.g. `ABCD-1234`) and a link to `https://github.com/login/device`.
3. Open the link, paste the code, click **Authorize Speedwave**.
4. The Desktop app stores the resulting `gho_...` access token at `~/.speedwave/tokens/<project>/github/token` (`0o600` permissions) and mounts it read-only into the worker.

The token is **long-lived** (no expiration window in the OAuth App device flow — GitHub does not publish a precise inactivity TTL, but it is on the order of a year of unused; reconnect manually if a tool call returns `401`). Speedwave does **not** persist a refresh token (there is none for OAuth App device flow), and the access token never crosses the Tauri ↔ Angular boundary — the polling task writes it to disk directly.

The scopes requested are `repo read:user`:

- **`repo`** — full control of private and public repos. Covers Issues, Pull requests, Contents, Releases, branches, commits, and GitHub Actions (runs, logs, artifacts, workflow dispatch).
- **`read:user`** — used by the connection health probe (`GET /user`).

Org and gist scopes are intentionally not requested — the worker does not call those endpoints.

##### Advanced: PAT fallback

For headless setups or environments where the OAuth flow is unavailable (e.g. GitHub org admins who disable OAuth Apps), you can drop a Personal Access Token (classic `ghp_...` or fine-grained `github_pat_...`) directly into the token file. The worker does not inspect the prefix — any token GitHub accepts works.

If you go this route, the per-tool permissions matrix below maps Claude capabilities to the fine-grained permissions you need:

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

When a tool call hits a permission gap, the worker surfaces a generic "token is missing a required scope" message that points users at either the OAuth reconnect path or the PAT permission they need to add.

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

33 tools. Jira: `searchIssues`, `getIssue`, `createIssue`, `updateIssue`, `getTransitions`, `transitionIssue`, `assignIssue`, `getMyself`, `addComment`, `getComments`, `addWorklog`, `listProjects`, `getProject`, `listIssueTypes`, `listBoards`, `getBoard`, `getBoardConfiguration`, `listSprints`, `getSprint`, `moveIssuesToSprint`.
Confluence: `listSpaces`, `getSpace`, `searchPages`, `getPage`, `getPageByTitle`, `createPage`, `updatePage`, `getPageChildren`, `addPageComment`, `getPageComments`, `addPageLabels`, `getPageLabels`, `listAttachments`.

### SharePoint — Files and Pages

SharePoint integration combines two Microsoft Graph surfaces: a SharePoint document library (files) and SharePoint Pages (the modern wiki / site content). The worker runs in a hardened container with `/tokens:ro` (per ADR-060) and refresh tokens are kept on the host inside the `oauth` worker — see the OAuth flow below.

**Configuration.** The Desktop integration form collects `client_id`, `tenant_id`, `site_id`. The OAuth device-code flow runs once at setup and writes two locations: the worker-mounted token directory (read-only mount) holds `access_token` and `site_id`; the host-only OAuth state directory holds `{ provider, providerData: { clientId, tenantId }, refreshToken, scopes, grantedScopes, expiresAt, lastRefreshAt }`. The `provider` field selects the IdP implementation registered in the worker; IdP-specific keys live under `providerData` so future OAuth integrations (e.g. Atlassian) plug in without touching this schema.

**Upgrading from a v1 SharePoint setup.** Pre-ADR-060 builds (and the first pass of ADR-060 before the OAuthProvider refactor) stored `clientId` / `tenantId` at the top level of `oauth/<project>/sharepoint.json` instead of under `providerData`. On startup, a shape-only self-heal migration nests any such top-level identity under `providerData` (preserving every other field, never touching secrets), so the worker refresh succeeds and the Integrations page shows the correct Client ID / Tenant ID. If the file is too damaged to recover (no usable identity, or no refresh token because the original sign-in never completed), the Integrations page shows the "Re-authorize SharePoint" banner even while the card reads "Not Configured" — clicking "Sign in" reruns the device-code flow and rewrites the file in the new shape. The startup cleanup also removes any legacy `refresh_token` / `client_id` / `tenant_id` files left over inside the worker-mounted token directory. No manual migration steps are required.

**Site ID format.** `site_id` must be a Graph site id — either path form (e.g. `acme.sharepoint.com:/sites/Marketing:` — note both colons: one after the hostname and one at the end) or composite form (`{hostname},{site-guid},{web-guid}`, obtained by calling `GET /sites/{hostname}:/sites/{path}` in Graph Explorer and copying the `id` field). A raw SharePoint URL (`https://{tenant}.sharepoint.com/sites/{name}`) is rejected at worker startup with a guidance message; the worker reports `configured: false` until a valid value is provided. Validation is fail-closed (no URL normalization in the worker) to keep the token mount at a clear trust boundary.

**Scopes.** SharePoint requests `Sites.Manage.All Files.ReadWrite.All User.Read offline_access`. `Sites.Manage.All` is the broadest of the three site scopes Microsoft offers (covers `Sites.ReadWrite.All` and `Sites.Read.All`); it is required for `createList` (PR5) and is requested up-front so a single consent dialog covers all SharePoint operations. `Sites.Manage.All` typically requires tenant admin consent in Azure AD; users in tenants without admin consent will be prompted to request it during the device-code flow.

**Tool surface.** 28 tools total:

- Files (5): `listFileIds`, `getFileFull`, `downloadFile`, `uploadFile`, `getCurrentUser`.
- Pages (10, PR4): `listPages`, `getPage`, `createPage`, `updatePage`, `addWebPart`, `updateWebPart`, `removeWebPart`, `publishPage`, `generateTableOfContents`, `addImageWebPart`.
- Lists / items / columns / deletion (13, PR5): `listLists`, `getList`, `createList`, `updateList`, `deleteList`, `addListColumn`, `removeListColumn`, `listItems`, `getItem`, `createItem`, `updateItem`, `deleteItem`, `deletePage`.

**Site policy by omission.** None of the page / list / item / column tools accept a `site_id` parameter. The worker uses the `site_id` it reads from `/tokens/site_id` at startup, so the model has no way to target another site — security by design, not by validation. A regression test (`PAGE_TOOL_SCHEMAS` / `LIST_TOOL_SCHEMAS`) asserts no schema introduces a `site_id` field.

**Column types** in `addListColumn` are restricted to the six Microsoft Graph types covered by PR5: `text`, `number`, `boolean`, `dateTime`, `choice`, `lookup`. Other types (calculated, geolocation, term) are out of scope.

**Web part types** in `addWebPart` cover the text web part (via `innerHtml`) and the 14 standard web parts Microsoft Graph documents: `bingMaps`, `button`, `callToAction`, `divider`, `documentEmbed`, `image`, `imageGallery`, `linkPreview`, `orgChart`, `people`, `quickLinks`, `spacer`, `youtubeEmbed`, `titleArea`. Per-type `data` shape is webPart-specific; Microsoft Graph documents the envelope but not the per-type `properties` schema — consult the SharePoint UI / SPFx docs / PnPjs examples for individual web-part payloads. `updateWebPart` is currently text-only (PATCH at `.../webparts/{id}` with `innerHtml`).

**Home pages (`pageLayout: "home"`).** Microsoft Graph examples and request templates exclusively use `pageLayout: "article"`. Adding web parts to a `home` page via `POST .../webparts` surfaces as `400 Bad Request` even on freshly-created sections. This is a Graph limitation, not a Speedwave bug — for editable content, prefer creating an `article` page (the default for `createPage`). Two follow-ups specific to home pages, verified live:

- `updatePage(canvasLayout)` on `Home.aspx` persists in Graph (eTag bumps, `versionId` increments, `lastModifiedDateTime` updates), but the page **stays in `draft` state** until `publishPage` is called. SharePoint serves the last-published version to most viewers, so users won't see the edits even though the API reports success. Always follow `updatePage` on a home page with `publishPage` (or instruct the caller to "Publish again" from the SharePoint banner).
- `titleArea.imageWebUrl` is documented for `sitePage`, but the home layout renders its hero from `pageLayout: home`-specific templates; the `titleArea` image typically does not appear on home pages even when set successfully. Use `article` pages for hero images.

**Section emphasis** in `canvasLayout.horizontalSections[].emphasis` accepts `none`, `neutral`, `soft`, `strong`, `unknownFutureValue` (Graph `sectionEmphasisType`). Apply via `updatePage` with the full `canvasLayout`. Section `layout` accepts `none`, `oneColumn`, `twoColumns`, `threeColumns`, `oneThirdLeftColumn`, `oneThirdRightColumn`, `fullWidth`, `unknownFutureValue`.

**Navigation (Quick Launch, top nav, hub nav) is not exposed.** Microsoft Graph v1.0 and beta do not publish endpoints for SharePoint site navigation — those still live in the SharePoint REST API (`/_api/web/navigation/...`). Speedwave talks to Graph only (see ADR-060 site-policy invariant), so editing Quick Launch / top nav / hub nav has to be done in the SharePoint UI for now.

**Image web parts.** Use `sharepoint.uploadFile` to push the source into the site's drive, then call `sharepoint.addImageWebPart({ pageId, sectionIndex, columnIndex, sharepointPath })` — the worker looks up the file's `sharepointIds` and `image` facet so the payload survives the SharePoint UI image-picker reconciliation on Save & Close. External image URLs sent to `addWebPart({ webPartType: "image", ... })` directly will be visible in the Edit view but dropped on UI Save (live-verified 2026-05).

**canvasLayout round-trip.** When you `getPage` and re-`updatePage` the layout, strip UI-only fields that the SharePoint editor writes on Save but Graph PATCH rejects (e.g. `customContentDropSupport`). `pages-client.ts` exports `stripUiOnlyWebPartFields` for this and `patchPage` applies it automatically.

**Footnotes are not natively supported.** SharePoint Modern Pages has no footnote feature (auto-numbering, `[^1]` ↔ `[^1]:` references). Verified: (a) none of the 14 standardWebPart types in Graph is a footnote/reference type; (b) Microsoft's "Use the Markdown web part" docs confirm the Markdown web part uses Marked.js but does NOT enable GFM footnotes; (c) the Markdown web part is itself not in the Graph-supported web-parts table, so it cannot be added through `addWebPart` either way. A third-party SPFx web part (`better-markdown-webpart`) supports GFM footnotes, but installing it requires tenant-wide SPFx package deployment (`.sppkg`) outside the Graph API surface. Workaround through Speedwave: emit manual `<sup>[N]</sup>` markers in text web parts plus a separate "Sources" section at the bottom of the page. `generateTableOfContents` produces clickable bookmark links — the same `id`-injection technique can be reused for manual footnote anchors.

**OAuth refresh flow.** The SharePoint worker takes two paths to refreshing its access token; both end at `oauth.refresh()` on the host-side `oauth` worker (see [ADR-060](../adr/ADR-060-host-side-oauth-refresh-worker.md)).

- _Proactive_ — before every Graph API call the worker reads the JWT `exp` claim from the cached access token. If it expires within 120 s, it calls `oauth.refresh()` first to avoid a 401 round-trip and the race window where the oauth watchdog has just respawned the worker (rotating `WORKER_OAUTH_URL`). If the proactive refresh fails (`worker_unreachable` / `timeout`), the worker logs a warning and falls through to the Graph call with the still-valid existing token — `OAuthScopeMismatchError` is the exception and is re-thrown immediately because no retry can fix it.
- _Reactive_ — a 401 from Graph triggers the same `oauth.refresh()`, serialized by the helper's single-flight lock so concurrent 401s refresh once, then retries the original request. Both paths run through the shared `authedRequest` helper in `mcp-shared`, so the refresh-retry logic is identical across every OAuth integration.

In both paths the oauth worker reads `refreshToken` from `oauth.json`, calls Microsoft's `/oauth2/v2.0/token` endpoint, writes the new `access_token` to `/tokens/access_token`, and the SharePoint worker re-reads it. The SharePoint container never sees the refresh token. If Microsoft returns `scope_mismatch` (e.g. after a scope bump or admin policy change), the failure surfaces as an `OAUTH_SCOPE_MISMATCH` error that the Desktop UI uses to trigger re-consent. If the host oauth worker is unreachable (e.g. mid-respawn), the caller gets `OAuthRefreshError(worker_unreachable)` with a "Restart the project from Speedwave Desktop" recovery hint.

**Authentication errors.** Speedwave refreshes expired access tokens reactively — when a tool call fails with an auth error, the worker refreshes the token and retries once, so transient expiry is invisible. If a tool still fails with an authentication error after that, the refresh token itself is exhausted or revoked; reconnect the integration from its card in **Settings** to sign in again.

### Office — Documents

The Office integration is a built-in MCP worker for **Word, Excel, PowerPoint, and PDF** files. It is a pure file processor: it has **no credentials** (no `/tokens` mount), **no network egress** (attached only to an `internal: true` compose network — see [ADR-055](../adr/ADR-055-built-in-office-document-worker.md)), and its only window onto the host is the project workspace mounted read-write. Generated files are written under `/workspace/.speedwave/office/`.

It is a thin TypeScript worker on `@speedwave/mcp-shared` plus Python support-scripts invoked via `spawn`, gluing mature tools: `markitdown` and SheetJS for extraction, `pandoc` for Markdown↔document conversion, `weasyprint` for HTML/Markdown→PDF, LibreOffice headless for Office→PDF and Office↔Office conversion, `python-docx`/`openpyxl`/`python-pptx` for creating and editing Office files (including native Excel/PowerPoint charts), `pypdf` for PDF manipulation, and `matplotlib` for standalone chart images. Per [ADR-053](../adr/ADR-053-worker-implementation-own-vs-wrap-official-mcp.md) this is an own thin worker rather than wrapping an upstream MCP server: `microsoft/markitdown-mcp` covers read only (not create/edit/PDF/charts), and the other community servers are single-maintainer or Windows-only COM-based.

#### When to use Office vs reading files directly

- To turn an existing `.docx`/`.xlsx`/`.pptx`/`.pdf` into Markdown (to read or summarize), use `readDocument` — it picks the best engine per format (SheetJS for `.xlsx`/`.xls`/`.xlsb`/`.ods`, `markitdown` for `.docx`/`.pptx`/`.pdf`, with `pdftotext`/`pandoc`/`python-docx` fallbacks). For just the raw text layer of a PDF, use `readPdfText`.
- To produce a PDF: from Markdown use `markdownToPdf`; from HTML use `htmlToPdf` (only local resources under `/workspace` are loaded — no remote `http(s)`); from an existing Office file use `officeToPdf` (a true LibreOffice render).
- To produce an editable Office file: from Markdown use `markdownToDocx` / `markdownToPptx`; from a structured spec (headings/tables/cells/slides/native charts) use `createDocx` / `createXlsx` / `createPptx`; to modify an existing one use `editDocx` / `editXlsx` / `editPptx`.
- To make a chart image to embed in a PDF/doc/deck, use `renderChart` (PNG or SVG); for a native, editable chart inside an Excel/PowerPoint file, use the `charts`/`chart` keys of `createXlsx` / `createPptx`.
- For PDF surgery: `mergePdf`, `splitPdf`, `rotatePdf`, `watermarkPdf`, `fillPdfForm`, `pdfMetadata`.

The full `spec`/`ops` DSL and the `convertOffice` conversion matrix are normative in [ADR-055](../adr/ADR-055-built-in-office-document-worker.md). Inputs are paths under `/workspace` by preference; inline `markdown`/`html`/`spec` is accepted only up to ~200 KB.

#### Limitations

- `convertOffice` supports a curated matrix only — `.docx→{pdf,odt,txt,html,rtf}`, `.odt→{pdf,docx}`, `.pptx→{pdf,odp}`, `.odp→{pdf,pptx}`, `.xlsx→{pdf,ods,csv}`, `.ods→{pdf,xlsx,csv}`. Anything outside it (e.g. `xlsx→docx`) is rejected, because such conversions are lossy and not useful.
- No OCR / scanned-PDF text extraction in v1 (the `docling` ML pipeline is deliberately excluded to keep the image size down).
- No "editable `.docx` from a PDF" at full fidelity — `readDocument` gives you the PDF as Markdown, which covers the realistic case.
- `python-docx` has no native chart objects, so a chart inside a `.docx` is an image (`renderChart` + an `image` element). Native charts are available in `.xlsx` and `.pptx`.
- HTML→PDF and Markdown→PDF load no remote resources (no egress) — reference images as local files under `/workspace`.
- LibreOffice conversions are serialized by an in-worker mutex (`soffice --headless` is not reentrant), so parallel `officeToPdf` calls queue.

#### Tool surface

21 tools. Read: `readDocument`, `readPdfText`, `pdfMetadata`. Markdown/HTML→document: `markdownToDocx`, `markdownToPptx`, `markdownToPdf`, `htmlToPdf`. Charts: `renderChart`. Create/edit Office: `createDocx`, `editDocx`, `createXlsx`, `editXlsx`, `createPptx`, `editPptx`. Office→PDF / Office↔Office: `officeToPdf`, `convertOffice`. PDF manipulation: `mergePdf`, `splitPdf`, `rotatePdf`, `watermarkPdf`, `fillPdfForm`.

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

- **No credentials.** It accesses public URLs and may navigate to services running on the host loopback (e.g. local dev servers like `http://host.docker.internal:4200` for an Angular project — see [ADR-062](../adr/ADR-062-playwright-host-gateway-access.md)). There is no `/tokens` mount and no credential file. Enabling the integration requires no configuration.
- **No `/workspace` mount.** Screenshots, PDFs, and page dumps are returned to Claude as base64 payloads rather than written to the project. This keeps a compromised Chromium from exfiltrating repo contents.
- **Higher resource limits.** Chromium needs a large shared-memory segment (IPC) and tmpfs (heavy caching) plus more CPU/memory than an HTTP-only worker — noticeably larger than the 128 MiB budget given to those. The exact numbers are SSOT'd on the `playwright` descriptor in `crates/speedwave-runtime/src/consts.rs` (`McpServiceDescriptor.resources`), not here; see ADR-068. These values are read by the renderer, so this paragraph intentionally avoids restating them to prevent drift.

Container hardening is otherwise identical to every other MCP worker: `cap_drop: ALL`, `no-new-privileges:true`, `read_only: true` root filesystem, `noexec,nosuid` on `/tmp`. Chromium runs with `--no-sandbox` because the Lima/WSL2 VM + container capability-drop layer replaces its in-process sandbox (see [ADR-004](../adr/ADR-004-wsl2-and-nerdctl-on-windows.md)). Each container restart wipes `/tmp` (tmpfs-backed), giving the same ephemeral-profile guarantee as `--isolated` — no cookies, no storage state persist between invocations.

#### Tool surface

`@playwright/mcp` exposes roughly 70 tools grouped into:

- **Navigation** — `browser_navigate`, `browser_navigate_back`, `browser_tabs`.
- **Extraction** — `browser_snapshot` (accessibility tree, token-efficient), `browser_take_screenshot`, `browser_pdf_save`, `browser_evaluate`, `browser_network_requests`, `browser_console_messages`.
- **Interaction** — `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_press_key`, `browser_hover`, `browser_drag`.
- **Assertions and codegen** — `browser_verify_element_visible`, `browser_verify_text_visible`, `browser_generate_locator`, `browser_pick_locator`.
- **Tracing** — `browser_start_tracing`, `browser_start_video`, `browser_stop_tracing` (gated behind `--caps devtools` when explicitly enabled).

Refer to the [upstream README](https://github.com/microsoft/playwright-mcp) for the full list and parameter schemas.

### Context7 — Library Documentation

[Context7](https://context7.com) (project of Upstash) hosts an index of ~50k libraries with current code snippets and exposes a REST API. The Speedwave worker calls `https://context7.com/api/v2/*` directly — no MCP-in-MCP layer.

#### Anonymous mode vs API key

The integration works **without an API key** (anonymous tier, per-IP rate limit). For higher limits, paste a free key from [context7.com/dashboard](https://context7.com/dashboard) into the API Key field in Settings → Integrations → Context7. The badge "Anonymous" disappears once a key is set.

Removing the key returns to anonymous mode — the toggle stays enabled (unlike other integrations, which auto-disable when credentials are deleted).

#### Tool surface

| Tool               | Parameters                      | Description                                                                                                                         |
| ------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `resolveLibraryId` | `libraryName`, `query`          | Resolve a name (e.g. "react") to a Context7 ID (e.g. `/facebook/react`). Returns top 10 matches with `trustScore` and version list. |
| `queryDocs`        | `libraryId`, `query`, `tokens?` | Fetch documentation snippets for a known ID. `tokens` defaults to 5000, clamped to `[500, 15000]` to bound context-window usage.    |

The Hub exposes both tools through `execute_code`: `await context7.resolveLibraryId({libraryName: "react", query: "useState"})` and `await context7.queryDocs({libraryId: "/facebook/react", query: "useState"})`.

#### Example prompts

- _"Implement Next.js middleware that checks JWT in cookies. use context7"_
- _"How do I configure Spring Boot JWT filter authentication? use context7"_

#### Skill

Speedwave ships `containers/claude-resources/skills/integrations/context7/SKILL.md` that teaches Claude to prefer Context7 over training data for library, framework, API, CLI, and cloud-service questions. The skill runs the standard `resolveLibraryId` → `queryDocs` workflow. It is linked into `~/.claude/skills/context7` only when Context7 is enabled in project settings — see [Per-integration Claude resources](#per-integration-claude-resources) for the gating mechanism.

#### Network and security

The Context7 worker makes outbound HTTPS to `context7.com/api/v2/*` only. See [security.md](../architecture/security.md#third-party-services) for the data-flow disclosure (queries, library names, optional API key, client headers, IP).

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

The SharePoint worker's path validator blocks access to sensitive paths within the workspace: `.git/`, `.env`, and `.speedwave/`. These entries are enforced by a denylist in the SharePoint worker's `mcp-servers/sharepoint/src/path-validator.ts`, ensuring that worker cannot read or write protected files even though the full project directory is mounted. This denylist is SharePoint-worker-specific — it is not a shared validator automatically applied to other built-in workers or plugins.

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

### Plugin instructions (Dashboard)

A plugin may ship an optional `instructions` field in `plugin.json` — long-form
**Markdown** with setup or usage guidance (how to obtain a token, post-install
steps such as importing a companion desktop app, troubleshooting). When present,
it appears on the plugin's **Dashboard** tab as a collapsible **"Setup & usage"**
disclosure, **collapsed by default** so it stays out of the way until the user
expands it. It is distinct from `description` (the one-line tagline in the plugin
list). The Markdown is rendered with `marked` and sanitised by Angular before
display; the field is capped at 16 KiB and the content comes from the signed
manifest.

### Configuring plugin credentials

Plugins that declare `auth_fields` in `plugin.json` (e.g. a REST API token)
are configured from the plugin detail page in Speedwave Desktop: open the
plugin, switch to the **Settings** tab, and fill in the **Credentials**
section. Saving writes each field to
`~/.speedwave/tokens/<project>/<service_id>/<key>` with `chmod 600`; the
plugin's container mounts that directory read-only at `/tokens`.

Behaviour to know:

- **Write-only.** Stored values are never displayed back — the form always
  renders empty inputs. This is intentional: the tokens are secrets and no
  Tauri command exposes their contents.
- **Blank preserves.** Leaving a field empty on save keeps whatever value is
  already stored. Only fields you actually type into are overwritten. This
  lets you update one credential without re-entering the others.
- **Reset all** deletes every stored credential for the plugin (the whole
  per-plugin tokens directory). It is gated behind an inline confirm prompt
  and cannot be undone — you will need to re-enter the credentials before
  the plugin runs again.
- **Per-field limit.** Each value is capped at 4096 bytes (the form enforces
  this via `maxlength`; the backend rejects anything longer). Mirrors
  `MAX_CREDENTIAL_BYTES` in `desktop/src-tauri/src/types.rs`.
- **Verified plugins only.** The credentials form is shown only when the
  plugin's Ed25519 signature verifies (`verification_status === 'verified'`).
  A plugin in any other state surfaces its verification error instead — fix
  that first (see "Plugin verification & recovery" above).
- **Optional vs required.** Fields marked `required: false` in the manifest
  do not block the plugin from running; the plugin auto-enables on install
  and you add the credential later when a tool needs it. Tools that require
  the missing credential return a clear error (e.g. `AUTH_PAT_MISSING`)
  pointing back to this Settings tab.
- **"✓ set" indicator + clear.** Each field that already has a value stored
  shows a green **✓ set** badge next to its label and a **clear** link. The
  badge is driven by a metadata-only check (the file's existence and non-zero
  length) — secret contents are never read, so even write-only secrets show
  their configured state. **clear** removes just that one field's stored value
  (idempotent; it does not disable the plugin), unlike **Reset all**.
- **Field help text.** When a manifest field declares a `description`, it is
  rendered under the field label — use it for where to generate the token, the
  required scopes, and so on.
- **Format validation.** A field may declare a
  `validation: { "pattern": "<regex>", "message": "<hint>" }` constraint. The
  value you type must fully match the (anchored) pattern; on mismatch the form
  shows `message` and blocks the save. The same check runs again host-side in
  `save_plugin_credentials`, so a crafted call cannot bypass it. Patterns are
  capped in length and must compile under Rust's `regex` crate (the RE2 subset
  — no backreferences or lookaround), which is validated when the plugin is
  installed.

After saving or resetting, Speedwave requests a container restart so the
worker picks up the change.

### Plugin OAuth (Authorize)

A plugin can declare an `oauth` block in `plugin.json` to authenticate against a
third-party service through an OAuth2 flow instead of a pasted token. The flow
runs on the host; only a short-lived access token reaches the plugin container,
while the refresh token and client secret stay off-mount under
`~/.speedwave/oauth/<project>/<slug>.json` (see
[ADR-069](../adr/ADR-069-generic-plugin-oauth2.md)).

How it works in the UI:

1. Enter the plugin's OAuth **client id** (and **client secret** if the manifest
   declares one) in the Credentials section and click **Save**. These are not
   written to `/tokens` — they go to the off-mount seed file. The **Authorize**
   button stays disabled until they are saved.
2. Click **Sign in with `<plugin>`**. For the `authorization_code` grant a
   browser tab opens; complete sign-in there. If the identity provider requires
   a registered redirect URI, the UI shows the loopback URI to register.
3. On success the plugin is **auto-enabled** (a freshly-authorized OAuth plugin
   is ready to run) and Speedwave shows the restart banner; click it so the
   worker container starts and picks up the access token.

**Self-hosted services.** When the OAuth endpoints depend on the instance (e.g. a
self-hosted GLPI), the manifest declares `base_url_field` (naming the base-URL
credential field) plus `authorize_suffix`/`token_suffix` instead of static
`authorize_url`/`token_url`. The host resolves and SSRF-validates the endpoints
from the base URL you enter at sign-in time.

**Identity (who the service logs).** `authorization_code` and `device_code` are
user-delegated: you sign in with your own account and the service attributes
actions to **you**. `client_credentials` is a machine identity — actions land on
the OAuth client's technical account, not a specific person. Choose the grant
that matches your audit requirements.

### Bridge plugins — dev UX

Plugins that pair a containerized worker with an external host application (e.g. a design-tool desktop app, an editor extension) declare a `host_bridge` block in `plugin.json` — see [ADR-063](../adr/ADR-063-host-bridge-generic.md). Speedwave Desktop spawns a loopback WebSocket relay per such plugin and injects the bridge URL + auth token into the worker's container.

Two optional manifest fields make the user-facing flow smoother:

- `preferred_port: <u16>` — bind the relay on a stable port. If the port is busy at startup, the bridge fails hard (no random fallback) so the external app's saved URL never silently breaks. Must be > 1023.
- `persistent_token: true` — generate the auth token once and persist it at `~/.speedwave/plugin-state/<slug>/bridge-token` (chmod 0600). Subsequent Speedwave restarts reuse the same token; without this, the token rotates on every restart and external apps must re-paste it.

Example manifest fragment:

```json
"host_bridge": {
  "url_env": "MY_BRIDGE_URL",
  "token_env": "MY_BRIDGE_TOKEN",
  "display_name": "My Bridge",
  "roles": { "worker": { "scheme": "header", "name": "x-my-auth" } },
  "preferred_port": 60123,
  "persistent_token": true
}
```

**User flow** (any bridge plugin): the plugin detail page in Speedwave Desktop shows a _Bridge connection_ card with the connect URL, the auth token (masked, with Reveal/Copy), and a live status dot. Users copy these into their external app once; with `persistent_token: true`, restarts of Speedwave do not invalidate the credentials.

**CLI sessions** reach the same bridge, with one prerequisite: the relay listener lives in the Speedwave Desktop process (no background daemon, [ADR-008](../adr/ADR-008-no-background-daemon.md)), so Desktop must be running. When it is, a `speedwave` terminal launch — and likewise `speedwave update` and project-add — reconstructs the worker's bridge env from disk: the port from `preferred_port` in the manifest, the token from `plugin-state/<slug>/bridge-token`. Both interfaces then render identical bridge env, so a CLI render never recreates the shared worker without it. A plugin missing either opt-in (`preferred_port` + `persistent_token`) is not reconstructable off-process; its CLI workers degrade to `BRIDGE_NOT_CONFIGURED`. See [ADR-074](../adr/ADR-074-cli-host-bridge-reconstruction.md).

**Recovery from a port collision**: free the port (`lsof -nP -iTCP:<port> -sTCP:LISTEN`), or change `preferred_port` in the manifest, or remove the field to let the kernel pick a random one. Reload the plugin (toggle off/on) to retry.

**Threat model for persistent tokens**: persisting the UUID to a 0600 file extends the secret's lifetime from one Speedwave session to "until the plugin is uninstalled". `plugin::remove_plugin` deletes `plugin-state/<slug>/` entirely, including the token file. An attacker with read/write access to `~/.speedwave/` already has read/write access to the user's home directory and can compromise the bridge regardless of token rotation — persistence does not meaningfully widen the practical attack surface.

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

## Per-integration Claude resources

Some built-in integrations ship a companion Claude resource — a skill, command, agent, or hook that tells Claude when and how to call the integration's MCP tools (e.g. `office`'s decision-map skill, `playwright`'s automation skill). These resources are only useful when the underlying worker is running, so they are gated on the same per-project toggle as the worker itself.

### Layout

```
containers/claude-resources/
├── skills/
│   ├── code-review-basic/        # core skill — always linked
│   ├── code-review-…/            # 13 other code-review-* skills
│   ├── speedwave-code-review/    # core orchestrator
│   └── integrations/             # integration-bound bucket
│       ├── office/               # MCP — linked when `office` ∈ ENABLED_SERVICES
│       ├── playwright/           # MCP — linked when `playwright` ∈ ENABLED_SERVICES
│       ├── context7/             # MCP — linked when `context7` ∈ ENABLED_SERVICES
│       ├── slack/sharepoint/redmine/gitlab/github/atlassian/  # MCP — same pattern
│       └── reminders/calendar/mail/notes/                     # OS sub-services (see Runtime behavior)
├── commands/
│   └── integrations/<config_key>/    # same convention for commands
├── agents/
│   └── integrations/<config_key>/
└── hooks/
    └── integrations/<config_key>/
```

The directory name under `integrations/` **must match `config_key`** from `crates/speedwave-runtime/src/consts.rs::TOGGLEABLE_MCP_SERVICES` — that is the value Speedwave passes in `ENABLED_SERVICES`. Anything top-level inside `skills/`, `commands/`, `agents/`, or `hooks/` is treated as a core resource and linked unconditionally.

### Runtime behavior

`containers/entrypoint.sh` builds `~/.claude/<type>/` as a real directory of per-entry symlinks on every container start:

1. Core entries (everything outside `integrations/`) are linked unconditionally.
2. Integration entries under `integrations/<svc>/` are linked only when `<svc>` appears in `ENABLED_SERVICES`. The variable is injected into both the `claude` and `mcp-hub` containers by `apply_integrations_filter` in `crates/speedwave-runtime/src/compose.rs` and reflects the integrations toggle from Settings.
3. OS sub-service entries (`integrations/reminders/`, `calendar/`, `mail/`, `notes/`) are gated jointly: `os` must appear in `ENABLED_SERVICES` AND the sub-service must NOT appear in `DISABLED_OS_SERVICES`. The list of available sub-services is injected as `OS_AVAILABLE_SUBS` from `TOGGLEABLE_OS_SERVICES`, so adding a new sub-service requires no entrypoint change.
4. Plugin entries (from `/speedwave/plugins/<slug>/<type>/`) are linked into the same directory, alongside core and integration entries.

The entrypoint records every link it creates in `~/.claude/.speedwave-managed-links`. On the next start it removes those links before building the new set, so toggling an integration off in Settings reliably removes its skill from `~/.claude/skills/`. Files placed in `~/.claude/` by the user are never touched.

### Adding a per-integration resource

1. Place the resource (e.g. `SKILL.md`) under `containers/claude-resources/<type>/integrations/<config_key>/`. `<config_key>` must already exist in `TOGGLEABLE_MCP_SERVICES`.
2. No Rust or Compose changes are needed — `ENABLED_SERVICES` is already wired up.
3. Add a BATS test in `_tests/entrypoint/entrypoint.bats` exercising the on/off transition for the new directory.

## Local LLM Setup

You can run Claude Code inside Speedwave against a local or third-party LLM server instead of Anthropic's cloud API. Go to **Settings → LLM Provider** to configure providers.

Since [ADR-073](../adr/ADR-073-embedded-per-project-litellm-proxy.md) every session routes through an **embedded, per-project Rust forwarder** (container `proxy`, reachable only on the project's compose network — no host port, no admin UI). You do not run or install anything yourself; Speedwave builds and starts it. It routes by model prefix to your configured backend and relays the Anthropic stream unchanged — every supported backend already speaks the native Anthropic Messages API, so there is no translation step.

Settings holds a **provider list** rather than a single choice — configure several and pick the active one. Each entry is one of these kinds:

| Kind                    | What it is                                                                                                                | Key needed                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **Anthropic (OAuth)**   | Your Claude subscription (the default)                                                                                    | No (managed by Claude Code login) |
| **Anthropic (API key)** | Anthropic via a raw API key                                                                                               | Yes                               |
| **Local**               | A local **or remote** custom-URL server serving the Anthropic Messages API (Ollama, LM Studio, llama.cpp, vLLM, gateways) | Only if the server requires one   |
| **OpenRouter**          | OpenRouter's model catalog                                                                                                | Yes                               |

Per-provider API keys are stored at `~/.speedwave/tokens/<project>/llm/<provider_id>_api_key` (chmod 0600) — the on-disk config holds only a presence flag, never the secret. Switching the active provider or its model restarts the session; adding a provider or changing a key hot-reloads only the proxy.

**Cost per provider.** The LLM usage dashboard (and the chat footer / CLI statusline) show cost from the proxy usage SSOT, computed per provider: **API key** → real cost from the model price catalog; **OpenRouter** → real cost from its `/generation` endpoint; **local** → `$0`; **subscription (OAuth)** → "—" (flat-rate, per-request cost is not meaningful). An unpriced request shows "—", never `$0`.

#### Supported local / self-hosted servers

The forwarder speaks **native Anthropic Messages** (`POST /v1/messages`, streaming) and does **not** translate — the server must expose that endpoint. Supported servers and minimum versions:

| Server         | Minimum version           | Notes                                                                          |
| -------------- | ------------------------- | ------------------------------------------------------------------------------ |
| **llama.cpp**  | Jan 2026 build (#17570)   | `llama-server` native Anthropic Messages support (incl. `count_tokens`, tools) |
| **Ollama**     | 0.14.0                    | Bind `OLLAMA_HOST=0.0.0.0` so the container can reach it (not loopback)        |
| **LM Studio**  | 0.4.1                     | Enable the Local Server; Anthropic-compatible `/v1/messages`                   |
| **vLLM**       | build with `/v1/messages` | Use the **Local** row with the remote URL for a remote vLLM                    |
| **OpenRouter** | —                         | Remote; exposes the Anthropic Messages API natively                            |

A stock OpenAI-only server (TGI, an old vLLM, a plain Chat-Completions gateway) is **not** supported — point Speedwave at a backend with the Anthropic endpoint, or run your own Anthropic-Messages shim in front of it.

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

If your LLM server is at a non-standard address (e.g. another machine on your LAN at `http://192.168.1.100:11434`), select the **Local** provider and override the **Base URL** field. The URL must use `http://` or `https://` and may include a single-segment path prefix such as `/v1` (AWS-style gateways). Multi-segment paths and query strings are rejected.

### Servers requiring authentication

When the local server requires a Bearer token (vLLM `--api-key`, LM Studio with "Require Authentication" enabled, llama.cpp `--api-key`, LiteLLM `LITELLM_MASTER_KEY` for a user-operated LiteLLM gateway — not Speedwave's own stack, corporate gateways):

1. In Settings → LLM Provider, enter the token in the **api_key** field. The value is stored in `~/.speedwave/tokens/<project>/local-llm/api_key` (chmod 0600) — the on-disk config never contains the secret.
2. Click **Discover models** to verify connectivity (the probe sends an `Authorization: Bearer <token>` header and a 1-token `/v1/messages` sanity request).

A leading `Bearer ` typed by mistake is stripped automatically (Claude Code already adds the prefix). Clearing the field and saving deletes the stored token; saving without touching the field leaves the stored token untouched.

### Custom headers (Azure APIM, corporate gateways)

For gateways that require a non-`Authorization` header (e.g. `Ocp-Apim-Subscription-Key`, tenant routing), use the **custom_headers** textarea. Format: one `Name: Value` per line. The parser rejects `Authorization` (use the api_key field instead), `Cookie`, `Host`, `Content-Length`, `Transfer-Encoding`, and any CRLF in values (HTTP request-smuggling defense).

### OpenRouter

1. In Settings → LLM Provider, open the **OpenRouter** row and enter your OpenRouter API key.
2. Click **Discover models** to pull OpenRouter's catalog (the dropdown lists tool-capable models); pick one.
3. Set the row active. No base URL is needed — OpenRouter is a fixed endpoint.

### Remote / custom-URL servers (vLLM, gateways)

The forwarder speaks **native Anthropic Messages** to the backend — it does **not** translate to OpenAI Chat Completions. The server must therefore expose `POST /v1/messages` (streaming). Modern builds of vLLM (`/v1/messages` endpoint), llama.cpp, LM Studio, and Ollama all do; a stock OpenAI-only server (TGI, an old vLLM, a plain Chat-Completions gateway) is **not** supported — point Speedwave at a backend with the Anthropic endpoint, or run your own Anthropic-Messages shim in front of it.

1. In Settings → LLM Provider, open the **Local** row (it serves both local and remote custom-URL backends that speak the Anthropic Messages API).
2. Enter the server's **Base URL** (e.g. `http://host.docker.internal:8000` or a LAN address). A trailing `/v1` is fine — it's normalized away, and the forwarder appends `/v1/messages` itself.
3. Enter an **api_key** if the server requires one, then **Discover models** and pick one.
4. Set the row active.

> A **local** provider that needs custom headers (see below) is the one case that bypasses the forwarder and talks to the server directly — there too the server must speak Anthropic Messages on `POST /v1/messages`.

## See Also

- [ADR-010: mcp-os as Host Process Per Platform](../adr/ADR-010-mcp-os-as-host-process-per-platform.md)
- [ADR-013: mcp-os as Host Process — Implementation Details](../adr/ADR-013-mcp-os-as-host-process-implementation.md)
- [ADR-015: Plugin System](../adr/ADR-015-plugin-system.md)
- [ADR-036: Self-Declaring Worker Policy](../adr/ADR-036-self-declaring-worker-policy.md)
- [ADR-040: Remove LiteLLM — Direct Local Provider Injection](../adr/ADR-040-remove-litellm-direct-provider-injection.md)
- [ADR-041: Local LLM Model Discovery and SSRF Policy](../adr/ADR-041-local-llm-model-discovery.md)
