/**
 * Tests for chart spec validation and `renderChart` (the Python invocation is mocked).
 * @module mcp-office/engine/chart.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateChartSpec } from './chart.js';

const { runPythonScript, resolveOutputPath } = vi.hoisted(() => ({
  runPythonScript: vi.fn(async () => ({ ok: true })),
  resolveOutputPath: vi.fn(
    async (n: string | undefined, base: string) => `/workspace/.speedwave-office/${n ?? base}`
  ),
}));
vi.mock('../subprocess.js', () => ({ runPythonScript }));
vi.mock('../path-policy.js', () => ({
  resolveOutputPath,
  PathPolicyError: class PathPolicyError extends Error {},
}));
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return { ...real, stat: vi.fn(async () => ({ size: 1234 })) };
});

import { renderChart } from './chart.js';

const goodSpec = {
  type: 'bar' as const,
  title: 'T',
  data: { labels: ['a', 'b'], series: [{ name: 's1', values: [1, 2] }] },
};

describe('validateChartSpec', () => {
  it('accepts a well-formed spec', () => {
    expect(validateChartSpec(goodSpec)).toBe(goodSpec);
  });

  it('accepts every chart type and svg format and sizes', () => {
    for (const type of ['bar', 'line', 'pie', 'scatter', 'area'] as const) {
      validateChartSpec({ ...goodSpec, type, format: 'svg', width: 10, height: 6 });
    }
  });

  it('rejects a non-object spec', () => {
    expect(() => validateChartSpec(null)).toThrow(/must be an object/);
  });

  it('rejects an unknown type', () => {
    expect(() => validateChartSpec({ ...goodSpec, type: 'donut' })).toThrow(/type must be one of/);
  });

  it('rejects a bad format', () => {
    expect(() => validateChartSpec({ ...goodSpec, format: 'jpeg' })).toThrow(/format must be/);
  });

  it('rejects non-positive width/height', () => {
    expect(() => validateChartSpec({ ...goodSpec, width: 0 })).toThrow(
      /width must be a positive number/
    );
    expect(() => validateChartSpec({ ...goodSpec, height: -1 })).toThrow(
      /height must be a positive number/
    );
  });

  it('rejects a missing or non-object data', () => {
    expect(() => validateChartSpec({ ...goodSpec, data: undefined })).toThrow(/data must be/);
  });

  it('rejects non-string labels', () => {
    expect(() =>
      validateChartSpec({ ...goodSpec, data: { labels: [1], series: goodSpec.data.series } })
    ).toThrow(/labels must be an array of strings/);
  });

  it('rejects empty or non-array series', () => {
    expect(() => validateChartSpec({ ...goodSpec, data: { labels: ['a'], series: [] } })).toThrow(
      /series must be a non-empty array/
    );
  });

  it('rejects a series with a missing name', () => {
    expect(() =>
      validateChartSpec({
        ...goodSpec,
        data: { labels: ['a'], series: [{ name: '', values: [1] }] },
      })
    ).toThrow(/name must be a non-empty string/);
  });

  it('rejects a series with non-finite or non-number values', () => {
    expect(() =>
      validateChartSpec({
        ...goodSpec,
        data: { labels: ['a'], series: [{ name: 's', values: ['x'] }] },
      })
    ).toThrow(/values must be an array of finite numbers/);
    expect(() =>
      validateChartSpec({
        ...goodSpec,
        data: { labels: ['a'], series: [{ name: 's', values: [Infinity] }] },
      })
    ).toThrow(/values must be an array of finite numbers/);
  });

  it('rejects a values length mismatch', () => {
    expect(() =>
      validateChartSpec({
        ...goodSpec,
        data: { labels: ['a', 'b'], series: [{ name: 's', values: [1] }] },
      })
    ).toThrow(/length .* must equal/);
  });
});

describe('renderChart', () => {
  beforeEach(() => {
    runPythonScript.mockClear();
  });

  it('validates, invokes the python script, and returns a FileResult (png default)', async () => {
    const r = await renderChart(goodSpec);
    expect(r).toEqual({
      path: '/workspace/.speedwave-office/chart-' + r.path.split('chart-')[1],
      bytes: 1234,
      format: 'png',
      preview: '',
      truncated: false,
    });
    expect(runPythonScript).toHaveBeenCalledWith('render_chart.py', [
      r.path,
      JSON.stringify(goodSpec),
    ]);
  });

  it('honours the requested format extension', async () => {
    const r = await renderChart({ ...goodSpec, format: 'svg' }, 'mychart');
    expect(r.format).toBe('svg');
  });

  it('propagates a validation error before invoking python', async () => {
    await expect(renderChart({ type: 'bad' })).rejects.toThrow(/type must be one of/);
    expect(runPythonScript).not.toHaveBeenCalled();
  });
});
