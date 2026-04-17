# ADR-038: Single Internal Worker Port

## Status

Accepted

## Context

Speedwave's compose emitter currently assigns a unique TCP port to every MCP worker it generates:

| Service          | Port |
| ---------------- | ---- |
| `mcp-hub`        | 4000 |
| `mcp-slack`      | 4001 |
| `mcp-sharepoint` | 4002 |
| `mcp-redmine`    | 4003 |
| `mcp-gitlab`     | 4004 |
| `llm-proxy`      | 4009 |

Plugin workers declared a `port` field in `plugin.json` and Speedwave reserved the range `PORT_BASE..=(PORT_BASE + len(TOGGLEABLE_MCP_SERVICES))` plus `PORT_LLM_PROXY` for built-ins, rejecting any plugin manifest whose port overlapped[^1]. Every new built-in service therefore shifted the reserved range, breaking plugin manifests that happened to claim a port in the newly reserved slice[^2].

The question this ADR answers: **does per-worker port uniqueness carry any security weight, or can we collapse every worker onto a single internal port and let DNS disambiguate?**

### What actually depends on port numbers today

Speedwave's security model is explicit about its three pillars[^3]:

- **Token isolation** — each worker mounts only its own `~/.speedwave/tokens/<project>/<service>/` directory as `/tokens:ro`.
- **Network isolation** — each project has a dedicated `speedwave_<project>_network`; workers in project A cannot see workers in project B.
- **Container hardening** — `cap_drop: ALL`, `security_opt: no-new-privileges:true`, `read_only: true`, `tmpfs` with `noexec,nosuid`, per-service resource limits[^4].

None of these pillars references a port. The hub's SSRF protection layer (`validateWorkerUrl()`) checks the _format_ of the port (integer in `1..=65535`) and the _hostname_ (DNS name beginning with `mcp-` or on the gateway allowlist), but does not enforce a per-worker port allowlist[^5]. The compose template does not expose any worker port to the host — every worker is reachable only within the compose network, by DNS service name[^6]. ADR-036 already committed Speedwave to treating all services identically — no `BUILT_IN_SERVICES` list, no `isPluginService()` check[^7] — and port uniqueness was the last remaining field where built-ins and plugins diverged.

### Why port uniqueness stops paying rent

Each container runs in its own network namespace. Two containers listening on the same port is only a conflict when those ports share a namespace (same host, same bridge without NAT). On Speedwave's compose networks, `mcp-slack` and `mcp-playwright` can both bind `:3000` and there is no ambiguity — the hub reaches them as `http://mcp-slack:3000` vs `http://mcp-playwright:3000`. The port number carries no information that the DNS service name does not already carry.

Keeping unique ports therefore costs complexity (template variables, emitter branches, reserved ranges, plugin contract drift) for a benefit (port-based network policies) that Speedwave does not implement and has no roadmap to implement[^8].

## Decision

Collapse worker ports to a single internal constant.

- `PORT_BASE = 4000` — **renamed in docs as `PORT_HUB`** but kept under the same symbol for compatibility. This is the external contract: the `claude` container dials `http://mcp-hub:4000`.
- `PORT_WORKER = 3000` — every MCP worker listens on this port inside its own container. This includes built-in services (`mcp-slack`, `mcp-sharepoint`, `mcp-redmine`, `mcp-gitlab`, future `mcp-playwright`), the optional `llm-proxy` service, and plugin workers.
- `PORT_LLM_PROXY` — removed; llm-proxy listens on `PORT_WORKER` like any other worker. Claude reaches it via `ANTHROPIC_BASE_URL=http://llm-proxy:3000`.
- `plugin.json.port` — deprecated and ignored. The field remains in `PluginManifest` as `Option<u16>` so existing signed manifests still deserialize; setting a non-`PORT_WORKER` value merely emits a `log::warn!` pointing to this ADR. `validate_plugin_port()` is deleted along with the reserved-range logic.

### Impact on plugin contract

Summarised against the plugin contract table in `CLAUDE.md`:

- **`plugin.json` schema** — the `port` field remains structurally valid (optional `u16`), so already-signed plugin ZIPs continue to install. The value is ignored at compose render time with a deprecation warning. Plugin authors should drop the field from new releases.
- **Hub env var convention** — `WORKER_<SLUG_UPPER>_URL` is still injected into the hub, now always ending in `:3000`. Hub code that parses `WORKER_*_URL` is unchanged.
- **Token mount, workspace mount, security constraints** — all unchanged.
- **Coordination** — the `speedwave-plugins` sibling repository updates `template/scaffold/plugin.json`, `presale/plugin.json`, and the `figma` PRD to drop `port`; plugins are re-signed and republished.

## Alternatives rejected

### Reserved ranges (Variant B)

Retain unique ports but carve out a stable reservation: `4001–4019` for built-ins, `4020` for llm-proxy, `4021–4029` for future core services, `4030+` for plugins. This fixes plugin contract drift (the lower bound of the plugin range becomes a stable constant instead of `len(TOGGLEABLE_MCP_SERVICES)`) without touching the per-service port matrix.

Rejected because it only _delays_ the complexity: every built-in addition still requires a reservation decision, the emitter still branches per service, and `plugin.json.port` remains a required field. It trades a rolling breaking change for a structural one, with no compensating benefit in the current threat model.

### Dynamic port allocation

Allocate worker ports at compose render time from a pool. Solves drift without reserving ranges.

Rejected because it adds a discovery mechanism (the hub needs to learn which port was assigned to which service) without removing the per-worker port from the code path. This is more complexity than unique static ports, not less.

## Consequences

### Positive

- **Plugin contract stabilises.** Adding a new built-in MCP service never again forces a plugin repo to republish.
- **Fewer template variables.** `${PORT_HUB}` + `${PORT_WORKER}` replace `${PORT_HUB}` + `${PORT_SLACK}` + `${PORT_SHAREPOINT}` + `${PORT_REDMINE}` + `${PORT_GITLAB}` — and scales to zero additional vars per future worker.
- **Smaller emitter surface.** `render_compose()` loses four port locals and three `yaml.replace()` calls; `validate_plugin_port()` and its tests go away entirely.
- **Consistent with ADR-036.** The self-declaring worker policy already unified built-ins and plugins at the hub layer; this ADR completes that unification at the compose layer.

### Negative

- **Loss of optional port-based debugging heuristic.** Previously one could tell "which worker is on 4002?" from a port number; now every worker says `:3000` and the disambiguator is the service name. This is an ergonomic regression for ad-hoc debugging but has no impact on structured logs (which use service names) or observability (which tags by container name).
- **Theoretical loss of future port-based network policies.** If Speedwave ever adds firewall rules keyed on worker port, those rules would need to be keyed on DNS/hostname instead. No such feature is planned; if added, the migration is straightforward because container names are already stable.

## Verification

- `test_all_workers_use_port_worker` — renders a full compose with every integration enabled and asserts every worker service (excluding `claude` and `mcp-hub`) has `PORT=3000` in its environment.
- `test_hub_worker_urls_use_port_worker` — asserts every `WORKER_*_URL` entry in the hub environment ends with `:3000`.
- `test_llm_proxy_uses_port_worker` — enables an external LLM provider, asserts `llm-proxy` listens on `PORT=3000` and Claude's `ANTHROPIC_BASE_URL=http://llm-proxy:3000`.
- `test_plugin_manifest_port_is_ignored` — constructs a plugin manifest with `port: Some(9999)`, calls `generate_plugin_service()`, asserts the resulting service uses `PORT=3000`.
- `test_mcp_plugin_without_port_is_accepted` — validates a plugin manifest with `port: None` and confirms it passes validation.

## References

[^1]: `crates/speedwave-runtime/src/plugin.rs`, function `validate_plugin_port` (pre-this ADR): https://github.com/speednet-software/speedwave/blob/dev/crates/speedwave-runtime/src/plugin.rs

[^2]: Plugin contract table in `CLAUDE.md`: https://github.com/speednet-software/speedwave/blob/dev/CLAUDE.md#plugins

[^3]: Security architecture overview: https://github.com/speednet-software/speedwave/blob/dev/docs/architecture/security.md

[^4]: Container hardening reference: https://github.com/speednet-software/speedwave/blob/dev/docs/architecture/containers.md

[^5]: `mcp-servers/shared/src/security.ts`, function `validateWorkerUrl`: https://github.com/speednet-software/speedwave/blob/dev/mcp-servers/shared/src/security.ts

[^6]: `containers/compose.template.yml` — no worker has a `ports:` mapping to the host: https://github.com/speednet-software/speedwave/blob/dev/containers/compose.template.yml

[^7]: ADR-036, Self-Declaring Worker Policy: https://github.com/speednet-software/speedwave/blob/dev/docs/adr/ADR-036-self-declaring-worker-policy.md

[^8]: OWASP container security guidance — network segmentation operates at the network/namespace level, not per-port within a shared bridge: https://owasp.org/www-project-docker-top-10/
