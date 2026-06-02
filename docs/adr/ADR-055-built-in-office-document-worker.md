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
- **Own thin worker, not wrapping an upstream MCP server (ADR-053 gate).** No single mature upstream MCP server covers the full scope: `markitdown-mcp` is read-only, `pptx-xlsx-mcp` is Windows-only COM automation, the rest are single-maintainer community projects. So we glue mature libraries/CLIs instead.

## Security contract (part of the decision)

- **No egress at the network layer.** `mcp-office` is attached only to a dedicated `internal: true` network (`${NETWORK_NAME}_office`) with no gateway route, so it has no internet. `mcp-hub` attaches to both that and the main network so discovery still works (the hub holds zero tokens). When `office` is disabled, the filter removes the network and the hub's attachment. Application-level defenses layer on top: WeasyPrint's `url_fetcher` restricted to `file://` under `/workspace`, `pandoc` and LibreOffice run offline.
- **Path policy, enforced in the worker.** Every input/output path is canonicalized, rejected if not under `/workspace/` or if any component is a symlink, written atomically, and defaulted to `/workspace/.speedwave-office/` so an exploited parser cannot overwrite `.git`/`.speedwave.json`/scripts.
- **Anti-DoS limits.** Per-call caps on input-file size, PDF pages, subprocess wall-time (longer for LibreOffice via `_meta.timeoutClass`), container memory, and bounded subprocess output buffers. Exceeding any limit is a clear tool error.
- **No service credentials, but an internal Bearer.** `auth_fields: &[]` in `TOGGLEABLE_MCP_SERVICES`; the closest precedent for a credential-less toggleable MCP service is `playwright` (also `auth_fields: &[]`, `credential_files: &[]`). The worker still receives the standard internal Bearer token and fails fast (`process.exit(1)`) without `MCP_OFFICE_AUTH_TOKEN`.
- **No macros / active content.** LibreOffice headless runs with no script provider; the Python parsers read XML and never execute macros.
- **Standard container hardening:** `read_only`, `cap_drop: ALL`, `no-new-privileges`, runs as the container user, `tmpfs: /tmp:noexec,nosuid` with no exception (the LibreOffice profile lives there too), and no exposed ports.

## Tool contract (frozen here, not "refined during implementation")

Input is preferably a `/workspace` path; small inline content is accepted, large inputs are path-only. Output is always a file under `/workspace/.speedwave-office/`, returned with a bounded text preview — never the whole large document into context. The tool set covers: read-to-Markdown (`readDocument`, multi-engine best-output-wins) and PDF text/metadata; Markdown/HTML → `.docx`/`.pptx`/PDF; chart rendering (`renderChart`, a normative `matplotlib` spec — bar/line/pie/scatter/area) plus native chart objects inside Office files via the create/edit DSL; create/edit `.docx`/`.xlsx`/`.pptx` via a normative `spec`/`ops` JSON DSL; Office→PDF and a normative Office↔Office conversion matrix (LibreOffice headless, serialized by an in-worker mutex with a per-process profile); and PDF manipulation (merge, split, rotate, watermark, fill form). Anything outside the enumerated DSL or matrix is a tool error, not best-effort.

Out of scope for v1: `docling`/OCR (large ML models), full-fidelity PDF→editable-`.docx`, full N×N conversion, interactive HTML charts, anything requiring egress.

## Discoverability

Three layers select tools across the large tool set: `_meta.keywords` + `_meta.deferLoading` (ADR-036) so the hub shows only the common entry tools upfront; cross-referencing tool descriptions that disambiguate the three roads to PDF; and a decision-map `SKILL.md` shipped via the core-resources sync path. The skill is linked into `~/.claude/skills/office` only when `office` is in `ENABLED_SERVICES` (per-integration gating — see "Where it lives in code"), so with the integration off Claude does not see it.

## Where it lives in code

- **Worker** — `mcp-servers/office/` (`src/index.ts` fails fast without `MCP_OFFICE_AUTH_TOKEN`; Python helpers under `scripts/`)
- **Compose service + egress-less network** — `containers/compose.template.yml` (`mcp-office`, `${NETWORK_NAME}_office` declared `internal: true`)
- **Service registry SSOT** — `crates/speedwave-runtime/src/consts.rs::TOGGLEABLE_MCP_SERVICES` (the `office` entry, `egress_less: true`, `auth_fields: &[]`)
- **Filtering & auth tokens** — `crates/speedwave-runtime/src/compose.rs` (`apply_integrations_filter`, `apply_worker_auth_tokens_in`)
- **Decision-map skill** — `containers/claude-resources/skills/integrations/office/SKILL.md`, gated per-integration by `containers/entrypoint.sh` via `ENABLED_SERVICES` + the `~/.claude/.speedwave-managed-links` state file

## Rejected alternatives

- **A skill in `Containerfile.claude`** (libraries + `claude-resources/`) — puts the malware-bearing parser in Claude's own container and the large image on every machine.
- **Wrap an upstream MCP server** — none is both mature and covers create/edit/convert/charts; the read-only and Windows-only options fail the ADR-053 wrap gate.
- **A plugin (sibling repo)** — this is a core capability users requested, not an optional add-on; a plugin means coordinating two repositories and slower iteration.
- **Keep the prior container-to-container PDF workaround** — fragile (depends on a private container IP), expensive (large base64 through the model context), and opens an unauthenticated path bypassing the hub.
- **`docling`/OCR in v1** — YAGNI: large ML models, and `readDocument` covers the structured-text case.
- **SheetJS on the write path** — the SheetJS Community Edition writes no cell styles or charts, so writes stay on `openpyxl`.
- **`mcp-office` on the shared network with only application-level fetch restrictions** — a network-level egress block is stronger and cheaper than auditing every tool for remote-fetch paths; the application restrictions remain as defense in depth.
