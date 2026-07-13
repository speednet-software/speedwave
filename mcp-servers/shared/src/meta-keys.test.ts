import { describe, it, expect } from 'vitest';
import { META_KEYS, metaValue } from './meta-keys.js';

describe('META_KEYS', () => {
  it('exposes all seven prefixed keys under the speedwave.pl/ namespace', () => {
    expect(Object.values(META_KEYS)).toHaveLength(7);
    for (const key of Object.values(META_KEYS)) {
      expect(key.startsWith('speedwave.pl/')).toBe(true);
    }
  });

  it('has the exact expected key values', () => {
    expect(META_KEYS.USER_SCOPED).toBe('speedwave.pl/user-scoped');
    expect(META_KEYS.CURRENT_USER_TOOL).toBe('speedwave.pl/current-user-tool');
    expect(META_KEYS.SELF_PARAM).toBe('speedwave.pl/self-param');
    expect(META_KEYS.DEFER_LOADING).toBe('speedwave.pl/defer-loading');
    expect(META_KEYS.TIMEOUT_CLASS).toBe('speedwave.pl/timeout-class');
    expect(META_KEYS.TIMEOUT_MS).toBe('speedwave.pl/timeout-ms');
    expect(META_KEYS.OS_CATEGORY).toBe('speedwave.pl/os-category');
  });

  it('is frozen (cannot be mutated)', () => {
    expect(Object.isFrozen(META_KEYS)).toBe(true);
  });
});

describe('metaValue', () => {
  it('returns the prefixed value when present', () => {
    const meta = { [META_KEYS.DEFER_LOADING]: false, deferLoading: true };
    expect(metaValue(meta, META_KEYS.DEFER_LOADING, 'deferLoading')).toBe(false);
  });

  it('falls back to the legacy unprefixed key when prefixed is absent', () => {
    const meta = { deferLoading: true };
    expect(metaValue(meta, META_KEYS.DEFER_LOADING, 'deferLoading')).toBe(true);
  });

  it('returns undefined when neither key is present', () => {
    const meta = { somethingElse: 1 };
    expect(metaValue(meta, META_KEYS.DEFER_LOADING, 'deferLoading')).toBeUndefined();
  });

  it('returns undefined when meta itself is undefined', () => {
    expect(metaValue(undefined, META_KEYS.DEFER_LOADING, 'deferLoading')).toBeUndefined();
  });

  it('prefers prefixed key even when its value is falsy (0/false/"")', () => {
    const meta = { [META_KEYS.TIMEOUT_MS]: 0, timeoutMs: 5000 };
    expect(metaValue(meta, META_KEYS.TIMEOUT_MS, 'timeoutMs')).toBe(0);
  });

  it('treats an explicit null prefixed value as present (does not fall back)', () => {
    const meta = { [META_KEYS.SELF_PARAM]: null, self_param: 'user_id' };
    expect(metaValue(meta, META_KEYS.SELF_PARAM, 'self_param')).toBeNull();
  });
});
