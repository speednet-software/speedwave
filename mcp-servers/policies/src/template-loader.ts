/**
 * Loads and validates the shipped policy templates from `templates/*.yaml` (SSOT, read by
 * both the TS engine and the Rust save-gate).
 * @module template-loader
 */

import { readFileSync } from 'fs';
import { parse as parseYAML } from 'yaml';
import { parseTemplate } from './template-schema.js';
import type { PolicyTemplate } from './types.js';

/**
 * The package's `templates/` dir: `src/` and the compiled `dist/` both sit one level below
 * the package root, so one `..` resolves identically from either.
 */
const TEMPLATES_DIR = new URL('../templates/', import.meta.url);

/** Ids of the templates shipped in this package. */
export const SHIPPED_TEMPLATE_IDS = ['strict', 'gdpr-art32', 'eu-ai-act-art5'] as const;

/**
 * Load and validate a single template by id.
 * @param id - Template id (matches its YAML filename without the extension)
 * @returns The validated template
 */
export function loadTemplate(id: string): PolicyTemplate {
  const fileUrl = new URL(`${id}.yaml`, TEMPLATES_DIR);
  let raw: string;
  try {
    raw = readFileSync(fileUrl, 'utf-8');
  } catch (err) {
    /* c8 ignore next — fs sync calls only ever throw a real Error (SystemError) instance */
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`template "${id}" could not be read from ${fileUrl.pathname}: ${reason}`);
  }
  return parseTemplate(parseYAML(raw));
}

/**
 * Load every template shipped with this package.
 * @returns The validated templates, keyed by id
 */
export function loadAllTemplates(): Record<string, PolicyTemplate> {
  const result: Record<string, PolicyTemplate> = {};
  for (const id of SHIPPED_TEMPLATE_IDS) {
    result[id] = loadTemplate(id);
  }
  return result;
}
