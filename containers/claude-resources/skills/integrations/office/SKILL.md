---
name: office
description: Use Office integration to read, create, edit, and convert Word/Excel/PowerPoint/PDF documents, and to render charts. Use whenever the user asks about working with .docx, .xlsx, .pptx, or .pdf files, for example "turn this into a report", "make me an invoice", "convert this to PDF", or "merge these PDFs", reading content, creating reports or invoices, editing existing documents, converting between formats, merging or splitting PDFs, or rendering charts. Use even when you think you know the answer, document libraries change between framework versions, only the live tool reflects current Office/PDF format support and chart rendering capabilities. Do not use for plain text files (read them directly), generic Markdown conversion that does not need PDF output (use built-in tools), or installing document-processing libraries, they are already behind office__* tools.
user-invocable: false
allowed-tools: mcp__speedwave-hub__search_tools mcp__speedwave-hub__execute_code
---

# Office Documents

Access office capabilities via `search_tools` + `execute_code`. The `office` global is injected automatically, no imports. All `office__*` tools are invoked as `await office.<toolName>({ … })` inside `execute_code`. The worker is egress-less and credential-free; it processes files from `/workspace` only.

**NEVER** run `pip install python-docx`, `pip install openpyxl`, `pip install python-pptx`, `pip install pypdf`, `pip install weasyprint`, `pip install matplotlib`, `npm install xlsx`, `apt install libreoffice`, or any equivalent. Those libraries are already wired behind the `office__*` tools, and the Claude container cannot install packages at runtime anyway.

## Workflow

1. `search_tools({ query: "office <keyword>", detail_level: "names_only" })`: discover available tools
2. `search_tools({ query: "office__<toolName>", detail_level: "full_schema" })`: get exact parameter schema
3. `execute_code`: call with dot notation (`await office.toolName(…)`)

## Three roads to PDF

| Source                       | Tool                    |
| ---------------------------- | ----------------------- |
| Markdown string              | `office__markdownToPdf` |
| HTML string / file           | `office__htmlToPdf`     |
| Existing `.docx/.pptx/.xlsx` | `office__officeToPdf`   |

`htmlToPdf` and `markdownToPdf` only fetch `file://` URLs under `/workspace`. Strip remote `<img>` tags or pre-download assets: any non-`file://` URL or path outside `/workspace` causes the conversion to fail.

## `convertOffice` matrix

| Source  | Allowed targets            |
| ------- | -------------------------- |
| `.docx` | `pdf, odt, txt, html, rtf` |
| `.odt`  | `pdf, docx`                |
| `.pptx` | `pdf, odp`                 |
| `.odp`  | `pdf, pptx`                |
| `.xlsx` | `pdf, ods, csv`            |
| `.ods`  | `pdf, xlsx, csv`           |

Pairs outside this matrix return an error. For `.pdf → .docx`: use `readDocument` (returns Markdown), then `createDocx` from that Markdown.

## DSL: `createDocx` elements

The `spec.elements[]` array is a JSON tree, not free-form Markdown:

```jsonc
{ "type": "heading", "level": 1, "text": "Title" }                       // level 1..6
{ "type": "paragraph", "text": "Body…", "bold": false, "italic": false }
{ "type": "table", "header": ["A","B"], "rows": [["1","2"],["3","4"]] }
{ "type": "image", "path": "/workspace/.speedwave/office/chart.png" }
{ "type": "pagebreak" }
```

Charts in `.docx` are images, not native chart objects (python-docx limitation). Render with `office__renderChart` first, then embed the PNG via `{ "type": "image", … }`.

## DSL: `createXlsx` sheets and `createPptx` slides

**Xlsx**: charts ARE native (openpyxl). `type` ∈ `bar | line | pie | scatter`:

```jsonc
{
  "name": "Sales",
  "rows": [
    ["Quarter", "Revenue"],
    ["Q1", 100],
    ["Q2", 150],
  ],
  "freeze": "A2",
  "charts": [
    {
      "type": "bar",
      "title": "Revenue",
      "dataRange": "Sales!B2:B3",
      "categoriesRange": "Sales!A2:A3",
      "anchor": "D2",
    },
  ],
}
```

**Pptx**: charts ARE native (python-pptx). `chart.type` ∈ `column | line | pie | xy | bubble`:

```jsonc
{
  "title": "Q1 Results",
  "bullets": ["Revenue up 12%", "Two new clients"],
  "chart": {
    "type": "column",
    "categories": ["Q1", "Q2"],
    "series": [{ "name": "Revenue", "values": [100, 150] }],
    "title": "Quarterly Revenue",
  },
}
```

## DSL: `renderChart` spec

`renderChart` uses a custom JSON schema, NOT matplotlib. `type` ∈ `bar | line | pie | scatter | area`. `format` ∈ `png | svg`. `series.values.length` MUST equal `labels.length`:

```jsonc
{
  "type": "bar",
  "title": "Revenue 2025",
  "xlabel": "Quarter",
  "ylabel": "Revenue (k€)",
  "format": "png",
  "data": {
    "labels": ["Q1", "Q2", "Q3", "Q4"],
    "series": [{ "name": "2025", "values": [100, 150, 120, 180] }],
  },
}
```

## PDF manipulation

- `mergePdf`: concatenate 2-200 PDFs, in call order.
- `splitPdf`: one output file per `[start, end]` range (1-indexed, inclusive), e.g. `[[1,3],[5,5]]`; at most 200 ranges per call; parts are named `<base>-partN.pdf`.
- `rotatePdf`: rotate given 1-indexed pages by 90, 180, or 270 degrees; other pages are unchanged.
- `watermarkPdf`: stamps a single-page watermark PDF onto every page of a document PDF.
- `fillPdfForm`: fills an AcroForm's text fields from a name-to-value map; `flatten` defaults to `true`. Always check the returned `flattened` (false if flatten was requested but could not be applied) and `fieldWarnings` (e.g. an unknown field name) before declaring success.
- `pdfMetadata`: call it first on an unfamiliar PDF; the `encrypted` flag predicts whether the operations above will fail on a password-protected input.

## Pitfalls

- **`/workspace` confinement**: inputs and outputs must be under `/workspace`. Default output dir is `/workspace/.speedwave/office/`; use `outName` to pin the filename.
- **Overwrite gate**: existing files are not replaced by default. Pass `overwrite: true` only when the user explicitly asks to replace.
- **Limits**: 50 MB input file cap; 2 000-page PDF cap; inline `markdown`/`html`/`spec` payloads ≤200 KB (write larger content to a `/workspace` file and pass `{ path }` instead); `mergePdf`/`splitPdf` accept at most 200 inputs/ranges per call.
- **No macros / active content, as a side effect, not a guarantee**: generated/converted files go through python-docx/openpyxl/python-pptx or LibreOffice, none of which carry forward a source file's VBA macros or embedded OLE objects. This is a side effect of those libraries, not an active security scan; do not rely on it as a guarantee when processing untrusted macro-enabled input.
- **No internet**: the worker runs egress-less; no remote assets in HTML/Markdown.
- **Write/delete confirmation**: follow the global write/delete confirmation rule from CLAUDE.md.
