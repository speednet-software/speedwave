import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import type { ConversationSummary } from '../../models/chat';

/**
 * Buckets a conversation summary into a relative-day group.
 *
 * Mirrors the mockup's `today / yesterday / older` headers (lines 443/462/475).
 * Falls back to `older` when a timestamp can't be parsed so we never drop a row.
 * @param ts ISO timestamp of the conversation's last activity.
 * @param now Reference epoch in ms; defaults to `Date.now()` for testability.
 */
function bucketForTimestamp(ts: string | null | undefined, now: number = Date.now()): string {
  if (!ts) return 'older';
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return 'older';
  const ageMs = now - parsed;
  const oneDay = 24 * 60 * 60 * 1000;
  if (ageMs < oneDay) return 'today';
  if (ageMs < 2 * oneDay) return 'yesterday';
  return 'older';
}

/** A bucket with the matching conversations, in display order. */
interface ConversationGroup {
  key: string;
  label: string;
  rows: readonly ConversationSummary[];
}

/** Display order — drives both grouping and rendering. */
const BUCKET_ORDER: readonly { key: string; label: string }[] = [
  { key: 'today', label: 'today' },
  { key: 'yesterday', label: 'yesterday' },
  { key: 'older', label: 'older' },
];

/**
 * Left overlay drawer listing past conversations for the active project.
 *
 * Layout matches the terminal-minimal mockup (lines 280–301 + 427–483):
 * - Always present in the DOM as a `.collapsible-sidebar` so the
 *   `transform: translateX(...)` transition runs in/out.
 * - The parent (chat) toggles `body.sidebar-drawer-open` via `UiStateService`
 *   — the global stylesheet then animates the drawer in and dims the
 *   backdrop via `body.sidebar-drawer-open::before`.
 * - Header: mono "conversations" + accent pill count + new-conversation icon.
 * - Search input bar (UI-only filter for now — narrows the buckets below).
 * - Body: conversations grouped by today / yesterday / older with mono
 *   uppercase section labels and an accent left-border on the active row.
 *
 * Outputs match the legacy contract so chat.component continues to drive
 * view / resume / new actions without change.
 */
@Component({
  selector: 'app-conversations-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'navigation',
    'aria-label': 'Conversations',
    class:
      'collapsible-sidebar flex w-64 flex-shrink-0 flex-col border-r border-[var(--line)] bg-[var(--bg-1)]',
    '[attr.data-testid]': '"conversations-sidebar"',
    '[attr.aria-hidden]': '!open() ? "true" : null',
    '[attr.inert]': '!open() ? "" : null',
  },
  template: `
    <div class="flex h-11 items-center gap-2 border-b border-[var(--line)] px-3">
      <span class="mono text-[11px] text-[var(--ink-mute)]">conversations</span>
      <span class="pill accent" data-testid="conversations-sidebar-count">
        {{ conversations().length }}
      </span>
      <button
        type="button"
        class="ml-auto text-[var(--ink-mute)] hover:text-[var(--ink)]"
        data-testid="conversations-sidebar-new"
        title="New conversation"
        aria-label="New conversation"
        (click)="newConversation.emit()"
      >
        <svg
          class="h-4 w-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          stroke-width="1.75"
          aria-hidden="true"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
        </svg>
      </button>
      <button
        type="button"
        class="text-[var(--ink-mute)] hover:text-[var(--ink)]"
        data-testid="conversations-sidebar-close"
        aria-label="Close conversations sidebar"
        (click)="closed.emit()"
      >
        <svg
          class="h-4 w-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          stroke-width="1.75"
          aria-hidden="true"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>

    <div class="border-b border-[var(--line)] p-2">
      <label
        class="flex items-center gap-2 rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1"
      >
        <span class="mono text-[11px] text-[var(--ink-mute)]" aria-hidden="true">&gt;</span>
        <input
          type="search"
          name="conversations-search"
          class="mono w-full bg-transparent py-0.5 text-[12px] text-[var(--ink)] placeholder-[var(--ink-mute)] focus:outline-none"
          placeholder="search"
          aria-label="Search conversations"
          [value]="query()"
          (input)="onQuery($event)"
        />
        <span class="kbd" aria-hidden="true">⌘F</span>
      </label>
    </div>

    <div class="flex-1 overflow-y-auto py-1">
      @if (conversations().length === 0) {
        <div class="mono p-4 text-center text-[11.5px] text-[var(--ink-mute)]">
          no conversations yet
        </div>
      } @else if (groups().length === 0) {
        <div class="mono p-4 text-center text-[11.5px] text-[var(--ink-mute)]">no matches</div>
      } @else {
        @for (group of groups(); track group.key) {
          <div
            class="mono px-3 py-1 pt-3 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
            [attr.data-testid]="'group-' + group.key"
          >
            {{ group.label }}
          </div>
          @for (conv of group.rows; track conv.session_id) {
            @let active = conv.session_id === currentSessionId();
            <div
              class="flex items-stretch border-l-2"
              [class]="
                active ? 'border-[var(--accent)] bg-[var(--bg-2)]' : 'border-transparent hover-bg'
              "
              data-testid="conversations-sidebar-row"
            >
              <button
                type="button"
                class="min-w-0 flex-1 px-3 py-2 text-left"
                [attr.data-testid]="'conversation-view-' + conv.session_id"
                [attr.aria-current]="active ? 'true' : null"
                (click)="viewConversation.emit(conv)"
              >
                <div
                  class="truncate text-[13px]"
                  [class]="active ? 'text-[var(--ink)]' : 'text-[var(--ink-dim)]'"
                >
                  {{ conv.preview || 'untitled' }}
                </div>
                <div class="mono mt-0.5 text-[10px] text-[var(--ink-mute)]">
                  {{ conv.message_count }} · {{ conv.timestamp ?? 'unknown' }}
                </div>
              </button>
              <button
                type="button"
                class="mono px-2 text-[10px] text-[var(--ink-mute)] hover:text-[var(--accent)]"
                [attr.data-testid]="'conversation-resume-' + conv.session_id"
                aria-label="Resume conversation"
                (click)="resumeConversation.emit(conv)"
              >
                resume
              </button>
            </div>
          }
        }
      }
    </div>
  `,
})
export class ConversationsSidebarComponent {
  /** Whether the drawer is currently open. Drives the body class + a11y attrs. */
  readonly open = input<boolean>(false);
  /** Conversations to display, in newest-first order. */
  readonly conversations = input.required<readonly ConversationSummary[]>();
  /** Active session id — gets the accent left-border in the list. */
  readonly currentSessionId = input<string | null>(null);

  /** Drawer requested to close (close button or backdrop click in parent). */
  readonly closed = output<void>();
  /** New conversation requested. */
  readonly newConversation = output<void>();
  /** Read-only transcript view of `conv` requested. */
  readonly viewConversation = output<ConversationSummary>();
  /** Resume `conv` as the live session requested. */
  readonly resumeConversation = output<ConversationSummary>();

  /** Free-text filter applied to the buckets — narrows preview matches case-insensitively. */
  protected readonly query = signal('');

  /** Buckets the filtered list into today / yesterday / older with stable order. */
  protected readonly groups = computed<readonly ConversationGroup[]>(() => {
    const q = this.query().trim().toLowerCase();
    const list = this.conversations();
    const filtered =
      q === '' ? list : list.filter((c) => (c.preview ?? '').toLowerCase().includes(q));
    const buckets = new Map<string, ConversationSummary[]>();
    for (const conv of filtered) {
      const bucket = bucketForTimestamp(conv.timestamp);
      const existing = buckets.get(bucket);
      if (existing) existing.push(conv);
      else buckets.set(bucket, [conv]);
    }
    return BUCKET_ORDER.flatMap((b) => {
      const rows = buckets.get(b.key);
      return rows && rows.length > 0 ? [{ key: b.key, label: b.label, rows }] : [];
    });
  });

  /**
   * Mirrors the `open` input onto a body class so the drawer animates in.
   */
  constructor() {
    // Toggle the global body class so the stylesheet animates in the drawer
    // and dims the backdrop. We intentionally do NOT remove the class on
    // destroy — the parent owns the open/closed lifecycle.
    effect(() => {
      const open = this.open();
      const cls = 'sidebar-drawer-open';
      if (open) document.body.classList.add(cls);
      else document.body.classList.remove(cls);
    });
  }

  /**
   * Filter input handler — kept native to avoid a one-off form group.
   * @param event Native input event from the search field.
   */
  protected onQuery(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    this.query.set(target?.value ?? '');
  }
}
