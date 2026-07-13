/**
 * Standalone chart rendering — a JSON {@link ChartSpec} → a PNG/SVG image under `/workspace`, produced by `scripts/render_chart.py` (matplotlib, Agg backend). Embeddable into a PDF (`htmlToPdf` `<img>`, PNG or SVG), a `.docx` (`createDocx` image, PNG only — python-docx cannot embed SVG), or a `.pptx` (`createPptx` slide image, PNG).
 * @module mcp-office/engine/chart
 */

import { runPythonScript } from '../subprocess.js';
import { resolveOutputPath } from '../path-policy.js';
import { buildFileResult } from './file-result.js';
import { ValidationError } from '../errors.js';
import type { ChartSpec, FileResult } from '../types.js';

/** Allowed chart kinds for {@link ChartSpec}. */
const CHART_TYPES = new Set(['bar', 'line', 'pie', 'scatter', 'area']);

/**
 * Validate a {@link ChartSpec}: known `type`, non-empty `series`, and each `values` length equal to `labels` length.
 * @param spec - the candidate spec (unknown shape)
 * @returns The validated {@link ChartSpec}.
 * @throws {ValidationError} If the spec is malformed.
 */
export function validateChartSpec(spec: unknown): ChartSpec {
  if (typeof spec !== 'object' || spec === null) {
    throw new ValidationError('renderChart: spec must be an object');
  }
  const s = spec as Partial<ChartSpec> & { data?: { labels?: unknown; series?: unknown } };
  if (!CHART_TYPES.has(String(s.type))) {
    throw new ValidationError(`renderChart: type must be one of ${[...CHART_TYPES].join('|')}`);
  }
  if (s.format !== undefined && s.format !== 'png' && s.format !== 'svg') {
    throw new ValidationError('renderChart: format must be "png" or "svg"');
  }
  for (const [k, v] of Object.entries({ width: s.width, height: s.height })) {
    if (v !== undefined && (typeof v !== 'number' || !(v > 0) || !Number.isFinite(v))) {
      throw new ValidationError(`renderChart: ${k} must be a positive number`);
    }
  }
  if (typeof s.data !== 'object' || s.data === null) {
    throw new ValidationError('renderChart: data must be { labels, series }');
  }
  if (!Array.isArray(s.data.labels) || s.data.labels.some((l) => typeof l !== 'string')) {
    throw new ValidationError('renderChart: data.labels must be an array of strings');
  }
  if (!Array.isArray(s.data.series) || s.data.series.length === 0) {
    throw new ValidationError('renderChart: data.series must be a non-empty array');
  }
  for (let i = 0; i < s.data.series.length; i++) {
    const ser = s.data.series[i] as { name?: unknown; values?: unknown };
    if (typeof ser.name !== 'string' || ser.name.length === 0) {
      throw new ValidationError(`renderChart: data.series[${i}].name must be a non-empty string`);
    }
    if (
      !Array.isArray(ser.values) ||
      ser.values.some((v) => typeof v !== 'number' || !Number.isFinite(v))
    ) {
      throw new ValidationError(
        `renderChart: data.series[${i}].values must be an array of finite numbers`
      );
    }
    if (ser.values.length !== s.data.labels.length) {
      throw new ValidationError(
        `renderChart: data.series[${i}].values length (${ser.values.length}) must equal data.labels length (${s.data.labels.length})`
      );
    }
  }
  return spec as ChartSpec;
}

/**
 * Render a chart to an image file under `/workspace` (`spec` validated here; extension defaults to its `format`).
 * @param spec - the chart spec (validated here)
 * @param outName - output filename/path (optional; extension defaults to the spec's `format`)
 * @param overwrite - permit overwriting an existing output (default false)
 * @returns The {@link FileResult} for the produced image (`format` is `"png"` or `"svg"`).
 */
export async function renderChart(
  spec: unknown,
  outName?: string,
  overwrite = false
): Promise<FileResult> {
  const validated = validateChartSpec(spec);
  const fmt = validated.format ?? 'png';
  const dest = await resolveOutputPath(outName, `chart-${Date.now()}.${fmt}`, overwrite);
  await runPythonScript('render_chart.py', [dest, JSON.stringify(validated)]);
  return buildFileResult(dest, fmt);
}
