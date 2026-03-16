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
    <div class="app-layout">
      @if (projectState.status !== 'ready') {
        @if (projectState.status === 'error') {
          <div class="blocking-error-banner" data-testid="blocking-error">
            <span>{{ projectState.error }}</span>
            <div class="blocking-error-actions">
              <button (click)="retry()">Retry</button>
              <button (click)="dismiss()">Dismiss</button>
            </div>
          </div>
        } @else {
          <div class="blocking-overlay" data-testid="blocking-overlay">
            <div class="blocking-spinner"></div>
            <p class="blocking-text">{{ statusMessage }}</p>
          </div>
        }
      }
      <app-update-notification />
      <header class="app-header">
        <span class="app-title" data-testid="shell-title">Speedwave</span>
        <nav class="app-nav">
          <a routerLink="/chat" routerLinkActive="active" data-testid="nav-chat">Chat</a>
          <a routerLink="/integrations" routerLinkActive="active" data-testid="nav-integrations"
            >Integrations</a
          >
          <a routerLink="/plugins" routerLinkActive="active" data-testid="nav-plugins">Plugins</a>
          <a routerLink="/settings" routerLinkActive="active" data-testid="nav-settings"
            >Settings</a
          >
        </nav>
        <app-project-switcher />
      </header>
      <main class="app-main">
        <router-outlet />
      </main>
    </div>
  `,
  styles: [
    `
      .app-layout {
        display: flex;
        flex-direction: column;
        height: 100vh;
        background: #1a1a2e;
        color: #e0e0e0;
      }
      .app-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 16px;
        background: #16213e;
        border-bottom: 1px solid #0f3460;
      }
      .app-title {
        font-family: monospace;
        font-size: 16px;
        font-weight: bold;
        color: #e94560;
      }
      .app-nav {
        display: flex;
        gap: 16px;
      }
      .app-nav a {
        color: #888;
        text-decoration: none;
        font-size: 13px;
        font-family: monospace;
        padding: 4px 8px;
        border-radius: 4px;
        transition: color 0.2s;
      }
      .app-nav a:hover {
        color: #e0e0e0;
      }
      .app-nav a.active {
        color: #e94560;
        font-weight: bold;
      }
      .app-main {
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
      }
      .blocking-overlay {
        position: fixed;
        inset: 0;
        z-index: 9999;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        background: rgba(26, 26, 46, 0.92);
      }
      .blocking-spinner {
        width: 32px;
        height: 32px;
        border: 3px solid #333;
        border-top-color: #e94560;
        border-radius: 50%;
        animation: shell-spin 0.8s linear infinite;
      }
      @keyframes shell-spin {
        to {
          transform: rotate(360deg);
        }
      }
      .blocking-text {
        margin-top: 16px;
        font-family: monospace;
        font-size: 14px;
        color: #e0e0e0;
      }
      .blocking-error-banner {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 16px;
        background: #3d0000;
        border-bottom: 1px solid #e94560;
        color: #e94560;
        font-size: 13px;
        font-family: monospace;
      }
      .blocking-error-actions {
        display: flex;
        gap: 8px;
      }
      .blocking-error-banner button {
        background: none;
        border: 1px solid #e94560;
        color: #e94560;
        padding: 2px 10px;
        border-radius: 4px;
        font-size: 12px;
        cursor: pointer;
      }
    `,
  ],
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
