import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  Input,
  OnDestroy,
  OnInit,
  ViewChild,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TauriService } from '../services/tauri.service';
import type { BridgeStatus, ContainerHealth, HealthReport } from '../models/health';

/** Displays real-time system health status including VM, containers, IDE bridge, and mcp-os. */
@Component({
  selector: 'app-system-health',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="health-container">
      <div class="health-header">
        <h2>System Health</h2>
        <button
          class="refresh-btn"
          data-testid="health-refresh"
          (click)="refresh()"
          [disabled]="loading"
        >
          {{ loading ? 'Checking...' : 'Refresh' }}
        </button>
      </div>

      @if (error) {
        <div class="error-banner">{{ error }}</div>
      }

      <div class="status-grid">
        <div class="status-card">
          <div class="card-header">
            <span
              class="indicator"
              [class.green]="report?.overall_healthy"
              [class.red]="report !== null && !report.overall_healthy"
              [class.gray]="report === null"
            ></span>
            <span class="card-title">Overall Status</span>
          </div>
          <div class="card-value">
            @if (report === null) {
              Not connected
            } @else if (report.overall_healthy) {
              Healthy
            } @else {
              Unhealthy
            }
          </div>
        </div>

        <div class="status-card">
          <div class="card-header">
            <span
              class="indicator"
              [class.green]="report?.vm?.running"
              [class.red]="report !== null && !report.vm.running"
              [class.gray]="report === null"
            ></span>
            <span class="card-title">VM</span>
          </div>
          <div class="card-value">
            @if (report === null) {
              Not connected
            } @else if (report.vm.running) {
              Running ({{ report.vm.vm_type }})
            } @else {
              Stopped
            }
          </div>
        </div>

        <div class="status-card">
          <div class="card-header">
            <span
              class="indicator"
              [class.green]="report?.mcp_os?.running"
              [class.red]="report !== null && !report.mcp_os.running"
              [class.gray]="report === null"
            ></span>
            <span class="card-title">mcp-os</span>
          </div>
          <div class="card-value">
            @if (report === null) {
              Not connected
            } @else if (report.mcp_os.running) {
              Running
            } @else {
              Stopped
            }
          </div>
        </div>

        <div class="status-card">
          <div class="card-header">
            <span
              class="indicator"
              [class.green]="bridgeStatus !== null"
              [class.red]="report !== null && bridgeStatus === null"
              [class.gray]="report === null"
            ></span>
            <span class="card-title">IDE Bridge</span>
          </div>
          <div class="card-value">
            @if (report === null) {
              Not connected
            } @else if (bridgeStatus) {
              <span class="port-badge">:{{ bridgeStatus.port }}</span>
              @if (bridgeStatus.upstream_ide) {
                <span class="upstream-arrow">&rarr;</span>
                <span class="ide-name">{{ bridgeStatus.upstream_ide }}</span>
                <span class="port-badge">:{{ bridgeStatus.upstream_port }}</span>
              } @else {
                <span class="stub-mode">(stub mode)</span>
              }
            } @else if (report.ide_bridge.running) {
              @for (ide of report.ide_bridge.detected_ides; track ide.ide_name + ':' + ide.port) {
                <div class="ide-entry">
                  <span class="ide-name">{{ ide.ide_name }}</span>
                  @if (ide.port !== null) {
                    <span class="port-badge">:{{ ide.port }}</span>
                  }
                </div>
              }
            } @else {
              Stopped
            }
          </div>
        </div>
      </div>

      @if (lastEvent) {
        <div class="event-banner" [class.fading]="eventFading">
          {{ lastEvent }}
        </div>
      }

      <div class="containers-section">
        <h3>Containers</h3>
        @if (report === null) {
          <div class="no-data">Not connected — unable to fetch container status.</div>
        } @else if (report.containers.length === 0) {
          <div class="no-data">No containers running for this project.</div>
        } @else {
          <div class="container-list">
            @for (container of report.containers; track container.name) {
              <div
                class="container-row clickable"
                [class.selected]="selectedContainer === container.name"
                (click)="selectContainer(container.name)"
                (keydown.enter)="selectContainer(container.name)"
                tabindex="0"
                role="button"
              >
                <span
                  class="indicator"
                  [class.green]="container.healthy"
                  [class.red]="!container.healthy"
                ></span>
                <span class="container-name">{{ container.name }}</span>
                <span
                  class="container-status"
                  [class.healthy]="container.healthy"
                  [class.unhealthy]="!container.healthy"
                >
                  {{ container.status }}
                </span>
              </div>
            }
          </div>
        }
      </div>

      @if (selectedContainer !== null) {
        <div class="log-section">
          <div class="log-header">
            <h3>Logs</h3>
            <div class="log-controls">
              <label class="lines-label">
                Lines:
                <input
                  type="number"
                  class="lines-input"
                  [(ngModel)]="tailLines"
                  min="1"
                  max="10000"
                />
              </label>
              <button
                class="log-btn"
                data-testid="health-logs-refresh"
                (click)="fetchLogs()"
                [disabled]="logLoading"
              >
                {{ logLoading ? 'Loading...' : 'Refresh' }}
              </button>
              <button
                class="log-btn close-btn"
                data-testid="health-logs-close"
                (click)="closeLogs()"
              >
                Close
              </button>
            </div>
          </div>

          <div class="log-tabs">
            <button class="log-tab" [class.active]="showAllLogs" (click)="selectAllLogs()">
              All
            </button>
            @if (report !== null) {
              @for (container of report.containers; track container.name) {
                <button
                  class="log-tab"
                  [class.active]="selectedContainer === container.name"
                  (click)="selectContainer(container.name)"
                >
                  {{ container.name }}
                </button>
              }
            }
          </div>

          @if (logError) {
            <div class="error-banner">{{ logError }}</div>
          }

          <pre class="log-output" #logOutput>{{ logContent }}</pre>
        </div>
      }

      <div class="last-updated">
        @if (lastUpdated) {
          Last updated: {{ lastUpdated | date: 'HH:mm:ss' }}
        } @else {
          Waiting for first health check...
        }
      </div>
    </div>
  `,
  styles: [
    `
      .health-container {
        max-width: 700px;
        margin: 0 auto;
        padding: 0;
      }
      .health-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 24px;
      }
      h2 {
        font-size: 18px;
        color: #e94560;
        margin: 0;
      }
      h3 {
        font-size: 15px;
        color: #e0e0e0;
        margin: 0 0 12px 0;
      }
      .refresh-btn {
        padding: 6px 16px;
        background: #0f3460;
        color: #e0e0e0;
        border: 1px solid #0f3460;
        border-radius: 4px;
        font-size: 13px;
        font-family: monospace;
        cursor: pointer;
        transition: background 0.2s;
      }
      .refresh-btn:hover:not(:disabled) {
        background: #1a4a7a;
      }
      .refresh-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .error-banner {
        margin-bottom: 16px;
        padding: 8px 12px;
        background: #3d0000;
        border: 1px solid #e94560;
        border-radius: 4px;
        color: #e94560;
        font-size: 13px;
      }
      .status-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 12px;
        margin-bottom: 24px;
      }
      .ide-entry {
        display: flex;
        align-items: baseline;
        gap: 4px;
        line-height: 1.6;
      }
      .ide-name {
        font-size: 13px;
        color: #e0e0e0;
      }
      .port-badge {
        font-family: monospace;
        font-size: 12px;
        color: #2ecc71;
      }
      .status-card {
        background: #16213e;
        border: 1px solid #0f3460;
        border-radius: 8px;
        padding: 16px;
      }
      .card-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }
      .card-title {
        font-size: 12px;
        color: #888;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .card-value {
        font-size: 14px;
        font-weight: 600;
        color: #e0e0e0;
      }
      .indicator {
        display: inline-block;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #555;
        flex-shrink: 0;
      }
      .indicator.green {
        background: #2ecc71;
        box-shadow: 0 0 6px rgba(46, 204, 113, 0.4);
      }
      .indicator.red {
        background: #e94560;
        box-shadow: 0 0 6px rgba(233, 69, 96, 0.4);
      }
      .indicator.gray {
        background: #555;
      }
      .containers-section {
        background: #16213e;
        border: 1px solid #0f3460;
        border-radius: 8px;
        padding: 16px;
        margin-bottom: 16px;
      }
      .container-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .container-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 12px;
        background: #1a1a2e;
        border-radius: 4px;
      }
      .container-row.clickable {
        cursor: pointer;
        transition: background 0.15s;
      }
      .container-row.clickable:hover {
        background: #222244;
      }
      .container-row.selected {
        background: #222244;
        border-left: 3px solid #e94560;
      }
      .container-name {
        flex: 1;
        font-family: monospace;
        font-size: 13px;
        color: #e0e0e0;
      }
      .container-status {
        font-size: 12px;
        font-family: monospace;
        padding: 2px 8px;
        border-radius: 3px;
      }
      .container-status.healthy {
        color: #2ecc71;
        background: rgba(46, 204, 113, 0.1);
      }
      .container-status.unhealthy {
        color: #e94560;
        background: rgba(233, 69, 96, 0.1);
      }
      .no-data {
        color: #888;
        font-size: 13px;
        padding: 8px 0;
      }
      .log-section {
        background: #16213e;
        border: 1px solid #0f3460;
        border-radius: 8px;
        padding: 16px;
        margin-bottom: 16px;
      }
      .log-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 12px;
      }
      .log-controls {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .lines-label {
        font-size: 12px;
        color: #888;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .lines-input {
        width: 60px;
        padding: 3px 6px;
        background: #1a1a2e;
        border: 1px solid #0f3460;
        border-radius: 3px;
        color: #e0e0e0;
        font-family: monospace;
        font-size: 12px;
      }
      .log-btn {
        padding: 4px 12px;
        background: #0f3460;
        color: #e0e0e0;
        border: 1px solid #0f3460;
        border-radius: 4px;
        font-size: 12px;
        font-family: monospace;
        cursor: pointer;
        transition: background 0.2s;
      }
      .log-btn:hover:not(:disabled) {
        background: #1a4a7a;
      }
      .log-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .close-btn {
        background: #3d0000;
        border-color: #e94560;
      }
      .close-btn:hover {
        background: #5a0000;
      }
      .log-tabs {
        display: flex;
        gap: 4px;
        margin-bottom: 12px;
        flex-wrap: wrap;
      }
      .log-tab {
        padding: 4px 12px;
        background: #1a1a2e;
        color: #888;
        border: 1px solid #0f3460;
        border-radius: 12px;
        font-size: 11px;
        font-family: monospace;
        cursor: pointer;
        transition:
          background 0.15s,
          color 0.15s;
      }
      .log-tab:hover {
        color: #e0e0e0;
      }
      .log-tab.active {
        background: #e94560;
        color: #fff;
        border-color: #e94560;
      }
      .log-output {
        background: #0d0d1a;
        border: 1px solid #0f3460;
        border-radius: 4px;
        padding: 12px;
        margin: 0;
        max-height: 400px;
        overflow: auto;
        font-family: monospace;
        font-size: 12px;
        line-height: 1.4;
        color: #c0c0c0;
        white-space: pre-wrap;
        overflow-wrap: break-word;
      }
      .last-updated {
        text-align: center;
        color: #555;
        font-size: 12px;
      }
      .upstream-arrow {
        color: #2ecc71;
        margin: 0 4px;
        font-size: 13px;
      }
      .stub-mode {
        color: #888;
        font-size: 12px;
        margin-left: 4px;
      }
      .event-banner {
        margin-bottom: 16px;
        padding: 8px 12px;
        background: #1a2840;
        border: 1px solid #0f3460;
        border-radius: 4px;
        color: #aac;
        font-family: monospace;
        font-size: 12px;
        transition: opacity 1s ease-out;
      }
      .event-banner.fading {
        opacity: 0;
      }
    `,
  ],
})
export class SystemHealthComponent implements OnInit, OnDestroy {
  @Input() project: string | null = null;

  report: HealthReport | null = null;
  loading = false;
  error: string | null = null;
  lastUpdated: Date | null = null;

  bridgeStatus: BridgeStatus | null = null;
  selectedIde: { ide_name: string; port: number } | null = null;
  lastEvent: string | null = null;
  eventFading = false;

  logContent = '';
  logLoading = false;
  logError: string | null = null;
  selectedContainer: string | null = null;
  showAllLogs = false;
  tailLines = 200;

  @ViewChild('logOutput') private logOutputRef?: ElementRef<HTMLPreElement>;

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private eventTimerId: ReturnType<typeof setTimeout> | null = null;
  private unlistenEvent: (() => void) | null = null;
  private unlistenReconciled: (() => void) | null = null;
  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);

  /** Starts periodic health polling and subscribes to IDE bridge events. */
  ngOnInit(): void {
    this.refresh();
    // 15s balances responsiveness with resource usage: health checks shell out to
    // nerdctl compose ps (VM round-trip on macOS/Windows) which is expensive at
    // high frequency. 5s caused noticeable CPU overhead on low-power machines.
    // IDE bridge events provide instant feedback for the most common status changes.
    this.intervalId = setInterval(() => this.refresh(), 15000);

    this.tauri
      .listen<{ kind: string; detail: string }>('ide_bridge_event', (event) => {
        this.lastEvent = `${event.payload.kind}: ${event.payload.detail}`;
        this.eventFading = false;
        this.cdr.markForCheck();
        if (this.eventTimerId !== null) {
          clearTimeout(this.eventTimerId);
        }
        this.eventTimerId = setTimeout(() => {
          this.eventFading = true;
          this.cdr.markForCheck();
          this.eventTimerId = setTimeout(() => {
            this.lastEvent = null;
            this.eventFading = false;
            this.cdr.markForCheck();
            this.eventTimerId = null;
          }, 1000);
        }, 9000);
      })
      .then((unlisten) => {
        this.unlistenEvent = unlisten;
      });

    this.tauri
      .listen('containers_reconciled', () => {
        this.refresh();
      })
      .then((unlisten) => {
        this.unlistenReconciled = unlisten;
      })
      .catch(() => {
        // Tauri event listener not available outside desktop context
      });
  }

  /** Clears polling interval, event timers, and unsubscribes from IDE bridge events. */
  ngOnDestroy(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.eventTimerId !== null) {
      clearTimeout(this.eventTimerId);
      this.eventTimerId = null;
    }
    if (this.unlistenEvent) {
      this.unlistenEvent();
      this.unlistenEvent = null;
    }
    if (this.unlistenReconciled) {
      this.unlistenReconciled();
      this.unlistenReconciled = null;
    }
  }

  /** Fetches the latest health report and IDE bridge status from the Tauri backend. */
  async refresh(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      const result = await this.tauri.invoke<HealthReport>('get_health', {
        project: this.project,
      });
      this.report = result ?? null;
      if (
        this.report !== null &&
        this.selectedContainer !== null &&
        this.selectedContainer !== 'all' &&
        !this.report.containers.some((c: ContainerHealth) => c.name === this.selectedContainer)
      ) {
        this.closeLogs();
      }
      this.lastUpdated = new Date();
    } catch (err) {
      this.error = `Not connected — ${err}`;
      this.report = null;
    } finally {
      this.loading = false;
      this.cdr.markForCheck();
    }

    try {
      this.bridgeStatus =
        (await this.tauri.invoke<BridgeStatus | null>('get_bridge_status')) ?? null;
    } catch {
      this.bridgeStatus = null;
    }

    if (this.bridgeStatus && !this.bridgeStatus.upstream_ide && this.selectedIde) {
      this.selectedIde = null;
    }

    this.cdr.markForCheck();
  }

  /**
   * Selects a single container and fetches its logs.
   * @param name container name to select and display logs for
   */
  selectContainer(name: string): void {
    this.selectedContainer = name;
    this.showAllLogs = false;
    this.fetchLogs();
  }

  /** Switches to the combined compose log view for all containers. */
  selectAllLogs(): void {
    this.selectedContainer = 'all';
    this.showAllLogs = true;
    this.fetchLogs();
  }

  /** Closes the log panel and resets log-related state. */
  closeLogs(): void {
    this.selectedContainer = null;
    this.showAllLogs = false;
    this.logContent = '';
    this.logError = null;
    this.cdr.markForCheck();
  }

  /** Retrieves container or compose logs from the Tauri backend and scrolls to the bottom. */
  async fetchLogs(): Promise<void> {
    if (this.selectedContainer === null) return;
    this.logLoading = true;
    this.logError = null;
    this.logContent = '';
    const lines = Math.max(1, Math.min(10000, Math.floor(this.tailLines) || 200));
    try {
      if (this.showAllLogs) {
        this.logContent = await this.tauri.invoke<string>('get_compose_logs', {
          project: this.project,
          tail: lines,
        });
      } else {
        this.logContent = await this.tauri.invoke<string>('get_container_logs', {
          container: this.selectedContainer,
          tail: lines,
        });
      }
    } catch (err) {
      this.logError = `Failed to fetch logs: ${err}`;
      this.logContent = '';
    } finally {
      this.logLoading = false;
      this.cdr.markForCheck();
      setTimeout(() => {
        if (this.logOutputRef) {
          this.logOutputRef.nativeElement.scrollTop = this.logOutputRef.nativeElement.scrollHeight;
        }
      });
    }
  }
}
