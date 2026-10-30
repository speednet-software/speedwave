import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';

import { TabSwitcherService } from './tab-switcher.service';
import { ChatStateService } from './chat-state.service';
import { WindowFocusService } from './window-focus.service';

const REVEAL_MS = 150;

class FakeChat {
  ids: string[] = ['a', 'b', 'c'];
  readonly activeTabId = signal('a');
  readonly activateTab = vi.fn();
  tabsByRecentUse(): string[] {
    return [...this.ids];
  }
}

describe('TabSwitcherService', () => {
  let chat: FakeChat;
  let focused: WritableSignal<boolean>;
  let switcher: TabSwitcherService;

  beforeEach(() => {
    vi.useFakeTimers();
    chat = new FakeChat();
    focused = signal(true);
    TestBed.configureTestingModule({
      providers: [
        { provide: ChatStateService, useValue: chat },
        { provide: WindowFocusService, useValue: { focused: focused.asReadonly() } },
      ],
    });
    switcher = TestBed.inject(TabSwitcherService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('highlights the previous tab on Ctrl+Tab and the oldest one on Ctrl+Shift+Tab', () => {
    expect(switcher.step(1)).toBe(true);
    expect(switcher.active()).toBe(true);
    expect(switcher.entries()).toEqual(['a', 'b', 'c']);
    expect(switcher.highlighted()).toBe(1);

    switcher.cancel();
    switcher.step(-1);
    expect(switcher.highlighted()).toBe(2);
  });

  it('shows the popup only once Ctrl stays held past the reveal delay', () => {
    switcher.step(1);
    expect(switcher.visible()).toBe(false);

    vi.advanceTimersByTime(REVEAL_MS - 1);
    expect(switcher.visible()).toBe(false);

    vi.advanceTimersByTime(1);
    expect(switcher.visible()).toBe(true);
  });

  it('shows the popup at once on another Tab and wraps around at both ends', () => {
    switcher.step(1);
    switcher.step(1);
    expect(switcher.visible()).toBe(true);
    expect(switcher.highlighted()).toBe(2);

    switcher.step(1);
    expect(switcher.highlighted()).toBe(0);

    switcher.step(-1);
    expect(switcher.highlighted()).toBe(2);
  });

  it('switches to the highlighted tab and closes on commit', () => {
    switcher.step(1);
    switcher.step(1);

    switcher.commit();

    expect(chat.activateTab).toHaveBeenCalledWith('c');
    expect(switcher.active()).toBe(false);
    expect(switcher.visible()).toBe(false);
    expect(switcher.entries()).toEqual([]);
  });

  it('a quick tap switches to the previous tab without ever showing the popup', () => {
    switcher.step(1);
    switcher.commit();
    vi.advanceTimersByTime(REVEAL_MS * 2);

    expect(chat.activateTab).toHaveBeenCalledWith('b');
    expect(switcher.visible()).toBe(false);
  });

  it('switches to a clicked entry, whichever one is highlighted', () => {
    switcher.step(1);

    switcher.commit(2);

    expect(chat.activateTab).toHaveBeenCalledWith('c');
    expect(switcher.active()).toBe(false);
  });

  it('closes without switching on cancel, and the reveal timer no longer fires', () => {
    switcher.step(1);

    switcher.cancel();
    vi.advanceTimersByTime(REVEAL_MS);

    expect(chat.activateTab).not.toHaveBeenCalled();
    expect(switcher.active()).toBe(false);
    expect(switcher.visible()).toBe(false);
  });

  it('cancels a running switch when the window loses focus', () => {
    switcher.step(1);
    switcher.step(1);
    TestBed.tick();

    focused.set(false);
    TestBed.tick();

    expect(switcher.active()).toBe(false);
    expect(switcher.visible()).toBe(false);
    expect(chat.activateTab).not.toHaveBeenCalled();
  });

  it('cancels a running switch when another tab is activated from elsewhere', () => {
    switcher.step(1);
    TestBed.tick();

    chat.activeTabId.set('c');
    TestBed.tick();

    expect(switcher.active()).toBe(false);
    expect(chat.activateTab).not.toHaveBeenCalled();
  });

  it('keeps a switch running while the tab it started from stays active', () => {
    switcher.step(1);
    TestBed.tick();
    switcher.step(1);
    TestBed.tick();

    expect(switcher.active()).toBe(true);
    expect(switcher.highlighted()).toBe(2);
  });

  it('does nothing with fewer than two tabs open', () => {
    chat.ids = ['a'];

    expect(switcher.step(1)).toBe(false);
    expect(switcher.active()).toBe(false);
    vi.advanceTimersByTime(REVEAL_MS);
    expect(switcher.visible()).toBe(false);
  });

  it('keeps the order it started with while the switch runs', () => {
    switcher.step(1);
    chat.ids = ['c', 'b', 'a'];

    switcher.step(1);

    expect(switcher.entries()).toEqual(['a', 'b', 'c']);
    expect(switcher.highlighted()).toBe(2);
  });
});
