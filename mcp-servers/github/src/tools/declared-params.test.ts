import { describe, it, expect, vi } from 'vitest';
import { notConfiguredMessage, type ToolsCallResult } from '@speedwave/mcp-shared';
import { createToolDefinitions } from './index.js';
import type { GitHubClient } from '../client.js';

const textOf = (result: ToolsCallResult): string => (result.content[0] as { text: string }).text;

const issue = { number: 4, title: 't', state: 'open' };

const createMockClient = () => ({
  updateIssue: vi.fn().mockResolvedValue(issue),
  getRepo: vi.fn().mockResolvedValue({ full_name: 'o/r' }),
  getCurrentUser: vi.fn().mockResolvedValue({ login: 'octocat' }),
});

const handlerFor = (client: ReturnType<typeof createMockClient>, name: string) =>
  createToolDefinitions(client as unknown as GitHubClient).find((d) => d.tool.name === name)!
    .handler;

describe('GitHub declared-parameter guard', () => {
  describe.each(createToolDefinitions(null).map((d) => [d.tool.name, d] as const))(
    '%s',
    (_name, def) => {
      it('rejects an undeclared argument before the handler runs', async () => {
        const result = await def.handler({ not_a_declared_param: 1 });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain(`${def.tool.name} does not accept this parameter`);
        expect(textOf(result)).not.toContain(notConfiguredMessage('GitHub'));
      });

      it('declares every argument its input examples use', async () => {
        const declared = Object.keys(def.tool.inputSchema.properties);
        for (const example of def.tool.inputExamples ?? []) {
          expect(declared, example.description).toEqual(
            expect.arrayContaining(Object.keys(example.input))
          );
          const result = await def.handler(example.input);
          expect(textOf(result), example.description).toBe(
            `Error: ${notConfiguredMessage('GitHub')}`
          );
        }
      });
    }
  );

  it('rejects updateIssue with milestone instead of reporting a successful update', async () => {
    const client = createMockClient();

    const result = await handlerFor(
      client,
      'updateIssue'
    )({
      owner: 'o',
      repo: 'r',
      number: 4,
      milestone: 3,
    });

    expect(client.updateIssue).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid milestone.');
    expect(textOf(result)).toMatch(/Accepted parameters: .*assignees/);
  });

  it('sends a declared updateIssue call through to the client', async () => {
    const client = createMockClient();

    const result = await handlerFor(
      client,
      'updateIssue'
    )({
      owner: 'o',
      repo: 'r',
      number: '#4',
      title: 'New',
    });

    expect(result.isError).toBeUndefined();
    expect(client.updateIssue).toHaveBeenCalledWith('o', 'r', 4, { title: 'New' });
  });

  it('rejects any argument to getCurrentUser, which accepts none', async () => {
    const client = createMockClient();

    const result = await handlerFor(client, 'getCurrentUser')({ login: 'x' });

    expect(client.getCurrentUser).not.toHaveBeenCalled();
    expect(textOf(result)).toContain('Accepted parameters: none.');
  });

  it('rejects a missing required argument before calling the client', async () => {
    const client = createMockClient();

    const result = await handlerFor(client, 'getRepo')({ owner: 'o' });

    expect(client.getRepo).not.toHaveBeenCalled();
    expect(textOf(result)).toContain('getRepo requires repo');
  });
});
