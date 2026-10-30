import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';

import { NotificationsService } from './notifications.service';
import { TauriService } from './tauri.service';
import { ChatStateService } from './chat-state.service';
import { ProjectStateService } from './project-state.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import { NOTIFICATION_ACTIVATED_EVENT } from '../models/notifications';

describe('NotificationsService', () => {
  let mockTauri: MockTauriService;
  let activateTab: ReturnType<typeof vi.fn>;
  let navigateByUrl: ReturnType<typeof vi.fn>;
  const activeProject = signal<string | null>('demo');

  function createService(): NotificationsService {
    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: mockTauri },
        { provide: ChatStateService, useValue: { activateTab } },
        { provide: ProjectStateService, useValue: { activeProject } },
        { provide: Router, useValue: { navigateByUrl } },
      ],
    });
    return TestBed.inject(NotificationsService);
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  beforeEach(() => {
    mockTauri = new MockTauriService();
    activateTab = vi.fn();
    navigateByUrl = vi.fn().mockResolvedValue(true);
    activeProject.set('demo');
  });

  it('opens the chat view and the tab of a clicked notification', async () => {
    const service = createService();
    await service.listenForActivation();

    mockTauri.dispatchEvent(NOTIFICATION_ACTIVATED_EVENT, { project: 'demo', tab_id: 't-2' });
    await settle();

    expect(navigateByUrl).toHaveBeenCalledWith('/chat');
    expect(activateTab).toHaveBeenCalledWith('t-2');
  });

  it('leaves the view alone when the notification belongs to another project', async () => {
    const service = createService();
    await service.listenForActivation();
    activeProject.set('other');

    mockTauri.dispatchEvent(NOTIFICATION_ACTIVATED_EVENT, { project: 'demo', tab_id: 't-2' });
    await settle();

    expect(navigateByUrl).not.toHaveBeenCalled();
    expect(activateTab).not.toHaveBeenCalled();
  });

  it('stops routing clicks once unlistened', async () => {
    const service = createService();
    const stop = await service.listenForActivation();
    stop();

    mockTauri.dispatchEvent(NOTIFICATION_ACTIVATED_EVENT, { project: 'demo', tab_id: 't-2' });
    await settle();

    expect(navigateByUrl).not.toHaveBeenCalled();
    expect(activateTab).not.toHaveBeenCalled();
  });

  it('calls the backend commands with their arguments', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    mockTauri.invokeHandler = async (cmd, args) => {
      calls.push([cmd, args]);
      return cmd === 'request_notification_permission' ? 'denied' : undefined;
    };
    const service = createService();
    const prefs = {
      enabled: true,
      turn_finished: false,
      awaiting_input: true,
      session_error: true,
    };

    await service.settings();
    await service.setPrefs(prefs);
    expect(await service.requestPermission()).toBe('denied');
    await service.openSystemSettings();

    expect(calls).toEqual([
      ['get_notification_settings', undefined],
      ['set_notification_prefs', { prefs }],
      ['request_notification_permission', undefined],
      ['open_notification_settings', undefined],
    ]);
  });
});
