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
import { TauriService } from '../services/tauri.service';

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
      @if (projectState.status !== 'ready') {
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
        } @else if (projectState.status === 'auth_required') {
          <div
            class="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-sw-bg-darkest"
            data-testid="blocking-auth-required"
          >
            <span class="text-sw-accent text-lg font-mono font-bold">Authentication Required</span>
            <p class="mt-4 max-w-lg text-center font-mono text-sm text-sw-text-muted">
              Claude Code needs to be authenticated before you can start a conversation. Click
              "Authenticate" to open a terminal and complete the login.
            </p>
            <div class="mt-6 flex gap-3">
              <button
                class="px-6 py-2.5 rounded text-sm font-semibold font-mono border-none cursor-pointer transition-colors bg-sw-accent text-white hover:bg-sw-accent-hover"
                data-testid="auth-authenticate-btn"
                (click)="openAuthTerminal()"
              >
                Authenticate
              </button>
              <button
                class="px-6 py-2.5 rounded text-sm font-semibold font-mono border border-sw-border bg-transparent text-sw-text cursor-pointer transition-colors hover:bg-sw-bg-dark"
                data-testid="auth-check-btn"
                (click)="checkAuth()"
              >
                Check Status
              </button>
            </div>
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
            data-testid="blocking-overlay"
          >
            <div
              class="w-8 h-8 border-[3px] border-sw-border-dark border-t-sw-accent rounded-full animate-sw-spin"
            ></div>
            <p class="mt-4 font-mono text-sm text-sw-text">{{ statusMessage }}</p>
          </div>
        }
      }
      <app-update-notification />
      <header
        class="flex items-center justify-between px-4 py-2 bg-sw-bg-dark border-b border-sw-border"
      >
        <span class="font-mono text-[16px] font-bold text-sw-accent" data-testid="shell-title"
          >Speedwave</span
        >
        <nav class="flex gap-4" data-testid="app-nav">
          <a
            routerLink="/chat"
            routerLinkActive="!text-sw-accent font-bold"
            class="text-sw-text-muted no-underline text-[13px] font-mono px-2 py-1 rounded transition-colors duration-200 hover:text-sw-text"
            data-testid="nav-chat"
            >Chat</a
          >
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
        <app-project-switcher />
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
  private tauri = inject(TauriService);
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

  /** Opens a native terminal for Claude OAuth login. */
  async openAuthTerminal(): Promise<void> {
    const project = this.projectState.activeProject;
    if (project) {
      try {
        await this.tauri.invoke('open_auth_terminal', { project });
      } catch (err) {
        this.projectState.error = `Failed to open terminal: ${err}`;
        this.cdr.markForCheck();
      }
    }
  }

  /** Re-checks auth status after user completes authentication. */
  async checkAuth(): Promise<void> {
    await this.projectState.retryAuth();
    this.cdr.markForCheck();
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
