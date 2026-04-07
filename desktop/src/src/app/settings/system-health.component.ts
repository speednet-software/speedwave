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
import { ProjectStateService } from '../services/project-state.service';
import type { BridgeStatus, ContainerHealth, HealthReport } from '../models/health';

/** Displays real-time system health status including VM, containers, IDE bridge, and mcp-os. */
@Component({
  selector: 'app-system-health',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="max-w-[700px] mx-auto p-0" data-testid="health-container">
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-lg text-sw-accent m-0">System Health</h2>
        <button
          class="px-4 py-1.5 bg-sw-bg-navy text-sw-text border border-sw-border rounded text-[13px] font-mono cursor-pointer transition-colors duration-200 hover:enabled:bg-sw-btn-hover disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid="health-refresh"
          (click)="refresh()"
          [disabled]="loading"
        >
          {{ loading ? 'Checking...' : 'Refresh' }}
        </button>
      </div>

      @if (error) {
        <div
          class="mb-4 px-3 py-2 bg-sw-error-bg border border-sw-accent rounded text-sw-accent text-[13px]"
          data-testid="error-banner"
        >
          {{ error }}
        </div>
      }

      <div class="grid grid-cols-4 gap-3 mb-6" data-testid="status-grid">
        <div
          class="bg-sw-bg-dark border border-sw-border rounded-lg p-4"
          data-testid="status-card-overall"
        >
          <div class="flex items-center gap-2 mb-2">
            <span
              class="inline-block w-2.5 h-2.5 rounded-full shrink-0"
              [class]="
                report?.overall_healthy
                  ? 'bg-sw-success shadow-[0_0_6px_rgba(46,204,113,0.4)]'
                  : report !== null && !report.overall_healthy
                    ? 'bg-sw-accent shadow-[0_0_6px_rgba(233,69,96,0.4)]'
                    : 'bg-sw-slider'
              "
              data-testid="indicator-overall"
            ></span>
            <span class="text-xs text-sw-text-muted uppercase tracking-wide">Overall Status</span>
          </div>
          <div class="text-sm font-semibold text-sw-text">
            @if (report === null && !error) {
              Checking...
            } @else if (report === null) {
              Not connected
            } @else if (report.overall_healthy) {
              Healthy
            } @else {
              Unhealthy
            }
          </div>
        </div>

        <div
          class="bg-sw-bg-dark border border-sw-border rounded-lg p-4"
          data-testid="status-card-vm"
        >
          <div class="flex items-center gap-2 mb-2">
            <span
              class="inline-block w-2.5 h-2.5 rounded-full shrink-0"
              [class]="
                report?.vm?.running
                  ? 'bg-sw-success shadow-[0_0_6px_rgba(46,204,113,0.4)]'
                  : report !== null && !report.vm.running
                    ? 'bg-sw-accent shadow-[0_0_6px_rgba(233,69,96,0.4)]'
                    : 'bg-sw-slider'
              "
              data-testid="indicator-vm"
            ></span>
            <span class="text-xs text-sw-text-muted uppercase tracking-wide">VM</span>
          </div>
          <div class="text-sm font-semibold text-sw-text">
            @if (report === null && !error) {
              Checking...
            } @else if (report === null) {
              Not connected
            } @else if (report.vm.running) {
              Running ({{ report.vm.vm_type }})
            } @else {
              Stopped
            }
          </div>
        </div>

        <div
          class="bg-sw-bg-dark border border-sw-border rounded-lg p-4"
          data-testid="status-card-mcp-os"
        >
          <div class="flex items-center gap-2 mb-2">
            <span
              class="inline-block w-2.5 h-2.5 rounded-full shrink-0"
              [class]="
                report?.mcp_os?.running
                  ? 'bg-sw-success shadow-[0_0_6px_rgba(46,204,113,0.4)]'
                  : report !== null && !report.mcp_os.running
                    ? 'bg-sw-accent shadow-[0_0_6px_rgba(233,69,96,0.4)]'
                    : 'bg-sw-slider'
              "
              data-testid="indicator-mcp-os"
            ></span>
            <span class="text-xs text-sw-text-muted uppercase tracking-wide">mcp-os</span>
          </div>
          <div class="text-sm font-semibold text-sw-text">
            @if (report === null && !error) {
              Checking...
            } @else if (report === null) {
              Not connected
            } @else if (report.mcp_os.running) {
              Running
            } @else {
              Stopped
            }
          </div>
        </div>

        <div
          class="bg-sw-bg-dark border border-sw-border rounded-lg p-4"
          data-testid="status-card-ide-bridge"
        >
          <div class="flex items-center gap-2 mb-2">
            <span
              class="inline-block w-2.5 h-2.5 rounded-full shrink-0"
              [class]="
                bridgeStatus !== null
                  ? 'bg-sw-success shadow-[0_0_6px_rgba(46,204,113,0.4)]'
                  : report !== null && bridgeStatus === null
                    ? 'bg-sw-accent shadow-[0_0_6px_rgba(233,69,96,0.4)]'
                    : 'bg-sw-slider'
              "
              data-testid="indicator-ide-bridge"
            ></span>
            <span class="text-xs text-sw-text-muted uppercase tracking-wide">IDE Bridge</span>
          </div>
          <div class="text-sm font-semibold text-sw-text">
            @if (report === null && !error) {
              Checking...
            } @else if (report === null) {
              Not connected
            } @else if (bridgeStatus) {
              <span class="font-mono text-xs text-sw-success">:{{ bridgeStatus.port }}</span>
              @if (bridgeStatus.upstream_ide) {
                <span class="text-sw-success mx-1 text-[13px]">&rarr;</span>
                <span class="text-[13px] text-sw-text">{{ bridgeStatus.upstream_ide }}</span>
                <span class="font-mono text-xs text-sw-success"
                  >:{{ bridgeStatus.upstream_port }}</span
                >
              } @else {
                <span class="text-sw-text-muted text-xs ml-1">(stub mode)</span>
              }
            } @else if (report.ide_bridge.running) {
              @for (ide of report.ide_bridge.detected_ides; track ide.ide_name + ':' + ide.port) {
                <div class="flex items-baseline gap-1 leading-relaxed">
                  <span class="text-[13px] text-sw-text">{{ ide.ide_name }}</span>
                  @if (ide.port !== null) {
                    <span class="font-mono text-xs text-sw-success">:{{ ide.port }}</span>
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
        <div
          class="mb-4 px-3 py-2 bg-sw-event-bg border border-sw-border rounded text-sw-text-code font-mono text-xs transition-opacity duration-1000 ease-out"
          [class.opacity-0]="eventFading"
          data-testid="event-banner"
        >
          {{ lastEvent }}
        </div>
      }

      <div
        class="bg-sw-bg-dark border border-sw-border rounded-lg p-4 mb-4"
        data-testid="containers-section"
      >
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-[15px] text-sw-text m-0">Containers</h3>
          <button
            class="px-3 py-1 bg-sw-bg-navy text-sw-text border border-sw-border rounded text-xs font-mono cursor-pointer transition-colors duration-200 hover:enabled:bg-sw-btn-hover disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid="health-recreate"
            (click)="recreateContainers()"
            [disabled]="recreating || !project"
          >
            {{ recreating ? 'Recreating...' : 'Recreate' }}
          </button>
        </div>
        @if (report === null && !error) {
          <div class="text-sw-text-muted text-[13px] py-2" data-testid="no-data">
            Checking container status...
          </div>
        } @else if (report === null) {
          <div class="text-sw-text-muted text-[13px] py-2" data-testid="no-data">
            Not connected — unable to fetch container status.
          </div>
        } @else if (report.containers.length === 0) {
          <div class="text-sw-text-muted text-[13px] py-2" data-testid="no-data">
            No containers running for this project.
          </div>
        } @else {
          <div class="flex flex-col gap-2" data-testid="container-list">
            @for (container of report.containers; track container.name) {
              <div
                class="flex items-center gap-2.5 px-3 py-2 bg-sw-bg-darkest rounded cursor-pointer transition-colors duration-150 hover:bg-sw-error-event"
                [class.bg-sw-error-event]="selectedContainer === container.name"
                [style.border-left-width]="selectedContainer === container.name ? '3px' : ''"
                [class.border-l-sw-accent]="selectedContainer === container.name"
                (click)="selectContainer(container.name)"
                (keydown.enter)="selectContainer(container.name)"
                tabindex="0"
                role="button"
                data-testid="container-row"
              >
                <span
                  class="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                  [class]="
                    container.healthy
                      ? 'bg-sw-success shadow-[0_0_6px_rgba(46,204,113,0.4)]'
                      : 'bg-sw-accent shadow-[0_0_6px_rgba(233,69,96,0.4)]'
                  "
                  data-testid="indicator-container"
                ></span>
                <span
                  class="flex-1 font-mono text-[13px] text-sw-text"
                  data-testid="container-name"
                  >{{ container.name }}</span
                >
                <span
                  class="text-xs font-mono px-2 py-0.5 rounded-sm"
                  [class]="
                    container.healthy
                      ? 'text-sw-success bg-sw-success/10'
                      : 'text-sw-accent bg-sw-accent/10'
                  "
                  data-testid="container-status"
                >
                  {{ container.status }}
                </span>
              </div>
            }
          </div>
        }
      </div>

      @if (selectedContainer !== null) {
        <div
          class="bg-sw-bg-dark border border-sw-border rounded-lg p-4 mb-4"
          data-testid="log-section"
        >
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-[15px] text-sw-text m-0">Logs</h3>
            <div class="flex items-center gap-2">
              <label class="text-xs text-sw-text-muted flex items-center gap-1">
                Lines:
                <input
                  type="number"
                  class="w-[60px] px-1.5 py-0.5 bg-sw-bg-darkest border border-sw-border rounded-sm text-sw-text font-mono text-xs"
                  [(ngModel)]="tailLines"
                  min="1"
                  max="10000"
                  data-testid="lines-input"
                />
              </label>
              <button
                class="px-3 py-1 bg-sw-bg-navy text-sw-text border border-sw-border rounded text-xs font-mono cursor-pointer transition-colors duration-200 hover:enabled:bg-sw-btn-hover disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="health-logs-refresh"
                (click)="fetchLogs()"
                [disabled]="logLoading"
              >
                {{ logLoading ? 'Loading...' : 'Refresh' }}
              </button>
              <button
                class="px-3 py-1 bg-sw-error-bg text-sw-text border border-sw-accent rounded text-xs font-mono cursor-pointer transition-colors duration-200 hover:bg-sw-error-deep"
                data-testid="health-logs-close"
                (click)="closeLogs()"
              >
                Close
              </button>
            </div>
          </div>

          <div class="flex gap-1 mb-3 flex-wrap" data-testid="log-tabs">
            <button
              class="px-3 py-1 bg-sw-bg-darkest border border-sw-border rounded-xl text-[11px] font-mono cursor-pointer transition-colors duration-150 hover:text-sw-text"
              [class]="
                showAllLogs ? 'bg-sw-accent text-white border-sw-accent' : 'text-sw-text-muted'
              "
              (click)="selectAllLogs()"
              data-testid="log-tab-all"
            >
              All
            </button>
            @if (report !== null) {
              @for (container of report.containers; track container.name) {
                <button
                  class="px-3 py-1 bg-sw-bg-darkest border border-sw-border rounded-xl text-[11px] font-mono cursor-pointer transition-colors duration-150 hover:text-sw-text"
                  [class]="
                    selectedContainer === container.name
                      ? 'bg-sw-accent text-white border-sw-accent'
                      : 'text-sw-text-muted'
                  "
                  (click)="selectContainer(container.name)"
                  data-testid="log-tab"
                >
                  {{ container.name }}
                </button>
              }
            }
          </div>

          @if (logError) {
            <div
              class="mb-4 px-3 py-2 bg-sw-error-bg border border-sw-accent rounded text-sw-accent text-[13px]"
              data-testid="log-error-banner"
            >
              {{ logError }}
            </div>
          }

          <pre
            class="bg-sw-bg-deep border border-sw-border rounded p-3 m-0 max-h-[400px] overflow-auto font-mono text-xs leading-snug text-sw-text-silver whitespace-pre-wrap break-words"
            data-testid="log-output"
            #logOutput
            >{{ logContent }}</pre
          >
        </div>
      }

      <div class="text-center text-sw-slider text-xs" data-testid="last-updated">
        @if (lastUpdated) {
          Last updated: {{ lastUpdated | date: 'dd-MM-yyyy HH:mm:ss' }}
        } @else {
          Waiting for first health check...
        }
      </div>
    </div>
  `,
})
export class SystemHealthComponent implements OnInit, OnDestroy {
  @Input() project: string | null = null;

  report: HealthReport | null = null;
  loading = false;
  error: string | null = null;
  // Format 'dd-MM-yyyy HH:mm:ss' in template must match chrono format in log_file.rs:write_log_line()
  lastUpdated: Date | null = null;

  bridgeStatus: BridgeStatus | null = null;
  selectedIde: { ide_name: string; port: number } | null = null;
  lastEvent: string | null = null;
  eventFading = false;

  recreating = false;

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
  private unsubProjectReady: (() => void) | null = null;
  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  private projectState = inject(ProjectStateService);

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

    this.unsubProjectReady = this.projectState.onProjectReady(() => {
      this.refresh();
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
    if (this.unsubProjectReady) {
      this.unsubProjectReady();
      this.unsubProjectReady = null;
    }
  }

  /** Fetches the latest health report and IDE bridge status from the Tauri backend. */
  async refresh(): Promise<void> {
    if (this.projectState.status === 'switching') return;
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

  /** Recreates all containers for the active project (compose down + render + up). */
  async recreateContainers(): Promise<void> {
    if (!this.project) return;
    this.recreating = true;
    this.error = null;
    this.cdr.markForCheck();
    try {
      await this.tauri.invoke('recreate_project_containers', { project: this.project });
      await this.refresh();
    } catch (err) {
      this.error = `Recreate failed: ${err}`;
    } finally {
      this.recreating = false;
      this.cdr.markForCheck();
    }
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
      } else if (this.selectedContainer?.endsWith('_claude')) {
        // Naming convention: compose template names the Claude container
        // `{COMPOSE_PREFIX}_{project}_claude`, so `_claude` suffix is stable.
        // Fetch container logs and session logs in parallel; session logs are best-effort
        const [containerResult, sessionResult] = await Promise.allSettled([
          this.tauri.invoke<string>('get_container_logs', {
            container: this.selectedContainer,
            tail: lines,
          }),
          this.tauri.invoke<string>('get_claude_session_logs', {
            container: this.selectedContainer,
            tail: lines,
          }),
        ]);
        this.logContent = containerResult.status === 'fulfilled' ? containerResult.value : '';
        if (containerResult.status === 'rejected') {
          throw containerResult.reason;
        }
        if (sessionResult.status === 'fulfilled' && sessionResult.value.trim()) {
          this.logContent += '\n--- Claude Session Logs ---\n' + sessionResult.value;
        }
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
