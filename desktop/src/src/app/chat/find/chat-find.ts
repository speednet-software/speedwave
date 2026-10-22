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

/** The part of the state that decides what matches. */
export type FindQuery = Pick<ChatFindState, 'query' | 'regex' | 'matchCase'>;

/** A match as character offsets into the concatenated text of one search scope. */
export interface MatchSpan {
  start: number;
  end: number;
}

interface TextSegment {
  node: Text;
  start: number;
}

/** One searchable scope: its concatenated text and the text nodes it was built from. */
export interface SearchScope {
  text: string;
  segments: readonly TextSegment[];
}

/** Registry name of the current-match highlight; styled by `::highlight(chat-find)` in `styles.css`. */
const HIGHLIGHT_NAME = 'chat-find';

const SCOPE_SELECTOR = '[data-find-scope]';

/** Elements skipped inside a scope: a diagram slot (its shadow root draws the diagram), a closed `<details>`, hidden content. */
const SKIPPED_SELECTOR = '.mermaid-slot, details:not([open]), [hidden], [aria-hidden="true"]';

/** Elements whose start ends the text of the element before them, so a match never runs across two paragraphs. */
const BLOCK_SELECTOR =
  'p, div, li, ul, ol, pre, h1, h2, h3, h4, h5, h6, blockquote, table, thead, tbody, tr, td, th, section, details, summary, hr, br, dl, dt, dd, figure, figcaption';

const BLOCK_BOUNDARY = '\n';

/**
 * Collects every scope under `root`, in document order, each with its visible text concatenated across
 * inline elements so a match may span formatting (`foo **bar**`, highlight.js spans in code), with a
 * line break where a block element starts so text never runs from one paragraph into the next.
 * @param root - The message list container.
 */
export function collectSearchScopes(root: ParentNode): SearchScope[] {
  const scopes: SearchScope[] = [];
  for (const el of root.querySelectorAll(SCOPE_SELECTOR)) {
    if (el.closest(SKIPPED_SELECTOR)) continue;
    const scope = collectScope(el);
    if (scope.text.length > 0) scopes.push(scope);
  }
  return scopes;
}

/**
 * Builds the matcher for a query, or `null` for an empty query or a regex that does not compile.
 * @param find - The query and its toggles.
 */
export function compileQuery(find: FindQuery): RegExp | null {
  if (find.query.length === 0) return null;
  const source = find.regex ? find.query : escapeRegExp(find.query);
  try {
    return new RegExp(source, find.matchCase ? 'g' : 'gi');
  } catch {
    return null;
  }
}

/**
 * Escapes `text` so a regex built from it matches it literally.
 * @param text - Plain text, such as a selection prefilled while the regex toggle is on.
 */
export function escapeRegExp(text: string): string {
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
 * Maps a span of the scope text back to a DOM `Range` over the text nodes it covers; a span edge that
 * falls on a block boundary snaps to the nearest text node.
 * @param scope - The scope the span was found in.
 * @param span - Offsets into `scope.text`.
 */
export function rangeForSpan(scope: SearchScope, span: MatchSpan): Range {
  const start = locate(scope.segments, span.start, 'start');
  const end = locate(scope.segments, span.end, 'end');
  const range = start.node.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
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
  const own = range.getBoundingClientRect?.();
  if (own && (own.width > 0 || own.height > 0)) return own;
  const el = range.startContainer.parentElement;
  return el ? el.getBoundingClientRect() : new DOMRect();
}

/**
 * Highlights `range` as the current match, or clears the highlight; a no-op where the CSS Custom
 * Highlight API is missing (WKWebView before Safari 17.2), so scrolling and the counter still work.
 * @param range - The current match, or `null` to clear.
 */
export function setCurrentHighlight(range: Range | null): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS) || typeof Highlight !== 'function')
    return;
  if (range) CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range));
  else CSS.highlights.delete(HIGHLIGHT_NAME);
}

function collectScope(el: Element): SearchScope {
  const segments: TextSegment[] = [];
  let text = '';
  const boundary = (): void => {
    if (text.length > 0 && !text.endsWith(BLOCK_BOUNDARY)) text += BLOCK_BOUNDARY;
  };
  const walk = (parent: Node): void => {
    for (const child of parent.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const data = (child as Text).data;
        if (data.length === 0) continue;
        segments.push({ node: child as Text, start: text.length });
        text += data;
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const element = child as Element;
      const block = element.matches(BLOCK_SELECTOR);
      if (block) boundary();
      if (!element.matches(SKIPPED_SELECTOR)) walk(element);
      if (block) boundary();
    }
  };
  walk(el);
  return { text: text.endsWith(BLOCK_BOUNDARY) ? text.slice(0, -1) : text, segments };
}

function locate(
  segments: readonly TextSegment[],
  offset: number,
  edge: 'start' | 'end'
): { node: Text; offset: number } {
  let lo = 0;
  let hi = segments.length - 1;
  const probe = edge === 'start' ? offset : offset - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid].start <= probe) lo = mid;
    else hi = mid - 1;
  }
  let segment = segments[lo];
  let inNode = offset - segment.start;
  if (edge === 'start' && inNode >= segment.node.length && lo + 1 < segments.length) {
    segment = segments[lo + 1];
    inNode = 0;
  }
  return { node: segment.node, offset: Math.min(inNode, segment.node.length) };
}
