import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let dir: string | undefined;

/**
 * Re-import `policy.js` and `@speedwave/policy-engine` together after `vi.resetModules()` so
 * both come from the same fresh instance (a stale instance fails `toEqual` on function fields).
 * @returns The freshly imported policy module and policy-engine exports
 */
async function importFresh() {
  const policy = await import('./policy.js');
  const engine = await import('@speedwave/policy-engine');
  return { ...policy, ...engine };
}

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
  it('compiles the default policy when POLICY_FILE is unset', async () => {
    vi.stubEnv('POLICY_FILE', undefined);
    const { loadPolicy, getCompiledPolicy, compilePolicy, defaultResolvedPolicy } =
      await importFresh();

    loadPolicy();

    expect(getCompiledPolicy()).toEqual(compilePolicy(defaultResolvedPolicy()));
  });

  it('compiles the default policy when POLICY_FILE points at a missing file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hub-policy-test-'));
    vi.stubEnv('POLICY_FILE', join(dir, 'missing.json'));
    const { loadPolicy, getCompiledPolicy, compilePolicy, defaultResolvedPolicy } =
      await importFresh();

    loadPolicy();

    expect(getCompiledPolicy()).toEqual(compilePolicy(defaultResolvedPolicy()));
  });

  it('compiles a present, valid policy file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hub-policy-test-'));
    const file = join(dir, 'policy.json');
    writeFileSync(
      file,
      JSON.stringify({
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
      })
    );
    vi.stubEnv('POLICY_FILE', file);
    const { loadPolicy, getCompiledPolicy } = await import('./policy.js');

    loadPolicy();

    expect(getCompiledPolicy().categories.EMAIL).toBe(false);
  });

  it('throws when the present file is not valid JSON', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hub-policy-test-'));
    const file = join(dir, 'policy.json');
    writeFileSync(file, '{not json');
    vi.stubEnv('POLICY_FILE', file);
    const { loadPolicy } = await import('./policy.js');

    expect(() => loadPolicy()).toThrow(/not valid JSON/);
  });

  it('throws when the present file is schema-invalid', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hub-policy-test-'));
    const file = join(dir, 'policy.json');
    writeFileSync(file, JSON.stringify({ version: 2 }));
    vi.stubEnv('POLICY_FILE', file);
    const { loadPolicy } = await import('./policy.js');

    expect(() => loadPolicy()).toThrow(/unsupported version/);
  });

  it('throws when the present file is unreadable', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hub-policy-test-'));
    const file = join(dir, 'policy.json');
    writeFileSync(file, JSON.stringify({ version: 1 }));
    chmodSync(file, 0o000);
    vi.stubEnv('POLICY_FILE', file);
    const { loadPolicy } = await import('./policy.js');

    try {
      expect(() => loadPolicy()).toThrow(/could not be read/);
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it('never calls process.exit — the caller decides how to react to the throw', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hub-policy-test-'));
    const file = join(dir, 'policy.json');
    writeFileSync(file, '{not json');
    vi.stubEnv('POLICY_FILE', file);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit must not be called from policy.ts');
    });
    const { loadPolicy } = await import('./policy.js');

    expect(() => loadPolicy()).toThrow(/not valid JSON/);
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });
});

describe('getCompiledPolicy', () => {
  it('lazily compiles the default policy when loadPolicy was never called', async () => {
    const { getCompiledPolicy, compilePolicy, defaultResolvedPolicy } = await importFresh();

    expect(getCompiledPolicy()).toEqual(compilePolicy(defaultResolvedPolicy()));
  });

  it('returns the same cached instance on repeated calls', async () => {
    const { getCompiledPolicy } = await import('./policy.js');

    expect(getCompiledPolicy()).toBe(getCompiledPolicy());
  });
});
