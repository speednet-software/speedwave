import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  inject,
} from '@angular/core';
import { type UnlistenFn } from '@tauri-apps/api/event';
import { TauriService } from '../services/tauri.service';
import { BundleReconcileStatus, ProjectList, UpdateInfo } from '../models/update';

/** Shows a banner when a new Speedwave version is available for install. */
@Component({
  selector: 'app-update-notification',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (showBundleBanner || showUpdateBanner) {
      <div class="update-banner" data-testid="update-banner">
        <span class="update-text">
          @if (showBundleBanner) {
            {{ bundleStatusMessage }}
          } @else {
            Speedwave v{{ updateInfo!.version }} is ready
            @if (installing) {
              — updating...
            } @else if (containersRunning) {
              — running containers will be restarted
            } @else {
              — update and restart now
            }
          }
        </span>
        <div class="update-actions">
          @if (showBundleBanner && bundleStatus?.last_error) {
            <span class="update-error" data-testid="bundle-reconcile-error">
              {{ bundleStatus.last_error }}
            </span>
          } @else if (error) {
            <span class="update-error" data-testid="update-error">{{ error }}</span>
          }
          @if (showBundleBanner) {
            @if (bundleStatus?.last_error) {
              <button class="btn-restart" (click)="retryBundleReconcile()" [disabled]="retrying">
                {{ retrying ? 'Retrying...' : 'Retry' }}
              </button>
            }
          } @else {
            @if (isLinux) {
              <button class="btn-restart" (click)="openReleasesPage()">
                Download v{{ updateInfo!.version }}
              </button>
            } @else {
              @if (!confirmUpdate) {
                <button class="btn-restart" (click)="confirmUpdate = true" [disabled]="installing">
                  Update now
                </button>
              } @else {
                <button class="btn-restart" (click)="installAndRestart()" [disabled]="installing">
                  {{ installing ? 'Updating...' : 'Confirm Update' }}
                </button>
                <button class="btn-later" (click)="confirmUpdate = false" [disabled]="installing">
                  Cancel
                </button>
              }
            }
            @if (!confirmUpdate || isLinux) {
              @if (containersRunning && !isLinux) {
                <span class="containers-warning">Running containers will be interrupted</span>
              }
              @if (!updateInfo!.is_critical) {
                <button class="btn-later" (click)="dismiss()" [disabled]="installing">Later</button>
              }
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
  bundleStatus: BundleReconcileStatus | null = null;
  dismissed = false;
  installing = false;
  retrying = false;
  error = '';
  confirmUpdate = false;
  containersRunning = false;
  isLinux = false;

  private unlisten: UnlistenFn | null = null;
  private unlistenBundleStatus: UnlistenFn | null = null;
  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);

  /** Initializes the Tauri event listeners and performs an initial update check. */
  constructor() {
    this.setupListeners();
  }

  private async setupListeners(): Promise<void> {
    try {
      const platform = await this.tauri.invoke<string>('get_platform');
      this.isLinux = platform === 'linux';

      this.unlisten = await this.tauri.listen<UpdateInfo>('update_available', (event) => {
        this.updateInfo = event.payload;
        this.dismissed = false;
        this.error = '';
        this.confirmUpdate = false;
        this.checkContainers();
        this.cdr.markForCheck();
      });

      this.unlistenBundleStatus = await this.tauri.listen<BundleReconcileStatus>(
        'bundle_reconcile_status',
        (event) => {
          this.bundleStatus = event.payload;
          this.retrying = false;
          if (event.payload.last_error) {
            this.dismissed = false;
          }
          this.cdr.markForCheck();
        }
      );

      this.bundleStatus = await this.tauri.invoke<BundleReconcileStatus>(
        'get_bundle_reconcile_state'
      );
      if (this.bundleStatus?.last_error) {
        this.dismissed = false;
      }

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

  /** Downloads and installs the update, then lets the backend restart the app. */
  async installAndRestart(): Promise<void> {
    this.installing = true;
    this.error = '';
    this.cdr.markForCheck();
    try {
      await this.tauri.invoke('install_update_and_reconcile', {
        expectedVersion: this.updateInfo!.version,
      });
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
      this.confirmUpdate = false;
    } finally {
      this.installing = false;
      this.cdr.markForCheck();
    }
  }

  /** Retries the startup reconcile after a failed bundle update. */
  async retryBundleReconcile(): Promise<void> {
    this.retrying = true;
    this.cdr.markForCheck();
    try {
      await this.tauri.invoke('retry_bundle_reconcile');
      if (this.bundleStatus) {
        this.bundleStatus = {
          ...this.bundleStatus,
          in_progress: true,
          last_error: null,
        };
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      this.bundleStatus = {
        phase: this.bundleStatus?.phase ?? 'pending',
        in_progress: false,
        last_error: message,
        pending_running_projects: this.bundleStatus?.pending_running_projects ?? [],
        applied_bundle_id: this.bundleStatus?.applied_bundle_id ?? null,
      };
    } finally {
      this.retrying = false;
      this.cdr.markForCheck();
    }
  }

  /** Hides the notification banner until the next update event. */
  dismiss(): void {
    this.dismissed = true;
    this.confirmUpdate = false;
    this.cdr.markForCheck();
  }

  get showBundleBanner(): boolean {
    return !!this.bundleStatus && (this.bundleStatus.in_progress || !!this.bundleStatus.last_error);
  }

  get showUpdateBanner(): boolean {
    return !!this.updateInfo && !this.dismissed && !this.showBundleBanner;
  }

  get bundleStatusMessage(): string {
    if (!this.bundleStatus) {
      return '';
    }

    if (this.bundleStatus.last_error) {
      return 'Update failed';
    }

    switch (this.bundleStatus.phase) {
      case 'resources_synced':
      case 'images_built':
        return 'Rebuilding containers';
      case 'projects_restored':
        return 'Restoring projects';
      case 'pending':
      default:
        return 'Preparing update';
    }
  }

  /** Opens the GitHub Releases page for the latest version (Linux .deb). */
  async openReleasesPage(): Promise<void> {
    try {
      await this.tauri.invoke('open_url', {
        url: 'https://github.com/speednet-software/speedwave/releases',
      });
    } catch {
      // Fallback: not running inside Tauri
    }
  }

  /** Cleans up the Tauri event listeners on component destruction. */
  ngOnDestroy(): void {
    void this.unlisten?.();
    void this.unlistenBundleStatus?.();
  }
}
