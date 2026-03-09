/**
 * OS Tool Metadata Tests
 *
 * Verifies all 25 OS tools are correctly registered with proper metadata.
 */

import { describe, it, expect } from 'vitest';
import { toolMetadata, tools } from './index.js';

describe('OS tool metadata', () => {
  it('should have exactly 25 tools', () => {
    expect(Object.keys(toolMetadata).length).toBe(25);
    expect(tools.length).toBe(25);
  });

  it('all tools should have service "os"', () => {
    for (const [name, meta] of Object.entries(toolMetadata)) {
      expect(meta.service).toBe('os');
    }
  });

  it('all tools should have valid categories', () => {
    const validCategories = ['read', 'write', 'delete'];
    for (const [name, meta] of Object.entries(toolMetadata)) {
      expect(validCategories).toContain(meta.category);
    }
  });

  it('all tools should have required fields', () => {
    for (const [name, meta] of Object.entries(toolMetadata)) {
      expect(meta.name).toBe(name);
      expect(meta.description).toBeTruthy();
      expect(meta.keywords).toBeDefined();
      expect(Array.isArray(meta.keywords)).toBe(true);
      expect(meta.keywords.length).toBeGreaterThan(0);
      expect(meta.inputSchema).toBeDefined();
      expect(meta.example).toBeTruthy();
      expect(meta.timeoutMs).toBe(30_000);
    }
  });

  it('should have correct category assignments', () => {
    // Read tools
    const readTools = [
      'listReminderLists',
      'listReminders',
      'getReminder',
      'listCalendars',
      'listEvents',
      'getEvent',
      'detectMailClients',
      'listMailboxes',
      'listEmails',
      'getEmail',
      'searchEmails',
      'listNoteFolders',
      'listNotes',
      'getNote',
      'searchNotes',
    ];
    for (const name of readTools) {
      expect(toolMetadata[name]?.category).toBe('read');
    }

    // Write tools
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
    for (const name of writeTools) {
      expect(toolMetadata[name]?.category).toBe('write');
    }

    // Delete tools
    const deleteTools = ['deleteEvent', 'deleteNote'];
    for (const name of deleteTools) {
      expect(toolMetadata[name]?.category).toBe('delete');
    }
  });

  it('should have all 5 reminder tools', () => {
    expect(toolMetadata['listReminderLists']).toBeDefined();
    expect(toolMetadata['listReminders']).toBeDefined();
    expect(toolMetadata['getReminder']).toBeDefined();
    expect(toolMetadata['createReminder']).toBeDefined();
    expect(toolMetadata['completeReminder']).toBeDefined();
  });

  it('should have all 6 calendar tools', () => {
    expect(toolMetadata['listCalendars']).toBeDefined();
    expect(toolMetadata['listEvents']).toBeDefined();
    expect(toolMetadata['getEvent']).toBeDefined();
    expect(toolMetadata['createEvent']).toBeDefined();
    expect(toolMetadata['updateEvent']).toBeDefined();
    expect(toolMetadata['deleteEvent']).toBeDefined();
  });

  it('should have all 7 mail tools', () => {
    expect(toolMetadata['detectMailClients']).toBeDefined();
    expect(toolMetadata['listMailboxes']).toBeDefined();
    expect(toolMetadata['listEmails']).toBeDefined();
    expect(toolMetadata['getEmail']).toBeDefined();
    expect(toolMetadata['searchEmails']).toBeDefined();
    expect(toolMetadata['sendEmail']).toBeDefined();
    expect(toolMetadata['replyToEmail']).toBeDefined();
  });

  it('should have all 7 notes tools', () => {
    expect(toolMetadata['listNoteFolders']).toBeDefined();
    expect(toolMetadata['listNotes']).toBeDefined();
    expect(toolMetadata['getNote']).toBeDefined();
    expect(toolMetadata['searchNotes']).toBeDefined();
    expect(toolMetadata['createNote']).toBeDefined();
    expect(toolMetadata['updateNote']).toBeDefined();
    expect(toolMetadata['deleteNote']).toBeDefined();
  });

  it('tools with required params should have required array in inputSchema', () => {
    const toolsWithRequired: Record<string, string[]> = {
      getReminder: ['id'],
      createReminder: ['name'],
      completeReminder: ['id'],
      getEvent: ['id'],
      createEvent: ['summary', 'start', 'end'],
      updateEvent: ['id'],
      deleteEvent: ['id'],
      getEmail: ['id'],
      searchEmails: ['query'],
      sendEmail: ['to', 'subject', 'body', 'confirm_send'],
      replyToEmail: ['id', 'body', 'confirm_send'],
      getNote: ['id'],
      searchNotes: ['query'],
      createNote: ['title'],
      updateNote: ['id'],
      deleteNote: ['id'],
    };

    for (const [name, required] of Object.entries(toolsWithRequired)) {
      const schema = toolMetadata[name]?.inputSchema as { required?: string[] };
      expect(schema?.required).toBeDefined();
      expect(schema?.required?.sort()).toEqual(required.sort());
    }
  });

  it('all tools should have "os" in keywords', () => {
    for (const [name, meta] of Object.entries(toolMetadata)) {
      expect(meta.keywords).toContain('os');
    }
  });

  it('should have osCategory on all OS tools', () => {
    const validCategories = ['reminders', 'calendar', 'mail', 'notes'];
    for (const [name, meta] of Object.entries(toolMetadata)) {
      expect(meta.osCategory).toBeDefined();
      expect(validCategories).toContain(meta.osCategory);
    }
  });

  it('should have correct osCategory assignments', () => {
    const reminderTools = [
      'listReminderLists',
      'listReminders',
      'getReminder',
      'createReminder',
      'completeReminder',
    ];
    for (const name of reminderTools) {
      expect(toolMetadata[name]?.osCategory).toBe('reminders');
    }

    const calendarTools = [
      'listCalendars',
      'listEvents',
      'getEvent',
      'createEvent',
      'updateEvent',
      'deleteEvent',
    ];
    for (const name of calendarTools) {
      expect(toolMetadata[name]?.osCategory).toBe('calendar');
    }

    const mailTools = [
      'detectMailClients',
      'listMailboxes',
      'listEmails',
      'getEmail',
      'searchEmails',
      'sendEmail',
      'replyToEmail',
    ];
    for (const name of mailTools) {
      expect(toolMetadata[name]?.osCategory).toBe('mail');
    }

    const notesTools = [
      'listNoteFolders',
      'listNotes',
      'getNote',
      'searchNotes',
      'createNote',
      'updateNote',
      'deleteNote',
    ];
    for (const name of notesTools) {
      expect(toolMetadata[name]?.osCategory).toBe('notes');
    }
  });

  it('inputSchema should have type and properties', () => {
    for (const [name, meta] of Object.entries(toolMetadata)) {
      const schema = meta.inputSchema as { type?: string; properties?: Record<string, unknown> };
      expect(schema.type).toBe('object');
      expect(schema.properties).toBeDefined();
    }
  });
});
