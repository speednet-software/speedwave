import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  OnInit,
  Output,
  inject,
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
    <!-- Updates -->
    <section class="mb-6">
      <h2 class="text-[15px] text-sw-text m-0 mb-3">Updates</h2>
      <div class="bg-sw-bg-dark border border-sw-border rounded-lg p-4">
        <div class="flex justify-between items-center py-2">
          <span class="text-[13px] text-sw-text-muted">Current version</span>
          <span class="text-[13px] font-mono text-sw-text-dim">{{ currentVersion || '—' }}</span>
        </div>
        <div class="flex justify-between items-center py-2 border-t border-sw-border">
          <span class="text-[13px] text-sw-text-muted min-w-[120px]">Auto-check</span>
          <label class="flex items-center gap-2 cursor-pointer" for="update-auto-check">
            <input
              id="update-auto-check"
              type="checkbox"
              [checked]="updateAutoCheck"
              (change)="toggleAutoCheck()"
              class="accent-sw-accent w-4 h-4 cursor-pointer"
            />
            <span class="text-[13px] text-sw-text font-mono">{{
              updateAutoCheck ? 'On' : 'Off'
            }}</span>
          </label>
        </div>
        @if (updateAutoCheck) {
          <div class="flex justify-between items-center py-2 border-t border-sw-border">
            <label class="text-[13px] text-sw-text-muted min-w-[120px]" for="check-frequency"
              >Frequency</label
            >
            <select
              id="check-frequency"
              [ngModel]="updateIntervalHours"
              (ngModelChange)="setCheckInterval($event)"
              class="flex-1 max-w-[340px] px-2.5 py-1.5 bg-sw-bg-abyss border border-sw-border rounded text-sw-text text-[13px] font-mono outline-none focus:border-sw-accent"
            >
              <option [ngValue]="12">Every 12 hours</option>
              <option [ngValue]="24">Every 24 hours</option>
              <option [ngValue]="168">Weekly</option>
            </select>
          </div>
        }
        <div class="flex items-center gap-3 pt-3 pb-1">
          <button
            class="px-5 py-1.5 bg-transparent text-sw-accent border border-sw-accent rounded text-[13px] font-mono cursor-pointer transition-all duration-200 hover:enabled:bg-sw-accent hover:enabled:text-sw-bg-abyss disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid="settings-check-update"
            (click)="checkForUpdate()"
            [disabled]="updateChecking || updateInstalling"
          >
            {{ updateChecking ? 'Checking...' : 'Check now' }}
          </button>
          @if (updateResult === 'up-to-date') {
            <span class="text-sw-success text-[13px]">Up to date</span>
          }
          @if (updateResult === 'available') {
            <span class="text-sw-accent text-[13px] font-bold"
              >v{{ updateAvailableVersion }} available</span
            >
            @if (isLinux) {
              <button
                class="px-4 py-1.5 bg-sw-accent text-sw-bg-abyss border-none rounded text-[13px] font-mono cursor-pointer transition-opacity duration-200 hover:enabled:opacity-85 disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="settings-download-update"
                (click)="openReleasesPage()"
              >
                Download v{{ updateAvailableVersion }}
              </button>
            } @else {
              <button
                class="px-4 py-1.5 bg-sw-accent text-sw-bg-abyss border-none rounded text-[13px] font-mono cursor-pointer transition-opacity duration-200 hover:enabled:opacity-85 disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="settings-install-update"
                (click)="installUpdate()"
                [disabled]="updateInstalling"
              >
                {{ updateInstalling ? 'Installing...' : 'Install & Restart' }}
              </button>
            }
          }
        </div>
        @if (updateInstallError) {
          <p
            class="mt-2 mb-4 px-3 py-2 bg-sw-error-bg border border-sw-error rounded text-sw-error text-[13px]"
          >
            {{ updateInstallError }}
          </p>
        }
      </div>
    </section>
  `,
})
export class UpdateSectionComponent implements OnInit {
  @Input() activeProject: string | null = null;

  @Output() errorOccurred = new EventEmitter<string>();

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
