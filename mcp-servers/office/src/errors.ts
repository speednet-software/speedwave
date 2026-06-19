/**
 * Error types for the office worker.
 * @module mcp-office/errors
 */

/**
 * A path violated the workspace policy: outside `/workspace`, a symlinked component, oversize input, or refused overwrite.
 */
export class PathPolicyError extends Error {
  /**
   * Construct a path-policy violation.
   * @param message - Human-readable reason.
   */
  constructor(message: string) {
    super(message);
    this.name = 'PathPolicyError';
  }
}

/**
 * The caller's request was malformed: bad DSL spec/ops, invalid chart type, injection-guard failure, or out-of-range page count.
 */
export class ValidationError extends Error {
  /**
   * Construct a request-validation error.
   * @param message - Human-readable reason.
   */
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
