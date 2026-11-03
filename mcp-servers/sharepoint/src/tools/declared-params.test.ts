import { describe, it, expect, vi } from 'vitest';
import { notConfiguredMessage, type ToolsCallResult } from '@speedwave/mcp-shared';
import { createToolDefinitions } from './index.js';
import type { SharePointClient } from '../client.js';

const textOf = (result: ToolsCallResult): string => (result.content[0] as { text: string }).text;

const createMockClient = () => ({
  listFiles: vi.fn().mockResolvedValue({ files: [], exists: true }),
  getFileMetadata: vi.fn().mockResolvedValue({ id: 'abc123' }),
});

const handlerFor = (client: ReturnType<typeof createMockClient>, name: string) =>
  createToolDefinitions(client as unknown as SharePointClient).find((d) => d.tool.name === name)!
    .handler;

describe('SharePoint declared-parameter guard', () => {
  describe.each(createToolDefinitions(null).map((d) => [d.tool.name, d] as const))(
    '%s',
    (_name, def) => {
      it('rejects an undeclared argument before the handler runs', async () => {
        const result = await def.handler({ not_a_declared_param: 1 });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain(`${def.tool.name} does not accept this parameter`);
        expect(textOf(result)).not.toContain(notConfiguredMessage('SharePoint'));
      });

      it('declares every argument its input examples use', async () => {
        const declared = Object.keys(def.tool.inputSchema.properties);
        for (const example of def.tool.inputExamples ?? []) {
          expect(declared, example.description).toEqual(
            expect.arrayContaining(Object.keys(example.input))
          );
          const result = await def.handler(example.input);
          expect(textOf(result), example.description).toContain(notConfiguredMessage('SharePoint'));
        }
      });
    }
  );

  it('rejects an undeclared argument without calling the client', async () => {
    const client = createMockClient();

    const result = await handlerFor(client, 'listFileIds')({ folder: 'docs' });

    expect(client.listFiles).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Accepted parameters: path\./);
  });

  it('rejects a missing required argument without calling the client', async () => {
    const client = createMockClient();

    const result = await handlerFor(client, 'getFileFull')({});

    expect(client.getFileMetadata).not.toHaveBeenCalled();
    expect(textOf(result)).toContain('getFileFull requires file_id');
  });

  it('lets a call with only declared arguments reach the client', async () => {
    const client = createMockClient();

    const result = await handlerFor(client, 'listFileIds')({ path: 'docs' });

    expect(client.listFiles).toHaveBeenCalledWith({ path: 'docs' });
    expect(result.isError).toBeUndefined();
  });
});
