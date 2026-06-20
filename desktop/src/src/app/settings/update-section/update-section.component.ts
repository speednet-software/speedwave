import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnInit,
  inject,
  input,
  output,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TauriService } from '../../services/tauri.service';
import { UpdateCheckOutcome, UpdateSettings } from '../../models/update';

/** Displays app update controls, container update/rollback, and auto-check settings. */
@Component({
  selector: 'app-update-section',
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <section id="section-updates" class="border-t border-[var(--line)] pt-6">
      <h2 class="view-title view-title-section text-[var(--ink)]">Updates</h2>
      <div class="mt-3 rounded border border-[var(--line)]">
        <div class="flex items-center justify-between px-4 py-3">
          <div>
            <div class="mono text-[12px] text-[var(--ink)]">
              speedwave {{ currentVersion ? 'v' + currentVersion : '' }}
            </div>
            <div class="mono mt-0.5 text-[11px]" [class]="updateStatusClass()">
              {{ updateStatusText() }}
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40 disabled:cursor-not-allowed"
              data-testid="settings-check-update"
              (click)="checkForUpdate()"
              [disabled]="updateChecking || updateInstalling"
            >
              {{ updateChecking ? 'checking...' : 'check now' }}
            </button>
            @if (updateResult === 'available') {
              <button
                type="button"
                class="mono rounded bg-[var(--accent)] px-3 py-1 text-[11px] font-medium text-[var(--on-accent)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="settings-install-update"
                (click)="installUpdate()"
                [disabled]="updateInstalling"
              >
                {{ updateInstalling ? 'installing...' : 'install & restart' }}
              </button>
            }
          </div>
        </div>
      </div>

      @if (updateInstallError) {
        <p
          class="mono mt-3 rounded border border-red-500/40 bg-red-500/5 px-3 py-2 text-[11px] text-red-300"
        >
          {{ updateInstallError }}
        </p>
      }
    </section>
  `,
})
export class UpdateSectionComponent implements OnInit {
  readonly activeProject = input<string | null>(null);

  readonly errorOccurred = output<string>();

  /** Hard-coded auto-check interval in hours; the UI exposes no toggle or frequency control. */
  private static readonly DEFAULT_INTERVAL_HOURS = 12;

  currentVersion = '';
  /** Always true; auto-check is non-negotiable. */
  updateAutoCheck = true;
  updateIntervalHours = UpdateSectionComponent.DEFAULT_INTERVAL_HOURS;
  updateChecking = false;
  updateResult: 'none' | 'up-to-date' | 'available' = 'none';
  updateAvailableVersion = '';
  updateInstalling = false;
  updateInstallError = '';
  error = '';

  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);

  /** Loads current version and update settings on init. */
  ngOnInit(): void {
    this.loadCurrentVersion();
    this.loadUpdateSettings();
  }

  /** Human-readable status line shown under the version label. Maps the four UI states to the mockup's status copy. */
  updateStatusText(): string {
    if (this.updateChecking) return 'checking for updates...';
    if (this.updateResult === 'up-to-date') return '✓ up to date';
    if (this.updateResult === 'available') {
      return '⚠ update available: v' + this.updateAvailableVersion;
    }
    return 'tap "check now" to look for updates';
  }

  /** Tailwind class for the status line: green for up-to-date, amber for available, muted for idle/checking. Returned as single string for [class]="..." binding. */
  updateStatusClass(): string {
    if (this.updateResult === 'up-to-date') return 'text-[var(--green)]';
    if (this.updateResult === 'available') return 'text-[var(--amber)]';
    return 'text-[var(--ink-mute)]';
  }

  private async loadCurrentVersion(): Promise<void> {
    try {
      this.currentVersion = await this.tauri.getVersion();
    } catch {
      // Not running inside Tauri
    }
    this.cdr.markForCheck();
  }

  private async loadUpdateSettings(): Promise<void> {
    try {
      const settings = await this.tauri.invoke<UpdateSettings>('get_update_settings');
      const needsRewrite =
        !settings.auto_check ||
        settings.check_interval_hours !== UpdateSectionComponent.DEFAULT_INTERVAL_HOURS;
      if (needsRewrite) {
        await this.saveUpdateSettings();
      }
    } catch {
      // Not running inside Tauri
    }
    this.cdr.markForCheck();
  }

  private async saveUpdateSettings(): Promise<void> {
    try {
      await this.tauri.invoke('set_update_settings', {
        settings: {
          auto_check: this.updateAutoCheck,
          check_interval_hours: this.updateIntervalHours,
        },
      });
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
      this.errorOccurred.emit(this.error);
      this.cdr.markForCheck();
    }
  }

  /** Manually checks for available updates. */
  async checkForUpdate(): Promise<void> {
    this.updateChecking = true;
    this.updateResult = 'none';
    this.error = '';
    this.cdr.markForCheck();
    try {
      const outcome = await this.tauri.invoke<UpdateCheckOutcome>('check_for_update');
      switch (outcome.kind) {
        case 'update_available':
          this.updateResult = 'available';
          this.updateAvailableVersion = outcome.version;
          break;
        case 'up_to_date':
          this.updateResult = 'up-to-date';
          setTimeout(() => {
            this.updateResult = 'none';
            this.cdr.markForCheck();
          }, 3000);
          break;
      }
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
      this.errorOccurred.emit(this.error);
    }
    this.updateChecking = false;
    this.cdr.markForCheck();
  }

  /** Downloads and installs the available update, then lets the backend restart the app. */
  async installUpdate(): Promise<void> {
    if (!this.updateAvailableVersion) return;
    this.updateInstalling = true;
    this.updateInstallError = '';
    this.cdr.markForCheck();
    try {
      await this.tauri.invoke('install_update_and_reconcile', {
        expectedVersion: this.updateAvailableVersion,
      });
    } catch (e: unknown) {
      this.updateInstallError = e instanceof Error ? e.message : String(e);
    }
    this.updateInstalling = false;
    this.cdr.markForCheck();
  }
}
