import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { ProjectSwitcherComponent } from '../project-switcher/project-switcher.component';
import { UpdateNotificationComponent } from '../update-notification/update-notification.component';

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
      <app-update-notification />
      <header class="app-header">
        <span class="app-title" data-testid="shell-title">Speedwave</span>
        <nav class="app-nav">
          <a routerLink="/chat" routerLinkActive="active" data-testid="nav-chat">Chat</a>
          <a routerLink="/integrations" routerLinkActive="active" data-testid="nav-integrations"
            >Integrations</a
          >
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
    `,
  ],
})
export class ShellComponent {}
