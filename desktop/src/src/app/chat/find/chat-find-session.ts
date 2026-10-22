import { signal, type Signal } from '@angular/core';
import {
  collectSearchScopes,
  compileQuery,
  findMatches,
  firstIndexAtOrBelow,
  matchRect,
  rangeForSpan,
  setCurrentHighlight,
  wrapIndex,
  type ChatFindState,
  type MatchSpan,
  type SearchScope,
} from './chat-find';

/** Typing and content changes recompute the matches after this pause. */
const DEBOUNCE_MS = 150;

/** What the message list gives the session: its scroll container, the tab's state, and a way to report a changed state. */
export interface ChatFindHost {
  container(): HTMLElement | null;
  state(): ChatFindState;
  changed(next: ChatFindState): void;
}

interface FoundMatch {
  scope: SearchScope;
  span: MatchSpan;
}

type Reason = 'query' | 'content' | 'restore';

/**
 * The DOM side of find-in-chat for one message list: counts the matches of the tab's query in the
 * rendered text, highlights and scrolls to the current one, and recounts after a debounce whenever
 * the query, the open state, the conversation or the list's DOM changes.
 */
export class ChatFindSession {
  private readonly _total = signal(0);
  private readonly _invalid = signal(false);
  /** Number of matches in the list, 0 while the bar is closed. */
  readonly total: Signal<number> = this._total.asReadonly();
  /** Whether the query is a regex that does not compile. */
  readonly invalid: Signal<boolean> = this._invalid.asReadonly();

  private matches: FoundMatch[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private observer: MutationObserver | null = null;
  private lastQuery: ChatFindState | null = null;
  private lastConversationKey: string | null = null;

  /**
   * Binds the session to one message list.
   * @param host - The list's container, the tab's state and the change sink.
   */
  constructor(private readonly host: ChatFindHost) {}

  /**
   * Takes the tab's state after any change of it or of the conversation shown. A query or toggle
   * change scrolls to the first match at or below the viewport; an open or a tab switch restores the
   * stored current match without scrolling; a closed bar clears everything.
   * @param state - The tab's find state.
   * @param conversationKey - Identity of the conversation shown (tab id).
   */
  update(state: ChatFindState, conversationKey: string): void {
    if (!state.open) {
      this.reset();
      return;
    }
    const reopened = this.lastQuery === null;
    const switched =
      this.lastConversationKey !== null && conversationKey !== this.lastConversationKey;
    const queryChanged =
      !reopened &&
      (state.query !== this.lastQuery!.query ||
        state.regex !== this.lastQuery!.regex ||
        state.matchCase !== this.lastQuery!.matchCase);
    this.lastQuery = state;
    this.lastConversationKey = conversationKey;
    this.observe();
    if (reopened || switched) this.schedule('restore');
    else if (queryChanged) this.schedule('query');
  }

  /** Moves to the next match, wrapping to the first after the last. */
  next(): void {
    this.step(1);
  }

  /** Moves to the previous match, wrapping to the last before the first. */
  previous(): void {
    this.step(-1);
  }

  /** Stops observing and drops the highlight; the session may be updated again afterwards. */
  dispose(): void {
    this.reset();
  }

  private reset(): void {
    this.clearTimer();
    this.observer?.disconnect();
    this.observer = null;
    this.lastQuery = null;
    this.matches = [];
    this._total.set(0);
    this._invalid.set(false);
    setCurrentHighlight(null);
  }

  private observe(): void {
    const container = this.host.container();
    if (this.observer || !container) return;
    this.observer = new MutationObserver(() => this.schedule('content'));
    this.observer.observe(container, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open'],
    });
  }

  private schedule(reason: Reason): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.recompute(reason);
    }, DEBOUNCE_MS);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private step(delta: number): void {
    const total = this.matches.length;
    if (total === 0) return;
    const state = this.host.state();
    const current = wrapIndex(state.current + delta, total);
    this.show(current, true);
    this.host.changed({ ...state, current });
  }

  private recompute(reason: Reason): void {
    const state = this.host.state();
    const container = this.host.container();
    if (!state.open || !container) return;
    this.observe();
    const matcher = compileQuery(state);
    this._invalid.set(state.regex && state.query.length > 0 && matcher === null);
    const found: FoundMatch[] = [];
    if (matcher) {
      for (const scope of collectSearchScopes(container)) {
        for (const span of findMatches(scope.text, matcher)) found.push({ scope, span });
      }
    }
    this.matches = found;
    this._total.set(found.length);
    if (found.length === 0) {
      setCurrentHighlight(null);
      if (state.current !== 0) this.host.changed({ ...state, current: 0 });
      return;
    }
    let current: number;
    if (reason === 'query') {
      const viewportTop = container.getBoundingClientRect().top;
      const tops = found.map((m) => matchRect(rangeForSpan(m.scope, m.span)).top);
      current = firstIndexAtOrBelow(tops, viewportTop);
    } else {
      current = Math.min(state.current, found.length - 1);
    }
    this.show(current, reason === 'query');
    if (current !== state.current) this.host.changed({ ...state, current });
  }

  private show(index: number, scroll: boolean): void {
    const match = this.matches[index];
    const container = this.host.container();
    if (!match || !container) return;
    const range = rangeForSpan(match.scope, match.span);
    setCurrentHighlight(range);
    if (!scroll) return;
    const rect = matchRect(range);
    const viewport = container.getBoundingClientRect();
    container.scrollTop += rect.top - viewport.top - (container.clientHeight - rect.height) / 2;
  }
}
