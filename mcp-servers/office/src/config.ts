/**
 * Static configuration for the office worker — paths, limits, timeouts.
 * All values are fixed at build time except those overridable via env (documented).
 * @module mcp-office/config
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root of the mounted project workspace inside the container (compose mounts `${PROJECT_DIR}:/workspace:rw`). */
export const WORKSPACE_ROOT = '/workspace';

/** Default output directory for generated files — kept under `/workspace/.speedwave/` so an exploited parser cannot overwrite `.git`/config/scripts. */
export const OUTPUT_DIR = path.join(WORKSPACE_ROOT, '.speedwave', 'office');

/** Path to the Python virtualenv created in the Dockerfile (`/opt/office-venv`). The `python3` binary used for support-scripts. */
export const PYTHON_BIN = `${process.env.OFFICE_VENV ?? '/opt/office-venv'}/bin/python3`;

/** Directory holding the Python support-scripts (`scripts/*.py`), relative to the built `dist/` directory. */
export const SCRIPTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts'
);

/** Max size of an input file the worker will process (anti-zip-bomb / anti-DoS). Override: `OFFICE_MAX_INPUT_BYTES`. */
export const MAX_INPUT_BYTES = parsePositiveInt(
  process.env.OFFICE_MAX_INPUT_BYTES,
  50 * 1024 * 1024
);

/** Max size of inline `markdown`/`html`/JSON-`spec` payloads (the shared Express body limit is 1 MB; keep well under it). */
export const MAX_INLINE_BYTES = 200 * 1024;

/** Max PDF page count the worker will operate on. */
export const MAX_PDF_PAGES = parsePositiveInt(process.env.OFFICE_MAX_PDF_PAGES, 2000);

/** Per-subprocess wall-time timeout (ms) for standard tools (pandoc, weasyprint, python scripts, markitdown). */
export const TIMEOUT_STANDARD_MS = parsePositiveInt(process.env.OFFICE_TIMEOUT_STANDARD_MS, 60_000);

/** Per-subprocess wall-time timeout (ms) for LibreOffice conversions (slow cold start + render). */
export const TIMEOUT_LIBREOFFICE_MS = parsePositiveInt(process.env.OFFICE_TIMEOUT_LO_MS, 120_000);

/** Cap on captured stdout/stderr per subprocess (bytes) — without this, a chatty tool can exhaust worker memory. */
export const MAX_SUBPROCESS_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Default `maxChars` for text previews returned by read/convert tools — keeps large documents out of the model context. */
export const DEFAULT_MAX_CHARS = 4000;

/**
 * Parse a positive integer from an env var, falling back to `fallback` for missing/invalid/non-positive values.
 * @param raw - The raw env-var string (or undefined).
 * @param fallback - The value to use when `raw` is absent or not a positive integer.
 * @returns The parsed positive integer, or `fallback`.
 */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
