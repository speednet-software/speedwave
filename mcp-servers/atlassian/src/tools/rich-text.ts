/**
 * Shared validation of "Markdown or ADF, not both" tool parameters.
 * @module mcp-atlassian/tools/rich-text
 */

import { teachingErrorResult } from '@speedwave/mcp-shared';
import { isAdfDoc } from '../adf.js';
import type { AdfDoc } from '../types.js';

/** Resolved value, or the teaching error to return to the caller. */
export type RichTextResult<T> = { value: T } | { error: ReturnType<typeof teachingErrorResult> };

/**
 * Enforce "Markdown or ADF, not both" and that the ADF parameter is a document.
 * @param markdownName - Name of the Markdown parameter, used in errors.
 * @param markdown - The Markdown value, if given.
 * @param adfName - Name of the ADF parameter, used in errors.
 * @param adf - The ADF value, if given.
 * @returns The value to send (`undefined` when neither was given) or a teaching error.
 */
export function resolveRichText(
  markdownName: string,
  markdown: string | undefined,
  adfName: string,
  adf: unknown
): RichTextResult<string | AdfDoc | undefined> {
  if (markdown !== undefined && adf !== undefined) {
    return {
      error: teachingErrorResult({
        paramName: `${markdownName} and ${adfName}`,
        nextStep: `Give ${markdownName} (Markdown) or ${adfName} (ADF), not both. Nothing was sent.`,
      }),
    };
  }
  if (adf === undefined) return { value: markdown };
  if (!isAdfDoc(adf)) {
    return {
      error: teachingErrorResult({
        paramName: adfName,
        nextStep: `${adfName} must be an ADF document: { version: 1, type: "doc", content: [...] }. Nothing was sent.`,
      }),
    };
  }
  return { value: adf };
}
