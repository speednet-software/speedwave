# ADR-091: MDM-managed services, the management inventory and live policy

**Status:** Proposed

**Date:** 2026-10-07

## Context

ADR-076 and ADR-090 let an organisation force telemetry, the PII policy and the AI route through `managed-config.json`. What a project may reach besides the model was still the user's alone: every integration (Slack, GitLab, GitHub, Atlassian, Redmine, SharePoint, Office, Playwright, Context7), the macOS integrations and every plugin run as MCP workers the user turns on per project. An organisation governing AI use needs to see which of those each machine runs and to keep some of them off, as it does for the model route.

The management layer stays agnostic of who manages the machine: Speedwave enforces what the policy says (the enforcement point) and reports what it runs; the decision lives with whatever writes the policy — an MDM profile, or a management agent of any vendor (Auditor is one). A plugin cannot be the enforcement point: the user can remove it.

Until now a policy change reached Speedwave only at its next start, so a management agent had to restart the app to apply one.

## Decision

**A `services` block in `managed-config.json` decides which services may run.** `ManagedServicesConfig` (`crates/speedwave-runtime/src/config.rs`): `default` (`allow` | `deny`) for a service no rule names, and `rules` keyed by the service's policy key — a built-in by its config key (`slack`), a macOS integration as `os.<key>` (`os.mail`), a plugin as `plugin:<service_id>`. `validate` rejects a key naming no such service; it runs in the boot check with `llm_egress`.

**The policy is applied where the enabled set is computed.** `apply_services_policy` turns off every denied service in `ResolvedIntegrationsConfig` inside `resolve_project_config_in_with_load`, so the compose filter drops the denied workers and `ENABLED_SERVICES` (hub and Claude) never names them — one point, every consumer. An unreadable policy denies every service (fail-closed, like telemetry and the PII policy). The desktop shows a denied service as blocked by the organisation and refuses to enable it (`set_integration_enabled`, `set_os_integration_enabled`, `set_plugin_enabled`).

**Speedwave reports what it runs.** `management::refresh_inventory` writes `<data_dir>/management/inventory.json` — every project with the services its user turned on, each with its policy key, kind, name, whether it runs and whether the policy blocks it, plus the policy's state — at startup, after every save of the user config and after a policy change. A management agent reads it instead of inspecting processes.

**The policy is live.** The desktop watches the policy's directory (`managed_policy_watch`); when the file changes it validates it, refreshes the inventory, tells the UI (`managed_policy_changed`) and, when the active project's containers run, re-renders and restarts them (`integrations_cmd::restart_project_containers`). A policy that fails validation is reported and not applied; the running containers keep the last one.

## Consequences

- An organisation can deny a whole class of data flows (a chat tool, a document store, a plugin) on every machine it manages, and see per project which services each machine uses.
- The inventory carries service names, never credentials or content.
- A service turned off by the policy keeps the user's own choice: removing the rule brings it back.
- Applying a changed policy restarts the active project's containers, as toggling an integration does.
