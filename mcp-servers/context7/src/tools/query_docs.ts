/**
 * `query_docs` tool — fetch documentation snippets for a known library ID.
 * @module mcp-context7/tools/query_docs
 */

import {
  errorResult,
  jsonResult,
  READ_ONLY_ANNOTATIONS,
  Tool,
  ToolDefinition,
  ToolsCallResult,
} from '@speedwave/mcp-shared';
import { Context7Client, Context7Error, clampTokens } from '../client.js';
import { DEFAULT_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS, MIN_OUTPUT_TOKENS } from '../consts.js';

/** Tool metadata exposed to the hub. */
export const queryDocsTool: Tool = {
  name: 'query_docs',
  description:
    'Retrieve documentation snippets for a Context7 library ID. Use resolve_library_id first if the ID is unknown.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: false },
  keywords: ['context7', 'docs', 'documentation', 'snippets', 'context'],
  example:
    'const { docs } = await context7.query_docs({ libraryId: "/facebook/react", query: "useState examples" })',
  inputSchema: {
    type: 'object',
    properties: {
      libraryId: {
        type: 'string',
        description:
          'Context7 library ID (e.g. "/facebook/react", "/vercel/next.js@v15.1.8"). Get it from resolve_library_id.',
      },
      query: {
        type: 'string',
        description: 'Question to answer (e.g. "How do I use useState?").',
      },
      tokens: {
        type: 'number',
        description: `Output cap (default ${DEFAULT_OUTPUT_TOKENS}, clamped to [${MIN_OUTPUT_TOKENS}, ${MAX_OUTPUT_TOKENS}]).`,
      },
    },
    required: ['libraryId', 'query'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      tier: {
        type: 'string',
        description: 'Quota tier reported by Context7.',
      },
      libraryId: { type: 'string' },
      tokens: { type: 'number', description: 'Effective output cap after clamping.' },
      docs: { type: 'string', description: 'Documentation snippets as plain text.' },
    },
    required: ['tier', 'libraryId', 'tokens', 'docs'],
  },
  inputExamples: [
    {
      description: 'Default cap',
      input: { libraryId: '/facebook/react', query: 'useState examples' },
    },
    {
      description: 'Larger cap for deep dive',
      input: { libraryId: '/vercel/next.js', query: 'middleware redirect', tokens: 10000 },
    },
  ],
};

/** Parameter shape for {@link createQueryDocsTool}'s handler. */
export interface QueryDocsParams {
  /** Context7 library ID (`/owner/repo` or `/websites/<slug>`). */
  libraryId: string;
  /** User question. */
  query: string;
  /** Optional output cap; clamped to {@link MIN_OUTPUT_TOKENS}..{@link MAX_OUTPUT_TOKENS}. */
  tokens?: number;
}

/**
 * Build a `{tool, handler}` definition wired to the supplied client.
 * @param client - Configured Context7 client
 */
export function createQueryDocsTool(client: Context7Client): ToolDefinition {
  return {
    tool: queryDocsTool,
    handler: async (params: unknown): Promise<ToolsCallResult> => {
      const p = params as Partial<QueryDocsParams> | null;
      const libraryId = typeof p?.libraryId === 'string' ? p.libraryId : '';
      const query = typeof p?.query === 'string' ? p.query : '';
      const requested = typeof p?.tokens === 'number' ? p.tokens : DEFAULT_OUTPUT_TOKENS;
      if (!libraryId) return errorResult('libraryId is required');
      if (!query) return errorResult('query is required');
      const tokens = clampTokens(requested);

      try {
        const { data, tier } = await client.getContext(libraryId, query, tokens);
        return jsonResult({ tier, libraryId, tokens, docs: data });
      } catch (e) {
        if (e instanceof Context7Error) return errorResult(e.message);
        return errorResult((e as Error).message);
      }
    },
  };
}
