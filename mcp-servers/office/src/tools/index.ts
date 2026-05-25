/**
 * Office worker tool definitions and handlers — ~25 tools across read/extract,
 * Markdown/HTML → document, charts, create/edit Office, Office→PDF / Office↔Office,
 * and PDF manipulation. Discoverability rests on `_meta.deferLoading` + `keywords`,
 * cross-referencing descriptions, and the decision-map skill at
 * `containers/claude-resources/skills/integrations/office/SKILL.md` (ADR-055).
 * @module mcp-office/tools
 */

import {
  type Tool,
  type ToolDefinition,
  type ToolsCallResult,
  jsonResult,
  errorResult,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { DEFAULT_MAX_CHARS } from '../config.js';
import { readDocumentToMarkdown, readPdfText } from '../engine/extract.js';
import {
  markdownToPdf,
  htmlToPdf,
  markdownToDocx,
  markdownToPptx,
  officeToPdf,
  convertOffice,
  CONVERT_MATRIX,
  type TextInput,
  type PdfOptions,
} from '../engine/convert.js';
import { renderChart } from '../engine/chart.js';
import {
  createDocx,
  editDocx,
  createXlsx,
  editXlsx,
  createPptx,
  editPptx,
} from '../engine/office-build.js';
import {
  pdfMetadata,
  mergePdf,
  splitPdf,
  rotatePdf,
  watermarkPdf,
  fillPdfForm,
} from '../engine/pdf-ops.js';

/** A `deferLoading: false` `_meta` marker — tool is shown to Claude upfront (not behind `search_tools`). */
const SHOWN = { deferLoading: false } as const;
/** Shown upfront, but a slow tool (LibreOffice/weasyprint) — needs the `long` timeout class. */
const SHOWN_LONG = { deferLoading: false, timeoutClass: 'long' } as const;
/** A `deferLoading: true` `_meta` marker for slow tools (LibreOffice/weasyprint/matplotlib). */
const DEFERRED_LONG = { deferLoading: true, timeoutClass: 'long' } as const;
/** A `deferLoading: true` `_meta` marker for standard-cost tools. */
const DEFERRED = { deferLoading: true } as const;

/**
 * Wrap a handler so any thrown error is returned as an MCP `isError` result rather than
 * propagating as an unhandled rejection (which the hub would see as a dropped response).
 * @param fn - The handler to wrap.
 */
function guard(
  fn: (p: Record<string, unknown>) => Promise<ToolsCallResult>
): (p: Record<string, unknown>) => Promise<ToolsCallResult> {
  return async (params) => {
    try {
      return await fn(params);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };
}

/**
 * Read `params.maxChars` as a positive integer, defaulting when absent/invalid.
 * @param params - The MCP tool call parameters.
 */
function maxChars(params: Record<string, unknown>): number {
  const v = params.maxChars;
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : DEFAULT_MAX_CHARS;
}

/**
 * Read `params.overwrite` as a boolean (default false).
 * @param params - The MCP tool call parameters.
 */
function overwriteFlag(params: Record<string, unknown>): boolean {
  return params.overwrite === true;
}

/**
 * Coerce a tool's text-ish `input` param (must be `{ path }` | `{ markdown }` | `{ html }`).
 * @param params - The MCP tool call parameters.
 */
function textInput(params: Record<string, unknown>): TextInput {
  const i = params.input;
  if (typeof i !== 'object' || i === null) {
    throw new Error('input must be an object: { path } or { markdown } / { html }');
  }
  return i as TextInput;
}

/**
 * Read optional PDF page options from `params.opts`.
 * @param params - The MCP tool call parameters.
 */
function pdfOpts(params: Record<string, unknown>): PdfOptions {
  const o = params.opts;
  if (o === undefined) {
    return {};
  }
  if (typeof o !== 'object' || o === null) {
    throw new Error('opts must be an object: { pageSize?, margin?, landscape? }');
  }
  return o as PdfOptions;
}

/**
 * Require `params[name]` to be a non-empty string and return it.
 * @param params - The MCP tool call parameters.
 * @param name - The parameter name to read.
 */
function reqStr(params: Record<string, unknown>, name: string): string {
  const v = params[name];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${name} is required and must be a non-empty string`);
  }
  return v;
}

/**
 * Optional string param, or undefined.
 * @param params - The MCP tool call parameters.
 * @param name - The parameter name to read.
 */
function optStr(params: Record<string, unknown>, name: string): string | undefined {
  const v = params[name];
  if (v === undefined) {
    return undefined;
  }
  if (typeof v !== 'string') {
    throw new Error(`${name} must be a string`);
  }
  return v;
}

/** A reusable JSON-schema fragment for the optional `outName`/`overwrite` output controls. */
const OUTPUT_PROPS = {
  outName: {
    type: 'string',
    description:
      'Output file name (written under /workspace/.speedwave-office/) or an explicit path under /workspace.',
  },
  overwrite: {
    type: 'boolean',
    description: 'Overwrite the output if it already exists (default false).',
  },
} as const;

// ── Tool definitions ─────────────────────────────────────────────────────────

const readDocumentTool: Tool = {
  name: 'readDocument',
  description:
    'Extract a document (.docx, .xlsx, .xls, .xlsb, .ods, .pptx, .pdf, .html) to Markdown. ' +
    'Use this to read or summarize an existing file. Returns Markdown plus byte size and a `truncated` flag (limited by `maxChars`). ' +
    'For just the plain text layer of a PDF use `readPdfText`. To turn Markdown back into a PDF/DOCX/PPTX use `markdownToPdf`/`markdownToDocx`/`markdownToPptx`.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: SHOWN,
  keywords: [
    'read',
    'extract',
    'markdown',
    'docx',
    'xlsx',
    'xls',
    'pptx',
    'pdf',
    'parse',
    'convert',
    'document',
    'open',
  ],
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the document, under /workspace.' },
      maxChars: {
        type: 'number',
        description: `Max characters of Markdown to return (default ${DEFAULT_MAX_CHARS}).`,
      },
    },
    required: ['path'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string' },
      bytes: { type: 'number' },
      truncated: { type: 'boolean' },
      engine: { type: 'string' },
    },
    required: ['content', 'bytes', 'truncated', 'engine'],
  },
};

const readPdfTextTool: Tool = {
  name: 'readPdfText',
  description:
    'Extract the plain text layer of a PDF (pdftotext -layout). Use this when you only need the raw text. ' +
    'For a structured Markdown rendering (tables, headings) use `readDocument` instead.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: DEFERRED,
  keywords: ['pdf', 'text', 'extract', 'read', 'plain'],
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .pdf, under /workspace.' },
      maxChars: {
        type: 'number',
        description: `Max characters of text to return (default ${DEFAULT_MAX_CHARS}).`,
      },
    },
    required: ['path'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string' },
      bytes: { type: 'number' },
      truncated: { type: 'boolean' },
      engine: { type: 'string' },
    },
    required: ['content', 'bytes', 'truncated', 'engine'],
  },
};

const pdfMetadataTool: Tool = {
  name: 'pdfMetadata',
  description:
    "Read a PDF's metadata: page count, title/author/producer, and whether it is encrypted.",
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: DEFERRED,
  keywords: ['pdf', 'metadata', 'pages', 'info', 'properties'],
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path to the .pdf, under /workspace.' } },
    required: ['path'],
  },
  outputSchema: {
    type: 'object',
    properties: { metadata: { type: 'object' } },
    required: ['metadata'],
  },
};

const fileResultSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    bytes: { type: 'number' },
    format: { type: 'string' },
    preview: { type: 'string' },
    truncated: { type: 'boolean' },
  },
  required: ['path', 'bytes', 'format'],
} as const;

const markdownToPdfTool: Tool = {
  name: 'markdownToPdf',
  description:
    'Render Markdown (a .md path under /workspace, or inline `markdown` ≤200KB) to a PDF written under /workspace/.speedwave-office/. ' +
    'Uses pandoc → HTML → WeasyPrint with print CSS (page size, margins, page breaks, monospace code). ' +
    'For an EXISTING .docx/.pptx/.xlsx use `officeToPdf` — this tool does not read Office formats. For HTML input use `htmlToPdf`. ' +
    'To embed a chart, first call `renderChart` to produce a PNG/SVG under /workspace, then reference it as `![](path)` in the markdown.',
  annotations: WRITE_ANNOTATIONS,
  _meta: SHOWN_LONG,
  keywords: ['markdown', 'pdf', 'render', 'document', 'report', 'export', 'convert'],
  inputSchema: {
    type: 'object',
    properties: {
      input: {
        type: 'object',
        description:
          '{ path: "<.md under /workspace>" } or { markdown: "<inline markdown ≤200KB>" }',
      },
      opts: {
        type: 'object',
        description: '{ pageSize?: "A4", margin?: "18mm", landscape?: false }',
      },
      ...OUTPUT_PROPS,
    },
    required: ['input'],
  },
  outputSchema: fileResultSchema,
};

const htmlToPdfTool: Tool = {
  name: 'htmlToPdf',
  description:
    'Render HTML (a path under /workspace, or inline `html` ≤200KB) to a PDF via WeasyPrint. Only local resources under /workspace are loaded (no remote http(s)). ' +
    'Embeds `<img>` PNG/SVG, including charts from `renderChart`. For Markdown input use `markdownToPdf`; for an existing Office file use `officeToPdf`.',
  annotations: WRITE_ANNOTATIONS,
  _meta: DEFERRED_LONG,
  keywords: ['html', 'pdf', 'render', 'weasyprint', 'export', 'convert', 'web'],
  inputSchema: {
    type: 'object',
    properties: {
      input: {
        type: 'object',
        description: '{ path: "<.html under /workspace>" } or { html: "<inline html ≤200KB>" }',
      },
      opts: {
        type: 'object',
        description: '{ pageSize?: "A4", margin?: "18mm", landscape?: false }',
      },
      ...OUTPUT_PROPS,
    },
    required: ['input'],
  },
  outputSchema: fileResultSchema,
};

const markdownToDocxTool: Tool = {
  name: 'markdownToDocx',
  description:
    'Convert Markdown (path or inline ≤200KB) to a .docx via pandoc. For a PDF use `markdownToPdf`; for slides use `markdownToPptx`.',
  annotations: WRITE_ANNOTATIONS,
  _meta: DEFERRED,
  keywords: [
    'markdown',
    'docx',
    'word',
    'document',
    'convert',
    'export',
    'office',
    'file',
    'generate',
    'make',
    'create',
  ],
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'object', description: '{ path } or { markdown }' },
      ...OUTPUT_PROPS,
    },
    required: ['input'],
  },
  outputSchema: fileResultSchema,
};

const markdownToPptxTool: Tool = {
  name: 'markdownToPptx',
  description:
    'Convert Markdown (path or inline ≤200KB) to a .pptx via pandoc (one slide per top-level heading). ' +
    'For a finer-grained deck with charts/images use `createPptx`. For a Word document use `markdownToDocx`.',
  annotations: WRITE_ANNOTATIONS,
  _meta: DEFERRED,
  keywords: [
    'markdown',
    'pptx',
    'powerpoint',
    'slides',
    'presentation',
    'convert',
    'export',
    'office',
    'file',
    'generate',
    'make',
    'create',
    'deck',
  ],
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'object', description: '{ path } or { markdown }' },
      ...OUTPUT_PROPS,
    },
    required: ['input'],
  },
  outputSchema: fileResultSchema,
};

const renderChartTool: Tool = {
  name: 'renderChart',
  description:
    'Render a chart (bar/line/pie/scatter/area) to a PNG or SVG image under /workspace, from a JSON spec. ' +
    'Embed the result into a PDF (`htmlToPdf` via `<img>`), a .docx (`createDocx` image element), or a .pptx (`createPptx` slide image). ' +
    'For a native, editable chart inside an Excel/PowerPoint file, use the `charts`/`chart` keys of `createXlsx`/`createPptx` instead.',
  annotations: WRITE_ANNOTATIONS,
  _meta: DEFERRED_LONG,
  keywords: [
    'chart',
    'graph',
    'plot',
    'visualization',
    'bar',
    'line',
    'pie',
    'scatter',
    'diagram',
    'figure',
    'matplotlib',
  ],
  inputSchema: {
    type: 'object',
    properties: {
      spec: {
        type: 'object',
        description:
          '{ type: "bar"|"line"|"pie"|"scatter"|"area", title?, xlabel?, ylabel?, format?: "png"|"svg", width?, height?, data: { labels: string[], series: [{ name: string, values: number[] }] } } — each series.values length must equal labels length.',
      },
      ...OUTPUT_PROPS,
    },
    required: ['spec'],
  },
  outputSchema: fileResultSchema,
};

const createDocxTool: Tool = {
  name: 'createDocx',
  description:
    'Create a .docx from a structured spec: { elements: [ { type: "heading", level, text } | { type: "paragraph", text, bold?, italic? } | { type: "table", header, rows } | { type: "image", path } | { type: "pagebreak" } ] }. ' +
    'Image paths must be under /workspace (this is where a `renderChart` PNG goes). To modify an existing .docx use `editDocx`. From Markdown, use `markdownToDocx`.',
  annotations: WRITE_ANNOTATIONS,
  _meta: DEFERRED,
  keywords: [
    'docx',
    'word',
    'create',
    'document',
    'write',
    'generate',
    'report',
    'office',
    'file',
    'new',
    'make',
    'build',
    'template',
    'rich',
    'formatted',
    'formatting',
    'features',
    'heading',
    'paragraph',
    'table',
  ],
  inputSchema: {
    type: 'object',
    properties: {
      spec: { type: 'object', description: '{ elements: Element[] }' },
      ...OUTPUT_PROPS,
    },
    required: ['spec'],
  },
  outputSchema: fileResultSchema,
};

const editDocxTool: Tool = {
  name: 'editDocx',
  description:
    'Apply edits to an existing .docx: ops = [ { op: "append", element } | { op: "replace_text", find, replace } | { op: "delete_paragraph", index } ]. Writes a new file. To create one from scratch use `createDocx`.',
  annotations: WRITE_ANNOTATIONS,
  _meta: DEFERRED,
  keywords: [
    'docx',
    'word',
    'edit',
    'modify',
    'update',
    'replace',
    'append',
    'office',
    'file',
    'change',
    'patch',
    'rewrite',
  ],
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the source .docx, under /workspace.' },
      ops: { type: 'array', description: 'List of edit ops (see description).' },
      ...OUTPUT_PROPS,
    },
    required: ['path', 'ops'],
  },
  outputSchema: fileResultSchema,
};

const createXlsxTool: Tool = {
  name: 'createXlsx',
  description:
    'Create an .xlsx from a spec: { sheets: [ { name, rows: (string|number|null)[][], freeze?: "A2", charts?: [ { type: "bar"|"line"|"pie"|"scatter", title?, dataRange: "Sheet1!B1:B10", categoriesRange?, anchor: "E2" } ] } ] }. ' +
    'Supports native, editable Excel charts. To modify an existing workbook use `editXlsx`. To read one use `readDocument`.',
  annotations: WRITE_ANNOTATIONS,
  _meta: DEFERRED,
  keywords: [
    'xlsx',
    'excel',
    'spreadsheet',
    'create',
    'workbook',
    'chart',
    'write',
    'generate',
    'office',
    'file',
    'new',
    'make',
    'build',
    'template',
    'sheet',
    'table',
    'data',
    'formula',
    'formatted',
    'features',
  ],
  inputSchema: {
    type: 'object',
    properties: { spec: { type: 'object', description: '{ sheets: Sheet[] }' }, ...OUTPUT_PROPS },
    required: ['spec'],
  },
  outputSchema: fileResultSchema,
};

const editXlsxTool: Tool = {
  name: 'editXlsx',
  description:
    'Apply edits to an existing .xlsx: ops = [ { op: "set_cell", sheet, cell, value } | { op: "set_formula", sheet, cell, formula } | { op: "add_sheet", name } | { op: "add_chart", sheet, chart } ]. Writes a new file. To create one use `createXlsx`.',
  annotations: WRITE_ANNOTATIONS,
  _meta: DEFERRED,
  keywords: [
    'xlsx',
    'excel',
    'edit',
    'modify',
    'cell',
    'formula',
    'sheet',
    'chart',
    'office',
    'file',
    'spreadsheet',
    'workbook',
    'update',
    'change',
    'add',
  ],
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the source .xlsx, under /workspace.' },
      ops: { type: 'array', description: 'List of edit ops (see description).' },
      ...OUTPUT_PROPS,
    },
    required: ['path', 'ops'],
  },
  outputSchema: fileResultSchema,
};

const createPptxTool: Tool = {
  name: 'createPptx',
  description:
    'Create a .pptx from a spec: { slides: [ { title?, bullets?: string[], image?: { path }, chart?: { type: "column"|"line"|"pie"|"xy"|"bubble", categories: string[], series: [{ name, values }], title? } } ] }. ' +
    'Supports native PowerPoint charts and images (e.g. a `renderChart` PNG). To modify an existing deck use `editPptx`. From Markdown, use `markdownToPptx`.',
  annotations: WRITE_ANNOTATIONS,
  _meta: DEFERRED,
  keywords: [
    'pptx',
    'powerpoint',
    'slides',
    'presentation',
    'create',
    'chart',
    'deck',
    'generate',
    'office',
    'file',
    'new',
    'make',
    'build',
    'template',
    'slideshow',
    'formatted',
    'features',
  ],
  inputSchema: {
    type: 'object',
    properties: { spec: { type: 'object', description: '{ slides: Slide[] }' }, ...OUTPUT_PROPS },
    required: ['spec'],
  },
  outputSchema: fileResultSchema,
};

const editPptxTool: Tool = {
  name: 'editPptx',
  description:
    'Apply edits to an existing .pptx: ops = [ { op: "add_slide", slide } | { op: "set_title", index, text } | { op: "delete_slide", index } ]. Writes a new file. To create one use `createPptx`.',
  annotations: WRITE_ANNOTATIONS,
  _meta: DEFERRED,
  keywords: [
    'pptx',
    'powerpoint',
    'edit',
    'modify',
    'slide',
    'deck',
    'office',
    'file',
    'presentation',
    'slideshow',
    'add',
    'remove',
    'update',
  ],
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the source .pptx, under /workspace.' },
      ops: { type: 'array', description: 'List of edit ops (see description).' },
      ...OUTPUT_PROPS,
    },
    required: ['path', 'ops'],
  },
  outputSchema: fileResultSchema,
};

const officeToPdfTool: Tool = {
  name: 'officeToPdf',
  description:
    'Convert an EXISTING Office/ODF file (.docx, .xlsx, .pptx, .odt, .ods, .odp, .rtf) to PDF — a true LibreOffice render. ' +
    'For Markdown→PDF use `markdownToPdf`; for HTML→PDF use `htmlToPdf`. For other target formats use `convertOffice`.',
  annotations: WRITE_ANNOTATIONS,
  _meta: DEFERRED_LONG,
  keywords: ['office', 'pdf', 'convert', 'docx', 'xlsx', 'pptx', 'export', 'render', 'libreoffice'],
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the Office/ODF file, under /workspace.' },
      ...OUTPUT_PROPS,
    },
    required: ['path'],
  },
  outputSchema: fileResultSchema,
};

const convertOfficeTool: Tool = {
  name: 'convertOffice',
  description:
    'Convert an Office/ODF file to another supported format via LibreOffice. Supported pairs: ' +
    '.docx→{pdf,odt,txt,html,rtf}; .odt→{pdf,docx}; .pptx→{pdf,odp}; .odp→{pdf,pptx}; .xlsx→{pdf,ods,csv}; .ods→{pdf,xlsx,csv}. ' +
    'Anything outside this matrix is rejected. For .docx/.xlsx/.pptx → PDF specifically, `officeToPdf` is the simpler call.',
  annotations: WRITE_ANNOTATIONS,
  _meta: DEFERRED_LONG,
  keywords: [
    'office',
    'convert',
    'docx',
    'odt',
    'pptx',
    'odp',
    'xlsx',
    'ods',
    'pdf',
    'csv',
    'html',
    'rtf',
    'libreoffice',
  ],
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the source file, under /workspace.' },
      target: {
        type: 'string',
        description:
          'Target format token, e.g. "pdf", "odt", "csv" (must be allowed for the source type).',
      },
      ...OUTPUT_PROPS,
    },
    required: ['path', 'target'],
  },
  outputSchema: fileResultSchema,
};

const mergePdfTool: Tool = {
  name: 'mergePdf',
  description:
    'Concatenate two or more PDFs into one, in the given order. To split a PDF use `splitPdf`.',
  annotations: WRITE_ANNOTATIONS,
  _meta: DEFERRED,
  keywords: ['pdf', 'merge', 'combine', 'join', 'concatenate', 'append'],
  inputSchema: {
    type: 'object',
    properties: {
      paths: { type: 'array', description: 'Two or more .pdf paths under /workspace, in order.' },
      ...OUTPUT_PROPS,
    },
    required: ['paths'],
  },
  outputSchema: fileResultSchema,
};

const splitPdfTool: Tool = {
  name: 'splitPdf',
  description:
    'Split a PDF into one output file per page range. `ranges` is a list of [start, end] (1-indexed, inclusive), e.g. [[1,3],[5,5]]. Each part is named `<base>-partN.pdf`. To merge PDFs use `mergePdf`.',
  annotations: WRITE_ANNOTATIONS,
  _meta: DEFERRED,
  keywords: ['pdf', 'split', 'extract', 'pages', 'range', 'separate'],
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .pdf, under /workspace.' },
      ranges: {
        type: 'array',
        description: 'List of [start, end] 1-indexed inclusive page ranges.',
      },
      outName: {
        type: 'string',
        description: 'Base name for the parts (each suffixed -part1, -part2, …).',
      },
      overwrite: { type: 'boolean', description: 'Overwrite existing parts (default false).' },
    },
    required: ['path', 'ranges'],
  },
  outputSchema: { type: 'object', properties: { parts: { type: 'array' } }, required: ['parts'] },
};

const rotatePdfTool: Tool = {
  name: 'rotatePdf',
  description:
    'Rotate the given 1-indexed pages of a PDF by 90, 180, or 270 degrees, leaving other pages unchanged.',
  annotations: WRITE_ANNOTATIONS,
  _meta: DEFERRED,
  keywords: ['pdf', 'rotate', 'orientation', 'pages', 'turn'],
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .pdf, under /workspace.' },
      pages: { type: 'array', description: '1-indexed page numbers to rotate.' },
      degrees: { type: 'number', description: '90, 180, or 270.' },
      ...OUTPUT_PROPS,
    },
    required: ['path', 'pages', 'degrees'],
  },
  outputSchema: fileResultSchema,
};

const watermarkPdfTool: Tool = {
  name: 'watermarkPdf',
  description: 'Stamp a single-page watermark PDF onto every page of a document PDF.',
  annotations: WRITE_ANNOTATIONS,
  _meta: DEFERRED,
  keywords: ['pdf', 'watermark', 'stamp', 'overlay', 'brand'],
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the document .pdf, under /workspace.' },
      watermarkPath: {
        type: 'string',
        description: 'Path to a single-page .pdf used as the stamp, under /workspace.',
      },
      ...OUTPUT_PROPS,
    },
    required: ['path', 'watermarkPath'],
  },
  outputSchema: fileResultSchema,
};

const fillPdfFormTool: Tool = {
  name: 'fillPdfForm',
  description:
    "Fill an AcroForm PDF's text fields from a name→value map, flattening the result by default.",
  annotations: WRITE_ANNOTATIONS,
  _meta: DEFERRED,
  keywords: ['pdf', 'form', 'acroform', 'fill', 'fields', 'flatten'],
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the form .pdf, under /workspace.' },
      fields: { type: 'object', description: 'Map of form-field name → string value.' },
      flatten: {
        type: 'boolean',
        description: 'Flatten the form so values become static content (default true).',
      },
      ...OUTPUT_PROPS,
    },
    required: ['path', 'fields'],
  },
  outputSchema: fileResultSchema,
};

/**
 * Build the full list of office tool definitions with their handlers.
 * @returns All {@link ToolDefinition}s for the worker.
 */
export function createToolDefinitions(): ToolDefinition[] {
  return [
    {
      tool: readDocumentTool,
      handler: guard(async (p) =>
        jsonResult(await readDocumentToMarkdown(reqStr(p, 'path'), maxChars(p)))
      ),
    },
    {
      tool: readPdfTextTool,
      handler: guard(async (p) => jsonResult(await readPdfText(reqStr(p, 'path'), maxChars(p)))),
    },
    {
      tool: pdfMetadataTool,
      handler: guard(async (p) => jsonResult({ metadata: await pdfMetadata(reqStr(p, 'path')) })),
    },
    {
      tool: markdownToPdfTool,
      handler: guard(async (p) =>
        jsonResult(
          await markdownToPdf(textInput(p), optStr(p, 'outName'), pdfOpts(p), overwriteFlag(p))
        )
      ),
    },
    {
      tool: htmlToPdfTool,
      handler: guard(async (p) =>
        jsonResult(
          await htmlToPdf(textInput(p), optStr(p, 'outName'), pdfOpts(p), overwriteFlag(p))
        )
      ),
    },
    {
      tool: markdownToDocxTool,
      handler: guard(async (p) =>
        jsonResult(await markdownToDocx(textInput(p), optStr(p, 'outName'), overwriteFlag(p)))
      ),
    },
    {
      tool: markdownToPptxTool,
      handler: guard(async (p) =>
        jsonResult(await markdownToPptx(textInput(p), optStr(p, 'outName'), overwriteFlag(p)))
      ),
    },
    {
      tool: renderChartTool,
      handler: guard(async (p) =>
        jsonResult(await renderChart(p.spec, optStr(p, 'outName'), overwriteFlag(p)))
      ),
    },
    {
      tool: createDocxTool,
      handler: guard(async (p) =>
        jsonResult(await createDocx(p.spec, optStr(p, 'outName'), overwriteFlag(p)))
      ),
    },
    {
      tool: editDocxTool,
      handler: guard(async (p) =>
        jsonResult(await editDocx(reqStr(p, 'path'), p.ops, optStr(p, 'outName'), overwriteFlag(p)))
      ),
    },
    {
      tool: createXlsxTool,
      handler: guard(async (p) =>
        jsonResult(await createXlsx(p.spec, optStr(p, 'outName'), overwriteFlag(p)))
      ),
    },
    {
      tool: editXlsxTool,
      handler: guard(async (p) =>
        jsonResult(await editXlsx(reqStr(p, 'path'), p.ops, optStr(p, 'outName'), overwriteFlag(p)))
      ),
    },
    {
      tool: createPptxTool,
      handler: guard(async (p) =>
        jsonResult(await createPptx(p.spec, optStr(p, 'outName'), overwriteFlag(p)))
      ),
    },
    {
      tool: editPptxTool,
      handler: guard(async (p) =>
        jsonResult(await editPptx(reqStr(p, 'path'), p.ops, optStr(p, 'outName'), overwriteFlag(p)))
      ),
    },
    {
      tool: officeToPdfTool,
      handler: guard(async (p) =>
        jsonResult(await officeToPdf(reqStr(p, 'path'), optStr(p, 'outName'), overwriteFlag(p)))
      ),
    },
    {
      tool: convertOfficeTool,
      handler: guard(async (p) =>
        jsonResult(
          await convertOffice(
            reqStr(p, 'path'),
            reqStr(p, 'target'),
            optStr(p, 'outName'),
            overwriteFlag(p)
          )
        )
      ),
    },
    {
      tool: mergePdfTool,
      handler: guard(async (p) => {
        const paths = p.paths;
        if (!Array.isArray(paths) || paths.some((x) => typeof x !== 'string')) {
          throw new Error('paths must be an array of strings');
        }
        return jsonResult(
          await mergePdf(paths as string[], optStr(p, 'outName'), overwriteFlag(p))
        );
      }),
    },
    {
      tool: splitPdfTool,
      handler: guard(async (p) => {
        const ranges = p.ranges;
        if (!Array.isArray(ranges)) {
          throw new Error('ranges must be an array of [start, end] pairs');
        }
        return jsonResult({
          parts: await splitPdf(
            reqStr(p, 'path'),
            ranges as [number, number][],
            optStr(p, 'outName'),
            overwriteFlag(p)
          ),
        });
      }),
    },
    {
      tool: rotatePdfTool,
      handler: guard(async (p) => {
        const pages = p.pages;
        const degrees = p.degrees;
        if (!Array.isArray(pages) || pages.some((x) => typeof x !== 'number')) {
          throw new Error('pages must be an array of numbers');
        }
        if (typeof degrees !== 'number') {
          throw new Error('degrees must be a number (90, 180, or 270)');
        }
        return jsonResult(
          await rotatePdf(
            reqStr(p, 'path'),
            pages as number[],
            degrees,
            optStr(p, 'outName'),
            overwriteFlag(p)
          )
        );
      }),
    },
    {
      tool: watermarkPdfTool,
      handler: guard(async (p) =>
        jsonResult(
          await watermarkPdf(
            reqStr(p, 'path'),
            reqStr(p, 'watermarkPath'),
            optStr(p, 'outName'),
            overwriteFlag(p)
          )
        )
      ),
    },
    {
      tool: fillPdfFormTool,
      handler: guard(async (p) => {
        const fields = p.fields;
        if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
          throw new Error('fields must be an object of name → value');
        }
        const flatten = p.flatten === undefined ? true : p.flatten === true;
        return jsonResult(
          await fillPdfForm(
            reqStr(p, 'path'),
            fields as Record<string, string>,
            optStr(p, 'outName'),
            flatten,
            overwriteFlag(p)
          )
        );
      }),
    },
  ];
}

/** Re-exported for tests / docs: the supported conversion matrix. */
export { CONVERT_MATRIX };
