import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolvePolicy } from './resolve.js';
import { defaultResolvedPolicy } from './resolved-policy.js';

let dir: string | undefined;

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe('resolvePolicy', () => {
  it('falls back to the default when POLICY_FILE is unset', () => {
    expect(resolvePolicy({})).toEqual(defaultResolvedPolicy());
  });

  it('falls back to the default when POLICY_FILE points at a missing file', () => {
    dir = mkdtempSync(join(tmpdir(), 'policy-engine-test-'));
    const missing = join(dir, 'policy.json');
    expect(resolvePolicy({ POLICY_FILE: missing })).toEqual(defaultResolvedPolicy());
  });

  it('parses a present, valid policy file', () => {
    dir = mkdtempSync(join(tmpdir(), 'policy-engine-test-'));
    const file = join(dir, 'policy.json');
    const raw = {
      version: 1,
      source: { mode: 'custom' },
      categories: {
        EMAIL: false,
        PHONE_PL: true,
        PESEL: true,
        NIP: true,
        IBAN: true,
        CARD: true,
        API_KEY: true,
        SENSITIVE_FIELD: true,
      },
      customPatterns: [],
      sensitiveKeys: { add: [], remove: [], forcedAdd: [] },
      forcedCategories: [],
    };
    writeFileSync(file, JSON.stringify(raw));

    const resolved = resolvePolicy({ POLICY_FILE: file });
    expect(resolved.categories.EMAIL).toBe(false);
    expect(resolved.limits).toEqual({ maxTokens: 1000, ttlMs: 1800000 });
  });

  it('throws (fail-closed) when the present file is not valid JSON', () => {
    dir = mkdtempSync(join(tmpdir(), 'policy-engine-test-'));
    const file = join(dir, 'policy.json');
    writeFileSync(file, '{not json');

    expect(() => resolvePolicy({ POLICY_FILE: file })).toThrow(/not valid JSON/);
  });

  it('throws (fail-closed) when the present file has an unsupported version', () => {
    dir = mkdtempSync(join(tmpdir(), 'policy-engine-test-'));
    const file = join(dir, 'policy.json');
    writeFileSync(file, JSON.stringify({ version: 2 }));

    expect(() => resolvePolicy({ POLICY_FILE: file })).toThrow(/unsupported version/);
  });

  it('throws (fail-closed) when the present file is unreadable', () => {
    dir = mkdtempSync(join(tmpdir(), 'policy-engine-test-'));
    const file = join(dir, 'policy.json');
    writeFileSync(file, JSON.stringify({ version: 1 }));
    chmodSync(file, 0o000);

    try {
      expect(() => resolvePolicy({ POLICY_FILE: file })).toThrow(/could not be read/);
    } finally {
      chmodSync(file, 0o600);
    }
  });
});
