/**
 * `resolveLibraryId` tool — name → Context7-compatible library ID.
 * @module mcp-context7/tools/resolve_library_id
 */

import {
  errorResult,
  jsonResult,
  META_KEYS,
  READ_ONLY_ANNOTATIONS,
  teachingErrorResult,
  textResult,
  Tool,
  ToolDefinition,
  ToolsCallResult,
} from '@speedwave/mcp-shared';
import { Context7Client, Context7Error } from '../client.js';
import { MAX_SEARCH_RESULTS } from '../consts.js';

/** Tool metadata exposed to the hub. */
export const resolveLibraryIdTool: Tool = {
  name: 'resolveLibraryId',
  description: `Resolve a general library name into a Context7-compatible library ID. Call before queryDocs unless the ID is already known. Returns at most ${MAX_SEARCH_RESULTS} ranked matches; refine libraryName/query if the expected match is missing.`,
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: false },
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
            benchmarkScore: {
              type: 'number',
              description: 'Benchmark score (0-100), if reported.',
            },
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
      if (!libraryName) {
        return teachingErrorResult({
          paramName: 'libraryName',
          received: p?.libraryName,
          nextStep: 'Provide a non-empty library name, e.g. "react" or "spring boot".',
        });
      }
      if (!query) {
        return teachingErrorResult({
          paramName: 'query',
          received: p?.query,
          nextStep: "Provide the user's question so Context7 can rank matches by relevance.",
        });
      }

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
            benchmarkScore: lib.benchmarkScore,
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
