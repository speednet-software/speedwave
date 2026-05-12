/**
 * Tests for the PDF-ops orchestration (python invocation + path resolution mocked).
 * @module mcp-office/engine/pdf-ops.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { resolveInputFile, resolveOutputPath, runPythonScript } = vi.hoisted(() => ({
  resolveInputFile: vi.fn(async (p: string) => `/workspace/${p}`),
  resolveOutputPath: vi.fn(
    async (n: string | undefined, base: string) => `/workspace/.speedwave-office/${n ?? base}`
  ),
  runPythonScript: vi.fn(async () => ({ ok: true, metadata: { pages: 3 } })),
}));
vi.mock('../path-policy.js', () => ({
  resolveInputFile,
  resolveOutputPath,
  PathPolicyError: class PathPolicyError extends Error {},
}));
vi.mock('../subprocess.js', () => ({ runPythonScript }));
vi.mock('../config.js', () => ({ MAX_PDF_PAGES: 100 }));
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return { ...real, stat: vi.fn(async () => ({ size: 555 })) };
});

import {
  pdfMetadata,
  mergePdf,
  splitPdf,
  rotatePdf,
  watermarkPdf,
  fillPdfForm,
} from './pdf-ops.js';

beforeEach(() => {
  runPythonScript.mockClear();
  resolveInputFile.mockClear();
  resolveOutputPath.mockClear();
});

describe('pdfMetadata', () => {
  it('returns the metadata object from the script', async () => {
    expect(await pdfMetadata('a.pdf')).toEqual({ pages: 3 });
    expect(runPythonScript).toHaveBeenCalledWith('pdf_ops.py', ['metadata', '/workspace/a.pdf']);
  });

  it('returns {} when the script omits metadata', async () => {
    runPythonScript.mockResolvedValueOnce({ ok: true });
    expect(await pdfMetadata('a.pdf')).toEqual({});
  });
});

describe('mergePdf', () => {
  it('merges two or more PDFs', async () => {
    const r = await mergePdf(['a.pdf', 'b.pdf'], 'm.pdf');
    expect(r.format).toBe('pdf');
    expect(runPythonScript).toHaveBeenCalledWith('pdf_ops.py', [
      'merge',
      '/workspace/.speedwave-office/m.pdf',
      '/workspace/a.pdf',
      '/workspace/b.pdf',
    ]);
  });

  it('rejects fewer than two inputs', async () => {
    await expect(mergePdf(['only.pdf'])).rejects.toThrow(/at least two/);
    // @ts-expect-error — runtime guard
    await expect(mergePdf('x')).rejects.toThrow(/at least two/);
  });

  it('rejects more than the batch cap', async () => {
    const many = Array.from({ length: 201 }, (_, i) => `f${i}.pdf`);
    await expect(mergePdf(many)).rejects.toThrow(/at most 200 input PDFs/);
  });
});

describe('splitPdf', () => {
  it('produces one file per range', async () => {
    const parts = await splitPdf(
      'a.pdf',
      [
        [1, 2],
        [3, 3],
      ],
      'split.pdf'
    );
    expect(parts).toHaveLength(2);
    expect(runPythonScript).toHaveBeenNthCalledWith(1, 'pdf_ops.py', [
      'split',
      '/workspace/a.pdf',
      expect.stringContaining('-part1.pdf'),
      '1',
      '2',
    ]);
  });

  it('uses a generated base when outName is omitted', async () => {
    const parts = await splitPdf('a.pdf', [[1, 1]]);
    expect(parts[0].path).toContain('-part1.pdf');
  });

  it('rejects empty / malformed ranges and out-of-limit ranges', async () => {
    await expect(splitPdf('a.pdf', [])).rejects.toThrow(/at least one/);
    await expect(splitPdf('a.pdf', [[2, 1]] as [number, number][])).rejects.toThrow(
      /Invalid page range/
    );
    await expect(splitPdf('a.pdf', [[1]] as unknown as [number, number][])).rejects.toThrow(
      /Invalid page range/
    );
    await expect(splitPdf('a.pdf', [[1, 999]])).rejects.toThrow(/exceeds the 100-page limit/);
  });

  it('rejects more than the batch cap of ranges', async () => {
    const many = Array.from({ length: 201 }, () => [1, 1] as [number, number]);
    await expect(splitPdf('a.pdf', many)).rejects.toThrow(/at most 200 ranges/);
  });
});

describe('rotatePdf', () => {
  it('rotates the given pages', async () => {
    const r = await rotatePdf('a.pdf', [1, 3], 90, 'rot.pdf');
    expect(r.format).toBe('pdf');
    expect(runPythonScript).toHaveBeenCalledWith('pdf_ops.py', [
      'rotate',
      '/workspace/a.pdf',
      '/workspace/.speedwave-office/rot.pdf',
      '90',
      '1,3',
    ]);
  });

  it('rejects bad degrees and bad page lists', async () => {
    await expect(rotatePdf('a.pdf', [1], 45)).rejects.toThrow(/degrees must be 90, 180, or 270/);
    await expect(rotatePdf('a.pdf', [], 90)).rejects.toThrow(/non-empty list/);
    await expect(rotatePdf('a.pdf', [0], 90)).rejects.toThrow(/non-empty list/);
  });
});

describe('watermarkPdf', () => {
  it('stamps a watermark onto the document', async () => {
    const r = await watermarkPdf('doc.pdf', 'wm.pdf', 'out.pdf');
    expect(r.format).toBe('pdf');
    expect(runPythonScript).toHaveBeenCalledWith('pdf_ops.py', [
      'watermark',
      '/workspace/doc.pdf',
      '/workspace/wm.pdf',
      '/workspace/.speedwave-office/out.pdf',
    ]);
  });
});

describe('fillPdfForm', () => {
  it('fills and flattens by default', async () => {
    const r = await fillPdfForm('form.pdf', { name: 'Ada' }, 'filled.pdf');
    expect(r.format).toBe('pdf');
    expect(runPythonScript).toHaveBeenCalledWith('pdf_ops.py', [
      'fillform',
      '/workspace/form.pdf',
      '/workspace/.speedwave-office/filled.pdf',
      '1',
      JSON.stringify({ name: 'Ada' }),
    ]);
  });

  it('honours flatten=false', async () => {
    await fillPdfForm('form.pdf', { a: '1' }, undefined, false);
    expect(runPythonScript).toHaveBeenCalledWith(
      'pdf_ops.py',
      expect.arrayContaining([
        'fillform',
        '/workspace/form.pdf',
        expect.any(String),
        '0',
        JSON.stringify({ a: '1' }),
      ])
    );
  });

  it('rejects a non-object fields', async () => {
    // @ts-expect-error — runtime guard
    await expect(fillPdfForm('form.pdf', ['x'])).rejects.toThrow(/fields must be an object/);
  });

  it('rejects a non-string field value', async () => {
    // @ts-expect-error — exercising the value-type guard
    await expect(fillPdfForm('form.pdf', { age: 42 })).rejects.toThrow(/must be a string/);
  });

  it('surfaces flattened + fieldWarnings from the script', async () => {
    runPythonScript.mockResolvedValueOnce({
      ok: true,
      flattened: true,
      fill_warnings: ['KeyError: no such field'],
    });
    const r = await fillPdfForm('form.pdf', { name: 'Ada' });
    expect(r.flattened).toBe(true);
    expect(r.fieldWarnings).toEqual(['KeyError: no such field']);
  });

  it('reports flatten:false when the script could not flatten (default flatten requested)', async () => {
    runPythonScript.mockResolvedValueOnce({ ok: true, flattened: false });
    const r = await fillPdfForm('form.pdf', { name: 'Ada' });
    expect(r.flattened).toBe(false);
    expect(r.fieldWarnings).toBeUndefined();
  });
});
