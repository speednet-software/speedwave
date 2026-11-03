import { describe, it, expect, vi } from 'vitest';
import type { ToolsCallResult } from '@speedwave/mcp-shared';
import { createToolDefinitions } from './index.js';
import { Context7Client } from '../client.js';

const textOf = (result: ToolsCallResult): string => (result.content[0] as { text: string }).text;

function makeStubClient() {
  const stub = new Context7Client();
  const searchLibraries = vi.fn().mockResolvedValue({ data: [], tier: 'free' });
  const getContext = vi.fn().mockResolvedValue({ data: 'docs', tier: 'free' });
  Object.assign(stub, { searchLibraries, getContext });
  return { client: stub, searchLibraries, getContext };
}

describe('Context7 declared-parameter guard', () => {
  describe.each(createToolDefinitions(new Context7Client()).map((d) => [d.tool.name, d] as const))(
    '%s',
    (_name, def) => {
      it('rejects an undeclared argument before the client is called', async () => {
        const { client, searchLibraries, getContext } = makeStubClient();
        const tool = createToolDefinitions(client).find((d) => d.tool.name === def.tool.name)!;
        const required = Object.fromEntries(
          (def.tool.inputSchema.required ?? []).map((r) => [r, 'x'])
        );

        const result = await tool.handler({ ...required, not_a_declared_param: 1 });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain(`${def.tool.name} does not accept this parameter`);
        expect(searchLibraries).not.toHaveBeenCalled();
        expect(getContext).not.toHaveBeenCalled();
      });

      it('runs every input example through the handler without a parameter rejection', async () => {
        const { client } = makeStubClient();
        const tool = createToolDefinitions(client).find((d) => d.tool.name === def.tool.name)!;
        const declared = Object.keys(def.tool.inputSchema.properties);
        for (const example of def.tool.inputExamples ?? []) {
          expect(declared, example.description).toEqual(
            expect.arrayContaining(Object.keys(example.input))
          );
          const text = textOf(await tool.handler(example.input));
          expect(text, example.description).not.toContain('does not accept');
          expect(text, example.description).not.toMatch(/requires \w+/);
        }
      });
    }
  );

  it('rejects a missing required argument without calling the client', async () => {
    const { client, getContext } = makeStubClient();
    const queryDocs = createToolDefinitions(client).find((d) => d.tool.name === 'queryDocs')!;

    const result = await queryDocs.handler({ libraryId: '/facebook/react' });

    expect(getContext).not.toHaveBeenCalled();
    expect(textOf(result)).toContain('queryDocs requires query');
  });

  it('lets a call with only declared arguments reach the client', async () => {
    const { client, getContext } = makeStubClient();
    const queryDocs = createToolDefinitions(client).find((d) => d.tool.name === 'queryDocs')!;

    const result = await queryDocs.handler({
      libraryId: '/facebook/react',
      query: 'useState',
      tokens: 6000,
    });

    expect(getContext).toHaveBeenCalledWith('/facebook/react', 'useState', 6000);
    expect(result.isError).toBeUndefined();
  });
});
