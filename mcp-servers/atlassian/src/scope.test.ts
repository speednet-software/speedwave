/**
 * Tests for project/space scope enforcement.
 */

import { describe, it, expect } from 'vitest';
import {
  ScopeError,
  assertJiraProjectAllowed,
  assertConfluenceSpaceAllowed,
  assertJiraIssueKeyAllowed,
  filterByAllowlist,
} from './scope.js';

describe('assertJiraProjectAllowed / assertConfluenceSpaceAllowed', () => {
  it('no-op when the allowlist is empty', () => {
    expect(() => assertJiraProjectAllowed('ANYTHING', [])).not.toThrow();
    expect(() => assertConfluenceSpaceAllowed(undefined, [])).not.toThrow();
  });

  it('passes when the key is in the allowlist (case-insensitive)', () => {
    expect(() => assertJiraProjectAllowed('proj', ['PROJ', 'OPS'])).not.toThrow();
  });

  it('throws ScopeError when the key is outside the allowlist', () => {
    expect(() => assertJiraProjectAllowed('OTHER', ['PROJ'])).toThrow(ScopeError);
    expect(() => assertJiraProjectAllowed('OTHER', ['PROJ'])).toThrow(/outside the allowed list/);
  });

  it('throws ScopeError when the key cannot be determined but a list is configured', () => {
    expect(() => assertConfluenceSpaceAllowed(undefined, ['DEV'])).toThrow(ScopeError);
    expect(() => assertConfluenceSpaceAllowed('  ', ['DEV'])).toThrow(/Cannot determine/);
  });
});

describe('assertJiraIssueKeyAllowed', () => {
  it('no-op when the allowlist is empty', () => {
    expect(() => assertJiraIssueKeyAllowed('PROJ-1', [])).not.toThrow();
    expect(() => assertJiraIssueKeyAllowed('10001', [])).not.toThrow();
  });

  it('parses the project key from a PROJ-123-style ref and passes when allowed', () => {
    expect(() => assertJiraIssueKeyAllowed('proj-7', ['PROJ'])).not.toThrow();
  });

  it('throws ScopeError when the parsed project is outside the allowlist', () => {
    expect(() => assertJiraIssueKeyAllowed('OTHER-9', ['PROJ'])).toThrow(ScopeError);
  });

  it('throws ScopeError for a bare numeric ID when an allowlist is configured', () => {
    expect(() => assertJiraIssueKeyAllowed('10001', ['PROJ'])).toThrow(ScopeError);
    expect(() => assertJiraIssueKeyAllowed('10001', ['PROJ'])).toThrow(/Cannot determine/);
  });
});

describe('ScopeError', () => {
  it('carries the right name and extends Error', () => {
    const err = new ScopeError('x');
    expect(err.name).toBe('ScopeError');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('filterByAllowlist', () => {
  const items = [{ k: 'PROJ' }, { k: 'OPS' }, { k: 'OTHER' }, { k: undefined }];

  it('returns the list unchanged when the allowlist is empty', () => {
    expect(filterByAllowlist(items, (i) => i.k, [])).toBe(items);
  });

  it('keeps only items whose key is in the allowlist (case-insensitive)', () => {
    expect(filterByAllowlist(items, (i) => i.k, ['proj', 'ops'])).toEqual([
      { k: 'PROJ' },
      { k: 'OPS' },
    ]);
  });

  it('drops items with no resolvable key when an allowlist is set', () => {
    expect(filterByAllowlist(items, (i) => i.k, ['PROJ'])).toEqual([{ k: 'PROJ' }]);
  });
});
