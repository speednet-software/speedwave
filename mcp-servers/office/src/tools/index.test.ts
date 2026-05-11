/**
 * Tests for the tool definitions and handler dispatch. Engine functions are mocked so the
 * handlers' parameter coercion, the `guard` error wrapper, and the tool metadata are exercised
 * without touching subprocesses.
 * @module mcp-office/tools/index.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Build a fake FileResult-shaped object for the given format. */
function fr(format: string) {
  return {
    path: `/workspace/.speedwave-office/x.${format}`,
    bytes: 10,
    format,
    preview: '',
    truncated: false,
  };
}

// Mock every engine module the tools call. Hoisted so the `vi.mock` factories can reference these.
const eng = vi.hoisted(() => {
  const make = (impl: () => unknown) => vi.fn(async () => impl());
  const file = (format: string) => () => ({
    path: `/workspace/.speedwave-office/x.${format}`,
    bytes: 10,
    format,
    preview: '',
    truncated: false,
  });
  return {
    readDocumentToMarkdown: vi.fn(async () => ({
      content: 'md',
      bytes: 1,
      truncated: false,
      engine: 'sheetjs',
    })),
    readPdfText: vi.fn(async () => ({
      content: 't',
      bytes: 1,
      truncated: false,
      engine: 'pdftotext',
    })),
    markdownToPdf: make(file('pdf')),
    htmlToPdf: make(file('pdf')),
    markdownToDocx: make(file('docx')),
    markdownToPptx: make(file('pptx')),
    renderChart: make(file('png')),
    createDocx: make(file('docx')),
    editDocx: make(file('docx')),
    createXlsx: make(file('xlsx')),
    editXlsx: make(file('xlsx')),
    createPptx: make(file('pptx')),
    editPptx: make(file('pptx')),
    officeToPdf: make(file('pdf')),
    convertOffice: make(file('odt')),
    pdfMetadata: vi.fn(async () => ({ pages: 2 })),
    mergePdf: make(file('pdf')),
    splitPdf: vi.fn(async () => [file('pdf')(), file('pdf')()]),
    rotatePdf: make(file('pdf')),
    watermarkPdf: make(file('pdf')),
    fillPdfForm: make(file('pdf')),
  };
});

vi.mock('../engine/extract.js', () => ({
  readDocumentToMarkdown: eng.readDocumentToMarkdown,
  readPdfText: eng.readPdfText,
}));
vi.mock('../engine/convert.js', () => ({
  markdownToPdf: eng.markdownToPdf,
  htmlToPdf: eng.htmlToPdf,
  markdownToDocx: eng.markdownToDocx,
  markdownToPptx: eng.markdownToPptx,
  officeToPdf: eng.officeToPdf,
  convertOffice: eng.convertOffice,
  CONVERT_MATRIX: { '.docx': new Set(['pdf']) },
}));
vi.mock('../engine/chart.js', () => ({ renderChart: eng.renderChart }));
vi.mock('../engine/office-build.js', () => ({
  createDocx: eng.createDocx,
  editDocx: eng.editDocx,
  createXlsx: eng.createXlsx,
  editXlsx: eng.editXlsx,
  createPptx: eng.createPptx,
  editPptx: eng.editPptx,
}));
vi.mock('../engine/pdf-ops.js', () => ({
  pdfMetadata: eng.pdfMetadata,
  mergePdf: eng.mergePdf,
  splitPdf: eng.splitPdf,
  rotatePdf: eng.rotatePdf,
  watermarkPdf: eng.watermarkPdf,
  fillPdfForm: eng.fillPdfForm,
}));
vi.mock('../config.js', () => ({ DEFAULT_MAX_CHARS: 4000 }));

import { createToolDefinitions, CONVERT_MATRIX } from './index.js';
import type { ToolDefinition } from '@speedwave/mcp-shared';

let defs: ToolDefinition[];
let byName: Map<string, ToolDefinition>;

beforeEach(() => {
  for (const fn of Object.values(eng)) {
    fn.mockClear();
  }
  defs = createToolDefinitions();
  byName = new Map(defs.map((d) => [d.tool.name, d]));
});

/** Call a tool's handler by name with the given params. */
async function call(name: string, params: Record<string, unknown>) {
  const d = byName.get(name);
  if (!d) {
    throw new Error(`no tool ${name}`);
  }
  return d.handler(params);
}

/** Parse the JSON payload out of a successful tool result. */
function payload(res: { content: Array<{ text?: string }>; isError?: boolean }): unknown {
  expect(res.isError).toBeFalsy();
  return JSON.parse(res.content[0].text ?? '');
}

describe('tool metadata', () => {
  it('exposes 21 tools, each with a description, keywords, _meta and inputSchema', () => {
    expect(defs).toHaveLength(21);
    for (const { tool } of defs) {
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(20);
      expect(Array.isArray(tool.keywords) && tool.keywords.length > 0).toBe(true);
      expect(tool._meta).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('shows readDocument and markdownToPdf upfront and defers the rest', () => {
    const shown = defs
      .filter((d) => (d.tool._meta as { deferLoading?: boolean }).deferLoading === false)
      .map((d) => d.tool.name);
    expect(shown.sort()).toEqual(['markdownToPdf', 'readDocument']);
  });

  it('marks LibreOffice/weasyprint/matplotlib tools with timeoutClass long', () => {
    const longTools = new Set([
      'markdownToPdf',
      'htmlToPdf',
      'renderChart',
      'officeToPdf',
      'convertOffice',
    ]);
    for (const { tool } of defs) {
      const tc = (tool._meta as { timeoutClass?: string }).timeoutClass;
      if (longTools.has(tool.name)) {
        expect(tc).toBe('long');
      } else {
        expect(tc).toBeUndefined();
      }
    }
  });

  it('re-exports the conversion matrix', () => {
    expect(CONVERT_MATRIX['.docx']).toBeTruthy();
  });
});

describe('handler dispatch — read', () => {
  it('readDocument passes the path and default maxChars', async () => {
    expect(payload(await call('readDocument', { path: 'a.docx' }))).toEqual({
      content: 'md',
      bytes: 1,
      truncated: false,
      engine: 'sheetjs',
    });
    expect(eng.readDocumentToMarkdown).toHaveBeenCalledWith('a.docx', 4000);
  });

  it('readDocument uses a provided positive integer maxChars and ignores a bad one', async () => {
    await call('readDocument', { path: 'a.docx', maxChars: 7 });
    expect(eng.readDocumentToMarkdown).toHaveBeenCalledWith('a.docx', 7);
    await call('readDocument', { path: 'a.docx', maxChars: -1 });
    expect(eng.readDocumentToMarkdown).toHaveBeenLastCalledWith('a.docx', 4000);
  });

  it('readDocument returns an error result when path is missing', async () => {
    const res = await call('readDocument', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/path is required/);
  });

  it('readPdfText and pdfMetadata work', async () => {
    expect(payload(await call('readPdfText', { path: 'a.pdf' }))).toMatchObject({
      engine: 'pdftotext',
    });
    expect(payload(await call('pdfMetadata', { path: 'a.pdf' }))).toEqual({
      metadata: { pages: 2 },
    });
  });
});

describe('handler dispatch — text inputs and opts', () => {
  it('markdownToPdf forwards input, opts and overwrite', async () => {
    await call('markdownToPdf', {
      input: { markdown: '# x' },
      opts: { pageSize: 'Letter' },
      outName: 'o.pdf',
      overwrite: true,
    });
    expect(eng.markdownToPdf).toHaveBeenCalledWith(
      { markdown: '# x' },
      'o.pdf',
      { pageSize: 'Letter' },
      true
    );
  });

  it('markdownToPdf errors when input is not an object', async () => {
    expect((await call('markdownToPdf', { input: 'x' })).isError).toBe(true);
  });

  it('markdownToPdf errors when opts is not an object', async () => {
    expect((await call('markdownToPdf', { input: { markdown: 'x' }, opts: 'no' })).isError).toBe(
      true
    );
  });

  it('htmlToPdf, markdownToDocx, markdownToPptx forward correctly', async () => {
    await call('htmlToPdf', { input: { html: '<p/>' } });
    expect(eng.htmlToPdf).toHaveBeenCalled();
    await call('markdownToDocx', { input: { path: 'a.md' } });
    expect(eng.markdownToDocx).toHaveBeenCalled();
    await call('markdownToPptx', { input: { path: 'a.md' } });
    expect(eng.markdownToPptx).toHaveBeenCalled();
  });

  it('errors when outName is not a string', async () => {
    expect((await call('markdownToDocx', { input: { markdown: 'x' }, outName: 5 })).isError).toBe(
      true
    );
  });
});

describe('handler dispatch — charts and office builders', () => {
  it('renderChart forwards the spec', async () => {
    await call('renderChart', { spec: { type: 'bar' }, outName: 'c.png' });
    expect(eng.renderChart).toHaveBeenCalledWith({ type: 'bar' }, 'c.png', false);
  });

  it('createDocx/editDocx/createXlsx/editXlsx/createPptx/editPptx forward spec/ops', async () => {
    await call('createDocx', { spec: { elements: [] } });
    expect(eng.createDocx).toHaveBeenCalledWith({ elements: [] }, undefined, false);
    await call('editDocx', { path: 's.docx', ops: [] });
    expect(eng.editDocx).toHaveBeenCalledWith('s.docx', [], undefined, false);
    await call('createXlsx', { spec: { sheets: [] } });
    expect(eng.createXlsx).toHaveBeenCalled();
    await call('editXlsx', { path: 's.xlsx', ops: [] });
    expect(eng.editXlsx).toHaveBeenCalled();
    await call('createPptx', { spec: { slides: [] } });
    expect(eng.createPptx).toHaveBeenCalled();
    await call('editPptx', { path: 's.pptx', ops: [] });
    expect(eng.editPptx).toHaveBeenCalled();
  });

  it('editDocx errors when path is missing', async () => {
    expect((await call('editDocx', { ops: [] })).isError).toBe(true);
  });
});

describe('handler dispatch — convert / pdf ops', () => {
  it('officeToPdf and convertOffice forward args', async () => {
    await call('officeToPdf', { path: 'a.docx' });
    expect(eng.officeToPdf).toHaveBeenCalledWith('a.docx', undefined, false);
    await call('convertOffice', { path: 'a.docx', target: 'pdf' });
    expect(eng.convertOffice).toHaveBeenCalledWith('a.docx', 'pdf', undefined, false);
  });

  it('convertOffice errors when target is missing', async () => {
    expect((await call('convertOffice', { path: 'a.docx' })).isError).toBe(true);
  });

  it('mergePdf validates the paths array', async () => {
    await call('mergePdf', { paths: ['a.pdf', 'b.pdf'] });
    expect(eng.mergePdf).toHaveBeenCalledWith(['a.pdf', 'b.pdf'], undefined, false);
    expect((await call('mergePdf', { paths: 'x' })).isError).toBe(true);
    expect((await call('mergePdf', { paths: [1] })).isError).toBe(true);
  });

  it('splitPdf returns the parts array and validates ranges type', async () => {
    expect(payload(await call('splitPdf', { path: 'a.pdf', ranges: [[1, 2]] }))).toEqual({
      parts: [fr('pdf'), fr('pdf')],
    });
    expect((await call('splitPdf', { path: 'a.pdf', ranges: 'no' })).isError).toBe(true);
  });

  it('rotatePdf validates pages and degrees', async () => {
    await call('rotatePdf', { path: 'a.pdf', pages: [1], degrees: 90 });
    expect(eng.rotatePdf).toHaveBeenCalledWith('a.pdf', [1], 90, undefined, false);
    expect((await call('rotatePdf', { path: 'a.pdf', pages: 'x', degrees: 90 })).isError).toBe(
      true
    );
    expect((await call('rotatePdf', { path: 'a.pdf', pages: [1], degrees: 'x' })).isError).toBe(
      true
    );
  });

  it('watermarkPdf forwards both paths', async () => {
    await call('watermarkPdf', { path: 'a.pdf', watermarkPath: 'w.pdf' });
    expect(eng.watermarkPdf).toHaveBeenCalledWith('a.pdf', 'w.pdf', undefined, false);
  });

  it('fillPdfForm validates fields and the flatten default', async () => {
    await call('fillPdfForm', { path: 'f.pdf', fields: { a: '1' } });
    expect(eng.fillPdfForm).toHaveBeenCalledWith('f.pdf', { a: '1' }, undefined, true, false);
    await call('fillPdfForm', { path: 'f.pdf', fields: { a: '1' }, flatten: false });
    expect(eng.fillPdfForm).toHaveBeenLastCalledWith('f.pdf', { a: '1' }, undefined, false, false);
    expect((await call('fillPdfForm', { path: 'f.pdf', fields: ['x'] })).isError).toBe(true);
  });
});
