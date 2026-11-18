import { ChangeDetectionStrategy, Component, OnInit, inject, output, signal } from '@angular/core';

import { TauriService } from '../../services/tauri.service';
import { ToggleComponent } from '../../shared/toggle.component';

/** Settings → Sleep (SPEED-917): keeps the computer out of idle sleep while work runs. */
@Component({
  selector: 'app-sleep-section',
  imports: [ToggleComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <section
      id="section-sleep"
      class="border-t border-[var(--line)] pt-6"
      data-testid="settings-section-sleep"
    >
      <h2 class="view-title view-title-section text-[var(--ink)]">Sleep</h2>
      <p class="mt-1 text-[12.5px] leading-relaxed text-[var(--ink-dim)]">
        While a meeting is recorded or transcribed, or a chat is working, Speedwave stops the
        computer from going to sleep on its own. The screen can still turn off and lock.
      </p>

      @let on = enabled();
      @if (on !== null) {
        <div class="mt-4 flex items-center justify-between gap-3">
          <div>
            <div class="text-[12px] text-[var(--ink)]">Keep the computer awake</div>
            <div class="text-[11px] text-[var(--ink-mute)]">
              Closing the lid, choosing Sleep or a low battery still put it to sleep.
              @if (isWindows()) {
                On battery, Windows may still sleep a few minutes after its usual time.
              }
            </div>
          </div>
          <app-toggle
            testId="keep-awake-toggle"
            ariaLabel="Keep the computer awake"
            [checked]="on"
            (changed)="onToggle($event)"
          />
        </div>
      }
    </section>
  `,
})
export class SleepSectionComponent implements OnInit {
  /** Emits a user-facing message when reading or saving the setting fails. */
  readonly errorOccurred = output<string>();

  /** The stored switch, or the user's latest pick while its save is pending (null while loading). */
  readonly enabled = signal<boolean | null>(null);
  /** Whether the host is Windows, whose battery limit the hint names. */
  readonly isWindows = signal(false);

  private readonly tauri = inject(TauriService);
  private saves: Promise<void> = Promise.resolve();
  private pendingSaves = 0;

  /** Reads the platform and the stored switch. */
  async ngOnInit(): Promise<void> {
    try {
      this.isWindows.set((await this.tauri.invoke<string>('get_platform')) === 'windows');
    } catch {}
    await this.refresh();
  }

  /**
   * Shows the switch at once and queues its save; a failed save re-reads the stored value.
   * @param event - The toggle's change event.
   * @returns Resolves once every save queued so far has finished.
   */
  onToggle(event: Event): Promise<void> {
    const enabled = (event.target as HTMLInputElement).checked;
    this.enabled.set(enabled);
    this.pendingSaves += 1;
    this.saves = this.saves.then(() => this.save(enabled));
    return this.saves;
  }

  private async save(enabled: boolean): Promise<void> {
    try {
      await this.tauri.invoke<void>('set_keep_awake', { enabled });
    } catch (e: unknown) {
      this.errorOccurred.emit(message(e));
      if (this.pendingSaves === 1) await this.refresh();
    } finally {
      this.pendingSaves -= 1;
    }
  }

  private async refresh(): Promise<void> {
    try {
      this.enabled.set(await this.tauri.invoke<boolean>('get_keep_awake'));
    } catch (e: unknown) {
      this.errorOccurred.emit(message(e));
    }
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
