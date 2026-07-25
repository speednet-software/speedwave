import { describe, it, expect, afterEach } from 'vitest';
import { getAllServiceNames, sandboxGlobalName, resolveSandboxGlobals } from './service-list.js';

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
      process.env.ENABLED_SERVICES = 'slack,gitlab,example-plugin';
      const names = getAllServiceNames();
      expect(names).toEqual(['slack', 'gitlab', 'example-plugin']);
    });

    it('includes multiple plugin services', () => {
      process.env.ENABLED_SERVICES = 'slack,example-plugin,crm,analytics';
      const names = getAllServiceNames();
      expect(names).toContain('example-plugin');
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
      process.env.ENABLED_SERVICES = ' slack , example-plugin , gitlab ';
      const names = getAllServiceNames();
      expect(names).toEqual(['slack', 'example-plugin', 'gitlab']);
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

  describe('sandboxGlobalName', () => {
    it('camelCases a dashed service name into a valid JS identifier', () => {
      expect(sandboxGlobalName('my-plugin')).toBe('myPlugin');
    });

    it('leaves an already-valid identifier unchanged', () => {
      expect(sandboxGlobalName('slack')).toBe('slack');
      expect(sandboxGlobalName('host_exec')).toBe('host_exec');
    });

    it('collapses multiple and consecutive dashes', () => {
      expect(sandboxGlobalName('a-b-c')).toBe('aBC');
      expect(sandboxGlobalName('my--plugin')).toBe('myPlugin');
    });

    it('drops a trailing dash and keeps digits after a dash', () => {
      expect(sandboxGlobalName('svc-')).toBe('svc');
      expect(sandboxGlobalName('crm-2go')).toBe('crm2go');
    });

    it('is pure camelization: a reserved word or empty result passes through unchanged', () => {
      // Validation (reserved word / collision) is the executor's job, not this function's.
      expect(sandboxGlobalName('class')).toBe('class');
      expect(sandboxGlobalName('await')).toBe('await');
      expect(sandboxGlobalName('-')).toBe('');
    });

    it('produces a valid AsyncFunction parameter name for every dashed result', () => {
      // Probe with the same constructor production uses; `Function` accepts a wider grammar.
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      for (const name of ['my-plugin', 'a-b-c', 'svc-', 'crm-2go', 'my--plugin']) {
        expect(() => new AsyncFunction(sandboxGlobalName(name), 'return 1')).not.toThrow();
      }
    });
  });

  describe('resolveSandboxGlobals', () => {
    const RESERVED = new Set(['batch', 'collectPages', 'console']);

    it('maps plain and dashed services to their globals', () => {
      const { usable, skipped } = resolveSandboxGlobals(['slack', 'my-plugin'], RESERVED);

      expect(Object.fromEntries(usable)).toEqual({ slack: 'slack', 'my-plugin': 'myPlugin' });
      expect(skipped.size).toBe(0);
    });

    it('skips reserved-word and empty globals', () => {
      const { usable, skipped } = resolveSandboxGlobals(['class', '--'], RESERVED);

      expect(usable.size).toBe(0);
      expect(skipped.get('class')).toContain('invalid sandbox global');
      expect(skipped.get('--')).toContain('invalid sandbox global');
    });

    it('skips a service shadowing a sandbox helper or a JS value global', () => {
      const { usable, skipped } = resolveSandboxGlobals(
        ['collect-pages', 'undefined', 'nan', 'let'],
        RESERVED
      );

      for (const service of ['collect-pages', 'undefined', 'let']) {
        expect(skipped.get(service)).toContain('built-in or unsafe JS global');
      }
      // `nan` is a distinct identifier from `NaN`; only the exact global name is unsafe.
      expect(Object.fromEntries(usable)).toEqual({ nan: 'nan' });
    });

    it('lets an exact name win a collision against a camelCased one', () => {
      const { usable, skipped } = resolveSandboxGlobals(['redmine-', 'redmine'], RESERVED);

      expect(usable.get('redmine')).toBe('redmine');
      expect(usable.has('redmine-')).toBe(false);
      expect(skipped.get('redmine-')).toContain('collides with redmine');
    });

    it('skips all candidates when a collision has no exact-name winner', () => {
      const { usable, skipped } = resolveSandboxGlobals(['a-b', 'a--b'], RESERVED);

      expect(usable.size).toBe(0);
      expect(skipped.get('a-b')).toContain('collides with');
      expect(skipped.get('a--b')).toContain('collides with');
    });

    it('resolves independently of input order', () => {
      const forward = resolveSandboxGlobals(['redmine-', 'redmine'], RESERVED);
      const reverse = resolveSandboxGlobals(['redmine', 'redmine-'], RESERVED);

      expect(Object.fromEntries(forward.usable)).toEqual(Object.fromEntries(reverse.usable));
    });
  });
});
