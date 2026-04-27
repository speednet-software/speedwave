import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  inject,
  input,
  model,
  output,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TauriService } from '../../services/tauri.service';

/** Displays logging controls, diagnostics export, and factory reset (danger zone). */
@Component({
  selector: 'app-advanced-section',
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- Logging -->
    <section id="section-logging" class="border-t border-[var(--line)] pt-6">
      <h2 class="view-title text-[16px] text-[var(--ink)]">Logging</h2>

      <div class="mt-3">
        <label
          class="mono mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
          for="log-level"
          >log level</label
        >
        <select
          id="log-level"
          [ngModel]="logLevel()"
          (ngModelChange)="setLogLevel($event)"
          class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
          data-testid="settings-log-level"
        >
          <option value="error">error</option>
          <option value="warn">warn</option>
          <option value="info">info (default)</option>
          <option value="debug">debug</option>
          <option value="trace">trace</option>
        </select>
        <p class="mono mt-1 text-[10px] text-[var(--ink-mute)]">
          Higher levels (debug, trace) produce more output. Verbose library logs (hyper, reqwest)
          are always clamped to warn.
        </p>
      </div>

      <div class="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid="settings-export-diagnostics"
          (click)="exportDiagnostics()"
          [disabled]="diagnosticsExporting || !activeProject()"
        >
          {{ diagnosticsExporting ? 'exporting...' : 'export diagnostics' }}
        </button>
        @if (diagnosticsPath) {
          <span class="mono text-[11px] text-[var(--green)]">{{ diagnosticsPath }}</span>
        }
      </div>
      <p class="mono mt-2 text-[10px] text-[var(--ink-mute)]">
        Collects app logs, container logs, and system info into a sanitized ZIP (no tokens or
        secrets).
      </p>
    </section>

    <!-- Danger zone -->
    <section id="section-danger" class="border-t border-red-500/20 pt-6">
      <h2 class="view-title text-[16px] text-red-300">Danger Zone</h2>
      <div class="mt-3 rounded border border-red-500/30 bg-red-500/5 p-4">
        <div class="mono text-[12px] text-red-200">factory reset</div>
        <p class="mt-1 text-[12px] leading-relaxed text-[var(--ink-dim)]">
          Stops all containers, destroys the VM (macOS), and removes all Speedwave data including
          tokens and plugins. The application will restart and the Setup Wizard will run again.
        </p>
        <div class="mt-3">
          @if (!confirmReset) {
            <button
              type="button"
              class="mono rounded border border-red-500/50 bg-red-500/10 px-3 py-1 text-[11px] text-red-300 hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
              data-testid="settings-reset-btn"
              (click)="confirmReset = true"
              [disabled]="resetting"
            >
              reset everything &rarr;
            </button>
          } @else {
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="mono rounded border border-red-500/50 bg-red-500/10 px-3 py-1 text-[11px] text-red-300 hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="settings-confirm-reset"
                (click)="resetEnvironment()"
                [disabled]="resetting"
              >
                {{ resetting ? 'resetting...' : 'confirm reset' }}
              </button>
              <button
                type="button"
                class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="settings-cancel-reset"
                (click)="confirmReset = false"
                [disabled]="resetting"
              >
                cancel
              </button>
            </div>
          }
        </div>
      </div>
    </section>
  `,
})
export class AdvancedSectionComponent {
  readonly activeProject = input<string | null>(null);
  readonly logLevel = model('info');
  readonly errorOccurred = output<string>();
  readonly resetCompleted = output<void>();

  confirmReset = false;
  resetting = false;
  diagnosticsExporting = false;
  diagnosticsPath = '';

  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);

  /**
   * Changes the runtime log level and persists it to config.
   * @param level - The desired log level (error, warn, info, debug, trace).
   */
  async setLogLevel(level: string): Promise<void> {
    this.logLevel.set(level);
    try {
      await this.tauri.invoke('set_log_level', { level });
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
    this.cdr.markForCheck();
  }

  /** Exports diagnostic data as a sanitized ZIP archive. */
  async exportDiagnostics(): Promise<void> {
    const project = this.activeProject();
    if (!project) return;
    this.diagnosticsExporting = true;
    this.diagnosticsPath = '';
    this.cdr.markForCheck();
    try {
      const path = await this.tauri.invoke<string>('export_diagnostics', {
        project,
      });
      this.diagnosticsPath = path;
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
    this.diagnosticsExporting = false;
    this.cdr.markForCheck();
  }

  /**
   * Performs a factory reset, destroying containers and VM.
   * The backend calls app.restart() and never returns a response,
   * so the lines after invoke() are unreachable in practice —
   * they exist only as a safety net if restart behaviour changes.
   */
  async resetEnvironment(): Promise<void> {
    this.resetting = true;
    try {
      await this.tauri.invoke('factory_reset');
      // app.restart() fires before Tauri can return — this line is unreachable
      this.resetCompleted.emit();
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
    this.resetting = false;
    this.confirmReset = false;
    this.cdr.markForCheck();
  }
}
