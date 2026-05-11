/**
 * Document → Markdown / plain-text extraction.
 * Best-output-wins engine chain: SheetJS for spreadsheet formats (native TS, reads
 * `.xls`/`.xlsb` that markitdown does not), `markitdown` as the primary for
 * `.docx`/`.pptx`/`.pdf`, then `pdftotext`/`pandoc`/the `python-docx` script as
 * fallback. Ported in spirit from the `presale` plugin's extraction engine.
 * @module mcp-office/engine/extract
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as XLSX from 'xlsx';
import { runOk, runPythonScript } from '../subprocess.js';
import { resolveInputFile } from '../path-policy.js';
import { DEFAULT_MAX_CHARS } from '../config.js';
import type { ReadResult } from '../types.js';

/** Spreadsheet extensions handled natively by SheetJS (no subprocess; also reads legacy `.xls`/`.xlsb`). */
const SHEET_EXTS = new Set(['.xlsx', '.xls', '.xlsb', '.xlsm', '.ods', '.csv']);

/**
 * Truncate `text` to `maxChars` characters, reporting whether truncation happened.
 * @param text - The full text.
 * @param maxChars - Maximum number of characters to keep.
 * @returns The (possibly truncated) text and a `truncated` flag.
 */
export function truncate(text: string, maxChars: number): { content: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { content: text, truncated: false };
  }
  return { content: text.slice(0, maxChars), truncated: true };
}

/**
 * Render a parsed SheetJS workbook to Markdown: one `## SheetName` heading per sheet,
 * followed by the sheet as a CSV-derived Markdown table.
 * @param wb - The parsed workbook.
 * @returns A Markdown string covering every sheet.
 */
function workbookToMarkdown(wb: XLSX.WorkBook): string {
  const escape = (cell: string): string => cell.replace(/\|/g, '\\|');
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    parts.push(`## ${name}`);
    // `sheet_to_csv` emits a rectangular grid over the sheet's used range.
    const rows = XLSX.utils
      .sheet_to_csv(sheet)
      .split(/\r?\n/)
      .filter((r) => r.length > 0)
      .map((r) => r.split(',').map(escape));
    if (rows.length === 0) {
      parts.push('_(empty)_');
      continue;
    }
    const [header, ...body] = rows;
    parts.push(`| ${header.join(' | ')} |`);
    parts.push(`| ${header.map(() => '---').join(' | ')} |`);
    for (const row of body) {
      parts.push(`| ${row.join(' | ')} |`);
    }
  }
  return parts.join('\n\n');
}

/**
 * Extract `path` to Markdown using the best available engine for its type.
 * @param userPath - Caller-supplied path to the document, under `/workspace`.
 * @param maxChars - Max characters of Markdown to return (default `DEFAULT_MAX_CHARS`).
 * @returns A {@link ReadResult} with Markdown, source size, truncation flag, and the engine used.
 */
export async function readDocumentToMarkdown(
  userPath: string,
  maxChars: number = DEFAULT_MAX_CHARS
): Promise<ReadResult> {
  const abs = await resolveInputFile(userPath);
  const ext = path.extname(abs).toLowerCase();
  const bytes = (await fsp.stat(abs)).size;

  if (SHEET_EXTS.has(ext)) {
    const buf = await fsp.readFile(abs);
    const wb = XLSX.read(buf, { type: 'buffer' });
    const md = workbookToMarkdown(wb);
    const { content, truncated } = truncate(md, maxChars);
    return { content, bytes, truncated, engine: 'sheetjs' };
  }

  // markitdown handles docx/pptx/pdf/html/images; let it try first.
  try {
    const r = await runOk('markitdown', [abs]);
    const { content, truncated } = truncate(r.stdout, maxChars);
    if (content.trim().length > 0) {
      return { content, bytes, truncated, engine: 'markitdown' };
    }
  } catch {
    // fall through to type-specific fallbacks
  }

  if (ext === '.pdf') {
    const r = await runOk('pdftotext', ['-layout', abs, '-']);
    const { content, truncated } = truncate(r.stdout, maxChars);
    return { content, bytes, truncated, engine: 'pdftotext' };
  }
  if (ext === '.docx') {
    const out = await runPythonScript('python_docx_extract.py', [abs]);
    const md = String(out.markdown ?? '');
    const { content, truncated } = truncate(md, maxChars);
    return { content, bytes, truncated, engine: 'python-docx' };
  }
  // Last resort: pandoc can read many formats and emit Markdown.
  const r = await runOk('pandoc', ['-t', 'markdown', abs]);
  const { content, truncated } = truncate(r.stdout, maxChars);
  return { content, bytes, truncated, engine: 'pandoc' };
}

/**
 * Extract the plain text layer of a PDF (`pdftotext -layout`).
 * @param userPath - Caller-supplied path to the `.pdf`, under `/workspace`.
 * @param maxChars - Max characters of text to return (default `DEFAULT_MAX_CHARS`).
 * @returns A {@link ReadResult} with the text, source size, truncation flag, and `engine: "pdftotext"`.
 */
export async function readPdfText(
  userPath: string,
  maxChars: number = DEFAULT_MAX_CHARS
): Promise<ReadResult> {
  const abs = await resolveInputFile(userPath);
  const bytes = (await fsp.stat(abs)).size;
  const r = await runOk('pdftotext', ['-layout', abs, '-']);
  const { content, truncated } = truncate(r.stdout, maxChars);
  return { content, bytes, truncated, engine: 'pdftotext' };
}
