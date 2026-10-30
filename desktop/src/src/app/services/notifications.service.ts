import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import type { UnlistenFn } from '@tauri-apps/api/event';

import { TauriService } from './tauri.service';
import { ChatStateService } from './chat-state.service';
import { ProjectStateService } from './project-state.service';
import {
  NOTIFICATION_ACTIVATED_EVENT,
  type NotificationPermission,
  type NotificationPrefs,
  type NotificationSettings,
  type NotificationTarget,
} from '../models/notifications';

/** Native OS notifications for chat-session events (SPEED-522): settings and click routing. */
@Injectable({ providedIn: 'root' })
export class NotificationsService {
  private readonly tauri = inject(TauriService);
  private readonly router = inject(Router);
  private readonly chat = inject(ChatStateService);
  private readonly projectState = inject(ProjectStateService);

  /**
   * Reads the switches and the OS permission; never prompts.
   * @returns The current settings.
   */
  settings(): Promise<NotificationSettings> {
    return this.tauri.invoke<NotificationSettings>('get_notification_settings');
  }

  /**
   * Stores every switch.
   * @param prefs - The switches to store.
   * @returns Resolves once written.
   */
  setPrefs(prefs: NotificationPrefs): Promise<void> {
    return this.tauri.invoke<void>('set_notification_prefs', { prefs });
  }

  /**
   * Shows the OS prompt when the permission is undetermined.
   * @returns The permission after the prompt.
   */
  requestPermission(): Promise<NotificationPermission> {
    return this.tauri.invoke<NotificationPermission>('request_notification_permission');
  }

  /**
   * Opens the OS pane where notifications for Speedwave are allowed.
   * @returns Resolves once the pane was asked to open.
   */
  openSystemSettings(): Promise<void> {
    return this.tauri.invoke<void>('open_notification_settings');
  }

  /**
   * Routes every clicked notification to its chat tab; one from another project leaves the view as it is.
   * @returns Stops listening.
   */
  listenForActivation(): Promise<UnlistenFn> {
    return this.tauri.listen<NotificationTarget>(NOTIFICATION_ACTIVATED_EVENT, (event) => {
      void this.openTarget(event.payload);
    });
  }

  private async openTarget(target: NotificationTarget): Promise<void> {
    if (target.project !== this.projectState.activeProject()) return;
    await this.router.navigateByUrl('/chat');
    this.chat.activateTab(target.tab_id);
  }
}
