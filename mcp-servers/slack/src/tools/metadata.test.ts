/**
 * Metadata Tests - Validates that every Slack tool has required metadata fields
 */

import { describe, it, expect } from 'vitest';
import { createChannelTools } from './channel-tools.js';
import { createDmTools } from './dm-tools.js';
import { createFileTools } from './file-tools.js';
import { createUserTools } from './user-tools.js';
import { ToolDefinition, RefreshLock, META_KEYS } from '@speedwave/mcp-shared';
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

/** Every tool that MUST declare speedwave.pl/user-scoped: true. */
const userScopedToolNames = new Set([
  'sendChannel',
  'getChannelMessages',
  'getThreadMessages',
  'listChannelIds',
  'listDirectMessages',
  'openDirectMessage',
]);

describe('tool metadata', () => {
  it('should have at least one tool defined', () => {
    expect(allTools.length).toBeGreaterThan(0);
  });

  for (const { tool } of allTools) {
    describe(tool.name, () => {
      const meta = tool._meta as Record<string, unknown> | undefined;

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
        expect(meta, `${tool.name} missing _meta`).toBeDefined();
        expect(typeof meta![META_KEYS.DEFER_LOADING], `${tool.name} missing prefixed key`).toBe(
          'boolean'
        );
      });

      it('should not use the legacy unprefixed deferLoading key', () => {
        expect(meta?.deferLoading, `${tool.name} still uses legacy deferLoading`).toBeUndefined();
      });

      const isUserScoped = userScopedToolNames.has(tool.name);

      it(`should ${isUserScoped ? '' : 'not '}declare speedwave.pl/user-scoped`, () => {
        if (isUserScoped) {
          expect(meta?.[META_KEYS.USER_SCOPED]).toBe(true);
        } else {
          expect(
            meta?.[META_KEYS.USER_SCOPED],
            `${tool.name} unexpectedly user-scoped`
          ).toBeFalsy();
        }
      });

      it('should not use the legacy unprefixed userScoped key', () => {
        expect(meta?.userScoped, `${tool.name} still uses legacy userScoped`).toBeUndefined();
      });

      if (isUserScoped) {
        it('should declare a current-user tool or self-param resolving its identity', () => {
          const currentUserTool = meta?.[META_KEYS.CURRENT_USER_TOOL];
          const selfParam = meta?.[META_KEYS.SELF_PARAM];
          expect(
            currentUserTool !== undefined || selfParam !== undefined,
            `${tool.name} is user-scoped but declares neither ${META_KEYS.CURRENT_USER_TOOL} nor ${META_KEYS.SELF_PARAM}`
          ).toBe(true);
        });

        it('should not use the legacy currentUserTool/selfParam keys', () => {
          expect(
            meta?.currentUserTool,
            `${tool.name} still uses legacy currentUserTool`
          ).toBeUndefined();
          expect(meta?.selfParam, `${tool.name} still uses legacy selfParam`).toBeUndefined();
        });
      }
    });
  }
});

describe('identity metadata', () => {
  for (const name of ['getChannelMessages', 'getThreadMessages']) {
    it(`${name} points at getCurrentUser via speedwave.pl/current-user-tool`, () => {
      const tool = allTools.find((t) => t.tool.name === name)!.tool;
      const meta = tool._meta as Record<string, unknown>;
      expect(meta[META_KEYS.CURRENT_USER_TOOL]).toBe('getCurrentUser');
    });
  }
});
