/**
 * Tests for Context7 MCP tool definitions.
 */

import { describe, it, expect, vi } from 'vitest';
import { createResolveLibraryIdTool, resolveLibraryIdTool } from './resolve_library_id.js';
import { createQueryDocsTool, queryDocsTool } from './query_docs.js';
import { Context7Client, Context7Error } from '../client.js';
import { DEFAULT_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS } from '../consts.js';

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

describe('resolve_library_id metadata', () => {
  it('exposes name, schema, examples', () => {
    expect(resolveLibraryIdTool.name).toBe('resolve_library_id');
    expect(resolveLibraryIdTool.inputSchema.type).toBe('object');
    expect(resolveLibraryIdTool.inputSchema.required).toEqual(['libraryName', 'query']);
    expect(resolveLibraryIdTool.annotations?.readOnlyHint).toBe(true);
    expect(resolveLibraryIdTool.inputExamples?.length).toBeGreaterThan(0);
  });
});

describe('resolve_library_id handler', () => {
  it('rejects missing libraryName', async () => {
    const client = makeStubClient();
    const { handler } = createResolveLibraryIdTool(client);
    const result = await handler({ query: 'q' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('libraryName');
  });

  it('rejects missing query', async () => {
    const client = makeStubClient();
    const { handler } = createResolveLibraryIdTool(client);
    const result = await handler({ libraryName: 'react' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('query');
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
});

describe('query_docs metadata', () => {
  it('exposes name, schema, examples', () => {
    expect(queryDocsTool.name).toBe('query_docs');
    expect(queryDocsTool.inputSchema.required).toEqual(['libraryId', 'query']);
    expect(queryDocsTool.annotations?.readOnlyHint).toBe(true);
  });
});

describe('query_docs handler', () => {
  it('rejects missing libraryId', async () => {
    const client = makeStubClient();
    const { handler } = createQueryDocsTool(client);
    const result = await handler({ query: 'q' });
    expect(result.isError).toBe(true);
  });

  it('rejects missing query', async () => {
    const client = makeStubClient();
    const { handler } = createQueryDocsTool(client);
    const result = await handler({ libraryId: '/x/y' });
    expect(result.isError).toBe(true);
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
});
