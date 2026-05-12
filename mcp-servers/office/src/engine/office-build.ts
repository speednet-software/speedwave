/**
 * Create/edit Word, Excel, PowerPoint files from the normative `spec`/`ops` DSL.
 * All building runs in the bundled Python venv via `scripts/{docx,xlsx,pptx}_build.py`
 * (python-docx / openpyxl / python-pptx). This module validates the DSL shapes in
 * TypeScript before handing them to the scripts.
 * @module mcp-office/engine/office-build
 */

import { runPythonScript } from '../subprocess.js';
import { resolveInputFile, resolveOutputPath } from '../path-policy.js';
import { buildFileResult } from './file-result.js';
import { ValidationError } from '../errors.js';
import type {
  DocxSpec,
  DocxOp,
  DocxElement,
  XlsxSpec,
  PptxSpec,
  PptxOp,
  PptxSlide,
  FileResult,
} from '../types.js';

/** A candidate object plucked from `unknown` DSL input; fields accessed as `o['key']`, no per-field casts. */
type Obj = Record<string, unknown>;

/**
 * Cast `v` to a plain object for field-by-field validation, or throw {@link ValidationError}.
 * @param v - The candidate value.
 * @param what - Path-in-spec label for the error message.
 * @returns `v` typed as a plain object.
 */
function asObj(v: unknown, what: string): Obj {
  if (typeof v !== 'object' || v === null) {
    throw new ValidationError(`${what} must be an object`);
  }
  return v as Obj;
}

/**
 * Require `obj[key]` to be a non-empty string and return it, else throw {@link ValidationError}.
 * @param obj - The object to read from.
 * @param key - The field name.
 * @param where - Path-in-spec label for the error message.
 * @returns The validated non-empty string.
 */
function reqStr(obj: Obj, key: string, where: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new ValidationError(`${where}.${key} must be a non-empty string`);
  }
  return v;
}

/**
 * Validate one {@link DocxElement}; image paths are resolved/validated against `/workspace`.
 * @param el - The candidate element.
 * @param where - Path-in-spec label for error messages.
 */
function validateDocxElement(el: unknown, where: string): void {
  const e = asObj(el, `${where}: element`);
  switch (e['type']) {
    case 'heading': {
      reqStr(e, 'text', where);
      const level = e['level'];
      if (!Number.isInteger(level) || (level as number) < 1 || (level as number) > 6) {
        throw new ValidationError(`${where}.level must be an integer 1..6`);
      }
      break;
    }
    case 'paragraph':
      reqStr(e, 'text', where);
      break;
    case 'table': {
      const header = e['header'];
      if (!Array.isArray(header) || header.some((h) => typeof h !== 'string')) {
        throw new ValidationError(`${where}.header must be an array of strings`);
      }
      const rows = e['rows'];
      if (
        !Array.isArray(rows) ||
        rows.some((r) => !Array.isArray(r) || r.some((c) => typeof c !== 'string'))
      ) {
        throw new ValidationError(`${where}.rows must be an array of string arrays`);
      }
      break;
    }
    case 'image':
      reqStr(e, 'path', where);
      // resolved later by the caller using resolveImagePaths
      break;
    case 'pagebreak':
      break;
    default:
      throw new ValidationError(`${where}: unknown element type ${String(e['type'])}`);
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
 * @throws {ValidationError} If `spec` is malformed.
 */
export async function createDocx(
  spec: unknown,
  outName?: string,
  overwrite = false
): Promise<FileResult> {
  if (typeof spec !== 'object' || spec === null || !Array.isArray((spec as DocxSpec).elements)) {
    throw new ValidationError('createDocx: spec must be { elements: Element[] }');
  }
  (spec as DocxSpec).elements.forEach((el, i) => validateDocxElement(el, `elements[${i}]`));
  const resolved = await resolveImagePaths((spec as DocxSpec).elements);
  const dest = await resolveOutputPath(outName, `document-${Date.now()}.docx`, overwrite);
  await runPythonScript('docx_build.py', ['create', dest, JSON.stringify({ elements: resolved })]);
  return buildFileResult(dest, 'docx');
}

/**
 * Apply `ops` to an existing `.docx`.
 * @param userPath - Caller-supplied path to the source `.docx`, under `/workspace`.
 * @param ops - The mutation list (validated here against the DSL).
 * @param outName - Output filename/path (optional).
 * @param overwrite - Permit overwriting an existing output (default false).
 * @returns The {@link FileResult} for the produced `.docx`.
 * @throws {ValidationError} If `ops` is malformed.
 */
export async function editDocx(
  userPath: string,
  ops: unknown,
  outName?: string,
  overwrite = false
): Promise<FileResult> {
  if (!Array.isArray(ops)) {
    throw new ValidationError('editDocx: ops must be an array');
  }
  for (let i = 0; i < ops.length; i++) {
    const o = asObj(ops[i], `ops[${i}]`);
    if (o['op'] === 'append') {
      validateDocxElement(o['element'], `ops[${i}].element`);
    } else if (o['op'] === 'replace_text') {
      reqStr(o, 'find', `ops[${i}]`);
      if (typeof o['replace'] !== 'string') {
        throw new ValidationError(`ops[${i}].replace must be a string`);
      }
    } else if (o['op'] === 'delete_paragraph') {
      const index = o['index'];
      if (!Number.isInteger(index) || (index as number) < 0) {
        throw new ValidationError(`ops[${i}].index must be a non-negative integer`);
      }
    } else {
      throw new ValidationError(`ops[${i}]: unknown op ${String(o['op'])}`);
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
  return buildFileResult(dest, 'docx');
}

/**
 * Validate an {@link XlsxChart} object.
 * @param c - The candidate chart object.
 * @param where - Path-in-spec label for error messages.
 */
function validateXlsxChart(c: unknown, where: string): void {
  const ch = asObj(c, `${where}: chart`);
  if (!['bar', 'line', 'pie', 'scatter'].includes(String(ch['type']))) {
    throw new ValidationError(`${where}.type must be one of bar|line|pie|scatter`);
  }
  reqStr(ch, 'dataRange', where);
  reqStr(ch, 'anchor', where);
}

/**
 * Validate one {@link XlsxSheet}.
 * @param s - The candidate sheet/slide object.
 * @param where - Path-in-spec label for error messages.
 */
function validateXlsxSheet(s: unknown, where: string): void {
  const sh = asObj(s, `${where}: sheet`);
  reqStr(sh, 'name', where);
  const rows = sh['rows'];
  if (!Array.isArray(rows) || rows.some((r) => !Array.isArray(r))) {
    throw new ValidationError(`${where}.rows must be an array of arrays`);
  }
  for (const r of rows as unknown[][]) {
    for (const c of r) {
      if (c !== null && typeof c !== 'string' && typeof c !== 'number') {
        throw new ValidationError(`${where}.rows cells must be string|number|null`);
      }
    }
  }
  const charts = sh['charts'];
  if (charts !== undefined) {
    if (!Array.isArray(charts)) {
      throw new ValidationError(`${where}.charts must be an array`);
    }
    charts.forEach((c, i) => validateXlsxChart(c, `${where}.charts[${i}]`));
  }
}

/**
 * Create an `.xlsx` from an {@link XlsxSpec}.
 * @param spec - The workbook spec (validated here).
 * @param outName - Output filename/path (optional).
 * @param overwrite - Permit overwriting an existing output (default false).
 * @returns The {@link FileResult} for the produced `.xlsx`.
 * @throws {ValidationError} If `spec` is malformed.
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
    throw new ValidationError(
      'createXlsx: spec must be { sheets: [{ name, rows, ... }, ...] } with at least one sheet'
    );
  }
  (spec as XlsxSpec).sheets.forEach((s, i) => validateXlsxSheet(s, `sheets[${i}]`));
  const dest = await resolveOutputPath(outName, `workbook-${Date.now()}.xlsx`, overwrite);
  await runPythonScript('xlsx_build.py', ['create', dest, JSON.stringify(spec)]);
  return buildFileResult(dest, 'xlsx');
}

/**
 * Apply `ops` to an existing `.xlsx`.
 * @param userPath - Caller-supplied path to the source `.xlsx`, under `/workspace`.
 * @param ops - The mutation list (validated here).
 * @param outName - Output filename/path (optional).
 * @param overwrite - Permit overwriting an existing output (default false).
 * @returns The {@link FileResult} for the produced `.xlsx`.
 * @throws {ValidationError} If `ops` is malformed.
 */
export async function editXlsx(
  userPath: string,
  ops: unknown,
  outName?: string,
  overwrite = false
): Promise<FileResult> {
  if (!Array.isArray(ops)) {
    throw new ValidationError('editXlsx: ops must be an array');
  }
  for (let i = 0; i < ops.length; i++) {
    const o = asObj(ops[i], `ops[${i}]`);
    const w = `ops[${i}]`;
    if (o['op'] === 'set_cell') {
      reqStr(o, 'sheet', w);
      reqStr(o, 'cell', w);
      const v = o['value'];
      if (v !== null && typeof v !== 'string' && typeof v !== 'number') {
        throw new ValidationError(`${w}.value must be string|number|null`);
      }
    } else if (o['op'] === 'set_formula') {
      reqStr(o, 'sheet', w);
      reqStr(o, 'cell', w);
      reqStr(o, 'formula', w);
    } else if (o['op'] === 'add_sheet') {
      reqStr(o, 'name', w);
    } else if (o['op'] === 'add_chart') {
      reqStr(o, 'sheet', w);
      validateXlsxChart(o['chart'], `${w}.chart`);
    } else {
      throw new ValidationError(`${w}: unknown op ${String(o['op'])}`);
    }
  }
  const src = await resolveInputFile(userPath);
  const dest = await resolveOutputPath(outName, `workbook-${Date.now()}.xlsx`, overwrite);
  await runPythonScript('xlsx_build.py', ['edit', src, dest, JSON.stringify(ops)]);
  return buildFileResult(dest, 'xlsx');
}

/**
 * Validate a {@link PptxChart}.
 * @param c - The candidate chart object.
 * @param where - Path-in-spec label for error messages.
 */
function validatePptxChart(c: unknown, where: string): void {
  const ch = asObj(c, `${where}: chart`);
  if (!['column', 'line', 'pie', 'xy', 'bubble'].includes(String(ch['type']))) {
    throw new ValidationError(`${where}.type must be one of column|line|pie|xy|bubble`);
  }
  const categories = ch['categories'];
  if (!Array.isArray(categories) || categories.some((x) => typeof x !== 'string')) {
    throw new ValidationError(`${where}.categories must be an array of strings`);
  }
  const series = ch['series'];
  if (!Array.isArray(series) || series.length === 0) {
    throw new ValidationError(`${where}.series must be a non-empty array`);
  }
  for (let i = 0; i < series.length; i++) {
    const s = asObj(series[i], `${where}.series[${i}]`);
    reqStr(s, 'name', `${where}.series[${i}]`);
    if (
      !Array.isArray(s['values']) ||
      (s['values'] as unknown[]).some((v) => typeof v !== 'number')
    ) {
      throw new ValidationError(`${where}.series[${i}].values must be an array of numbers`);
    }
  }
}

/**
 * Validate one {@link PptxSlide}; image paths are resolved later.
 * @param s - The candidate sheet/slide object.
 * @param where - Path-in-spec label for error messages.
 */
function validatePptxSlide(s: unknown, where: string): void {
  const sl = asObj(s, `${where}: slide`);
  if (sl['title'] !== undefined && typeof sl['title'] !== 'string') {
    throw new ValidationError(`${where}.title must be a string`);
  }
  const bullets = sl['bullets'];
  if (
    bullets !== undefined &&
    (!Array.isArray(bullets) || bullets.some((b) => typeof b !== 'string'))
  ) {
    throw new ValidationError(`${where}.bullets must be an array of strings`);
  }
  if (sl['image'] !== undefined) {
    reqStr(asObj(sl['image'], `${where}.image`), 'path', `${where}.image`);
  }
  if (sl['chart'] !== undefined) {
    validatePptxChart(sl['chart'], `${where}.chart`);
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
 * @throws {ValidationError} If `spec` is malformed.
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
    throw new ValidationError(
      'createPptx: spec must be { slides: Slide[] } with at least one slide'
    );
  }
  (spec as PptxSpec).slides.forEach((s, i) => validatePptxSlide(s, `slides[${i}]`));
  const resolved = await resolveSlideImages((spec as PptxSpec).slides);
  const dest = await resolveOutputPath(outName, `presentation-${Date.now()}.pptx`, overwrite);
  await runPythonScript('pptx_build.py', ['create', dest, JSON.stringify({ slides: resolved })]);
  return buildFileResult(dest, 'pptx');
}

/**
 * Apply `ops` to an existing `.pptx`.
 * @param userPath - Caller-supplied path to the source `.pptx`, under `/workspace`.
 * @param ops - The mutation list (validated here).
 * @param outName - Output filename/path (optional).
 * @param overwrite - Permit overwriting an existing output (default false).
 * @returns The {@link FileResult} for the produced `.pptx`.
 * @throws {ValidationError} If `ops` is malformed.
 */
export async function editPptx(
  userPath: string,
  ops: unknown,
  outName?: string,
  overwrite = false
): Promise<FileResult> {
  if (!Array.isArray(ops)) {
    throw new ValidationError('editPptx: ops must be an array');
  }
  for (let i = 0; i < ops.length; i++) {
    const o = asObj(ops[i], `ops[${i}]`);
    const w = `ops[${i}]`;
    if (o['op'] === 'add_slide') {
      validatePptxSlide(o['slide'], `${w}.slide`);
    } else if (o['op'] === 'set_title') {
      const index = o['index'];
      if (!Number.isInteger(index) || (index as number) < 0) {
        throw new ValidationError(`${w}.index must be a non-negative integer`);
      }
      reqStr(o, 'text', w);
    } else if (o['op'] === 'delete_slide') {
      const index = o['index'];
      if (!Number.isInteger(index) || (index as number) < 0) {
        throw new ValidationError(`${w}.index must be a non-negative integer`);
      }
    } else {
      throw new ValidationError(`${w}: unknown op ${String(o['op'])}`);
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
  return buildFileResult(dest, 'pptx');
}
