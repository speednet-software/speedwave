import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { WindowFocusService } from './window-focus.service';
import { TauriService } from './tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';

describe('WindowFocusService', () => {
  let mockTauri: MockTauriService;
  let service: WindowFocusService;

  function setVisibility(state: DocumentVisibilityState): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  beforeEach(() => {
    mockTauri = new MockTauriService();
    TestBed.configureTestingModule({ providers: [{ provide: TauriService, useValue: mockTauri }] });
    service = TestBed.inject(WindowFocusService);
  });

  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState');
    vi.restoreAllMocks();
  });

  it('follows the window losing and regaining focus', () => {
    window.dispatchEvent(new Event('focus'));
    expect(service.focused()).toBe(true);

    window.dispatchEvent(new Event('blur'));
    expect(service.focused()).toBe(false);

    window.dispatchEvent(new Event('focus'));
    expect(service.focused()).toBe(true);
  });

  it('re-reads the focus on the backend focus event, so a late one cannot undo a blur', () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    setVisibility('visible');
    window.dispatchEvent(new Event('blur'));
    expect(service.focused()).toBe(false);

    mockTauri.dispatchEvent('window_focused', null);
    expect(service.focused()).toBe(true);

    window.dispatchEvent(new Event('blur'));
    hasFocus.mockReturnValue(false);
    mockTauri.dispatchEvent('window_focused', null);
    expect(service.focused()).toBe(false);
  });

  it('counts a hidden document as unfocused and a visible one by its focus', () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));

    setVisibility('hidden');
    expect(service.focused()).toBe(false);

    setVisibility('visible');
    expect(service.focused()).toBe(true);

    hasFocus.mockReturnValue(false);
    setVisibility('visible');
    expect(service.focused()).toBe(false);
  });

  it('stops following the window and the backend once destroyed', async () => {
    window.dispatchEvent(new Event('focus'));

    TestBed.resetTestingModule();
    await Promise.resolve();
    window.dispatchEvent(new Event('blur'));

    expect(service.focused()).toBe(true);
    expect(mockTauri.listenHandlers['window_focused']).toBeUndefined();
  });
});
