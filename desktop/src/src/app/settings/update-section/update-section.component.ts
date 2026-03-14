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
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- Updates -->
    <section class="section">
      <h2>Updates</h2>
      <div class="info-card">
        <div class="info-row">
          <span class="info-label">Current version</span>
          <span class="info-value mono">{{ currentVersion || '—' }}</span>
        </div>
        <div class="form-row">
          <span class="form-label">Auto-check</span>
          <label class="toggle" for="update-auto-check">
            <input
              id="update-auto-check"
              type="checkbox"
              [checked]="updateAutoCheck"
              (change)="toggleAutoCheck()"
            />
            <span class="toggle-label">{{ updateAutoCheck ? 'On' : 'Off' }}</span>
          </label>
        </div>
        @if (updateAutoCheck) {
          <div class="form-row">
            <label class="form-label" for="check-frequency">Frequency</label>
            <select
              id="check-frequency"
              [ngModel]="updateIntervalHours"
              (ngModelChange)="setCheckInterval($event)"
              class="form-select"
            >
              <option [ngValue]="12">Every 12 hours</option>
              <option [ngValue]="24">Every 24 hours</option>
              <option [ngValue]="168">Weekly</option>
            </select>
          </div>
        }
        <div class="form-actions">
          <button
            class="btn-save"
            data-testid="settings-check-update"
            (click)="checkForUpdate()"
            [disabled]="updateChecking || updateInstalling"
          >
            {{ updateChecking ? 'Checking...' : 'Check now' }}
          </button>
          @if (updateResult === 'up-to-date') {
            <span class="save-feedback">Up to date</span>
          }
          @if (updateResult === 'available') {
            <span class="update-available">v{{ updateAvailableVersion }} available</span>
            @if (isLinux) {
              <button
                class="btn-restart"
                data-testid="settings-download-update"
                (click)="openReleasesPage()"
              >
                Download v{{ updateAvailableVersion }}
              </button>
            } @else {
              <button
                class="btn-restart"
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
          <p class="error-banner" style="margin-top: 8px">{{ updateInstallError }}</p>
        }
      </div>
    </section>
  `,
  styles: [
    `
      .section {
        margin-bottom: 24px;
      }
      h2 {
        font-size: 15px;
        color: #e0e0e0;
        margin: 0 0 12px 0;
      }
      .info-card {
        background: #16213e;
        border: 1px solid #0f3460;
        border-radius: 8px;
        padding: 16px;
      }
      .info-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 0;
      }
      .info-row + .info-row {
        border-top: 1px solid #0f3460;
      }
      .info-label {
        font-size: 13px;
        color: #888;
      }
      .info-value {
        font-size: 13px;
        color: #e0e0e0;
      }
      .info-value.mono {
        font-family: monospace;
        color: #aaa;
      }
      .error-banner {
        margin-bottom: 16px;
        padding: 8px 12px;
        background: #3d0000;
        border: 1px solid #e94560;
        border-radius: 4px;
        color: #e94560;
        font-size: 13px;
      }
      .form-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 0;
      }
      .form-row + .form-row {
        border-top: 1px solid #0f3460;
      }
      .form-label {
        font-size: 13px;
        color: #888;
        min-width: 120px;
      }
      .form-select {
        flex: 1;
        max-width: 340px;
        padding: 6px 10px;
        background: #1a1a2e;
        border: 1px solid #0f3460;
        border-radius: 4px;
        color: #e0e0e0;
        font-size: 13px;
        font-family: monospace;
      }
      .form-select:focus {
        outline: none;
        border-color: #e94560;
      }
      .form-actions {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 0 4px 0;
      }
      .btn-save {
        padding: 6px 20px;
        background: transparent;
        color: #e94560;
        border: 1px solid #e94560;
        border-radius: 4px;
        font-size: 13px;
        font-family: monospace;
        cursor: pointer;
        transition: all 0.2s;
      }
      .btn-save:hover:not(:disabled) {
        background: #e94560;
        color: #1a1a2e;
      }
      .btn-save:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .btn-cancel {
        padding: 6px 16px;
        background: transparent;
        color: #888;
        border: 1px solid #555;
        border-radius: 4px;
        font-size: 13px;
        font-family: monospace;
        cursor: pointer;
        transition: all 0.2s;
      }
      .btn-cancel:hover:not(:disabled) {
        color: #e0e0e0;
        border-color: #888;
      }
      .btn-cancel:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .save-feedback {
        color: #4caf50;
        font-size: 13px;
      }
      .note {
        font-size: 11px;
        color: #666;
        margin: 8px 0 0 0;
      }
      .toggle {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
      }
      .toggle input[type='checkbox'] {
        accent-color: #e94560;
        width: 16px;
        height: 16px;
        cursor: pointer;
      }
      .toggle-label {
        font-size: 13px;
        color: #e0e0e0;
        font-family: monospace;
      }
      .update-available {
        color: #e94560;
        font-size: 13px;
        font-weight: bold;
      }
      .btn-restart {
        padding: 6px 16px;
        background: #e94560;
        color: #1a1a2e;
        border: none;
        border-radius: 4px;
        font-size: 13px;
        font-family: monospace;
        cursor: pointer;
        transition: opacity 0.2s;
      }
      .btn-restart:hover:not(:disabled) {
        opacity: 0.85;
      }
      .btn-restart:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
    `,
  ],
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

  /** Downloads and installs the available update, then restarts the app. */
  async installUpdate(): Promise<void> {
    if (!this.updateAvailableVersion) return;
    this.updateInstalling = true;
    this.updateInstallError = '';
    this.cdr.markForCheck();
    try {
      await this.tauri.invoke('install_update', { expectedVersion: this.updateAvailableVersion });
      await this.tauri.invoke('restart_app', { force: true });
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
