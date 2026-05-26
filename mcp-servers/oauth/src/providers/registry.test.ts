import { describe, it, expect } from 'vitest';
import { getProvider, knownProviderIds } from './registry.js';
import { microsoftProvider } from './microsoft.js';

describe('getProvider', () => {
  it('returns microsoftProvider for id "microsoft"', () => {
    expect(getProvider('microsoft')).toBe(microsoftProvider);
  });

  it('returns undefined for an unknown id', () => {
    expect(getProvider('nonexistent')).toBeUndefined();
  });

  it('returns undefined for an empty id', () => {
    expect(getProvider('')).toBeUndefined();
  });
});

describe('knownProviderIds', () => {
  it('lists microsoft', () => {
    expect(knownProviderIds()).toContain('microsoft');
  });

  it('returns a non-empty list', () => {
    expect(knownProviderIds().length).toBeGreaterThan(0);
  });
});
