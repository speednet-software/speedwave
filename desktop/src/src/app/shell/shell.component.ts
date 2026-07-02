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
import { BetaService } from '../services/beta.service';
import { ProjectStateService } from '../services/project-state.service';
import { UiStateService } from '../services/ui-state.service';
import { CommandPaletteComponent } from './command-palette/command-palette.component';
import { ModalOverlayComponent } from './modal-overlay/modal-overlay.component';
import { NavRailComponent, type NavRailEntry } from './nav-rail/nav-rail.component';
import { SpinIconComponent } from '../shared/spin-icon.component';
import { CloudStorageModalComponent } from '../shared/cloudstorage-modal/cloudstorage-modal.component';

/**
 * Application shell — hosts the icon rail, routed content, global keyboard
 * shortcuts, and the blocking overlays (loading / check-failed / restart / error).
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
    SpinIconComponent,
    CloudStorageModalComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onKeydown($event)' },
  template: `
    <div
      class="flex h-screen flex-col border-t border-[var(--line)] bg-[var(--bg)] text-[var(--ink)]"
    >
      @if (
        projectState.status() !== 'ready' &&
        projectState.status() !== 'auth_required' &&
        projectState.status() !== 'no_provider'
      ) {
        @if (projectState.status() === 'check_failed') {
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
        } @else if (projectState.status() === 'error') {
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
            <app-spin-icon class="block h-8 w-8 text-[var(--accent)]" />
            <p class="mono mt-4 text-sm text-[var(--ink)]">{{ statusMessage }}</p>
          </div>
        }
      }
      @if (
        projectState.needsRestart &&
        (projectState.status() === 'ready' || projectState.status() === 'auth_required')
      ) {
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
                <app-spin-icon class="block h-8 w-8 text-[var(--accent)]" />
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
            modalTitle="Container config changed"
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

      <!-- CloudStorage TCC modal — shown when project dir is in OneDrive/Dropbox/etc. and TCC is denied -->
      <app-cloudstorage-modal
        [visible]="projectState.errorKind === 'cloudstorage_tcc_required'"
        [provider]="projectState.failureProvider"
      />

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

      @if (beta.enabled()) {
        <span
          class="mono pointer-events-none fixed bottom-1.5 right-2 z-[1000] select-none rounded border border-[var(--line)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[var(--ink-mute)]"
          data-testid="beta-badge"
          aria-label="Beta features enabled"
          >Beta</span
        >
      }
    </div>
  `,
})
export class ShellComponent implements OnInit, OnDestroy {
  readonly projectState = inject(ProjectStateService);
  readonly ui = inject(UiStateService);
  readonly beta = inject(BetaService);
  private cdr = inject(ChangeDetectorRef);
  private router = inject(Router);
  private unsubscribe: (() => void) | null = null;
  private routerSub: Subscription | null = null;

  /** Catalog of every nav entry — order matches the rail top-down. */
  private readonly entryCatalog: readonly NavRailEntry[] = [
    { id: 'chat', label: 'Chat', route: '/chat', iconName: 'message-circle', shortcut: '⌘1' },
    {
      id: 'integrations',
      label: 'Integrations',
      route: '/integrations',
      iconName: 'code',
      shortcut: '⌘2',
    },
    {
      id: 'plugins',
      label: 'Plugins',
      route: '/plugins',
      iconName: 'cube',
      shortcut: '⌘3',
    },
    {
      id: 'meeting-transcription',
      label: 'Meeting transcription',
      route: '/meeting-transcription',
      iconName: 'microphone',
      shortcut: '⌘4',
    },
    {
      id: 'usage',
      label: 'LLM usage',
      route: '/usage',
      iconName: 'chart',
      shortcut: '⌘5',
    },
    {
      id: 'settings',
      label: 'Settings',
      route: '/settings',
      iconName: 'settings',
      shortcut: '⌘,',
    },
    { id: 'logs', label: 'Logs & Health', route: '/logs', iconName: 'document', shortcut: '⌘L' },
  ];

  private readonly currentUrlSignal = signal<string>(this.router.url);

  /** Nav entries to render: chat always visible; meeting-transcription beta-gated (ADR-058/056). */
  readonly visibleEntries = computed(() =>
    this.beta.enabled()
      ? this.entryCatalog
      : this.entryCatalog.filter((e) => e.id !== 'meeting-transcription')
  );

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
    switch (this.projectState.status()) {
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
      case 'no_provider':
        return 'No LLM provider selected.';
      default:
        return '';
    }
  }

  /** Bootstraps project state and tracks the current URL. */
  ngOnInit(): void {
    this.projectState.init();
    this.unsubscribe = this.projectState.onChange(() => {
      this.cdr.markForCheck();
    });
    this.routerSub = this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => this.currentUrlSignal.set(e.urlAfterRedirects));
  }

  /**
   * Global keyboard shortcuts.
   * @param event - keyboard event; consumed via preventDefault on every match.
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
      case '4':
        event.preventDefault();
        // Beta-gated route — the shortcut is inert until beta is enabled.
        if (this.beta.enabled()) {
          void this.router.navigateByUrl('/meeting-transcription');
        }
        return;
      case '5':
        event.preventDefault();
        void this.router.navigateByUrl('/usage');
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
