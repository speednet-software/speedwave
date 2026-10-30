import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';

import { ChatTabSwitcherComponent } from './chat-tab-switcher.component';
import { ChatStateService } from '../../services/chat-state.service';
import { TabSwitcherService } from '../../services/tab-switcher.service';
import { WindowFocusService } from '../../services/window-focus.service';
import type { ChatMessage } from '../../models/chat';
import type { ChatSessionEventKind } from '../../models/notifications';

const REVEAL_MS = 150;

class FakeStore {
  readonly messagesFromState = signal<readonly ChatMessage[]>([]);
  readonly isStreamingFromState = signal(false);
  readonly sessionEnded = signal(false);
  readonly unseenEvent = signal<ChatSessionEventKind | null>(null);

  constructor(title: string) {
    this.messagesFromState.set([
      { role: 'user', blocks: [{ type: 'text', content: title }], timestamp: 0 },
    ]);
  }
}

class FakeChatState {
  readonly tabs = signal<ReadonlyMap<string, FakeStore>>(new Map());
  readonly activeTabId = signal('a');
  readonly activateTab = vi.fn((id: string) => this.activeTabId.set(id));

  tabsByRecentUse(): string[] {
    return Array.from(this.tabs().keys());
  }
}

describe('ChatTabSwitcherComponent', () => {
  let fixture: ComponentFixture<ChatTabSwitcherComponent>;
  let chat: FakeChatState;
  let switcher: TabSwitcherService;

  function popup(): HTMLElement | null {
    return fixture.nativeElement.querySelector('[data-testid="chat-tab-switcher"]');
  }

  function rows(): HTMLElement[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="chat-tab-switcher-row"]')
    );
  }

  function titleOf(row: HTMLElement): string {
    return (row.querySelector('[data-testid="chat-tab-title"]') as HTMLElement).textContent!.trim();
  }

  function mousedown(target: Element): MouseEvent {
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, ctrlKey: true });
    target.dispatchEvent(event);
    return event;
  }

  function announcement(): string {
    return fixture.nativeElement
      .querySelector('[data-testid="chat-tab-switcher-announcement"]')
      .textContent.trim();
  }

  function open(): void {
    switcher.step(1);
    vi.advanceTimersByTime(REVEAL_MS);
    fixture.detectChanges();
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    chat = new FakeChatState();
    chat.tabs.set(
      new Map([
        ['a', new FakeStore('alpha')],
        ['b', new FakeStore('beta')],
        ['c', new FakeStore('gamma')],
      ])
    );
    await TestBed.configureTestingModule({
      imports: [ChatTabSwitcherComponent],
      providers: [
        { provide: ChatStateService, useValue: chat },
        { provide: WindowFocusService, useValue: { focused: signal(true).asReadonly() } },
      ],
    }).compileComponents();
    switcher = TestBed.inject(TabSwitcherService);
    fixture = TestBed.createComponent(ChatTabSwitcherComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing until the switcher shows', () => {
    expect(popup()).toBeNull();

    switcher.step(1);
    fixture.detectChanges();
    expect(popup()).toBeNull();

    vi.advanceTimersByTime(REVEAL_MS);
    fixture.detectChanges();
    expect(popup()).not.toBeNull();
  });

  it('lists the tabs in switcher order with the highlighted one selected', () => {
    open();

    expect(rows().map(titleOf)).toEqual(['alpha', 'beta', 'gamma']);
    expect(rows().map((r) => r.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(popup()?.getAttribute('role')).toBe('listbox');

    switcher.step(1);
    fixture.detectChanges();
    expect(rows()[2].getAttribute('aria-selected')).toBe('true');
    expect(rows()[2].classList.contains('bg-[var(--bg-3)]')).toBe(true);
  });

  it('shows a tab with an unseen event bold, with its dot and its tooltip', () => {
    chat.tabs().get('c')!.unseenEvent.set('session_error');
    open();

    const marked = rows()[2];
    const title = marked.querySelector('[data-testid="chat-tab-title"]') as HTMLElement;
    expect(title.classList.contains('font-bold')).toBe(true);
    expect(marked.querySelector('[data-testid="chat-tab-unseen"]')?.getAttribute('data-kind')).toBe(
      'session_error'
    );
    expect(marked.getAttribute('title')).toBe('Error');
    expect(marked.getAttribute('aria-label')).toBe('Switch to tab: gamma, error');
  });

  it('switches to a row on the Ctrl+click that presses it, and closes', () => {
    open();

    const event = mousedown(rows()[2]);
    fixture.detectChanges();

    expect(chat.activateTab).toHaveBeenCalledWith('c');
    expect(event.defaultPrevented).toBe(true);
    expect(popup()).toBeNull();
  });

  it('keeps the context menu of a Ctrl+click from opening over the popup', () => {
    open();

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    rows()[1].dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('cancels the switch on a mouse press outside the popup', () => {
    open();

    mousedown(document.body);
    fixture.detectChanges();

    expect(switcher.active()).toBe(false);
    expect(chat.activateTab).not.toHaveBeenCalled();
    expect(popup()).toBeNull();
  });

  it('cancels on a mouse press outside before the popup shows', () => {
    switcher.step(1);

    mousedown(document.body);

    expect(switcher.active()).toBe(false);
  });

  it('announces the highlighted tab while the popup shows', () => {
    switcher.step(1);
    fixture.detectChanges();
    expect(announcement()).toBe('');

    vi.advanceTimersByTime(REVEAL_MS);
    fixture.detectChanges();
    expect(announcement()).toBe('Switch to tab: beta');

    switcher.step(1);
    fixture.detectChanges();
    expect(announcement()).toBe('Switch to tab: gamma');

    switcher.cancel();
    fixture.detectChanges();
    expect(announcement()).toBe('');
  });

  it('leaves out a tab closed while the switcher shows, keeping the others selectable', () => {
    open();
    const tabs = new Map(chat.tabs());
    tabs.delete('b');
    chat.tabs.set(tabs);
    fixture.detectChanges();

    expect(rows().map(titleOf)).toEqual(['alpha', 'gamma']);

    mousedown(rows()[1]);
    expect(chat.activateTab).toHaveBeenCalledWith('c');
  });
});
