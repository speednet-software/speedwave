import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  inject,
} from '@angular/core';
import { type UnlistenFn } from '@tauri-apps/api/event';
import { TauriService } from '../services/tauri.service';
import { UpdateInfo, ProjectList } from '../models/update';

/** Shows a banner when a new Speedwave version is available for install. */
@Component({
  selector: 'app-update-notification',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (updateInfo && !dismissed) {
      <div class="update-banner">
        <span class="update-text">
          @if (updateInstalled) {
            Speedwave v{{ updateInfo.version }} downloaded
            @if (containersRunning) {
              — will apply on next restart
            } @else {
              — restart to apply
            }
          } @else {
            Speedwave v{{ updateInfo.version }} is ready
            @if (installing) {
              — installing...
            } @else if (containersRunning) {
              — containers running, restart to update
            } @else {
              — restart to update
            }
          }
        </span>
        <div class="update-actions">
          @if (error) {
            <span class="update-error">{{ error }}</span>
          }
          @if (!updateInstalled) {
            @if (!confirmRestart) {
              <button class="btn-restart" (click)="confirmRestart = true" [disabled]="installing">
                Restart
              </button>
            } @else {
              <button class="btn-restart" (click)="installAndRestart()" [disabled]="installing">
                {{ installing ? 'Installing...' : 'Confirm Restart' }}
              </button>
              <button class="btn-later" (click)="confirmRestart = false" [disabled]="installing">
                Cancel
              </button>
            }
            @if (!confirmRestart) {
              @if (containersRunning) {
                <span class="containers-warning">Running containers will be interrupted</span>
              }
              @if (!updateInfo.is_critical) {
                <button class="btn-later" (click)="dismiss()" [disabled]="installing">Later</button>
              }
            }
          } @else {
            @if (!containersRunning) {
              @if (!confirmRestart) {
                <button class="btn-restart" (click)="confirmRestart = true">Restart now</button>
              } @else {
                <button class="btn-restart" (click)="restartApp()">Confirm Restart</button>
                <button class="btn-later" (click)="confirmRestart = false">Cancel</button>
              }
            }
            @if (!updateInfo.is_critical) {
              <button class="btn-later" (click)="dismiss()">Later</button>
            }
          }
        </div>
      </div>
    }
  `,
  styles: [
    `
      .update-banner {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 16px;
        background: #0f3460;
        border-bottom: 1px solid #e94560;
        font-size: 13px;
        font-family: monospace;
      }
      .update-text {
        color: #e0e0e0;
      }
      .update-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .update-error {
        color: #e94560;
        font-size: 12px;
      }
      .containers-warning {
        color: #f59e0b;
        font-size: 12px;
      }
      .btn-restart {
        padding: 3px 12px;
        background: #e94560;
        color: #1a1a2e;
        border: none;
        border-radius: 4px;
        font-size: 12px;
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
      .btn-later {
        padding: 3px 12px;
        background: transparent;
        color: #888;
        border: 1px solid #555;
        border-radius: 4px;
        font-size: 12px;
        font-family: monospace;
        cursor: pointer;
        transition: color 0.2s;
      }
      .btn-later:hover:not(:disabled) {
        color: #e0e0e0;
        border-color: #888;
      }
      .btn-later:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
    `,
  ],
})
export class UpdateNotificationComponent implements OnDestroy {
  updateInfo: UpdateInfo | null = null;
  dismissed = false;
  installing = false;
  error = '';
  confirmRestart = false;
  updateInstalled = false;
  containersRunning = false;

  private unlisten: UnlistenFn | null = null;
  private unlistenInstalled: UnlistenFn | null = null;
  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);

  /** Initializes the Tauri event listeners and performs an initial update check. */
  constructor() {
    this.setupListeners();
  }

  private async setupListeners(): Promise<void> {
    try {
      this.unlisten = await this.tauri.listen<UpdateInfo>('update_available', (event) => {
        this.updateInfo = event.payload;
        this.dismissed = false;
        this.updateInstalled = false;
        this.error = '';
        this.confirmRestart = false;
        this.checkContainers();
        this.cdr.markForCheck();
      });

      this.unlistenInstalled = await this.tauri.listen<UpdateInfo>('update_installed', (event) => {
        if (this.updateInfo?.version !== event.payload.version) {
          this.dismissed = false;
        }
        this.updateInfo = event.payload;
        this.updateInstalled = true;
        this.installing = false;
        this.error = '';
        this.confirmRestart = false;
        this.checkContainers();
        this.cdr.markForCheck();
      });

      // Proactive check in case event fired before listener registration
      const info = await this.tauri.invoke<UpdateInfo | null>('check_for_update');
      if (info) {
        this.updateInfo = info;
        this.checkContainers();
        this.cdr.markForCheck();
      }
    } catch {
      // Not running inside Tauri
    }
  }

  private async checkContainers(): Promise<void> {
    try {
      const projectList = await this.tauri.invoke<ProjectList>('list_projects');
      let anyRunning = false;
      for (const project of projectList.projects) {
        const running = await this.tauri.invoke<boolean>('check_containers_running', {
          project: project.name,
        });
        if (running) {
          anyRunning = true;
          break;
        }
      }
      this.containersRunning = anyRunning;
      this.cdr.markForCheck();
    } catch {
      this.containersRunning = false;
    }
  }

  /** Downloads and installs the update, then restarts the app. */
  async installAndRestart(): Promise<void> {
    this.installing = true;
    this.error = '';
    this.cdr.markForCheck();
    try {
      await this.tauri.invoke('install_update', { expectedVersion: this.updateInfo!.version });
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
      this.confirmRestart = false;
    } finally {
      this.installing = false;
      this.cdr.markForCheck();
    }
  }

  /** Restarts the app after update is already installed. */
  async restartApp(): Promise<void> {
    this.error = '';
    this.cdr.markForCheck();
    try {
      await this.tauri.invoke('restart_app', { force: false });
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
      this.confirmRestart = false;
      this.cdr.markForCheck();
    }
  }

  /** Hides the notification banner until the next update event. */
  dismiss(): void {
    this.dismissed = true;
    this.confirmRestart = false;
    this.cdr.markForCheck();
  }

  /** Cleans up the Tauri event listeners on component destruction. */
  ngOnDestroy(): void {
    if (this.unlisten) {
      this.unlisten();
    }
    if (this.unlistenInstalled) {
      this.unlistenInstalled();
    }
  }
}
