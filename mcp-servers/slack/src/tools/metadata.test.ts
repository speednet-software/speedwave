/**
 * Metadata Tests - Validates that every Slack tool has required metadata fields
 */

import { describe, it, expect } from 'vitest';
import { createChannelTools } from './channel-tools.js';
import { createUserTools } from './user-tools.js';
import { ToolDefinition } from '@speedwave/mcp-shared';

const allTools: ToolDefinition[] = [...createChannelTools(null), ...createUserTools(null)];

describe('tool metadata', () => {
  it('should have at least one tool defined', () => {
    expect(allTools.length).toBeGreaterThan(0);
  });

  for (const { tool } of allTools) {
    describe(tool.name, () => {
      it('should have category defined', () => {
        expect(tool.category).toBeDefined();
        expect(['read', 'write', 'delete']).toContain(tool.category);
      });

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
    });
  }
});
