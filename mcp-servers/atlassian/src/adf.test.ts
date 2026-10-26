/**
 * Tests for ADF / Confluence-storage helpers. Scope-enforcement primitives are
 * tested in `scope.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  isAdfDoc,
  storageBody,
  textToStorage,
  resolveBodyPayload,
  markdownToAdf,
  adfToMarkdown,
} from './adf.js';
import type { AdfNode } from './types.js';

describe('isAdfDoc', () => {
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

const doc = (...content: AdfNode[]) => ({ version: 1 as const, type: 'doc' as const, content });
const p = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content });
const t = (text: string, marks?: AdfNode['marks']): AdfNode =>
  marks ? { type: 'text', text, marks } : { type: 'text', text };

describe('markdownToAdf blocks', () => {
  it('turns empty input into one empty paragraph', () => {
    expect(markdownToAdf('')).toEqual(doc({ type: 'paragraph', content: [] }));
  });

  it('splits paragraphs on blank lines and joins soft line breaks with a space', () => {
    expect(markdownToAdf('one\ntwo\n\nthree')).toEqual(doc(p(t('one two')), p(t('three'))));
  });

  it('turns trailing double space and backslash into hard breaks', () => {
    expect(markdownToAdf('a  \nb\\\nc')).toEqual(
      doc(p(t('a'), { type: 'hardBreak' }, t('b'), { type: 'hardBreak' }, t('c')))
    );
  });

  it('parses headings 1 to 6 and strips closing hashes', () => {
    expect(markdownToAdf('# A\n###### F ##')).toEqual(
      doc(
        { type: 'heading', attrs: { level: 1 }, content: [t('A')] },
        { type: 'heading', attrs: { level: 6 }, content: [t('F')] }
      )
    );
  });

  it('parses horizontal rules', () => {
    expect(markdownToAdf('---\n* * *\n___')).toEqual(
      doc({ type: 'rule' }, { type: 'rule' }, { type: 'rule' })
    );
  });

  it('parses fenced code blocks with and without language', () => {
    expect(markdownToAdf('```ts\nconst a = 1;\n\nb\n```\n~~~\nplain\n~~~')).toEqual(
      doc(
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('const a = 1;\n\nb')] },
        { type: 'codeBlock', content: [t('plain')] }
      )
    );
  });

  it('parses empty and unterminated code blocks', () => {
    expect(markdownToAdf('```\n```')).toEqual(doc({ type: 'codeBlock' }));
    expect(markdownToAdf('```js\nx')).toEqual(
      doc({ type: 'codeBlock', attrs: { language: 'js' }, content: [t('x')] })
    );
  });

  it('keeps a shorter fence inside a longer fence', () => {
    expect(markdownToAdf('````\n```\n````')).toEqual(
      doc({ type: 'codeBlock', content: [t('```')] })
    );
  });

  it('parses blockquotes containing blocks', () => {
    expect(markdownToAdf('> # T\n> text\n>\n> more')).toEqual(
      doc({
        type: 'blockquote',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [t('T')] },
          p(t('text')),
          p(t('more')),
        ],
      })
    );
  });

  it('parses bullet and ordered lists with nesting', () => {
    expect(markdownToAdf('- a\n  - b\n  - c\n- d\n\n3. x\n4. y')).toEqual(
      doc(
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                p(t('a')),
                {
                  type: 'bulletList',
                  content: [
                    { type: 'listItem', content: [p(t('b'))] },
                    { type: 'listItem', content: [p(t('c'))] },
                  ],
                },
              ],
            },
            { type: 'listItem', content: [p(t('d'))] },
          ],
        },
        {
          type: 'orderedList',
          attrs: { order: 3 },
          content: [
            { type: 'listItem', content: [p(t('x'))] },
            { type: 'listItem', content: [p(t('y'))] },
          ],
        }
      )
    );
  });

  it('parses ordered list without order attr when starting at 1', () => {
    expect(markdownToAdf('1) a')).toEqual(
      doc({ type: 'orderedList', content: [{ type: 'listItem', content: [p(t('a'))] }] })
    );
  });

  it('parses multi-paragraph list items and code inside items', () => {
    expect(markdownToAdf('- a\n\n  b\n  ```\n  c\n  ```\n\n- z')).toEqual(
      doc({
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [p(t('a')), p(t('b')), { type: 'codeBlock', content: [t('c')] }],
          },
          { type: 'listItem', content: [p(t('z'))] },
        ],
      })
    );
  });

  it('ends a list when the marker kind changes', () => {
    expect(markdownToAdf('- a\n1. b').content.map((n) => n.type)).toEqual([
      'bulletList',
      'orderedList',
    ]);
  });

  it('ends a list at a dedented non-list line after a blank', () => {
    expect(markdownToAdf('- a\n\ntext').content.map((n) => n.type)).toEqual([
      'bulletList',
      'paragraph',
    ]);
  });

  it('parses GFM pipe tables with escaped pipes and ragged rows', () => {
    expect(markdownToAdf('| H1 | H2 |\n| --- | :-: |\n| a \\| b | **c** |\n| d |')).toEqual(
      doc({
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [p(t('H1'))] },
              { type: 'tableHeader', content: [p(t('H2'))] },
            ],
          },
          {
            type: 'tableRow',
            content: [
              { type: 'tableCell', content: [p(t('a | b'))] },
              { type: 'tableCell', content: [p(t('c', [{ type: 'strong' }]))] },
            ],
          },
          { type: 'tableRow', content: [{ type: 'tableCell', content: [p(t('d'))] }] },
        ],
      })
    );
  });

  it('parses a table without outer pipes and stops at a blank line', () => {
    const result = markdownToAdf('a | b\n- | -\n1 | 2\n\nafter');
    expect(result.content.map((n) => n.type)).toEqual(['table', 'paragraph']);
  });

  it('does not treat a pipe line followed by a pipeless rule as a table', () => {
    expect(markdownToAdf('a | b\n---').content.map((n) => n.type)).toEqual(['paragraph', 'rule']);
  });

  it('does not treat a pipe line without separator as a table', () => {
    expect(markdownToAdf('a | b')).toEqual(doc(p(t('a | b'))));
  });

  it('stops a paragraph at the next block start', () => {
    expect(markdownToAdf('text\n# H\n- l').content.map((n) => n.type)).toEqual([
      'paragraph',
      'heading',
      'bulletList',
    ]);
  });
});

describe('markdownToAdf inline', () => {
  it('parses bold, italic, strike and combined marks', () => {
    expect(markdownToAdf('**b** *i* _i2_ __b2__ ~~s~~ ***bi***')).toEqual(
      doc(
        p(
          t('b', [{ type: 'strong' }]),
          t(' '),
          t('i', [{ type: 'em' }]),
          t(' '),
          t('i2', [{ type: 'em' }]),
          t(' '),
          t('b2', [{ type: 'strong' }]),
          t(' '),
          t('s', [{ type: 'strike' }]),
          t(' '),
          t('bi', [{ type: 'strong' }, { type: 'em' }])
        )
      )
    );
  });

  it('nests marks', () => {
    expect(markdownToAdf('**a *b***')).toEqual(
      doc(p(t('a ', [{ type: 'strong' }]), t('b', [{ type: 'strong' }, { type: 'em' }])))
    );
  });

  it('leaves unmatched or spaced delimiters literal', () => {
    expect(markdownToAdf('2 * 3 and **open and snake_case_name and a_ b')).toEqual(
      doc(p(t('2 * 3 and **open and snake_case_name and a_ b')))
    );
    expect(markdownToAdf('*a * b')).toEqual(doc(p(t('*a * b'))));
    expect(markdownToAdf('~~x')).toEqual(doc(p(t('~~x'))));
    expect(markdownToAdf('***x')).toEqual(doc(p(t('***x'))));
  });

  it('skips escaped closing delimiters and a doubled delimiter inside italic', () => {
    expect(markdownToAdf('*a\\* b*')).toEqual(doc(p(t('a* b', [{ type: 'em' }]))));
    expect(markdownToAdf('*a **b** c*')).toEqual(
      doc(
        p(
          t('a ', [{ type: 'em' }]),
          t('b', [{ type: 'em' }, { type: 'strong' }]),
          t(' c', [{ type: 'em' }])
        )
      )
    );
  });

  it('parses inline code, including backticks inside', () => {
    expect(markdownToAdf('`a*b` and `` x`y `` and ``` ` ```')).toEqual(
      doc(
        p(
          t('a*b', [{ type: 'code' }]),
          t(' and '),
          t('x`y', [{ type: 'code' }]),
          t(' and '),
          t('`', [{ type: 'code' }])
        )
      )
    );
  });

  it('skips backtick runs of a different length inside a code span', () => {
    expect(markdownToAdf('`` a ``` b ``')).toEqual(doc(p(t('a ``` b', [{ type: 'code' }]))));
  });

  it('keeps the link mark on code inside a link label', () => {
    expect(markdownToAdf('[`x`](https://a.b)')).toEqual(
      doc(p(t('x', [{ type: 'link', attrs: { href: 'https://a.b' } }, { type: 'code' }])))
    );
  });

  it('leaves an unclosed backtick literal', () => {
    expect(markdownToAdf('a ` b')).toEqual(doc(p(t('a ` b'))));
  });

  it('parses links with formatted labels and titles', () => {
    expect(markdownToAdf('[**x**](https://a.b/c_(d) "title") [y](https://e.f)')).toEqual(
      doc(
        p(
          t('x', [{ type: 'link', attrs: { href: 'https://a.b/c_(d)' } }, { type: 'strong' }]),
          t(' '),
          t('y', [{ type: 'link', attrs: { href: 'https://e.f' } }])
        )
      )
    );
  });

  it('leaves bracket text without a link target literal', () => {
    expect(markdownToAdf('[x] and [y]')).toEqual(doc(p(t('[x] and [y]'))));
  });

  it('parses autolinks as inlineCard', () => {
    expect(markdownToAdf('<https://a.b/c> <not a link>')).toEqual(
      doc(p({ type: 'inlineCard', attrs: { url: 'https://a.b/c' } }, t(' <not a link>')))
    );
  });

  it('parses mentions and emoji', () => {
    expect(markdownToAdf('hi [@Ann](mention:abc123) :smile: 10:30:45 a:b:')).toEqual(
      doc(
        p(
          t('hi '),
          { type: 'mention', attrs: { id: 'abc123', text: '@Ann' } },
          t(' '),
          { type: 'emoji', attrs: { shortName: ':smile:' } },
          t(' 10:30:45 a:b:')
        )
      )
    );
  });

  it('keeps emoji-like text followed by a word character literal', () => {
    expect(markdownToAdf(':a:b')).toEqual(doc(p(t(':a:b'))));
  });

  it('unescapes backslash-escaped punctuation and keeps other backslashes', () => {
    expect(markdownToAdf('\\*x\\* \\_ a\\b \\')).toEqual(doc(p(t('*x* _ a\\b \\'))));
  });

  it('parses br tags as hard breaks', () => {
    expect(markdownToAdf('a<br>b<BR/>c')).toEqual(
      doc(p(t('a'), { type: 'hardBreak' }, t('b'), { type: 'hardBreak' }, t('c')))
    );
  });
});

describe('adfToMarkdown', () => {
  it('returns an empty string for missing or empty docs', () => {
    expect(adfToMarkdown(undefined)).toBe('');
    expect(adfToMarkdown(null)).toBe('');
    expect(adfToMarkdown(doc())).toBe('');
    expect(adfToMarkdown({ version: 1, type: 'doc' } as never)).toBe('');
  });

  it('renders paragraphs, skipping empty ones', () => {
    expect(adfToMarkdown(doc(p(t('a')), p(), p(t('b'))))).toBe('a\n\nb');
    expect(adfToMarkdown(doc({ type: 'paragraph' }))).toBe('');
  });

  it('renders headings and clamps the level', () => {
    expect(
      adfToMarkdown(
        doc(
          { type: 'heading', attrs: { level: 3 }, content: [t('A')] },
          { type: 'heading', attrs: { level: 9 }, content: [t('B')] },
          { type: 'heading', attrs: { level: 0 }, content: [t('C')] },
          { type: 'heading', content: [t('D')] }
        )
      )
    ).toBe('### A\n\n###### B\n\n# C\n\n# D');
  });

  it('renders marks, keeping edge whitespace outside', () => {
    expect(
      adfToMarkdown(
        doc(
          p(
            t('b ', [{ type: 'strong' }]),
            t('i', [{ type: 'em' }]),
            t(' s', [{ type: 'strike' }]),
            t('c', [{ type: 'code' }]),
            t('l', [{ type: 'link', attrs: { href: 'https://a.b/(x y)' } }]),
            t('  ', [{ type: 'strong' }])
          )
        )
      )
    ).toBe('**b** *i* ~~s~~`c`[l](https://a.b/%28x%20y%29)  ');
  });

  it('marks text formatting without a Markdown equivalent instead of dropping it', () => {
    expect(
      adfToMarkdown(
        doc(
          p(
            t('u', [{ type: 'underline' }]),
            t(' c ', [{ type: 'textColor', attrs: { color: '#ff0000' } }]),
            t('b', [{ type: 'backgroundColor', attrs: { color: '#00ff00' } }]),
            t('x', [{ type: 'subsup', attrs: { type: 'sub' } }]),
            t('n', [{ type: 'strong' }, { type: 'annotation', attrs: { id: 'a1' } }])
          )
        )
      )
    ).toBe(
      '[adf:underline]u[/adf:underline] [adf:textColor #ff0000]c[/adf:textColor] ' +
        '[adf:backgroundColor #00ff00]b[/adf:backgroundColor][adf:subsup sub]x[/adf:subsup]' +
        '[adf:annotation a1]**n**[/adf:annotation]'
    );
  });

  it('renders inline code containing backticks', () => {
    expect(
      adfToMarkdown(doc(p(t('a`b', [{ type: 'code' }]), t(' '), t('`', [{ type: 'code' }]))))
    ).toBe('``a`b`` `` ` ``');
  });

  it('escapes markdown specials in text', () => {
    expect(adfToMarkdown(doc(p(t('*a* _b_ snake_case `c` [d] ~e~ <f> \\g'))))).toBe(
      '\\*a\\* \\_b\\_ snake_case \\`c\\` \\[d\\] \\~e\\~ \\<f> \\\\g'
    );
  });

  it('escapes block starts in paragraphs', () => {
    expect(
      adfToMarkdown(
        doc(p(t('# x')), p(t('- y')), p(t('+ z')), p(t('> q')), p(t('1. n')), p(t('2) n')))
      )
    ).toBe('\\# x\n\n\\- y\n\n\\+ z\n\n\\> q\n\n1\\. n\n\n2\\) n');
  });

  it('renders hard breaks, mentions, emoji, inline cards', () => {
    expect(
      adfToMarkdown(
        doc(
          p(
            t('a'),
            { type: 'hardBreak' },
            { type: 'mention', attrs: { id: 'u1', text: '@Ann [x]' } },
            { type: 'mention', attrs: { id: 'u2' } },
            { type: 'emoji', attrs: { shortName: ':smile:' } },
            { type: 'emoji', attrs: { text: 'X' } },
            { type: 'inlineCard', attrs: { url: 'https://a.b' } }
          )
        )
      )
    ).toBe('a\\\n[@Ann \\[x\\]](mention:u1)[@u2](mention:u2):smile:X<https://a.b>');
  });

  it('renders lists with nesting, order start and loose items', () => {
    const item = (...content: AdfNode[]): AdfNode => ({ type: 'listItem', content });
    expect(
      adfToMarkdown(
        doc(
          {
            type: 'bulletList',
            content: [
              item(p(t('a')), { type: 'bulletList', content: [item(p(t('b')))] }),
              item(p(t('c')), p(t('d'))),
            ],
          },
          {
            type: 'orderedList',
            attrs: { order: 4 },
            content: [item(p(t('x')), { type: 'orderedList', content: [item(p(t('y')))] })],
          },
          { type: 'orderedList', content: [item(p(t('z')))] },
          { type: 'bulletList' }
        )
      )
    ).toBe('- a\n  - b\n- c\n\n  d\n\n4. x\n   1. y\n\n1. z');
  });

  it('renders code blocks with language and longer fences', () => {
    expect(
      adfToMarkdown(
        doc(
          { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('a\n\nb')] },
          { type: 'codeBlock', content: [t('```x')] },
          { type: 'codeBlock' }
        )
      )
    ).toBe('```ts\na\n\nb\n```\n\n````\n```x\n````\n\n```\n\n```');
  });

  it('renders blockquotes and rules', () => {
    expect(
      adfToMarkdown(doc({ type: 'blockquote', content: [p(t('a')), p(t('b'))] }, { type: 'rule' }))
    ).toBe('> a\n>\n> b\n\n---');
  });

  it('renders tables with the first row as header and cell content on one line', () => {
    const cell = (type: string, ...content: AdfNode[]): AdfNode => ({ type, content });
    expect(
      adfToMarkdown(
        doc({
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [cell('tableHeader', p(t('H1'))), cell('tableHeader', p(t('H|2')))],
            },
            {
              type: 'tableRow',
              content: [
                cell('tableCell', p(t('a'), { type: 'hardBreak' }, t('b')), p(t('c'))),
                cell('tableCell', {
                  type: 'bulletList',
                  content: [{ type: 'listItem', content: [p(t('x'))] }],
                }),
              ],
            },
            { type: 'tableRow' },
          ],
        })
      )
    ).toBe('| H1 | H\\|2 |\n| --- | --- |\n| a<br>b<br>c | - x |\n|  |');
  });

  it('renders an empty table as nothing', () => {
    expect(adfToMarkdown(doc({ type: 'table' }))).toBe('');
  });

  it('marks unsupported block containers visibly and keeps their content', () => {
    expect(
      adfToMarkdown(
        doc(
          { type: 'panel', attrs: { panelType: 'info' }, content: [p(t('inside'))] },
          { type: 'expand', attrs: { title: 'More ]' }, content: [p(t('hidden'))] },
          { type: 'weird', content: [p(t('w'))] }
        )
      )
    ).toBe(
      '[adf:panel info]\n\ninside\n\n[/adf:panel]\n\n[adf:expand More  ]\n\nhidden\n\n[/adf:expand]\n\n[adf:weird]\n\nw\n\n[/adf:weird]'
    );
  });

  it('marks unsupported leaf blocks and inline nodes visibly', () => {
    expect(
      adfToMarkdown(
        doc(
          { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'f1', type: 'file' } }] },
          { type: 'media', attrs: { url: 'https://x.y/z.png' } },
          { type: 'extension', attrs: { n: 1 } },
          p(
            t('s '),
            { type: 'status', attrs: { text: 'Done', color: 'green' } },
            t(' d '),
            { type: 'date', attrs: { timestamp: '1700000000000' } },
            { type: 'date', attrs: { timestamp: 'nope' } },
            { type: 'date' },
            { type: 'inlineCard', attrs: {} },
            { type: 'mention' },
            { type: 'emoji' },
            { type: 'inlineExtension', content: [t('in')] }
          )
        )
      )
    ).toBe(
      '[adf:mediaSingle]\n\n[adf:media f1]\n\n[/adf:mediaSingle]\n\n[adf:media https://x.y/z.png]\n\n[adf:extension]\n\n' +
        's [adf:status Done] d [adf:date 2023-11-14][adf:date][adf:date][adf:inlineCard][adf:mention][adf:emoji][adf:inlineExtension]in[/adf:inlineExtension]'
    );
  });

  it('marks text nodes without text as empty', () => {
    expect(adfToMarkdown(doc(p({ type: 'text' })))).toBe('');
  });
});

describe('round trip', () => {
  it.each([
    'plain paragraph',
    '# Title\n\nBody with **bold**, *italic*, ~~strike~~, `code` and [a link](https://a.b).',
    '- a\n  - b\n- c',
    '3. a\n   1. b\n4. c',
    '```ts\nconst a = 1;\n```',
    '> quoted\n>\n> - item',
    '---',
    '| A | B |\n| --- | --- |\n| 1 | 2 |',
    'hi [@Ann](mention:u1) :smile: <https://a.b>',
    'line\\\nbreak',
  ])('keeps %j stable', (markdown) => {
    expect(adfToMarkdown(markdownToAdf(markdown))).toBe(markdown);
  });
});
