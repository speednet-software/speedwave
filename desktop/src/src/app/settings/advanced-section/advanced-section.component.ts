import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  inject,
  output,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TauriService } from '../../services/tauri.service';

/**
 * Settings → Danger Zone. Diagnostics export and forced trace-level logging
 * live in the System health view (`/logs`); Settings only owns the
 * destructive factory-reset action now.
 */
@Component({
  selector: 'app-advanced-section',
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <section id="section-danger" class="border-t border-red-500/20 pt-6">
      <h2 class="view-title view-title-section text-red-300">Danger Zone</h2>
      <div class="mt-3 rounded border border-red-500/30 bg-red-500/5 p-4">
        <div class="mono text-[12px] text-red-200">factory reset</div>
        <p class="mt-1 text-[12px] leading-relaxed text-[var(--ink-dim)]">
          Stops all containers, destroys the VM (macOS), and removes all Speedwave data including
          tokens and plugins. The application will restart and the Setup Wizard will run again.
        </p>
        <div class="mt-3">
          @if (!confirmReset) {
            <button
              type="button"
              class="mono rounded border border-red-500/50 bg-red-500/10 px-3 py-1 text-[11px] text-red-300 hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
              data-testid="settings-reset-btn"
              (click)="confirmReset = true"
              [disabled]="resetting"
            >
              reset everything &rarr;
            </button>
          } @else {
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="mono rounded border border-red-500/50 bg-red-500/10 px-3 py-1 text-[11px] text-red-300 hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="settings-confirm-reset"
                (click)="resetEnvironment()"
                [disabled]="resetting"
              >
                {{ resetting ? 'resetting...' : 'confirm reset' }}
              </button>
              <button
                type="button"
                class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="settings-cancel-reset"
                (click)="confirmReset = false"
                [disabled]="resetting"
              >
                cancel
              </button>
            </div>
          }
        </div>
      </div>
    </section>
  `,
})
export class AdvancedSectionComponent {
  readonly errorOccurred = output<string>();
  readonly resetCompleted = output<void>();

  confirmReset = false;
  resetting = false;

  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);

  /**
   * Performs a factory reset, destroying containers and VM.
   * The backend calls app.restart() and never returns a response,
   * so the lines after invoke() are unreachable in practice —
   * they exist only as a safety net if restart behaviour changes.
   */
  async resetEnvironment(): Promise<void> {
    this.resetting = true;
    try {
      await this.tauri.invoke('factory_reset');
      // app.restart() fires before Tauri can return — this line is unreachable
      this.resetCompleted.emit();
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
    this.resetting = false;
    this.confirmReset = false;
    this.cdr.markForCheck();
  }
}
