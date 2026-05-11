/**
 * Document generation and conversion: Markdown/HTML → PDF/DOCX/PPTX (pandoc + weasyprint)
 * and Office → PDF / Office ↔ Office (LibreOffice headless, serialized via the LO queue).
 * @module mcp-office/engine/convert
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runOk } from '../subprocess.js';
import { libreOfficeQueue } from '../lo-queue.js';
import { ignoreError } from '../util.js';
import {
  resolveInputFile,
  resolveOutputPath,
  atomicMoveOnto,
  PathPolicyError,
} from '../path-policy.js';
import { TIMEOUT_LIBREOFFICE_MS, MAX_INLINE_BYTES } from '../config.js';
import { truncate } from './extract.js';
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
 * Resolve a {@link TextInput} to a concrete file path: a provided path is validated as an input file;
 * inline content (≤ `MAX_INLINE_BYTES`) is written to a temp file with the given extension.
 * @param input - The text input (path or inline).
 * @param inlineExt - Extension to use for the temp file when content is inline (e.g. `".md"`, `".html"`).
 * @returns The path to use and whether it is a temp file the caller should delete.
 * @throws {PathPolicyError} When inline content exceeds the size cap, or when `input` has no recognized key.
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
    throw new PathPolicyError('Input must be { path } or { markdown } / { html }');
  }
  if (Buffer.byteLength(inline, 'utf8') > MAX_INLINE_BYTES) {
    throw new PathPolicyError(
      `Inline content exceeds ${MAX_INLINE_BYTES} bytes — write it to a file under /workspace and pass { path } instead`
    );
  }
  const tmp = path.join(os.tmpdir(), `office-in-${randomUUID()}${inlineExt}`);
  await fsp.writeFile(tmp, inline);
  return { filePath: tmp, isTemp: true };
}

/**
 * Build a minimal print-oriented HTML wrapper around `bodyHtml` with `@page` rules from `opts`.
 * @param bodyHtml - The HTML body fragment to wrap.
 * @param opts - Page-rendering options.
 */
function wrapPrintHtml(bodyHtml: string, opts: PdfOptions): string {
  const size = `${opts.pageSize ?? 'A4'}${opts.landscape ? ' landscape' : ''}`;
  const margin = opts.margin ?? '18mm';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@page { size: ${size}; margin: ${margin}; }
body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; line-height: 1.5; }
pre, code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
pre { background:#f6f8fa; padding:12px; border-radius:6px; overflow:auto; }
table { border-collapse: collapse; } th, td { border: 1px solid #ccc; padding: 4px 8px; }
img { max-width: 100%; }
</style></head><body>${bodyHtml}</body></html>`;
}

/** A WeasyPrint `url_fetcher` (passed via a tiny Python shim) that only resolves `file://` URLs under `/workspace`. */
const WEASYPRINT_LOCALONLY_FETCHER = `
import sys, weasyprint
from weasyprint import default_url_fetcher
def fetcher(url, timeout=10, ssl_context=None):
    if not url.startswith('file:'):
        raise ValueError('remote resources are not allowed: ' + url)
    from urllib.parse import urlparse, unquote
    p = unquote(urlparse(url).path)
    import os
    rp = os.path.realpath(p)
    if not (rp == '/workspace' or rp.startswith('/workspace/')):
        raise ValueError('resource outside /workspace: ' + url)
    return default_url_fetcher(url, timeout=timeout, ssl_context=ssl_context)
src, dst, base = sys.argv[1], sys.argv[2], sys.argv[3]
weasyprint.HTML(filename=src, base_url=base, url_fetcher=fetcher).write_pdf(dst)
print('{"ok": true}')
`;

/**
 * Render an HTML file to PDF via WeasyPrint, restricting resource loading to `file://` under `/workspace`.
 * @param htmlAbs - Absolute path of the source HTML.
 * @param baseUrl - Base URL for resolving relative resources (a `file://` URL under `/workspace`).
 * @param destAbs - Absolute destination path for the PDF (already validated).
 */
async function htmlFileToPdf(htmlAbs: string, baseUrl: string, destAbs: string): Promise<void> {
  const tmpPdf = path.join(os.tmpdir(), `office-pdf-${randomUUID()}.pdf`);
  const tmpShim = path.join(os.tmpdir(), `weasy-shim-${randomUUID()}.py`);
  await fsp.writeFile(tmpShim, WEASYPRINT_LOCALONLY_FETCHER);
  try {
    await runOk(`${process.env.OFFICE_VENV ?? '/opt/office-venv'}/bin/python3`, [
      tmpShim,
      htmlAbs,
      tmpPdf,
      baseUrl,
    ]);
    await atomicMoveOnto(tmpPdf, destAbs);
  } finally {
    await fsp.rm(tmpShim, { force: true }).catch(ignoreError);
    await fsp.rm(tmpPdf, { force: true }).catch(ignoreError);
  }
}

/**
 * Read a produced file's size and a short text preview (only meaningful for text-ish formats).
 * @param absPath - Absolute path of the file.
 * @param format - Output format token (e.g. "pdf").
 * @param previewText - Text to use for the result preview.
 */
async function fileResult(absPath: string, format: string, previewText = ''): Promise<FileResult> {
  const bytes = (await fsp.stat(absPath)).size;
  const { content, truncated } = truncate(previewText, 2000);
  return { path: absPath, bytes, format, preview: content, truncated };
}

/**
 * Markdown (path or inline) → PDF via pandoc → HTML → WeasyPrint.
 * @param input - The Markdown source.
 * @param outName - Output filename/path (optional; defaults under `/workspace/.speedwave-office/`).
 * @param opts - Page-rendering options.
 * @param overwrite - Permit overwriting an existing output (default false).
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
    const html = wrapPrintHtml(r.stdout, opts);
    const tmpHtml = path.join(os.tmpdir(), `office-html-${randomUUID()}.html`);
    await fsp.writeFile(tmpHtml, html);
    const dest = await resolveOutputPath(outName, `document-${Date.now()}.pdf`, overwrite);
    try {
      await htmlFileToPdf(tmpHtml, `file://${path.dirname(filePath)}/`, dest);
    } finally {
      await fsp.rm(tmpHtml, { force: true }).catch(ignoreError);
    }
    return fileResult(dest, 'pdf');
  } finally {
    if (isTemp) {
      await fsp.rm(filePath, { force: true }).catch(ignoreError);
    }
  }
}

/**
 * HTML (path or inline) → PDF via WeasyPrint (local resources only).
 * @param input - The HTML source.
 * @param outName - Output filename/path (optional).
 * @param opts - Page-rendering options (applied as an injected `@page` rule when the HTML has no `<head>`).
 * @param overwrite - Permit overwriting an existing output (default false).
 * @returns The {@link FileResult} for the produced PDF.
 */
export async function htmlToPdf(
  input: TextInput,
  outName?: string,
  opts: PdfOptions = {},
  overwrite = false
): Promise<FileResult> {
  const { filePath, isTemp } = await materializeTextInput(input, '.html');
  try {
    // If the HTML looks like a fragment, wrap it; otherwise inject our @page rule before </head>.
    const raw = await fsp.readFile(filePath, 'utf8');
    const pageRule = `<style>@page{size:${opts.pageSize ?? 'A4'}${
      opts.landscape ? ' landscape' : ''
    };margin:${opts.margin ?? '18mm'};}</style>`;
    let finalHtml: string;
    if (/<html[\s>]/i.test(raw)) {
      finalHtml = /<\/head>/i.test(raw) ? raw.replace(/<\/head>/i, `${pageRule}</head>`) : raw;
    } else {
      finalHtml = wrapPrintHtml(raw, opts);
    }
    const tmpHtml = path.join(os.tmpdir(), `office-html-${randomUUID()}.html`);
    await fsp.writeFile(tmpHtml, finalHtml);
    const dest = await resolveOutputPath(outName, `document-${Date.now()}.pdf`, overwrite);
    try {
      await htmlFileToPdf(tmpHtml, `file://${path.dirname(filePath)}/`, dest);
    } finally {
      await fsp.rm(tmpHtml, { force: true }).catch(ignoreError);
    }
    return fileResult(dest, 'pdf');
  } finally {
    if (isTemp) {
      await fsp.rm(filePath, { force: true }).catch(ignoreError);
    }
  }
}

/**
 * Markdown (path or inline) → `.docx` via pandoc.
 * @param input - The Markdown source.
 * @param outName - Output filename/path (optional).
 * @param overwrite - Permit overwriting an existing output (default false).
 * @returns The {@link FileResult} for the produced `.docx`.
 */
export async function markdownToDocx(
  input: TextInput,
  outName?: string,
  overwrite = false
): Promise<FileResult> {
  const { filePath, isTemp } = await materializeTextInput(input, '.md');
  try {
    const dest = await resolveOutputPath(outName, `document-${Date.now()}.docx`, overwrite);
    await runOk('pandoc', ['-f', 'markdown', '-t', 'docx', '-o', dest, filePath]);
    return fileResult(dest, 'docx');
  } finally {
    if (isTemp) {
      await fsp.rm(filePath, { force: true }).catch(ignoreError);
    }
  }
}

/**
 * Markdown (path or inline) → `.pptx` via pandoc's pptx writer (one slide per top-level heading).
 * @param input - The Markdown source.
 * @param outName - Output filename/path (optional).
 * @param overwrite - Permit overwriting an existing output (default false).
 * @returns The {@link FileResult} for the produced `.pptx`.
 */
export async function markdownToPptx(
  input: TextInput,
  outName?: string,
  overwrite = false
): Promise<FileResult> {
  const { filePath, isTemp } = await materializeTextInput(input, '.md');
  try {
    const dest = await resolveOutputPath(outName, `presentation-${Date.now()}.pptx`, overwrite);
    await runOk('pandoc', ['-f', 'markdown', '-t', 'pptx', '-o', dest, filePath]);
    return fileResult(dest, 'pptx');
  } finally {
    if (isTemp) {
      await fsp.rm(filePath, { force: true }).catch(ignoreError);
    }
  }
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

/**
 * Run `soffice --headless --convert-to <fmt>` on `srcAbs` into a fresh temp dir with a per-call user profile,
 * serialized through the LibreOffice queue. Returns the produced file's temp path.
 * @param srcAbs - Absolute path of the source Office file.
 * @param target - Target format token (e.g. `"pdf"`).
 * @returns The absolute path of the produced file under a temp directory.
 * @throws {Error} If LibreOffice produces no output file.
 */
async function libreOfficeConvert(srcAbs: string, target: string): Promise<string> {
  return libreOfficeQueue.run(async () => {
    const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'office-lo-'));
    const profile = `file://${path.join(os.tmpdir(), `lo-profile-${randomUUID()}`)}`;
    try {
      await runOk(
        'soffice',
        [
          '--headless',
          '--norestore',
          '--nologo',
          '--nofirststartwizard',
          `-env:UserInstallation=${profile}`,
          '--convert-to',
          target,
          '--outdir',
          outDir,
          srcAbs,
        ],
        { timeoutMs: TIMEOUT_LIBREOFFICE_MS, env: { HOME: '/tmp/lo' } }
      );
      const produced = (await fsp.readdir(outDir)).map((f) => path.join(outDir, f));
      const file =
        produced.find((f) => f.toLowerCase().endsWith(`.${target.toLowerCase()}`)) ?? produced[0];
      if (!file) {
        throw new Error(`LibreOffice produced no output for --convert-to ${target}`);
      }
      // Move out of the temp dir we are about to delete.
      const staged = path.join(os.tmpdir(), `office-staged-${randomUUID()}${path.extname(file)}`);
      await fsp.copyFile(file, staged);
      return staged;
    } finally {
      await fsp.rm(outDir, { recursive: true, force: true }).catch(ignoreError);
      // The per-call profile dir is small; clean it up best-effort.
      await fsp
        .rm(profile.replace('file://', ''), { recursive: true, force: true })
        .catch(ignoreError);
    }
  });
}

/**
 * `.docx`/`.xlsx`/`.pptx` → PDF via LibreOffice headless (a true render).
 * @param userPath - Caller-supplied path to the Office file, under `/workspace`.
 * @param outName - Output filename/path (optional).
 * @param overwrite - Permit overwriting an existing output (default false).
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
    throw new PathPolicyError(
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
  return fileResult(dest, 'pdf');
}

/**
 * Convert an Office/ODF file to another format from the {@link CONVERT_MATRIX}. Targets outside the matrix are rejected.
 * @param userPath - Caller-supplied path to the source file, under `/workspace`.
 * @param target - Target format token (must be allowed for the source extension).
 * @param outName - Output filename/path (optional).
 * @param overwrite - Permit overwriting an existing output (default false).
 * @returns The {@link FileResult} for the produced file.
 * @throws {PathPolicyError} If the source extension is unknown or the target is not allowed for it.
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
    throw new PathPolicyError(`convertOffice does not handle source type ${ext}`);
  }
  const tgt = target.toLowerCase();
  if (!allowed.has(tgt)) {
    throw new PathPolicyError(
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
  return fileResult(dest, tgt);
}
