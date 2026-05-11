/**
 * Tests for ADF / Confluence-storage helpers and project/space scope guards.
 */

import { describe, it, expect } from 'vitest';
import {
  textToAdf,
  isAdfDoc,
  toAdf,
  storageBody,
  textToStorage,
  ScopeError,
  assertJiraProjectAllowed,
  assertConfluenceSpaceAllowed,
  filterByAllowlist,
} from './adf.js';

describe('textToAdf', () => {
  it('wraps a single line in one paragraph', () => {
    expect(textToAdf('hello')).toEqual({
      version: 1,
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    });
  });

  it('produces one paragraph per line', () => {
    const doc = textToAdf('a\nb');
    expect(doc.content).toHaveLength(2);
    expect(doc.content[1]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'b' }] });
  });

  it('represents a blank line as an empty paragraph', () => {
    const doc = textToAdf('a\n\nb');
    expect(doc.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
      { type: 'paragraph', content: [] },
      { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
    ]);
  });

  it('handles an empty string as a single empty paragraph', () => {
    expect(textToAdf('').content).toEqual([{ type: 'paragraph', content: [] }]);
  });

  it('coerces nullish input to an empty document body', () => {
    // @ts-expect-error — exercising the runtime guard
    expect(textToAdf(undefined).content).toEqual([{ type: 'paragraph', content: [] }]);
  });

  it('keeps special characters verbatim (no escaping at this layer)', () => {
    const doc = textToAdf('<b> & "x"');
    expect(doc.content[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: '<b> & "x"' }],
    });
  });
});

describe('isAdfDoc / toAdf', () => {
  it('recognises a well-formed ADF doc', () => {
    expect(isAdfDoc({ version: 1, type: 'doc', content: [] })).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'doc'],
    ['wrong type field', { type: 'paragraph', content: [] }],
    ['missing content array', { type: 'doc' }],
    ['content not an array', { type: 'doc', content: 'x' }],
  ])('rejects %s', (_label, value) => {
    expect(isAdfDoc(value)).toBe(false);
  });

  it('passes a pre-built ADF doc through unchanged', () => {
    const doc = { version: 1 as const, type: 'doc' as const, content: [] };
    expect(toAdf(doc)).toBe(doc);
  });

  it('converts plain text', () => {
    expect(toAdf('x')).toEqual(textToAdf('x'));
  });

  it('coerces a nullish body to an empty document', () => {
    // @ts-expect-error — exercising the runtime guard
    expect(toAdf(undefined)).toEqual(textToAdf(''));
  });
});

describe('storageBody / textToStorage', () => {
  it('wraps a value as a storage representation object', () => {
    expect(storageBody('<p>hi</p>')).toEqual({ representation: 'storage', value: '<p>hi</p>' });
  });

  it('coerces a nullish value to an empty string', () => {
    // @ts-expect-error — exercising the runtime guard
    expect(storageBody(undefined)).toEqual({ representation: 'storage', value: '' });
  });

  it('escapes HTML special characters and wraps in <p>', () => {
    expect(textToStorage('a & <b> "c"')).toBe('<p>a &amp; &lt;b&gt; "c"</p>');
  });

  it('handles nullish text', () => {
    // @ts-expect-error — exercising the runtime guard
    expect(textToStorage(undefined)).toBe('<p></p>');
  });
});

describe('scope guards', () => {
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

  it('ScopeError carries the right name', () => {
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

  it('keeps only items whose key is in the allowlist', () => {
    expect(filterByAllowlist(items, (i) => i.k, ['proj', 'ops'])).toEqual([
      { k: 'PROJ' },
      { k: 'OPS' },
    ]);
  });

  it('drops items with no resolvable key when an allowlist is set', () => {
    expect(filterByAllowlist(items, (i) => i.k, ['PROJ'])).toEqual([{ k: 'PROJ' }]);
  });
});
