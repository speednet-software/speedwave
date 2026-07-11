import { A11yModule } from '@angular/cdk/a11y';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { TemplatePortal } from '@angular/cdk/portal';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  TemplateRef,
  ViewContainerRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { filter } from 'rxjs/operators';
import type { ConversationSummary } from '../../models/chat';
import { IconComponent } from '../../shared/icon.component';

/**
 * Buckets a conversation into today/yesterday/older by relative day.
 * @param ts - ISO timestamp of the conversation's last activity.
 * @param now - Reference epoch in ms; defaults to `Date.now()`.
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

/** One conversation row prepared for rendering with cleaned preview/timestamp. */
interface ConversationRow {
  readonly conv: ConversationSummary;
  readonly preview: string;
  readonly timestamp: string;
}

/** A bucket with the matching prepared rows, in display order. */
interface ConversationGroup {
  key: string;
  label: string;
  rows: readonly ConversationRow[];
}

/** Display order — drives both grouping and rendering. */
const BUCKET_ORDER: readonly { key: string; label: string }[] = [
  { key: 'today', label: 'today' },
  { key: 'yesterday', label: 'yesterday' },
  { key: 'older', label: 'older' },
];

/**
 * Left CDK-overlay drawer of past conversations: portalled `<ng-template>`,
 * search-filtered buckets (today/yesterday/older); outputs match legacy contract.
 */
@Component({
  selector: 'app-conversations-sidebar',
  imports: [A11yModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-template #content>
      <div
        class="flex h-full w-64 flex-col border-r border-[var(--line)] bg-[var(--bg-1)]"
        role="navigation"
        aria-label="Conversations"
        data-testid="conversations-sidebar"
        cdkTrapFocus
      >
        <div class="flex h-11 items-center gap-2 border-b border-[var(--line)] px-3">
          <span class="mono text-[11px] text-[var(--ink-mute)]">conversations</span>
          <span class="pill accent" data-testid="conversations-sidebar-count">
            {{ conversations().length }}
          </span>
          <button
            type="button"
            class="ml-auto text-[var(--ink-mute)] hover:text-[var(--ink)]"
            data-testid="conversations-sidebar-close"
            aria-label="Close conversations sidebar"
            (click)="closed.emit()"
          >
            <app-icon name="x" class="h-4 w-4" />
          </button>
        </div>

        <div class="border-b border-[var(--line)] p-2">
          <label
            class="flex items-center gap-2 rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1"
          >
            <span class="mono text-[11px] text-[var(--ink-mute)]" aria-hidden="true">&gt;</span>
            <input
              type="text"
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
              @for (row of group.rows; track row.conv.session_id) {
                @let active = row.conv.session_id === currentSessionId();
                @let pendingDelete = row.conv.session_id === pendingDeleteId();
                <div
                  class="group flex items-stretch border-l-2"
                  [class]="
                    active
                      ? 'border-[var(--accent)] bg-[var(--bg-2)]'
                      : 'border-transparent hover-bg'
                  "
                  [attr.data-active]="active ? 'true' : null"
                  data-testid="conversations-sidebar-row"
                >
                  @if (pendingDelete) {
                    <div
                      class="flex min-w-0 flex-1 items-center justify-between gap-2 px-3 py-2"
                      [attr.data-testid]="'conversation-confirm-' + row.conv.session_id"
                      role="alertdialog"
                      aria-label="Confirm delete conversation"
                    >
                      <span class="mono truncate text-[11.5px] text-[var(--ink-dim)]"> Sure? </span>
                      <div class="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          class="mono rounded border border-red-500/40 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-500/10"
                          [attr.data-testid]="'conversation-confirm-yes-' + row.conv.session_id"
                          (click)="confirmDelete(row.conv)"
                        >
                          delete
                        </button>
                        <button
                          type="button"
                          class="mono rounded border border-[var(--line)] px-2 py-0.5 text-[11px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
                          [attr.data-testid]="'conversation-confirm-no-' + row.conv.session_id"
                          (click)="cancelDelete()"
                        >
                          cancel
                        </button>
                      </div>
                    </div>
                  } @else {
                    <!-- Row click resumes directly — no "view → resume" two-step. -->
                    <button
                      type="button"
                      class="min-w-0 flex-1 px-3 py-2 text-left"
                      [attr.data-testid]="'conversation-resume-' + row.conv.session_id"
                      [attr.aria-current]="active ? 'true' : null"
                      aria-label="Resume conversation"
                      (click)="resumeConversation.emit(row.conv)"
                    >
                      <div
                        class="truncate text-[13px]"
                        [class]="active ? 'text-[var(--ink)]' : 'text-[var(--ink-dim)]'"
                      >
                        {{ row.preview }}
                      </div>
                      <div class="mono mt-0.5 text-[10px] text-[var(--ink-mute)]">
                        {{ row.conv.message_count }} · {{ row.timestamp }}
                      </div>
                    </button>
                    <button
                      type="button"
                      class="flex shrink-0 items-center px-2 text-[var(--ink-mute)] opacity-0 hover:text-red-300 focus:opacity-100 group-hover:opacity-100"
                      [attr.data-testid]="'conversation-delete-' + row.conv.session_id"
                      [attr.aria-label]="'Delete conversation ' + row.preview"
                      (click)="requestDelete(row.conv)"
                    >
                      <app-icon name="trash" class="h-4 w-4" />
                    </button>
                  }
                </div>
              }
            }
          }
        </div>
      </div>
    </ng-template>
  `,
})
export class ConversationsSidebarComponent {
  /** Whether the drawer is currently open. Drives the CDK overlay attach/detach. */
  readonly open = input<boolean>(false);
  /** Conversations to display, in newest-first order. */
  readonly conversations = input.required<readonly ConversationSummary[]>();
  /** Active session id — gets the accent left-border in the list. */
  readonly currentSessionId = input<string | null>(null);

  /** Drawer requested to close (close button, backdrop click, or Escape). */
  readonly closed = output<void>();
  /** Resume `conv` as the live session — emitted on row click (primary action). */
  readonly resumeConversation = output<ConversationSummary>();
  /** Delete confirmed for `conv`; parent calls the backend + reloads. */
  readonly deleteConversation = output<ConversationSummary>();

  /** Free-text filter applied to the buckets — narrows preview matches case-insensitively. */
  protected readonly query = signal('');

  /** Session id pending confirm; `null` when no row is in the confirm state. */
  protected readonly pendingDeleteId = signal<string | null>(null);

  /** Template containing the drawer content — handed to the CDK overlay portal. */
  protected readonly content = viewChild.required<TemplateRef<unknown>>('content');

  private readonly overlay = inject(Overlay);
  private readonly viewContainerRef = inject(ViewContainerRef);
  private overlayRef: OverlayRef | null = null;

  /**
   * Buckets the filtered list (today/yesterday/older); preview+timestamp are
   * formatted once here, not per change-detection tick.
   */
  protected readonly groups = computed<readonly ConversationGroup[]>(() => {
    const q = this.query().trim().toLowerCase();
    const list = this.conversations();
    const filtered =
      q === '' ? list : list.filter((c) => (c.preview ?? '').toLowerCase().includes(q));
    const buckets = new Map<string, ConversationRow[]>();
    for (const conv of filtered) {
      const bucket = bucketForTimestamp(conv.timestamp);
      const row: ConversationRow = {
        conv,
        preview: cleanConversationPreview(conv.preview),
        timestamp: formatRelativeTime(conv.timestamp),
      };
      const existing = buckets.get(bucket);
      if (existing) existing.push(row);
      else buckets.set(bucket, [row]);
    }
    return BUCKET_ORDER.flatMap((b) => {
      const rows = buckets.get(b.key);
      return rows && rows.length > 0 ? [{ key: b.key, label: b.label, rows }] : [];
    });
  });

  private readonly injector = inject(Injector);

  /** Sync the `open` input with the CDK overlay lifecycle (open/close panel). */
  constructor() {
    effect(() => {
      if (this.open()) this.openOverlay();
      else this.closeOverlay();
    });
    // Scroll active row into view on open, active-session change, or rows arriving.
    effect(() => {
      this.open();
      this.currentSessionId();
      this.groups();
      this.scheduleActiveRowScroll();
    });
    // Dispose the overlay if the host is torn down while open.
    inject(DestroyRef).onDestroy(() => this.closeOverlay());
  }

  /** After the next render, scroll the active row into view within the overlay. */
  private scheduleActiveRowScroll(): void {
    const root = this.overlayRef?.overlayElement;
    if (!root) return;
    afterNextRender(() => scrollActiveRowIntoView(root), { injector: this.injector });
  }

  /**
   * Filter input handler — kept native to avoid a one-off form group.
   * @param event Native input event from the search field.
   */
  protected onQuery(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    this.query.set(target?.value ?? '');
  }

  protected requestDelete(conv: ConversationSummary): void {
    this.pendingDeleteId.set(conv.session_id);
  }

  protected confirmDelete(conv: ConversationSummary): void {
    this.pendingDeleteId.set(null);
    this.deleteConversation.emit(conv);
  }

  protected cancelDelete(): void {
    this.pendingDeleteId.set(null);
  }

  private openOverlay(): void {
    if (this.overlayRef !== null) return;
    const overlayRef = this.overlay.create({
      // Anchor past the 56px nav-rail so the drawer doesn't cover it.
      positionStrategy: this.overlay.position().global().left('56px').top('0'),
      height: '100%',
      hasBackdrop: true,
      backdropClass: 'cdk-overlay-dark-backdrop',
      panelClass: ['drawer-panel', 'sidebar-drawer-panel'],
      scrollStrategy: this.overlay.scrollStrategies.block(),
    });
    overlayRef.attach(new TemplatePortal(this.content(), this.viewContainerRef));
    overlayRef.backdropClick().subscribe(() => this.closed.emit());
    overlayRef
      .keydownEvents()
      .pipe(filter((e) => e.key === 'Escape'))
      .subscribe((e) => {
        e.preventDefault();
        this.closed.emit();
      });
    this.overlayRef = overlayRef;
  }

  private closeOverlay(): void {
    if (this.overlayRef === null) return;
    this.pendingDeleteId.set(null);
    this.overlayRef.dispose();
    this.overlayRef = null;
  }
}

/**
 * Scrolls the active row to the top within `root`; no-op if none active.
 * Exported for unit testing.
 * @param root - Element containing the rendered rows.
 */
export function scrollActiveRowIntoView(root: ParentNode): void {
  const active = root.querySelector<HTMLElement>('[data-active="true"]');
  active?.scrollIntoView({ block: 'start' });
}

const PREVIEW_TAG_RE =
  /<\/?(command-(?:name|message|args|stdout|stderr)|local-command-[^>]+|user-prompt-submit-hook[^>]*)>/gi;
const PREVIEW_OTHER_TAG_RE = /<[^>]+>/g;
const PREVIEW_PLAN_PREFIX_RE = /^\[Plan mode\][^\n]*\n+/i;

/**
 * Strips internal markers (`<command-message>` etc.) from a backend preview;
 * falls back to "untitled" when nothing usable remains.
 * @param raw - Raw preview text from `list_conversations`.
 */
function cleanConversationPreview(raw: string): string {
  if (!raw) return 'untitled';
  const stripped = raw
    .replace(PREVIEW_TAG_RE, '')
    .replace(PREVIEW_OTHER_TAG_RE, ' ')
    .replace(PREVIEW_PLAN_PREFIX_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || 'untitled';
}

/**
 * Formats a timestamp as a short relative label (`2m`, `1h`, `3d`); returns
 * unparseable input unchanged so pre-formatted strings pass through.
 * @param value - ISO timestamp string (or pre-formatted display label).
 */
function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  const diffMs = Date.now() - parsed;
  if (diffMs < 0) return 'now';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(days / 365);
  return `${years}y`;
}
