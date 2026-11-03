import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolsCallResult } from '@speedwave/mcp-shared';
import { createToolDefinitions } from './index.js';

vi.mock('../platform-runner.js', () => ({
  runCommand: vi.fn(),
}));

import { runCommand } from '../platform-runner.js';

const textOf = (result: ToolsCallResult): string => (result.content[0] as { text: string }).text;

const tools = createToolDefinitions();

describe('OS declared-parameter guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runCommand).mockResolvedValue({ stdout: '{}', parsed: {} });
  });

  it('guards every OS tool', () => {
    expect(tools.map((d) => d.tool.name)).toEqual(
      expect.arrayContaining([
        'listReminders',
        'createEvent',
        'listNotes',
        'sendEmail',
        'listMailSignatures',
      ])
    );
  });

  describe.each(tools.map((d) => [d.tool.name, d] as const))('%s', (_name, def) => {
    it('rejects an undeclared argument before the native CLI runs', async () => {
      const result = await def.handler({ not_a_declared_param: 1 });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(`${def.tool.name} does not accept this parameter`);
      expect(runCommand).not.toHaveBeenCalled();
    });

    it('declares every argument its input examples use', () => {
      const declared = Object.keys(def.tool.inputSchema.properties);
      for (const example of def.tool.inputExamples ?? []) {
        expect(declared, example.description).toEqual(
          expect.arrayContaining(Object.keys(example.input))
        );
      }
    });
  });

  it('rejects a misspelled field on updateEvent instead of dropping it', async () => {
    const updateEvent = tools.find((d) => d.tool.name === 'updateEvent')!.handler;

    const result = await updateEvent({ id: 'evt-1', summery: 'Renamed' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('summery');
    expect(textOf(result)).toMatch(/Accepted parameters: .*summary/);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('rejects a call without a required argument before the native CLI runs', async () => {
    const getNote = tools.find((d) => d.tool.name === 'getNote')!.handler;

    const result = await getNote({});

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('getNote requires id');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('lets a call with only declared arguments reach the native CLI', async () => {
    vi.mocked(runCommand).mockResolvedValue({ stdout: '{}', parsed: { notes: [] } });
    const listNotes = tools.find((d) => d.tool.name === 'listNotes')!.handler;

    const result = await listNotes({ folder_id: 'Work', limit: 5 });

    expect(result.isError).toBeUndefined();
    expect(runCommand).toHaveBeenCalledWith('notes', 'list_notes', { folder_id: 'Work', limit: 5 });
    expect(JSON.parse(textOf(result))).toEqual({ notes: [] });
  });
});
