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
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- Logging -->
    <section class="section">
      <h2>Logging</h2>
      <div class="info-card">
        <div class="form-row">
          <label class="form-label" for="log-level">Log level</label>
          <select
            id="log-level"
            [ngModel]="logLevel"
            (ngModelChange)="setLogLevel($event)"
            class="form-select"
            data-testid="settings-log-level"
          >
            <option value="error">Error</option>
            <option value="warn">Warn</option>
            <option value="info">Info (default)</option>
            <option value="debug">Debug</option>
            <option value="trace">Trace</option>
          </select>
        </div>
        <p class="note">
          Higher levels (Debug, Trace) produce more output. Verbose library logs (hyper, reqwest)
          are always clamped to Warn.
        </p>
        <div class="form-actions">
          <button
            class="btn-save"
            data-testid="settings-export-diagnostics"
            (click)="exportDiagnostics()"
            [disabled]="diagnosticsExporting || !activeProject"
          >
            {{ diagnosticsExporting ? 'Exporting...' : 'Export Diagnostics' }}
          </button>
          @if (diagnosticsPath) {
            <span class="save-feedback">{{ diagnosticsPath }}</span>
          }
        </div>
        <p class="note">
          Collects app logs, container logs, and system info into a sanitized ZIP (no tokens or
          secrets).
        </p>
      </div>
    </section>

    <!-- Danger zone -->
    <section class="section danger-zone">
      <h2>Danger Zone</h2>
      <div class="danger-card">
        <div class="danger-info">
          <h3>Factory Reset</h3>
          <p>
            Stops all containers, destroys the VM (macOS), and resets setup state. Tokens in
            ~/.speedwave/tokens/ are preserved. After reset the Setup Wizard will run again.
          </p>
        </div>
        <div class="danger-actions">
          @if (!confirmReset) {
            <button
              class="btn-danger"
              data-testid="settings-reset-btn"
              (click)="confirmReset = true"
              [disabled]="resetting"
            >
              Reset
            </button>
          } @else {
            <div class="confirm-actions">
              <button
                class="btn-danger"
                data-testid="settings-confirm-reset"
                (click)="resetEnvironment()"
                [disabled]="resetting"
              >
                {{ resetting ? 'Resetting...' : 'Confirm Reset' }}
              </button>
              <button
                class="btn-cancel"
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
  styles: [
    `
      .section {
        margin-bottom: 24px;
      }
      h2 {
        font-size: 15px;
        color: #e0e0e0;
        margin: 0 0 12px 0;
      }
      .info-card {
        background: #16213e;
        border: 1px solid #0f3460;
        border-radius: 8px;
        padding: 16px;
      }
      .form-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 0;
      }
      .form-row + .form-row {
        border-top: 1px solid #0f3460;
      }
      .form-label {
        font-size: 13px;
        color: #888;
        min-width: 120px;
      }
      .form-select {
        flex: 1;
        max-width: 340px;
        padding: 6px 10px;
        background: #1a1a2e;
        border: 1px solid #0f3460;
        border-radius: 4px;
        color: #e0e0e0;
        font-size: 13px;
        font-family: monospace;
      }
      .form-select:focus {
        outline: none;
        border-color: #e94560;
      }
      .form-actions {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 0 4px 0;
      }
      .btn-save {
        padding: 6px 20px;
        background: transparent;
        color: #e94560;
        border: 1px solid #e94560;
        border-radius: 4px;
        font-size: 13px;
        font-family: monospace;
        cursor: pointer;
        transition: all 0.2s;
      }
      .btn-save:hover:not(:disabled) {
        background: #e94560;
        color: #1a1a2e;
      }
      .btn-save:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .save-feedback {
        color: #4caf50;
        font-size: 13px;
      }
      .note {
        font-size: 11px;
        color: #666;
        margin: 8px 0 0 0;
      }
      .danger-zone h2 {
        color: #e94560;
      }
      .danger-card {
        background: #16213e;
        border: 1px solid #e94560;
        border-radius: 8px;
        padding: 16px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
      }
      .danger-info {
        flex: 1;
      }
      .danger-info h3 {
        font-size: 14px;
        color: #e0e0e0;
        margin: 0 0 4px 0;
      }
      .danger-info p {
        font-size: 12px;
        color: #888;
        margin: 0;
        line-height: 1.5;
      }
      .danger-actions {
        flex-shrink: 0;
      }
      .confirm-actions {
        display: flex;
        gap: 8px;
      }
      .btn-danger {
        padding: 6px 16px;
        background: transparent;
        color: #e94560;
        border: 1px solid #e94560;
        border-radius: 4px;
        font-size: 13px;
        font-family: monospace;
        cursor: pointer;
        transition: all 0.2s;
        white-space: nowrap;
      }
      .btn-danger:hover:not(:disabled) {
        background: #e94560;
        color: #1a1a2e;
      }
      .btn-danger:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .btn-cancel {
        padding: 6px 16px;
        background: transparent;
        color: #888;
        border: 1px solid #555;
        border-radius: 4px;
        font-size: 13px;
        font-family: monospace;
        cursor: pointer;
        transition: all 0.2s;
      }
      .btn-cancel:hover:not(:disabled) {
        color: #e0e0e0;
        border-color: #888;
      }
      .btn-cancel:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
    `,
  ],
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

  /** Performs a factory reset, destroying containers and VM. */
  async resetEnvironment(): Promise<void> {
    this.resetting = true;
    try {
      await this.tauri.invoke('factory_reset');
      this.resetCompleted.emit();
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
    this.resetting = false;
    this.confirmReset = false;
    this.cdr.markForCheck();
  }
}
