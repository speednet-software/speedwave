/**
 * SSOT for TEACHING-style error composition: what was wrong, where to find a correct
 * value, and what to do next — so a weak model can self-correct without guessing.
 * @module shared/teaching-errors
 */

import { errorResult } from './server.js';
import type { ToolResult } from './tool-validation.js';

/**
 * Summarize an arbitrary received value for inclusion in an error message.
 * @param value - The received value to render compactly.
 */
function summarizeReceived(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** Input for {@link teachingErrorResult}. */
export interface TeachingErrorParams {
  /** Name of the invalid parameter. */
  paramName: string;
  /** The value that was actually received. */
  received: unknown;
  /** Name of the tool that provides a correct value for this param (e.g. "listIssueIds"). */
  correctValueTool?: string;
  /** Suggested next step for the model to take. */
  nextStep: string;
}

/**
 * Compose the teaching-style message body (no envelope): what was wrong, which
 * tool provides a correct value, and the suggested next step — in that order.
 * @param params - What was wrong, where a correct value comes from, and what to do next.
 */
function buildTeachingMessage(params: TeachingErrorParams): string {
  const { paramName, received, correctValueTool, nextStep } = params;
  const parts = [`Invalid ${paramName} (received: ${summarizeReceived(received)}).`];
  if (correctValueTool) {
    parts.push(`Get a valid value from ${correctValueTool}.`);
  }
  parts.push(nextStep);
  return parts.join(' ');
}

/**
 * Build a teaching-style {@link errorResult}: states what was wrong, which tool
 * provides a correct value, and the suggested next step — in that order.
 * @param params - What was wrong, where a correct value comes from, and what to do next.
 */
export function teachingErrorResult(params: TeachingErrorParams): ReturnType<typeof errorResult> {
  return errorResult(buildTeachingMessage(params));
}

/**
 * Build a teaching-style {@link ToolResult} error envelope (Family A's
 * `{ success, error }` shape) with the same message text as {@link teachingErrorResult}.
 * @param params - What was wrong, where a correct value comes from, and what to do next.
 * @param code - Error code to attach (default `INVALID_PARAM`).
 */
export function teachingToolResult(
  params: TeachingErrorParams,
  code = 'INVALID_PARAM'
): ToolResult {
  return {
    success: false,
    error: { code, message: buildTeachingMessage(params) },
  };
}

/**
 * Clamp a pagination page-size param to a finite positive integer, defaulting when
 * the input is missing, NaN, or otherwise not a finite number.
 * @param value - Raw page-size value (e.g. from tool params).
 * @param def - Default to use when `value` is not a finite number.
 * @param max - Upper bound the result is capped to.
 */
export function clampPageSize(value: unknown, def: number, max: number): number {
  if (typeof value !== 'number' && typeof value !== 'string') return def;
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(Math.floor(n), max));
}
