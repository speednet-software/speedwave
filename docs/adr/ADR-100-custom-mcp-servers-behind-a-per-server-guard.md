# ADR-100: Custom MCP Servers Behind a Per-Server Guard

> **Status:** Accepted
> **Date:** 2026-10-08
> **Context:** Users want to add MCP servers Speedwave does not ship (a public npm package, or an HTTP MCP endpoint already running on the host such as a design tool's local server) without giving third-party code the reach of a built-in worker or a signed plugin. The MCP specification lets any server describe its own tools, and tells clients to treat tool annotations as untrusted unless the server is trusted[^1]. Third-party code must therefore never sit where Claude, the hub or another worker can reach it directly, and the user must decide which of its tools Claude may call.

## Decision

1. **A Custom MCP server is a user-approved entry in the user config** (`ProjectUserEntry.custom_mcp`, `crates/speedwave-runtime/src/custom_mcp/model.rs`), never in the repository `.speedwave.json`. It runs only when it is valid, beta features are on, the organization policy allows it (`ManagedCustomMcpConfig`, presence-is-lock), the user enabled it and its recorded consent digest equals the digest recomputed from its pinned fields (`custom_mcp::effective::resolve_effective`). At most `consts::CUSTOM_MCP_MAX_PER_PROJECT` (5) run per project. The resolution is computed once per config resolve and carried on `ResolvedIntegrationsConfig::custom_mcp`, so the CLI and the Desktop render the same compose from the same inputs.

2. **Every server sits behind its own guard container** (`mcp-custom-<name>`, image `speedwave-mcp-custom-guard`, Speedwave code in `mcp-servers/custom-guard/`). The hub reaches only the guard, as an ordinary worker (`WORKER_CUSTOM_<NAME>_URL`, bearer `MCP_CUSTOM_<NAME>_AUTH_TOKEN` from `/secrets/custom-<name>-auth-token:ro`, `ENABLED_SERVICES` += `custom-<name>`). The guard enforces the tool decisions (ADR-103) and talks to the server:
   - **npm mode:** the server runs in `mcp-custom-<name>-up`, the package started by the stdio↔Streamable HTTP launcher (`mcp-servers/custom-launcher/`) behind a second per-server bearer that only the guard and the server receive. Its image is pinned and built locally (ADR-101); its network has no route out except its own egress proxy (ADR-102).
   - **host mode:** only the guard runs, on the compose-managed `_custom_host` bridge, and reaches the Desktop relay through `host.docker.internal` with the bearer from the mounted `relay-<name>/` directory. Paths are mapped between `/workspace` and the raw project directory (`SPW_HOST_PROJECT_DIR`, `SPW_HOST_PATH_STYLE`).

3. **The guard image is a catalogue image without a template placeholder.** It is in `build::IMAGES` (bundle-manifest tag, bundle scripts, `hash_inputs`) but listed in `compose/mod.rs::RENDERED_ONLY_IMAGES` instead of `IMAGE_PLACEHOLDERS`: the renderer reads its tag only when it adds a guard, so a project without Custom MCP servers renders exactly as before, and `enabled_images` builds it only while at least one server runs.

4. **Every container is hardened like a plugin and checked at every start gate.** The renderer (`compose/custom_mcp.rs`, `compose/custom_host.rs`) emits `read_only`, UID 1000, `cap_drop: [ALL]`, `no-new-privileges`, a `noexec` `/tmp`, `pull_policy: never`, role/id/consent labels and limits from `resources::CUSTOM_MCP_{GUARD,SERVER,EGRESS}_RESOURCES`. `SecurityCheck` gains seven rules (`UnknownService` and `CustomMcp{Consent,Image,Volumes,Networks,ForbiddenKeys,Resources}`, `compose/security_check/custom.rs`) that compare every Custom MCP container with `custom_mcp::expectations_for(user_config, project, managed)`, computed from the current config at every gate. A rollback snapshot holding a server whose consent was revoked therefore fails and gives way to a fresh render (`update::choose_rollback_compose`). A service that is neither built-in, a labelled plugin nor a correctly labelled Custom MCP container no longer starts.

5. **Names:** a server name matches `^[a-z][a-z0-9-]{0,30}$`, does not end in `-up`/`-egress` (its companion containers) and is not `guard`, `relay` or `relay-*` (the guard image repository and the relay state directories). The `custom-` service-id prefix is reserved against plugins (ADR-015).

## Consequences

- A malicious npm server can reach only its own credentials (`tokens/<project>/custom-<name>:/tokens:ro`), `/workspace` in the mode the user approved, and the domains on its own egress allowlist. The hub and `claude` never receive its launcher bearer.
- A host server is reached through the guard, but on macOS the `claude` container can still open host ports directly through the Lima gateway (ADR-062), so its tool allowlist is advisory until host-port isolation ships; the Desktop states that before enabling a host server.
- Custom MCP state lives under `<data_dir>/custom-mcp/<project>/` (owner-only, `fs_security`); the guard policy is written empty only when absent, because the Desktop owns the tool decisions in it.

## Rejected alternatives

- **Running third-party servers as plugins.** Plugins are signed by Speednet (ADR-015); a user-chosen package has no such signature, and a plugin runs on the project network with the hub.
- **One guard for every server.** A compromised guard would then hold every server's bearer and policy.
- **A `${IMAGE_MCP_CUSTOM_GUARD}` placeholder in the template.** It would put a guard-image reference into every project's compose although most projects run no Custom MCP server.

[^1]: Model Context Protocol specification 2025-06-18, Tools: "clients MUST consider tool annotations to be untrusted unless they come from trusted servers". https://modelcontextprotocol.io/specification/2025-06-18/server/tools
