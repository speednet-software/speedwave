import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findSrcRoot } from './testing/src-root';

const INDEX_HTML = readFileSync(join(findSrcRoot(), 'index.html'), 'utf-8');

function htmlTagAttributes(): Record<string, string> {
  const match = /<html\b([^>]*)>/i.exec(INDEX_HTML);
  if (!match) throw new Error('index.html: no <html> tag found');
  const attributes: Record<string, string> = {};
  for (const pair of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) {
    attributes[pair[1]] = pair[2];
  }
  return attributes;
}

describe('index.html', () => {
  it('turns the dictionary, autocorrect and writing suggestions off for the whole app', () => {
    const attributes = htmlTagAttributes();
    expect(attributes['spellcheck']).toBe('false');
    expect(attributes['autocorrect']).toBe('off');
    expect(attributes['writingsuggestions']).toBe('false');
  });
});
