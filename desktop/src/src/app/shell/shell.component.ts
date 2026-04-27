import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  computed,
  inject,
  OnDestroy,
  OnInit,
  signal,
} from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import type { Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { ProjectSwitcherComponent } from '../project-switcher/project-switcher.component';
import { UpdateNotificationComponent } from '../update-notification/update-notification.component';
import { ProjectStateService } from '../services/project-state.service';
import { ThemeService } from '../services/theme.service';
import { UiStateService } from '../services/ui-state.service';
import { CommandPaletteComponent } from './command-palette/command-palette.component';
import { ModalOverlayComponent } from './modal-overlay/modal-overlay.component';
import { NavRailComponent, type NavRailEntry } from './nav-rail/nav-rail.component';

/** SVG `d` paths for the rail icons (kept short — single-path glyphs). */
const ICON_CHAT =
  'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 0 1-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z';
const ICON_INTEGRATIONS = 'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4';
const ICON_PLUGINS = 'M20 7 12 3 4 7m16 0-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4';
const ICON_SETTINGS =
  'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z';
const ICON_LOGS =
  'M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.586a1 1 0 0 1 .707.293l5.414 5.414a1 1 0 0 1 .293.707V19a2 2 0 0 1-2 2z';

/**
 * Application shell — hosts the left icon rail, the routed main content, and
 * the global keyboard shortcuts (⌘1/⌘2/⌘3/⌘L for view nav, ⌘B for the
 * conversations drawer, ⌘K for the command palette, ⌘T to cycle accent themes).
 *
 * Blocking overlays (loading / check-failed / restart-required / error banner)
 * live here because they must cover the rail and the routed content alike.
 */
@Component({
  selector: 'app-shell',
  imports: [
    RouterOutlet,
    ProjectSwitcherComponent,
    UpdateNotificationComponent,
    NavRailComponent,
    ModalOverlayComponent,
    CommandPaletteComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onKeydown($event)' },
  template: `
    <div class="flex h-screen flex-col bg-[var(--bg)] text-[var(--ink)]">
      @if (projectState.status !== 'ready' && projectState.status !== 'auth_required') {
        @if (projectState.status === 'check_failed') {
          <div
            class="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-[var(--bg)]"
            data-testid="blocking-check-failed"
          >
            <span class="mono text-lg font-bold text-[var(--accent)]">System Check Failed</span>
            <p
              class="mono mt-4 max-w-lg whitespace-pre-line text-center text-sm text-[var(--ink-mute)]"
            >
              {{ projectState.error }}
            </p>
            <button
              type="button"
              class="mono mt-6 cursor-pointer rounded border-none bg-[var(--accent)] px-6 py-2.5 text-sm font-semibold text-[var(--on-accent)] transition-opacity hover:opacity-90"
              data-testid="check-retry-btn"
              (click)="retryCheck()"
            >
              Retry
            </button>
          </div>
        } @else if (projectState.status === 'error') {
          <div
            class="mono flex items-center justify-between border-b border-red-500/40 bg-red-500/10 px-4 py-2 text-[13px] text-red-300"
            data-testid="blocking-error"
          >
            <span>{{ projectState.error }}</span>
            <div class="flex gap-2">
              <button
                type="button"
                class="cursor-pointer rounded border border-red-500/50 bg-transparent px-2.5 py-0.5 text-xs text-red-300"
                (click)="retry()"
              >
                Retry
              </button>
              <button
                type="button"
                class="cursor-pointer rounded border border-[var(--line)] bg-transparent px-2.5 py-0.5 text-xs text-[var(--ink-mute)]"
                (click)="dismiss()"
              >
                Dismiss
              </button>
            </div>
          </div>
        } @else {
          <div
            class="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-[var(--bg)]/[0.92]"
            role="alertdialog"
            aria-modal="true"
            [attr.aria-label]="statusMessage"
            data-testid="blocking-overlay"
          >
            <div
              class="spin h-8 w-8 rounded-full border-[3px] border-[var(--line-strong)] border-t-[var(--accent)]"
            ></div>
            <p class="mono mt-4 text-sm text-[var(--ink)]">{{ statusMessage }}</p>
          </div>
        }
      }
      @if (projectState.needsRestart && projectState.status === 'ready') {
        @if (projectState.restarting) {
          <div
            class="fixed inset-0 z-[900] flex items-center justify-center bg-black/75 backdrop-blur-sm"
            role="alertdialog"
            aria-modal="true"
            aria-label="Restarting containers"
            data-testid="restart-overlay"
          >
            <div
              class="w-[min(24rem,calc(100vw-2rem))] rounded border border-[var(--line-strong)] bg-[var(--bg-1)] p-5"
            >
              <div class="flex flex-col items-center">
                <div
                  class="spin h-8 w-8 rounded-full border-[3px] border-[var(--line-strong)] border-t-[var(--accent)]"
                ></div>
                <p class="mono mt-4 text-sm text-[var(--ink)]">Restarting containers...</p>
                <p class="mono mt-2 text-[11px] text-[var(--ink-mute)]">This may take a while</p>
              </div>
            </div>
          </div>
        } @else {
          <app-modal-overlay
            [open]="true"
            kicker="⚠ restart required"
            kickerColor="amber"
            title="Container config changed"
            body="Enabling/disabling services needs a container restart. Running conversations will pause briefly."
            [inlineError]="projectState.restartError"
            primaryLabel="restart now"
            secondaryLabel="later"
            testId="restart-overlay"
            primaryTestId="restart-now-btn"
            secondaryTestId="restart-later-btn"
            inlineErrorTestId="restart-error"
            (primary)="restartContainers()"
            (secondary)="dismissRestart()"
            (closed)="dismissRestart()"
          />
        }
      }
      <app-update-notification />

      <div class="flex flex-1 overflow-hidden">
        <app-nav-rail
          [entries]="visibleEntries()"
          [activeId]="activeViewId()"
          (paletteOpened)="ui.togglePalette()"
        />
        <div class="flex flex-1 flex-col overflow-hidden">
          <main class="flex min-h-0 flex-1 flex-col overflow-hidden">
            <router-outlet />
          </main>
        </div>
      </div>

      <!-- Project switcher dropdown — anchored to viewport, toggled by chat header / palette. -->
      <app-project-switcher />

      <!-- Command palette modal — ⌘K opens, ESC (handled in shell) closes. -->
      <app-command-palette />
    </div>
  `,
})
export class ShellComponent implements OnInit, OnDestroy {
  readonly projectState = inject(ProjectStateService);
  readonly ui = inject(UiStateService);
  readonly theme = inject(ThemeService);
  private cdr = inject(ChangeDetectorRef);
  private router = inject(Router);
  private unsubscribe: (() => void) | null = null;
  private routerSub: Subscription | null = null;

  /** Catalog of every nav entry — order matches the rail top-down. */
  private readonly entryCatalog: readonly NavRailEntry[] = [
    { id: 'chat', label: 'Chat', route: '/chat', iconPath: ICON_CHAT, shortcut: '⌘1' },
    {
      id: 'integrations',
      label: 'Integrations',
      route: '/integrations',
      iconPath: ICON_INTEGRATIONS,
      shortcut: '⌘2',
    },
    {
      id: 'plugins',
      label: 'Plugins',
      route: '/plugins',
      iconPath: ICON_PLUGINS,
      shortcut: '⌘3',
    },
    {
      id: 'settings',
      label: 'Settings',
      route: '/settings',
      iconPath: ICON_SETTINGS,
      shortcut: '⌘,',
    },
    { id: 'logs', label: 'Logs & Health', route: '/logs', iconPath: ICON_LOGS, shortcut: '⌘L' },
  ];

  private readonly currentUrlSignal = signal<string>(this.router.url);
  private readonly statusSignal = signal(this.projectState.status);

  /**
   * Catalog of nav entries to render. The chat icon stays visible regardless
   * of project status — when the user lands on `/chat` while authentication
   * is missing, the view itself surfaces the `auth required` block + a link
   * back to Settings instead of silently disappearing from the rail.
   */
  readonly visibleEntries = computed(() => this.entryCatalog);

  /** Active entry id derived from the current router URL — used by the rail. */
  readonly activeViewId = computed(() => {
    const url = this.currentUrlSignal();
    // longest-route-prefix wins so /settings beats /settings-something nonexistent etc.
    const sorted = [...this.entryCatalog].sort((a, b) => b.route.length - a.route.length);
    const match = sorted.find((v) => url.startsWith(v.route));
    return match?.id ?? '';
  });

  /** Human-readable copy for the blocking overlay, keyed off projectState.status. */
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

  /** Bootstraps project state, mirrors status into a signal, and tracks the current URL. */
  ngOnInit(): void {
    this.projectState.init();
    this.unsubscribe = this.projectState.onChange(() => {
      this.statusSignal.set(this.projectState.status);
      this.cdr.markForCheck();
    });
    this.routerSub = this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => this.currentUrlSignal.set(e.urlAfterRedirects));
  }

  /**
   * Global keyboard shortcuts. Wired via `host: { '(document:keydown)': … }` —
   * the `HostListener` decorator is forbidden by the project's best-practices
   * rules.
   * @param event - keyboard event from the document; consumed (preventDefault)
   *   on every match so the platform doesn't apply the default action.
   */
  onKeydown(event: KeyboardEvent): void {
    const cmd = event.metaKey || event.ctrlKey;
    const key = event.key;

    // ⎋ closes any open overlay first — independent of cmd modifier.
    if (key === 'Escape') {
      let consumed = false;
      if (this.ui.paletteOpen()) {
        this.ui.closePalette();
        consumed = true;
      }
      if (this.ui.projectSwitcherOpen()) {
        this.ui.closeProjectSwitcher();
        consumed = true;
      }
      if (consumed) {
        event.preventDefault();
      }
      return;
    }

    if (!cmd) return;

    switch (key.toLowerCase()) {
      case 'k':
        event.preventDefault();
        this.ui.togglePalette();
        return;
      case 'b':
        event.preventDefault();
        this.ui.toggleSidebar();
        return;
      case 't':
        event.preventDefault();
        this.theme.cycle();
        return;
      case '1':
        event.preventDefault();
        void this.router.navigateByUrl('/chat');
        return;
      case '2':
        event.preventDefault();
        void this.router.navigateByUrl('/integrations');
        return;
      case '3':
        event.preventDefault();
        void this.router.navigateByUrl('/plugins');
        return;
      case ',':
        event.preventDefault();
        void this.router.navigateByUrl('/settings');
        return;
      case 'l':
        event.preventDefault();
        void this.router.navigateByUrl('/logs');
        return;
      default:
        return;
    }
  }

  /** Retries the container lifecycle (used by the error banner). */
  retry(): void {
    this.projectState.ensureContainersRunning();
  }

  /** Retries the system check (prereqs + security) on check_failed. */
  retryCheck(): void {
    this.projectState.ensureContainersRunning();
  }

  /** Triggers a container restart from the restart-required overlay. */
  restartContainers(): void {
    this.projectState.restartContainers();
  }

  /** Dismisses the restart-required overlay without restarting. */
  dismissRestart(): void {
    this.projectState.dismissRestart();
  }

  /** Clears the active error banner. */
  async dismiss(): Promise<void> {
    await this.projectState.dismissError();
    this.cdr.markForCheck();
  }

  /** Tears down the projectState and router subscriptions. */
  ngOnDestroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.routerSub) {
      this.routerSub.unsubscribe();
      this.routerSub = null;
    }
  }
}
