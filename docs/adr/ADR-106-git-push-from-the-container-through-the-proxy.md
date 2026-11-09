# ADR-106: Git push from the container through the proxy

> **Status:** Accepted
> **Date:** 2026-11-03
> **Context:** SPEED-532. Work in Speedwave had two sources of repository history: local git in the `claude` container and server-side commits made by the GitHub worker's `createOrUpdateFile` (Contents API). This ADR records that the integration stops creating commits and that the container gets a real git transport through the per-project proxy, with the integration token held by the proxy.

## Context

- `createOrUpdateFile` created one commit per file on the server, with the author from the token, its own timestamp and a message from the parameter, so its SHA never matched a local commit and two diverging histories of the same change appeared. When `sha` was omitted the worker fetched the current blob SHA itself and overwrote whatever was on the branch.
- The `claude` container could not push: `containers/Containerfile.claude` installs no ssh client, there is no credential helper, and `origin` is usually an ssh URL.
- The container is token-free (`.claude/rules/security.md`), and the earlier position (SPEED-320) was "no git push bridge". The 2026-10-27 SDLC meeting reversed that direction: push from the container yes, but never with the developer's personal ssh key.
- Before this change the proxy served only `/v1/messages` and `/v1/messages/count_tokens`, routed by the `model` field of the JSON body and read bodies up to 32 MiB (`containers/proxy/src/main.rs::MAX_REQUEST_BODY_BYTES`). It mounted only `tokens/<project>/llm`.

## Decision

1. **One source of history.** The GitHub worker has no tool that creates a commit; `createOrUpdateFile` is removed (`mcp-servers/github/src/tools/repository-tools.ts`). The GitLab worker never had one. Commits exist only in local git and reach the forge by `git push`, so the SHA on the forge equals the local SHA.
2. **Transport through the proxy.** The proxy gets a route `/git/<host>/<path>` (`containers/proxy/src/git.rs`). It accepts only the four git smart HTTP requests[^1]: `GET <repo>/info/refs?service=git-upload-pack`, `GET <repo>/info/refs?service=git-receive-pack`, `POST <repo>/git-upload-pack` and `POST <repo>/git-receive-pack`. Any other path or method under `/git/`, and any host that is not an enabled forge, gets 403 without a request upstream. Without the allowlist the route would be an authenticated proxy to the forge's REST API (on GitLab the API lives on the same host).
3. **The token stays in the proxy.** The proxy adds `Authorization: Basic` with the integration token: login `x-access-token` for GitHub[^2], `oauth2` for GitLab[^3]. It reads the token from its read-only mount on every request, so a refreshed token works without a restart. `${TOKENS_DIR}/github` and `${TOKENS_DIR}/gitlab` are mounted into the proxy at `/git-tokens/<service>:ro` only when the integration is enabled in the project, and `compose::SecurityCheck` accepts exactly these two extra proxy mounts.
4. **Caller authentication.** The route requires the per-project `x-speedwave-proxy-auth` secret like `/v1/*`; a proxy config without one rejects every git request.
5. **Streaming, no inspection.** Request and response bodies are streamed in both directions with no size limit, no JSON parsing and no PII rewrite. The proxy does not read the pushed pack and holds no ref policy: branch protection, deletion and force push belong to the forge's repository settings.
6. **Audit.** Every git request is one row in the proxy audit file (`audit-proxy.jsonl`, `layer: "git"`): method, host, repository, service, status. No token, no body.
7. **Git configuration in the container.** The renderer passes `SPEEDWAVE_GIT_HOSTS`, `SPEEDWAVE_GIT_PROXY_URL` and `SPEEDWAVE_GIT_PROXY_AUTH` to the `claude` container when at least one forge is enabled. The entrypoint writes `~/.config/speedwave/git-transport.gitconfig` with `url.<proxy>/git/<host>/.insteadOf` for the ssh form (`git@<host>:`) and the https form (`https://<host>/`) of each host, plus `http.<proxy>/git/.extraHeader` with the caller secret[^4], and includes it once from `~/.gitconfig`. Repository `.git/config` is untouched, so the host keeps pushing over ssh with the same `origin`. With no forge enabled the file is removed; git ignores an include of a missing file.
8. **No `workflow` scope.** `GITHUB_OAUTH_SCOPES` (`crates/speedwave-runtime/src/consts.rs`) stays `repo read:user`. Without `workflow` GitHub refuses a push that adds or changes a workflow file[^5], so a prompt-injected agent cannot push a workflow that runs with the repository's secrets on a `push` trigger. Such a change is pushed from the host.
9. **No feature flag.** The route works whenever the integration is enabled. A read-only mode of the integration disables `git-receive-pack` in the proxy (section "Integration mode and git push" of [ADR-108](ADR-108-access-policy-in-the-hub-and-read-only-mode.md), SPEED-67); fetch is unchanged.

## Consequences

- The proxy becomes the second consumer of the `github` and `gitlab` tokens. This changes the rule of [ADR-009](ADR-009-per-project-isolation-preserved.md) that a token directory is mounted only into its own worker: a compromised proxy exposes the LLM keys and the forge tokens of its project. The proxy already holds the LLM provider keys and the PII key and accepts requests only with the caller secret, which is the reason it was chosen over the worker.
- The `claude` container still holds no service token. It holds the caller secret, which it already received for `/v1/*` in `ANTHROPIC_CUSTOM_HEADERS` on the proxy path.
- The GitHub OAuth `repo` scope reaches every repository the user can access[^6], so the agent can push to any of them, not only the project's repository. This is the accepted cost of using one token, the integration's. Superseded for the git transport by the amendment of 2026-11-04 below.
- A path-prefixed GitLab instance (`https://host/gitlab`) is reached at its host root; GitLab with a private CA and hosts without TLS are not supported. Git LFS is not supported.
- The SPEED-320 assumption "token-free container, no git push bridge" is revoked.

## Alternatives rejected

- **`createCommitOnBranch` (multi-file server-side commit).** Fixes atomicity and concurrency but keeps two sources of history and the SHA mismatch.
- **`git push` in the GitHub worker.** The worker would run git with the token on a `.git` directory the agent controls (`core.fsmonitor`, `core.sshCommand`, hooks), which turns the repository config into code execution next to the token.
- **ssh key or personal access token in the `claude` container.** Puts a credential where prompt injection runs; rejected at the 2026-10-27 SDLC meeting for the personal ssh key.
- **Ref policy in the proxy.** Duplicates what the forge's branch protection already enforces and would require parsing the pushed pack.

## Amendment (2026-11-04): per-project repository allowlist (SPEED-956)

The third consequence above accepted that the git transport reaches every repository the token reaches. The security review of SPEED-532 on 2026-11-04 rejected that: a prompt injection in one project could push to another client's repository, fetch any private repository of the user and carry it out, or push the content of `/workspace` to a public repository. The proxy knew the hosts of a project, not its repositories.

1. **The proxy forwards only listed repositories.** Every `git_forges` entry of `proxy.json` carries `repositories` (`containers/proxy/src/router.rs::GitForge::allows`). A request passes when its repository path equals an entry, or when an entry ends in `/*` and the path continues below that prefix, segment by segment (`group/*` admits `group/repo` and `group/team/repo`, not `group-other/repo`); letter case and a `.git` suffix are ignored. Any other request on an enabled forge gets 403 without a request upstream, the audit row of decision 6 and a `text/plain` body that names the repository, which git prints as `remote:` lines when ref discovery fails[^7]. An empty or missing list refuses every request. This holds for `git-upload-pack` and `git-receive-pack` alike.
2. **The list is per project and per integration, approved by a person.** It lives in the user config, `projects[].integrations.github.repositories` and `projects[].integrations.gitlab.repositories` (`crates/speedwave-runtime/src/config.rs::GitForgeIntegrationConfig`); a repository's `.speedwave.json` has no effect on it, and the `claude` container has no mount of the user config. A person edits it in Desktop, in the GitHub and GitLab panels of the Integrations view (`desktop/src-tauri/src/git_repositories_cmd.rs`). An entry is `owner/repo`, a GitLab path with subgroups, `owner/*`, or a clone URL of the integration's host; `crates/speedwave-runtime/src/git_allowlist.rs::normalise_entry` refuses a bare `*`, a whole host, a `*` anywhere but as the last segment and a URL of another host. The renderer validates every stored entry again and drops one that no longer validates.
3. **The project directory only suggests entries.** Desktop lists the `url` and `pushurl` remotes of the git repositories in the project directory that point at the integration's host, each with its directory and its own Add button; nothing enters the list without that click. The agent can write `/workspace`, so a remote that an injected prompt adds to `.git/config` would otherwise join the list at the next render.
4. **A save applies at once.** It re-renders `proxy.json` and recreates only the proxy container (`containers_cmd.rs::restart_llm_proxy`); the chat session keeps running.
5. **`insteadOf` stays per host** (`containers/git-transport.sh`). With the integration enabled, every request to that host goes through the proxy, so a public repository on it needs an entry too.

Consequences:

- The token still reaches every repository the user can access; the git transport reaches only the listed ones. The GitHub and GitLab MCP tools are not limited by the list yet (SPEED-961).
- `owner/*` also admits a repository created under that owner later, by anyone with access to it.
- An organisation-forced list that narrows the user's list belongs to the managed policy (SPEED-955).

Alternatives rejected: the remotes found in the project directory as the source of the list (decision 3); one list per account instead of per project (it leaves lateral movement between projects open); separate lists for fetch and push (the read-only mode of the integration blocks push for the whole forge, ADR-108); an absent list meaning "everything" during a migration (no release carries the git transport without the list, so there is nothing to migrate).

## References

[^1]: Git, "HTTP transfer protocols", smart clients: `GET $GIT_URL/info/refs?service=git-upload-pack`, "The request MUST contain exactly one query parameter, `service=$servicename`", and `POST $GIT_URL/git-upload-pack` / `POST $GIT_URL/git-receive-pack`: https://git-scm.com/docs/http-protocol

[^2]: GitHub Docs, "Authenticating as a GitHub App installation": HTTP-based Git access with `git clone https://x-access-token:TOKEN@github.com/...`: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation. That page documents installation tokens; that the same login works with the integration's OAuth device-flow token is to be confirmed by the live push test of SPEED-532.

[^3]: GitLab Docs, "OAuth 2.0 identity provider API": "A token with scope `read_repository` or `write_repository` can access Git over HTTPS. Use the token as the password. You can set the username to any string value. You should use `oauth2`": https://docs.gitlab.com/api/oauth2/

[^4]: Git, `git-config` manual, `url.<base>.insteadOf`, `http.<url>.extraHeader` and the `[include]` section: https://git-scm.com/docs/git-config

[^5]: GitHub Docs, "Scopes for OAuth apps", `workflow`: "Grants the ability to add and update GitHub Actions workflow files.": https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps

[^6]: GitHub Docs, "Scopes for OAuth apps", `repo`: "Grants full access to public and private repositories including read and write access to code": https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps

[^7]: Git, `remote-curl.c`, `show_http_message`: on a failed ref discovery (`discover_refs`) git prints a `text/plain` response body to stderr, each line prefixed with `remote:`: https://github.com/git/git/blob/master/remote-curl.c
