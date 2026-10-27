import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { NotificationsSectionComponent } from './notifications-section.component';
import { TauriService } from '../../services/tauri.service';
import { NotificationsService } from '../../services/notifications.service';
import { MockTauriService } from '../../testing/mock-tauri.service';
import { createDeferred } from '../../testing/deferred';
import type {
  NotificationPermission,
  NotificationPrefs,
  NotificationSettings,
} from '../../models/notifications';

const ALL_ON: NotificationPrefs = {
  enabled: true,
  turn_finished: true,
  awaiting_input: true,
  session_error: true,
};

describe('NotificationsSectionComponent', () => {
  let fixture: ComponentFixture<NotificationsSectionComponent>;
  let component: NotificationsSectionComponent;
  let mockTauri: MockTauriService;
  let platform: string;
  let svc: {
    settings: ReturnType<typeof vi.fn>;
    setPrefs: ReturnType<typeof vi.fn>;
    requestPermission: ReturnType<typeof vi.fn>;
    openSystemSettings: ReturnType<typeof vi.fn>;
  };

  function serve(permission: NotificationPermission, prefs: NotificationPrefs = ALL_ON): void {
    svc.settings.mockResolvedValue({ prefs, permission } satisfies NotificationSettings);
  }

  async function render(): Promise<HTMLElement> {
    fixture = TestBed.createComponent(NotificationsSectionComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await settle();
    return fixture.nativeElement as HTMLElement;
  }

  function toggle(el: HTMLElement, testId: string): HTMLInputElement {
    return el.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement;
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
  }

  function flip(box: HTMLInputElement, on: boolean): void {
    box.checked = on;
    box.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  beforeEach(async () => {
    mockTauri = new MockTauriService();
    platform = 'macos';
    mockTauri.invokeHandler = async (cmd) => (cmd === 'get_platform' ? platform : undefined);
    svc = {
      settings: vi.fn(),
      setPrefs: vi.fn().mockResolvedValue(undefined),
      requestPermission: vi.fn(),
      openSystemSettings: vi.fn().mockResolvedValue(undefined),
    };
    serve('granted');
    await TestBed.configureTestingModule({
      imports: [NotificationsSectionComponent],
      providers: [
        { provide: TauriService, useValue: mockTauri },
        { provide: NotificationsService, useValue: svc },
      ],
    }).compileComponents();
  });

  it('shows the stored switches and an allowed permission without an action', async () => {
    serve('granted', { ...ALL_ON, awaiting_input: false });
    const el = await render();

    expect(toggle(el, 'notifications-enabled-toggle').checked).toBe(true);
    expect(toggle(el, 'notifications-turn_finished-toggle').checked).toBe(true);
    expect(toggle(el, 'notifications-awaiting_input-toggle').checked).toBe(false);
    expect(toggle(el, 'notifications-session_error-toggle').checked).toBe(true);
    expect(
      el.querySelector('[data-testid="notification-permission-state"]')?.textContent
    ).toContain('Allowed.');
    expect(el.querySelector('[data-testid="request-notification-permission"]')).toBeNull();
    expect(el.querySelector('[data-testid="open-notification-settings"]')).toBeNull();
  });

  it('stores every switch when one changes', async () => {
    const el = await render();

    flip(toggle(el, 'notifications-session_error-toggle'), false);
    await settle();

    expect(svc.setPrefs).toHaveBeenCalledWith({ ...ALL_ON, session_error: false });
    expect(component.prefs()).toEqual({ ...ALL_ON, session_error: false });
  });

  it('disables the event switches while the master switch is off', async () => {
    serve('granted', { ...ALL_ON, enabled: false });
    const el = await render();

    expect(toggle(el, 'notifications-turn_finished-toggle').disabled).toBe(true);
    expect(toggle(el, 'notifications-awaiting_input-toggle').disabled).toBe(true);
    expect(toggle(el, 'notifications-session_error-toggle').disabled).toBe(true);
  });

  it('saves a toggle made during a save after it, with both changes', async () => {
    const first = createDeferred();
    svc.setPrefs.mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const el = await render();

    flip(toggle(el, 'notifications-turn_finished-toggle'), false);
    await settle();
    flip(toggle(el, 'notifications-awaiting_input-toggle'), false);
    await settle();

    expect(svc.setPrefs).toHaveBeenCalledTimes(1);
    expect(svc.setPrefs).toHaveBeenLastCalledWith({ ...ALL_ON, turn_finished: false });

    first.resolve();
    await settle();

    expect(svc.setPrefs).toHaveBeenCalledTimes(2);
    expect(svc.setPrefs).toHaveBeenLastCalledWith({
      ...ALL_ON,
      turn_finished: false,
      awaiting_input: false,
    });
    expect(component.prefs()).toEqual({ ...ALL_ON, turn_finished: false, awaiting_input: false });
  });

  it('reports a failed save and shows the switches stored on disk', async () => {
    svc.setPrefs.mockRejectedValue(new Error('config locked'));
    const errors: string[] = [];
    const el = await render();
    component.errorOccurred.subscribe((m) => errors.push(m));
    serve('granted', { ...ALL_ON, session_error: false });

    flip(toggle(el, 'notifications-enabled-toggle'), false);
    await settle();

    expect(errors).toEqual(['config locked']);
    expect(component.prefs()).toEqual({ ...ALL_ON, session_error: false });
    expect(toggle(el, 'notifications-enabled-toggle').checked).toBe(true);
  });

  it('folds toggles made in one burst into one save', async () => {
    const el = await render();

    flip(toggle(el, 'notifications-turn_finished-toggle'), false);
    flip(toggle(el, 'notifications-awaiting_input-toggle'), false);
    await settle();

    expect(svc.setPrefs).toHaveBeenCalledTimes(1);
    expect(svc.setPrefs).toHaveBeenLastCalledWith({
      ...ALL_ON,
      turn_finished: false,
      awaiting_input: false,
    });
  });

  it('keeps saving after a failed save', async () => {
    svc.setPrefs.mockRejectedValueOnce(new Error('config locked')).mockResolvedValue(undefined);
    const el = await render();

    flip(toggle(el, 'notifications-turn_finished-toggle'), false);
    await settle();
    flip(toggle(el, 'notifications-session_error-toggle'), false);
    await settle();

    expect(svc.setPrefs).toHaveBeenCalledTimes(2);
    expect(svc.setPrefs).toHaveBeenLastCalledWith({ ...ALL_ON, session_error: false });
  });

  it('offers the prompt while the permission is undetermined and shows the answer', async () => {
    serve('undetermined');
    svc.requestPermission.mockResolvedValue('denied');
    const el = await render();
    expect(el.textContent).toContain('Not asked yet');

    (
      el.querySelector('[data-testid="request-notification-permission"]') as HTMLButtonElement
    ).click();
    await settle();

    expect(svc.requestPermission).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain('Blocked by the system');
  });

  it('names where to unblock notifications on macOS and opens System Settings', async () => {
    serve('denied');
    const el = await render();
    const state = el.querySelector('[data-testid="notification-permission-state"]');
    const button = el.querySelector(
      '[data-testid="open-notification-settings"]'
    ) as HTMLButtonElement;

    expect(state?.textContent).toContain('System Settings > Notifications');
    expect(button.textContent).toContain('Open System Settings');
    button.click();
    expect(svc.openSystemSettings).toHaveBeenCalledTimes(1);
  });

  it('names the Windows settings page when blocked on Windows', async () => {
    platform = 'windows';
    serve('denied');
    const el = await render();

    expect(el.textContent).toContain('Settings > System > Notifications');
    expect(el.textContent).toContain('Open Windows Settings');
  });

  it('explains a Windows quiet state and a build without notifications', async () => {
    platform = 'windows';
    serve('suppressed');
    let el = await render();
    expect(el.textContent).toContain('holds notifications back');

    serve('unavailable');
    el = await render();
    expect(el.textContent).toContain('Not available in this build');
    expect(el.querySelector('[data-testid="open-notification-settings"]')).toBeNull();
  });

  it('re-reads the permission when the window regains focus', async () => {
    serve('denied');
    const el = await render();
    serve('granted');

    mockTauri.dispatchEvent('window_focused', null);
    await settle();

    expect(svc.settings).toHaveBeenCalledTimes(2);
    expect(el.textContent).toContain('Allowed.');
  });

  it('reports a failed read instead of showing switches', async () => {
    svc.settings.mockRejectedValue(new Error('config unreadable'));
    fixture = TestBed.createComponent(NotificationsSectionComponent);
    component = fixture.componentInstance;
    const errors: string[] = [];
    component.errorOccurred.subscribe((m) => errors.push(m));

    fixture.detectChanges();
    await settle();

    expect(errors).toEqual(['config unreadable']);
    expect(toggle(fixture.nativeElement, 'notifications-enabled-toggle')).toBeNull();
  });
});
