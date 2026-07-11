/**
 * Shared types for the office worker — tool I/O shapes and the `spec`/`ops` DSL, the normative contract (ADR-055); anything outside it is a tool error.
 * @module mcp-office/types
 */

/** Standard "this file was produced" envelope returned by every generation/conversion tool. */
export interface FileResult {
  /** Absolute path of the written file, under `/workspace`. */
  path: string;
  /** Size of the written file in bytes. */
  bytes: number;
  /** Output format / extension (e.g. `"pdf"`, `"docx"`, `"png"`). */
  format: string;
  /** A short text preview of the produced content where meaningful (e.g. extracted text), else an empty string. */
  preview: string;
  /** Whether `preview` was truncated at the requested `maxChars`. */
  truncated: boolean;
}

/** Result of a read/extract tool — Markdown (or plain text) plus size and truncation flags. */
export interface ReadResult {
  /** The extracted content (Markdown for `readDocument`, plain text for `readPdfText`). */
  content: string;
  /** Size of the source file in bytes. */
  bytes: number;
  /** Whether `content` was truncated at the requested `maxChars`. */
  truncated: boolean;
  /** Which extraction engine produced the content (`"sheetjs" | "markitdown" | "pdftotext" | "pandoc" | "python-docx"`). */
  engine: string;
}

// ── Chart DSL (renderChart) ──────────────────────────────────────────────────

/** Supported standalone-chart kinds for {@link ChartSpec}. */
export type ChartType = 'bar' | 'line' | 'pie' | 'scatter' | 'area';

/** One named data series within a chart. */
export interface ChartSeries {
  /** Legend label for this series. */
  name: string;
  /** Y values; must have the same length as `data.labels`. */
  values: number[];
}

/** Normative spec for `renderChart` (matplotlib). */
export interface ChartSpec {
  /** Chart kind. */
  type: ChartType;
  /** Optional chart title. */
  title?: string;
  /** Optional X-axis label. */
  xlabel?: string;
  /** Optional Y-axis label. */
  ylabel?: string;
  /** Output image format (default `"png"`). */
  format?: 'png' | 'svg';
  /** Figure width in inches (default 8). */
  width?: number;
  /** Figure height in inches (default 5). */
  height?: number;
  /** The data: X-axis labels/categories and one or more series. */
  data: {
    /** X-axis categories / labels. */
    labels: string[];
    /** One or more series; each `values` length must equal `labels` length. */
    series: ChartSeries[];
  };
}

// ── Word DSL (createDocx / editDocx) ─────────────────────────────────────────

/** A single content element in a `.docx` spec. */
export type DocxElement =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: 'paragraph'; text: string; bold?: boolean; italic?: boolean }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'image'; path: string }
  | { type: 'pagebreak' };

/** Normative `spec` for `createDocx`. */
export interface DocxSpec {
  /** Ordered list of content elements. */
  elements: DocxElement[];
}

/** A single mutation in a `.docx` `ops` list. */
export type DocxOp =
  | { op: 'append'; element: DocxElement }
  | { op: 'replace_text'; find: string; replace: string }
  | { op: 'delete_paragraph'; index: number };

// ── Excel DSL (createXlsx / editXlsx) ────────────────────────────────────────

/** Supported native-chart kinds inside an `.xlsx`. */
export type XlsxChartType = 'bar' | 'line' | 'pie' | 'scatter';

/** A native chart anchored on a worksheet, bound to cell ranges. */
export interface XlsxChart {
  /** Chart kind. */
  type: XlsxChartType;
  /** Optional chart title. */
  title?: string;
  /** Data range in `Sheet!A1:B10` form. */
  dataRange: string;
  /** Optional categories range in `Sheet!A1:A10` form. */
  categoriesRange?: string;
  /** Top-left anchor cell for the chart (e.g. `"E2"`). */
  anchor: string;
}

/** One worksheet in an `.xlsx` spec. */
export interface XlsxSheet {
  /** Sheet name. */
  name: string;
  /** Row-major cell values; `null` leaves a cell empty. */
  rows: (string | number | null)[][];
  /** Optional freeze-panes anchor (e.g. `"A2"` freezes the header row). */
  freeze?: string;
  /** Optional native charts on this sheet. */
  charts?: XlsxChart[];
}

/** Normative `spec` for `createXlsx`. */
export interface XlsxSpec {
  /** One or more worksheets. */
  sheets: XlsxSheet[];
}

/** A single mutation in an `.xlsx` `ops` list. */
export type XlsxOp =
  | { op: 'set_cell'; sheet: string; cell: string; value: string | number | null }
  | { op: 'set_formula'; sheet: string; cell: string; formula: string }
  | { op: 'add_sheet'; name: string }
  | { op: 'add_chart'; sheet: string; chart: XlsxChart };

// ── PowerPoint DSL (createPptx / editPptx) ───────────────────────────────────

/** Supported native-chart kinds inside a `.pptx`. */
export type PptxChartType = 'column' | 'line' | 'pie' | 'xy' | 'bubble';

/** A native chart on a slide. */
export interface PptxChart {
  /** Chart kind. */
  type: PptxChartType;
  /** Category labels. */
  categories: string[];
  /** One or more series. */
  series: ChartSeries[];
  /** Optional chart title. */
  title?: string;
}

/** One slide in a `.pptx` spec. */
export interface PptxSlide {
  /** Optional slide title. */
  title?: string;
  /** Optional bullet lines for the body placeholder. */
  bullets?: string[];
  /** Optional image to place on the slide. */
  image?: { path: string };
  /** Optional native chart on the slide. */
  chart?: PptxChart;
}

/** Normative `spec` for `createPptx`. */
export interface PptxSpec {
  /** Ordered list of slides. */
  slides: PptxSlide[];
}

/** A single mutation in a `.pptx` `ops` list. */
export type PptxOp =
  | { op: 'add_slide'; slide: PptxSlide }
  | { op: 'set_title'; index: number; text: string }
  | { op: 'delete_slide'; index: number };
