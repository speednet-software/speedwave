/**
 * Shared output-schema builders for Redmine tools.
 */

/**
 * Build the `{success, ...props, error}` output-schema wrapper every read-result
 * tool redeclares by hand, with `success` required.
 * @param props - Tool-specific properties beyond the shared success/error wrapper
 */
export function successResultSchema(props: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    properties: { success: { type: 'boolean' }, ...props, error: { type: 'string' } },
    required: ['success'],
  };
}
