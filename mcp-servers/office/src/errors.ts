/**
 * Error types for the office worker. `guard()` in `tools/index.ts` turns any thrown
 * `Error` into an MCP `isError` result, so these classes exist mainly to give callers
 * (and the JSDoc) a precise name for the failure category.
 * @module mcp-office/errors
 */

/**
 * A path violated the workspace policy: outside `/workspace` after canonicalization,
 * a symlinked component, an oversize input, or a refused overwrite. Distinct from
 * `ValidationError` — this one is about filesystem confinement, not request shape.
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
 * The caller's request was malformed: a bad DSL `spec`/`ops` shape, an invalid chart
 * type, a CSS option that fails the injection-guard regex, an out-of-range page count,
 * etc. Distinct from `PathPolicyError` — this one is about request content, not paths.
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
