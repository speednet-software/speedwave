import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
} from '@angular/core';

import { ChatStateService } from '../../services/chat-state.service';
import { TabSwitcherService } from '../../services/tab-switcher.service';
import { ChatTabLabelComponent } from './chat-tab-label.component';
import { chatTabRow, type ChatTabRow } from './chat-tab-row';

interface SwitcherItem {
  readonly index: number;
  readonly row: ChatTabRow;
}

/**
 * The Ctrl+Tab popup at the top-left of the chat, under the tab strip: the open tabs, the most
 * recently active first, with the one Ctrl's release switches to highlighted.
 */
@Component({
  selector: 'app-chat-tab-switcher',
  imports: [ChatTabLabelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'relative block h-0' },
  template: `
    <div class="sr-only" aria-live="polite" data-testid="chat-tab-switcher-announcement">
      {{ announcement() }}
    </div>
    @if (switcher.visible()) {
      <div
        class="absolute left-3 top-2 z-30 w-64 rounded border border-[var(--line-strong)] bg-[var(--bg-1)] py-1 shadow-lg"
        role="listbox"
        aria-label="Switch chat tab"
        data-testid="chat-tab-switcher"
        (contextmenu)="$event.preventDefault()"
      >
        @for (item of items(); track item.row.id) {
          <button
            type="button"
            class="flex w-full cursor-pointer items-center px-3 py-1.5 text-left"
            [class]="item.index === switcher.highlighted() ? 'bg-[var(--bg-3)]' : 'hover-bg'"
            role="option"
            tabindex="-1"
            [attr.aria-selected]="item.index === switcher.highlighted() ? 'true' : 'false'"
            [attr.aria-label]="item.row.ariaLabel"
            [attr.title]="item.row.tooltip"
            data-testid="chat-tab-switcher-row"
            (mousedown)="pick($event, item.index)"
          >
            <app-chat-tab-label [row]="item.row" [emphasized]="true" />
          </button>
        }
      </div>
    }
  `,
})
export class ChatTabSwitcherComponent {
  protected readonly switcher = inject(TabSwitcherService);
  private readonly chat = inject(ChatStateService);

  protected readonly items = computed<readonly SwitcherItem[]>(() => {
    const tabs = this.chat.tabs();
    const activeId = this.chat.activeTabId();
    return this.switcher.entries().flatMap((id, index) => {
      const store = tabs.get(id);
      return store ? [{ index, row: chatTabRow(id, store, id === activeId) }] : [];
    });
  });

  protected readonly announcement = computed(() => {
    if (!this.switcher.visible()) return '';
    const highlighted = this.switcher.highlighted();
    return this.items().find((item) => item.index === highlighted)?.row.ariaLabel ?? '';
  });

  /** Cancels a running switch on a mouse press outside the popup. */
  constructor() {
    const host: HTMLElement = inject(ElementRef).nativeElement;
    const document = inject(DOCUMENT);
    const cancelOutside = (event: MouseEvent): void => {
      if (this.switcher.active() && !host.contains(event.target as Node)) this.switcher.cancel();
    };
    document.addEventListener('mousedown', cancelOutside, true);
    inject(DestroyRef).onDestroy(() =>
      document.removeEventListener('mousedown', cancelOutside, true)
    );
  }

  protected pick(event: MouseEvent, index: number): void {
    event.preventDefault();
    this.switcher.commit(index);
  }
}
