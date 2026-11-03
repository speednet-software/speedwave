import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolsCallResult } from '@speedwave/mcp-shared';

const eng = vi.hoisted(() => ({
  readDocumentToMarkdown: vi.fn(),
  readPdfText: vi.fn(),
  markdownToPdf: vi.fn(),
  htmlToPdf: vi.fn(),
  markdownToDocx: vi.fn(),
  markdownToPptx: vi.fn(),
  officeToPdf: vi.fn(),
  convertOffice: vi.fn(),
  renderChart: vi.fn(),
  createDocx: vi.fn(),
  editDocx: vi.fn(),
  createXlsx: vi.fn(),
  editXlsx: vi.fn(),
  createPptx: vi.fn(),
  editPptx: vi.fn(),
  pdfMetadata: vi.fn(),
  mergePdf: vi.fn(),
  splitPdf: vi.fn(),
  rotatePdf: vi.fn(),
  watermarkPdf: vi.fn(),
  fillPdfForm: vi.fn(),
}));

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
  CONVERT_MATRIX: {},
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

import { createToolDefinitions } from './index.js';

const textOf = (result: ToolsCallResult): string => (result.content[0] as { text: string }).text;

const tools = createToolDefinitions();

describe('Office declared-parameter guard', () => {
  beforeEach(() => {
    for (const fn of Object.values(eng)) {
      fn.mockReset();
    }
  });

  describe.each(tools.map((d) => [d.tool.name, d] as const))('%s', (_name, def) => {
    it('rejects an undeclared argument before any engine runs', async () => {
      const result = await def.handler({ not_a_declared_param: 1 });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(`${def.tool.name} does not accept this parameter`);
      for (const fn of Object.values(eng)) {
        expect(fn).not.toHaveBeenCalled();
      }
    });
  });

  it('rejects a misspelled output option instead of writing to the default name', async () => {
    const markdownToPdf = tools.find((d) => d.tool.name === 'markdownToPdf')!.handler;

    const result = await markdownToPdf({ input: { markdown: '# T' }, outname: 'x.pdf' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('outname');
    expect(textOf(result)).toMatch(/Accepted parameters: .*outName/);
    expect(eng.markdownToPdf).not.toHaveBeenCalled();
  });

  it('lets a call with only declared arguments reach the engine', async () => {
    eng.readDocumentToMarkdown.mockResolvedValue({
      content: 'md',
      bytes: 2,
      truncated: false,
      engine: 'sheetjs',
    });
    const readDocument = tools.find((d) => d.tool.name === 'readDocument')!.handler;

    const result = await readDocument({ path: '/workspace/a.docx', maxChars: 10 });

    expect(result.isError).toBeUndefined();
    expect(eng.readDocumentToMarkdown).toHaveBeenCalledWith('/workspace/a.docx', 10);
    expect(JSON.parse(textOf(result))).toMatchObject({ content: 'md' });
  });
});
