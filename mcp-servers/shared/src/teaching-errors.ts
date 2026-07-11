/**
 * SSOT for TEACHING-style error composition: what was wrong, where to find a correct
 * value, and what to do next — so a weak model can self-correct without guessing.
 * @module shared/teaching-errors
 */

import { errorResult } from './server.js';
import type { ToolResult } from './tool-validation.js';

/** Max characters of a received value echoed into a teaching error before truncation. */
export const MAX_RECEIVED_LENGTH = 200;

/**
 * Render an arbitrary received value compactly for an error message.
 * @param value - The received value to render.
 */
function renderReceived(value: unknown): string {
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

/**
 * Summarize a received value, capping oversized or prompt-injected input at
 * {@link MAX_RECEIVED_LENGTH} with a trailing `...` marker.
 * @param value - The received value to render compactly.
 */
function summarizeReceived(value: unknown): string {
  const rendered = renderReceived(value);
  if (rendered.length <= MAX_RECEIVED_LENGTH) return rendered;
  return `${rendered.slice(0, MAX_RECEIVED_LENGTH)}...`;
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
 * Clamp a pagination page-size param to a positive integer. Missing, null, zero,
 * negative, NaN, or non-numeric input yields `def`; fractional input floors; `max`
 * omitted means no upper ceiling. The result is never below 1.
 * @param value - Raw page-size value (e.g. from tool params).
 * @param def - Default to use when `value` is missing or not a usable number.
 * @param max - Optional upper bound; when omitted the value is only floored and clamped to >= 1.
 */
export function clampPageSize(value: unknown, def: number, max?: number): number {
  if (typeof value !== 'number' && typeof value !== 'string') return def;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return def;
  const floored = Math.max(1, Math.floor(n));
  return max === undefined ? floored : Math.min(floored, max);
}

/**
 * Build a MISSING_PARAM teaching {@link ToolResult}: names the missing param, the
 * received value, and the next step. Shared by slack / sharepoint required-param guards.
 * @param paramName - Name of the missing or invalid parameter.
 * @param received - The value actually received.
 * @param nextStep - What the caller should do instead.
 */
export function missingParamResult(
  paramName: string,
  received: unknown,
  nextStep: string
): ToolResult {
  return teachingToolResult({ paramName, received, nextStep }, 'MISSING_PARAM');
}
