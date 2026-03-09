import { describe, it, expect } from 'vitest';
import * as handler from './get_current_user.js';
import { metadata } from './get_current_user.js';

//═══════════════════════════════════════════════════════════════════════════════
// Tests for Redmine Get Current User Tool
//
// The handler only exports `metadata` — there is no `execute` function.
// The actual execution is handled by the Redmine service client, not this tool
// handler. Therefore only metadata tests are applicable here.
//═══════════════════════════════════════════════════════════════════════════════

describe('redmine/get_current_user', () => {
  it('does not export an execute function', () => {
    expect('execute' in handler).toBe(false);
  });

  describe('metadata', () => {
    it('should have correct tool name', () => {
      expect(metadata.name).toBe('getCurrentUser');
    });

    it('should have correct category', () => {
      expect(metadata.category).toBe('read');
    });

    it('should have correct service', () => {
      expect(metadata.service).toBe('redmine');
    });

    it('should have non-empty description', () => {
      expect(metadata.description).toBeTruthy();
      expect(typeof metadata.description).toBe('string');
      expect(metadata.description.length).toBeGreaterThan(0);
    });

    it('should have keywords array', () => {
      expect(Array.isArray(metadata.keywords)).toBe(true);
      expect(metadata.keywords.length).toBeGreaterThan(0);
      expect(metadata.keywords).toContain('redmine');
      expect(metadata.keywords).toContain('user');
      expect(metadata.keywords).toContain('current');
    });

    it('should have valid inputSchema with no properties required', () => {
      expect(metadata.inputSchema).toBeDefined();
      expect(metadata.inputSchema.type).toBe('object');
      expect(metadata.inputSchema.properties).toBeDefined();
      expect(Object.keys(metadata.inputSchema.properties as object)).toHaveLength(0);
    });

    it('should have no required input fields', () => {
      expect(metadata.inputSchema.required).toBeUndefined();
    });

    it('should have example code', () => {
      expect(metadata.example).toBeTruthy();
      expect(typeof metadata.example).toBe('string');
      expect(metadata.example).toContain('getCurrentUser');
    });

    it('should have deferLoading enabled', () => {
      expect(metadata.deferLoading).toBe(true);
    });
  });
});
