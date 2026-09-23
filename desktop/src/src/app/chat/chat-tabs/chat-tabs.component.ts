import { ChangeDetectionStrategy, Component, computed, inject, type Signal } from '@angular/core';
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
}

function truncateTitle(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= TITLE_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, TITLE_MAX_CHARS).trimEnd()}…`;
}

function tabTitle(store: ChatSessionStore): string {
  const firstUser = store.messagesFromState().find((m) => m.role === 'user');
  if (!firstUser) return 'New chat';
  const text = blocksToPlainText(firstUser.blocks);
  return text ? truncateTitle(text) : 'New chat';
}

/**
 * Browser-style tab bar for parallel chat sessions. Reads `ChatStateService.tabs` directly;
 * gating whether the bar is shown at all lives in the parent shell.
 */
@Component({
  selector: 'app-chat-tabs',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block flex-shrink-0' },
  template: `
    <div
      data-testid="chat-tabs"
      class="flex h-11 flex-shrink-0 items-stretch border-b border-[var(--line)] bg-[var(--bg-1)]"
    >
      <div class="flex min-w-0 flex-1 overflow-x-auto" role="tablist" aria-label="Chat tabs">
        @for (row of tabRows(); track row.id) {
          <div
            class="group flex min-w-[110px] max-w-[200px] flex-1 items-stretch border-r border-[var(--line)]"
            [class]="row.active ? 'bg-[var(--bg-2)]' : 'hover-bg'"
            role="tab"
            data-testid="chat-tab"
            [attr.data-active]="row.active ? 'true' : null"
            [attr.aria-selected]="row.active ? 'true' : 'false'"
          >
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-1.5 px-3 text-left"
              data-testid="chat-tab-activate"
              [attr.aria-current]="row.active ? 'true' : null"
              [attr.aria-label]="'Switch to tab: ' + row.title"
              (click)="chat.activateTab(row.id)"
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
        [attr.title]="chat.canOpenTab() ? null : maxTabsTooltip"
        data-testid="chat-tabs-new"
        aria-label="Open new chat tab"
        (click)="chat.openTab()"
      >
        <app-icon name="plus" class="h-4 w-4" />
      </button>
    </div>
  `,
})
export class ChatTabsComponent {
  protected readonly chat = inject(ChatStateService);
  protected readonly maxTabsTooltip = `Maximum ${MAX_CHAT_TABS} tabs`;

  protected readonly tabRows: Signal<readonly ChatTabRow[]> = computed(() => {
    const tabs = this.chat.tabs();
    const activeId = this.chat.activeTabId();
    return Array.from(tabs.entries()).map(([id, store]) => ({
      id,
      title: tabTitle(store),
      streaming: store.isStreamingFromState(),
      ended: store.sessionEnded(),
      active: id === activeId,
    }));
  });

  /**
   * Closes the tab without letting the click bubble into the sibling activate button's row.
   * @param event - The close button's click event.
   * @param id - Id of the tab to close.
   */
  protected close(event: Event, id: string): void {
    event.stopPropagation();
    void this.chat.closeTab(id);
  }
}
