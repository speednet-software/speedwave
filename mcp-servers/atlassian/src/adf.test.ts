/**
 * Tests for ADF / Confluence-storage helpers. Scope-enforcement primitives are
 * tested in `scope.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  textToAdf,
  isAdfDoc,
  toAdf,
  storageBody,
  textToStorage,
  resolveBodyPayload,
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
    ['wrong version', { version: 2, type: 'doc', content: [] }],
    ['missing version', { type: 'doc', content: [] }],
    ['missing content array', { version: 1, type: 'doc' }],
    ['content not an array', { version: 1, type: 'doc', content: 'x' }],
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

describe('storageBody / textToStorage / resolveBodyPayload', () => {
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

  it('resolveBodyPayload prefers raw storage over text', () => {
    expect(resolveBodyPayload({ storage: '<h1>x</h1>', text: 'ignored' })).toEqual({
      representation: 'storage',
      value: '<h1>x</h1>',
    });
  });

  it('resolveBodyPayload escapes + wraps a text body when no storage given', () => {
    expect(resolveBodyPayload({ text: 'a & b' })).toEqual({
      representation: 'storage',
      value: '<p>a &amp; b</p>',
    });
  });

  it('resolveBodyPayload treats an absent text body as the empty paragraph', () => {
    expect(resolveBodyPayload({})).toEqual({ representation: 'storage', value: '<p></p>' });
  });
});
