# ADR-055: Built-in `office` MCP Worker (Word / Excel / PowerPoint / PDF — read, write, convert, charts)

> **Status:** Accepted
> **Context:** Speedwave had no built-in way to read, write, or convert `.docx`/`.xlsx`/`.pptx`/`.pdf`, so Claude improvised fragile, isolation-breaking workarounds.

## Decision

Ship a built-in MCP worker `office` (compose name `mcp-office`, hub env `WORKER_OFFICE_URL`): a thin TypeScript worker on `@speedwave/mcp-shared` that shells out to mature document tools (`markitdown`, `pandoc`, LibreOffice headless, `weasyprint`, `pypdf`, `python-docx`/`openpyxl`/`python-pptx`, `matplotlib`, SheetJS) via Python/CLI helper scripts. It carries no service credentials (no `/tokens` mount — it is a pure file processor), runs with no network egress, and mounts only the project workspace at `/workspace:rw` behind a hard path policy. The full feature scope (read, write, create, convert in both directions, PDF manipulation, Office→PDF, charts — roughly 25 tools) ships at once.

## Why

- **A worker, not a skill in `Containerfile.claude`.** Office/PDF parsers are a classic malware-bearing surface. In a separate hardened worker (`cap_drop: ALL`, `read_only`, no tokens, no egress, only `/workspace` mounted) an exploited parser is confined to `/workspace`; the Claude container — holding `~/.claude`, the IDE bridge, conversation history — is untouched. A skill would put the parser in Claude's own container.
- **Image weight.** LibreOffice headless plus the Python/Office/PDF libraries is a large image (LibreOffice dominates). As a worker it builds once and starts only when `office` is enabled per-project; baked into `Containerfile.claude` it would burden every machine and project.
- **Deterministic contract.** Named tools with fixed schemas are reproducible and tested in the same commit, unlike whatever glue code Claude would otherwise write per-task.
- **Consistency & free per-project toggle.** Reuses the existing worker pattern (hub discovery via `WORKER_*_URL`, the `_meta` policy from ADR-036) and is gated by `ENABLED_SERVICES` automatically.
- **Own thin worker, not wrapping an upstream MCP server (ADR-053 gate).** No single mature upstream MCP server covers the full scope: `markitdown-mcp` is read-only[^1], `pptx-xlsx-mcp` is Windows-only COM automation[^2], the rest are single-maintainer community projects. So we glue mature libraries/CLIs instead.

## Security contract (part of the decision)

- **No egress at the network layer.** `mcp-office` is attached only to a dedicated `internal: true` network (`${NETWORK_NAME}_office`) with no gateway route, so it has no internet. `mcp-hub` attaches to both that and the main network so discovery still works (the hub holds zero tokens). When `office` is disabled, the filter removes the network and the hub's attachment. Application-level defenses layer on top: WeasyPrint's `url_fetcher`[^3] restricted to `file://` under `/workspace`, `pandoc` and LibreOffice run offline.
- **Path policy, enforced in the worker.** Every input/output path is canonicalized, rejected if not under `/workspace/` or if any component is a symlink, written atomically, and defaulted to `/workspace/.speedwave/office/` so an exploited parser cannot overwrite `.git`/`.speedwave.json`/scripts.
- **Anti-DoS limits.** Per-call caps on input-file size, PDF pages, subprocess wall-time (longer for LibreOffice via `_meta.timeoutClass`), container memory, and bounded subprocess output buffers. Exceeding any limit is a clear tool error.
- **No service credentials, but an internal Bearer.** `auth_fields: &[]` in `TOGGLEABLE_MCP_SERVICES`; the closest precedent for a credential-less toggleable MCP service is `playwright` (also `auth_fields: &[]`, `credential_files: &[]`). The worker still receives the standard internal Bearer token and fails fast (`process.exit(1)`) without `MCP_OFFICE_AUTH_TOKEN`.
- **No macros / active content.** LibreOffice headless runs with no script provider; the Python parsers read XML and never execute macros.
- **Standard container hardening:** `read_only`, `cap_drop: ALL`, `no-new-privileges`, runs as the container user, `tmpfs: /tmp:noexec,nosuid` with no exception (the LibreOffice profile lives there too), and no exposed ports.

## Tool contract (frozen here, not "refined during implementation")

Input is preferably a `/workspace` path; small inline content is accepted, large inputs are path-only. Output is always a file under `/workspace/.speedwave/office/`, returned with a bounded text preview — never the whole large document into context. The tool set covers: read-to-Markdown (`readDocument`, multi-engine best-output-wins) and PDF text/metadata; Markdown/HTML → `.docx`/`.pptx`/PDF; chart rendering (`renderChart`, a normative `matplotlib` spec — bar/line/pie/scatter/area) plus native chart objects inside Office files via the create/edit DSL; create/edit `.docx`/`.xlsx`/`.pptx` via a normative `spec`/`ops` JSON DSL; Office→PDF and a normative Office↔Office conversion matrix (LibreOffice headless, serialized by an in-worker mutex with a per-process profile); and PDF manipulation (merge, split, rotate, watermark, fill form). Anything outside the enumerated DSL or matrix is a tool error, not best-effort.

Out of scope for v1: `docling`/OCR (large ML models), full-fidelity PDF→editable-`.docx`, full N×N conversion, interactive HTML charts, anything requiring egress.

## Discoverability

Three layers select tools across the large tool set: `_meta.keywords` + `_meta.deferLoading` (ADR-036) so the hub shows only the common entry tools upfront; cross-referencing tool descriptions that disambiguate the three roads to PDF; and a decision-map `SKILL.md` shipped via the core-resources sync path. The skill is linked into `~/.claude/skills/office` only when `office` is in `ENABLED_SERVICES` (per-integration gating — see "Where it lives in code"), so with the integration off Claude does not see it.

## Where it lives in code

- **Worker** — `mcp-servers/office/` (`src/index.ts` fails fast without `MCP_OFFICE_AUTH_TOKEN`; Python helpers under `scripts/`)
- **Compose service + egress-less network** — `containers/compose.template.yml` (`mcp-office`, `${NETWORK_NAME}_office` declared `external: true` and pre-created isolated by the runtime, see the 2026-10-08 amendment)
- **Service registry SSOT** — `crates/speedwave-runtime/src/consts.rs::TOGGLEABLE_MCP_SERVICES` (the `office` entry, `egress_less: true`, `auth_fields: &[]`)
- **Filtering & auth tokens** — `crates/speedwave-runtime/src/compose.rs` (`apply_integrations_filter`, `apply_worker_auth_tokens_in`)
- **Decision-map skill** — `containers/claude-resources/skills/integrations/office/SKILL.md`, gated per-integration by `containers/entrypoint.sh` via `ENABLED_SERVICES` + the `~/.claude/.speedwave-managed-links` state file

## Rejected alternatives

- **A skill in `Containerfile.claude`** (libraries + `claude-resources/`) — puts the malware-bearing parser in Claude's own container and the large image on every machine.
- **Wrap an upstream MCP server** — none is both mature and covers create/edit/convert/charts; the read-only and Windows-only options fail the ADR-053 wrap gate.
- **A plugin (sibling repo)** — this is a core capability users requested, not an optional add-on; a plugin means coordinating two repositories and slower iteration.
- **Keep the prior container-to-container PDF workaround** — fragile (depends on a private container IP), expensive (large base64 through the model context), and opens an unauthenticated path bypassing the hub.
- **`docling`/OCR in v1** — YAGNI: large ML models, and `readDocument` covers the structured-text case.
- **SheetJS on the write path** — the SheetJS Community Edition writes no cell styles or charts, so writes stay on `openpyxl`[^4].
- **`mcp-office` on the shared network with only application-level fetch restrictions** — a network-level egress block is stronger and cheaper than auditing every tool for remote-fetch paths; the application restrictions remain as defense in depth.

## Amendment (2026-10-08): the runtime pre-creates the office network with `--internal`

**Context.** The `internal: true` key never reached the engine. Speedwave starts every stack with the bundled nerdctl 2.2.2 (`consts.rs::NERDCTL_FULL_VERSION`), whose `compose up` creates a non-external network with `nerdctl network create`, passing only the name, the driver, the driver options and the IPAM settings; every other non-empty key, `internal` included, is logged as `Ignoring: network …` and dropped[^5]. A plain `network create` builds a bridge with `isGateway` and `ipMasq` set, a `portmap` plugin and a `0.0.0.0/0` route in its IPAM config; only `--internal` leaves all of them out[^6]. So `${NETWORK_NAME}_office` had a gateway and masquerade, and `mcp-office` could reach the internet, contrary to the security contract above. The compose tests only pinned the YAML text.

**Decision.** Egress-less networks are created by the runtime, not by compose.

- The template declares `${NETWORK_NAME}_office` with `name:` equal to its key and `external: true`. nerdctl compose does nothing for an external network on `up` or `down`[^7].
- Before every `compose up` (`LockedRuntime::compose_up`, `compose_up_recreate` and `compose_up_service`, under the project lock, so the CLI, Desktop, update and rollback paths all get it), the runtime reads the compose file it is about to start. For each external network whose key is the egress-less network of an `egress_less` service (`compose/networks.rs`), it calls `ContainerRuntime::ensure_internal_network` (`runtime/networks.rs`). That runs `nerdctl network inspect --mode=native`, which prints the network's raw CNI config list[^8]. A missing network is created with `network create --internal` and the two labels nerdctl compose puts on a project network, then inspected again. The start fails unless the first CNI plugin is a bridge, no plugin sets `isGateway`, `isDefaultGateway` or `ipMasq` (all three are omitted when false[^9]), no plugin is `portmap`, and no IPAM route is a default route. An existing network that fails the same check is removed and created again; if containers still use it, the removal fails and so does the start. On Lima, a transient `limactl shell` EOF repeats only `network inspect`, `ls` and `rm` (`runtime/lima.rs::network_command_is_retryable`; a repeated `rm` that finds the network gone counts as removed), never `network create`; a failed create is accepted only when a fresh inspect finds the network present and isolated (`runtime/networks.rs::ensure_internal_network_with`).
- When `office` is disabled, the network is absent from the compose file and nothing is created.
- The `com.docker.compose.project=<project>` label lets the post-`down` sweep that already removes a project's compose networks (`runtime/mod.rs::force_remove_project_networks_with_run_fn`) remove this network too, so a stop removes it and the next start creates it again. Unregistering a project also removes every egress-less network of the project after `compose down`, and keeps the project registered if that fails (`LockedRuntime::remove_egress_less_networks`, called from `containers_cmd.rs::remove_project_core`). Factory reset deletes the Lima VM or the WSL distro, which holds the network configs.
- A new `SecurityCheck` rule, `EGRESS_LESS_NETWORK_EXTERNAL`, fails a compose in which an egress-less network is not one of the project's own (`compose/networks.rs::egress_less_network_names`), is not `external: true` or names another network, in which `mcp-office` is attached to anything else, or in which any service other than `mcp-office` and `mcp-hub` is attached to it. A rollback snapshot rendered before this amendment declares the office network `internal: true`, fails the rule, and gives way to a fresh render (`update.rs::choose_rollback_compose`).

**Consequences.** compose-go names a non-external network without `name:` `<project>_<key>` and an external one by its key[^10], so the network that earlier releases created (`<project>_<prefix>_<project>_network_office`) is not the one started now. Containers move to the isolated network only when they are recreated: a plain `compose up` starts an existing container again when its service config hash is unchanged[^11], and that hash keys a service's networks by their short name, which this change keeps. A new release changes the Desktop bundle id, so the Desktop reconcile and the update path both run `compose down` and then `compose_up_recreate`; the old network carries the compose project label and goes in that `down`. A stack from an earlier release that the CLI starts before any of those runs would keep `mcp-office` and `mcp-hub` (the two services on the office network) on the old network, so every start also looks for it. Once the isolated network is in place, `LockedRuntime` inspects `<project>_<key>` (`compose/networks.rs::legacy_compose_network_name`, `ContainerRuntime::network_exists`, the same not-found classification as the pre-create). If it exists, a full start (`compose_up` or `compose_up_recreate`) runs `compose_up_recreate` instead, which recreates every container on the networks the compose file now declares, and then removes the old network. An engine that cannot answer the inspect fails the start rather than skipping the check. A removal that fails, for example because a container is still attached, fails the start after the recreate, and the next start tries again. A `compose_up_service` start (the proxy hot-reload) that meets the old network does not escalate: recreating the whole stack would also recreate `claude` and end a running chat. It fails with `runtime/mod.rs::NetworkMigrationPending` ("The project network is being migrated to an isolated network; restart the project to finish it.") and leaves the running containers untouched; the next full start migrates them. The engine behavior this relies on (the not-found messages of `network inspect --mode=native` and `network rm`, and the CNI config of a `network create --internal` network) is pinned on the e2e rigs by `_tests/e2e/engine-contract.bats`. The same mechanism serves any later network that must have no egress. Isolation is checked against the CNI config on every start, not by probing traffic from inside a container.

[^1]: [markitdown-mcp package README](https://github.com/microsoft/markitdown/tree/main/packages/markitdown-mcp): exposes a single `convert_to_markdown(uri)` tool, no write/edit tool.

[^2]: [jenstangen1/pptx-xlsx-mcp](https://github.com/jenstangen1/pptx-xlsx-mcp): uses `pywin32` COM automation against locally running PowerPoint/Excel, Windows-only.

[^3]: [WeasyPrint API reference, `url_fetcher`](https://doc.courtbouillon.org/weasyprint/stable/api_reference.html): `HTML`/`CSS` accept a custom `url_fetcher` callable that can restrict or reject fetched URL schemes.

[^4]: [SheetJS issue #3214](https://git.sheetjs.com/sheetjs/sheetjs/issues/3214): reading and re-writing a file with the Community Edition does not preserve cell styles; styling and chart-writing support is reserved for the Pro edition.

[^5]: [nerdctl v2.2.2 `pkg/composer/up_network.go` L39-L92](https://github.com/containerd/nerdctl/blob/v2.2.2/pkg/composer/up_network.go#L39-L92): `UnknownNonEmptyFields(&net, "Name", "Ipam", "Driver", "DriverOpts")` logs `Ignoring: network …`, and the `network create` argv carries only the compose labels, `--driver`, `--opt` and the IPAM flags.

[^6]: [nerdctl v2.2.2 `pkg/netutil/netutil_unix.go` L132-L161](https://github.com/containerd/nerdctl/blob/v2.2.2/pkg/netutil/netutil_unix.go#L132-L161) and [L223-L226](https://github.com/containerd/nerdctl/blob/v2.2.2/pkg/netutil/netutil_unix.go#L223-L226): `bridge.IsGW = !internal`, `IPMasq = false` when internal, the `portmap` plugin only when not internal, and the `0.0.0.0/0` IPAM route only when not internal.

[^7]: [nerdctl v2.2.2 `pkg/composer/up_network.go` L34-L37](https://github.com/containerd/nerdctl/blob/v2.2.2/pkg/composer/up_network.go#L34-L37) and [`pkg/composer/down.go` L94](https://github.com/containerd/nerdctl/blob/v2.2.2/pkg/composer/down.go#L94): an external network is skipped on `up` and on `down`.

[^8]: [nerdctl v2.2.2 `pkg/cmd/network/inspect.go` L82-L106](https://github.com/containerd/nerdctl/blob/v2.2.2/pkg/cmd/network/inspect.go#L82-L106): `--mode=native` prints the network with `CNI` set to its raw config list; a name that matches no network ends in `unable to find any network matching the provided request`.

[^9]: [nerdctl v2.2.2 `pkg/netutil/cni_plugin_unix.go` L27-L30](https://github.com/containerd/nerdctl/blob/v2.2.2/pkg/netutil/cni_plugin_unix.go#L27-L30): the bridge plugin's `isGateway`, `isDefaultGateway` and `ipMasq` fields are `omitempty`.

[^10]: [compose-go v2.10.0 `loader/normalize.go` L251-L256](https://github.com/compose-spec/compose-go/blob/v2.10.0/loader/normalize.go#L251-L256), the compose-go version [nerdctl v2.2.2 requires](https://github.com/containerd/nerdctl/blob/v2.2.2/go.mod#L10): a network without `name:` is named by its key when it is external and `<project>_<key>` otherwise.

[^11]: [nerdctl v2.2.2 `pkg/composer/up_service.go` L156-L177](https://github.com/containerd/nerdctl/blob/v2.2.2/pkg/composer/up_service.go#L156-L177) and [`pkg/composer/config.go` L80-L91](https://github.com/containerd/nerdctl/blob/v2.2.2/pkg/composer/config.go#L80-L91): without `--force-recreate`, an existing container whose `ComposeConfigHash` label equals the hash of the JSON-encoded service config is started instead of recreated.
