import { describe, it, expect, afterEach } from 'vitest';
import { getAllServiceNames } from './service-list.js';

describe('service-list', () => {
  const originalEnv = process.env.ENABLED_SERVICES;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ENABLED_SERVICES;
    } else {
      process.env.ENABLED_SERVICES = originalEnv;
    }
  });

  describe('getAllServiceNames', () => {
    it('returns empty array when ENABLED_SERVICES is not set', () => {
      delete process.env.ENABLED_SERVICES;
      const names = getAllServiceNames();
      expect(names).toEqual([]);
    });

    it('returns services listed in ENABLED_SERVICES', () => {
      process.env.ENABLED_SERVICES = 'slack,gitlab';
      const names = getAllServiceNames();
      expect(names).toEqual(['slack', 'gitlab']);
    });

    it('includes plugin services from ENABLED_SERVICES', () => {
      process.env.ENABLED_SERVICES = 'slack,gitlab,presale';
      const names = getAllServiceNames();
      expect(names).toEqual(['slack', 'gitlab', 'presale']);
    });

    it('includes multiple plugin services', () => {
      process.env.ENABLED_SERVICES = 'slack,presale,crm,analytics';
      const names = getAllServiceNames();
      expect(names).toContain('presale');
      expect(names).toContain('crm');
      expect(names).toContain('analytics');
      expect(names).toContain('slack');
    });

    it('returns empty array when ENABLED_SERVICES is empty string', () => {
      process.env.ENABLED_SERVICES = '';
      const names = getAllServiceNames();
      expect(names).toEqual([]);
    });

    it('handles whitespace in ENABLED_SERVICES', () => {
      process.env.ENABLED_SERVICES = ' slack , presale , gitlab ';
      const names = getAllServiceNames();
      expect(names).toEqual(['slack', 'presale', 'gitlab']);
    });

    it('filters out empty entries from trailing commas', () => {
      process.env.ENABLED_SERVICES = 'slack,,gitlab,';
      const names = getAllServiceNames();
      expect(names).toEqual(['slack', 'gitlab']);
    });

    it('preserves order from env var', () => {
      process.env.ENABLED_SERVICES = 'gitlab,slack,os';
      const names = getAllServiceNames();
      expect(names).toEqual(['gitlab', 'slack', 'os']);
    });
  });
});
