import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  Output,
  inject,
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
    <section class="mb-6">
      <h2 class="text-[15px] text-sw-text m-0 mb-3">Logging</h2>
      <div class="bg-sw-bg-dark border border-sw-border rounded-lg p-4">
        <div class="flex justify-between items-center py-2">
          <label class="text-[13px] text-sw-text-muted min-w-[120px]" for="log-level"
            >Log level</label
          >
          <select
            id="log-level"
            [ngModel]="logLevel"
            (ngModelChange)="setLogLevel($event)"
            class="flex-1 max-w-[340px] px-2.5 py-1.5 bg-sw-bg-abyss border border-sw-border rounded text-sw-text text-[13px] font-mono outline-none focus:border-sw-accent"
            data-testid="settings-log-level"
          >
            <option value="error">Error</option>
            <option value="warn">Warn</option>
            <option value="info">Info (default)</option>
            <option value="debug">Debug</option>
            <option value="trace">Trace</option>
          </select>
        </div>
        <p class="text-[11px] text-sw-text-faint mt-2 mb-0">
          Higher levels (Debug, Trace) produce more output. Verbose library logs (hyper, reqwest)
          are always clamped to Warn.
        </p>
        <div class="flex items-center gap-3 pt-3 pb-1">
          <button
            class="px-5 py-1.5 bg-transparent text-sw-accent border border-sw-accent rounded text-[13px] font-mono cursor-pointer transition-all duration-200 hover:enabled:bg-sw-accent hover:enabled:text-sw-bg-abyss disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid="settings-export-diagnostics"
            (click)="exportDiagnostics()"
            [disabled]="diagnosticsExporting || !activeProject"
          >
            {{ diagnosticsExporting ? 'Exporting...' : 'Export Diagnostics' }}
          </button>
          @if (diagnosticsPath) {
            <span class="text-sw-success text-[13px]">{{ diagnosticsPath }}</span>
          }
        </div>
        <p class="text-[11px] text-sw-text-faint mt-2 mb-0">
          Collects app logs, container logs, and system info into a sanitized ZIP (no tokens or
          secrets).
        </p>
      </div>
    </section>

    <!-- Danger zone -->
    <section class="mb-6">
      <h2 class="text-[15px] text-sw-error m-0 mb-3">Danger Zone</h2>
      <div
        class="bg-sw-bg-dark border border-sw-error rounded-lg p-4 flex justify-between items-center gap-4"
      >
        <div class="flex-1">
          <h3 class="text-sm text-sw-text m-0 mb-1">Factory Reset</h3>
          <p class="text-xs text-sw-text-muted m-0 leading-relaxed">
            Stops all containers, destroys the VM (macOS), and removes all Speedwave data including
            tokens and plugins. The application will restart and the Setup Wizard will run again.
          </p>
        </div>
        <div class="shrink-0">
          @if (!confirmReset) {
            <button
              class="px-4 py-1.5 bg-transparent text-sw-accent border border-sw-accent rounded text-[13px] font-mono cursor-pointer transition-all duration-200 whitespace-nowrap hover:enabled:bg-sw-accent hover:enabled:text-sw-bg-abyss disabled:opacity-40 disabled:cursor-not-allowed"
              data-testid="settings-reset-btn"
              (click)="confirmReset = true"
              [disabled]="resetting"
            >
              Reset
            </button>
          } @else {
            <div class="flex gap-2">
              <button
                class="px-4 py-1.5 bg-transparent text-sw-accent border border-sw-accent rounded text-[13px] font-mono cursor-pointer transition-all duration-200 whitespace-nowrap hover:enabled:bg-sw-accent hover:enabled:text-sw-bg-abyss disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="settings-confirm-reset"
                (click)="resetEnvironment()"
                [disabled]="resetting"
              >
                {{ resetting ? 'Resetting...' : 'Confirm Reset' }}
              </button>
              <button
                class="px-4 py-1.5 bg-transparent text-sw-text-muted border border-sw-text-faint rounded text-[13px] font-mono cursor-pointer transition-all duration-200 hover:enabled:text-sw-text hover:enabled:border-sw-text-muted disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="settings-cancel-reset"
                (click)="confirmReset = false"
                [disabled]="resetting"
              >
                Cancel
              </button>
            </div>
          }
        </div>
      </div>
    </section>
  `,
})
export class AdvancedSectionComponent {
  @Input() activeProject: string | null = null;
  @Input() logLevel = 'info';
  @Output() errorOccurred = new EventEmitter<string>();
  @Output() resetCompleted = new EventEmitter<void>();

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
    this.logLevel = level;
    try {
      await this.tauri.invoke('set_log_level', { level });
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
    this.cdr.markForCheck();
  }

  /** Exports diagnostic data as a sanitized ZIP archive. */
  async exportDiagnostics(): Promise<void> {
    if (!this.activeProject) return;
    this.diagnosticsExporting = true;
    this.diagnosticsPath = '';
    this.cdr.markForCheck();
    try {
      const path = await this.tauri.invoke<string>('export_diagnostics', {
        project: this.activeProject,
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
