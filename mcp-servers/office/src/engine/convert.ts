/**
 * Markdown/HTML → PDF/DOCX/PPTX (pandoc + weasyprint), Office → PDF / Office ↔ Office (LibreOffice headless).
 * @module mcp-office/engine/convert
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runOk, runPythonScript } from '../subprocess.js';
import { libreOfficeQueue } from '../lo-queue.js';
import { ignoreError } from '../util.js';
import { resolveInputFile, resolveOutputPath, atomicMoveOnto } from '../path-policy.js';
import { buildFileResult } from './file-result.js';
import { ValidationError } from '../errors.js';
import { TIMEOUT_LIBREOFFICE_MS, MAX_INLINE_BYTES, WORKSPACE_ROOT } from '../config.js';
import type { FileResult } from '../types.js';

/** Page-rendering options for HTML/Markdown → PDF. */
export interface PdfOptions {
  /** Page size token understood by CSS `@page size` (e.g. `"A4"`, `"Letter"`). Default `"A4"`. */
  pageSize?: string;
  /** Page margin (any CSS length, e.g. `"18mm"`). Default `"18mm"`. */
  margin?: string;
  /** Landscape orientation. Default `false`. */
  landscape?: boolean;
}

/** Either an inline string or a `/workspace` path; tools accept both for text-ish inputs. */
export type TextInput = { path: string } | { markdown: string } | { html: string };

/**
 * Resolve a {@link TextInput} to a concrete file path: a provided path is validated as an input file; inline content (≤ `MAX_INLINE_BYTES`) is written to a temp file with the given extension.
 * @param input - the text input (path or inline)
 * @param inlineExt - extension to use for the temp file when content is inline (e.g. `".md"`, `".html"`)
 * @returns The path to use and whether it is a temp file the caller should delete.
 * @throws {ValidationError} When inline content exceeds the size cap, or when `input` has no recognized key.
 */
async function materializeTextInput(
  input: TextInput,
  inlineExt: string
): Promise<{ filePath: string; isTemp: boolean }> {
  if ('path' in input && typeof input.path === 'string') {
    return { filePath: await resolveInputFile(input.path), isTemp: false };
  }
  const inline = 'markdown' in input ? input.markdown : 'html' in input ? input.html : undefined;
  if (typeof inline !== 'string') {
    throw new ValidationError('Input must be { path } or { markdown } / { html }');
  }
  if (Buffer.byteLength(inline, 'utf8') > MAX_INLINE_BYTES) {
    throw new ValidationError(
      `Inline content exceeds ${MAX_INLINE_BYTES} bytes — write it to a file under /workspace and pass { path } instead`
    );
  }
  const tmp = path.join(os.tmpdir(), `office-in-${randomUUID()}${inlineExt}`);
  await fsp.writeFile(tmp, inline);
  return { filePath: tmp, isTemp: true };
}

/**
 * Base URL for WeasyPrint's `url_fetcher`: `/workspace/` for inline content, else the file's own directory.
 * @param filePath - the materialized file path
 * @param isTemp - whether the materialization wrote to `/tmp` (inline content)
 * @returns A `file://` base URL under `/workspace`.
 */
function baseUrlFor(filePath: string, isTemp: boolean): string {
  return isTemp ? `file://${WORKSPACE_ROOT}/` : `file://${path.dirname(filePath)}/`;
}

/** A CSS named page size (`@page size`), e.g. `A4`, `Letter`, `A3 landscape`. Case-insensitive. */
const PAGE_SIZE_KEYWORD = /^(A[0-5]|B[0-5]|letter|legal|ledger)(\s+(portrait|landscape))?$/i;
/** A CSS `<length>` token: a number (optional sign/decimal) followed by a unit, or `0`. */
const CSS_LENGTH = /^[+-]?(\d+(\.\d+)?|\.\d+)(cm|mm|in|px|pt|pc|q)$|^0$/i;
/**
 * True if `value` is one to four space-separated CSS `<length>` tokens (the `margin` shorthand).
 * @param value - the candidate margin string
 */
function isCssMargin(value: string): boolean {
  const parts = value.trim().split(/\s+/);
  return parts.length >= 1 && parts.length <= 4 && parts.every((p) => CSS_LENGTH.test(p));
}

/**
 * Validate `opts` and build the safe `@page` declaration (`size: …; margin: …;`).
 * @param opts - page-rendering options
 * @returns The validated `size: <...>; margin: <...>;` string for an `@page` block.
 * @throws {ValidationError} If `pageSize` or `margin` is not a recognized CSS value.
 */
function pageRuleBody(opts: PdfOptions): string {
  const rawSize = (opts.pageSize ?? 'A4').trim();
  if (!PAGE_SIZE_KEYWORD.test(rawSize) && !isCssMargin(rawSize)) {
    throw new ValidationError(
      `pageSize must be a CSS page-size keyword (A4, Letter, …) or "<width> <height>" lengths, got: ${rawSize}`
    );
  }
  // Strip any trailing orientation already present in the keyword.
  const baseSize = rawSize.replace(/\s+(portrait|landscape)\s*$/i, '');
  const size = opts.landscape ? `${baseSize} landscape` : rawSize;
  const margin = (opts.margin ?? '18mm').trim();
  if (!isCssMargin(margin)) {
    throw new ValidationError(
      `margin must be one to four CSS lengths (e.g. "18mm"), got: ${margin}`
    );
  }
  return `size: ${size}; margin: ${margin};`;
}

/**
 * Build a minimal print-oriented HTML wrapper around `bodyHtml` using an already-validated `@page` rule body from {@link pageRuleBody}.
 * @param bodyHtml - the HTML body fragment to wrap
 * @param ruleBody - the validated `size: …; margin: …;` string from {@link pageRuleBody}
 */
function wrapPrintHtmlWithRule(bodyHtml: string, ruleBody: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@page { ${ruleBody} }
body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; line-height: 1.5; }
pre, code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
pre { background:#f6f8fa; padding:12px; border-radius:6px; overflow:auto; }
table { border-collapse: collapse; } th, td { border: 1px solid #ccc; padding: 4px 8px; }
img { max-width: 100%; }
</style></head><body>${bodyHtml}</body></html>`;
}

/**
 * Render an HTML file to PDF via WeasyPrint (`scripts/weasyprint_render.py`), atomically moved onto `destAbs`.
 * @param htmlAbs - absolute path of the source HTML
 * @param baseUrl - base URL for resolving relative resources (a `file://` URL under `/workspace`)
 * @param destAbs - absolute destination path for the PDF (already validated)
 */
async function htmlFileToPdf(htmlAbs: string, baseUrl: string, destAbs: string): Promise<void> {
  const tmpPdf = path.join(os.tmpdir(), `office-pdf-${randomUUID()}.pdf`);
  try {
    await runPythonScript('weasyprint_render.py', [htmlAbs, tmpPdf, baseUrl]);
    await atomicMoveOnto(tmpPdf, destAbs);
  } finally {
    await fsp.rm(tmpPdf, { force: true }).catch(ignoreError);
  }
}

/**
 * Markdown (path or inline) → PDF via pandoc → HTML → WeasyPrint.
 * @param input - the Markdown source
 * @param outName - output filename/path (optional; defaults under `/workspace/.speedwave/office/`)
 * @param opts - page-rendering options
 * @param overwrite - permit overwriting an existing output (default false)
 * @returns The {@link FileResult} for the produced PDF.
 */
export async function markdownToPdf(
  input: TextInput,
  outName?: string,
  opts: PdfOptions = {},
  overwrite = false
): Promise<FileResult> {
  const { filePath, isTemp } = await materializeTextInput(input, '.md');
  try {
    const r = await runOk('pandoc', ['-f', 'markdown', '-t', 'html', filePath]);
    const html = wrapPrintHtmlWithRule(r.stdout, pageRuleBody(opts));
    const tmpHtml = path.join(os.tmpdir(), `office-html-${randomUUID()}.html`);
    await fsp.writeFile(tmpHtml, html);
    const dest = await resolveOutputPath(outName, `document-${Date.now()}.pdf`, overwrite);
    try {
      await htmlFileToPdf(tmpHtml, baseUrlFor(filePath, isTemp), dest);
    } finally {
      await fsp.rm(tmpHtml, { force: true }).catch(ignoreError);
    }
    return buildFileResult(dest, 'pdf');
  } finally {
    if (isTemp) {
      await fsp.rm(filePath, { force: true }).catch(ignoreError);
    }
  }
}

/**
 * HTML (path or inline) → PDF via WeasyPrint (local resources only); `opts` is applied as an injected `@page` rule when the HTML has no `<head>`.
 * @param input - the HTML source
 * @param outName - output filename/path (optional)
 * @param opts - page-rendering options (applied as an injected `@page` rule when the HTML has no `<head>`)
 * @param overwrite - permit overwriting an existing output (default false)
 * @returns The {@link FileResult} for the produced PDF.
 */
export async function htmlToPdf(
  input: TextInput,
  outName?: string,
  opts: PdfOptions = {},
  overwrite = false
): Promise<FileResult> {
  const { filePath, isTemp } = await materializeTextInput(input, '.html');
  const baseUrl = baseUrlFor(filePath, isTemp);
  try {
    // Validate `opts` once (throws on bad CSS), then reuse the rule body for both branches.
    const ruleBody = pageRuleBody(opts);
    // If the HTML looks like a fragment, wrap it; otherwise inject our (validated) @page rule before </head>.
    const raw = await fsp.readFile(filePath, 'utf8');
    let finalHtml: string;
    if (/<html[\s>]/i.test(raw)) {
      finalHtml = /<\/head>/i.test(raw)
        ? raw.replace(/<\/head>/i, `<style>@page { ${ruleBody} }</style></head>`)
        : raw;
    } else {
      finalHtml = wrapPrintHtmlWithRule(raw, ruleBody);
    }
    const tmpHtml = path.join(os.tmpdir(), `office-html-${randomUUID()}.html`);
    await fsp.writeFile(tmpHtml, finalHtml);
    const dest = await resolveOutputPath(outName, `document-${Date.now()}.pdf`, overwrite);
    try {
      await htmlFileToPdf(tmpHtml, baseUrl, dest);
    } finally {
      await fsp.rm(tmpHtml, { force: true }).catch(ignoreError);
    }
    return buildFileResult(dest, 'pdf');
  } finally {
    if (isTemp) {
      await fsp.rm(filePath, { force: true }).catch(ignoreError);
    }
  }
}

/**
 * Markdown (path or inline) → another format via pandoc, atomically moved onto the validated destination.
 * @param input - the Markdown source
 * @param writer - pandoc output writer (`"docx"` | `"pptx"`)
 * @param defaultBase - default base filename when `outName` is omitted
 * @param outName - output filename/path (optional)
 * @param overwrite - permit overwriting an existing output (default false)
 * @returns The {@link FileResult} for the produced file.
 */
async function markdownViaPandoc(
  input: TextInput,
  writer: 'docx' | 'pptx',
  defaultBase: string,
  outName?: string,
  overwrite = false
): Promise<FileResult> {
  const { filePath, isTemp } = await materializeTextInput(input, '.md');
  const tmpOut = path.join(os.tmpdir(), `office-pandoc-${randomUUID()}.${writer}`);
  try {
    const dest = await resolveOutputPath(outName, defaultBase, overwrite);
    await runOk('pandoc', ['-f', 'markdown', '-t', writer, '-o', tmpOut, filePath]);
    await atomicMoveOnto(tmpOut, dest);
    return buildFileResult(dest, writer);
  } finally {
    if (isTemp) {
      await fsp.rm(filePath, { force: true }).catch(ignoreError);
    }
    await fsp.rm(tmpOut, { force: true }).catch(ignoreError);
  }
}

/**
 * Markdown (path or inline) → `.docx` via pandoc.
 * @param input - the Markdown source
 * @param outName - output filename/path (optional)
 * @param overwrite - permit overwriting an existing output (default false)
 * @returns The {@link FileResult} for the produced `.docx`.
 */
export async function markdownToDocx(
  input: TextInput,
  outName?: string,
  overwrite = false
): Promise<FileResult> {
  return markdownViaPandoc(input, 'docx', `document-${Date.now()}.docx`, outName, overwrite);
}

/**
 * Markdown (path or inline) → `.pptx` via pandoc's pptx writer (one slide per top-level heading).
 * @param input - the Markdown source
 * @param outName - output filename/path (optional)
 * @param overwrite - permit overwriting an existing output (default false)
 * @returns The {@link FileResult} for the produced `.pptx`.
 */
export async function markdownToPptx(
  input: TextInput,
  outName?: string,
  overwrite = false
): Promise<FileResult> {
  return markdownViaPandoc(input, 'pptx', `presentation-${Date.now()}.pptx`, outName, overwrite);
}

/** Normative Office↔Office conversion matrix: source extension → set of allowed target formats. */
export const CONVERT_MATRIX: Readonly<Record<string, ReadonlySet<string>>> = {
  '.docx': new Set(['pdf', 'odt', 'txt', 'html', 'rtf']),
  '.odt': new Set(['pdf', 'docx']),
  '.pptx': new Set(['pdf', 'odp']),
  '.odp': new Set(['pdf', 'pptx']),
  '.xlsx': new Set(['pdf', 'ods', 'csv']),
  '.ods': new Set(['pdf', 'xlsx', 'csv']),
};

/** Matches "password"/"encrypt(ed|ion)" as a whole word only, never a substring inside a longer token. */
const PASSWORD_OR_ENCRYPTED = /\b(?:password|encrypt(?:ed|ion)?)\b/i;

/**
 * Strips path-like tokens (anything containing `/`) so an echoed source path can never false-trigger the signature match.
 * @param detail - the raw failure detail text
 */
function withoutPathTokens(detail: string): string {
  return detail.replace(/\S*\/\S+/g, '');
}

/**
 * Re-throw a LibreOffice subprocess failure as a {@link ValidationError} with actionable guidance, anchoring the password/encrypted case to a whole-word signature outside any echoed file path.
 * @param err - the error thrown by `runOk` for the `soffice` invocation
 */
function translateLibreOfficeError(err: unknown): never {
  const detail = err instanceof Error ? err.message : String(err);
  if (PASSWORD_OR_ENCRYPTED.test(withoutPathTokens(detail))) {
    throw new ValidationError(
      'LibreOffice could not open the input -- it may be password-protected or encrypted; ' +
        'verify the file opens normally (without a password) before converting.'
    );
  }
  throw new ValidationError(
    `LibreOffice conversion failed: ${detail} -- the input file may be corrupted, encrypted, ` +
      'or use a feature LibreOffice cannot render.'
  );
}

/**
 * Run `soffice --headless --convert-to <fmt>` on `srcAbs` into a fresh temp dir with a per-call user profile, serialized through the LibreOffice queue.
 * @param srcAbs - absolute path of the source Office file
 * @param target - target format token (e.g. `"pdf"`)
 * @returns The absolute path of the produced file under a temp directory.
 * @throws {ValidationError} If LibreOffice fails to run or produces no output file.
 */
async function libreOfficeConvert(srcAbs: string, target: string): Promise<string> {
  return libreOfficeQueue.run(async () => {
    const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'office-lo-'));
    const profilePath = path.join(os.tmpdir(), `lo-profile-${randomUUID()}`);
    try {
      try {
        await runOk(
          'soffice',
          [
            '--headless',
            '--norestore',
            '--nologo',
            '--nofirststartwizard',
            `-env:UserInstallation=file://${profilePath}`,
            '--convert-to',
            target,
            '--outdir',
            outDir,
            srcAbs,
          ],
          { timeoutMs: TIMEOUT_LIBREOFFICE_MS, env: { HOME: '/tmp/lo' } }
        );
      } catch (err) {
        translateLibreOfficeError(err);
      }
      const produced = (await fsp.readdir(outDir)).map((f) => path.join(outDir, f));
      const file =
        produced.find((f) => f.toLowerCase().endsWith(`.${target.toLowerCase()}`)) ?? produced[0];
      if (!file) {
        throw new ValidationError(
          `LibreOffice produced no output for --convert-to ${target} -- the source file may use a ` +
            'feature headless LibreOffice cannot render; try readDocument to confirm the file parses ' +
            'normally, or simplify/re-save the source file and retry.'
        );
      }
      // Move out of the temp dir we are about to delete.
      const staged = path.join(os.tmpdir(), `office-staged-${randomUUID()}${path.extname(file)}`);
      await fsp.copyFile(file, staged);
      return staged;
    } finally {
      await fsp.rm(outDir, { recursive: true, force: true }).catch(ignoreError);
      // The per-call profile dir is small; clean it up best-effort.
      await fsp.rm(profilePath, { recursive: true, force: true }).catch(ignoreError);
    }
  });
}

/**
 * `.docx`/`.xlsx`/`.pptx` → PDF via LibreOffice headless (a true render).
 * @param userPath - caller-supplied path to the Office file, under `/workspace`
 * @param outName - output filename/path (optional)
 * @param overwrite - permit overwriting an existing output (default false)
 * @returns The {@link FileResult} for the produced PDF.
 */
export async function officeToPdf(
  userPath: string,
  outName?: string,
  overwrite = false
): Promise<FileResult> {
  const abs = await resolveInputFile(userPath);
  const ext = path.extname(abs).toLowerCase();
  if (!['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.rtf'].includes(ext)) {
    throw new ValidationError(
      `officeToPdf does not support ${ext} — use readDocument or convertOffice`
    );
  }
  const staged = await libreOfficeConvert(abs, 'pdf');
  const dest = await resolveOutputPath(
    outName,
    `${path.basename(abs, ext)}-${Date.now()}.pdf`,
    overwrite
  );
  await atomicMoveOnto(staged, dest);
  return buildFileResult(dest, 'pdf');
}

/**
 * Convert an Office/ODF file to another format from the {@link CONVERT_MATRIX}. Targets outside the matrix are rejected.
 * @param userPath - caller-supplied path to the source file, under `/workspace`
 * @param target - target format token (must be allowed for the source extension)
 * @param outName - output filename/path (optional)
 * @param overwrite - permit overwriting an existing output (default false)
 * @returns The {@link FileResult} for the produced file.
 * @throws {ValidationError} If the source extension is unknown or the target is not allowed for it.
 */
export async function convertOffice(
  userPath: string,
  target: string,
  outName?: string,
  overwrite = false
): Promise<FileResult> {
  const abs = await resolveInputFile(userPath);
  const ext = path.extname(abs).toLowerCase();
  const allowed = CONVERT_MATRIX[ext];
  if (!allowed) {
    throw new ValidationError(`convertOffice does not handle source type ${ext}`);
  }
  const tgt = target.toLowerCase();
  if (!allowed.has(tgt)) {
    throw new ValidationError(
      `convertOffice: ${ext} → ${tgt} is not in the supported matrix (allowed: ${[...allowed].join(', ')})`
    );
  }
  const staged = await libreOfficeConvert(abs, tgt);
  const dest = await resolveOutputPath(
    outName,
    `${path.basename(abs, ext)}-${Date.now()}.${tgt}`,
    overwrite
  );
  await atomicMoveOnto(staged, dest);
  return buildFileResult(dest, tgt);
}
