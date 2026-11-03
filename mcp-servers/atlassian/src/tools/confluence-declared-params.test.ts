import { describe, it, expect, vi } from 'vitest';
import type { ToolsCallResult } from '@speedwave/mcp-shared';

const pagesStub = {
  search: vi.fn().mockResolvedValue([]),
  get: vi.fn().mockResolvedValue({ id: '1' }),
  getByTitle: vi.fn().mockResolvedValue({ id: '1' }),
  create: vi.fn().mockResolvedValue({ id: '1' }),
  update: vi.fn().mockResolvedValue({ id: '1' }),
  getChildren: vi.fn().mockResolvedValue([]),
};
const spacesStub = {
  list: vi.fn().mockResolvedValue([]),
  getByKey: vi.fn().mockResolvedValue({ key: 'DEV' }),
};
const contentStub = {
  addComment: vi.fn().mockResolvedValue({ id: '1' }),
  getComments: vi.fn().mockResolvedValue([]),
  addLabels: vi.fn().mockResolvedValue([]),
  getLabels: vi.fn().mockResolvedValue([]),
  listAttachments: vi.fn().mockResolvedValue([]),
};
vi.mock('../domains/confluence-pages.js', () => ({ createConfluencePagesClient: () => pagesStub }));
vi.mock('../domains/confluence-spaces.js', () => ({
  createConfluenceSpacesClient: () => spacesStub,
}));
vi.mock('../domains/confluence-content.js', () => ({
  createConfluenceContentClient: () => contentStub,
}));

import { createConfluencePageTools } from './confluence-page-tools.js';
import { createConfluenceSpaceTools } from './confluence-space-tools.js';
import { createConfluenceContentTools } from './confluence-content-tools.js';
import type { AtlassianClient } from '../client.js';

const client = {} as AtlassianClient;
const allStubs = [pagesStub, spacesStub, contentStub].flatMap((s) => Object.values(s));
const textOf = (result: ToolsCallResult): string => (result.content[0] as { text: string }).text;

const confluenceTools = (c: AtlassianClient | null) => [
  ...createConfluenceSpaceTools(c),
  ...createConfluencePageTools(c),
  ...createConfluenceContentTools(c),
];

describe('Confluence declared-parameter guard', () => {
  describe.each(confluenceTools(client).map((d) => [d.tool.name, d] as const))(
    '%s',
    (_name, def) => {
      it('rejects an undeclared argument before the client is called', async () => {
        allStubs.forEach((m) => m.mockClear());
        const result = await def.handler({ not_a_declared_param: 1 });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain(`${def.tool.name} does not accept this parameter`);
        for (const m of allStubs) expect(m).not.toHaveBeenCalled();
      });

      it('declares every argument its input examples use and runs them through the handler', async () => {
        const declared = Object.keys(def.tool.inputSchema.properties);
        for (const example of def.tool.inputExamples ?? []) {
          expect(declared, example.description).toEqual(
            expect.arrayContaining(Object.keys(example.input))
          );
          const result = await def.handler(example.input);
          expect(result.isError, example.description).toBeUndefined();
        }
      });
    }
  );

  it('rejects an undeclared argument on an unconfigured worker too', async () => {
    for (const def of confluenceTools(null)) {
      const result = await def.handler({ not_a_declared_param: 1 });
      expect(textOf(result)).toContain(`${def.tool.name} does not accept this parameter`);
    }
  });

  it('still reaches the client with declared arguments', async () => {
    const [createPage] = createConfluencePageTools(client).filter(
      (d) => d.tool.name === 'createPage'
    );
    const result = await createPage.handler({
      spaceKey: 'DEV',
      title: 'T',
      bodyText: 'x',
      parentId: '100',
    });
    expect(result.isError).toBeUndefined();
    expect(pagesStub.create).toHaveBeenCalledWith({
      spaceKey: 'DEV',
      title: 'T',
      body: { text: 'x' },
      parentId: '100',
    });
  });
});
