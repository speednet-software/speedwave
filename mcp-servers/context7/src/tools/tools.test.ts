/**
 * Tests for Context7 MCP tool definitions.
 */

import { describe, it, expect, vi } from 'vitest';
import { META_KEYS } from '@speedwave/mcp-shared';
import { createResolveLibraryIdTool, resolveLibraryIdTool } from './resolve_library_id.js';
import { createQueryDocsTool, queryDocsTool } from './query_docs.js';
import { Context7Client, Context7Error } from '../client.js';
import { DEFAULT_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS, MAX_SEARCH_RESULTS } from '../consts.js';

/** Build a stub client whose two API methods are vitest mocks. */
function makeStubClient(): Context7Client & {
  searchLibraries: ReturnType<typeof vi.fn>;
  getContext: ReturnType<typeof vi.fn>;
} {
  const stub = new Context7Client();
  (stub as unknown as { searchLibraries: unknown }).searchLibraries = vi.fn();
  (stub as unknown as { getContext: unknown }).getContext = vi.fn();
  return stub as unknown as Context7Client & {
    searchLibraries: ReturnType<typeof vi.fn>;
    getContext: ReturnType<typeof vi.fn>;
  };
}

describe('resolveLibraryId metadata', () => {
  it('exposes name, schema, examples', () => {
    expect(resolveLibraryIdTool.name).toBe('resolveLibraryId');
    expect(resolveLibraryIdTool.inputSchema.type).toBe('object');
    expect(resolveLibraryIdTool.inputSchema.required).toEqual(['libraryName', 'query']);
    expect(resolveLibraryIdTool.annotations?.readOnlyHint).toBe(true);
    expect(resolveLibraryIdTool.inputExamples?.length).toBeGreaterThan(0);
  });

  it('uses the prefixed defer-loading meta key', () => {
    expect(resolveLibraryIdTool._meta?.[META_KEYS.DEFER_LOADING]).toBe(false);
    expect(resolveLibraryIdTool._meta).not.toHaveProperty('deferLoading');
  });

  it('documents the search-result cap in the description', () => {
    expect(resolveLibraryIdTool.description).toContain(String(MAX_SEARCH_RESULTS));
  });

  it('declares benchmarkScore in the output schema', () => {
    const matches = (
      resolveLibraryIdTool.outputSchema.properties as Record<
        string,
        { items: { properties: unknown } }
      >
    ).matches;
    expect(matches.items.properties as Record<string, unknown>).toHaveProperty('benchmarkScore');
  });
});

describe('resolveLibraryId handler', () => {
  it('rejects missing libraryName with a teaching error', async () => {
    const client = makeStubClient();
    const { handler } = createResolveLibraryIdTool(client);
    const result = await handler({ query: 'q' });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('libraryName');
    expect(text).toContain('undefined');
  });

  it('rejects missing query with a teaching error', async () => {
    const client = makeStubClient();
    const { handler } = createResolveLibraryIdTool(client);
    const result = await handler({ libraryName: 'react' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('query');
  });

  it('rejects empty-string libraryName', async () => {
    const client = makeStubClient();
    const { handler } = createResolveLibraryIdTool(client);
    const result = await handler({ libraryName: '', query: 'q' });
    expect(result.isError).toBe(true);
  });

  it('returns formatted matches on success', async () => {
    const client = makeStubClient();
    client.searchLibraries.mockResolvedValue({
      data: [
        {
          id: '/facebook/react',
          title: 'React',
          description: 'UI library',
          trustScore: 9.2,
          benchmarkScore: 87,
          totalSnippets: 3000,
          versions: ['v18', 'v19'],
        },
      ],
      tier: 'anonymous',
    });
    const { handler } = createResolveLibraryIdTool(client);
    const result = await handler({ libraryName: 'react', query: 'hooks' });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.tier).toBe('anonymous');
    expect(body.matches[0].id).toBe('/facebook/react');
    expect(body.matches[0].benchmarkScore).toBe(87);
  });

  it('returns helpful text on empty results', async () => {
    const client = makeStubClient();
    client.searchLibraries.mockResolvedValue({ data: [], tier: 'free' });
    const { handler } = createResolveLibraryIdTool(client);
    const result = await handler({ libraryName: 'nonexistent', query: 'q' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('No matches');
    expect(result.content[0].text).toContain('tier: free');
  });

  it('propagates Context7Error message', async () => {
    const client = makeStubClient();
    client.searchLibraries.mockRejectedValue(
      new Context7Error('rate limited', 429, 'anonymous', false)
    );
    const { handler } = createResolveLibraryIdTool(client);
    const result = await handler({ libraryName: 'react', query: 'q' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('rate limited');
  });

  it('propagates plain Error message from unexpected failures', async () => {
    const client = makeStubClient();
    client.searchLibraries.mockRejectedValue(new Error('boom'));
    const { handler } = createResolveLibraryIdTool(client);
    const result = await handler({ libraryName: 'react', query: 'q' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('boom');
  });

  it('defaults versions to empty array when match has none', async () => {
    const client = makeStubClient();
    client.searchLibraries.mockResolvedValue({
      data: [{ id: '/x/y', title: 'X', description: '' }],
      tier: 'unknown',
    });
    const { handler } = createResolveLibraryIdTool(client);
    const result = await handler({ libraryName: 'x', query: 'q' });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.matches[0].versions).toEqual([]);
  });
});

describe('queryDocs metadata', () => {
  it('exposes name, schema, examples', () => {
    expect(queryDocsTool.name).toBe('queryDocs');
    expect(queryDocsTool.inputSchema.required).toEqual(['libraryId', 'query']);
    expect(queryDocsTool.annotations?.readOnlyHint).toBe(true);
  });

  it('uses the prefixed defer-loading meta key', () => {
    expect(queryDocsTool._meta?.[META_KEYS.DEFER_LOADING]).toBe(false);
    expect(queryDocsTool._meta).not.toHaveProperty('deferLoading');
  });
});

describe('queryDocs handler', () => {
  it('rejects missing libraryId with a teaching error naming resolveLibraryId', async () => {
    const client = makeStubClient();
    const { handler } = createQueryDocsTool(client);
    const result = await handler({ query: 'q' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('libraryId');
    expect(result.content[0].text).toContain('resolveLibraryId');
  });

  it('rejects missing query', async () => {
    const client = makeStubClient();
    const { handler } = createQueryDocsTool(client);
    const result = await handler({ libraryId: '/x/y' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('query');
  });

  it('uses DEFAULT_OUTPUT_TOKENS when tokens omitted', async () => {
    const client = makeStubClient();
    client.getContext.mockResolvedValue({ data: 'docs body', tier: 'anonymous' });
    const { handler } = createQueryDocsTool(client);
    await handler({ libraryId: '/x/y', query: 'q' });
    expect(client.getContext).toHaveBeenCalledWith('/x/y', 'q', DEFAULT_OUTPUT_TOKENS);
  });

  it('clamps oversized tokens before calling client', async () => {
    const client = makeStubClient();
    client.getContext.mockResolvedValue({ data: 'docs', tier: 'pro' });
    const { handler } = createQueryDocsTool(client);
    await handler({ libraryId: '/x/y', query: 'q', tokens: 999_999 });
    expect(client.getContext).toHaveBeenCalledWith('/x/y', 'q', MAX_OUTPUT_TOKENS);
  });

  it('returns structured docs on success', async () => {
    const client = makeStubClient();
    client.getContext.mockResolvedValue({ data: 'docs body', tier: 'pro' });
    const { handler } = createQueryDocsTool(client);
    const result = await handler({ libraryId: '/x/y', query: 'q', tokens: 5000 });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({ tier: 'pro', libraryId: '/x/y', tokens: 5000, docs: 'docs body' });
  });

  it('propagates Context7Error message', async () => {
    const client = makeStubClient();
    client.getContext.mockRejectedValue(
      new Context7Error('library not found', 404, 'unknown', false)
    );
    const { handler } = createQueryDocsTool(client);
    const result = await handler({ libraryId: '/x/y', query: 'q' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('library not found');
  });

  it('propagates plain Error message from unexpected failures', async () => {
    const client = makeStubClient();
    client.getContext.mockRejectedValue(new Error('socket closed'));
    const { handler } = createQueryDocsTool(client);
    const result = await handler({ libraryId: '/x/y', query: 'q' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('socket closed');
  });
});
