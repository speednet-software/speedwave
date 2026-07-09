import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseResolvedPolicy,
  defaultResolvedPolicy,
  resolvedPolicyFromTemplate,
  compilePolicy,
} from './resolved-policy.js';
import { loadTemplate } from './template-loader.js';
import { PIIType, type ResolvedPolicy } from './types.js';

const ALL_TRUE = {
  EMAIL: true,
  PHONE_PL: true,
  PESEL: true,
  NIP: true,
  IBAN: true,
  CARD: true,
  API_KEY: true,
  SENSITIVE_FIELD: true,
};

function validResolvedPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    source: { mode: 'template', templateId: 'gdpr-art32' },
    categories: ALL_TRUE,
    customPatterns: [],
    sensitiveKeys: { add: [], remove: [], forcedAdd: [] },
    limits: { maxTokens: 1000, ttlMs: 1800000 },
    forcedCategories: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('defaultResolvedPolicy', () => {
  it('enables all 8 categories with today-equivalent limits and no overrides', () => {
    const policy = defaultResolvedPolicy();
    expect(policy).toEqual({
      version: 1,
      source: { mode: 'template', templateId: 'strict' },
      categories: ALL_TRUE,
      customPatterns: [],
      sensitiveKeys: { add: [], remove: [], forcedAdd: [] },
      limits: { maxTokens: 1000, ttlMs: 1800000 },
      forcedCategories: [],
    });
  });

  it('deep-equals the resolved "strict" template (test-pinned on both sides)', () => {
    const strict = resolvedPolicyFromTemplate(loadTemplate('strict'));
    expect(strict).toEqual(defaultResolvedPolicy());
  });
});

describe('resolvedPolicyFromTemplate', () => {
  it('carries the template categories, customPatterns and sensitiveKeys through', () => {
    const template = loadTemplate('gdpr-art32');
    const resolved = resolvedPolicyFromTemplate(template);

    expect(resolved.categories).toEqual(template.categories);
    expect(resolved.categories.API_KEY).toBe(false);
    expect(resolved.source).toEqual({ mode: 'template', templateId: 'gdpr-art32' });
    expect(resolved.sensitiveKeys).toEqual({ add: [], remove: [], forcedAdd: [] });
    expect(resolved.forcedCategories).toEqual([]);
  });
});

describe('parseResolvedPolicy — schema validation matrix', () => {
  it('parses a well-formed resolved policy', () => {
    const raw = validResolvedPolicy();
    expect(parseResolvedPolicy(raw)).toEqual(raw);
  });

  it('rejects a non-object', () => {
    expect(() => parseResolvedPolicy(null)).toThrow(/must be an object/);
  });

  it('rejects an unsupported version', () => {
    expect(() => parseResolvedPolicy(validResolvedPolicy({ version: 2 }))).toThrow(
      /unsupported version/
    );
  });

  it('rejects an invalid source.mode', () => {
    expect(() =>
      parseResolvedPolicy(validResolvedPolicy({ source: { mode: 'bogus' } }))
    ).toThrow(/source.mode/);
  });

  it('rejects a non-object source', () => {
    expect(() => parseResolvedPolicy(validResolvedPolicy({ source: 'template' }))).toThrow(
      /source must be an object/
    );
  });

  it('requires templateId when source.mode is "template"', () => {
    expect(() =>
      parseResolvedPolicy(validResolvedPolicy({ source: { mode: 'template' } }))
    ).toThrow(/templateId/);
  });

  it('accepts source.mode "custom" without a templateId', () => {
    const raw = validResolvedPolicy({ source: { mode: 'custom' } });
    expect(parseResolvedPolicy(raw).source).toEqual({ mode: 'custom' });
  });

  it('accepts source.mode "custom" with an informational templateId', () => {
    const raw = validResolvedPolicy({ source: { mode: 'custom', templateId: 'gdpr-art32' } });
    expect(parseResolvedPolicy(raw).source).toEqual({ mode: 'custom', templateId: 'gdpr-art32' });
  });

  it('rejects a missing category', () => {
    const { SENSITIVE_FIELD, ...missing } = ALL_TRUE;
    expect(() => parseResolvedPolicy(validResolvedPolicy({ categories: missing }))).toThrow(
      /missing required key "SENSITIVE_FIELD"/
    );
  });

  it('rejects an unknown category', () => {
    expect(() =>
      parseResolvedPolicy(validResolvedPolicy({ categories: { ...ALL_TRUE, BOGUS: true } }))
    ).toThrow(/unknown key/);
  });

  it('rejects a custom pattern id colliding with a built-in PIIType', () => {
    const raw = validResolvedPolicy({
      customPatterns: [
        { id: PIIType.EMAIL, displayName: 'x', pattern: 'abc', caseInsensitive: false, forced: false },
      ],
    });
    expect(() => parseResolvedPolicy(raw)).toThrow(/collides with a built-in PIIType/);
  });

  it('rejects duplicate custom pattern ids', () => {
    const rule = { id: 'DUP_ID', displayName: 'x', pattern: 'abc', caseInsensitive: false, forced: false };
    const raw = validResolvedPolicy({ customPatterns: [rule, { ...rule }] });
    expect(() => parseResolvedPolicy(raw)).toThrow(/duplicated/);
  });

  it('defaults sensitiveKeys sub-arrays to empty when omitted', () => {
    const raw = validResolvedPolicy({ sensitiveKeys: {} });
    expect(parseResolvedPolicy(raw).sensitiveKeys).toEqual({ add: [], remove: [], forcedAdd: [] });
  });

  it('rejects a non-array sensitiveKeys.forcedAdd', () => {
    const raw = validResolvedPolicy({ sensitiveKeys: { add: [], remove: [], forcedAdd: 'x' } });
    expect(() => parseResolvedPolicy(raw)).toThrow(/must be an array of strings/);
  });

  it('rejects a missing sensitiveKeys', () => {
    const { sensitiveKeys, ...rest } = validResolvedPolicy();
    expect(() => parseResolvedPolicy(rest)).toThrow(/sensitiveKeys must be an object/);
  });

  it('defaults limits to the today-equivalent maxTokens/ttlMs when omitted', () => {
    const { limits, ...rest } = validResolvedPolicy();
    expect(parseResolvedPolicy(rest).limits).toEqual({ maxTokens: 1000, ttlMs: 1800000 });
  });

  it('accepts explicit limits overrides', () => {
    const raw = validResolvedPolicy({ limits: { maxTokens: 42, ttlMs: 5000 } });
    expect(parseResolvedPolicy(raw).limits).toEqual({ maxTokens: 42, ttlMs: 5000 });
  });

  it('defaults maxTokens when limits is present but omits it', () => {
    const raw = validResolvedPolicy({ limits: { ttlMs: 5000 } });
    expect(parseResolvedPolicy(raw).limits).toEqual({ maxTokens: 1000, ttlMs: 5000 });
  });

  it('defaults ttlMs when limits is present but omits it', () => {
    const raw = validResolvedPolicy({ limits: { maxTokens: 42 } });
    expect(parseResolvedPolicy(raw).limits).toEqual({ maxTokens: 42, ttlMs: 1800000 });
  });

  it('defaults customPatterns to an empty array when omitted', () => {
    const { customPatterns, ...rest } = validResolvedPolicy();
    expect(parseResolvedPolicy(rest).customPatterns).toEqual([]);
  });

  it('rejects a non-positive maxTokens', () => {
    const raw = validResolvedPolicy({ limits: { maxTokens: 0, ttlMs: 5000 } });
    expect(() => parseResolvedPolicy(raw)).toThrow(/maxTokens/);
  });

  it('rejects a non-positive ttlMs', () => {
    const raw = validResolvedPolicy({ limits: { maxTokens: 5, ttlMs: -1 } });
    expect(() => parseResolvedPolicy(raw)).toThrow(/ttlMs/);
  });

  it('rejects a non-object limits', () => {
    const raw = validResolvedPolicy({ limits: 'nope' });
    expect(() => parseResolvedPolicy(raw)).toThrow(/limits must be an object/);
  });

  it('defaults forcedCategories to an empty array when omitted', () => {
    const { forcedCategories, ...rest } = validResolvedPolicy();
    expect(parseResolvedPolicy(rest).forcedCategories).toEqual([]);
  });

  it('rejects an unknown forcedCategories entry', () => {
    const raw = validResolvedPolicy({ forcedCategories: ['BOGUS'] });
    expect(() => parseResolvedPolicy(raw)).toThrow(/forcedCategories/);
  });

  it('accepts a valid forcedCategories entry', () => {
    const raw = validResolvedPolicy({ forcedCategories: [PIIType.EMAIL] });
    expect(parseResolvedPolicy(raw).forcedCategories).toEqual([PIIType.EMAIL]);
  });

  it('rejects a non-array forcedCategories', () => {
    const raw = validResolvedPolicy({ forcedCategories: 'nope' });
    expect(() => parseResolvedPolicy(raw)).toThrow(/forcedCategories must be an array/);
  });

  it('logs and ignores an unknown top-level field', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = validResolvedPolicy({ bogusTopLevelField: 'x' });
    const parsed = parseResolvedPolicy(raw);

    expect(parsed).not.toHaveProperty('bogusTopLevelField');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bogusTopLevelField'));
  });
});

describe('compilePolicy', () => {
  it('compiles built-in patterns in today-exact order for an all-on policy', () => {
    const compiled = compilePolicy(defaultResolvedPolicy());
    expect(compiled.patterns.map((p) => p.type)).toEqual([
      PIIType.EMAIL,
      PIIType.PHONE_PL,
      PIIType.PESEL,
      PIIType.NIP,
      PIIType.IBAN,
      PIIType.CARD,
      PIIType.API_KEY,
    ]);
  });

  it('excludes a category-off built-in pattern (category-off passthrough)', () => {
    const policy: ResolvedPolicy = {
      ...defaultResolvedPolicy(),
      categories: { ...ALL_TRUE, EMAIL: false },
    };
    const compiled = compilePolicy(policy);
    expect(compiled.patterns.map((p) => p.type)).not.toContain(PIIType.EMAIL);
  });

  it('re-forces a category-off built-in when it is in forcedCategories', () => {
    const policy: ResolvedPolicy = {
      ...defaultResolvedPolicy(),
      categories: { ...ALL_TRUE, EMAIL: false },
      forcedCategories: [PIIType.EMAIL],
    };
    const compiled = compilePolicy(policy);
    expect(compiled.patterns.map((p) => p.type)).toContain(PIIType.EMAIL);
  });

  it('disables key-name detection when SENSITIVE_FIELD is off', () => {
    const policy: ResolvedPolicy = {
      ...defaultResolvedPolicy(),
      categories: { ...ALL_TRUE, SENSITIVE_FIELD: false },
    };
    expect(compilePolicy(policy).sensitiveKeysEnabled).toBe(false);
  });

  it('appends custom patterns after built-ins, in file order, without a validator', () => {
    const policy: ResolvedPolicy = {
      ...defaultResolvedPolicy(),
      customPatterns: [
        { id: 'EMP_ID', displayName: 'a', pattern: '\\bEMP-\\d{4}\\b', caseInsensitive: false, forced: false },
        { id: 'BADGE_ID', displayName: 'b', pattern: '\\bBADGE-\\d{4}\\b', caseInsensitive: true, forced: false },
      ],
    };
    const compiled = compilePolicy(policy);
    const custom = compiled.patterns.slice(7);
    expect(custom.map((p) => p.type)).toEqual(['EMP_ID', 'BADGE_ID']);
    expect(custom.every((p) => p.validator === undefined)).toBe(true);
    expect(custom[0].regex.flags).toBe('g');
    expect(custom[1].regex.flags).toBe('gi');
  });

  it('skips a custom pattern that fails pattern-lint, logging an error, without throwing', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const policy: ResolvedPolicy = {
      ...defaultResolvedPolicy(),
      customPatterns: [
        { id: 'BAD_ID', displayName: 'bad', pattern: '(a+)+', caseInsensitive: false, forced: false },
      ],
    };
    const compiled = compilePolicy(policy);

    expect(compiled.patterns.map((p) => p.type)).not.toContain('BAD_ID');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('BAD_ID'));
  });

  it('unions add, subtracts remove, and re-forces forcedAdd over remove', () => {
    const policy: ResolvedPolicy = {
      ...defaultResolvedPolicy(),
      sensitiveKeys: { add: ['salary'], remove: ['password'], forcedAdd: ['password'] },
    };
    const compiled = compilePolicy(policy);

    expect(compiled.sensitiveKeys).toContain('salary');
    // "password" is both removed and forcedAdd — forcedAdd wins (defense-in-depth re-force).
    expect(compiled.sensitiveKeys).toContain('password');
  });

  it('subtracts a removed default key that is not also forced', () => {
    const policy: ResolvedPolicy = {
      ...defaultResolvedPolicy(),
      sensitiveKeys: { add: [], remove: ['password'], forcedAdd: [] },
    };
    const compiled = compilePolicy(policy);
    expect(compiled.sensitiveKeys).not.toContain('password');
  });

  it('maps limits to maxTokens/ttlMs, defaulting when omitted', () => {
    const policy: ResolvedPolicy = { ...defaultResolvedPolicy(), limits: undefined };
    const compiled = compilePolicy(policy);
    expect(compiled.maxTokens).toBe(1000);
    expect(compiled.ttlMs).toBe(1800000);
  });

  it('applies explicit limits overrides', () => {
    const policy: ResolvedPolicy = { ...defaultResolvedPolicy(), limits: { maxTokens: 5, ttlMs: 9 } };
    const compiled = compilePolicy(policy);
    expect(compiled.maxTokens).toBe(5);
    expect(compiled.ttlMs).toBe(9);
  });

  it('defaults maxTokens/ttlMs when a hand-built policy has a partially-populated limits object', () => {
    // compilePolicy accepts a ResolvedPolicy directly (not necessarily one that went through
    // parseResolvedPolicy's normalization), so it must independently guard a partial `limits`.
    const policy: ResolvedPolicy = { ...defaultResolvedPolicy(), limits: {} };
    const compiled = compilePolicy(policy);
    expect(compiled.maxTokens).toBe(1000);
    expect(compiled.ttlMs).toBe(1800000);
  });
});
