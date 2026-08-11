import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadEngine } from './engine.js';

const VALID_POLICY_V3 = {
  version: 3,
  source: { policies: ['strict'], forced: [] },
  rules: [
    {
      id: 'EMAIL',
      displayName: 'E-mail address',
      patterns: ['[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}'],
      caseSensitive: true,
      tokenize: true,
      log: false,
    },
  ],
  keywords: [],
};

/**
 * Run `fn` against a fresh temp dir, always cleaning it up afterward.
 * @param fn - Callback receiving the temp dir path
 * @returns Whatever `fn` returns
 */
function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'policy-engine-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('loadEngine', () => {
  it('uses the compiled-in default policy and an ephemeral key when POLICY_FILE is unset', () => {
    const engine = loadEngine({});
    const { value, detections } = engine.tokenize({ note: 'contact a@b.com' });
    expect((value as { note: string }).note).not.toContain('a@b.com');
    expect(detections.some((d) => d.category === 'EMAIL')).toBe(true);
  });

  it('uses the default policy when POLICY_FILE points at a missing file', () => {
    withTempDir((dir) => {
      const engine = loadEngine({ POLICY_FILE: join(dir, 'missing.json') });
      const { value } = engine.tokenize({ note: 'a@b.com' });
      expect((value as { note: string }).note).not.toContain('a@b.com');
    });
  });

  it('loads a present, valid policy file and its sibling key', () => {
    withTempDir((dir) => {
      const policyFile = join(dir, 'policy.json');
      writeFileSync(policyFile, JSON.stringify(VALID_POLICY_V3));
      writeFileSync(join(dir, 'key'), 'ab'.repeat(32));
      const engine = loadEngine({ POLICY_FILE: policyFile });
      const original = { email: 'x@y.com' };
      const tokenized = engine.tokenize(original);
      expect((tokenized.value as { email: string }).email).not.toBe('x@y.com');
      expect(engine.detokenize(tokenized.value)).toEqual(original);
    });
  });

  it('trims trailing whitespace from the key file', () => {
    withTempDir((dir) => {
      const policyFile = join(dir, 'policy.json');
      writeFileSync(policyFile, JSON.stringify(VALID_POLICY_V3));
      writeFileSync(join(dir, 'key'), `${'cd'.repeat(32)}\n`);
      expect(() => loadEngine({ POLICY_FILE: policyFile })).not.toThrow();
    });
  });

  it('throws when POLICY_FILE is present but unreadable', () => {
    withTempDir((dir) => {
      const policyFile = join(dir, 'policy.json');
      writeFileSync(policyFile, JSON.stringify(VALID_POLICY_V3));
      chmodSync(policyFile, 0o000);
      try {
        expect(() => loadEngine({ POLICY_FILE: policyFile })).toThrow(/could not be read/);
      } finally {
        chmodSync(policyFile, 0o600);
      }
    });
  });

  it('throws when POLICY_FILE is present but the sibling key file is missing', () => {
    withTempDir((dir) => {
      const policyFile = join(dir, 'policy.json');
      writeFileSync(policyFile, JSON.stringify(VALID_POLICY_V3));
      expect(() => loadEngine({ POLICY_FILE: policyFile })).toThrow(/key ".*" not found/);
    });
  });

  it('throws when the sibling key file is unreadable', () => {
    withTempDir((dir) => {
      const policyFile = join(dir, 'policy.json');
      writeFileSync(policyFile, JSON.stringify(VALID_POLICY_V3));
      const keyFile = join(dir, 'key');
      writeFileSync(keyFile, 'ab'.repeat(32));
      chmodSync(keyFile, 0o000);
      try {
        expect(() => loadEngine({ POLICY_FILE: policyFile })).toThrow(/key ".*" could not be read/);
      } finally {
        chmodSync(keyFile, 0o600);
      }
    });
  });

  it('throws (fail-closed) when the policy content fails to compile', () => {
    withTempDir((dir) => {
      const policyFile = join(dir, 'policy.json');
      writeFileSync(policyFile, JSON.stringify({ version: 1 }));
      writeFileSync(join(dir, 'key'), 'ab'.repeat(32));
      expect(() => loadEngine({ POLICY_FILE: policyFile })).toThrow(
        /PII policy engine failed to initialize/
      );
    });
  });

  it('throws (fail-closed) when the key is not valid hex', () => {
    withTempDir((dir) => {
      const policyFile = join(dir, 'policy.json');
      writeFileSync(policyFile, JSON.stringify(VALID_POLICY_V3));
      writeFileSync(join(dir, 'key'), 'not-hex');
      expect(() => loadEngine({ POLICY_FILE: policyFile })).toThrow(
        /PII policy engine failed to initialize/
      );
    });
  });
});

describe('PiiEngine tokenize/detokenize', () => {
  it('passes undefined through unchanged in both directions', () => {
    const engine = loadEngine({});
    expect(engine.tokenize(undefined)).toEqual({ value: undefined, detections: [] });
    expect(engine.detokenize(undefined)).toBeUndefined();
  });

  it('round-trips arrays and nested objects', () => {
    const engine = loadEngine({});
    const original = { people: [{ email: 'a@b.com' }, { email: 'c@d.com' }] };
    const { value } = engine.tokenize(original);
    expect(value).not.toEqual(original);
    expect(engine.detokenize(value)).toEqual(original);
  });

  it('detokenize throws (fail-closed) on a tampered token', () => {
    const engine = loadEngine({});
    const { value } = engine.tokenize({ email: 'a@b.com' }) as { value: { email: string } };
    const tampered = { email: value.email.replace('TOKEN_', 'TOKEN_X') };
    expect(() => engine.detokenize(tampered)).toThrow();
  });
});

describe('keyword masking', () => {
  const KEYWORD_POLICY_V3 = {
    ...VALID_POLICY_V3,
    keywords: [{ match: 'coca-cola', alias: 'Brandex', caseSensitive: false }],
  };

  /**
   * Write the keyword-bearing policy + key into `dir` and load an engine bound to it.
   * @param dir - Temp dir to write policy.json and the sibling key into
   * @returns The loaded engine
   */
  function keywordEngine(dir: string) {
    const policyFile = join(dir, 'policy.json');
    writeFileSync(policyFile, JSON.stringify(KEYWORD_POLICY_V3));
    writeFileSync(join(dir, 'key'), 'ab'.repeat(32));
    return loadEngine({ POLICY_FILE: policyFile });
  }

  it('tokenize masks keywords in nested values preserving the case pattern', () => {
    withTempDir((dir) => {
      const engine = keywordEngine(dir);
      const { value, detections } = engine.tokenize({
        note: 'coca-cola shipped',
        tags: ['COCA-COLA', 7],
      });
      const v = value as { note: string; tags: [string, number] };
      expect(v.note).toBe('brandex shipped');
      expect(v.tags[0]).toBe('BRANDEX');
      expect(v.tags[1]).toBe(7);
      // Keyword masking is not a detection: the audit contract carries PII categories only.
      expect(detections).toEqual([]);
    });
  });

  it('detokenize unmasks aliases and round-trips together with PII tokens', () => {
    withTempDir((dir) => {
      const engine = keywordEngine(dir);
      const original = { note: `coca-cola contact: ${['user', 'example.com'].join('@')}` };
      const { value } = engine.tokenize(original);
      const masked = value as { note: string };
      expect(masked.note).toContain('brandex');
      expect(masked.note).toContain('[EMAIL:TOKEN_');
      expect(engine.detokenize(value)).toEqual(original);
    });
  });

  it('a keyword-less policy leaves keyword-looking text untouched', () => {
    withTempDir((dir) => {
      const policyFile = join(dir, 'policy.json');
      writeFileSync(policyFile, JSON.stringify(VALID_POLICY_V3));
      writeFileSync(join(dir, 'key'), 'ab'.repeat(32));
      const engine = loadEngine({ POLICY_FILE: policyFile });
      const { value } = engine.tokenize({ note: 'Brandex and coca-cola stay' });
      expect((value as { note: string }).note).toBe('Brandex and coca-cola stay');
    });
  });
});
