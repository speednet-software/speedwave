/**
 * Metadata Tests - Validates that every Slack tool has required metadata fields
 */

import { describe, it, expect } from 'vitest';
import { createChannelTools } from './channel-tools.js';
import { createDmTools } from './dm-tools.js';
import { createFileTools } from './file-tools.js';
import { createUserTools } from './user-tools.js';
import { ToolDefinition, RefreshLock, META_KEYS, metaValue } from '@speedwave/mcp-shared';
import type { SlackClients } from '../client.js';

/** Helper: clients object representing "tokens missing" — replaces null. */
const stubClients: SlackClients = {
  user: {} as any,
  tokenState: { accessToken: '' },
  lock: new RefreshLock(),
  _tokensStatus: 'missing',
};

const allTools: ToolDefinition[] = [
  ...createChannelTools(stubClients),
  ...createDmTools(stubClients),
  ...createFileTools(stubClients),
  ...createUserTools(stubClients),
];

describe('tool metadata', () => {
  it('should have at least one tool defined', () => {
    expect(allTools.length).toBeGreaterThan(0);
  });

  for (const { tool } of allTools) {
    describe(tool.name, () => {
      it('should have annotations with readOnlyHint and destructiveHint', () => {
        expect(tool.annotations).toBeDefined();
        expect(typeof tool.annotations!.readOnlyHint).toBe('boolean');
        expect(typeof tool.annotations!.destructiveHint).toBe('boolean');
      });

      it('should have keywords with at least 1 entry', () => {
        expect(tool.keywords).toBeDefined();
        expect(Array.isArray(tool.keywords)).toBe(true);
        expect(tool.keywords!.length).toBeGreaterThanOrEqual(1);
      });

      it('should have example as non-empty string', () => {
        expect(tool.example).toBeDefined();
        expect(typeof tool.example).toBe('string');
        expect(tool.example!.length).toBeGreaterThan(0);
      });

      it('should have _meta with the prefixed defer-loading key', () => {
        expect(tool._meta, `${tool.name} missing _meta`).toBeDefined();
        const deferLoading = metaValue(
          tool._meta as Record<string, unknown>,
          META_KEYS.DEFER_LOADING,
          'deferLoading'
        );
        expect(typeof deferLoading, `${tool.name} missing ${META_KEYS.DEFER_LOADING}`).toBe(
          'boolean'
        );
      });
    });
  }
});

describe('identity metadata', () => {
  const userScopedToolNames = [
    'sendChannel',
    'getChannelMessages',
    'getThreadMessages',
    'listChannelIds',
    'listDirectMessages',
    'openDirectMessage',
  ];

  for (const name of userScopedToolNames) {
    it(`${name} declares speedwave.pl/user-scoped`, () => {
      const tool = allTools.find((t) => t.tool.name === name)!.tool;
      const userScoped = metaValue(
        tool._meta as Record<string, unknown>,
        META_KEYS.USER_SCOPED,
        'userScoped'
      );
      expect(userScoped).toBe(true);
    });
  }

  for (const name of ['getChannelMessages', 'getThreadMessages']) {
    it(`${name} points at getCurrentUser via speedwave.pl/current-user-tool`, () => {
      const tool = allTools.find((t) => t.tool.name === name)!.tool;
      const currentUserTool = metaValue(
        tool._meta as Record<string, unknown>,
        META_KEYS.CURRENT_USER_TOOL,
        'currentUserTool'
      );
      expect(currentUserTool).toBe('getCurrentUser');
    });
  }

  it('getFileContent/downloadFile/getUsers/findUsers are not marked user-scoped', () => {
    for (const name of ['getFileContent', 'downloadFile', 'getUsers', 'findUsers']) {
      const tool = allTools.find((t) => t.tool.name === name)!.tool;
      const userScoped = metaValue(
        tool._meta as Record<string, unknown>,
        META_KEYS.USER_SCOPED,
        'userScoped'
      );
      expect(userScoped, `${name} should not be user-scoped`).toBeUndefined();
    }
  });
});
