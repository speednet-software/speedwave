/**
 * Create/edit Word, Excel, PowerPoint files from the normative `spec`/`ops` DSL.
 * All building runs in the bundled Python venv via `scripts/{docx,xlsx,pptx}_build.py`
 * (python-docx / openpyxl / python-pptx). This module validates the DSL shapes in
 * TypeScript before handing them to the scripts.
 * @module mcp-office/engine/office-build
 */

import * as fsp from 'node:fs/promises';
import { runPythonScript } from '../subprocess.js';
import { resolveInputFile, resolveOutputPath, PathPolicyError } from '../path-policy.js';
import type {
  DocxSpec,
  DocxOp,
  DocxElement,
  XlsxSpec,
  XlsxOp,
  XlsxChart,
  XlsxSheet,
  PptxSpec,
  PptxOp,
  PptxSlide,
  PptxChart,
  FileResult,
} from '../types.js';

/**
 * Build a {@link FileResult} for a produced Office file (no text preview).
 * @param absPath - Absolute path of the file.
 * @param format - Output format token (e.g. "pdf").
 */
async function officeResult(absPath: string, format: string): Promise<FileResult> {
  const bytes = (await fsp.stat(absPath)).size;
  return { path: absPath, bytes, format, preview: '', truncated: false };
}

/**
 * Assert `v` is a non-empty string, else throw {@link PathPolicyError} mentioning `what`.
 * @param v - The value to check.
 * @param what - Name of the field, for the error message.
 */
function assertString(v: unknown, what: string): asserts v is string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new PathPolicyError(`${what} must be a non-empty string`);
  }
}

/**
 * Validate one {@link DocxElement}; image paths are resolved/validated against `/workspace`.
 * @param el - The candidate element.
 * @param where - Path-in-spec label for error messages.
 */
function validateDocxElement(el: unknown, where: string): void {
  if (typeof el !== 'object' || el === null) {
    throw new PathPolicyError(`${where}: element must be an object`);
  }
  const e = el as Partial<DocxElement> & { type?: string };
  switch (e.type) {
    case 'heading':
      assertString((e as { text?: unknown }).text, `${where}.text`);
      if (
        !Number.isInteger((e as { level?: unknown }).level) ||
        (e as { level: number }).level < 1 ||
        (e as { level: number }).level > 6
      ) {
        throw new PathPolicyError(`${where}.level must be an integer 1..6`);
      }
      break;
    case 'paragraph':
      assertString((e as { text?: unknown }).text, `${where}.text`);
      break;
    case 'table': {
      const t = e as { header?: unknown; rows?: unknown };
      if (!Array.isArray(t.header) || t.header.some((h) => typeof h !== 'string')) {
        throw new PathPolicyError(`${where}.header must be an array of strings`);
      }
      if (
        !Array.isArray(t.rows) ||
        t.rows.some((r) => !Array.isArray(r) || r.some((c) => typeof c !== 'string'))
      ) {
        throw new PathPolicyError(`${where}.rows must be an array of string arrays`);
      }
      break;
    }
    case 'image':
      assertString((e as { path?: unknown }).path, `${where}.path`);
      // resolved later by the caller using resolveImagePaths
      break;
    case 'pagebreak':
      break;
    default:
      throw new PathPolicyError(`${where}: unknown element type ${String(e.type)}`);
  }
}

/**
 * Resolve every `image.path` in a list of elements to a validated absolute path under `/workspace`.
 * @param elements - The list of document elements.
 */
async function resolveImagePaths(elements: DocxElement[]): Promise<DocxElement[]> {
  return Promise.all(
    elements.map(async (el) =>
      el.type === 'image' ? { type: 'image' as const, path: await resolveInputFile(el.path) } : el
    )
  );
}

/**
 * Create a `.docx` from a {@link DocxSpec}.
 * @param spec - The document spec (validated here against the DSL).
 * @param outName - Output filename/path (optional).
 * @param overwrite - Permit overwriting an existing output (default false).
 * @returns The {@link FileResult} for the produced `.docx`.
 * @throws {PathPolicyError} If `spec` is malformed.
 */
export async function createDocx(
  spec: unknown,
  outName?: string,
  overwrite = false
): Promise<FileResult> {
  if (typeof spec !== 'object' || spec === null || !Array.isArray((spec as DocxSpec).elements)) {
    throw new PathPolicyError('createDocx: spec must be { elements: Element[] }');
  }
  (spec as DocxSpec).elements.forEach((el, i) => validateDocxElement(el, `elements[${i}]`));
  const resolved = await resolveImagePaths((spec as DocxSpec).elements);
  const dest = await resolveOutputPath(outName, `document-${Date.now()}.docx`, overwrite);
  await runPythonScript('docx_build.py', ['create', dest, JSON.stringify({ elements: resolved })]);
  return officeResult(dest, 'docx');
}

/**
 * Apply `ops` to an existing `.docx`.
 * @param userPath - Caller-supplied path to the source `.docx`, under `/workspace`.
 * @param ops - The mutation list (validated here against the DSL).
 * @param outName - Output filename/path (optional).
 * @param overwrite - Permit overwriting an existing output (default false).
 * @returns The {@link FileResult} for the produced `.docx`.
 * @throws {PathPolicyError} If `ops` is malformed.
 */
export async function editDocx(
  userPath: string,
  ops: unknown,
  outName?: string,
  overwrite = false
): Promise<FileResult> {
  if (!Array.isArray(ops)) {
    throw new PathPolicyError('editDocx: ops must be an array');
  }
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i] as Partial<DocxOp> & { op?: string };
    if (o.op === 'append') {
      validateDocxElement((o as { element?: unknown }).element, `ops[${i}].element`);
    } else if (o.op === 'replace_text') {
      assertString((o as { find?: unknown }).find, `ops[${i}].find`);
      if (typeof (o as { replace?: unknown }).replace !== 'string') {
        throw new PathPolicyError(`ops[${i}].replace must be a string`);
      }
    } else if (o.op === 'delete_paragraph') {
      if (
        !Number.isInteger((o as { index?: unknown }).index) ||
        (o as { index: number }).index < 0
      ) {
        throw new PathPolicyError(`ops[${i}].index must be a non-negative integer`);
      }
    } else {
      throw new PathPolicyError(`ops[${i}]: unknown op ${String(o.op)}`);
    }
  }
  const src = await resolveInputFile(userPath);
  // Resolve any image paths inside append ops.
  const resolvedOps = await Promise.all(
    (ops as DocxOp[]).map(async (o) =>
      o.op === 'append' && o.element.type === 'image'
        ? {
            op: 'append' as const,
            element: { type: 'image' as const, path: await resolveInputFile(o.element.path) },
          }
        : o
    )
  );
  const dest = await resolveOutputPath(outName, `document-${Date.now()}.docx`, overwrite);
  await runPythonScript('docx_build.py', ['edit', src, dest, JSON.stringify(resolvedOps)]);
  return officeResult(dest, 'docx');
}

/**
 * Validate an {@link XlsxChart} object.
 * @param c - The candidate chart object.
 * @param where - Path-in-spec label for error messages.
 */
function validateXlsxChart(c: unknown, where: string): void {
  if (typeof c !== 'object' || c === null) {
    throw new PathPolicyError(`${where}: chart must be an object`);
  }
  const ch = c as Partial<XlsxChart> & { type?: string };
  if (!['bar', 'line', 'pie', 'scatter'].includes(String(ch.type))) {
    throw new PathPolicyError(`${where}.type must be one of bar|line|pie|scatter`);
  }
  assertString((ch as { dataRange?: unknown }).dataRange, `${where}.dataRange`);
  assertString((ch as { anchor?: unknown }).anchor, `${where}.anchor`);
}

/**
 * Validate one {@link XlsxSheet}.
 * @param s - The candidate sheet/slide object.
 * @param where - Path-in-spec label for error messages.
 */
function validateXlsxSheet(s: unknown, where: string): void {
  if (typeof s !== 'object' || s === null) {
    throw new PathPolicyError(`${where}: sheet must be an object`);
  }
  const sh = s as Partial<XlsxSheet>;
  assertString(sh.name, `${where}.name`);
  if (!Array.isArray(sh.rows) || sh.rows.some((r) => !Array.isArray(r))) {
    throw new PathPolicyError(`${where}.rows must be an array of arrays`);
  }
  for (const r of sh.rows) {
    for (const c of r as unknown[]) {
      if (c !== null && typeof c !== 'string' && typeof c !== 'number') {
        throw new PathPolicyError(`${where}.rows cells must be string|number|null`);
      }
    }
  }
  if (sh.charts !== undefined) {
    if (!Array.isArray(sh.charts)) {
      throw new PathPolicyError(`${where}.charts must be an array`);
    }
    sh.charts.forEach((c, i) => validateXlsxChart(c, `${where}.charts[${i}]`));
  }
}

/**
 * Create an `.xlsx` from an {@link XlsxSpec}.
 * @param spec - The workbook spec (validated here).
 * @param outName - Output filename/path (optional).
 * @param overwrite - Permit overwriting an existing output (default false).
 * @returns The {@link FileResult} for the produced `.xlsx`.
 * @throws {PathPolicyError} If `spec` is malformed.
 */
export async function createXlsx(
  spec: unknown,
  outName?: string,
  overwrite = false
): Promise<FileResult> {
  if (
    typeof spec !== 'object' ||
    spec === null ||
    !Array.isArray((spec as XlsxSpec).sheets) ||
    (spec as XlsxSpec).sheets.length === 0
  ) {
    throw new PathPolicyError(
      'createXlsx: spec must be { sheets: [{ name, rows, ... }, ...] } with at least one sheet'
    );
  }
  (spec as XlsxSpec).sheets.forEach((s, i) => validateXlsxSheet(s, `sheets[${i}]`));
  const dest = await resolveOutputPath(outName, `workbook-${Date.now()}.xlsx`, overwrite);
  await runPythonScript('xlsx_build.py', ['create', dest, JSON.stringify(spec)]);
  return officeResult(dest, 'xlsx');
}

/**
 * Apply `ops` to an existing `.xlsx`.
 * @param userPath - Caller-supplied path to the source `.xlsx`, under `/workspace`.
 * @param ops - The mutation list (validated here).
 * @param outName - Output filename/path (optional).
 * @param overwrite - Permit overwriting an existing output (default false).
 * @returns The {@link FileResult} for the produced `.xlsx`.
 * @throws {PathPolicyError} If `ops` is malformed.
 */
export async function editXlsx(
  userPath: string,
  ops: unknown,
  outName?: string,
  overwrite = false
): Promise<FileResult> {
  if (!Array.isArray(ops)) {
    throw new PathPolicyError('editXlsx: ops must be an array');
  }
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i] as Partial<XlsxOp> & { op?: string };
    if (o.op === 'set_cell') {
      assertString((o as { sheet?: unknown }).sheet, `ops[${i}].sheet`);
      assertString((o as { cell?: unknown }).cell, `ops[${i}].cell`);
      const v = (o as { value?: unknown }).value;
      if (v !== null && typeof v !== 'string' && typeof v !== 'number') {
        throw new PathPolicyError(`ops[${i}].value must be string|number|null`);
      }
    } else if (o.op === 'set_formula') {
      assertString((o as { sheet?: unknown }).sheet, `ops[${i}].sheet`);
      assertString((o as { cell?: unknown }).cell, `ops[${i}].cell`);
      assertString((o as { formula?: unknown }).formula, `ops[${i}].formula`);
    } else if (o.op === 'add_sheet') {
      assertString((o as { name?: unknown }).name, `ops[${i}].name`);
    } else if (o.op === 'add_chart') {
      assertString((o as { sheet?: unknown }).sheet, `ops[${i}].sheet`);
      validateXlsxChart((o as { chart?: unknown }).chart, `ops[${i}].chart`);
    } else {
      throw new PathPolicyError(`ops[${i}]: unknown op ${String(o.op)}`);
    }
  }
  const src = await resolveInputFile(userPath);
  const dest = await resolveOutputPath(outName, `workbook-${Date.now()}.xlsx`, overwrite);
  await runPythonScript('xlsx_build.py', ['edit', src, dest, JSON.stringify(ops)]);
  return officeResult(dest, 'xlsx');
}

/**
 * Validate a {@link PptxChart}.
 * @param c - The candidate chart object.
 * @param where - Path-in-spec label for error messages.
 */
function validatePptxChart(c: unknown, where: string): void {
  if (typeof c !== 'object' || c === null) {
    throw new PathPolicyError(`${where}: chart must be an object`);
  }
  const ch = c as Partial<PptxChart> & { type?: string };
  if (!['column', 'line', 'pie', 'xy', 'bubble'].includes(String(ch.type))) {
    throw new PathPolicyError(`${where}.type must be one of column|line|pie|xy|bubble`);
  }
  if (!Array.isArray(ch.categories) || ch.categories.some((x) => typeof x !== 'string')) {
    throw new PathPolicyError(`${where}.categories must be an array of strings`);
  }
  if (!Array.isArray(ch.series) || ch.series.length === 0) {
    throw new PathPolicyError(`${where}.series must be a non-empty array`);
  }
  for (let i = 0; i < ch.series.length; i++) {
    const s = ch.series[i] as { name?: unknown; values?: unknown };
    assertString(s.name, `${where}.series[${i}].name`);
    if (!Array.isArray(s.values) || s.values.some((v) => typeof v !== 'number')) {
      throw new PathPolicyError(`${where}.series[${i}].values must be an array of numbers`);
    }
  }
}

/**
 * Validate one {@link PptxSlide}; image paths are resolved later.
 * @param s - The candidate sheet/slide object.
 * @param where - Path-in-spec label for error messages.
 */
function validatePptxSlide(s: unknown, where: string): void {
  if (typeof s !== 'object' || s === null) {
    throw new PathPolicyError(`${where}: slide must be an object`);
  }
  const sl = s as Partial<PptxSlide>;
  if (sl.title !== undefined && typeof sl.title !== 'string') {
    throw new PathPolicyError(`${where}.title must be a string`);
  }
  if (
    sl.bullets !== undefined &&
    (!Array.isArray(sl.bullets) || sl.bullets.some((b) => typeof b !== 'string'))
  ) {
    throw new PathPolicyError(`${where}.bullets must be an array of strings`);
  }
  if (sl.image !== undefined) {
    assertString((sl.image as { path?: unknown }).path, `${where}.image.path`);
  }
  if (sl.chart !== undefined) {
    validatePptxChart(sl.chart, `${where}.chart`);
  }
}

/**
 * Resolve `image.path` on every slide to a validated absolute path.
 * @param slides - The list of slides.
 */
async function resolveSlideImages(slides: PptxSlide[]): Promise<PptxSlide[]> {
  return Promise.all(
    slides.map(async (sl) =>
      sl.image ? { ...sl, image: { path: await resolveInputFile(sl.image.path) } } : sl
    )
  );
}

/**
 * Create a `.pptx` from a {@link PptxSpec}.
 * @param spec - The presentation spec (validated here).
 * @param outName - Output filename/path (optional).
 * @param overwrite - Permit overwriting an existing output (default false).
 * @returns The {@link FileResult} for the produced `.pptx`.
 * @throws {PathPolicyError} If `spec` is malformed.
 */
export async function createPptx(
  spec: unknown,
  outName?: string,
  overwrite = false
): Promise<FileResult> {
  if (
    typeof spec !== 'object' ||
    spec === null ||
    !Array.isArray((spec as PptxSpec).slides) ||
    (spec as PptxSpec).slides.length === 0
  ) {
    throw new PathPolicyError(
      'createPptx: spec must be { slides: Slide[] } with at least one slide'
    );
  }
  (spec as PptxSpec).slides.forEach((s, i) => validatePptxSlide(s, `slides[${i}]`));
  const resolved = await resolveSlideImages((spec as PptxSpec).slides);
  const dest = await resolveOutputPath(outName, `presentation-${Date.now()}.pptx`, overwrite);
  await runPythonScript('pptx_build.py', ['create', dest, JSON.stringify({ slides: resolved })]);
  return officeResult(dest, 'pptx');
}

/**
 * Apply `ops` to an existing `.pptx`.
 * @param userPath - Caller-supplied path to the source `.pptx`, under `/workspace`.
 * @param ops - The mutation list (validated here).
 * @param outName - Output filename/path (optional).
 * @param overwrite - Permit overwriting an existing output (default false).
 * @returns The {@link FileResult} for the produced `.pptx`.
 * @throws {PathPolicyError} If `ops` is malformed.
 */
export async function editPptx(
  userPath: string,
  ops: unknown,
  outName?: string,
  overwrite = false
): Promise<FileResult> {
  if (!Array.isArray(ops)) {
    throw new PathPolicyError('editPptx: ops must be an array');
  }
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i] as Partial<PptxOp> & { op?: string };
    if (o.op === 'add_slide') {
      validatePptxSlide((o as { slide?: unknown }).slide, `ops[${i}].slide`);
    } else if (o.op === 'set_title') {
      if (
        !Number.isInteger((o as { index?: unknown }).index) ||
        (o as { index: number }).index < 0
      ) {
        throw new PathPolicyError(`ops[${i}].index must be a non-negative integer`);
      }
      assertString((o as { text?: unknown }).text, `ops[${i}].text`);
    } else if (o.op === 'delete_slide') {
      if (
        !Number.isInteger((o as { index?: unknown }).index) ||
        (o as { index: number }).index < 0
      ) {
        throw new PathPolicyError(`ops[${i}].index must be a non-negative integer`);
      }
    } else {
      throw new PathPolicyError(`ops[${i}]: unknown op ${String(o.op)}`);
    }
  }
  const src = await resolveInputFile(userPath);
  const resolvedOps = await Promise.all(
    (ops as PptxOp[]).map(async (o) =>
      o.op === 'add_slide' && o.slide.image
        ? {
            op: 'add_slide' as const,
            slide: { ...o.slide, image: { path: await resolveInputFile(o.slide.image.path) } },
          }
        : o
    )
  );
  const dest = await resolveOutputPath(outName, `presentation-${Date.now()}.pptx`, overwrite);
  await runPythonScript('pptx_build.py', ['edit', src, dest, JSON.stringify(resolvedOps)]);
  return officeResult(dest, 'pptx');
}
