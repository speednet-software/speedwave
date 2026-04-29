import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  inject,
} from '@angular/core';
import { type UnlistenFn } from '@tauri-apps/api/event';
import { TauriService } from '../services/tauri.service';
import { ProjectList, UpdateCheckOutcome, UpdateInfo } from '../models/update';

/** Shows a banner when a new Speedwave version is available for install. */
@Component({
  selector: 'app-update-notification',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (showUpdateBanner) {
      <div
        class="flex items-center justify-between px-4 py-1.5 bg-sw-bg-navy border-b border-sw-accent text-[13px] font-mono"
        data-testid="update-banner"
      >
        <span class="text-sw-text">
          Speedwave v{{ updateInfo!.version }} is ready
          @if (installing) {
            — updating...
          } @else if (containersRunning) {
            — running containers will be restarted
          } @else {
            — update and restart now
          }
        </span>
        <div class="flex items-center gap-2">
          @if (error) {
            <span class="text-sw-accent text-xs" data-testid="update-error">{{ error }}</span>
          }
          @if (isLinux) {
            <button
              class="px-3 py-0.5 bg-sw-accent text-sw-bg-darkest border-none rounded text-xs font-mono cursor-pointer transition-opacity duration-200 hover:not-disabled:opacity-85 disabled:opacity-40 disabled:cursor-not-allowed"
              (click)="openReleasesPage()"
            >
              Download v{{ updateInfo!.version }}
            </button>
          } @else {
            @if (!confirmUpdate) {
              <button
                class="px-3 py-0.5 bg-sw-accent text-sw-bg-darkest border-none rounded text-xs font-mono cursor-pointer transition-opacity duration-200 hover:not-disabled:opacity-85 disabled:opacity-40 disabled:cursor-not-allowed"
                (click)="confirmUpdate = true"
                [disabled]="installing"
              >
                Update now
              </button>
            } @else {
              <button
                class="px-3 py-0.5 bg-sw-accent text-sw-bg-darkest border-none rounded text-xs font-mono cursor-pointer transition-opacity duration-200 hover:not-disabled:opacity-85 disabled:opacity-40 disabled:cursor-not-allowed"
                (click)="installAndRestart()"
                [disabled]="installing"
              >
                {{ installing ? 'Updating...' : 'Confirm Update' }}
              </button>
              <button
                class="px-3 py-0.5 bg-transparent text-sw-text-muted border border-sw-slider rounded text-xs font-mono cursor-pointer transition-colors duration-200 hover:not-disabled:text-sw-text hover:not-disabled:border-sw-text-muted disabled:opacity-40 disabled:cursor-not-allowed"
                (click)="confirmUpdate = false"
                [disabled]="installing"
              >
                Cancel
              </button>
            }
          }
          @if (!confirmUpdate || isLinux) {
            @if (containersRunning && !isLinux) {
              <span class="text-sw-warning text-xs">Running containers will be interrupted</span>
            }
            @if (!updateInfo!.is_critical) {
              <button
                class="px-3 py-0.5 bg-transparent text-sw-text-muted border border-sw-slider rounded text-xs font-mono cursor-pointer transition-colors duration-200 hover:not-disabled:text-sw-text hover:not-disabled:border-sw-text-muted disabled:opacity-40 disabled:cursor-not-allowed"
                (click)="dismiss()"
                [disabled]="installing"
              >
                Later
              </button>
            }
          }
        </div>
      </div>
    }
  `,
})
export class UpdateNotificationComponent implements OnDestroy {
  updateInfo: UpdateInfo | null = null;
  dismissed = false;
  installing = false;
  error = '';
  confirmUpdate = false;
  containersRunning = false;
  isLinux = false;

  private unlisten: UnlistenFn | null = null;
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

      // Proactive check in case the event fired before the listener was
      // registered. The backend returns a tagged outcome — only the
      // `update_available` variant should surface the banner.
      const outcome = await this.tauri.invoke<UpdateCheckOutcome>('check_for_update');
      if (outcome.kind === 'update_available') {
        const { kind: _kind, ...info } = outcome;
        void _kind;
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
      const results = await Promise.all(
        projectList.projects.map((p) =>
          this.tauri.invoke<boolean>('check_containers_running', { project: p.name })
        )
      );
      this.containersRunning = results.some(Boolean);
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

  /** Hides the notification banner until the next update event. */
  dismiss(): void {
    this.dismissed = true;
    this.confirmUpdate = false;
    this.cdr.markForCheck();
  }

  /** Whether the app update banner should be shown. */
  get showUpdateBanner(): boolean {
    return !!this.updateInfo && !this.dismissed;
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
  }
}
