/**
 * `resolveLibraryId` tool — name → Context7-compatible library ID.
 * @module mcp-context7/tools/resolve_library_id
 */

import {
  errorResult,
  jsonResult,
  READ_ONLY_ANNOTATIONS,
  textResult,
  Tool,
  ToolDefinition,
  ToolsCallResult,
} from '@speedwave/mcp-shared';
import { Context7Client, Context7Error } from '../client.js';

/** Tool metadata exposed to the hub. */
export const resolveLibraryIdTool: Tool = {
  name: 'resolveLibraryId',
  description:
    'Resolve a general library name into a Context7-compatible library ID. Call before queryDocs unless the ID is already known.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: false },
  keywords: ['context7', 'library', 'docs', 'documentation', 'resolve', 'search'],
  example:
    'const { matches } = await context7.resolveLibraryId({ libraryName: "react", query: "useState hook" })',
  inputSchema: {
    type: 'object',
    properties: {
      libraryName: {
        type: 'string',
        description: 'Library name to search (e.g. "react", "spring boot", "django").',
      },
      query: {
        type: 'string',
        description:
          'User intent — Context7 uses it to rank results by relevance (e.g. "useState hook examples").',
      },
    },
    required: ['libraryName', 'query'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      tier: {
        type: 'string',
        description:
          "Quota tier reported by Context7 ('anonymous', 'free', 'pro', 'enterprise', 'unknown').",
      },
      matches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            trustScore: { type: 'number' },
            totalSnippets: { type: 'number' },
            versions: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'title'],
        },
      },
    },
    required: ['tier', 'matches'],
  },
  inputExamples: [
    {
      description: 'Resolve React for a hooks-related question',
      input: { libraryName: 'react', query: 'useState hook examples' },
    },
    {
      description: 'Resolve Spring Boot for an authentication question',
      input: { libraryName: 'spring boot', query: 'jwt filter authentication' },
    },
  ],
};

/** Parameter shape for {@link resolveLibraryIdHandler}. */
export interface ResolveLibraryIdParams {
  /** Free-text library name. */
  libraryName: string;
  /** User question — used by Context7 for ranking. */
  query: string;
}

/**
 * Build a `{tool, handler}` definition wired to the supplied client.
 * @param client - Configured Context7 client
 */
export function createResolveLibraryIdTool(client: Context7Client): ToolDefinition {
  return {
    tool: resolveLibraryIdTool,
    handler: async (params: unknown): Promise<ToolsCallResult> => {
      const p = params as Partial<ResolveLibraryIdParams> | null;
      const libraryName = typeof p?.libraryName === 'string' ? p.libraryName : '';
      const query = typeof p?.query === 'string' ? p.query : '';
      if (!libraryName) return errorResult('libraryName is required');
      if (!query) return errorResult('query is required');

      try {
        const { data, tier } = await client.searchLibraries(libraryName, query);
        if (data.length === 0) {
          return textResult(
            `No matches for libraryName="${libraryName}". Try a different spelling or a more specific name. (tier: ${tier})`
          );
        }
        return jsonResult({
          tier,
          matches: data.map((lib) => ({
            id: lib.id,
            title: lib.title,
            description: lib.description,
            trustScore: lib.trustScore,
            totalSnippets: lib.totalSnippets,
            versions: lib.versions ?? [],
          })),
        });
      } catch (e) {
        if (e instanceof Context7Error) return errorResult(e.message);
        return errorResult((e as Error).message);
      }
    },
  };
}
