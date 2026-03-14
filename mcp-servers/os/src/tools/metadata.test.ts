/**
 * Metadata Validation Tests
 *
 * Validates that every OS worker tool has required metadata fields:
 * category, keywords, and example.
 */

import { describe, it, expect, vi } from 'vitest';
import { createReminderTools } from './reminder-tools.js';
import { createCalendarTools } from './calendar-tools.js';
import { createMailTools } from './mail-tools.js';
import { createNoteTools } from './notes-tools.js';

// Mock the platform runner (required by tool modules)
vi.mock('../platform-runner.js', () => ({
  runCommand: vi.fn(),
}));

const ALL_TOOLS = [
  ...createReminderTools(),
  ...createCalendarTools(),
  ...createMailTools(),
  ...createNoteTools(),
];

const VALID_CATEGORIES = ['read', 'write', 'delete'] as const;

describe('OS tool metadata', () => {
  it('registers exactly 25 tools', () => {
    expect(ALL_TOOLS).toHaveLength(25);
  });

  describe.each(ALL_TOOLS.map((td) => [td.tool.name, td] as const))('%s', (_name, td) => {
    it('has a category field set to read, write, or delete', () => {
      expect(td.tool.category).toBeDefined();
      expect(VALID_CATEGORIES).toContain(td.tool.category);
    });

    it('has a non-empty keywords array', () => {
      expect(td.tool.keywords).toBeDefined();
      expect(Array.isArray(td.tool.keywords)).toBe(true);
      expect(td.tool.keywords!.length).toBeGreaterThan(0);
      for (const kw of td.tool.keywords!) {
        expect(typeof kw).toBe('string');
        expect(kw.length).toBeGreaterThan(0);
      }
    });

    it('has a non-empty example string', () => {
      expect(td.tool.example).toBeDefined();
      expect(typeof td.tool.example).toBe('string');
      expect(td.tool.example!.length).toBeGreaterThan(0);
    });

    it('has an outputSchema object', () => {
      expect(td.tool.outputSchema).toBeDefined();
      expect(typeof td.tool.outputSchema).toBe('object');
      expect(td.tool.outputSchema).toHaveProperty('type');
    });

    it('has inputExamples with at least one entry', () => {
      expect(td.tool.inputExamples).toBeDefined();
      expect(Array.isArray(td.tool.inputExamples)).toBe(true);
      expect(td.tool.inputExamples!.length).toBeGreaterThan(0);
      for (const ex of td.tool.inputExamples!) {
        expect(typeof ex.description).toBe('string');
        expect(ex.description.length).toBeGreaterThan(0);
        expect(typeof ex.input).toBe('object');
      }
    });
  });

  it('all tool names are unique', () => {
    const names = ALL_TOOLS.map((td) => td.tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('write/delete tools have appropriate categories', () => {
    const writeTools = [
      'createReminder',
      'completeReminder',
      'createEvent',
      'updateEvent',
      'sendEmail',
      'replyToEmail',
      'createNote',
      'updateNote',
    ];
    const deleteTools = ['deleteEvent', 'deleteNote'];

    for (const td of ALL_TOOLS) {
      if (writeTools.includes(td.tool.name)) {
        expect(td.tool.category).toBe('write');
      }
      if (deleteTools.includes(td.tool.name)) {
        expect(td.tool.category).toBe('delete');
      }
    }
  });
});
