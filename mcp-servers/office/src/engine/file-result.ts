/**
 * The single {@link FileResult} builder for everything the office worker produces.
 * @module mcp-office/engine/file-result
 */

import * as fsp from 'node:fs/promises';
import { truncate } from './extract.js';
import type { FileResult } from '../types.js';

/** Preview cap (chars) for the optional text snippet returned alongside a produced file. */
const PREVIEW_CHARS = 2000;

/**
 * Build a {@link FileResult} for a file already written under `/workspace`.
 * @param absPath - Absolute path of the produced file.
 * @param format - Output format token (e.g. `"pdf"`, `"docx"`, `"png"`).
 * @param previewText - Optional text to expose as a capped preview; omitted/empty → no preview.
 * @returns The result envelope with `bytes` (from `stat`), `preview` (≤ {@link PREVIEW_CHARS}), and `truncated`.
 */
export async function buildFileResult(
  absPath: string,
  format: string,
  previewText = ''
): Promise<FileResult> {
  const bytes = (await fsp.stat(absPath)).size;
  const { content, truncated } = truncate(previewText, PREVIEW_CHARS);
  return { path: absPath, bytes, format, preview: content, truncated };
}
