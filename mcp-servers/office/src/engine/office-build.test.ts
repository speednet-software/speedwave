/**
 * Tests for the DSL validation and orchestration in office-build (python invocation +
 * path resolution are mocked, so this exercises the TypeScript-side validation branches).
 * @module mcp-office/engine/office-build.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { resolveInputFile, resolveOutputPath, runPythonScript } = vi.hoisted(() => ({
  resolveInputFile: vi.fn(async (p: string) => `/workspace/${p}`),
  resolveOutputPath: vi.fn(
    async (_n: string | undefined, base: string) => `/workspace/.speedwave-office/${base}`
  ),
  runPythonScript: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../path-policy.js', () => ({
  resolveInputFile,
  resolveOutputPath,
  PathPolicyError: class PathPolicyError extends Error {},
}));
vi.mock('../subprocess.js', () => ({ runPythonScript }));
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return { ...real, stat: vi.fn(async () => ({ size: 99 })) };
});

import {
  createDocx,
  editDocx,
  createXlsx,
  editXlsx,
  createPptx,
  editPptx,
} from './office-build.js';

beforeEach(() => {
  runPythonScript.mockClear();
  resolveInputFile.mockClear();
  resolveOutputPath.mockClear();
});

describe('createDocx', () => {
  it('builds a docx from a valid spec covering every element type', async () => {
    const spec = {
      elements: [
        { type: 'heading', level: 2, text: 'H' },
        { type: 'paragraph', text: 'P', bold: true, italic: false },
        { type: 'table', header: ['a'], rows: [['1']] },
        { type: 'image', path: 'pic.png' },
        { type: 'pagebreak' },
      ],
    };
    const r = await createDocx(spec, 'out.docx');
    expect(r.format).toBe('docx');
    expect(runPythonScript).toHaveBeenCalledWith(
      'docx_build.py',
      expect.arrayContaining(['create'])
    );
    // The image path was resolved.
    expect(resolveInputFile).toHaveBeenCalledWith('pic.png');
  });

  it('rejects a non-object spec', async () => {
    await expect(createDocx(null)).rejects.toThrow(/spec must be/);
  });

  it('rejects unknown element types and malformed elements', async () => {
    await expect(createDocx({ elements: [{ type: 'video' }] })).rejects.toThrow(
      /unknown element type/
    );
    await expect(createDocx({ elements: ['x'] })).rejects.toThrow(/element must be an object/);
    await expect(
      createDocx({ elements: [{ type: 'heading', level: 9, text: 'x' }] })
    ).rejects.toThrow(/level must be an integer/);
    await expect(createDocx({ elements: [{ type: 'heading', level: 1 }] })).rejects.toThrow(
      /text must be a non-empty string/
    );
    await expect(createDocx({ elements: [{ type: 'paragraph' }] })).rejects.toThrow(/text must be/);
    await expect(
      createDocx({ elements: [{ type: 'table', header: [1], rows: [] }] })
    ).rejects.toThrow(/header must be an array of strings/);
    await expect(
      createDocx({ elements: [{ type: 'table', header: ['a'], rows: [[1]] }] })
    ).rejects.toThrow(/rows must be an array of string arrays/);
    await expect(createDocx({ elements: [{ type: 'image' }] })).rejects.toThrow(/path must be/);
  });
});

describe('editDocx', () => {
  it('applies append/replace_text/delete_paragraph ops, resolving image paths in appends', async () => {
    const ops = [
      { op: 'append', element: { type: 'paragraph', text: 'x' } },
      { op: 'append', element: { type: 'image', path: 'p.png' } },
      { op: 'replace_text', find: 'a', replace: 'b' },
      { op: 'delete_paragraph', index: 0 },
    ];
    const r = await editDocx('src.docx', ops, 'out.docx');
    expect(r.format).toBe('docx');
    expect(resolveInputFile).toHaveBeenCalledWith('src.docx');
    expect(resolveInputFile).toHaveBeenCalledWith('p.png');
  });

  it('rejects non-array ops and unknown / malformed ops', async () => {
    await expect(editDocx('s.docx', 'nope')).rejects.toThrow(/ops must be an array/);
    await expect(editDocx('s.docx', [{ op: 'frobnicate' }])).rejects.toThrow(/unknown op/);
    await expect(
      editDocx('s.docx', [{ op: 'replace_text', find: '', replace: 'x' }])
    ).rejects.toThrow(/find must be/);
    await expect(
      editDocx('s.docx', [{ op: 'replace_text', find: 'a', replace: 1 }])
    ).rejects.toThrow(/replace must be a string/);
    await expect(editDocx('s.docx', [{ op: 'delete_paragraph', index: -1 }])).rejects.toThrow(
      /index must be a non-negative integer/
    );
    await expect(editDocx('s.docx', [{ op: 'append', element: { type: 'bad' } }])).rejects.toThrow(
      /unknown element type/
    );
  });
});

describe('createXlsx / editXlsx', () => {
  it('builds an xlsx from a valid spec with a native chart', async () => {
    const spec = {
      sheets: [
        {
          name: 'S1',
          rows: [['x', 1], ['y', 2], [null]],
          freeze: 'A2',
          charts: [
            {
              type: 'bar',
              title: 'C',
              dataRange: 'S1!B1:B2',
              categoriesRange: 'S1!A1:A2',
              anchor: 'E2',
            },
          ],
        },
      ],
    };
    const r = await createXlsx(spec, 'out.xlsx');
    expect(r.format).toBe('xlsx');
    expect(runPythonScript).toHaveBeenCalledWith(
      'xlsx_build.py',
      expect.arrayContaining(['create'])
    );
  });

  it('rejects malformed xlsx specs', async () => {
    await expect(createXlsx({ sheets: [] })).rejects.toThrow(/at least one sheet/);
    await expect(createXlsx({ sheets: ['x'] })).rejects.toThrow(/sheet must be an object/);
    await expect(createXlsx({ sheets: [{ name: '', rows: [] }] })).rejects.toThrow(/name must be/);
    await expect(createXlsx({ sheets: [{ name: 'S', rows: 'no' }] })).rejects.toThrow(
      /rows must be an array of arrays/
    );
    await expect(createXlsx({ sheets: [{ name: 'S', rows: [[{}]] }] })).rejects.toThrow(
      /cells must be string\|number\|null/
    );
    await expect(createXlsx({ sheets: [{ name: 'S', rows: [], charts: 'no' }] })).rejects.toThrow(
      /charts must be an array/
    );
    await expect(
      createXlsx({ sheets: [{ name: 'S', rows: [], charts: ['notobj'] }] })
    ).rejects.toThrow(/chart must be an object/);
    await expect(
      createXlsx({
        sheets: [{ name: 'S', rows: [], charts: [{ type: 'donut', dataRange: 'a', anchor: 'b' }] }],
      })
    ).rejects.toThrow(/type must be one of/);
    await expect(
      createXlsx({ sheets: [{ name: 'S', rows: [], charts: [{ type: 'bar', anchor: 'b' }] }] })
    ).rejects.toThrow(/dataRange must be/);
  });

  it('applies xlsx edit ops', async () => {
    const ops = [
      { op: 'set_cell', sheet: 'S', cell: 'A1', value: 1 },
      { op: 'set_formula', sheet: 'S', cell: 'B1', formula: 'SUM(A1:A2)' },
      { op: 'add_sheet', name: 'New' },
      { op: 'add_chart', sheet: 'S', chart: { type: 'line', dataRange: 'S!A1:A2', anchor: 'C1' } },
    ];
    const r = await editXlsx('src.xlsx', ops);
    expect(r.format).toBe('xlsx');
  });

  it('rejects malformed xlsx ops', async () => {
    await expect(editXlsx('s.xlsx', 'no')).rejects.toThrow(/ops must be an array/);
    await expect(
      editXlsx('s.xlsx', [{ op: 'set_cell', sheet: '', cell: 'A1', value: 1 }])
    ).rejects.toThrow(/sheet must be/);
    await expect(
      editXlsx('s.xlsx', [{ op: 'set_cell', sheet: 'S', cell: 'A1', value: {} }])
    ).rejects.toThrow(/value must be string\|number\|null/);
    await expect(
      editXlsx('s.xlsx', [{ op: 'set_formula', sheet: 'S', cell: 'A1', formula: '' }])
    ).rejects.toThrow(/formula must be/);
    await expect(editXlsx('s.xlsx', [{ op: 'add_sheet', name: '' }])).rejects.toThrow(
      /name must be/
    );
    await expect(
      editXlsx('s.xlsx', [
        { op: 'add_chart', sheet: 'S', chart: { type: 'bad', dataRange: 'a', anchor: 'b' } },
      ])
    ).rejects.toThrow(/type must be one of/);
    await expect(editXlsx('s.xlsx', [{ op: 'unknown' }])).rejects.toThrow(/unknown op/);
  });
});

describe('createPptx / editPptx', () => {
  it('builds a pptx from a valid spec with bullets, image and chart slides', async () => {
    const spec = {
      slides: [
        { title: 'T', bullets: ['a', 'b'] },
        { title: 'Pic', image: { path: 'p.png' } },
        {
          chart: {
            type: 'column',
            categories: ['x', 'y'],
            series: [{ name: 's', values: [1, 2] }],
            title: 'C',
          },
        },
        { chart: { type: 'xy', categories: ['1', '2'], series: [{ name: 's', values: [3, 4] }] } },
      ],
    };
    const r = await createPptx(spec, 'out.pptx');
    expect(r.format).toBe('pptx');
    expect(resolveInputFile).toHaveBeenCalledWith('p.png');
  });

  it('rejects malformed pptx specs', async () => {
    await expect(createPptx({ slides: [] })).rejects.toThrow(/at least one slide/);
    await expect(createPptx({ slides: ['x'] })).rejects.toThrow(/slide must be an object/);
    await expect(createPptx({ slides: [{ title: 1 }] })).rejects.toThrow(/title must be a string/);
    await expect(createPptx({ slides: [{ bullets: 'no' }] })).rejects.toThrow(
      /bullets must be an array of strings/
    );
    await expect(createPptx({ slides: [{ image: {} }] })).rejects.toThrow(/image.path must be/);
    await expect(createPptx({ slides: [{ chart: 'notobj' }] })).rejects.toThrow(
      /chart must be an object/
    );
    await expect(
      createPptx({ slides: [{ chart: { type: 'donut', categories: [], series: [] } }] })
    ).rejects.toThrow(/type must be one of/);
    await expect(
      createPptx({ slides: [{ chart: { type: 'pie', categories: [1], series: [] } }] })
    ).rejects.toThrow(/categories must be an array of strings/);
    await expect(
      createPptx({ slides: [{ chart: { type: 'pie', categories: ['a'], series: [] } }] })
    ).rejects.toThrow(/series must be a non-empty array/);
    await expect(
      createPptx({
        slides: [
          { chart: { type: 'pie', categories: ['a'], series: [{ name: '', values: [1] }] } },
        ],
      })
    ).rejects.toThrow(/name must be/);
    await expect(
      createPptx({
        slides: [
          { chart: { type: 'pie', categories: ['a'], series: [{ name: 's', values: ['x'] }] } },
        ],
      })
    ).rejects.toThrow(/values must be an array of numbers/);
  });

  it('applies pptx edit ops, resolving image paths in add_slide', async () => {
    const ops = [
      { op: 'add_slide', slide: { title: 'New', image: { path: 'q.png' } } },
      { op: 'set_title', index: 0, text: 'Updated' },
      { op: 'delete_slide', index: 1 },
    ];
    const r = await editPptx('src.pptx', ops);
    expect(r.format).toBe('pptx');
    expect(resolveInputFile).toHaveBeenCalledWith('q.png');
  });

  it('rejects malformed pptx ops', async () => {
    await expect(editPptx('s.pptx', 'no')).rejects.toThrow(/ops must be an array/);
    await expect(editPptx('s.pptx', [{ op: 'set_title', index: -1, text: 'x' }])).rejects.toThrow(
      /index must be a non-negative integer/
    );
    await expect(editPptx('s.pptx', [{ op: 'set_title', index: 0, text: '' }])).rejects.toThrow(
      /text must be/
    );
    await expect(editPptx('s.pptx', [{ op: 'delete_slide', index: -2 }])).rejects.toThrow(
      /index must be a non-negative integer/
    );
    await expect(editPptx('s.pptx', [{ op: 'unknown' }])).rejects.toThrow(/unknown op/);
    await expect(
      editPptx('s.pptx', [
        { op: 'add_slide', slide: { chart: { type: 'bad', categories: [], series: [] } } },
      ])
    ).rejects.toThrow(/type must be one of/);
  });
});
