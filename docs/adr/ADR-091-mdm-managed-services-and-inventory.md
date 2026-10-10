# ADR-091: MDM-managed services, the management inventory and live policy

**Status:** Proposed

**Date:** 2026-10-07

## Context

ADR-076 and ADR-090 let an organisation force telemetry, the PII policy and the AI route through `managed-config.json`. What a project may reach besides the model was still the user's alone: every integration (Slack, GitLab, GitHub, Atlassian, Redmine, SharePoint, Office, Playwright, Context7), the macOS integrations and every plugin run as MCP workers the user turns on per project. An organisation governing AI use needs to see which of those each machine runs and to keep some of them off, as it does for the model route.

The management layer stays agnostic of who manages the machine: Speedwave enforces what the policy says (the enforcement point) and reports what it runs; the decision lives with whatever writes the policy — an MDM profile, or a management agent of any vendor (Auditor is one). A plugin cannot be the enforcement point: the user can remove it.

Until now a policy change reached Speedwave only at its next start, so a management agent had to restart the app to apply one.

## Decision

**A `services` block in `managed-config.json` decides which services may run.** `ManagedServicesConfig` (`crates/speedwave-runtime/src/config.rs`): `default` (`allow` | `deny`) for a service no rule names, and `rules` keyed by the service's policy key — a built-in by its config key (`slack`), a macOS integration as `os.<key>` (`os.mail`), a plugin as `plugin:<service_id>`. `validate` rejects a key naming no such service; it runs in the boot check with `llm_egress`.

**The policy is applied where the enabled set is computed.** `apply_services_policy` turns off every denied service in `ResolvedIntegrationsConfig` inside `resolve_project_config_in_with_load`, so the compose filter drops the denied workers and `ENABLED_SERVICES` (hub and Claude) never names them — one point, every consumer. An unreadable policy denies every service (fail-closed, like telemetry and the PII policy). The desktop shows a denied service as not allowed yet and lets the user turn it on all the same (`set_integration_enabled`, `set_os_integration_enabled`, `set_plugin_enabled`): the choice is recorded and reported in the inventory, so the organisation sees what is wanted and can allow it, but the service never runs while the policy denies it.

**Speedwave reports what it runs.** `management::refresh_inventory` writes `<data_dir>/management/inventory.json` — every project with the services its user turned on, each with its policy key, kind, name, whether it runs and whether the policy blocks it, the Claude Code agents the project defines (`agent:<name>`), whether the policy blocks the project, plus the policy's state — at startup, after every save of the user config, before every start of a project and after a policy change. A management agent reads it instead of inspecting processes.

**Projects and agents are governed by name, like services by key.** An organisation that treats every project, service, integration, plugin and agent as an item of its own — each runs only once the organisation allows it — needs to say so for projects and agents too. `projects` and `agents` blocks (`ManagedAccessList`: `default` and `rules` by name) carry it. A project the policy denies is refused where every start renders its compose file (`compose::render_compose_in`), so it never starts, and one running stops when the changed policy restarts it. An agent the policy denies is denied to Claude by name in the project's managed settings (`permissions.deny`: `Agent(<name>)`, `Task(<name>)`) — mounted read-only, above the user's settings. Claude Code's built-in agents are not the organisation's items and are not governed.

**Each item is marked where it appears, never the machine as a whole.** The desktop reads the policy itself (`get_managed_access`) and marks each project (switcher, project pill), service and OS integration (Integrations), plugin (Plugins) and agent (slash menu) with the neutral mark and a lamp: allowed or not allowed. A kind the policy says nothing about is not marked. What a provider says about one item — its compliance, its deployment — belongs to that item and is not shown as a machine-wide setting.

**The policy is live.** The desktop watches the policy's directory (`managed_policy_watch`); when the file changes it validates it, refreshes the inventory, tells the UI (`managed_policy_changed`) and, when the active project's containers run, re-renders and restarts them (`integrations_cmd::restart_project_containers`). A policy that fails validation is reported and not applied; the running containers keep the last one.

**Who manages the machine is named by the policy, not built in.** A `management` block (`ManagedManagementConfig`) carries the provider's `name`, the `status_url` the desktop reads the management status from (with the gateway's headers) and an optional `console_url`; the desktop's status view (`management_cmd`) and its UI show the provider by that name, with a neutral mark. Nothing in Speedwave names a vendor or a vendor's path. A top-level `schema_version` lets an organisation's tooling say which policy schema it writes; one newer than `MANAGED_POLICY_SCHEMA_VERSION` is refused like any invalid policy (`config::validate_managed_policy`, run at boot and by the watcher).

## Consequences

- An organisation can deny a whole class of data flows (a chat tool, a document store, a plugin) on every machine it manages, and see per project which services each machine uses.
- An organisation can let a project or an agent run only once it allows it (a `deny` default with rules for what it allowed); the user sees which, beside each.
- The inventory carries service names, never credentials or content.
- A service turned off by the policy keeps the user's own choice: removing the rule brings it back.
- Applying a changed policy restarts the active project's containers, as toggling an integration does.
- Any management agent can drive Speedwave by writing `managed-config.json` and reading the inventory; the management status contract is the one `management_cmd` reads (organization, host, access, deployments, use cases, project).
