import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ChatTabsComponent } from './chat-tabs.component';
import { ChatStateService } from '../../services/chat-state.service';
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
    expect(plus.title).toBe('Maximum 3 tabs');
  });

  it('leaves the plus button enabled with no tooltip below the cap', () => {
    const store = new FakeStore();
    chat.setTabs([['t1', store]]);
    chat.setCanOpenTab(true);
    fixture.detectChanges();

    const plus = fixture.nativeElement.querySelector(
      '[data-testid="chat-tabs-new"]'
    ) as HTMLButtonElement;
    expect(plus.disabled).toBe(false);
    expect(plus.title).toBe('');
  });

  it('exposes tab semantics for accessibility (role, aria-selected, labels)', () => {
    const store = new FakeStore();
    chat.setTabs([['t1', store]]);
    chat.setActive('t1');
    fixture.detectChanges();

    const tab = tabEls()[0];
    expect(tab.getAttribute('role')).toBe('tab');
    expect(tab.getAttribute('aria-selected')).toBe('true');
    const closeBtn = tab.querySelector('[data-testid="chat-tab-close"]') as HTMLElement;
    expect(closeBtn.getAttribute('aria-label')).toBeTruthy();
    const plus = fixture.nativeElement.querySelector(
      '[data-testid="chat-tabs-new"]'
    ) as HTMLElement;
    expect(plus.getAttribute('aria-label')).toBeTruthy();
  });

  it('renders Unicode titles verbatim without over-truncating', () => {
    const store = new FakeStore();
    store.setMessages([userMessage('日本語 テスト')]);
    chat.setTabs([['t1', store]]);
    fixture.detectChanges();

    expect(titleFor(tabEls()[0])).toBe('日本語 テスト');
  });
});
