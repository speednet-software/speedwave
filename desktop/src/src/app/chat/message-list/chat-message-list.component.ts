import {
  AfterViewChecked,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  OnChanges,
  OnDestroy,
  ViewChild,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { ChatMessage, MessageBlock } from '../../models/chat';
import { ChatMessageComponent } from '../message/chat-message.component';
import { SpinIconComponent } from '../../shared/spin-icon.component';
import { IconComponent } from '../../shared/icon.component';
import { onRequestCounter } from '../../shared/request-counter';
import { ChatFindBarComponent } from '../find/chat-find-bar.component';
import { ChatFindSession } from '../find/chat-find-session';
import { DEFAULT_FIND_STATE, type ChatFindState } from '../find/chat-find';

const SCROLL_BOTTOM_THRESHOLD_PX = 16;

/** Scrollable message list with auto-scroll-to-bottom that pauses while the user reads earlier messages. */
@Component({
  selector: 'app-chat-message-list',
  imports: [ChatMessageComponent, SpinIconComponent, IconComponent, ChatFindBarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'relative flex min-h-0 flex-1 flex-col' },
  template: `
    <div
      #scrollContainer
      data-testid="chat-message-list"
      role="log"
      aria-live="polite"
      aria-label="Chat messages"
      class="relative h-full overflow-y-auto p-4 md:p-6"
      (scroll)="onScroll()"
    >
      @if (showTranscriptLoader()) {
        <div
          data-testid="chat-transcript-loading"
          class="absolute inset-0 flex items-center justify-center"
        >
          <app-spin-icon class="block h-8 w-8 text-[var(--accent)]" />
        </div>
      }
      <div class="mx-auto max-w-3xl space-y-8">
        @for (msg of messages(); track msg.timestamp; let i = $index) {
          <app-chat-message
            [blocks]="msg.blocks"
            [role]="msg.role"
            [timestamp]="msg.timestamp"
            [entryIndex]="i"
            [isLast]="i === lastAssistantIndex()"
            [entry]="msg"
            [precedingEdited]="isPrecedingUserEdited(i)"
            (questionAnswered)="questionAnswered.emit($event)"
          />
        }
        @if (showStreaming()) {
          <app-chat-message
            data-testid="chat-message-list-streaming"
            [blocks]="currentBlocks()"
            role="assistant"
            [streaming]="true"
            (questionAnswered)="questionAnswered.emit($event)"
          />
        } @else if (showAwaitingCaret()) {
          <!-- Standalone caret placeholder: streaming started, no block yet. -->
          <div data-testid="chat-message-list-awaiting">
            <span class="caret" aria-label="Assistant is responding"></span>
          </div>
        }
      </div>
    </div>
    @if (find().open) {
      <app-chat-find-bar
        class="absolute right-4 top-2 z-10 md:right-6"
        [query]="find().query"
        [regex]="find().regex"
        [matchCase]="find().matchCase"
        [invalid]="findInvalid()"
        [current]="find().current"
        [total]="findTotal()"
        (queryChange)="onFindQuery($event)"
        (regexToggled)="onFindRegexToggled()"
        (caseToggled)="onFindCaseToggled()"
        (next)="findNext()"
        (previous)="findPrevious()"
        (closed)="findClosed.emit()"
      />
    }
    @if (!atBottom()) {
      <button
        type="button"
        data-testid="chat-jump-to-bottom"
        class="absolute bottom-3 left-1/2 z-10 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-[var(--line-strong)] bg-[var(--bg-2)] text-[var(--ink-dim)] shadow-lg hover:text-[var(--ink)]"
        aria-label="Scroll to bottom"
        title="Scroll to bottom"
        (click)="jumpToBottom()"
      >
        <app-icon name="chevron-down" [strokeWidth]="2" class="h-4 w-4" />
      </button>
    }
  `,
})
export class ChatMessageListComponent implements AfterViewChecked, OnChanges, OnDestroy {
  readonly messages = input.required<readonly ChatMessage[]>();
  readonly currentBlocks = input<readonly MessageBlock[]>([]);
  readonly isStreaming = input(false);
  /** Shows a centered spinner while a resumed transcript is being fetched. */
  readonly loadingTranscript = input(false);
  /** Index of the most recent assistant entry in `messages` (`-1` when none); gates the per-message Retry button. */
  readonly lastAssistantIndex = input(-1);
  /** Identity of the rendered conversation (tab id); a change resets the per-conversation scroll tracking. */
  readonly conversationKey = input('');
  readonly autoScrollRequest = input(0);
  /** The active tab's find state; the bar renders while it is open. */
  readonly find = input<ChatFindState>(DEFAULT_FIND_STATE);
  /** A counter whose change puts the caret into the open find bar (⌘F). */
  readonly findFocusRequest = input(0);

  readonly questionAnswered = output<{ toolId: string; questionIdx: number; value: string }>();
  /** The next find state after a typed query, a toggle, or a moved current match. */
  readonly findChanged = output<ChatFindState>();
  /** The bar asked to close (Escape or its button). */
  readonly findClosed = output<void>();

  @ViewChild('scrollContainer') scrollContainer!: ElementRef<HTMLDivElement>;
  private readonly findBar = viewChild(ChatFindBarComponent);
  private readonly injector = inject(Injector);

  /** Whether the viewport shows the end of the list; drives the jump-to-bottom button. */
  readonly atBottom = signal(true);

  private readonly findSession = new ChatFindSession({
    container: () => this.scrollContainer?.nativeElement ?? null,
    state: () => this.find(),
    changed: (next) => this.findChanged.emit(next),
  });
  readonly findTotal = this.findSession.total;
  readonly findInvalid = this.findSession.invalid;

  private shouldAutoScroll = true;
  private pendingScrollSync = false;
  private lastAutoScrollRequest = 0;
  private lastConversationKey: string | null = null;
  private rederiveFromViewport = false;

  /** Wires the streaming-aware scroll sync, re-run on every signal-input change. */
  constructor() {
    effect(() => {
      const key = this.conversationKey();
      const request = this.autoScrollRequest();
      this.messages();
      this.currentBlocks();
      this.isStreaming();
      const keyChanged = this.lastConversationKey !== null && key !== this.lastConversationKey;
      const requested = request !== this.lastAutoScrollRequest;
      this.lastConversationKey = key;
      this.lastAutoScrollRequest = request;
      if (keyChanged) {
        this.rederiveFromViewport = true;
        this.pendingScrollSync = false;
        return;
      }
      if (this.rederiveFromViewport) {
        this.rederiveFromViewport = false;
        this.shouldAutoScroll = this.isAtBottom();
      }
      if (requested) {
        this.shouldAutoScroll = true;
      }
      this.pendingScrollSync = true;
    });

    effect(() => {
      const state = this.find();
      const key = this.conversationKey();
      untracked(() => this.findSession.update(state, key));
    });

    onRequestCounter(this.findFocusRequest, () =>
      afterNextRender(() => this.findBar()?.focusInput(), { injector: this.injector })
    );
  }

  private isAtBottom(): boolean {
    const el = this.scrollContainer?.nativeElement;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_BOTTOM_THRESHOLD_PX;
  }

  /** Whether to show the transcript loader: fetching with nothing rendered yet. */
  showTranscriptLoader(): boolean {
    return this.loadingTranscript() && this.messages().length === 0;
  }

  /** Whether to render the streaming placeholder as the last entry. */
  showStreaming(): boolean {
    return this.isStreaming() && this.currentBlocks().length > 0;
  }

  /** Whether to render the standalone caret: streaming with no block yet. */
  showAwaitingCaret(): boolean {
    return this.isStreaming() && this.currentBlocks().length === 0;
  }

  /**
   * True when the user entry preceding `messages[i]` was retried (surfaces as `· edited`); false for user entries, index 0, or no `edited_at`.
   * @param i - Index into `messages()` to check.
   */
  isPrecedingUserEdited(i: number): boolean {
    if (i <= 0) return false;
    const list = this.messages();
    const self = list[i];
    if (!self || self.role !== 'assistant') return false;
    const prev = list[i - 1];
    return prev?.role === 'user' && typeof prev.edited_at === 'number';
  }

  /** Marks scroll position for sync on next `ngAfterViewChecked`. */
  ngOnChanges(): void {
    this.pendingScrollSync = true;
  }

  /** Whether new output is pinned to the bottom: false while the user reads earlier messages. */
  followsNewOutput(): boolean {
    return this.shouldAutoScroll;
  }

  /** Tracks user scrolling to decide whether to pin new output to the bottom. */
  onScroll(): void {
    if (!this.scrollContainer?.nativeElement) return;
    this.shouldAutoScroll = this.isAtBottom();
    this.atBottom.set(this.shouldAutoScroll);
  }

  /** Scrolls to the end and pins new output there again (the jump-to-bottom button). */
  jumpToBottom(): void {
    const el = this.scrollContainer?.nativeElement;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    this.shouldAutoScroll = true;
    this.atBottom.set(true);
  }

  /** The chat's text selection when it is a single line inside this list, else an empty string. */
  selectedText(): string {
    const selection = document.getSelection();
    const list = this.scrollContainer?.nativeElement;
    if (!selection || !list || selection.isCollapsed || !selection.anchorNode) return '';
    if (!list.contains(selection.anchorNode)) return '';
    const text = selection.toString();
    return text.includes('\n') ? '' : text;
  }

  /** Pins to the bottom after each render when the user has not scrolled up. */
  ngAfterViewChecked(): void {
    if (!this.pendingScrollSync) return;
    this.pendingScrollSync = false;
    if (!this.shouldAutoScroll) return;
    const el = this.scrollContainer?.nativeElement;
    if (!el) return;
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 1) {
      el.scrollTop = el.scrollHeight;
    }
  }

  /** Stops the find session: its observer, a pending recompute and the highlight. */
  ngOnDestroy(): void {
    this.findSession.dispose();
  }

  /**
   * The bar's field changed.
   * @param query - The typed text.
   */
  onFindQuery(query: string): void {
    this.findChanged.emit({ ...this.find(), query });
  }

  /** The regex toggle was pressed. */
  onFindRegexToggled(): void {
    const state = this.find();
    this.findChanged.emit({ ...state, regex: !state.regex });
  }

  /** The match-case toggle was pressed. */
  onFindCaseToggled(): void {
    const state = this.find();
    this.findChanged.emit({ ...state, matchCase: !state.matchCase });
  }

  /** Moves to the next match, wrapping to the first after the last. */
  findNext(): void {
    this.findSession.next();
  }

  /** Moves to the previous match, wrapping to the last before the first. */
  findPrevious(): void {
    this.findSession.previous();
  }
}
