/**
 * Shared tool output-schema fragments composed by more than one tool file.
 * @module github/tools/schemas
 */

/** Object-typed output schema for the diff tools (getPrDiff / getCommitDiff). */
export const DIFF_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    diff: { type: 'string', description: 'The unified diff as plain text.' },
  },
  required: ['diff'],
} as const;
