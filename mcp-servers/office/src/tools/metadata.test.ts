import { describe, it, expect } from 'vitest';
import { READ_ONLY_ANNOTATIONS, WORKSPACE_WRITE_ANNOTATIONS } from '@speedwave/mcp-shared';
import { createToolDefinitions } from './index.js';

const READ_ONLY_TOOL_NAMES = ['readDocument', 'readPdfText', 'pdfMetadata'];

const WORKSPACE_WRITE_TOOL_NAMES = [
  'markdownToPdf',
  'htmlToPdf',
  'markdownToDocx',
  'markdownToPptx',
  'renderChart',
  'createDocx',
  'editDocx',
  'createXlsx',
  'editXlsx',
  'createPptx',
  'editPptx',
  'officeToPdf',
  'convertOffice',
  'mergePdf',
  'splitPdf',
  'rotatePdf',
  'watermarkPdf',
  'fillPdfForm',
];

describe('Office read-only access annotations', () => {
  const tools = createToolDefinitions().map((td) => td.tool);

  it('lists every tool as either reading or writing only into the workspace', () => {
    expect([...tools.map((t) => t.name)].sort()).toEqual(
      [...READ_ONLY_TOOL_NAMES, ...WORKSPACE_WRITE_TOOL_NAMES].sort()
    );
  });

  it.each(READ_ONLY_TOOL_NAMES)('marks %s with the read-only annotations', (name) => {
    expect(tools.find((t) => t.name === name)?.annotations).toEqual(READ_ONLY_ANNOTATIONS);
  });

  it.each(WORKSPACE_WRITE_TOOL_NAMES)(
    'marks %s with the workspace-write annotations, which read-only mode lets through',
    (name) => {
      const annotations = tools.find((t) => t.name === name)?.annotations;
      expect(annotations).toEqual(WORKSPACE_WRITE_ANNOTATIONS);
      expect(annotations?.readOnlyHint).toBe(true);
    }
  );
});
