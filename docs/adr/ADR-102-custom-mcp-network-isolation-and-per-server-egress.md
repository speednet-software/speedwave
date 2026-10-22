# ADR-102: Custom MCP Network Isolation and Per-Server Egress

> **Status:** Accepted
> **Date:** 2026-10-08
> **Context:** A Custom MCP server (ADR-100) must reach the internet only at the `host:port` targets the user approved, and nothing else in the project. nerdctl compose ignores a network's `internal` key: its network setup passes only `Name`, `Ipam`, `Driver` and `DriverOpts` through and logs every other field as ignored[^1], so `internal: true` in the YAML isolates nothing. The initial design shared one egress proxy per project across every server.

## Decision

1. **Egress-less networks are pre-created, not declared.** `_custom` (hub ↔ npm guards) and `_cx_<name>` (one npm server's guard, server and egress) are declared `external: true` under their own name; `LockedRuntime` creates every egress-less network a rendered compose declares with `nerdctl network create --internal` and checks the created bridge live (no gateway, no masquerade, no default route) before every `compose up`, the same path as the office network. `compose/networks.rs` is the naming SSOT and `is_egress_less_network` recognizes office, `_custom` and `_cx_<valid name>`. `CUSTOM_MCP_NETWORKS` checks who declares and joins `_custom` and `_cx_<name>`, while `EGRESS_LESS_NETWORK_EXTERNAL` keeps to the built-in networks (`is_builtin_egress_less_network`); the one-time probe for a network compose created before the `--internal` pre-create also covers only the built-in ones, since no release let compose create a Custom MCP network.

2. **Egress is per server, reversing the initial design of one shared proxy.** Each npm server gets `mcp-custom-<name>-egress`: the `spw-egress` CONNECT proxy (second binary of the proxy image, `entrypoint: ["/spw-egress"]`) on `_cx_<name>` and on its own compose-managed bridge `_eg_<name>`. The server's `HTTPS_PROXY`/`HTTP_PROXY` point at it, `NO_PROXY` is empty and `NODE_USE_ENV_PROXY=1` asks Node to honour them for `fetch()` and `http`/`https` requests[^2][^3]. Node marks this built-in proxy support experimental (stability 1.1, Active Development) and supports it for `http`/`https` from v24.5.0[^3]; the pinned server base image (`consts::CUSTOM_MCP_RESOLVER_IMAGE`, the `FROM` of `Containerfile.npm.template`) was Node 24.16.0 when this was written (re-check on a digest bump), the version Docker Hub's `24.16.0-bookworm-slim` tag carries under that digest[^4]. The server has no route out anyway, so a client that ignores the proxy only fails. A proxy shared by every server would sit on every `_cx_` network and, once taken over, bridge them; telling servers apart by source subnet would need fixed subnets per network.

3. **Host-mode guards use a normal bridge.** `_custom_host` (hub + host guards) needs a gateway to reach `host.docker.internal`, so it is compose-managed; only Speedwave's guard and the hub join it.

4. **Membership is a start-gate invariant.** `SecurityCheck`'s `CustomMcpNetworks` rule requires `_custom`/`_cx_*` to be external under their own project-scoped names, exact membership per role, plain network lists (no aliases or fixed addresses), no `network_mode`, and no other service than the hub (on `_custom`/`_custom_host`) in a Custom MCP network.

5. **Cleanup.** External networks live outside the compose lifecycle: project removal deletes `_custom`, the `_cx_` network of every configured server name and every egress-less network the rendered compose declares; `LockedRuntime::remove_custom_mcp_server_networks` deletes one server's `_cx_` and compose-created `_eg_` networks after a render without it is up.

## Consequences

- Up to two networks per npm server plus `_custom` and `_custom_host`; the CNI address headroom for several projects is an open item to measure.
- A change to the egress binary retags the proxy image.
- The egress allowlist (`egress.json`) is rewritten from the effective domains on every render and re-read by the proxy on every CONNECT, so a domain change needs no restart.

[^1]: nerdctl v2.2.2, `pkg/composer/up_network.go` L39-L92: unknown network fields are logged as `Ignoring: network …` and no `--internal` flag is passed. https://github.com/containerd/nerdctl/blob/v2.2.2/pkg/composer/up_network.go#L39-L92

[^2]: Node.js command-line API, `NODE_USE_ENV_PROXY=1`: Node parses `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` at startup and routes requests through the proxy. https://nodejs.org/api/cli.html#node_use_env_proxy1

[^3]: Node.js HTTP API, "Built-in Proxy Support": covers `fetch()` and `http.request()`/`https.request()`, stability 1.1 (Active Development), added in v24.5.0 and v22.21.0. https://nodejs.org/api/http.html#built-in-proxy-support

[^4]: Docker Hub, `library/node` tag `24.16.0-bookworm-slim`, whose `digest` is the `sha256:2c87ef9b…` the template and the resolver pin. https://hub.docker.com/v2/repositories/library/node/tags/24.16.0-bookworm-slim
