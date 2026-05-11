/**
 * Tests for the convert engine: text-input materialization, the conversion matrix,
 * and the orchestration of pandoc / weasyprint / LibreOffice (all subprocesses mocked).
 * @module mcp-office/engine/convert.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { resolveInputFile, resolveOutputPath, atomicMoveOnto, runOk, fakeFs, readdir } = vi.hoisted(
  () => ({
    resolveInputFile: vi.fn(async (p: string) => `/workspace/${p}`),
    resolveOutputPath: vi.fn(
      async (n: string | undefined, base: string) => `/workspace/.speedwave-office/${n ?? base}`
    ),
    atomicMoveOnto: vi.fn(async () => undefined),
    runOk: vi.fn(async () => ({
      code: 0,
      stdout: '<p>html</p>',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
    })),
    fakeFs: {} as Record<string, string>,
    readdir: vi.fn(async () => ['out.pdf'] as string[]),
  })
);
vi.mock('../path-policy.js', () => ({
  resolveInputFile,
  resolveOutputPath,
  atomicMoveOnto,
  PathPolicyError: class PathPolicyError extends Error {},
}));
vi.mock('../subprocess.js', () => ({ runOk }));
vi.mock('../lo-queue.js', () => ({ libreOfficeQueue: { run: <T>(fn: () => Promise<T>) => fn() } }));
vi.mock('../config.js', () => ({ TIMEOUT_LIBREOFFICE_MS: 1000, MAX_INLINE_BYTES: 100 }));
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return {
    ...real,
    writeFile: vi.fn(async (p: string, d: string) => {
      fakeFs[p] = d;
    }),
    readFile: vi.fn(async (p: string) => fakeFs[p] ?? '<html><head></head><body>x</body></html>'),
    rm: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 321 })),
    mkdtemp: vi.fn(async (prefix: string) => `${prefix}xyz`),
    readdir,
    copyFile: vi.fn(async () => undefined),
  };
});

import {
  markdownToPdf,
  htmlToPdf,
  markdownToDocx,
  markdownToPptx,
  officeToPdf,
  convertOffice,
  CONVERT_MATRIX,
} from './convert.js';

beforeEach(() => {
  runOk.mockClear();
  resolveInputFile.mockClear();
  resolveOutputPath.mockClear();
  atomicMoveOnto.mockClear();
  readdir.mockClear();
  readdir.mockResolvedValue(['out.pdf']);
  for (const k of Object.keys(fakeFs)) {
    delete fakeFs[k];
  }
});

describe('markdownToPdf', () => {
  it('accepts inline markdown, runs pandoc then the weasyprint shim', async () => {
    const r = await markdownToPdf({ markdown: '# Hi' }, 'doc.pdf');
    expect(r).toMatchObject({ format: 'pdf', bytes: 321 });
    // pandoc + python weasyprint shim each invoked.
    expect(runOk).toHaveBeenCalledWith('pandoc', [
      '-f',
      'markdown',
      '-t',
      'html',
      expect.stringMatching(/office-in-.*\.md$/),
    ]);
    expect(runOk).toHaveBeenCalledWith(
      expect.stringContaining('python3'),
      expect.arrayContaining([expect.stringMatching(/weasy-shim-.*\.py$/)])
    );
  });

  it('accepts a path input', async () => {
    await markdownToPdf({ path: 'in.md' });
    expect(resolveInputFile).toHaveBeenCalledWith('in.md');
  });

  it('rejects an input that is neither path nor markdown/html', async () => {
    // @ts-expect-error — exercising the runtime guard
    await expect(markdownToPdf({ foo: 'bar' })).rejects.toThrow(/must be \{ path \}/);
  });

  it('rejects inline content over the size cap', async () => {
    await expect(markdownToPdf({ markdown: 'x'.repeat(200) })).rejects.toThrow(/exceeds 100 bytes/);
  });
});

describe('htmlToPdf', () => {
  it('injects an @page rule into a full HTML document', async () => {
    fakeFs['/workspace/page.html'] = '<html><head></head><body>hello</body></html>';
    resolveInputFile.mockResolvedValueOnce('/workspace/page.html');
    const r = await htmlToPdf({ path: 'page.html' }, 'p.pdf', {
      pageSize: 'Letter',
      landscape: true,
      margin: '10mm',
    });
    expect(r.format).toBe('pdf');
  });

  it('wraps a fragment that is not a full document', async () => {
    fakeFs['/workspace/frag.html'] = '<p>just a fragment</p>';
    resolveInputFile.mockResolvedValueOnce('/workspace/frag.html');
    await htmlToPdf({ path: 'frag.html' });
    expect(runOk).toHaveBeenCalled();
  });

  it('leaves a full document without a head untouched (no head to inject into)', async () => {
    fakeFs['/workspace/nohead.html'] = '<html><body>no head</body></html>';
    resolveInputFile.mockResolvedValueOnce('/workspace/nohead.html');
    await htmlToPdf({ path: 'nohead.html' });
    expect(runOk).toHaveBeenCalled();
  });

  it('accepts inline html', async () => {
    await htmlToPdf({ html: '<p>x</p>' });
    expect(runOk).toHaveBeenCalled();
  });
});

describe('markdownToDocx / markdownToPptx', () => {
  it('runs pandoc with the docx writer', async () => {
    const r = await markdownToDocx({ markdown: '# x' }, 'd.docx');
    expect(r.format).toBe('docx');
    expect(runOk).toHaveBeenCalledWith('pandoc', expect.arrayContaining(['-t', 'docx']));
  });

  it('runs pandoc with the pptx writer (path input)', async () => {
    const r = await markdownToPptx({ path: 'x.md' }, 'p.pptx');
    expect(r.format).toBe('pptx');
    expect(runOk).toHaveBeenCalledWith('pandoc', expect.arrayContaining(['-t', 'pptx']));
  });

  it('runs pandoc with the pptx writer (inline markdown — exercises temp-file cleanup)', async () => {
    const r = await markdownToPptx({ markdown: '# slide' });
    expect(r.format).toBe('pptx');
  });

  it('runs pandoc with the docx writer (inline markdown — exercises temp-file cleanup)', async () => {
    const r = await markdownToDocx({ markdown: '# x' });
    expect(r.format).toBe('docx');
  });
});

describe('officeToPdf', () => {
  it('converts a supported office file via LibreOffice', async () => {
    resolveInputFile.mockResolvedValueOnce('/workspace/a.docx');
    const r = await officeToPdf('a.docx', 'out.pdf');
    expect(r.format).toBe('pdf');
    expect(runOk).toHaveBeenCalledWith(
      'soffice',
      expect.arrayContaining(['--headless', '--convert-to', 'pdf']),
      expect.objectContaining({ env: { HOME: '/tmp/lo' } })
    );
    expect(atomicMoveOnto).toHaveBeenCalled();
  });

  it('rejects an unsupported extension', async () => {
    resolveInputFile.mockResolvedValueOnce('/workspace/a.txt');
    await expect(officeToPdf('a.txt')).rejects.toThrow(/does not support .txt/);
  });

  it('throws when LibreOffice produces nothing', async () => {
    readdir.mockResolvedValueOnce([]);
    resolveInputFile.mockResolvedValueOnce('/workspace/a.docx');
    await expect(officeToPdf('a.docx')).rejects.toThrow(/produced no output/);
  });
});

describe('convertOffice', () => {
  it('exposes the documented matrix', () => {
    expect(CONVERT_MATRIX['.docx']).toBeTruthy();
    expect([...CONVERT_MATRIX['.xlsx']]).toContain('csv');
  });

  it('converts a supported pair', async () => {
    resolveInputFile.mockResolvedValueOnce('/workspace/a.docx');
    const r = await convertOffice('a.docx', 'ODT', 'out.odt');
    expect(r.format).toBe('odt');
  });

  it('rejects an unknown source type', async () => {
    resolveInputFile.mockResolvedValueOnce('/workspace/a.zip');
    await expect(convertOffice('a.zip', 'pdf')).rejects.toThrow(/does not handle source type/);
  });

  it('rejects a target not in the matrix for the source type', async () => {
    resolveInputFile.mockResolvedValueOnce('/workspace/a.xlsx');
    await expect(convertOffice('a.xlsx', 'docx')).rejects.toThrow(/not in the supported matrix/);
  });
});
