import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let dir: string | undefined;

const VALID_POLICY_V2 = {
  version: 2,
  source: { policies: ['strict'], forced: [] },
  categories: {
    EMAIL: { tokenize: true, log: false },
    PHONE_PL: { tokenize: true, log: false },
    PESEL: { tokenize: true, log: false },
    NIP: { tokenize: true, log: false },
    IBAN: { tokenize: true, log: false },
    CARD: { tokenize: true, log: false },
    API_KEY: { tokenize: true, log: false },
    SENSITIVE_FIELD: { tokenize: true, log: false },
  },
  customPatterns: [],
  sensitiveKeys: ['password', 'token', 'secret'],
};

const VALID_KEY = 'ab'.repeat(32);

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe('loadPolicy', () => {
  it('loads the compiled-in default policy when POLICY_FILE is unset', async () => {
    vi.stubEnv('POLICY_FILE', undefined);
    const { loadPolicy, getEngine } = await import('./policy.js');

    loadPolicy();

    const { value } = getEngine().tokenize({ note: 'contact a@b.com' });
    expect((value as { note: string }).note).not.toContain('a@b.com');
  });

  it('loads the default policy when POLICY_FILE points at a missing file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hub-policy-test-'));
    vi.stubEnv('POLICY_FILE', join(dir, 'missing.json'));
    const { loadPolicy, getEngine } = await import('./policy.js');

    loadPolicy();

    const { value } = getEngine().tokenize({ note: 'a@b.com' });
    expect((value as { note: string }).note).not.toContain('a@b.com');
  });

  it('loads a present, valid policy file and disables a category per its content', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hub-policy-test-'));
    const file = join(dir, 'policy.json');
    writeFileSync(
      file,
      JSON.stringify({
        ...VALID_POLICY_V2,
        categories: { ...VALID_POLICY_V2.categories, EMAIL: { tokenize: false, log: false } },
      })
    );
    writeFileSync(join(dir, 'key'), VALID_KEY);
    vi.stubEnv('POLICY_FILE', file);
    const { loadPolicy, getEngine } = await import('./policy.js');

    loadPolicy();

    const { value } = getEngine().tokenize({ note: 'a@b.com' });
    expect((value as { note: string }).note).toContain('a@b.com');
  });

  it('throws when the present file is not valid JSON', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hub-policy-test-'));
    const file = join(dir, 'policy.json');
    writeFileSync(file, '{not json');
    writeFileSync(join(dir, 'key'), VALID_KEY);
    vi.stubEnv('POLICY_FILE', file);
    const { loadPolicy } = await import('./policy.js');

    expect(() => loadPolicy()).toThrow(/PII policy engine failed to initialize/);
  });

  it('throws when the present file is schema-invalid', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hub-policy-test-'));
    const file = join(dir, 'policy.json');
    writeFileSync(file, JSON.stringify({ version: 1 }));
    writeFileSync(join(dir, 'key'), VALID_KEY);
    vi.stubEnv('POLICY_FILE', file);
    const { loadPolicy } = await import('./policy.js');

    expect(() => loadPolicy()).toThrow(/PII policy engine failed to initialize/);
  });

  it('throws when the present file is unreadable', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hub-policy-test-'));
    const file = join(dir, 'policy.json');
    writeFileSync(file, JSON.stringify(VALID_POLICY_V2));
    chmodSync(file, 0o000);
    vi.stubEnv('POLICY_FILE', file);
    const { loadPolicy } = await import('./policy.js');

    try {
      expect(() => loadPolicy()).toThrow(/could not be read/);
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it('throws when the present file has no sibling key', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hub-policy-test-'));
    const file = join(dir, 'policy.json');
    writeFileSync(file, JSON.stringify(VALID_POLICY_V2));
    vi.stubEnv('POLICY_FILE', file);
    const { loadPolicy } = await import('./policy.js');

    expect(() => loadPolicy()).toThrow(/key ".*" not found/);
  });

  it('never calls process.exit — the caller decides how to react to the throw', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hub-policy-test-'));
    const file = join(dir, 'policy.json');
    writeFileSync(file, '{not json');
    writeFileSync(join(dir, 'key'), VALID_KEY);
    vi.stubEnv('POLICY_FILE', file);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit must not be called from policy.ts');
    });
    const { loadPolicy } = await import('./policy.js');

    expect(() => loadPolicy()).toThrow(/PII policy engine failed to initialize/);
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });
});

describe('getEngine', () => {
  it('lazily loads the compiled-in default policy when loadPolicy was never called', async () => {
    const { getEngine } = await import('./policy.js');

    const { value } = getEngine().tokenize({ note: 'contact a@b.com' });
    expect((value as { note: string }).note).not.toContain('a@b.com');
  });

  it('returns the same cached instance on repeated calls', async () => {
    const { getEngine } = await import('./policy.js');

    expect(getEngine()).toBe(getEngine());
  });
});
