# `@speedwave/mcp-office`

Built-in MCP worker for office documents — read/write/create/edit Word, Excel, PowerPoint; generate PDF (Markdown/HTML → PDF, Office → PDF); manipulate PDF (merge/split/rotate/watermark/forms); convert Office ↔ Office (LibreOffice headless); render charts (matplotlib).

A **pure file processor**: no service credentials, no `/tokens` mount, **no network egress** (compose attaches it to an `internal: true` network), only `/workspace:rw` mounted, behind a hard path policy. Architecture and the normative tool/DSL contract: [`docs/adr/ADR-055-built-in-office-document-worker.md`](../../docs/adr/ADR-055-built-in-office-document-worker.md). User-facing reference: the Integrations section of https://speedwave.dev/docs.

## Layout

- `src/index.ts` — `createMCPServer` entry point (fails fast without `MCP_OFFICE_AUTH_TOKEN`).
- `src/tools/index.ts` — the ~25 tool definitions and handlers.
- `src/engine/` — `extract.ts` (→ Markdown), `convert.ts` (Markdown/HTML → PDF/DOCX/PPTX, Office → PDF, Office ↔ Office), `pdf-ops.ts` (merge/split/rotate/watermark/forms/metadata), `chart.ts` (chart spec → image), `office-build.ts` (DSL → DOCX/XLSX/PPTX).
- `src/path-policy.ts` — `/workspace` confinement, symlink guard, atomic writes, `overwrite:false` default, default output dir `/workspace/.speedwave/office/`.
- `src/subprocess.ts` — hardened `spawn` (timeout/SIGKILL, bounded stdout/stderr) + `runPythonScript`.
- `src/lo-queue.ts` — serializes all `soffice` invocations (LibreOffice headless is not reentrant).
- `scripts/*.py` — Python support-scripts run in the venv at `/opt/office-venv`: `docx_build.py`, `xlsx_build.py`, `pptx_build.py`, `pdf_ops.py`, `render_chart.py`, `python_docx_extract.py`; helpers `markdown_utils.py`, `script_runner.py` (the stdout-JSON / exit-code convention); tests `test_helpers.py`, `test_scripts.py`.
- `Dockerfile` — multi-stage: alpine builder for the TS, Debian runtime with `libreoffice-writer/calc/impress`, `poppler-utils`, `pandoc`, the Python venv (markitdown, python-docx, openpyxl, python-pptx, pypdf, matplotlib, weasyprint), and fonts.

## Tests

- TypeScript: `npm test` (vitest; coverage thresholds 100/100/90/100). Run from `mcp-servers/` as part of `make test-mcp`.
- Python: `make test-mcp-office-py` (builds a venv from `requirements.txt` + pytest, runs `scripts/`), or — if the worker's Python deps are already on PATH — `npm run test:py`. `test_helpers.py` (the dependency-free `script_runner`/`markdown_utils` helpers) runs anywhere; `test_scripts.py` (the library-driven scripts) self-skips when the deps are absent, and the matplotlib-render cases self-skip on too-new Python interpreters.
