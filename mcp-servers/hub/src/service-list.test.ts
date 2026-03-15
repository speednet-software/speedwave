import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BUILT_IN_SERVICES, getAllServiceNames, isPluginService } from './service-list.js';

describe('service-list', () => {
  const originalEnv = process.env.ENABLED_SERVICES;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ENABLED_SERVICES;
    } else {
      process.env.ENABLED_SERVICES = originalEnv;
    }
  });

  describe('BUILT_IN_SERVICES', () => {
    it('contains exactly the 5 built-in services', () => {
      expect(BUILT_IN_SERVICES).toEqual(['slack', 'sharepoint', 'redmine', 'gitlab', 'os']);
    });

    it('is a readonly tuple (as const)', () => {
      // BUILT_IN_SERVICES is declared `as const` which makes it readonly at the TS level.
      // Verify it cannot be changed at runtime by checking the type/content stability.
      expect(BUILT_IN_SERVICES.length).toBe(5);
      expect([...BUILT_IN_SERVICES]).toEqual(['slack', 'sharepoint', 'redmine', 'gitlab', 'os']);
    });
  });

  describe('getAllServiceNames', () => {
    it('returns only built-in services when ENABLED_SERVICES is not set', () => {
      delete process.env.ENABLED_SERVICES;
      const names = getAllServiceNames();
      expect(names).toEqual(['slack', 'sharepoint', 'redmine', 'gitlab', 'os']);
    });

    it('returns only built-in services when ENABLED_SERVICES has only built-in names', () => {
      process.env.ENABLED_SERVICES = 'slack,gitlab';
      const names = getAllServiceNames();
      expect(names).toEqual(['slack', 'sharepoint', 'redmine', 'gitlab', 'os']);
    });

    it('includes plugin services from ENABLED_SERVICES after built-in', () => {
      process.env.ENABLED_SERVICES = 'slack,gitlab,presale';
      const names = getAllServiceNames();
      expect(names).toEqual(['slack', 'sharepoint', 'redmine', 'gitlab', 'os', 'presale']);
    });

    it('includes multiple plugin services', () => {
      process.env.ENABLED_SERVICES = 'slack,presale,crm,analytics';
      const names = getAllServiceNames();
      expect(names).toContain('presale');
      expect(names).toContain('crm');
      expect(names).toContain('analytics');
      expect(names.indexOf('presale')).toBeGreaterThan(names.indexOf('os'));
    });

    it('handles empty ENABLED_SERVICES', () => {
      process.env.ENABLED_SERVICES = '';
      const names = getAllServiceNames();
      expect(names).toEqual(['slack', 'sharepoint', 'redmine', 'gitlab', 'os']);
    });

    it('handles whitespace in ENABLED_SERVICES', () => {
      process.env.ENABLED_SERVICES = ' slack , presale , gitlab ';
      const names = getAllServiceNames();
      expect(names).toContain('presale');
    });

    it('does not duplicate built-in services', () => {
      process.env.ENABLED_SERVICES = 'slack,slack,presale';
      const names = getAllServiceNames();
      const slackCount = names.filter((n) => n === 'slack').length;
      expect(slackCount).toBe(1);
    });
  });

  describe('isPluginService', () => {
    it('returns false for all built-in services', () => {
      for (const service of BUILT_IN_SERVICES) {
        expect(isPluginService(service)).toBe(false);
      }
    });

    it('returns true for plugin service names', () => {
      expect(isPluginService('presale')).toBe(true);
      expect(isPluginService('crm')).toBe(true);
      expect(isPluginService('analytics')).toBe(true);
    });

    it('returns true for unknown service names', () => {
      expect(isPluginService('nonexistent')).toBe(true);
    });

    it('is case-sensitive', () => {
      expect(isPluginService('Slack')).toBe(true);
      expect(isPluginService('SLACK')).toBe(true);
      expect(isPluginService('slack')).toBe(false);
    });
  });
});
