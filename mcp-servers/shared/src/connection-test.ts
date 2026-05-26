/**
 * Connection-test result types and helpers shared by MCP workers.
 *
 * Consolidates `ConnectionTestResult` interfaces previously duplicated across
 * GitLab, GitHub, and Atlassian workers. The shared shape is a superset:
 * `errorType` covers GitLab/GitHub's categorisation; Atlassian historically
 * omitted it and continues to work without setting the field.
 *
 * The classifier is HTTP-library-agnostic: it duck-types Axios-like errors
 * (`response.status`, `code`) so shared has zero runtime HTTP dependencies.
 * @module shared/connection-test
 */

/** Categorised connection-test failure reason. */
export type ConnectionErrorType = 'auth' | 'network' | 'permission' | 'not_found' | 'unknown';

/** Result of a lightweight external connection test performed during init. */
export interface ConnectionTestResult {
  /** True when the test reached the service and authenticated successfully. */
  success: boolean;
  /** Human-readable error message when the test failed. */
  error?: string;
  /**
   * Categorised error reason. Workers may omit this field when they do not
   * differentiate categories (legacy Atlassian behaviour).
   */
  errorType?: ConnectionErrorType;
}

/** Minimal HTTP-error shape understood by {@link classifyConnectionError}. */
interface HttpLikeError {
  message?: string;
  code?: string;
  response?: { status?: number };
}

function isHttpLikeError(value: unknown): value is HttpLikeError {
  return typeof value === 'object' && value !== null;
}

/**
 * Classify an HTTP error into a {@link ConnectionTestResult}.
 *
 * Maps common HTTP/network failures to {@link ConnectionErrorType}:
 * - `401` → `auth`
 * - `403` → `permission`
 * - `404` → `not_found`
 * - `ECONNREFUSED` / `ENOTFOUND` / `ETIMEDOUT` / `ECONNABORTED` / no `response` → `network`
 * - Other → `unknown`
 *
 * Duck-types Axios errors by reading `response.status` and `code`. Works
 * unchanged with `node-fetch`, `undici`, and `gitbeaker` errors that follow
 * the same shape.
 * @param error - The HTTP/network error caught from an external API call.
 */
export function classifyConnectionError(error: unknown): ConnectionTestResult {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' &&
          error !== null &&
          typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : String(error);
  if (isHttpLikeError(error)) {
    const status = error.response?.status;
    if (status === 401) {
      return { success: false, error: message, errorType: 'auth' };
    }
    if (status === 403) {
      return { success: false, error: message, errorType: 'permission' };
    }
    if (status === 404) {
      return { success: false, error: message, errorType: 'not_found' };
    }
    if (
      !error.response &&
      (error.code === 'ECONNREFUSED' ||
        error.code === 'ENOTFOUND' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNABORTED' ||
        error.code === undefined)
    ) {
      return { success: false, error: message, errorType: 'network' };
    }
  }
  return {
    success: false,
    error: message,
    errorType: 'unknown',
  };
}
