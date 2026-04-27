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
import { FormsModule } from '@angular/forms';
import { TauriService } from '../../services/tauri.service';
import { UpdateInfo, UpdateSettings } from '../../models/update';

/** Displays app update controls, container update/rollback, and auto-check settings. */
@Component({
  selector: 'app-update-section',
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section id="section-updates" class="border-t border-[var(--line)] pt-6">
      <h2 class="view-title text-[16px] text-[var(--ink)]">Updates</h2>
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
              @if (isLinux) {
                <button
                  type="button"
                  class="mono rounded bg-[var(--accent)] px-3 py-1 text-[11px] font-medium text-[var(--on-accent)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                  data-testid="settings-download-update"
                  (click)="openReleasesPage()"
                >
                  download v{{ updateAvailableVersion }}
                </button>
              } @else {
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

      <label
        class="mono mt-3 flex cursor-pointer items-center gap-2 text-[12px] text-[var(--ink-dim)]"
        for="update-auto-check"
      >
        <input
          id="update-auto-check"
          type="checkbox"
          [checked]="updateAutoCheck"
          (change)="toggleAutoCheck()"
          class="sr-only"
        />
        <span class="toggle" [class.on]="updateAutoCheck" aria-hidden="true"></span>
        <span>auto-check</span>
      </label>

      @if (updateAutoCheck) {
        <div class="mt-3">
          <label
            class="mono mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
            for="check-frequency"
            >frequency</label
          >
          <select
            id="check-frequency"
            [ngModel]="updateIntervalHours"
            (ngModelChange)="setCheckInterval($event)"
            class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
          >
            <option [ngValue]="12">every 12 hours</option>
            <option [ngValue]="24">every 24 hours</option>
            <option [ngValue]="168">weekly</option>
          </select>
        </div>
      }
    </section>
  `,
})
export class UpdateSectionComponent implements OnInit {
  readonly activeProject = input<string | null>(null);

  readonly errorOccurred = output<string>();

  currentVersion = '';
  updateAutoCheck = true;
  updateIntervalHours = 24;
  updateChecking = false;
  updateResult: 'none' | 'up-to-date' | 'available' = 'none';
  updateAvailableVersion = '';
  updateInstalling = false;
  isLinux = false;
  updateInstallError = '';
  error = '';

  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);

  /** Loads current version, update settings, and detects platform on init. */
  ngOnInit(): void {
    this.loadCurrentVersion();
    this.loadUpdateSettings();
    this.detectPlatform();
  }

  /**
   * Human-readable status line shown under the version label.
   * Maps the four UI states (idle, checking, up-to-date, available) to the
   * mockup's status copy so the status row mirrors the design.
   */
  updateStatusText(): string {
    if (this.updateChecking) return 'checking for updates...';
    if (this.updateResult === 'up-to-date') return '✓ up to date';
    if (this.updateResult === 'available') {
      return '⚠ update available: v' + this.updateAvailableVersion;
    }
    return 'tap "check now" to look for updates';
  }

  /**
   * Tailwind class applied to the status line. Green for "up to date", amber
   * for "available", muted for the idle/checking states. Returned as a single
   * string so the template uses `[class]="..."` rather than `ngClass`.
   */
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
      this.updateAutoCheck = settings.auto_check;
      this.updateIntervalHours = settings.check_interval_hours;
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

  /** Toggles the auto-check setting and persists it. */
  async toggleAutoCheck(): Promise<void> {
    this.updateAutoCheck = !this.updateAutoCheck;
    await this.saveUpdateSettings();
  }

  /**
   * Updates the check interval and persists it.
   * @param hours - The interval in hours between automatic update checks.
   */
  async setCheckInterval(hours: number): Promise<void> {
    this.updateIntervalHours = hours;
    await this.saveUpdateSettings();
  }

  /** Manually checks for available updates. */
  async checkForUpdate(): Promise<void> {
    this.updateChecking = true;
    this.updateResult = 'none';
    this.error = '';
    this.cdr.markForCheck();
    try {
      const info = await this.tauri.invoke<UpdateInfo | null>('check_for_update');
      if (info) {
        this.updateResult = 'available';
        this.updateAvailableVersion = info.version;
      } else {
        this.updateResult = 'up-to-date';
        setTimeout(() => {
          this.updateResult = 'none';
          this.cdr.markForCheck();
        }, 3000);
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

  /** Detects the current platform for platform-specific UI. */
  private async detectPlatform(): Promise<void> {
    try {
      const platform = await this.tauri.invoke<string>('get_platform');
      this.isLinux = platform === 'linux';
      this.cdr.markForCheck();
    } catch {
      // Not running inside Tauri
    }
  }

  /** Opens the GitHub Releases page for manual download (Linux .deb). */
  async openReleasesPage(): Promise<void> {
    try {
      await this.tauri.invoke('open_url', {
        url: 'https://github.com/speednet-software/speedwave/releases',
      });
    } catch {
      // Fallback: not running inside Tauri
    }
  }
}
