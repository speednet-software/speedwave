import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { CdkDrag, CdkDropList, type CdkDragDrop } from '@angular/cdk/drag-drop';
import { ChatTabsComponent } from './chat-tabs.component';
import { ChatStateService, MAX_CHAT_TABS } from '../../services/chat-state.service';
import type { ChatMessage } from '../../models/chat';

class FakeStore {
  private readonly _messages = signal<readonly ChatMessage[]>([]);
  private readonly _streaming = signal(false);
  private readonly _ended = signal(false);
  readonly messagesFromState = this._messages.asReadonly();
  readonly isStreamingFromState = this._streaming.asReadonly();
  readonly sessionEnded = this._ended.asReadonly();

  setMessages(msgs: readonly ChatMessage[]): void {
    this._messages.set(msgs);
  }
  setStreaming(v: boolean): void {
    this._streaming.set(v);
  }
  setEnded(v: boolean): void {
    this._ended.set(v);
  }
}

function userMessage(text: string): ChatMessage {
  return { role: 'user', blocks: [{ type: 'text', content: text }], timestamp: 0 };
}

class FakeChatState {
  private readonly _tabs = signal<ReadonlyMap<string, FakeStore>>(new Map());
  private readonly _activeTabId = signal('t1');
  private readonly _canOpenTab = signal(true);

  readonly tabs = this._tabs.asReadonly();
  readonly activeTabId = this._activeTabId.asReadonly();
  readonly canOpenTab = this._canOpenTab.asReadonly();

  readonly openTab = vi.fn().mockResolvedValue('new-tab-id');
  readonly closeTab = vi.fn().mockResolvedValue(undefined);
  readonly activateTab = vi.fn((id: string) => this._activeTabId.set(id));
  readonly moveTab = vi.fn();

  setTabs(entries: readonly (readonly [string, FakeStore])[]): void {
    this._tabs.set(new Map(entries));
  }
  setActive(id: string): void {
    this._activeTabId.set(id);
  }
  setCanOpenTab(v: boolean): void {
    this._canOpenTab.set(v);
  }
}

describe('ChatTabsComponent', () => {
  let fixture: ComponentFixture<ChatTabsComponent>;
  let chat: FakeChatState;

  function tabEls(): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('[data-testid="chat-tab"]'));
  }

  function stripEl(): HTMLElement {
    return fixture.nativeElement.querySelector('[data-testid="chat-tabs-strip"]') as HTMLElement;
  }

  function titleFor(tabEl: HTMLElement): string {
    return (
      tabEl.querySelector('[data-testid="chat-tab-title"]') as HTMLElement
    ).textContent!.trim();
  }

  beforeEach(async () => {
    chat = new FakeChatState();
    await TestBed.configureTestingModule({
      imports: [ChatTabsComponent],
      providers: [{ provide: ChatStateService, useValue: chat }],
    }).compileComponents();

    fixture = TestBed.createComponent(ChatTabsComponent);
  });

  it('renders one tab per entry in insertion order', () => {
    const s1 = new FakeStore();
    const s2 = new FakeStore();
    const s3 = new FakeStore();
    s1.setMessages([userMessage('first')]);
    s2.setMessages([userMessage('second')]);
    chat.setTabs([
      ['t3', s3],
      ['t1', s1],
      ['t2', s2],
    ]);
    fixture.detectChanges();

    const tabs = tabEls();
    expect(tabs).toHaveLength(3);
    expect(titleFor(tabs[0])).toBe('New chat');
    expect(titleFor(tabs[1])).toBe('first');
    expect(titleFor(tabs[2])).toBe('second');
  });

  it('falls back to "New chat" when the store has no user message', () => {
    const store = new FakeStore();
    chat.setTabs([['t1', store]]);
    fixture.detectChanges();

    expect(titleFor(tabEls()[0])).toBe('New chat');
  });

  it('truncates a long first user message to ~24 chars with an ellipsis', () => {
    const store = new FakeStore();
    store.setMessages([userMessage('this is a very long first message that overflows')]);
    chat.setTabs([['t1', store]]);
    fixture.detectChanges();

    const title = titleFor(tabEls()[0]);
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(25);
  });

  it('truncates by code points so a surrogate pair at the boundary is never split', () => {
    const store = new FakeStore();
    store.setMessages([userMessage('😀'.repeat(30))]);
    chat.setTabs([['t1', store]]);
    fixture.detectChanges();

    const title = titleFor(tabEls()[0]);
    const points = Array.from(title);
    expect(points).toHaveLength(25);
    expect(points.slice(0, 24).every((p) => p === '😀')).toBe(true);
    expect(points[24]).toBe('…');
  });

  it('falls back to "New chat" when the first user message has no text block', () => {
    const store = new FakeStore();
    store.setMessages([
      { role: 'user', blocks: [{ type: 'image', media_type: 'image/png' }], timestamp: 0 },
    ]);
    chat.setTabs([['t1', store]]);
    fixture.detectChanges();

    expect(titleFor(tabEls()[0])).toBe('New chat');
  });

  it('marks the active tab and updates it via activateTab', () => {
    const s1 = new FakeStore();
    const s2 = new FakeStore();
    chat.setTabs([
      ['t1', s1],
      ['t2', s2],
    ]);
    chat.setActive('t1');
    fixture.detectChanges();

    const tabs = tabEls();
    expect(tabs[0].getAttribute('data-active')).toBe('true');
    expect(tabs[1].getAttribute('data-active')).toBeNull();

    chat.setActive('t2');
    fixture.detectChanges();

    const refreshed = tabEls();
    expect(refreshed[0].getAttribute('data-active')).toBeNull();
    expect(refreshed[1].getAttribute('data-active')).toBe('true');
  });

  it('clicking a tab activates it via the facade', () => {
    const s1 = new FakeStore();
    const s2 = new FakeStore();
    chat.setTabs([
      ['t1', s1],
      ['t2', s2],
    ]);
    chat.setActive('t1');
    fixture.detectChanges();

    const activateBtn = tabEls()[1].querySelector(
      '[data-testid="chat-tab-activate"]'
    ) as HTMLButtonElement;
    activateBtn.click();

    expect(chat.activateTab).toHaveBeenCalledWith('t2');
  });

  it('clicking the row body activates the tab', () => {
    const s1 = new FakeStore();
    const s2 = new FakeStore();
    chat.setTabs([
      ['t1', s1],
      ['t2', s2],
    ]);
    chat.setActive('t1');
    fixture.detectChanges();

    tabEls()[1].click();

    expect(chat.activateTab).toHaveBeenCalledWith('t2');
  });

  it('clicking the close button closes the tab without activating it', () => {
    const s1 = new FakeStore();
    const s2 = new FakeStore();
    chat.setTabs([
      ['t1', s1],
      ['t2', s2],
    ]);
    chat.setActive('t1');
    fixture.detectChanges();

    const closeBtn = tabEls()[1].querySelector(
      '[data-testid="chat-tab-close"]'
    ) as HTMLButtonElement;
    closeBtn.click();

    expect(chat.closeTab).toHaveBeenCalledWith('t2');
    expect(chat.activateTab).not.toHaveBeenCalledWith('t2');
  });

  it('moves a dropped tab to the slot it was dropped on', () => {
    chat.setTabs([
      ['t1', new FakeStore()],
      ['t2', new FakeStore()],
      ['t3', new FakeStore()],
    ]);
    fixture.detectChanges();
    const list = fixture.debugElement.query(By.directive(CdkDropList)).injector.get(CdkDropList);
    const drags = fixture.debugElement
      .queryAll(By.directive(CdkDrag))
      .map((el) => el.injector.get(CdkDrag<string>));

    list.dropped.emit({
      item: drags[2],
      currentIndex: 0,
    } as CdkDragDrop<unknown, unknown, string>);

    expect(chat.moveTab).toHaveBeenCalledWith('t3', 0);
  });

  it('makes every tab draggable along the strip only', () => {
    chat.setTabs([
      ['t1', new FakeStore()],
      ['t2', new FakeStore()],
    ]);
    fixture.detectChanges();
    const list = fixture.debugElement.query(By.directive(CdkDropList)).injector.get(CdkDropList);
    const drags = fixture.debugElement
      .queryAll(By.directive(CdkDrag))
      .map((el) => el.injector.get(CdkDrag<string>));

    expect(list.orientation).toBe('horizontal');
    expect(list.lockAxis).toBe('x');
    expect(drags.map((d) => d.data)).toEqual(['t1', 't2']);
    expect(drags.map((d) => d.element.nativeElement)).toEqual(tabEls());
  });

  it('shows the close button on the active tab without hover', () => {
    const s1 = new FakeStore();
    chat.setTabs([['t1', s1]]);
    chat.setActive('t1');
    fixture.detectChanges();

    const closeBtn = tabEls()[0].querySelector('[data-testid="chat-tab-close"]') as HTMLElement;
    expect(closeBtn.classList.contains('opacity-100')).toBe(true);
  });

  it('shows a streaming indicator only while the store is streaming', () => {
    const store = new FakeStore();
    chat.setTabs([['t1', store]]);
    fixture.detectChanges();

    expect(tabEls()[0].querySelector('[data-testid="chat-tab-streaming"]')).toBeNull();

    store.setStreaming(true);
    fixture.detectChanges();

    expect(tabEls()[0].querySelector('[data-testid="chat-tab-streaming"]')).not.toBeNull();
  });

  it('shows an ended badge when the session has ended', () => {
    const store = new FakeStore();
    chat.setTabs([['t1', store]]);
    fixture.detectChanges();

    expect(tabEls()[0].querySelector('[data-testid="chat-tab-ended"]')).toBeNull();

    store.setEnded(true);
    fixture.detectChanges();

    expect(tabEls()[0].querySelector('[data-testid="chat-tab-ended"]')).not.toBeNull();
  });

  it('opens a new tab when the plus button is clicked', () => {
    const store = new FakeStore();
    chat.setTabs([['t1', store]]);
    fixture.detectChanges();

    const plus = fixture.nativeElement.querySelector(
      '[data-testid="chat-tabs-new"]'
    ) as HTMLButtonElement;
    plus.click();

    expect(chat.openTab).toHaveBeenCalled();
  });

  it('disables the plus button at the tab cap and shows a tooltip', () => {
    const store = new FakeStore();
    chat.setTabs([['t1', store]]);
    chat.setCanOpenTab(false);
    fixture.detectChanges();

    const plus = fixture.nativeElement.querySelector(
      '[data-testid="chat-tabs-new"]'
    ) as HTMLButtonElement;
    expect(plus.disabled).toBe(true);
    expect(plus.title).toBe(`Maximum ${MAX_CHAT_TABS} tabs`);
  });

  it('leaves the plus button enabled with a "New tab (⌘N)" tooltip below the cap', () => {
    const store = new FakeStore();
    chat.setTabs([['t1', store]]);
    chat.setCanOpenTab(true);
    fixture.detectChanges();

    const plus = fixture.nativeElement.querySelector(
      '[data-testid="chat-tabs-new"]'
    ) as HTMLButtonElement;
    expect(plus.disabled).toBe(false);
    expect(plus.title).toBe('New tab (⌘N)');
  });

  it('exposes tab semantics for accessibility (role on the focusable button, labels)', () => {
    const store = new FakeStore();
    chat.setTabs([['t1', store]]);
    chat.setActive('t1');
    fixture.detectChanges();

    const tab = tabEls()[0];
    expect(tab.getAttribute('role')).toBe('presentation');
    const activateBtn = tab.querySelector('[data-testid="chat-tab-activate"]') as HTMLElement;
    expect(activateBtn.getAttribute('role')).toBe('tab');
    expect(activateBtn.getAttribute('aria-selected')).toBe('true');
    expect(activateBtn.getAttribute('aria-label')).toBe('Switch to tab: New chat');
    const closeBtn = tab.querySelector('[data-testid="chat-tab-close"]') as HTMLElement;
    expect(closeBtn.getAttribute('aria-label')).toBeTruthy();
    const plus = fixture.nativeElement.querySelector(
      '[data-testid="chat-tabs-new"]'
    ) as HTMLElement;
    expect(plus.getAttribute('aria-label')).toBeTruthy();
  });

  it('folds the streaming state into the tab button aria-label', () => {
    const store = new FakeStore();
    chat.setTabs([['t1', store]]);
    fixture.detectChanges();

    const activateBtn = () =>
      tabEls()[0].querySelector('[data-testid="chat-tab-activate"]') as HTMLElement;
    expect(activateBtn().getAttribute('aria-label')).toBe('Switch to tab: New chat');

    store.setStreaming(true);
    fixture.detectChanges();

    expect(activateBtn().getAttribute('aria-label')).toBe('Switch to tab: New chat, streaming');
  });

  it('folds the ended state into the tab button aria-label, taking priority over streaming', () => {
    const store = new FakeStore();
    chat.setTabs([['t1', store]]);
    store.setStreaming(true);
    store.setEnded(true);
    fixture.detectChanges();

    const activateBtn = tabEls()[0].querySelector(
      '[data-testid="chat-tab-activate"]'
    ) as HTMLElement;
    expect(activateBtn.getAttribute('aria-label')).toBe('Switch to tab: New chat, session ended');
  });

  it('gives the active tab a visibly darker background than an inactive tab', () => {
    const s1 = new FakeStore();
    const s2 = new FakeStore();
    chat.setTabs([
      ['t1', s1],
      ['t2', s2],
    ]);
    chat.setActive('t1');
    fixture.detectChanges();

    const tabs = tabEls();
    expect(tabs[0].classList.contains('bg-[var(--bg-3)]')).toBe(true);
    expect(tabs[1].classList.contains('bg-[var(--bg-3)]')).toBe(false);
    expect(tabs[1].classList.contains('hover-bg')).toBe(true);
  });

  it('marks an inactive tab unselected on its tab button', () => {
    const s1 = new FakeStore();
    const s2 = new FakeStore();
    chat.setTabs([
      ['t1', s1],
      ['t2', s2],
    ]);
    chat.setActive('t1');
    fixture.detectChanges();

    const inactiveBtn = tabEls()[1].querySelector(
      '[data-testid="chat-tab-activate"]'
    ) as HTMLElement;
    expect(inactiveBtn.getAttribute('aria-selected')).toBe('false');
  });

  it('carries the overflow layout classes (container scrolls, tabs shrink)', () => {
    const store = new FakeStore();
    chat.setTabs([['t1', store]]);
    fixture.detectChanges();

    const tablist = fixture.nativeElement.querySelector('[role="tablist"]') as HTMLElement;
    expect(tablist.classList.contains('overflow-x-auto')).toBe(true);
    expect(tablist.classList.contains('min-w-0')).toBe(true);
    const tab = tabEls()[0];
    expect(tab.classList.contains('min-w-[110px]')).toBe(true);
    expect(tab.classList.contains('max-w-[200px]')).toBe(true);
  });

  it('keeps the plus button outside the scrolling strip, pinned right after it', () => {
    chat.setTabs(
      Array.from({ length: MAX_CHAT_TABS }, (_, i) => [`t${i}`, new FakeStore()] as const)
    );
    fixture.detectChanges();

    const strip = stripEl();
    const plus = fixture.nativeElement.querySelector(
      '[data-testid="chat-tabs-new"]'
    ) as HTMLElement;
    expect(strip.contains(plus)).toBe(false);
    expect(strip.nextElementSibling).toBe(plus);
    expect(plus.classList.contains('flex-shrink-0')).toBe(true);
    expect(tabEls()).toHaveLength(MAX_CHAT_TABS);
    expect(tabEls().every((tab) => strip.contains(tab))).toBe(true);
  });

  it('hides the strip scrollbar so it never eats into the header row', () => {
    chat.setTabs([['t1', new FakeStore()]]);
    fixture.detectChanges();

    expect(stripEl().classList.contains('tab-strip')).toBe(true);
  });

  describe('overflowing strip', () => {
    let scrollLeft: number;

    function overflow(strip: HTMLElement, scrollWidth: number, clientWidth: number): void {
      scrollLeft = 0;
      Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: scrollWidth });
      Object.defineProperty(strip, 'clientWidth', { configurable: true, value: clientWidth });
      Object.defineProperty(strip, 'scrollLeft', {
        configurable: true,
        get: () => scrollLeft,
        set: (v: number) => (scrollLeft = v),
      });
    }

    function wheel(deltaX: number, deltaY: number): WheelEvent {
      const event = new WheelEvent('wheel', { deltaX, deltaY, cancelable: true });
      stripEl().dispatchEvent(event);
      return event;
    }

    function rect(left: number, right: number): DOMRect {
      return { left, right, top: 0, bottom: 44, width: right - left, height: 44 } as DOMRect;
    }

    beforeEach(() => {
      chat.setTabs([
        ['t1', new FakeStore()],
        ['t2', new FakeStore()],
        ['t3', new FakeStore()],
      ]);
      chat.setActive('t1');
      fixture.detectChanges();
    });

    it('turns a vertical mouse wheel into a sideways scroll', () => {
      overflow(stripEl(), 600, 300);

      const event = wheel(0, 120);

      expect(scrollLeft).toBe(120);
      expect(event.defaultPrevented).toBe(true);
    });

    it('leaves a horizontal (trackpad) wheel to the browser', () => {
      overflow(stripEl(), 600, 300);

      const event = wheel(80, 10);

      expect(scrollLeft).toBe(0);
      expect(event.defaultPrevented).toBe(false);
    });

    it('leaves the wheel alone while every tab fits', () => {
      overflow(stripEl(), 300, 300);

      const event = wheel(0, 120);

      expect(scrollLeft).toBe(0);
      expect(event.defaultPrevented).toBe(false);
    });

    it('scrolls a newly activated tab past the right edge into view', async () => {
      const strip = stripEl();
      overflow(strip, 600, 300);
      strip.getBoundingClientRect = () => rect(100, 400);
      tabEls()[2].getBoundingClientRect = () => rect(420, 530);

      chat.setActive('t3');
      fixture.detectChanges();
      await fixture.whenStable();

      expect(scrollLeft).toBe(130);
    });

    it('scrolls a newly activated tab past the left edge into view', async () => {
      const strip = stripEl();
      overflow(strip, 600, 300);
      scrollLeft = 200;
      strip.getBoundingClientRect = () => rect(100, 400);
      tabEls()[1].getBoundingClientRect = () => rect(40, 150);

      chat.setActive('t2');
      fixture.detectChanges();
      await fixture.whenStable();

      expect(scrollLeft).toBe(140);
    });

    it('does not move a strip whose active tab is already visible', async () => {
      const strip = stripEl();
      overflow(strip, 600, 300);
      scrollLeft = 50;
      strip.getBoundingClientRect = () => rect(100, 400);
      tabEls()[1].getBoundingClientRect = () => rect(210, 320);

      chat.setActive('t2');
      fixture.detectChanges();
      await fixture.whenStable();

      expect(scrollLeft).toBe(50);
    });

    it('does not pull the strip back to the active tab when only a tab title or streaming state changes', async () => {
      const strip = stripEl();
      overflow(strip, 600, 300);
      scrollLeft = 250;
      strip.getBoundingClientRect = () => rect(100, 400);
      tabEls()[0].getBoundingClientRect = () => rect(-150, -40);

      (chat.tabs().get('t2') as FakeStore).setStreaming(true);
      fixture.detectChanges();
      await fixture.whenStable();

      expect(scrollLeft).toBe(250);
    });
  });

  it('renders Unicode titles verbatim without over-truncating', () => {
    const store = new FakeStore();
    store.setMessages([userMessage('日本語 テスト')]);
    chat.setTabs([['t1', store]]);
    fixture.detectChanges();

    expect(titleFor(tabEls()[0])).toBe('日本語 テスト');
  });

  it('does not force the tab list to fill the header row, so the plus button hugs the last tab', () => {
    const store = new FakeStore();
    chat.setTabs([['t1', store]]);
    fixture.detectChanges();

    const tablist = fixture.nativeElement.querySelector('[role="tablist"]') as HTMLElement;
    expect(tablist.classList.contains('flex-1')).toBe(false);
  });

  it('carries host classes that shrink-then-scroll as an inline flex child of the header row', () => {
    const store = new FakeStore();
    chat.setTabs([['t1', store]]);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.classList.contains('flex-1')).toBe(true);
    expect(host.classList.contains('min-w-0')).toBe(true);
    expect(host.getAttribute('data-testid')).toBe('chat-tabs');
  });
});
