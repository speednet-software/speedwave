import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  inject,
} from '@angular/core';
import { type UnlistenFn } from '@tauri-apps/api/event';
import { TauriService } from '../services/tauri.service';
import { UpdateProgressService } from '../services/update-progress.service';
import { UpdateProgressBarComponent } from '../shared/update-progress-bar.component';
import {
  ProjectList,
  UpdateCheckOutcome,
  UpdateInfo,
  newerVersionNoticeText,
  recheckNewerVersion,
} from '../models/update';

/** Shows a banner when a new Speedwave version is available for install. */
@Component({
  selector: 'app-update-notification',
  imports: [UpdateProgressBarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (showUpdateBanner) {
      <div
        class="flex items-center justify-between px-4 py-1.5 bg-sw-bg-navy border-b border-sw-accent text-[13px] font-mono"
        data-testid="update-banner"
      >
        <span class="flex items-center gap-3 text-sw-text">
          <span>
            Speedwave v{{ updateInfo!.version }} is ready:
            @if (updateProgress.progress() === null) {
              @if (installInFlight()) {
                updating...
              } @else if (containersRunning) {
                running containers will be restarted
              } @else {
                update and restart now
              }
            }
          </span>
          @if (updateProgress.progress(); as progress) {
            <app-update-progress-bar [progress]="progress" data-testid="update-progress" />
          }
        </span>
        <div class="flex items-center gap-2">
          @if (error) {
            <span class="text-sw-accent text-xs" data-testid="update-error">{{ error }}</span>
          }
          @if (newerVersionNotice) {
            <span class="text-sw-text text-xs" data-testid="update-newer-version-notice">{{
              newerVersionNotice
            }}</span>
          }
          @if (!confirmUpdate) {
            <button
              class="px-3 py-0.5 bg-sw-accent text-on-accent border-none rounded text-xs font-mono cursor-pointer transition-opacity duration-200 hover:not-disabled:opacity-85 disabled:opacity-40 disabled:cursor-not-allowed"
              (click)="confirmUpdate = true"
              [disabled]="installInFlight()"
            >
              Update now
            </button>
          } @else {
            <button
              class="px-3 py-0.5 bg-sw-accent text-on-accent border-none rounded text-xs font-mono cursor-pointer transition-opacity duration-200 hover:not-disabled:opacity-85 disabled:opacity-40 disabled:cursor-not-allowed"
              (click)="installAndRestart()"
              [disabled]="installInFlight()"
            >
              {{ installInFlight() ? 'Updating...' : 'Confirm Update' }}
            </button>
            <button
              class="px-3 py-0.5 bg-transparent text-sw-text-muted border border-sw-slider rounded text-xs font-mono cursor-pointer transition-colors duration-200 hover:not-disabled:text-sw-text hover:not-disabled:border-sw-text-muted disabled:opacity-40 disabled:cursor-not-allowed"
              (click)="confirmUpdate = false"
              [disabled]="installInFlight()"
            >
              Cancel
            </button>
          }
          @if (!confirmUpdate) {
            @if (containersRunning) {
              <span class="text-sw-warning text-xs">Running containers will be interrupted</span>
            }
            @if (!updateInfo!.is_critical) {
              <button
                class="px-3 py-0.5 bg-transparent text-sw-text-muted border border-sw-slider rounded text-xs font-mono cursor-pointer transition-colors duration-200 hover:not-disabled:text-sw-text hover:not-disabled:border-sw-text-muted disabled:opacity-40 disabled:cursor-not-allowed"
                (click)="dismiss()"
                [disabled]="installInFlight()"
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
  newerVersionNotice = '';
  confirmUpdate = false;
  containersRunning = false;

  private unlisten: UnlistenFn | null = null;
  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  protected readonly updateProgress = inject(UpdateProgressService);

  /** Initializes the Tauri event listeners and performs an initial update check. */
  constructor() {
    this.setupListeners();
  }

  private async setupListeners(): Promise<void> {
    try {
      this.unlisten = await this.tauri.listen<UpdateInfo>('update_available', (event) => {
        const isDifferentVersion = event.payload.version !== this.updateInfo?.version;
        this.updateInfo = event.payload;
        if (isDifferentVersion && !this.installing) {
          this.dismissed = false;
          this.error = '';
          this.confirmUpdate = false;
          this.newerVersionNotice = '';
        }
        this.checkContainers();
        this.cdr.markForCheck();
      });

      const outcome = await this.tauri.invoke<UpdateCheckOutcome>('check_for_update');
      if (outcome.kind === 'update_available') {
        this.updateInfo = toUpdateInfo(outcome);
        this.checkContainers();
        this.cdr.markForCheck();
      }
    } catch {}
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

  protected installInFlight(): boolean {
    return this.installing || this.updateProgress.progress() !== null;
  }

  /** Downloads and installs the update, then lets the backend restart the app. */
  async installAndRestart(): Promise<void> {
    if (this.installInFlight()) return;
    this.installing = true;
    this.error = '';
    this.newerVersionNotice = '';
    this.cdr.markForCheck();
    const triedVersion = this.updateInfo!.version;
    try {
      await this.tauri.invoke('install_update_and_reconcile', {
        expectedVersion: triedVersion,
      });
    } catch (e: unknown) {
      await this.handleInstallFailure(e, triedVersion);
    } finally {
      this.installing = false;
      this.cdr.markForCheck();
    }
  }

  private async handleInstallFailure(e: unknown, triedVersion: string): Promise<void> {
    this.confirmUpdate = false;
    const newerVersion = await recheckNewerVersion(this.tauri, triedVersion);
    if (newerVersion) {
      this.updateInfo = { ...this.updateInfo!, version: newerVersion };
      this.newerVersionNotice = newerVersionNoticeText(newerVersion);
      return;
    }
    this.error = e instanceof Error ? e.message : String(e);
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

  /** Cleans up the Tauri event listeners on component destruction. */
  ngOnDestroy(): void {
    void this.unlisten?.();
  }
}

function toUpdateInfo(outcome: { kind: 'update_available' } & UpdateInfo): UpdateInfo {
  const { kind: _kind, ...info } = outcome;
  void _kind;
  return info;
}
