/**
 * PDF manipulation — merge, split, rotate, watermark, fill AcroForm, read metadata.
 * All operations run in the bundled Python venv via `scripts/pdf_ops.py` (pypdf).
 * @module mcp-office/engine/pdf-ops
 */

import { runPythonScript } from '../subprocess.js';
import { resolveInputFile, resolveOutputPath } from '../path-policy.js';
import { buildFileResult } from './file-result.js';
import { ValidationError } from '../errors.js';
import { MAX_PDF_PAGES } from '../config.js';
import type { FileResult } from '../types.js';

/** Cap on the number of PDFs/ranges a single merge/split call may take (each spawns a subprocess). */
const MAX_PDF_BATCH = 200;

/**
 * Read a PDF's metadata (page count, title/author/producer, encryption flag).
 * @param userPath - Caller-supplied path to the `.pdf`, under `/workspace`.
 * @returns The metadata object returned by `pdf_ops.py metadata`.
 */
export async function pdfMetadata(userPath: string): Promise<Record<string, unknown>> {
  const abs = await resolveInputFile(userPath);
  const out = await runPythonScript('pdf_ops.py', ['metadata', abs]);
  return (out.metadata as Record<string, unknown>) ?? {};
}

/**
 * Concatenate several PDFs into one, in the given order.
 * @param userPaths - 1..n caller-supplied PDF paths, under `/workspace`.
 * @param outName - Output filename/path (optional).
 * @param overwrite - Permit overwriting an existing output (default false).
 * @returns The {@link FileResult} for the merged PDF.
 * @throws {ValidationError} If fewer than two inputs are given.
 */
export async function mergePdf(
  userPaths: string[],
  outName?: string,
  overwrite = false
): Promise<FileResult> {
  if (!Array.isArray(userPaths) || userPaths.length < 2) {
    throw new ValidationError('mergePdf needs at least two input PDFs');
  }
  if (userPaths.length > MAX_PDF_BATCH) {
    throw new ValidationError(`mergePdf accepts at most ${MAX_PDF_BATCH} input PDFs`);
  }
  const abs = await Promise.all(userPaths.map((p) => resolveInputFile(p)));
  const dest = await resolveOutputPath(outName, `merged-${Date.now()}.pdf`, overwrite);
  await runPythonScript('pdf_ops.py', ['merge', dest, ...abs]);
  return buildFileResult(dest, 'pdf');
}

/**
 * Split a PDF into one output file per page range (`[[1,3],[5,5]]`, 1-indexed, inclusive).
 * @param userPath - Caller-supplied path to the `.pdf`, under `/workspace`.
 * @param ranges - List of `[start, end]` 1-indexed inclusive page ranges.
 * @param outName - Base name for the outputs (optional); each part is suffixed `-part1`, `-part2`, …
 * @param overwrite - Permit overwriting existing outputs (default false).
 * @returns One {@link FileResult} per produced part.
 * @throws {ValidationError} If `ranges` is empty/malformed, or a range exceeds the page count.
 */
export async function splitPdf(
  userPath: string,
  ranges: [number, number][],
  outName?: string,
  overwrite = false
): Promise<FileResult[]> {
  const abs = await resolveInputFile(userPath);
  if (!Array.isArray(ranges) || ranges.length === 0) {
    throw new ValidationError('splitPdf needs at least one [start, end] range');
  }
  if (ranges.length > MAX_PDF_BATCH) {
    throw new ValidationError(`splitPdf accepts at most ${MAX_PDF_BATCH} ranges`);
  }
  for (const r of ranges) {
    if (
      !Array.isArray(r) ||
      r.length !== 2 ||
      !Number.isInteger(r[0]) ||
      !Number.isInteger(r[1]) ||
      r[0] < 1 ||
      r[1] < r[0]
    ) {
      throw new ValidationError(
        `Invalid page range: ${JSON.stringify(r)} (expected [start, end], 1-indexed)`
      );
    }
    if (r[1] > MAX_PDF_PAGES) {
      throw new ValidationError(`Page range end ${r[1]} exceeds the ${MAX_PDF_PAGES}-page limit`);
    }
  }
  // Ranges write to independent output paths from the same read-only input — run in parallel.
  const base = (outName ?? `split-${Date.now()}.pdf`).replace(/\.pdf$/i, '');
  return Promise.all(
    ranges.map(async (range, i) => {
      const dest = await resolveOutputPath(undefined, `${base}-part${i + 1}.pdf`, overwrite);
      await runPythonScript('pdf_ops.py', ['split', abs, dest, String(range[0]), String(range[1])]);
      return buildFileResult(dest, 'pdf');
    })
  );
}

/**
 * Rotate the given pages (1-indexed) of a PDF by 90/180/270 degrees, leaving other pages unchanged.
 * @param userPath - Caller-supplied path to the `.pdf`, under `/workspace`.
 * @param pages - 1-indexed page numbers to rotate.
 * @param degrees - Rotation amount; one of 90, 180, 270.
 * @param outName - Output filename/path (optional).
 * @param overwrite - Permit overwriting an existing output (default false).
 * @returns The {@link FileResult} for the rotated PDF.
 * @throws {ValidationError} If `degrees` is not 90/180/270 or `pages` is empty/malformed.
 */
export async function rotatePdf(
  userPath: string,
  pages: number[],
  degrees: number,
  outName?: string,
  overwrite = false
): Promise<FileResult> {
  if (![90, 180, 270].includes(degrees)) {
    throw new ValidationError('rotatePdf: degrees must be 90, 180, or 270');
  }
  if (
    !Array.isArray(pages) ||
    pages.length === 0 ||
    pages.some((p) => !Number.isInteger(p) || p < 1)
  ) {
    throw new ValidationError(
      'rotatePdf: pages must be a non-empty list of 1-indexed page numbers'
    );
  }
  const abs = await resolveInputFile(userPath);
  const dest = await resolveOutputPath(outName, `rotated-${Date.now()}.pdf`, overwrite);
  await runPythonScript('pdf_ops.py', ['rotate', abs, dest, String(degrees), pages.join(',')]);
  return buildFileResult(dest, 'pdf');
}

/**
 * Stamp a single-page watermark PDF onto every page of `userPath`.
 * @param userPath - Caller-supplied path to the document PDF, under `/workspace`.
 * @param watermarkPath - Caller-supplied path to a single-page PDF used as the stamp, under `/workspace`.
 * @param outName - Output filename/path (optional).
 * @param overwrite - Permit overwriting an existing output (default false).
 * @returns The {@link FileResult} for the watermarked PDF.
 */
export async function watermarkPdf(
  userPath: string,
  watermarkPath: string,
  outName?: string,
  overwrite = false
): Promise<FileResult> {
  const abs = await resolveInputFile(userPath);
  const wm = await resolveInputFile(watermarkPath);
  const dest = await resolveOutputPath(outName, `watermarked-${Date.now()}.pdf`, overwrite);
  await runPythonScript('pdf_ops.py', ['watermark', abs, wm, dest]);
  return buildFileResult(dest, 'pdf');
}

/** Result of {@link fillPdfForm}: the file envelope plus whether the form was actually flattened and any per-field warnings. */
export type FilledFormResult = FileResult & {
  /** True if the AcroForm was flattened (only relevant when `flatten` was requested). */
  flattened: boolean;
  /** Non-fatal warnings from the fill step (e.g. a field name not present in the form). */
  fieldWarnings?: string[];
};

/**
 * Fill an AcroForm PDF's text fields from a name→value map, flattening the result by default.
 * @param userPath - Caller-supplied path to the form PDF, under `/workspace`.
 * @param fields - Map of form-field names to string values.
 * @param outName - Output filename/path (optional).
 * @param flatten - Whether to flatten the form so values become static content (default true).
 * @param overwrite - Permit overwriting an existing output (default false).
 * @returns The {@link FilledFormResult}: file info, `flattened`, and any `fieldWarnings`. If `flatten`
 *   was requested but could not be applied, `flattened` is false and a warning is written to stderr.
 * @throws {ValidationError} If `fields` is not a plain object.
 */
export async function fillPdfForm(
  userPath: string,
  fields: Record<string, string>,
  outName?: string,
  flatten = true,
  overwrite = false
): Promise<FilledFormResult> {
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    throw new ValidationError('fillPdfForm: fields must be an object of name → value');
  }
  // Contract is name→string; non-string values are rejected, not coerced.
  const strFields: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v !== 'string') {
      throw new ValidationError(`fillPdfForm: fields[${JSON.stringify(k)}] must be a string`);
    }
    strFields[k] = v;
  }
  const abs = await resolveInputFile(userPath);
  const dest = await resolveOutputPath(outName, `filled-${Date.now()}.pdf`, overwrite);
  const out = await runPythonScript('pdf_ops.py', [
    'fillform',
    abs,
    dest,
    flatten ? '1' : '0',
    JSON.stringify(strFields),
  ]);
  const flattened = out.flattened === true;
  const fieldWarnings = Array.isArray(out.fill_warnings)
    ? (out.fill_warnings as unknown[]).map(String)
    : undefined;
  if (flatten && !flattened) {
    process.stderr.write('[office] fillPdfForm: flatten requested but could not be applied\n');
  }
  if (fieldWarnings && fieldWarnings.length > 0) {
    process.stderr.write(`[office] fillPdfForm warnings: ${fieldWarnings.join('; ')}\n`);
  }
  const base = await buildFileResult(dest, 'pdf');
  return { ...base, flattened, ...(fieldWarnings ? { fieldWarnings } : {}) };
}
