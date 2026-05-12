---
name: office
description: Read, write, create, edit, and convert Word/Excel/PowerPoint/PDF documents; render charts. Triggers on "create word", "stwórz worda", "make a docx", "edit document", "spreadsheet with chart", "presentation", "stwórz prezentację", "convert to pdf", "merge pdf", "render chart", "office file", "report", "invoice".
user-invocable: false
model: sonnet
---

# Office Documents

You have the `office` MCP service for every Office/PDF task. **NEVER** run `pip install python-docx`, `pip install openpyxl`, `pip install python-pptx`, `pip install pypdf`, `pip install weasyprint`, `pip install matplotlib`, `npm install xlsx`, `apt install libreoffice`, or any equivalent — those libraries are already wired behind the `office__*` tools. Installing them in your own container is wasted work, and the parser would run there unsandboxed (no `cap_drop`, no `read_only`); the `office` worker runs it in a hardened, egress-less container instead. Use the tools.

If a tool in the table below fits the task, use it. Otherwise call the hub's `search_tools` meta-tool once with the task keywords (e.g. `search_tools({ query: "office watermark", detail_level: "with_descriptions" })`) — `search_tools` has no service prefix. Do not improvise with `Bash`.

All `office__*` tools run through the hub's `execute_code` meta-tool, where the calling convention is dot notation: `await office.createDocx({ spec: { … }, outName: "…" })`. The DSL sections below give the exact shapes; the workflow sections show full `execute_code`-ready calls.

## Decision table: task → tool

| The user wants…                                  | Use                                                               |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| Read a .docx / .pptx / .xlsx / .pdf as Markdown  | `office__readDocument` (returns `{ markdown, bytes, truncated }`) |
| Plain text from a PDF                            | `office__readPdfText`                                             |
| PDF metadata (pages, author, encryption flag)    | `office__pdfMetadata`                                             |
| Create a new .docx from scratch (rich content)   | `office__createDocx` with a `spec` (see DSL below)                |
| Edit an existing .docx                           | `office__editDocx` with `ops`                                     |
| Quick Markdown → .docx (no styling)              | `office__markdownToDocx`                                          |
| Create a new .xlsx with sheets / charts          | `office__createXlsx` with a `spec`                                |
| Edit an existing .xlsx                           | `office__editXlsx` with `ops`                                     |
| Create a new .pptx with slides / charts          | `office__createPptx` with a `spec`                                |
| Edit an existing .pptx                           | `office__editPptx` with `ops`                                     |
| Quick Markdown → .pptx (no styling)              | `office__markdownToPptx`                                          |
| Render a chart as PNG/SVG (to embed elsewhere)   | `office__renderChart`                                             |
| Markdown → PDF                                   | `office__markdownToPdf`                                           |
| HTML → PDF                                       | `office__htmlToPdf`                                               |
| .docx / .pptx / .xlsx → PDF                      | `office__officeToPdf`                                             |
| Convert between Office formats (e.g. .docx→.odt) | `office__convertOffice` (see matrix below)                        |
| Merge several PDFs into one                      | `office__mergePdf`                                                |
| Split a PDF by page ranges                       | `office__splitPdf`                                                |
| Rotate PDF pages                                 | `office__rotatePdf`                                               |
| Add a watermark to a PDF                         | `office__watermarkPdf`                                            |
| Fill a PDF AcroForm                              | `office__fillPdfForm`                                             |

## Key rules

1. **All inputs and outputs live under `/workspace`.** The worker rejects anything outside it. Default output dir is `/workspace/.speedwave-office/` — you can specify `outName` to pin the filename inside that dir, or pass a path under `/workspace/...` to put it elsewhere.

2. **Existing files are not overwritten by default.** Pass `overwrite: true` if the user explicitly asks to replace. A `.tmp-<uuid>` sibling left behind means a previous run crashed mid-write — safe to delete.

3. **Charts in docx are images, not native chart objects** (python-docx limitation). Workflow for a Word report with a chart:
   - `office__renderChart` → PNG under `/workspace/.speedwave-office/`
   - `office__createDocx` with `{ type: "image", path: "<png-path>" }` in `elements`.

4. **Charts in xlsx and pptx ARE native, editable** (openpyxl / python-pptx). Use the `charts` field in `createXlsx` `spec.sheets[].charts` or the `chart` field in `createPptx` `spec.slides[].chart`.

5. **`readDocument` truncates by default** (`maxChars: 4000`). For a long doc, raise it explicitly when you need the full text — but prefer summarizing as you read.

6. **No remote resources in HTML.** `htmlToPdf` and `markdownToPdf` only fetch `file://` URLs under `/workspace`. An `<img src="https://...">` (or any non-`file://` URL, or a `file://` outside `/workspace`) makes the conversion **fail with an error** — strip remote `<img>` tags, or pre-download the assets into `/workspace` and reference them by path.

7. **PDF → editable .docx is not supported** (no reliable open-source converter). Use `readDocument` on the PDF to get Markdown, then `createDocx` from that Markdown.

## DSL: `createDocx` `spec.elements[]`

Each element is one of:

```jsonc
{ "type": "heading", "level": 1, "text": "Title" }                       // level 1..6
{ "type": "paragraph", "text": "Body…", "bold": false, "italic": false } // bold/italic optional
{ "type": "table", "header": ["A","B"], "rows": [["1","2"],["3","4"]] }
{ "type": "image", "path": "/workspace/.speedwave-office/chart.png" }
{ "type": "pagebreak" }
```

## DSL: `createXlsx` `spec.sheets[]`

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
      "title": "Quarterly Revenue",
      "dataRange": "Sales!B2:B3",
      "categoriesRange": "Sales!A2:A3",
      "anchor": "D2",
    },
  ],
}
```

`type` ∈ `bar | line | pie | scatter`. `dataRange`/`categoriesRange` use `Sheet!A1:Z9` notation.

## DSL: `createPptx` `spec.slides[]`

```jsonc
{
  "title": "Q1 Results",
  "bullets": ["Revenue up 12%", "Two new clients"],
  "image": { "path": "/workspace/.speedwave-office/chart.png" },
  "chart": {
    "type": "column",
    "categories": ["Q1", "Q2"],
    "series": [{ "name": "Revenue", "values": [100, 150] }],
    "title": "Quarterly Revenue",
  },
}
```

`chart.type` ∈ `column | line | pie | xy | bubble`.

## DSL: edit ops (`editDocx` / `editXlsx` / `editPptx` `ops[]`)

Each `ops` entry has an `op` discriminator. Indices are 0-based.

**`editDocx`** — operates on paragraphs (the `element` of an `append` op is a `createDocx` element from above):

```jsonc
[
  { "op": "append", "element": { "type": "heading", "level": 2, "text": "New section" } },
  { "op": "replace_text", "find": "DRAFT", "replace": "FINAL" }, // all occurrences
  { "op": "delete_paragraph", "index": 3 }, // 0-based
]
```

**`editXlsx`** — operates on sheets/cells (the `chart` of an `add_chart` op is a `createXlsx` chart from above):

```jsonc
[
  { "op": "set_cell", "sheet": "Sales", "cell": "B5", "value": 200 },
  { "op": "set_formula", "sheet": "Sales", "cell": "B6", "formula": "=SUM(B2:B5)" },
  { "op": "add_sheet", "name": "Summary" },
  {
    "op": "add_chart",
    "sheet": "Sales",
    "chart": { "type": "line", "dataRange": "Sales!B2:B6", "anchor": "E2" },
  },
]
```

**`editPptx`** — operates on slides (the `slide` of an `add_slide` op is a `createPptx` slide from above):

```jsonc
[
  { "op": "add_slide", "slide": { "title": "Appendix", "bullets": ["Source data"] } },
  { "op": "set_title", "index": 0, "text": "Q1 2025 Results" }, // 0-based
  { "op": "delete_slide", "index": 4 }, // 0-based
]
```

## DSL: `renderChart` `spec`

```jsonc
{
  "type": "bar",
  "title": "Quarterly Revenue",
  "xlabel": "Quarter",
  "ylabel": "Revenue (k€)",
  "format": "png",
  "data": {
    "labels": ["Q1", "Q2", "Q3", "Q4"],
    "series": [{ "name": "2025", "values": [100, 150, 120, 180] }],
  },
}
```

`type` ∈ `bar | line | pie | scatter | area`. `format` ∈ `png | svg`. `series.values.length` MUST equal `labels.length` (per-series).

## Conversion matrix (`convertOffice`)

| Source  | Allowed targets            |
| ------- | -------------------------- |
| `.docx` | `pdf, odt, txt, html, rtf` |
| `.odt`  | `pdf, docx`                |
| `.pptx` | `pdf, odp`                 |
| `.odp`  | `pdf, pptx`                |
| `.xlsx` | `pdf, ods, csv`            |
| `.ods`  | `pdf, xlsx, csv`           |

Anything outside this matrix returns an error — those pairs are lossy or unsupported. For `.pdf → .docx`: use `readDocument` then `createDocx` from the resulting Markdown.

## Workflow: Word report with a chart

Run inside `execute_code` — dot notation, `await` each call:

```javascript
// 1. render the chart
const chart = await office.renderChart({
  spec: {
    type: 'bar',
    title: 'Revenue 2025',
    data: {
      labels: ['Q1', 'Q2', 'Q3', 'Q4'],
      series: [{ name: '€k', values: [100, 150, 120, 180] }],
    },
  },
  outName: 'revenue.png',
});

// 2. build the docx, embedding the PNG
const doc = await office.createDocx({
  spec: {
    elements: [
      { type: 'heading', level: 1, text: 'Quarterly Revenue Report' },
      { type: 'paragraph', text: 'Strong growth across all quarters.' },
      { type: 'image', path: chart.path },
      { type: 'pagebreak' },
      { type: 'heading', level: 2, text: 'Details' },
      {
        type: 'table',
        header: ['Q', '€k'],
        rows: [
          ['Q1', '100'],
          ['Q2', '150'],
        ],
      },
    ],
  },
  outName: 'report.docx',
});

return doc; // { path, bytes, format }
```

## Workflow: Convert a deck to PDF

```javascript
return await office.officeToPdf({ path: '/workspace/deck.pptx', outName: 'deck.pdf' });
```

## Workflow: Merge invoices

```javascript
return await office.mergePdf({
  paths: ['/workspace/invoice-01.pdf', '/workspace/invoice-02.pdf'],
  outName: 'invoices.pdf',
});
```
