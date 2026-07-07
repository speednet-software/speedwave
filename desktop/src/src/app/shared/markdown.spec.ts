import { describe, it, expect } from 'vitest';
import { marked, Marked } from 'marked';
import { parseMarkdownSync } from './markdown';

describe('parseMarkdownSync', () => {
  it('parses markdown to an HTML string via the marked namespace', () => {
    const html = parseMarkdownSync(marked, '## Title\n\n**bold**');
    expect(html).toContain('<h2>');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('parses via a scoped Marked instance with a custom renderer', () => {
    const scoped = new Marked({
      renderer: {
        link({ href, text }) {
          return `<a href="${href}" target="_blank">${text}</a>`;
        },
      },
    });
    const html = parseMarkdownSync(scoped, '[docs](https://example.com)');
    expect(html).toContain('target="_blank"');
  });

  it('returns an empty-paragraph-free string for empty source', () => {
    expect(parseMarkdownSync(marked, '')).toBe('');
  });

  it('throws when an async extension makes parse return a Promise', () => {
    const asyncParser = {
      parse: () => Promise.resolve('late'),
    };
    expect(() => parseMarkdownSync(asyncParser, 'x')).toThrow(/async option must remain false/);
  });
});
