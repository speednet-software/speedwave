import { describe, it, expect, afterEach } from 'vitest';
import {
  FIND_HIGHLIGHT_NAME,
  FIND_SCOPE_ATTR,
  collectSearchScopes,
  compileQuery,
  findMatches,
  firstIndexAtOrBelow,
  highlightsSupported,
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

describe('compileQuery', () => {
  it('returns null for an empty query', () => {
    expect(compileQuery('', false, false)).toBeNull();
    expect(compileQuery('', true, true)).toBeNull();
  });

  it('escapes metacharacters in a plain query', () => {
    const m = compileQuery('a.b(c)', false, false)!;
    expect(findMatches('a.b(c) axb(c)', m)).toEqual([{ start: 0, end: 6 }]);
  });

  it('is case-insensitive unless matchCase is set', () => {
    expect(findMatches('Foo foo FOO', compileQuery('foo', false, false)!)).toHaveLength(3);
    expect(findMatches('Foo foo FOO', compileQuery('foo', false, true)!)).toEqual([
      { start: 4, end: 7 },
    ]);
  });

  it('compiles a regex query and returns null when it does not parse', () => {
    expect(findMatches('ab12cd', compileQuery('\\d+', true, false)!)).toEqual([
      { start: 2, end: 4 },
    ]);
    expect(compileQuery('(', true, false)).toBeNull();
    expect(compileQuery('[a-', true, true)).toBeNull();
  });

  it('matches Unicode text', () => {
    const m = compileQuery('zażółć', false, false)!;
    expect(findMatches('Zażółć gęślą jaźń, zażółć', m)).toEqual([
      { start: 0, end: 6 },
      { start: 19, end: 25 },
    ]);
  });
});

describe('findMatches', () => {
  it('skips zero-length matches instead of counting every gap', () => {
    expect(findMatches('baaac', compileQuery('a*', true, false)!)).toEqual([{ start: 1, end: 4 }]);
    expect(findMatches('abc', compileQuery('x*', true, false)!)).toEqual([]);
  });

  it('finds overlapping-looking repeats as consecutive non-overlapping matches', () => {
    expect(findMatches('aaaa', compileQuery('aa', false, false)!)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it('starts from the beginning on every call', () => {
    const m = compileQuery('a', false, false)!;
    expect(findMatches('aa', m)).toHaveLength(2);
    expect(findMatches('aa', m)).toHaveLength(2);
  });
});

describe('collectSearchScopes', () => {
  it('concatenates text across inline elements so a match may span formatting', () => {
    const [scope] = scopesFrom(
      `<div ${FIND_SCOPE_ATTR}><p>foo <strong>bar</strong> <code><span class="hljs">baz</span></code></p></div>`
    );
    expect(scope.text).toBe('foo bar baz');
    expect(scope.segments.map((s) => s.start)).toEqual([0, 4, 7, 8]);
    const m = compileQuery('foo bar', false, false)!;
    expect(findMatches(scope.text, m)).toEqual([{ start: 0, end: 7 }]);
  });

  it('returns scopes in document order and drops empty ones', () => {
    const scopes = scopesFrom(
      `<div ${FIND_SCOPE_ATTR}>first</div><div ${FIND_SCOPE_ATTR}></div><div ${FIND_SCOPE_ATTR}>second</div>`
    );
    expect(scopes.map((s) => s.text)).toEqual(['first', 'second']);
  });

  it('ignores text outside a scope', () => {
    const scopes = scopesFrom(
      `<span>12:34</span><div ${FIND_SCOPE_ATTR}>hello</div><button>Retry</button>`
    );
    expect(scopes.map((s) => s.text)).toEqual(['hello']);
  });

  it('skips a mermaid slot, a closed details, hidden and aria-hidden elements inside a scope', () => {
    const [scope] = scopesFrom(
      `<div ${FIND_SCOPE_ATTR}>a<div class="mermaid-slot"><pre>graph TD</pre></div>b<details><summary>s</summary>closed</details><details open><summary>t</summary>open</details>c<span hidden>h</span><span aria-hidden="true">x</span></div>`
    );
    expect(scope.text).toBe('abtopenc');
  });

  it('skips a scope that sits inside a closed details', () => {
    const scopes = scopesFrom(
      `<details><summary>thinking</summary><div ${FIND_SCOPE_ATTR}>reasoning</div></details><details open><summary>thinking</summary><div ${FIND_SCOPE_ATTR}>shown</div></details>`
    );
    expect(scopes.map((s) => s.text)).toEqual(['shown']);
  });
});

describe('rangeForSpan', () => {
  it('maps a span inside one text node', () => {
    const [scope] = scopesFrom(`<div ${FIND_SCOPE_ATTR}>hello world</div>`);
    const range = rangeForSpan(scope, { start: 6, end: 11 });
    expect(range.toString()).toBe('world');
  });

  it('maps a span that crosses text nodes', () => {
    const [scope] = scopesFrom(`<div ${FIND_SCOPE_ATTR}>foo <b>bar</b> baz</div>`);
    const range = rangeForSpan(scope, { start: 2, end: 9 });
    expect(range.toString()).toBe('o bar b');
    expect(range.startContainer).toBe(scope.segments[0].node);
    expect(range.endContainer).toBe(scope.segments[2].node);
  });

  it('ends inside the node that holds the last matched character', () => {
    const [scope] = scopesFrom(`<div ${FIND_SCOPE_ATTR}><i>ab</i><i>cd</i></div>`);
    const range = rangeForSpan(scope, { start: 0, end: 2 });
    expect(range.endContainer).toBe(scope.segments[0].node);
    expect(range.endOffset).toBe(2);
    expect(range.toString()).toBe('ab');
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
    const [scope] = scopesFrom(`<div ${FIND_SCOPE_ATTR}><p>hello</p></div>`);
    const p = scope.segments[0].node.parentElement!;
    p.getBoundingClientRect = () => new DOMRect(0, 120, 50, 20);
    const rect = matchRect(rangeForSpan(scope, { start: 0, end: 5 }));
    expect(rect.top).toBe(120);
    expect(rect.height).toBe(20);
  });
});

describe('highlights', () => {
  afterEach(() => {
    delete (globalThis as { CSS?: unknown }).CSS;
    delete (globalThis as { Highlight?: unknown }).Highlight;
  });

  it('reports no support without CSS.highlights and then sets nothing', () => {
    expect(highlightsSupported()).toBe(false);
    const [scope] = scopesFrom(`<div ${FIND_SCOPE_ATTR}>abc</div>`);
    expect(() => setCurrentHighlight(rangeForSpan(scope, { start: 0, end: 1 }))).not.toThrow();
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
    const [scope] = scopesFrom(`<div ${FIND_SCOPE_ATTR}>abc</div>`);
    const range = rangeForSpan(scope, { start: 1, end: 2 });

    expect(highlightsSupported()).toBe(true);
    setCurrentHighlight(range);
    expect((registry.get(FIND_HIGHLIGHT_NAME) as FakeHighlight).range).toBe(range);

    setCurrentHighlight(null);
    expect(registry.has(FIND_HIGHLIGHT_NAME)).toBe(false);
  });
});
