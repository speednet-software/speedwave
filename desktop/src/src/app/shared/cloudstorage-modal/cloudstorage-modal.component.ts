import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  inject,
  input,
} from '@angular/core';
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService } from '../../services/project-state.service';
import { LoggerService } from '../../services/logger.service';

/**
 * Modal shown when a CloudStorage TCC permission failure is detected.
 *
 * Provides:
 * - Manual step-by-step instructions (always visible — no System Settings button fallback needed)
 * - "Open System Settings" button that invokes `open_files_folders_pane` (macOS only)
 * - "Retry" button that re-runs `ensureContainersRunning` via `projectState.retry()`
 *
 * The modal is rendered by `ShellComponent` when
 * `projectState.errorKind === 'cloudstorage_tcc_required'`.
 */
@Component({
  selector: 'app-cloudstorage-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <div
        class="fixed inset-0 z-[1200] flex items-center justify-center bg-black/75 backdrop-blur-sm"
        role="alertdialog"
        aria-modal="true"
        aria-label="Cloud storage permission required"
        data-testid="cloudstorage-modal"
      >
        <div
          class="w-[min(30rem,calc(100vw-2rem))] rounded border border-[var(--line-strong)] bg-[var(--bg-1)] p-6"
          role="document"
        >
          <div class="mono text-[11px] uppercase tracking-widest text-[var(--accent)]">
            cloud storage permission required
          </div>
          <h2 class="mono mt-2 text-base font-semibold text-[var(--ink)]">
            Speedwave needs access to{{ providerLabel() }}
          </h2>
          <p class="mono mt-3 text-[13px] text-[var(--ink-mute)]">
            macOS is blocking access to your project folder. Grant permission in System Settings:
          </p>

          <!-- Always-visible manual instructions -->
          <ol class="mono mt-3 list-decimal space-y-1 pl-5 text-[13px] text-[var(--ink-mute)]">
            <li>
              Open
              <strong class="text-[var(--ink)]"
                >System Settings → Privacy &amp; Security → Files and Folders</strong
              >
            </li>
            <li>Find <strong class="text-[var(--ink)]">Speedwave</strong> in the list</li>
            <li>
              Enable access to
              <strong class="text-[var(--ink)]">{{
                providerLabel() || 'your cloud storage folder'
              }}</strong>
            </li>
            <li>Return to Speedwave and click <strong class="text-[var(--ink)]">Retry</strong></li>
          </ol>

          <div class="mt-5 flex gap-3">
            <button
              type="button"
              class="mono cursor-pointer rounded border-none bg-[var(--accent)] px-4 py-2 text-[13px] font-semibold text-[var(--on-accent)] transition-opacity hover:opacity-90"
              data-testid="cloudstorage-open-settings-btn"
              (click)="openSystemSettings()"
            >
              Open System Settings
            </button>
            <button
              type="button"
              class="mono cursor-pointer rounded border border-[var(--line)] bg-transparent px-4 py-2 text-[13px] text-[var(--ink)] hover:bg-[var(--bg-2)]"
              data-testid="cloudstorage-retry-btn"
              (click)="retry()"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class CloudStorageModalComponent {
  /** Controls modal visibility — bind to `projectState.errorKind === 'cloudstorage_tcc_required'`. */
  readonly visible = input<boolean>(false);
  /** Optional provider display name to show in the message (e.g. "OneDrive"). */
  readonly provider = input<string | undefined>(undefined);

  private readonly tauri = inject(TauriService);
  private readonly projectState = inject(ProjectStateService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly log = inject(LoggerService);

  /** Returns " OneDrive" (with leading space) or empty string for template interpolation. */
  providerLabel(): string {
    const p = this.provider();
    return p ? ` ${p}` : '';
  }

  /** Launches macOS System Settings → Privacy & Security → Files and Folders pane. */
  async openSystemSettings(): Promise<void> {
    try {
      await this.tauri.invoke('open_files_folders_pane');
    } catch (err) {
      this.log.warn(`[CloudStorageModal] open_files_folders_pane failed: ${String(err)}`);
    }
  }

  /** Re-triggers container startup after the user grants TCC permission. */
  async retry(): Promise<void> {
    await this.projectState.retry();
    this.cdr.markForCheck();
  }
}
