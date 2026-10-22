import { describe, it, expect, afterEach } from 'vitest';
import {
  collectSearchScopes,
  compileQuery,
  escapeRegExp,
  findMatches,
  firstIndexAtOrBelow,
  matchRect,
  rangeForSpan,
  setCurrentHighlight,
  wrapIndex,
} from './chat-find';

function scopesFrom(html: string): ReturnType<typeof collectSearchScopes> {
  const root = document.createElement('div');
  root.innerHTML = html;
  return collectSearchScopes(root);
}

function query(query: string, regex = false, matchCase = false): RegExp {
  const compiled = compileQuery({ query, regex, matchCase });
  if (!compiled) throw new Error(`query did not compile: ${query}`);
  return compiled;
}

describe('compileQuery', () => {
  it('returns null for an empty query', () => {
    expect(compileQuery({ query: '', regex: false, matchCase: false })).toBeNull();
    expect(compileQuery({ query: '', regex: true, matchCase: true })).toBeNull();
  });

  it('escapes metacharacters in a plain query', () => {
    expect(findMatches('a.b(c) axb(c)', query('a.b(c)'))).toEqual([{ start: 0, end: 6 }]);
  });

  it('is case-insensitive unless matchCase is set', () => {
    expect(findMatches('Foo foo FOO', query('foo'))).toHaveLength(3);
    expect(findMatches('Foo foo FOO', query('foo', false, true))).toEqual([{ start: 4, end: 7 }]);
  });

  it('compiles a regex query and returns null when it does not parse', () => {
    expect(findMatches('ab12cd', query('\\d+', true))).toEqual([{ start: 2, end: 4 }]);
    expect(compileQuery({ query: '(', regex: true, matchCase: false })).toBeNull();
    expect(compileQuery({ query: '[a-', regex: true, matchCase: true })).toBeNull();
  });

  it('matches Unicode text', () => {
    expect(findMatches('Zażółć gęślą jaźń, zażółć', query('zażółć'))).toEqual([
      { start: 0, end: 6 },
      { start: 19, end: 25 },
    ]);
  });
});

describe('escapeRegExp', () => {
  it('makes a regex that matches the text literally', () => {
    const text = 'a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o';
    expect(new RegExp(escapeRegExp(text)).exec(text)?.[0]).toBe(text);
    expect(new RegExp(escapeRegExp('a.b')).test('axb')).toBe(false);
  });
});

describe('findMatches', () => {
  it('skips zero-length matches instead of counting every gap', () => {
    expect(findMatches('baaac', query('a*', true))).toEqual([{ start: 1, end: 4 }]);
    expect(findMatches('abc', query('x*', true))).toEqual([]);
  });

  it('finds repeats as consecutive non-overlapping matches', () => {
    expect(findMatches('aaaa', query('aa'))).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it('starts from the beginning on every call', () => {
    const m = query('a');
    expect(findMatches('aa', m)).toHaveLength(2);
    expect(findMatches('aa', m)).toHaveLength(2);
  });
});

describe('collectSearchScopes', () => {
  it('concatenates text across inline elements so a match may span formatting', () => {
    const [scope] = scopesFrom(
      '<div data-find-scope><p>foo <strong>bar</strong> <code><span class="hljs">baz</span></code></p></div>'
    );
    expect(scope.text).toBe('foo bar baz');
    expect(scope.segments.map((s) => s.start)).toEqual([0, 4, 7, 8]);
    expect(findMatches(scope.text, query('foo bar'))).toEqual([{ start: 0, end: 7 }]);
  });

  it('puts a line break between block elements so text never runs across paragraphs', () => {
    const [scope] = scopesFrom(
      '<div data-find-scope><p>foo</p><p>bar</p><ul><li>one</li><li>two</li></ul>tail<br>after</div>'
    );
    expect(scope.text).toBe('foo\nbar\none\ntwo\ntail\nafter');
    expect(findMatches(scope.text, query('foobar'))).toEqual([]);
    expect(findMatches(scope.text, query('foo bar'))).toEqual([]);
    expect(findMatches(scope.text, query('foo\\s+bar', true))).toEqual([{ start: 0, end: 7 }]);
  });

  it('adds no boundary at the start of a scope or twice in a row', () => {
    const [scope] = scopesFrom('<div data-find-scope><div><p>a</p></div><div></div><p>b</p></div>');
    expect(scope.text).toBe('a\nb');
  });

  it('returns scopes in document order and drops empty ones', () => {
    const scopes = scopesFrom(
      '<div data-find-scope>first</div><div data-find-scope></div><div data-find-scope>second</div>'
    );
    expect(scopes.map((s) => s.text)).toEqual(['first', 'second']);
  });

  it('ignores text outside a scope', () => {
    const scopes = scopesFrom(
      '<span>12:34</span><div data-find-scope>hello</div><button>Retry</button>'
    );
    expect(scopes.map((s) => s.text)).toEqual(['hello']);
  });

  it('skips a mermaid slot, a closed details, hidden and aria-hidden elements inside a scope', () => {
    const [scope] = scopesFrom(
      '<div data-find-scope>a<div class="mermaid-slot"><pre>graph TD</pre></div>b<details><summary>s</summary>closed</details><details open><summary>t</summary>open</details>c<span hidden>h</span><span aria-hidden="true">x</span></div>'
    );
    expect(scope.text).toBe('a\nb\nt\nopen\nc');
  });

  it('skips a scope that sits inside a closed details', () => {
    const scopes = scopesFrom(
      '<details><summary>thinking</summary><div data-find-scope>reasoning</div></details><details open><summary>thinking</summary><div data-find-scope>shown</div></details>'
    );
    expect(scopes.map((s) => s.text)).toEqual(['shown']);
  });
});

describe('rangeForSpan', () => {
  it('maps a span inside one text node', () => {
    const [scope] = scopesFrom('<div data-find-scope>hello world</div>');
    expect(rangeForSpan(scope, { start: 6, end: 11 }).toString()).toBe('world');
  });

  it('maps a span that crosses text nodes', () => {
    const [scope] = scopesFrom('<div data-find-scope>foo <b>bar</b> baz</div>');
    const range = rangeForSpan(scope, { start: 2, end: 9 });
    expect(range.toString()).toBe('o bar b');
    expect(range.startContainer).toBe(scope.segments[0].node);
    expect(range.endContainer).toBe(scope.segments[2].node);
  });

  it('ends inside the node that holds the last matched character', () => {
    const [scope] = scopesFrom('<div data-find-scope><i>ab</i><i>cd</i></div>');
    const range = rangeForSpan(scope, { start: 0, end: 2 });
    expect(range.endContainer).toBe(scope.segments[0].node);
    expect(range.endOffset).toBe(2);
    expect(range.toString()).toBe('ab');
  });

  it('snaps a span edge on a block boundary to the text nodes around it', () => {
    const [scope] = scopesFrom('<div data-find-scope><p>foo</p><p>bar</p></div>');
    const across = rangeForSpan(scope, { start: 0, end: 7 });
    expect(across.toString()).toBe('foobar');
    const fromBoundary = rangeForSpan(scope, { start: 3, end: 5 });
    expect(fromBoundary.startContainer).toBe(scope.segments[1].node);
    expect(fromBoundary.toString()).toBe('b');
    const toBoundary = rangeForSpan(scope, { start: 1, end: 4 });
    expect(toBoundary.endContainer).toBe(scope.segments[0].node);
    expect(toBoundary.toString()).toBe('oo');
  });
});

describe('wrapIndex', () => {
  it('wraps both ways and is 0 without matches', () => {
    expect(wrapIndex(7, 7)).toBe(0);
    expect(wrapIndex(-1, 7)).toBe(6);
    expect(wrapIndex(3, 7)).toBe(3);
    expect(wrapIndex(5, 0)).toBe(0);
  });
});

describe('firstIndexAtOrBelow', () => {
  it('picks the first match at or below the viewport top, else the first match', () => {
    expect(firstIndexAtOrBelow([-50, 10, 40], 0)).toBe(1);
    expect(firstIndexAtOrBelow([-50, 0, 40], 0)).toBe(1);
    expect(firstIndexAtOrBelow([-50, -20], 0)).toBe(0);
    expect(firstIndexAtOrBelow([], 0)).toBe(0);
  });
});

describe('matchRect', () => {
  it('falls back to the enclosing element when the range reports no box', () => {
    const [scope] = scopesFrom('<div data-find-scope><p>hello</p></div>');
    const p = scope.segments[0].node.parentElement!;
    p.getBoundingClientRect = () => new DOMRect(0, 120, 50, 20);
    const rect = matchRect(rangeForSpan(scope, { start: 0, end: 5 }));
    expect(rect.top).toBe(120);
    expect(rect.height).toBe(20);
  });
});

describe('setCurrentHighlight', () => {
  afterEach(() => {
    delete (globalThis as { CSS?: unknown }).CSS;
    delete (globalThis as { Highlight?: unknown }).Highlight;
  });

  it('does nothing without CSS.highlights', () => {
    const [scope] = scopesFrom('<div data-find-scope>abc</div>');
    expect(() => setCurrentHighlight(rangeForSpan(scope, { start: 0, end: 1 }))).not.toThrow();
    expect(() => setCurrentHighlight(null)).not.toThrow();
  });

  it('registers the current match under one name and clears it with null', () => {
    const registry = new Map<string, unknown>();
    class FakeHighlight {
      constructor(readonly range: Range) {}
    }
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: { highlights: registry },
    });
    Object.defineProperty(globalThis, 'Highlight', { configurable: true, value: FakeHighlight });
    const [scope] = scopesFrom('<div data-find-scope>abc</div>');
    const range = rangeForSpan(scope, { start: 1, end: 2 });

    setCurrentHighlight(range);
    expect((registry.get('chat-find') as FakeHighlight).range).toBe(range);

    setCurrentHighlight(null);
    expect(registry.has('chat-find')).toBe(false);
  });
});
