/** Per-tab find-in-chat state; the match count is derived from the DOM, never stored. */
export interface ChatFindState {
  open: boolean;
  query: string;
  regex: boolean;
  matchCase: boolean;
  current: number;
}

export const DEFAULT_FIND_STATE: ChatFindState = {
  open: false,
  query: '',
  regex: false,
  matchCase: false,
  current: 0,
};

/** A match as character offsets into the concatenated text of one search scope. */
export interface MatchSpan {
  start: number;
  end: number;
}

/** A text node and where its text starts in the scope's concatenated text. */
export interface TextSegment {
  node: Text;
  start: number;
}

/** One searchable scope: its concatenated text and the text nodes it was built from. */
export interface SearchScope {
  text: string;
  segments: readonly TextSegment[];
}

/** Attribute that marks an element whose rendered text the find bar searches. */
export const FIND_SCOPE_ATTR = 'data-find-scope';

/** Elements skipped inside a scope: a diagram slot (its shadow root draws the diagram) and a closed `<details>`. */
const SKIPPED_SELECTOR = '.mermaid-slot, details:not([open]), [hidden], [aria-hidden="true"]';

/**
 * Collects every scope under `root`, in document order, each with its visible text concatenated across
 * inline elements so a match may span formatting (`foo **bar**`, highlight.js spans in code).
 * @param root - The message list container.
 */
export function collectSearchScopes(root: ParentNode): SearchScope[] {
  const scopes: SearchScope[] = [];
  for (const el of root.querySelectorAll(`[${FIND_SCOPE_ATTR}]`)) {
    if (el.closest(SKIPPED_SELECTOR)) continue;
    const scope = collectScope(el);
    if (scope.text.length > 0) scopes.push(scope);
  }
  return scopes;
}

function collectScope(el: Element): SearchScope {
  const doc = el.ownerDocument;
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        return (node as Element).matches(SKIPPED_SELECTOR)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const segments: TextSegment[] = [];
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const data = (node as Text).data;
    if (data.length === 0) continue;
    segments.push({ node: node as Text, start: text.length });
    text += data;
  }
  return { text, segments };
}

/**
 * Builds the matcher for a query, or `null` for an empty query or a regex that does not compile.
 * @param query - The typed query.
 * @param regex - Whether the query is a JavaScript regular expression.
 * @param matchCase - Whether letter case must match.
 */
export function compileQuery(query: string, regex: boolean, matchCase: boolean): RegExp | null {
  if (query.length === 0) return null;
  const source = regex ? query : escapeRegExp(query);
  try {
    return new RegExp(source, matchCase ? 'g' : 'gi');
  } catch {
    return null;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every non-empty match of `matcher` in `text`, in order; a zero-length match is skipped so `a*`
 * does not count the gaps between characters.
 * @param text - The scope text.
 * @param matcher - A global RegExp from {@link compileQuery}.
 */
export function findMatches(text: string, matcher: RegExp): MatchSpan[] {
  const spans: MatchSpan[] = [];
  matcher.lastIndex = 0;
  for (let m = matcher.exec(text); m; m = matcher.exec(text)) {
    if (m[0].length === 0) {
      matcher.lastIndex += 1;
      continue;
    }
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

/**
 * Maps a span of the scope text back to a DOM `Range` over the text nodes it covers.
 * @param scope - The scope the span was found in.
 * @param span - Offsets into `scope.text`.
 */
export function rangeForSpan(scope: SearchScope, span: MatchSpan): Range {
  const startSeg = segmentAt(scope.segments, span.start);
  const endSeg = segmentAt(scope.segments, span.end - 1);
  const range = startSeg.node.ownerDocument.createRange();
  range.setStart(startSeg.node, span.start - startSeg.start);
  range.setEnd(endSeg.node, span.end - endSeg.start);
  return range;
}

function segmentAt(segments: readonly TextSegment[], offset: number): TextSegment {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid].start <= offset) lo = mid;
    else hi = mid - 1;
  }
  return segments[lo];
}

/**
 * Wraps an index into `[0, total)`; `0` when there is nothing to wrap into.
 * @param index - Any integer.
 * @param total - Number of matches.
 */
export function wrapIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  return ((index % total) + total) % total;
}

/**
 * The index of the first match whose top edge is at or below `viewportTop`, else the first match.
 * Mirrors an IDE's "search from the cursor" when the query changes.
 * @param tops - The top edge of each match, in document order.
 * @param viewportTop - The top edge of the visible area, in the same coordinates.
 */
export function firstIndexAtOrBelow(tops: readonly number[], viewportTop: number): number {
  const index = tops.findIndex((top) => top >= viewportTop);
  return index === -1 ? 0 : index;
}

/**
 * The box of a match: the range's own rectangle, or the rectangle of the element holding its first
 * character where the engine gives a range none (jsdom) or an empty one.
 * @param range - A range from {@link rangeForSpan}.
 */
export function matchRect(range: Range): DOMRect {
  const own =
    typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
  if (own && (own.width > 0 || own.height > 0)) return own;
  const el = range.startContainer.parentElement;
  return el ? el.getBoundingClientRect() : new DOMRect();
}

/** Registry name of the current-match highlight; styled by `::highlight(chat-find)` in `styles.css`. */
export const FIND_HIGHLIGHT_NAME = 'chat-find';

/** Whether this engine has the CSS Custom Highlight API (WebView2; WKWebView from Safari 17.2). */
export function highlightsSupported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function';
}

/**
 * Highlights `range` as the current match, or clears the highlight; a no-op where the API is missing,
 * so scrolling and the counter still work without it.
 * @param range - The current match, or `null` to clear.
 */
export function setCurrentHighlight(range: Range | null): void {
  if (!highlightsSupported()) return;
  if (range) CSS.highlights.set(FIND_HIGHLIGHT_NAME, new Highlight(range));
  else CSS.highlights.delete(FIND_HIGHLIGHT_NAME);
}
