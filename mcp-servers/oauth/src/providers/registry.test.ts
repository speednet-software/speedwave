import { describe, it, expect } from 'vitest';
import { getProvider, knownProviderIds } from './registry.js';
import { microsoftProvider } from './microsoft.js';
import { slackProvider } from './slack.js';

describe('getProvider', () => {
  it('returns microsoftProvider for id "microsoft"', () => {
    expect(getProvider('microsoft')).toBe(microsoftProvider);
  });

  it('returns slackProvider for id "slack"', () => {
    expect(getProvider('slack')).toBe(slackProvider);
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

  it('lists slack', () => {
    expect(knownProviderIds()).toContain('slack');
  });

  it('returns a non-empty list', () => {
    expect(knownProviderIds().length).toBeGreaterThan(0);
  });
});
