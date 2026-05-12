/**
 * Tests for the extraction engine: SheetJS spreadsheet → Markdown, the markitdown-first
 * chain with format-specific fallbacks, truncation, and `readPdfText`.
 * @module mcp-office/engine/extract.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { resolveInputFile, runOk, runPythonScript, fileBytes } = vi.hoisted(() => ({
  resolveInputFile: vi.fn(async (p: string) => `/workspace/${p}`),
  runOk: vi.fn(),
  runPythonScript: vi.fn(),
  fileBytes: {} as Record<string, Buffer>,
}));
vi.mock('../path-policy.js', () => ({
  resolveInputFile,
  PathPolicyError: class PathPolicyError extends Error {},
}));
vi.mock('../subprocess.js', () => ({ runOk, runPythonScript }));
vi.mock('../config.js', () => ({ DEFAULT_MAX_CHARS: 4000 }));
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return {
    ...real,
    readFile: vi.fn(async (p: string) => fileBytes[p] ?? Buffer.from('')),
    stat: vi.fn(async () => ({ size: 42 })),
  };
});

// Build a tiny real .xlsx in memory so the SheetJS path is exercised end-to-end.
import * as XLSX from 'xlsx';
function makeWorkbookBuffer(): Buffer {
  const wb = XLSX.utils.book_new();
  // Ragged sheet: header row is 3 wide, a later row is 1 wide (short-row padding path). One cell
  // contains a comma and one contains a pipe — exercises both the comma-safe parsing and pipe-escaping.
  const ws = XLSX.utils.aoa_to_sheet([
    ['Name', 'Score', 'Note'],
    ['Ada', 10, 'hello, world'],
    ['Bo|b'],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), 'Empty');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

import { readDocumentToMarkdown, readPdfText, truncate } from './extract.js';

beforeEach(() => {
  runOk.mockReset();
  runPythonScript.mockReset();
  resolveInputFile.mockClear();
  for (const k of Object.keys(fileBytes)) {
    delete fileBytes[k];
  }
});

describe('truncate', () => {
  it('returns the text unchanged when within the limit', () => {
    expect(truncate('hello', 10)).toEqual({ content: 'hello', truncated: false });
  });
  it('truncates and flags when over the limit', () => {
    expect(truncate('hello', 3)).toEqual({ content: 'hel', truncated: true });
  });
});

describe('readDocumentToMarkdown — spreadsheets (SheetJS)', () => {
  it('renders an .xlsx to Markdown tables — pipes escaped, commas kept in-cell, short rows padded', async () => {
    fileBytes['/workspace/data.xlsx'] = makeWorkbookBuffer();
    const r = await readDocumentToMarkdown('data.xlsx');
    expect(r.engine).toBe('sheetjs');
    expect(r.content).toContain('## Sheet1');
    expect(r.content).toContain('| Name | Score | Note |');
    // A cell containing a comma stays in one column (not split): `| Ada | 10 | hello, world |`.
    expect(r.content).toContain('| Ada | 10 | hello, world |');
    // The pipe in "Bo|b" is escaped, and the short row is padded to the table width.
    expect(r.content).toMatch(/\| Bo\\\|b \| {2}\| {2}\|/);
    expect(r.content).toContain('## Empty');
    expect(r.content).toContain('_(empty)_');
    expect(runOk).not.toHaveBeenCalled();
  });

  it('truncates the Markdown to maxChars', async () => {
    fileBytes['/workspace/data.xlsx'] = makeWorkbookBuffer();
    const r = await readDocumentToMarkdown('data.xlsx', 5);
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBe(5);
  });

  it('reads a .csv via SheetJS too', async () => {
    fileBytes['/workspace/d.csv'] = Buffer.from('a,b\n1,2\n');
    const r = await readDocumentToMarkdown('d.csv');
    expect(r.engine).toBe('sheetjs');
    expect(r.content).toContain('| a | b |');
    expect(r.content).toContain('| 1 | 2 |');
    expect(runOk).not.toHaveBeenCalled();
  });

  it('escapes a backslash before a pipe (literal `\\|` round-trips as `\\\\\\|`)', async () => {
    fileBytes['/workspace/bs.csv'] = Buffer.from('"a\\|b"\n');
    const r = await readDocumentToMarkdown('bs.csv');
    // `\|` in the cell → `\\` (escaped backslash) then `\|` (escaped pipe) → `\\\|`.
    expect(r.content).toContain('| a\\\\\\|b |');
  });

  it('collapses newlines inside a cell so the table row stays intact', async () => {
    fileBytes['/workspace/nl.csv'] = Buffer.from('"line1\nline2",b\n');
    const r = await readDocumentToMarkdown('nl.csv');
    expect(r.content).toContain('| line1 line2 | b |');
    expect(r.content).not.toContain('line1\nline2');
  });
});

describe('readDocumentToMarkdown — markitdown chain', () => {
  it('uses markitdown when it returns content', async () => {
    runOk.mockResolvedValueOnce({
      stdout: '# From markitdown',
      stderr: '',
      code: 0,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    const r = await readDocumentToMarkdown('a.docx');
    expect(r.engine).toBe('markitdown');
    expect(r.content).toBe('# From markitdown');
  });

  it('falls back to pdftotext for a .pdf when markitdown yields nothing', async () => {
    runOk
      .mockResolvedValueOnce({
        stdout: '   ',
        stderr: '',
        code: 0,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }) // markitdown empty
      .mockResolvedValueOnce({
        stdout: 'pdf text',
        stderr: '',
        code: 0,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }); // pdftotext
    const r = await readDocumentToMarkdown('a.pdf');
    expect(r.engine).toBe('pdftotext');
    expect(r.content).toBe('pdf text');
  });

  it('falls back to the python-docx script for a .docx when markitdown throws', async () => {
    runOk.mockRejectedValueOnce(new Error('markitdown crashed'));
    runPythonScript.mockResolvedValueOnce({ ok: true, markdown: '# via python-docx' });
    const r = await readDocumentToMarkdown('a.docx');
    expect(r.engine).toBe('python-docx');
    expect(r.content).toBe('# via python-docx');
  });

  it('falls back to pandoc for an unknown extension when markitdown yields nothing', async () => {
    runOk
      .mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        code: 0,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }) // markitdown
      .mockResolvedValueOnce({
        stdout: 'pandoc md',
        stderr: '',
        code: 0,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }); // pandoc
    const r = await readDocumentToMarkdown('a.rtf');
    expect(r.engine).toBe('pandoc');
    expect(r.content).toBe('pandoc md');
  });
});

describe('readPdfText', () => {
  it('returns the pdftotext output', async () => {
    runOk.mockResolvedValueOnce({
      stdout: 'raw pdf text',
      stderr: '',
      code: 0,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    const r = await readPdfText('a.pdf');
    expect(r.engine).toBe('pdftotext');
    expect(r.content).toBe('raw pdf text');
    expect(runOk).toHaveBeenCalledWith('pdftotext', ['-layout', '/workspace/a.pdf', '-']);
  });

  it('truncates when over maxChars', async () => {
    runOk.mockResolvedValueOnce({
      stdout: 'abcdef',
      stderr: '',
      code: 0,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    const r = await readPdfText('a.pdf', 3);
    expect(r.content).toBe('abc');
    expect(r.truncated).toBe(true);
  });
});
