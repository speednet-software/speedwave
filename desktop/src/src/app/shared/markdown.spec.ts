import { describe, it, expect, vi, afterEach } from 'vitest';
import { SecurityContext } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DomSanitizer } from '@angular/platform-browser';
import { marked, Marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import { chatMarkdown, findMermaidSlots, parseMarkdownSync, pluginMarkdown } from './markdown';

const chat = (src: string): string => parseMarkdownSync(chatMarkdown, src);

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

describe('chatMarkdown', () => {
  afterEach(() => vi.restoreAllMocks());

  describe('code highlighting', () => {
    it('highlights a fence tagged with a known language', () => {
      const html = chat('```ts\nconst x = 1;\n```');
      expect(html).toContain('<code class="language-ts">');
      expect(html).toContain('<span class="hljs-keyword">const</span>');
      expect(html).toContain('<span class="hljs-number">1</span>');
    });

    it('resolves language aliases', () => {
      expect(chat('```sh\necho hi\n```')).toContain('<span class="hljs-built_in">echo</span>');
    });

    it.each([
      ['dockerfile', 'FROM node:20', '<span class="hljs-keyword">FROM</span>'],
      [
        'powershell',
        'Get-ChildItem -Path C:\\',
        '<span class="hljs-built_in">Get-ChildItem</span>',
      ],
    ])('highlights %s, registered on top of the common set', (lang, code, expected) => {
      expect(chat(`\`\`\`${lang}\n${code}\n\`\`\``)).toContain(expected);
    });

    it('leaves an untagged fence as escaped plain text', () => {
      const html = chat('```\n<b>x</b>\n```');
      expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
      expect(html).not.toContain('hljs-');
    });

    it('leaves a fence in an unknown language as escaped plain text', () => {
      const html = chat('```notalang\n<b>x</b>\n```');
      expect(html).toContain('<code class="language-notalang">&lt;b&gt;x&lt;/b&gt;');
      expect(html).not.toContain('hljs-');
    });

    it('escapes markup inside highlighted code', () => {
      const html = chat('```html\n<script>alert(1)</script>\n```');
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;');
    });

    it('highlights the same code once across parses', () => {
      const spy = vi.spyOn(hljs, 'highlight');
      const src = '```python\nprint("memo-é")\n```';
      const first = chat(src);
      expect(chat(src)).toBe(first);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('footnotes', () => {
    const src = 'A[^1] and B[^b] and A again[^1].\n\n[^1]: First.\n[^b]: Second.\n[^z]: Unused.';

    it('renders references as bare numbers in first-reference order', () => {
      const html = chat(src);
      expect(html).toContain('A<sup class="footnote-ref">1</sup>');
      expect(html).toContain('B<sup class="footnote-ref">2</sup>');
      expect(html).toContain('again<sup class="footnote-ref">1</sup>');
    });

    it('lists only the referenced definitions, without ids, links or data attributes', () => {
      const html = chat(src);
      expect(html).toContain('<section class="footnotes"><ol><li><p>First.</p>');
      expect(html).toContain('<li><p>Second.</p>');
      expect(html).not.toContain('Unused');
      expect(html).not.toMatch(/\sid=|href=|data-|<a\b|<h2/);
    });

    it('numbers from 1 again in every parse', () => {
      chat(src);
      expect(chat('C[^x].\n\n[^x]: Third.')).toContain('C<sup class="footnote-ref">1</sup>');
    });

    it('keeps a reference without a definition as text', () => {
      const html = chat('D[^nope].');
      expect(html).toContain('D[^nope].');
      expect(html).not.toContain('footnote');
    });
  });

  describe('alerts', () => {
    it.each([
      ['NOTE', 'note', 'Note'],
      ['TIP', 'tip', 'Tip'],
      ['IMPORTANT', 'important', 'Important'],
      ['WARNING', 'warning', 'Warning'],
      ['CAUTION', 'caution', 'Caution'],
    ])('renders [!%s] as a titled alert without an icon', (marker, variant, title) => {
      const html = chat(`> [!${marker}]\n> Body.`);
      expect(html).toContain(`<div class="markdown-alert markdown-alert-${variant}">`);
      expect(html).toContain(`<p class="markdown-alert-title">${title}</p>`);
      expect(html).toContain('<p>Body.</p>');
      expect(html).not.toContain('<svg');
    });

    it('keeps an ordinary blockquote a blockquote', () => {
      expect(chat('> just a quote')).toContain('<blockquote>');
    });
  });

  describe('task lists', () => {
    it('renders task markers as read-only checkboxes instead of inputs', () => {
      const html = chat('- [ ] open\n- [x] done');
      expect(html).toContain(
        '<span class="task-checkbox" role="checkbox" aria-checked="false" aria-disabled="true"></span> open'
      );
      expect(html).toContain('aria-checked="true" aria-disabled="true"></span> done');
      expect(html).not.toContain('<input');
    });

    it('renders the markers inside paragraphs of a loose list', () => {
      const html = chat('- [ ] open\n\n- [x] done');
      expect(html).toContain('<li><p><span class="task-checkbox"');
    });
  });

  describe('mermaid slots', () => {
    it('wraps a closed mermaid fence in a slot holding the escaped source', () => {
      const html = chat('```mermaid\ngraph TD\n  A["<img src=x onerror=alert(1)>"] --> B\n```');
      expect(html).toContain(
        '<div class="mermaid-slot"><pre><code class="language-mermaid">graph TD'
      );
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(html).not.toContain('<img');
    });

    it.each([
      ['an unclosed fence while it streams', '```mermaid\ngraph TD\n  A --> B'],
      ['a partial closing fence', '```mermaid\ngraph TD\n``'],
      ['a closing fence of the other character', '```mermaid\ngraph TD\n~~~'],
      ['an indented code block', '    graph TD'],
      ['a fence in another language', '```ts\nconst a = 1;\n```'],
    ])('keeps %s as a plain code block', (_label, src) => {
      expect(chat(src)).not.toContain('mermaid-slot');
    });

    it.each([
      ['a longer closing fence', '```mermaid\ngraph TD\n`````'],
      ['a tilde fence', '~~~mermaid\ngraph TD\n~~~'],
      ['a fence inside a list item', '- item\n\n  ```mermaid\n  graph TD\n  ```'],
      ['a capitalised tag with an info string', '```Mermaid title\ngraph TD\n```'],
    ])('slots %s', (_label, src) => {
      expect(chat(src)).toContain('<div class="mermaid-slot">');
    });
  });

  it('leaves links plain', () => {
    expect(chat('[a](https://example.com)')).toBe('<p><a href="https://example.com">a</a></p>\n');
  });
});

describe('pluginMarkdown', () => {
  it('opens links in a new tab without an opener and escapes href and title', () => {
    const html = parseMarkdownSync(pluginMarkdown, '[a](https://e.com/?q=1&r="x" "t\\"q")');
    expect(html).toContain(
      '<a href="https://e.com/?q=1&amp;r=&quot;x&quot;" target="_blank" rel="noopener noreferrer" title="t&quot;q">a</a>'
    );
  });

  it('shares highlighting and mermaid slots with the chat flavour', () => {
    const html = parseMarkdownSync(
      pluginMarkdown,
      '```ts\nlet y;\n```\n\n```mermaid\ngraph TD\n```'
    );
    expect(html).toContain('<span class="hljs-keyword">let</span>');
    expect(html).toContain('<div class="mermaid-slot">');
  });
});

describe('findMermaidSlots', () => {
  it('reads back the exact source of every closed fence and skips empty and streaming ones', () => {
    const host = document.createElement('div');
    host.innerHTML = parseMarkdownSync(
      chatMarkdown,
      '```mermaid\ngraph TD\n  A["x < y & z"] --> B\n```\n\n```mermaid\n```\n\n```mermaid\ngraph LR'
    );
    const slots = findMermaidSlots(host);
    expect(slots.map(({ source }) => source)).toEqual(['graph TD\n  A["x < y & z"] --> B']);
    expect(slots[0]?.slot).toBe(host.querySelector('.mermaid-slot'));
  });

  it('finds nothing in Markdown without a closed mermaid fence', () => {
    const host = document.createElement('div');
    host.innerHTML = parseMarkdownSync(chatMarkdown, 'text\n\n```ts\nconst a = 1;\n```');
    expect(findMermaidSlots(host)).toEqual([]);
  });
});

describe("Angular's HTML sanitizer", () => {
  it('keeps every element and attribute the Markdown flavours emit', () => {
    const src = [
      '```ts\nconst x = 1;\n```',
      'Ref[^1].',
      '> [!WARNING]\n> Careful.',
      '- [x] done',
      '```mermaid\ngraph TD\n```',
      '[^1]: Note.',
    ].join('\n\n');
    const html = chat(src);
    const warn = vi.spyOn(console, 'warn');
    const sanitized = TestBed.inject(DomSanitizer).sanitize(SecurityContext.HTML, html) ?? '';
    const doc = new DOMParser().parseFromString(sanitized, 'text/html');
    expect(doc.querySelector('span.hljs-keyword')?.textContent).toBe('const');
    expect(doc.querySelector('sup.footnote-ref')?.textContent).toBe('1');
    expect(doc.querySelector('section.footnotes ol li')?.textContent).toContain('Note.');
    expect(doc.querySelector('div.markdown-alert.markdown-alert-warning')).not.toBeNull();
    const checkbox = doc.querySelector('span.task-checkbox');
    expect(checkbox?.getAttribute('role')).toBe('checkbox');
    expect(checkbox?.getAttribute('aria-checked')).toBe('true');
    expect(doc.querySelector('div.mermaid-slot pre code.language-mermaid')).not.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
