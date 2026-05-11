# ADR-055: Built-in `office` MCP Worker — Word / Excel / PowerPoint / PDF Read · Write · Convert · Charts

**Status:** Accepted

**Date:** 2026-05-11

## Context

Speedwave has no built-in support for office documents. `containers/Containerfile.claude` installs only bash/git/curl plus Claude Code;[^1] none of the nine built-in workers (`slack`, `sharepoint`, `redmine`, `gitlab`, `github`, `atlassian`, `playwright`, `os`, `hub`) reads, writes, or converts `.docx`/`.xlsx`/`.pptx`/`.pdf`. The only code in the ecosystem that does is the `presale` plugin in the sibling `speedwave-plugins` repository — extraction-only (documents → Markdown), built on a multi-engine fallback chain (`markitdown[docx,pptx,xlsx,pdf]`, `pdftotext`, `pandoc`, `openpyxl`, `python-docx`, `docling` with pre-downloaded layout/tableformer models), with a `mem_limit` of `12g` for the ML pipeline.[^2]

With no tool for the job, Claude (running in the token-free container) improvises. A documented user experiment to turn Markdown into a PDF: stand up an ad-hoc HTTP server inside the Claude container (`node /tmp/serve.js`, port 8765, bind `0.0.0.0`); discover that `localhost` and `host.docker.internal` do not resolve to the Claude container from the Playwright container, but the Claude container's private compose-network IP (from `hostname -I`) is reachable; have the Playwright worker `page.goto()` an HTML page and call `page.pdf()` (which returns a `Buffer` in the Playwright container's memory);[^3] from inside the Chromium page context, `fetch()` that ~270 KB PDF as base64 back to the ad-hoc server, which writes it to `/workspace`. It works, but it is fragile (depends on a private container IP being reachable on whatever compose network is in play), expensive (the alternative is returning ~270 KB of base64 through the model's context window), and it opens an unauthenticated container-to-container path that bypasses the hub — contradicting the isolation model in `.claude/rules/security.md` (the hub is the only MCP server Claude sees; workers talk to the hub, not to each other).[^4] Separately, a user has explicitly asked for chart generation, which no current tool provides.

How Speedwave registers a built-in worker (established by reading `git diff 4e6e900^..4e6e900`, the commit that added the Atlassian worker — the full, exact wiring surface): services are **statically defined in `containers/compose.template.yml`** and merely _filtered_ by `compose::apply_integrations_filter` (a disabled service's container is removed from the rendered compose; it is not generated).[^5] `crates/speedwave-runtime/src/consts.rs::TOGGLEABLE_MCP_SERVICES` is the SSOT for service metadata (`config_key`, `compose_name`, `worker_env`, `display_name`, `description`, `auth_fields`, `credential_files`, `badge`). A per-worker Bearer token (`MCP_<SERVICE>_AUTH_TOKEN`) is generated and injected automatically by `compose::apply_worker_auth_tokens` for every enabled toggleable service (stored at `~/.speedwave/secrets/<project>/<service>-auth-token`, mounted into the hub as `/secrets/<service>-auth-token:ro`); the worker's `index.ts` must **fail fast** (`process.exit(1)`) when that env var is absent, as `mcp-servers/atlassian/src/index.ts` does. The hub discovers workers dynamically by the `WORKER_<SERVICE>_URL` env var (`mcp-servers/hub/src/tool-discovery.ts`) — no hub changes are needed to add a worker. The `os` service is the precedent for a toggleable service with no credentials (`auth_fields: &[]`): `desktop/src-tauri/src/types.rs::get_allowed_fields("os")` returns no fields and the integrations UI handles it (enabled without a credential form).

The trigger is a recurring user request for built-in Office/PDF handling — read, edit, create, convert, charts, in both directions.

## Decision

**Add a built-in MCP worker `office`** (compose name `mcp-office`, hub env `WORKER_OFFICE_URL`), built as an **own thin TypeScript worker** on `@speedwave/mcp-shared`'s `createMCPServer` plus **Python/CLI support-scripts invoked via `spawn`** — the hybrid pattern `presale` already uses (TypeScript worker, Python helpers behind `spawn`), and the registration pattern `mcp-servers/github/` and `mcp-servers/atlassian/` use (per ADR-053). It carries **no service credentials** (no `/tokens` mount — it is a pure file processor) but does receive the standard internal Bearer token and fails fast without it. It runs with **no network egress** (a dedicated `internal: true` compose network — see "Security contract"). Its only mount is the project workspace at `/workspace:rw`, behind a hard path policy.

### Built-in worker, not a skill

"Skill" here means the _implementation_ — shipping the libraries (`markitdown`, `weasyprint`, `python-docx`, …) inside `Containerfile.claude` plus `claude-resources/skills/` instructions, and letting Claude write and run the processing code in its own container. (Not to be confused with the `office` _decision-map_ skill — a `SKILL.md` that tells Claude which `office__*` tool to call — which this design does ship; see "Discoverability" below.) The implementation-as-skill option is rejected, for five reasons (ordered by weight):

- **(a) Isolation.** Office and PDF parsers are a classic malware-bearing surface — historically a large source of CVEs in `pdfminer`, `lxml` (used by `python-pptx`), `poppler`, and LibreOffice's import filters.[^6][^7][^8] In a separate worker (`cap_drop: ALL`, `read_only`, no tokens, no egress, only `/workspace` mounted) an exploited parser is confined to `/workspace`; the Claude container — which holds `~/.claude`, the IDE bridge, and the conversation history — is untouched. This is exactly the "a compromised worker exposes only that service's surface" model in `.claude/rules/security.md`. A skill puts the parser in Claude's own container.
- **(b) Image size.** LibreOffice headless plus `markitdown`, `matplotlib`, and the Office/PDF libraries is roughly 700 MB–1 GB.[^9][^10] Inside `Containerfile.claude` that weight is on _every_ machine and _every_ project, whether or not anyone touches documents. As a worker it builds once and starts only when `office` is enabled per-project.
- **(c) Deterministic contract.** A worker exposes named tools with fixed schemas; a skill leaves the result to whatever code Claude writes this time — the Playwright-bridge experiment is the live example of that improvisation. A `markdownToPdf(input) → { path }` call is reproducible, tested in the same commit (a repo requirement), and does not spend context on glue.
- **(d) Consistency.** Nine workers already use this pattern; the hub, tool discovery, `WORKER_*_URL`, and the `_meta` policy (ADR-036) exist. A skill that ships heavy native dependencies in Claude's container is a new, unused pattern.
- **(e) Per-project toggle.** A worker is gated by `ENABLED_SERVICES` for free; a skill baked into `Containerfile.claude` is always present.

KISS ("prefer existing tools over reimplementing", `.claude/rules/engineering-principles.md`) pulls toward a skill — but `markitdown`/`pandoc`/LibreOffice/`weasyprint` _are_ the existing tools here; the worker is ~40 tool definitions mapping onto those CLIs, i.e. glue, not a reimplementation. So KISS is neutral, and isolation decides.

A **plugin** (sibling repo) is rejected because this is a core capability users are asking for, not an optional add-on; a plugin would mean coordinating two repositories and slower iteration.

### Own thin worker, not wrapping an upstream MCP server (ADR-053 gate)

Upstream MCP servers exist — `microsoft/markitdown-mcp`,[^10] `GongRzhe/Office-Word-MCP-Server`,[^11] `dvejsada/mcp-ms-office-documents`,[^12] `jenstangen1/pptx-xlsx-mcp`[^13] — but the four-point wrap gate from ADR-053 is not met: (a) `markitdown-mcp` covers **read only** (file → Markdown) — not create/edit, not PDF generation, not Office↔Office conversion, not charts — so "an official MCP server that is mature and covers the need" fails;[^10] (b) `pptx-xlsx-mcp` drives Office via `pywin32` COM automation — Windows-only, useless in a Linux container;[^13] (c) the rest are single-maintainer community projects; (d) the "generic infrastructure, not a domain integration" condition is borderline for document processing, but the absence of any single mature upstream covering the full scope settles it toward an own thin worker that glues mature **libraries/CLIs** — `markitdown`,[^10] `pandoc`,[^14] LibreOffice headless,[^9] `weasyprint`,[^15] `pypdf`,[^16] `python-docx`/`openpyxl`/`python-pptx`,[^18][^19][^20] `matplotlib`,[^21] SheetJS.[^22] The wheel we are not reinventing is the document toolchain; we reinvent only the tool definitions and glue.

### Full scope in v1 — with the DSL frozen here

The product decision is to ship the full scope at once (read, write, create, convert in both directions, PDF manipulation, Office→PDF, charts) rather than a smaller slice. The condition attached to that decision: the `spec`/`ops` JSON DSL and the `convertOffice` matrix are **enumerated normatively in this ADR, below, before implementation** — not "to be refined during implementation". Anything outside the DSL or the matrix is a tool error, not best-effort behavior.

#### Tools (camelCase, no service prefix — repo convention)

I/O contract: input is a `/workspace` **path by preference**; inline `markdown`/`html`/`spec` is accepted only when ≤ ~200 KB (the `@speedwave/mcp-shared` Express body limit is `1mb` — `mcp-servers/shared/src/server.ts`; the worker raises it to `4mb` via `createMCPServer` options if that override exists, otherwise path-only for large inputs). Output is **always a file** under `/workspace/.speedwave-office/` (the default output directory — not the repo root, so an exploited parser cannot overwrite `.git`/`.speedwave.json`/scripts), returned as `{ path, bytes, format, preview, truncated }` where `preview` is the first `maxChars` (default 4000) of a text rendering. `readDocument` returns `{ markdown, bytes, truncated }` with the same `maxChars` — never the whole large document into context.

**Read → Markdown**

- `readDocument(path, maxChars?=4000)` → `{ markdown, bytes, truncated }`. Multi-engine, best-output-wins: SheetJS for `.xlsx`/`.xls`/`.xlsb`/`.ods` (native TypeScript, no subprocess, reads the legacy formats `markitdown` does not — `XLSX.utils.sheet_to_csv`/`sheet_to_html` → Markdown tables);[^22] `markitdown` as primary for `.docx`/`.pptx`/`.pdf`;[^10] `pdftotext -layout`/`pandoc`/`python-docx` as fallback. Extraction engine ported from `presale` (`src/extraction/`, `scripts/python_docx_extract.py`, `scripts/markdown_utils.py`).[^2] No `docling`/OCR in v1 (the ML models add ~500 MB).[^2]
- `readPdfText(path, maxChars?=4000)` → `{ text, bytes, truncated }` (`pdftotext -layout`).
- `pdfMetadata(path)` → `{ pages, title, author, producer, encrypted, … }` (`pypdf`).[^16]

**Markdown/HTML → document**

- `markdownToDocx(input, outName?)` — `pandoc`. `input` = `{ path }` | `{ markdown }`.
- `markdownToPptx(input, outName?)` — `pandoc` (the `pptx` output writer).[^14]
- `htmlToPdf(input, outName?, opts?)` — `weasyprint`. `input` = `{ path }` | `{ html }`. `opts` = `{ pageSize?='A4', margin?='18mm', landscape?=false }`. The `url_fetcher` is restricted to `file://` under `/workspace` (defense in depth on top of the network-level egress block).[^15] Renders `<img>` PNG/SVG, i.e. charts from `renderChart`. This replaces the Playwright-bridge route.
- `markdownToPdf(input, outName?, opts?)` — `pandoc` → standalone HTML (print CSS: `@page`, page size, margins, monospace code blocks) → `weasyprint`. No LaTeX.

**Charts** (`matplotlib`, `Agg` backend — headless; `MPLCONFIGDIR=/tmp/mpl`)[^21]

- `renderChart(spec, outName?)` — via `python3 scripts/render_chart.py`. Normative `spec`:
  ```
  { "type": "bar"|"line"|"pie"|"scatter"|"area",
    "title": string?, "xlabel": string?, "ylabel": string?,
    "format": "png"|"svg" (default "png"), "width": number? (inches, default 8), "height": number? (default 5),
    "data": { "labels": string[],                                   // X axis / categories
              "series": [ { "name": string, "values": number[] } ] } }   // ≥1 series; values.length === labels.length
  ```
  Validation: `series` non-empty; each `values.length === labels.length`; `type` from the list. Anything else is an error. The image embeds into a PDF (`<img>` via `htmlToPdf`), a `.docx` (`add_picture`), or a `.pptx` (`slides[].image`).
- Native chart objects _inside_ Office files come from the `charts`/`chart` keys in the `create*`/`edit*` DSL below, not a separate tool.

**Create / edit Office — `spec`/`ops` DSL (normative)**

- `createDocx(spec, outName?)`, `editDocx(path, ops[], outName?)` — `python-docx`, `python3 scripts/docx_build.py`.[^18]
  - `spec` = `{ "elements": Element[] }`; `Element` is one of:
    - `{ "type":"heading", "level":1..6, "text":string }`
    - `{ "type":"paragraph", "text":string, "bold"?:bool, "italic"?:bool }`
    - `{ "type":"table", "header":string[], "rows":string[][] }`
    - `{ "type":"image", "path":string }` (under `/workspace`; this is where a `renderChart` image goes)
    - `{ "type":"pagebreak" }`
  - `ops[]` = `{ "op":"append", "element":Element }` | `{ "op":"replace_text", "find":string, "replace":string }` | `{ "op":"delete_paragraph", "index":number }`.
  - `python-docx` has no native chart objects;[^18] a chart in a `.docx` is an image (`renderChart` + an `image` element).
- `createXlsx(spec, outName?)`, `editXlsx(path, ops[], outName?)` — `openpyxl`, `python3 scripts/xlsx_build.py`.[^19] (Write path is `openpyxl`, not SheetJS: the SheetJS Community Edition does not write cell styles or charts;[^22] SheetJS is read-path only. The asymmetry is licensing- and performance-driven.)
  - `spec` = `{ "sheets": [ { "name":string, "rows":(string|number|null)[][], "freeze"?:string ("A2"),
"charts"?: [ { "type":"bar"|"line"|"pie"|"scatter", "title"?:string,
  "dataRange":string ("Sheet1!B1:B10"), "categoriesRange"?:string, "anchor":string ("E2") } ] } ] }`
  - `ops[]` = `{ "op":"set_cell", "sheet":string, "cell":string, "value":string|number|null }` | `{ "op":"set_formula", "sheet":string, "cell":string, "formula":string }` | `{ "op":"add_sheet", "name":string }` | `{ "op":"add_chart", "sheet":string, "chart":<chart object as above> }`.
- `createPptx(spec, outName?)`, `editPptx(path, ops[], outName?)` — `python-pptx`, `python3 scripts/pptx_build.py`.[^20]
  - `spec` = `{ "slides": Slide[] }`; `Slide` = `{ "title"?:string, "bullets"?:string[],
"image"?:{ "path":string }, "chart"?:{ "type":"column"|"line"|"pie"|"xy"|"bubble", "categories":string[], "series":[{ "name":string, "values":number[] }], "title"?:string } }`
  - `ops[]` = `{ "op":"add_slide", "slide":Slide }` | `{ "op":"set_title", "index":number, "text":string }` | `{ "op":"delete_slide", "index":number }`.

**Office → PDF and Office ↔ Office** (LibreOffice headless)[^9]

- `officeToPdf(path, outName?)` — `.docx`/`.xlsx`/`.pptx` → PDF (a real render).
- `convertOffice(path, target, outName?)` — `target` from this **normative matrix** (anything outside it is an error):
  - `.docx` → `pdf`, `odt`, `txt`, `html`, `rtf`
  - `.odt` → `pdf`, `docx`
  - `.pptx` → `pdf`, `odp`
  - `.odp` → `pdf`, `pptx`
  - `.xlsx` → `pdf`, `ods`, `csv`
  - `.ods` → `pdf`, `xlsx`, `csv`
  - (Full N×N is excluded — e.g. `xlsx→docx` is lossy and not useful; documented in the integrations guide.)
- LibreOffice operational design (not just `HOME`): each invocation gets its own profile (`-env:UserInstallation=file:///tmp/lo-<uuid>`) because LibreOffice does not tolerate concurrent instances on one profile;[^23] all `soffice` invocations are serialized by an in-worker mutex/queue because `soffice --headless` is not reentrant;[^23] flags `--headless --norestore --nologo --nofirststartwizard --convert-to <fmt> --outdir <tmp> <in>`; macros are not enabled (no `--script-provider`); fonts are installed in the image (`fonts-liberation`, `fonts-dejavu-core`) so PDFs do not render with tofu; `HOME=/tmp/lo`, `XDG_CACHE_HOME=/tmp`, `XDG_CONFIG_HOME=/tmp`; the output is copied from `/tmp` to `/workspace/.speedwave-office/` atomically. Concurrency is tested (two parallel `officeToPdf` calls → both succeed, no corruption). Container limits start at `mem_limit: 1g` and `tmpfs: /tmp:size=512m` (LibreOffice on a non-trivial `.pptx` can use 400–800 MB) and are tuned during verification.

**PDF manipulation** (`pypdf` — pure Python, light)[^16]

- `mergePdf(paths[], outName?)`; `splitPdf(path, ranges[], outName?)` (`ranges` = `[[1,3],[5,5]]`, 1-indexed; each range → a separate file); `rotatePdf(path, pages[], degrees, outName?)` (`degrees` ∈ {90,180,270}); `watermarkPdf(path, watermarkPath, outName?)` (watermark is a single-page PDF, stamped on every page); `fillPdfForm(path, fields:{name:value}, outName?)` (AcroForm; `flatten` defaults to `true`).

**Out of scope for v1 (deliberately):** `docling`/OCR (ML, ~500 MB);[^2] PDF→editable-`.docx` at full fidelity (`pdf2docx` is weak; `readDocument` → Markdown covers the real use case); full N×N conversion; interactive charts (Plotly/ECharts HTML); anything requiring egress.

### Discoverability — keywords, cross-referencing descriptions, and a decision-map skill

Tool selection across the ~25 tools rests on three layers:

1. **`_meta.keywords` + `_meta.deferLoading` (ADR-036)** inside the tool definitions — the hub shows only `readDocument` and `markdownToPdf` upfront; the rest are `deferLoading: true`, reached via `search_tools`, matched on `keywords` (broad enough to catch natural-language queries: `office`, `file`, `make`, `new`, `build`, `template`, `formatted`, `features`, `heading`, `paragraph`, `table`, `sheet`, `slide`, `deck`, …).
2. **Tool `description`s with cross-references** ("Use this for …" plus "For X instead use `Y`") that disambiguate the overlapping tools (three roads to PDF: `markdownToPdf` ← Markdown, `htmlToPdf` ← HTML, `officeToPdf` ← an existing Office file).
3. **A `claude-resources/skills/office/SKILL.md` decision-map skill.** v1 shipped without one; feedback showed that even with broad keywords Claude would still occasionally reach for `pip install python-docx` because it had not yet called `search_tools` with a matching query and so did not know `createDocx` existed. The skill — modelled on the existing `playwright-browser` skill, shipped via the core-resources path (`containers/claude-resources/` → `bundle::sync_claude_resources` → data dir → `:ro` mount → `entrypoint.sh` symlink, so no Rust/compose/entrypoint changes) — puts a task→tool table, the `create*`/`renderChart` DSL, the `convertOffice` matrix, and an explicit "**never** `pip install` / `apt install` / `npm install` — the libraries are already behind `office__*` and the Claude container can't install them anyway" guardrail into the system prompt from turn 1. The skill is unconditional (loaded for every project, like `playwright-browser`): Claude only activates it when the description's trigger phrases match the prompt, so for non-Office projects it sits idle. No `/office:*` commands — the skill plus the keyword/description layers cover tool selection without adding slash commands. (This is the "if feedback later shows Claude mis-selecting tools, an `office` skill can be added in a separate PR" revision condition the first cut of this ADR named.)

### Security contract

This is part of the decision, not an implementation detail:

1. **No egress — enforced at the network layer, not only in application code.** `mcp-office` is **not** on `${NETWORK_NAME}` (the bridge network with egress). A new network `${NETWORK_NAME}_office` is declared `internal: true` (no route to the gateway → no internet).[^24] `mcp-office` is attached only to it; `mcp-hub` is attached to both (`${NETWORK_NAME}` and `${NETWORK_NAME}_office`) so hub→worker discovery still works — and the hub needs no egress anyway (it holds zero tokens and talks only to workers and the Claude container). When `office` is disabled, `compose::apply_integrations_filter` removes `${NETWORK_NAME}_office` and the hub's attachment to it. Defense in depth in application code: `weasyprint`'s `url_fetcher` is restricted to `file://` under `/workspace`;[^15] `pandoc` is run without remote-resource fetching; LibreOffice runs offline (no updates, no extension downloads).
2. **Path policy.** `/workspace:rw` is a larger surface than "confined to `/workspace`" suggests. Every input and output path is: (a) canonicalized (`realpath`); (b) rejected if, after canonicalization, it is not under `/workspace/`; (c) rejected if any component is a symlink (`lstat`/`O_NOFOLLOW` — an exploit cannot plant a symlink to `.git`); (d) written atomically (write to `*.tmp` in the same directory, then `rename`); (e) refused if the target exists, unless `overwrite: true`; (f) defaulted to `/workspace/.speedwave-office/` (created if missing). The pattern mirrors `compose.rs`'s existing `check_*_workspace_path` guards, but is enforced in the worker because the worker is what touches the files.
3. **Limits (anti-DoS / anti-zip-bomb).** Per call: max input-file size (`50 MB` default, `OFFICE_MAX_INPUT_BYTES`); max PDF pages (`2000`); per-subprocess wall-time timeout (`60s` standard, `120s` for LibreOffice — `_meta.timeoutClass: 'long'`); container `mem_limit: 1g`; bounded subprocess stdout/stderr buffers (~10 MB — without this `pandoc`/LibreOffice can flood the worker's memory with log output). Exceeding any limit is a tool error with a clear message.
4. **No service credentials, but an internal Bearer.** No `/tokens` mount; `auth_fields: &[]` in `TOGGLEABLE_MCP_SERVICES`. The worker must fail fast (`process.exit(1)`) without `MCP_OFFICE_AUTH_TOKEN` (the `mcp-servers/atlassian/src/index.ts` pattern); `createMCPServer({ auth: { token: AUTH_TOKEN } })`.
5. **No macros / active content.** LibreOffice headless runs with no script provider; `python-docx`/`openpyxl`/`python-pptx` read XML and do not execute macros; OLE/macro payloads in a `.docx` are ignored by the structural parser. Documented.
6. **Container hardening (as every worker):** `read_only: true`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `user: ${CONTAINER_USER}`, `tmpfs: /tmp:noexec,nosuid,size=512m` (if LibreOffice headless requires `exec` on `/tmp`, a separate `tmpfs: /tmp/lo:size=512m` without `noexec` is mounted for the LibreOffice profile and `/tmp` stays `noexec`). No `EXPOSE`/`ports:` — `check_no_ports_on_workers` enforces this for built-in workers.

### Deliberate duplication with `presale`

`mcp-office`'s extraction engine is ported from `presale`'s; both repositories keep their own copy. By the Rule of Three (`.claude/rules/engineering-principles.md`) two occurrences is "note it, don't abstract it". If a third consumer appears, a separate effort extracts the engine into a shared library — which spans both repositories and therefore needs its own ADR and the coordination required by CLAUDE.md's "Breaking-change rule".

## Rejected alternatives

- **A — A skill in `Containerfile.claude` (libraries + `claude-resources/`).** Rejected: it puts the malware-bearing parser in Claude's own container (isolation), and it puts ~700 MB–1 GB on every machine and every project (image size). See "Built-in worker, not a skill".
- **B — Wrap `microsoft/markitdown-mcp`.** Rejected: it covers read only — no create/edit, no PDF generation, no Office↔Office, no charts — so the ADR-053 "mature and covers the need" condition fails.[^10]
- **C — A plugin (sibling repo) instead of a built-in worker.** Rejected: this is a core capability users are asking for, not an optional add-on; a plugin means coordinating two repositories and slower iteration.
- **D — Keep the Playwright-bridge route for PDF.** Rejected: fragile (depends on a private container IP being reachable on whatever compose network is in play), expensive (the alternative is ~270 KB of base64 through the model context), and it opens an unauthenticated container-to-container path bypassing the hub — contradicting the isolation model.[^4]
- **E — Include `docling`/OCR in v1.** Rejected: YAGNI — the ML models add ~500 MB, and `readDocument` via `markitdown` covers the structured-text case;[^2][^10] add OCR later if someone asks.
- **F — Use SheetJS on the write path as well as read.** Rejected: the SheetJS Community Edition does not write cell styles or charts;[^22] the write path stays on `openpyxl`.[^19]
- **G — Put `mcp-office` on the shared `${NETWORK_NAME}` and rely on application-level local-only fetching instead of an `internal: true` network.** Rejected: a network-level egress block is stronger and cheaper to maintain than auditing every tool (`weasyprint`, `pandoc`, LibreOffice) for remote-fetch paths; the application-level restrictions remain, as defense in depth.

## Consequences

**Positive.**

- The Playwright-bridge improvisation is no longer needed: "content → PDF in `/workspace`" is one `markdownToPdf`/`htmlToPdf` call, with no HTTP server in Claude's container, no private IP, no base64 through context.
- Full Office/PDF handling — read, write, create, convert in both directions, manipulate, charts — in one worker, with a deterministic tool contract.
- The malware-bearing parser runs in an isolated, token-free, egress-less container; a compromise is confined to `/workspace`.
- Consistent with the nine existing workers — hub, discovery, `WORKER_*_URL`, `_meta` policy all apply unchanged.

**Negative.**

- A large image (~700 MB–1 GB) — dominated by LibreOffice.[^9]
- The extraction engine is duplicated with `presale` until a third consumer justifies extracting it.
- LibreOffice headless adds startup latency (~1–2 s on the first conversion as the profile is created).
- More code and tests than wrapping would require — ~40 tool definitions plus their vitest/pytest coverage.
- SheetJS is distributed from `cdn.sheetjs.com`, not the public npm registry;[^22] the Containerfile pins the tarball with a SHA-256 check, and it is a line item for `make audit`.
- pip/apt versions are pinned and must be kept current via `make audit`.
- The `soffice` mutex serializes LibreOffice conversions — parallel `officeToPdf` calls queue.

**Neutral.**

- "KISS — prefer existing tools over reimplementing" pulls toward a skill, but `markitdown`/`pandoc`/LibreOffice/`weasyprint` _are_ the existing tools; the worker is glue (~40 tool definitions onto those CLIs), not a reimplementation. The decision turns on isolation, not on KISS.

## Sources

[^1]: `containers/Containerfile.claude` in this repository — installs `bash ca-certificates curl git tzdata wget`, the Claude Code binary, and OSC-52 clipboard wrappers; no document-processing tooling.

[^2]: `speedwave-plugins/presale/` (sibling repository) — `requirements.txt` (`markitdown[docx,pptx,xlsx,pdf]==0.1.5`, `openpyxl==3.1.5`, `python-docx==1.2.0`, `docling==2.84.0`), `Containerfile` (`python3`, `poppler-utils`, `pandoc`, `libgl1`, Python venv at `/opt/markitdown`, `docling-tools models download layout tableformer`, `mem_limit: 12g`), `src/extraction/subprocess.ts` (spawns `markitdown`/`pdftotext`/`pandoc`/`openpyxl`/`python-docx`/`docling`), `scripts/{docling_extract,python_docx_extract,openpyxl_extract,markdown_utils,test_extract_scripts}.py`.

[^3]: Playwright — `Page.pdf()` returns a `Buffer` and only works in headless Chromium: <https://playwright.dev/docs/api/class-page#page-pdf>

[^4]: `.claude/rules/security.md` and `CLAUDE.md` in this repository — "MCP Hub: port 4000, the ONLY MCP server Claude sees. Hub has zero tokens"; each MCP worker mounts only its own credentials; the hardened, token-free Claude container.

[^5]: `git diff 4e6e900^..4e6e900` in this repository — the commit adding the Atlassian built-in worker: `containers/compose.template.yml` (new `mcp-atlassian` service + `WORKER_ATLASSIAN_URL`), `crates/speedwave-runtime/src/{consts.rs (TOGGLEABLE_MCP_SERVICES + BUILT_IN_SERVICES + BUILT_IN_SERVICE_IDS), build.rs (IMAGE_MCP_ATLASSIAN + IMAGES), compose.rs, config.rs (IntegrationsConfig/ResolvedIntegrationsConfig/set_service/is_service_enabled/apply_integrations_layer), project.rs, fs_security.rs, log_sanitizer.rs}`, `desktop/src-tauri/src/{integrations_cmd.rs, types.rs}`, `scripts/bundle-build-context.{sh,ps1}`, `Makefile`, `mcp-servers/{package.json, vitest.workspace.ts, package-lock.json}`, `release-please-config.json`, `commitlint.config.js`, `docs/guides/integrations.md`; `mcp-servers/atlassian/src/index.ts` fails fast (`process.exit(1)`) without `MCP_ATLASSIAN_AUTH_TOKEN`.

[^6]: `pdfminer.six` security advisories — e.g. GHSA on infinite-loop / resource-exhaustion in PDF parsing: <https://github.com/pdfminer/pdfminer.six/security/advisories>

[^7]: `lxml` (used by `python-pptx`) security advisories — XML parsing vulnerabilities: <https://github.com/lxml/lxml/security/advisories>

[^8]: LibreOffice security advisories — import-filter vulnerabilities: <https://www.libreoffice.org/about-us/security/advisories/>

[^9]: LibreOffice — headless conversion via `soffice --headless --convert-to`: <https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html>

[^10]: `microsoft/markitdown` — Python utility converting files (PDF, Word, Excel, PowerPoint, images, …) to Markdown, available as a library, CLI, and `markitdown-mcp` MCP server: <https://github.com/microsoft/markitdown>; PyPI: <https://pypi.org/project/markitdown/>

[^11]: `GongRzhe/Office-Word-MCP-Server` — community MCP server for creating/reading/manipulating Word documents: <https://github.com/GongRzhe/Office-Word-MCP-Server>

[^12]: `dvejsada/mcp-ms-office-documents` — community MCP server generating pptx/docx/eml/xlsx: <https://github.com/dvejsada/mcp-ms-office-documents>

[^13]: `jenstangen1/pptx-xlsx-mcp` — community MCP server editing PowerPoint/Excel via `pywin32` COM automation (Windows-only): <https://github.com/jenstangen1/pptx-xlsx-mcp>

[^14]: Pandoc — universal document converter; supports a `pptx` output writer and HTML output: <https://pandoc.org/MANUAL.html>

[^15]: WeasyPrint — HTML/CSS → PDF; custom `url_fetcher` to restrict resource loading: <https://doc.courtbouillon.org/weasyprint/stable/api_reference.html#weasyprint.default_url_fetcher>

[^16]: pypdf — pure-Python PDF library (merge, split, rotate, stamp, forms): <https://pypdf.readthedocs.io/en/stable/>

[^18]: python-docx — create and update `.docx`; no native chart support: <https://python-docx.readthedocs.io/en/latest/>

[^19]: openpyxl — read/write `.xlsx`/`.xlsm` including charts (`BarChart`, `LineChart`, `PieChart`, `ScatterChart`) and styles: <https://openpyxl.readthedocs.io/en/stable/charts/introduction.html>

[^20]: python-pptx — create and update `.pptx` including native charts (`add_chart`, `CategoryChartData`): <https://python-pptx.readthedocs.io/en/latest/user/charts.html>

[^21]: Matplotlib — the `Agg` (non-interactive) backend for headless PNG/SVG rendering: <https://matplotlib.org/stable/users/explain/figure/backends.html>

[^22]: SheetJS Community Edition — `xlsx` library; reads `.xlsx`/`.xls`/`.xlsb`/`.ods`; distributed from the SheetJS CDN rather than the public npm registry; the CE does not write cell styles or charts: <https://docs.sheetjs.com/docs/getting-started/installation/nodejs>

[^23]: LibreOffice — `-env:UserInstallation` selects a per-process user profile; concurrent headless instances on one profile are not supported (the canonical workaround for parallel conversions): <https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html>

[^24]: Compose / nerdctl — an `internal: true` network has no gateway route, so containers attached only to it have no outbound internet access: <https://docs.docker.com/reference/compose-file/networks/#internal>
