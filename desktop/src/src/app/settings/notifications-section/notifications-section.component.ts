import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';

import { TauriService } from '../../services/tauri.service';
import { NotificationsService } from '../../services/notifications.service';
import type { NotificationPermission, NotificationPrefs } from '../../models/notifications';
import { ToggleComponent } from '../../shared/toggle.component';

/** One per-event switch row. */
interface EventRow {
  key: Exclude<keyof NotificationPrefs, 'enabled'>;
  label: string;
  hint: string;
}

const EVENT_ROWS: readonly EventRow[] = [
  {
    key: 'turn_finished',
    label: 'Chat finished',
    hint: 'Claude is done and waits for your next message.',
  },
  {
    key: 'awaiting_input',
    label: 'Chat waits for your answer',
    hint: 'Claude asked a question and cannot continue without you.',
  },
  {
    key: 'session_error',
    label: 'Chat stopped with an error',
    hint: 'The turn or the session ended with an error.',
  },
];

/** Settings → Notifications (SPEED-522): system permission state and the per-event switches. */
@Component({
  selector: 'app-notifications-section',
  imports: [ToggleComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      id="section-notifications"
      class="border-t border-[var(--line)] pt-6"
      data-testid="settings-section-notifications"
    >
      <h2 class="view-title view-title-section text-[var(--ink)]">Notifications</h2>
      <p class="mt-1 text-[12.5px] leading-relaxed text-[var(--ink-dim)]">
        A system notification tells you when a chat needs you while Speedwave is in the background.
        Clicking it opens that chat.
      </p>

      @if (prefs(); as p) {
        <div
          class="mt-4 flex items-center justify-between gap-3 rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-3"
        >
          <div>
            <div class="text-[12px] text-[var(--ink)]">System permission</div>
            <div
              class="text-[11px] text-[var(--ink-mute)]"
              [class.text-amber-300]="permission() === 'denied'"
              data-testid="notification-permission-state"
            >
              {{ permissionLabel() }}
            </div>
          </div>
          @if (permission() === 'undetermined') {
            <button
              type="button"
              class="mono shrink-0 whitespace-nowrap rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)]"
              data-testid="request-notification-permission"
              (click)="requestPermission()"
            >
              Ask for access
            </button>
          } @else if (permission() === 'denied') {
            <button
              type="button"
              class="mono shrink-0 whitespace-nowrap rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)]"
              data-testid="open-notification-settings"
              (click)="openSystemSettings()"
            >
              {{ settingsButtonLabel() }}
            </button>
          }
        </div>

        <div class="mt-4 flex items-center justify-between gap-3">
          <div class="text-[12px] text-[var(--ink)]">Show notifications</div>
          <app-toggle
            testId="notifications-enabled-toggle"
            ariaLabel="Show notifications"
            [checked]="p.enabled"
            (changed)="onToggle('enabled', $event)"
          />
        </div>

        @for (row of eventRows; track row.key) {
          <div class="mt-3 flex items-center justify-between gap-3 pl-3">
            <div>
              <div class="text-[12px] text-[var(--ink)]">{{ row.label }}</div>
              <div class="text-[11px] text-[var(--ink-mute)]">{{ row.hint }}</div>
            </div>
            <app-toggle
              [testId]="'notifications-' + row.key + '-toggle'"
              [ariaLabel]="row.label"
              [checked]="p[row.key]"
              [disabled]="!p.enabled"
              disabledTitle="Turn on notifications first"
              (changed)="onToggle(row.key, $event)"
            />
          </div>
        }
      }
    </section>
  `,
})
export class NotificationsSectionComponent implements OnInit {
  /** Emits a user-facing message when reading or saving the settings fails. */
  readonly errorOccurred = output<string>();

  readonly eventRows = EVENT_ROWS;
  /** Stored switches (null while loading). */
  readonly prefs = signal<NotificationPrefs | null>(null);
  /** OS permission (null while loading). */
  readonly permission = signal<NotificationPermission | null>(null);
  /** Host platform from `get_platform`. */
  readonly platform = signal<string>('');
  /** Whether the host is Windows, which names its settings and quiet states differently. */
  readonly isWindows = computed(() => this.platform() === 'windows');

  /** Where the user turns notifications back on, named for this platform. */
  readonly settingsButtonLabel = computed(() =>
    this.isWindows() ? 'Open Windows Settings' : 'Open System Settings'
  );

  /** Human label for the permission state. */
  readonly permissionLabel = computed(() => {
    switch (this.permission()) {
      case 'granted':
        return 'Allowed.';
      case 'undetermined':
        return 'Not asked yet. macOS asks the first time a notification is due.';
      case 'denied':
        return this.isWindows()
          ? 'Blocked by the system. Turn on Speedwave in Settings > System > Notifications.'
          : 'Blocked by the system. Allow Speedwave in System Settings > Notifications.';
      case 'suppressed':
        return 'Allowed, but Windows holds notifications back right now (a full-screen app, a presentation, or the first hour after a new sign-in).';
      case 'unavailable':
        return 'Not available in this build. Notifications work in the installed app.';
      default:
        return 'Checking…';
    }
  });

  private readonly tauri = inject(TauriService);
  private readonly notifications = inject(NotificationsService);
  private readonly destroyRef = inject(DestroyRef);
  private saves: Promise<void> = Promise.resolve();
  private saveQueued = false;

  /** Reads the settings and re-reads the permission whenever the window regains focus. */
  async ngOnInit(): Promise<void> {
    try {
      this.platform.set(await this.tauri.invoke<string>('get_platform'));
    } catch {}
    await this.refresh();
    try {
      const stop = await this.tauri.listen('window_focused', () => void this.refresh());
      this.destroyRef.onDestroy(stop);
    } catch {}
  }

  /** Shows the system prompt, then shows the answer. */
  async requestPermission(): Promise<void> {
    try {
      this.permission.set(await this.notifications.requestPermission());
    } catch (e: unknown) {
      this.errorOccurred.emit(message(e));
    }
  }

  /** Opens the system pane where notifications for Speedwave are allowed. */
  async openSystemSettings(): Promise<void> {
    try {
      await this.notifications.openSystemSettings();
    } catch (e: unknown) {
      this.errorOccurred.emit(message(e));
    }
  }

  /**
   * Shows one switch at once and queues a save of all of them; a failed save re-reads the stored ones.
   * @param key - The switch that changed.
   * @param event - The toggle's change event.
   * @returns Resolves once every save queued so far has finished.
   */
  onToggle(key: keyof NotificationPrefs, event: Event): Promise<void> {
    const current = this.prefs();
    if (!current) return this.saves;
    this.prefs.set({ ...current, [key]: (event.target as HTMLInputElement).checked });
    if (!this.saveQueued) {
      this.saveQueued = true;
      this.saves = this.saves.then(() => {
        this.saveQueued = false;
        return this.saveLatest();
      });
    }
    return this.saves;
  }

  private async saveLatest(): Promise<void> {
    const prefs = this.prefs();
    if (!prefs) return;
    try {
      await this.notifications.setPrefs(prefs);
    } catch (e: unknown) {
      this.errorOccurred.emit(message(e));
      await this.refresh();
    }
  }

  private async refresh(): Promise<void> {
    try {
      const settings = await this.notifications.settings();
      this.prefs.set(settings.prefs);
      this.permission.set(settings.permission);
    } catch (e: unknown) {
      this.errorOccurred.emit(message(e));
    }
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
