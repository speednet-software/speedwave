import { CdkDrag, CdkDropList, type CdkDragDrop } from '@angular/cdk/drag-drop';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  viewChild,
  type Signal,
} from '@angular/core';
import {
  ChatStateService,
  MAX_CHAT_TABS,
  blocksToPlainText,
} from '../../services/chat-state.service';
import type { ChatSessionStore } from '../../services/chat-session-store';
import { IconComponent } from '../../shared/icon.component';

const TITLE_MAX_CHARS = 24;

interface ChatTabRow {
  readonly id: string;
  readonly title: string;
  readonly streaming: boolean;
  readonly ended: boolean;
  readonly active: boolean;
  readonly ariaLabel: string;
}

function tabAriaLabel(title: string, streaming: boolean, ended: boolean): string {
  const suffix = ended ? ', session ended' : streaming ? ', streaming' : '';
  return `Switch to tab: ${title}${suffix}`;
}

function truncateTitle(text: string): string {
  const trimmed = text.trim();
  const points = Array.from(trimmed);
  if (points.length <= TITLE_MAX_CHARS) return trimmed;
  return `${points.slice(0, TITLE_MAX_CHARS).join('').trimEnd()}…`;
}

function tabTitle(store: ChatSessionStore): string {
  const firstUser = store.messagesFromState().find((m) => m.role === 'user');
  if (!firstUser) return 'New chat';
  const text = blocksToPlainText(firstUser.blocks);
  return text ? truncateTitle(text) : 'New chat';
}

/**
 * Browser-style tab bar for parallel chat sessions, inline in the chat header; overflowing tabs
 * scroll sideways past the pinned plus button. The header decides whether the strip is shown.
 */
@Component({
  selector: 'app-chat-tabs',
  imports: [CdkDrag, CdkDropList, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex h-full min-w-0 flex-1 items-stretch', 'data-testid': 'chat-tabs' },
  styles: `
    .tab-strip {
      scrollbar-width: none;
    }
    .tab-strip::-webkit-scrollbar {
      display: none;
    }
    .cdk-drag-placeholder {
      opacity: 0;
    }
    .cdk-drag-animating,
    .cdk-drop-list-dragging .cdk-drag:not(.cdk-drag-placeholder) {
      transition: transform 150ms cubic-bezier(0, 0, 0.2, 1);
    }
  `,
  template: `
    <div
      #strip
      class="tab-strip flex min-w-0 overflow-x-auto"
      role="tablist"
      aria-label="Chat tabs"
      data-testid="chat-tabs-strip"
      (wheel)="scrollStrip($event)"
      cdkDropList
      cdkDropListOrientation="horizontal"
      cdkDropListLockAxis="x"
      (cdkDropListDropped)="drop($event)"
    >
      @for (row of tabRows(); track row.id) {
        <div
          class="group flex min-w-[110px] max-w-[200px] flex-1 items-stretch border-r border-[var(--line)]"
          [class]="row.active ? 'bg-[var(--bg-3)]' : 'hover-bg'"
          role="presentation"
          data-testid="chat-tab"
          [attr.data-active]="row.active ? 'true' : null"
          cdkDrag
          [cdkDragData]="row.id"
          cdkDragPreviewContainer="parent"
          cdkDragPreviewClass="bg-[var(--bg-3)]"
          (click)="chat.activateTab(row.id)"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-1.5 px-3 text-left"
            role="tab"
            data-testid="chat-tab-activate"
            [attr.aria-selected]="row.active ? 'true' : 'false'"
            [attr.aria-label]="row.ariaLabel"
          >
            @if (row.streaming) {
              <span
                class="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-[var(--accent)]"
                data-testid="chat-tab-streaming"
                aria-hidden="true"
              ></span>
            }
            <span
              class="truncate text-[12px]"
              data-testid="chat-tab-title"
              [class]="row.active ? 'text-[var(--ink)]' : 'text-[var(--ink-mute)]'"
            >
              {{ row.title }}
            </span>
            @if (row.ended) {
              <span class="pill flex-shrink-0" data-testid="chat-tab-ended">ended</span>
            }
          </button>
          <button
            type="button"
            class="flex flex-shrink-0 items-center px-2 text-[var(--ink-mute)] opacity-0 hover:text-[var(--ink)] group-hover:opacity-100"
            [class.opacity-100]="row.active"
            data-testid="chat-tab-close"
            [attr.aria-label]="'Close tab: ' + row.title"
            (click)="close($event, row.id)"
          >
            <app-icon name="x" class="h-3 w-3" />
          </button>
        </div>
      }
    </div>

    <button
      type="button"
      class="flex flex-shrink-0 items-center justify-center px-3 text-[var(--ink-mute)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-40"
      [disabled]="!chat.canOpenTab()"
      [attr.title]="chat.canOpenTab() ? 'New tab (⌘N)' : maxTabsTooltip"
      data-testid="chat-tabs-new"
      aria-label="Open new chat tab"
      (click)="chat.openTab()"
    >
      <app-icon name="plus" class="h-4 w-4" />
    </button>
  `,
})
export class ChatTabsComponent {
  protected readonly chat = inject(ChatStateService);
  protected readonly maxTabsTooltip = `Maximum ${MAX_CHAT_TABS} tabs`;
  private readonly strip = viewChild.required<ElementRef<HTMLElement>>('strip');
  private readonly revealKey = computed(
    () => `${this.chat.activeTabId()}:${this.chat.tabs().size}`
  );

  /** Scrolls the active tab into view whenever the active tab or the tab count changes. */
  constructor() {
    afterRenderEffect(() => {
      this.revealKey();
      this.revealActiveTab();
    });
  }

  protected readonly tabRows: Signal<readonly ChatTabRow[]> = computed(() => {
    const tabs = this.chat.tabs();
    const activeId = this.chat.activeTabId();
    return Array.from(tabs.entries()).map(([id, store]) => {
      const title = tabTitle(store);
      const streaming = store.isStreamingFromState();
      const ended = store.sessionEnded();
      return {
        id,
        title,
        streaming,
        ended,
        active: id === activeId,
        ariaLabel: tabAriaLabel(title, streaming, ended),
      };
    });
  });

  /**
   * Closes the tab without letting the click bubble into the row's click-to-activate handler.
   * @param event - The close button's click event.
   * @param id - Id of the tab to close.
   */
  protected close(event: Event, id: string): void {
    event.stopPropagation();
    void this.chat.closeTab(id);
  }

  /**
   * Scrolls the strip sideways on a vertical mouse wheel, so a mouse without a horizontal wheel
   * reaches the tabs past the edge; horizontal (trackpad) scrolling and a strip that fits pass.
   * @param event - The strip's wheel event.
   */
  protected scrollStrip(event: WheelEvent): void {
    const strip = this.strip().nativeElement;
    if (strip.scrollWidth <= strip.clientWidth) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    strip.scrollLeft += event.deltaY;
  }

  private revealActiveTab(): void {
    const strip = this.strip().nativeElement;
    const tab = strip.querySelector<HTMLElement>('[data-testid="chat-tab"][data-active="true"]');
    if (!tab) return;
    const view = strip.getBoundingClientRect();
    const rect = tab.getBoundingClientRect();
    if (rect.left < view.left) {
      strip.scrollLeft -= view.left - rect.left;
    } else if (rect.right > view.right) {
      strip.scrollLeft += rect.right - view.right;
    }
  }

  /**
   * Moves the dragged tab to the slot it was dropped on.
   * @param event - The drop list's drop event, carrying the dragged tab's id.
   */
  protected drop(event: CdkDragDrop<unknown, unknown, string>): void {
    this.chat.moveTab(event.item.data, event.currentIndex);
  }
}
