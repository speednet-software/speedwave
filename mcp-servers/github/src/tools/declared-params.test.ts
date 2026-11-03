import { describe, it, expect, vi } from 'vitest';
import { notConfiguredMessage, type ToolsCallResult } from '@speedwave/mcp-shared';
import { createToolDefinitions } from './index.js';
import type { GitHubClient } from '../client.js';

const textOf = (result: ToolsCallResult): string => (result.content[0] as { text: string }).text;

/**
 * Names of the top-level keys in the object literal passed to the call in an example string.
 * @param example - Example call such as `await github.getRepo({ owner: "o", repo: "r" })`
 */
const topLevelArgNames = (example: string): string[] => {
  const start = example.indexOf('({');
  if (start === -1) return [];
  const names: string[] = [];
  let depth = 0;
  let quote = '';
  let token = '';
  for (const ch of example.slice(start + 1)) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if ('{['.includes(ch)) {
      depth += 1;
    } else if ('}]'.includes(ch)) {
      depth -= 1;
    } else if (ch === ':' && depth === 1 && token) {
      names.push(token);
      token = '';
    } else if (/\w/.test(ch)) {
      token += ch;
    } else {
      token = '';
    }
  }
  return names;
};

const issue = { number: 4, title: 't', state: 'open' };

const createMockClient = () => ({
  updateIssue: vi.fn().mockResolvedValue(issue),
  getRepo: vi.fn().mockResolvedValue({ full_name: 'o/r' }),
  getCurrentUser: vi.fn().mockResolvedValue({ login: 'octocat' }),
  createOrUpdateFile: vi
    .fn()
    .mockResolvedValue({ commit_sha: 'abc', path: 'a.txt', html_url: 'u' }),
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

      it('names only declared arguments in its example call', () => {
        const declared = Object.keys(def.tool.inputSchema.properties);
        for (const name of topLevelArgNames(def.tool.example ?? '')) {
          expect(declared, def.tool.example).toContain(name);
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

  it('still splits a combined owner/repo given in repo while owner stays required', async () => {
    const client = createMockClient();

    const result = await handlerFor(client, 'getRepo')({ repo: 'octocat/hello' });

    expect(result.isError).toBeUndefined();
    expect(client.getRepo).toHaveBeenCalledWith('octocat', 'hello');
  });

  it('still rejects a repo with several slashes with the owner/repo teaching error', async () => {
    const client = createMockClient();

    const result = await handlerFor(client, 'getRepo')({ repo: 'a/b/c' });

    expect(client.getRepo).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("a single 'owner/repo' string");
  });

  it('creates an empty file, which the client accepts', async () => {
    const client = createMockClient();

    const result = await handlerFor(
      client,
      'createOrUpdateFile'
    )({
      owner: 'o',
      repo: 'r',
      path: 'a.txt',
      content: '',
      message: 'm',
    });

    expect(result.isError).toBeUndefined();
    expect(client.createOrUpdateFile).toHaveBeenCalledWith('o', 'r', {
      path: 'a.txt',
      content: '',
      message: 'm',
    });
  });
});
