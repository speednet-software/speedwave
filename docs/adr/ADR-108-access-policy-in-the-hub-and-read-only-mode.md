# ADR-108: Access policy in the hub and the read-only mode

> **Status:** Accepted
> **Date:** 2026-11-06
> **Context:** SPEED-598 (SPEED-309, SPEED-58, SPEED-67). A user had no way to take away the agent's right to change state in external services, other than disabling an integration and losing its reads. This ADR records the access policy module in the hub, the global read-only mode that is its first rule, and the contract that carries the rules from the host to the hub. The per-integration mode is SPEED-58 and is implemented; the git push block (SPEED-67) is filled in by its ticket, and the section "Integration mode and git push" states what is decided for it.

## Context

- Every restriction on writes had its own place and shape: `ENABLED_SERVICES` in the hub, the Jira project allowlist in the Atlassian worker, the `confirm_*` flags the model sets itself, the repository allowlist in the proxy (ADR-106 amendment).
- Every tool call, including the calls inside `execute_code`, passes through one function, `buildExecutorWrappers` in `mcp-servers/hub/src/tool-registry.ts`. The hub exposes only the two meta-tools `execute_code` and `search_tools` (`mcp-servers/hub/src/meta-tools.ts`). Before this change that function made no decision. The hub knew the category of a tool from its MCP annotations (`executor.ts::deriveAuditCategory`) and used it only for the audit line. ADR-105 states that the hub has no confirmation policy.
- Calls reach a worker only through `http-bridge.ts::callWorker`. Its production callers are the bridges `buildServiceBridge` creates, and `executor.ts::createToolWrappers` is the only place that hands those bridges to the sandbox, each one wrapped by `buildExecutorWrappers`. `search_tools` calls no worker. The `create*Bridge` exports of `http-bridge.ts` have no production caller. There is no second path from a model-written call to a worker.
- The hub already loads `policy.json` through `@speedwave/policy-engine` (`mcp-servers/hub/src/policy.ts`, `POLICY_FILE`, fail-closed). The proxy and the WASM build parse the same document with `crates/pii-engine/src/policy.rs`, which rejects unknown fields (`deny_unknown_fields`).
- Organization policy is carried by `ManagedConfig` (`crates/speedwave-runtime/src/managed_config.rs`), where the presence of a key is the lock (`.claude/rules/managed-policy-config.md`).

## Decision

1. **One access policy module in the hub.** `mcp-servers/hub/src/access-policy.ts` has one decision function, `decideAccess(rules, metadata)`, that returns allow, or deny with a reason and a teaching message. It is pure over the composed rules and the tool's registry metadata. `buildExecutorWrappers` asks it for every tool of a service when it builds the wrappers of an `execute_code` run, so direct calls and calls inside `execute_code` are one path. A denied tool gets a wrapper that rejects before the bridge, so the worker is never called. The decision has two outcomes, allow and deny. A `confirm` outcome is not built; it belongs to SPEED-513.
2. **Read-only passes only what is annotated read-only.** In a read-only service a tool passes when `annotations.readOnlyHint === true`, and every other tool is denied. A tool without annotations is denied. A service whose name starts with `custom-` is denied entirely in read-only mode, whatever its annotations say.
3. **Annotation trust.** The MCP schema describes tool annotations as hints that are not guaranteed to describe the tool's behavior, and tells clients not to base tool use decisions on annotations from untrusted servers[^1]. The hub therefore trusts the annotations of the built-in workers and of plugins signed by Speednet (ADR-015, ADR-051), and trusts none from a custom MCP server. No annotation counts as blocked, so a new or badly described plugin does not pass by default. Every worker the hub enforces on has a test that lists each tool as reading or changing and asserts `readOnlyHint` accordingly (`metadata.test.ts` of slack, sharepoint, redmine, atlassian and office), so a new tool must be classified and a wrong annotation fails the build.
4. **Rules live in `policy.json`.** The hub reads the access rules from the document `POLICY_FILE` points to, through the loader that reads the PII policy; there is no second file. The optional top-level `access` section has this shape:

   ```json
   "access": { "default": "full", "services": { "slack": "read_only" } }
   ```

   `default` and the values of `services` are `full` or `read_only`; `services` keys are service ids (`^[a-z][a-z0-9-]{0,62}$`, at most 256). A service not named in `services` has the `default` mode. An absent section means every service is `full`. The section is the composed result: the hub does no precedence logic. The shape is validated in one place, `crates/pii-engine/src/access.rs`, called from `compile_policy_v3`. The PII engine accepts the section and ignores it when scanning. An invalid section (unknown mode, unknown key, bad service id) makes `compile_policy_v3` fail, so the hub refuses to start through the existing fail-closed path, and the proxy would fail the same way. The WASM binding returns the section as JSON (`PiiEngine::access_json`) and `@speedwave/policy-engine` exposes it as `PiiEngine.access`; `npm run build:wasm` in `mcp-servers/policies` rebuilds the binding.

5. **Precedence is computed in Rust.** `crates/speedwave-runtime/src/access_policy.rs::compose_access_policy` takes the MDM switch, the project's global switch and a map of per-service modes, and the most restrictive mode wins: MDM over the global mode over the service mode. Entries equal to the resulting default are left out. The map comes from the `access` field of the integration entries of the project (decision 6). `pii_policy.rs::write_policy_config_in` writes the section, and omits it while every service is `full`. The section is part of the file the digest `POLICY_DIGEST` is computed from, so a change recreates the hub.
6. **Configuration.** The global switch is `read_only` in the project's entry of the user config (absent means off, `ProjectUserEntry::read_only`). The organization forces it with `access.read_only: true` in `managed-config.json`: the key's presence locks the switch on in Desktop, a malformed key is a hard error like every other managed key, and `read_only: false` is rejected because presence is the lock and the file has no way to force the mode off. The save path refuses a change while MDM locks the mode (`access_policy::set_read_only`), so the lock is not only a greyed control. No managed mount is added, so `SecurityCheck` has no new rule.
7. **Denial is a teaching error.** The message names the mode, the service and the tool, says why the tool is blocked (it changes data, it has no read-only annotation, or custom MCP servers are blocked in this mode), says that reads from the service still work, and tells the user to turn the mode off in Speedwave Desktop (Project settings, Agent access, Read-only mode), noting that an organization policy can lock it. The text stays under the 500 characters `executeCode` keeps of an error.
8. **Audit.** A denied call writes the existing audit line with `outcome=denied reason=read-only` and keeps its READ, WRITE or DELETE category, which still comes from the annotations. The in-memory entry carries `outcome` and `reason`. A call that passed writes the line as before.
9. **`search_tools` keeps blocked tools visible.** A blocked tool stays in the results with `blocked: "read-only"`. While any enabled service is read-only, the result starts with a `notice` field of one sentence that names the read-only services, so a model does not plan steps that will fail.
10. **Applying a change.** The Desktop save re-renders `policy.json` and recreates the `mcp-hub` service alone (`containers_cmd.rs::restart_hub`, the shape of `restart_llm_proxy`); when the project is not ready to restart one service, Desktop asks for a restart of the project, as the repository allowlist does. The hub keeps its MCP sessions in memory, and a request that carries an unknown session id gets a new session (`mcp-servers/shared/src/jsonrpc.ts`, the `auto-reconnect` branch of `handleToolsList` and `handleToolsCall`), so the server side does not reject a client that outlives the restart.
11. **Default off, no beta flag.** Without the switch nothing changes: the section is absent and every service is `full`.
12. **Integration mode in the config.** Every integration entry of the project in the user config (`IntegrationConfig`, `GitForgeIntegrationConfig`, and so the OS services and the plugin entries) has an optional `access` field, `"full"` or `"read_only"`, absent meaning full and written only while read-only (`AccessMode` from the pii-engine crate, one type for all). `IntegrationsConfig::access_modes` turns the entries into the per-service map of `compose_access_policy`, keyed by the name the hub knows the service by: the config key of a built-in integration, the `service_id` of a plugin, and `os-<key>` for a macOS native service (`os-reminders`, `os-calendar`, `os-mail`, `os-notes`). The hub has one `os` service, so `access-policy.ts` resolves an `os` tool through the `os-<category>` entry of its `osCategory` and lists the enabled read-only OS sub-services in the `search_tools` notice. Only the user's own entry sets a mode: the repository's `.speedwave.json` shares the type but its `access` values are not read. Toggling an integration on or off keeps its mode (`set_service`, `set_plugin_enabled` merge `enabled` into the stored entry). A plugin without annotations loses all its tools in Read-only, as in the global mode.
13. **Desktop control.** The panel of each integration (built-in integrations, OS integration rows, installed MCP plugins) shows "Access: Full / Read-only" (`shared/integration-access`). A change calls `set_integration_access_mode`, which stores the mode, and then recreates the hub through the path of the global switch (`HubRestartService`). While the project's global mode is on, whether set by the user or by MDM, every integration shows Read-only, the control is disabled and the reason is shown ("Set by your organization" or the pointer to Settings, Agent access); the stored mode is kept and applies again when the global mode is turned off.

## Boundaries of the mode

Read-only mode limits what the hub's tools may do. It does not cover:

- the native tools of Claude Code in the container (Write, Edit, Bash, WebFetch);
- internet access from the container, which a separate offline mode limits (SPEED-967);
- a credential put into the container by hand (a personal access token in a remote URL, a credential helper in `$HOME`), which goes through the open egress; SPEED-967 closes it;
- changes to the local repository (commit, checkout, reset). A read-only `.git`, the first shape of SPEED-67, is rejected: it breaks fetch and worktrees whose `.git` is a file, and it blocks only changes that can be undone;
- confirmation of a single write, which is SPEED-513;
- the repository scope of the GitHub and GitLab MCP tools, which is SPEED-961;
- an MDM rule per integration; MDM forces only the global mode.

MCP servers outside the hub are not governed by this policy. Claude Code starts with `--mcp-config` and `--strict-mcp-config` (`crates/speedwave-runtime/src/defaults.rs`, guarded by tests in `defaults.rs` and `config.rs`), and the flag makes it use only the servers from `--mcp-config` and ignore all other MCP configurations[^2].

## Integration mode and git push

Integration mode is implemented (SPEED-58, decisions 12 and 13). The push block is decided and left to SPEED-67:

- Every integration has one mode, Full or Read-only. The user sets it in the integration's panel in Desktop ("Access: Full / Read-only"); it enters `compose_access_policy` as an entry of the per-service map.
- For GitHub and GitLab, Read-only blocks the write tools in the hub and also the push through the proxy to that forge. The push token is the integration's token (ADR-106), and without the integration there is no push through Speedwave. A separate push switch is rejected: the combinations "tools yes, push no" and the reverse have no use case.
- The proxy gets the mode in the forge's entry of `proxy.json` and rejects both `git-receive-pack` requests (the ref discovery `GET` and the `POST`) with 403 and a `text/plain` body that git shows as `remote:` lines. `git-upload-pack` is unchanged. A denied push is written to `audit-proxy.jsonl` with the same reason.

## Consequences

- Hub-side enforcement depends on the annotations of the workers. A worker that annotates a write tool as read-only passes it in read-only mode. The built-in workers are reviewed in this repository; the annotations of Speedwave plugins are checked before release (the figma plugin has an annotation test).
- A plugin without annotations loses all its tools in read-only mode.
- Read-only blocks every tool that writes a file, because MCP defines `readOnlyHint` as "does not modify its environment". `downloadFile` of Slack and SharePoint and every Office tool that produces a file are therefore blocked, although they change nothing in the external service.
- The hub's `os` service has one name, so the OS integrations are separated by the `osCategory` of the tool; a tool of an OS service without a category follows the `os` entry or the default.
- The decision is taken when the wrappers of an `execute_code` run are built, from the rules loaded at hub start. A change takes effect through the hub restart, not in a running hub.
- A tool call made while the hub restarts fails, and the agent can retry it once the hub is back.
- `policy.json` has a second consumer for a new section. The contract is documented in `.claude/rules/mcp-servers.md` and `.claude/rules/managed-policy-config.md`.

## Alternatives rejected

- **A condition and an environment variable in the wrapper.** SPEED-513, SPEED-961 and SPEED-968 would each add a condition in the same place, and the precedence of MDM, the global mode and the integration mode would diverge between the host and the hub.
- **A second policy file for the hub.** Two files that must be rendered, mounted and recreated together.
- **Precedence in the hub.** The host has to know the effective mode for the UI and for the proxy; two implementations would drift.
- **Trusting `custom-*` annotations.** Their source is not signed by Speednet.

## To be verified on a running instance

These checks need `make dev DEV_INSTANCE=speed-598` run by a person; they are not verified by the code or the tests of this change.

- Whether a Claude Code session reconnects to the hub after `restart_hub` and the next tool call works. The server accepts a stale session id; the client behavior is unverified. If it does not reconnect, Desktop has to say that the change applies from a new session.
- Whether MCP servers of Claude Code plugins and claude.ai connectors load under `--strict-mcp-config`. If they load, read-only mode has to narrow `managed-settings.json` to the hub (`allowManagedMcpServersOnly`, `allowedMcpServers`), which works from a new session; that narrowing is not built in this change. If they do not load, this section records that the flag cuts them off.
- A write through an integration is denied with the teaching message, a read passes, and the denied call appears in the audit.
- Setting one integration to Read-only in its panel (a built-in one, a macOS one, a plugin) restarts the hub, blocks that integration's writes and leaves the others, and the control shows Read-only and is disabled once the global mode is on.

## References

[^1]: Model Context Protocol, schema reference 2025-06-18, `ToolAnnotations`: "all properties in ToolAnnotations are **hints**. They are not guaranteed to provide a faithful description of tool behavior (including descriptive properties like `title`). Clients should never make tool use decisions based on ToolAnnotations received from untrusted servers." and `readOnlyHint`: "If true, the tool does not modify its environment": https://modelcontextprotocol.io/specification/2025-06-18/schema

[^2]: Claude Code, CLI reference, `--strict-mcp-config`: "Only use MCP servers from `--mcp-config`, ignoring all other MCP configurations": https://code.claude.com/docs/en/cli-reference
