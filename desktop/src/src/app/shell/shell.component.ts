import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  inject,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { ProjectSwitcherComponent } from '../project-switcher/project-switcher.component';
import { UpdateNotificationComponent } from '../update-notification/update-notification.component';
import { ProjectStateService } from '../services/project-state.service';

/** Main application shell with header navigation and project switcher. */
@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    ProjectSwitcherComponent,
    UpdateNotificationComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col h-screen bg-sw-bg-darkest text-sw-text">
      @if (projectState.status !== 'ready' && projectState.status !== 'auth_required') {
        @if (projectState.status === 'check_failed') {
          <div
            class="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-sw-bg-darkest"
            data-testid="blocking-check-failed"
          >
            <span class="text-sw-accent text-lg font-mono font-bold">System Check Failed</span>
            <p
              class="mt-4 max-w-lg text-center font-mono text-sm text-sw-text-muted whitespace-pre-line"
            >
              {{ projectState.error }}
            </p>
            <button
              class="mt-6 px-6 py-2.5 rounded text-sm font-semibold font-mono border-none cursor-pointer transition-colors bg-sw-accent text-white hover:bg-sw-accent-hover"
              data-testid="check-retry-btn"
              (click)="retryCheck()"
            >
              Retry
            </button>
          </div>
        } @else if (projectState.status === 'error') {
          <div
            class="flex items-center justify-between px-4 py-2 bg-[#3d0000] border-b border-sw-accent text-sw-accent text-[13px] font-mono"
            data-testid="blocking-error"
          >
            <span>{{ projectState.error }}</span>
            <div class="flex gap-2">
              <button
                class="bg-transparent border border-sw-accent text-sw-accent px-2.5 py-0.5 rounded text-xs cursor-pointer"
                (click)="retry()"
              >
                Retry
              </button>
              <button
                class="bg-transparent border border-sw-accent text-sw-accent px-2.5 py-0.5 rounded text-xs cursor-pointer"
                (click)="dismiss()"
              >
                Dismiss
              </button>
            </div>
          </div>
        } @else {
          <div
            class="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-sw-bg-darkest/[0.92]"
            role="alertdialog"
            aria-modal="true"
            [attr.aria-label]="statusMessage"
            data-testid="blocking-overlay"
          >
            <div
              class="w-8 h-8 border-[3px] border-sw-border-dark border-t-sw-accent rounded-full animate-sw-spin"
            ></div>
            <p class="mt-4 font-mono text-sm text-sw-text">{{ statusMessage }}</p>
          </div>
        }
      }
      @if (projectState.needsRestart && projectState.status === 'ready') {
        <div
          class="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-sw-bg-darkest/[0.92]"
          role="alertdialog"
          aria-modal="true"
          aria-label="Container restart required"
          data-testid="restart-overlay"
        >
          @if (projectState.restarting) {
            <div
              class="w-8 h-8 border-[3px] border-sw-border-dark border-t-sw-accent rounded-full animate-sw-spin"
            ></div>
            <p class="mt-4 font-mono text-sm text-sw-text">Restarting containers...</p>
            <p class="mt-2 font-mono text-[11px] text-sw-text-faint">
              This may take a minute while containers are recreated
            </p>
          } @else {
            <span class="text-sw-accent text-lg font-mono font-bold">Restart Required</span>
            <p class="mt-3 max-w-md text-center font-mono text-sm text-sw-text-muted">
              Changes require container restart to take effect.
            </p>
            @if (projectState.restartError) {
              <div
                class="mt-3 px-3 py-2 bg-sw-error-bg border border-sw-accent rounded text-sw-accent text-[13px] max-w-md text-center"
                data-testid="restart-error"
              >
                {{ projectState.restartError }}
              </div>
            }
            <div class="mt-6 flex gap-3">
              <button
                class="px-6 py-2.5 rounded text-sm font-semibold font-mono border-none cursor-pointer transition-colors bg-sw-accent text-white hover:bg-sw-accent-hover"
                data-testid="restart-now-btn"
                (click)="restartContainers()"
              >
                Restart Now
              </button>
              <button
                class="px-6 py-2.5 rounded text-sm font-semibold font-mono border border-sw-border bg-transparent text-sw-text cursor-pointer transition-colors hover:bg-sw-bg-dark"
                data-testid="restart-later-btn"
                (click)="dismissRestart()"
              >
                Later
              </button>
            </div>
          }
        </div>
      }
      <app-update-notification />
      <header
        class="grid grid-cols-3 items-center px-4 py-2 bg-sw-bg-dark border-b border-sw-border"
      >
        <span
          class="flex items-center justify-self-start"
          data-testid="shell-title"
          aria-label="Speedwave"
        >
          <svg
            viewBox="0 0 82 80"
            class="h-[36px] w-auto"
            aria-hidden="true"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M82 27.4473L68.4717 52.2275L24.4268 80L0 66.2764V9.62598L33.1777 0L82 27.4473Z"
              fill="#000000"
            />
            <path
              d="M31 51H39.5L50 38V47H53.5L61 33H57.1631L53.5 39.5L53.5811 33H48.5L39 45L45.5 33L43 29L31 51Z"
              fill="#FFFFFF"
            />
            <path
              d="M10 41.5H27.5L26.2695 43.7061H8.85254L7 47H29.0293L33.8281 38.3525H16.7383L17.9121 36.2939H35L37 33H15L10 41.5Z"
              fill="#FFFFFF"
            />
          </svg>
        </span>
        <nav class="flex gap-4 justify-self-center" data-testid="app-nav">
          @if (projectState.status === 'ready' || projectState.status === 'error') {
            <a
              routerLink="/chat"
              routerLinkActive="!text-sw-accent font-bold"
              class="text-sw-text-muted no-underline text-[13px] font-mono px-2 py-1 rounded transition-colors duration-200 hover:text-sw-text"
              data-testid="nav-chat"
              >Chat</a
            >
          }
          <a
            routerLink="/integrations"
            routerLinkActive="!text-sw-accent font-bold"
            class="text-sw-text-muted no-underline text-[13px] font-mono px-2 py-1 rounded transition-colors duration-200 hover:text-sw-text"
            data-testid="nav-integrations"
            >Integrations</a
          >
          <a
            routerLink="/plugins"
            routerLinkActive="!text-sw-accent font-bold"
            class="text-sw-text-muted no-underline text-[13px] font-mono px-2 py-1 rounded transition-colors duration-200 hover:text-sw-text"
            data-testid="nav-plugins"
            >Plugins</a
          >
          <a
            routerLink="/settings"
            routerLinkActive="!text-sw-accent font-bold"
            class="text-sw-text-muted no-underline text-[13px] font-mono px-2 py-1 rounded transition-colors duration-200 hover:text-sw-text"
            data-testid="nav-settings"
            >Settings</a
          >
        </nav>
        <div class="justify-self-end">
          <app-project-switcher />
        </div>
      </header>
      <main class="flex-1 overflow-y-auto overflow-x-hidden">
        <router-outlet />
      </main>
    </div>
  `,
})
export class ShellComponent implements OnInit, OnDestroy {
  readonly projectState = inject(ProjectStateService);
  private cdr = inject(ChangeDetectorRef);
  private unsubscribe: (() => void) | null = null;

  /** Human-readable status message for the blocking overlay. */
  get statusMessage(): string {
    switch (this.projectState.status) {
      case 'loading':
        return 'Loading...';
      case 'system_check':
        return 'Running system checks...';
      case 'checking':
        return 'Checking containers...';
      case 'starting':
        return 'Starting containers...';
      case 'switching':
        return 'Switching project...';
      case 'rebuilding':
        return 'Rebuilding container images...';
      default:
        return '';
    }
  }

  /** Bootstraps ProjectStateService and subscribes to state changes. */
  ngOnInit(): void {
    this.projectState.init();
    this.unsubscribe = this.projectState.onChange(() => {
      this.cdr.markForCheck();
    });
  }

  /** Retries container lifecycle check. */
  retry(): void {
    this.projectState.ensureContainersRunning();
  }

  /** Retries system check (prereqs + security). */
  retryCheck(): void {
    this.projectState.ensureContainersRunning();
  }

  /** Triggers a container restart from the overlay. */
  restartContainers(): void {
    this.projectState.restartContainers();
  }

  /** Dismisses the restart overlay. */
  dismissRestart(): void {
    this.projectState.dismissRestart();
  }

  /** Dismisses the error banner. */
  async dismiss(): Promise<void> {
    await this.projectState.dismissError();
    this.cdr.markForCheck();
  }

  /** Cleans up the project state subscription. */
  ngOnDestroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}
