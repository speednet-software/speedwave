/**
 * Connection-test result types shared by MCP workers (GitLab/GitHub/Atlassian); `errorType` is optional (Atlassian back-compat).
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
 * Classify an HTTP error into a {@link ConnectionTestResult}: 401→auth, 403→permission, 404→not_found,
 * ECONNREFUSED/ENOTFOUND/ETIMEDOUT/ECONNABORTED/no `response`→network, else unknown. Duck-typed via `response.status`/`code`.
 * @param error - The caught error, of unknown shape
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
