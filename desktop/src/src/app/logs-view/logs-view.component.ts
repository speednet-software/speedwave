import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  OnDestroy,
  OnInit,
  ViewChild,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import { SystemHealthService } from '../services/system-health.service';
import { ProjectPillComponent } from '../project-switcher/project-pill.component';
import { ModalOverlayComponent } from '../shell/modal-overlay/modal-overlay.component';
import { TooltipDirective } from '../shared/tooltip.directive';

/** Log severity levels recognised by the logs-view filter chips. */
export type LogLevel = 'all' | 'debug' | 'info' | 'warn' | 'error';

/** One parsed log line: source, level, timestamp, message. */
export interface LogLine {
  time: string;
  source: string;
  level: LogLevel;
  message: string;
}

/** Filter state for level + source combined. `'all'` means no filter. */
export interface LogFilters {
  level: LogLevel;
  source: string;
}

/** How many lines to request from the backend on each fetch. */
export const LOGS_TAIL_LINES = 500;

/** Available level chips rendered in the toolbar. */
export const LEVEL_CHIPS: readonly LogLevel[] = ['all', 'debug', 'info', 'warn', 'error'];

// Polling cadence for the system health grid lives in `SystemHealthService`
// (`services/system-health.service.ts`) — the SSOT for the polling loop.

/**
 * Trace-level diagnostics is forced at view init so an exported diagnostics
 * ZIP always carries full context regardless of any prior runtime setting.
 */
const FORCED_LOG_LEVEL = 'trace';

const COMPOSE_RE = /^([\w.-]+)\s*\|\s*(.*)$/;
const BRACKETED_TIME_RE = /^\[(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]\s*(.*)$/;
const ISO_TIME_RE = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+(.*)$/;
/** ISO date+time at the start of a stamped log line (e.g. `2026-04-28T12:34:56.123Z`). */
const FORMAT_TIME_ISO_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/;
/** Bare `HH:MM:SS` prefix used by some compose log lines. Date is filled in from the host clock. */
const FORMAT_TIME_HMS_RE = /^(\d{2}:\d{2}:\d{2})/;
const LEVEL_RE = /^(DEBUG|INFO|WARN|WARNING|ERROR|TRACE)\s+(.*)$/i;
const CONTAINER_PREFIX_RE = /^speedwave_[^_]+_([^_]+)(?:_\d+)?$/;
const TRAILING_INDEX_RE = /_\d+$/;

/**
 * Parse a single compose-log line into `LogLine`. Tolerant — never throws.
 * @param raw - A single log line as emitted by `nerdctl compose logs`.
 */
export function parseLogLine(raw: string): LogLine {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { time: '', source: 'log', level: 'info', message: '' };
  }
  const composeMatch = COMPOSE_RE.exec(trimmed);
  const source = composeMatch ? stripContainerPrefix(composeMatch[1]) : 'log';
  const rest = composeMatch ? composeMatch[2] : trimmed;

  const timeMatch = BRACKETED_TIME_RE.exec(rest) ?? ISO_TIME_RE.exec(rest);
  const time = timeMatch ? timeMatch[1] : '';
  const afterTime = timeMatch ? timeMatch[2] : rest;

  const levelMatch = LEVEL_RE.exec(afterTime);
  const level: LogLevel = levelMatch ? normalizeLevel(levelMatch[1]) : 'info';
  const message = levelMatch ? levelMatch[2] : afterTime;

  return { time, source, level, message };
}

/**
 * Normalise a raw level token to the small enum used by chips.
 * @param raw - Raw level token (e.g. `WARNING`, `TRACE`).
 */
function normalizeLevel(raw: string): LogLevel {
  const upper = raw.toUpperCase();
  if (upper === 'ERROR') return 'error';
  if (upper === 'WARN' || upper === 'WARNING') return 'warn';
  if (upper === 'DEBUG' || upper === 'TRACE') return 'debug';
  return 'info';
}

/**
 * Strip the `speedwave_<project>_` prefix from a container name.
 * @param container - Container name as it appears in compose-log prefixes.
 */
function stripContainerPrefix(container: string): string {
  const match = CONTAINER_PREFIX_RE.exec(container);
  if (match) return match[1];
  return container.replace(TRAILING_INDEX_RE, '');
}

/**
 * Logs view — renders a full-width status bar above a filter toolbar and the
 * log stream. Status sections (overall, VM, containers, IDE bridge) wrap on
 * narrow widths; an expandable details row exposes per-container and
 * detected-IDE diagnostics without permanently stealing vertical space.
 */
@Component({
  selector: 'app-logs-view',
  imports: [ProjectPillComponent, ModalOverlayComponent, RouterLink, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="flex h-11 flex-shrink-0 items-center gap-3 border-b border-[var(--line)] bg-[var(--bg-1)] px-4 md:px-6"
      data-testid="logs-header"
    >
      <h1 class="view-title view-title-page truncate text-[var(--ink)]" data-testid="logs-title">
        System health
      </h1>
      <div class="ml-auto flex flex-shrink-0 items-center gap-3">
        <span
          class="mono hidden text-[11px] text-[var(--ink-mute)] md:inline"
          data-testid="logs-refresh-hint"
        >
          auto-refresh 5s
        </span>
        <span class="hidden text-[var(--line-strong)] md:inline">·</span>
        <app-project-pill />
      </div>
    </div>

    <div
      class="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-[var(--line)] bg-[var(--bg-1)] px-4 py-2.5 md:px-6"
      data-testid="logs-status-bar"
      role="status"
      aria-label="System health summary"
    >
      <button
        type="button"
        class="flex items-center gap-2 text-[13px]"
        data-testid="health-overall"
        [style.color]="overallHealthy() ? 'var(--green)' : 'var(--accent)'"
        [attr.aria-expanded]="detailsOpen()"
        aria-controls="logs-status-details"
        (click)="toggleDetails()"
        [title]="detailsOpen() ? 'Hide details' : 'Show details'"
      >
        <span
          class="dot"
          [style.background]="overallHealthy() ? 'var(--green)' : 'var(--accent)'"
        ></span>
        <span class="font-medium">{{ overallHealthy() ? 'healthy' : 'degraded' }}</span>
        <span
          class="mono text-[10px] text-[var(--ink-mute)]"
          [style.transform]="detailsOpen() ? 'rotate(180deg)' : null"
          aria-hidden="true"
          >▾</span
        >
      </button>

      <span
        class="hidden h-3 w-px bg-[var(--line-strong)] sm:inline-block"
        aria-hidden="true"
      ></span>

      <div class="flex items-center gap-2 text-[12px]" data-testid="health-vm">
        <span class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">vm</span>
        <span
          class="dot"
          [style.background]="vmRunning() ? 'var(--green)' : 'var(--accent)'"
        ></span>
        <span [style.color]="vmRunning() ? 'var(--ink)' : 'var(--accent)'">{{ vmLabel() }}</span>
        <span class="mono text-[10px] text-[var(--ink-mute)]">· {{ vmDetail() }}</span>
      </div>

      <span
        class="hidden h-3 w-px bg-[var(--line-strong)] sm:inline-block"
        aria-hidden="true"
      ></span>

      <div class="flex items-center gap-2 text-[12px]" data-testid="health-containers">
        <span class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
          >containers</span
        >
        <span
          class="dot"
          [style.background]="anyContainerUnhealthy() ? 'var(--amber)' : 'var(--green)'"
        ></span>
        <span [style.color]="anyContainerUnhealthy() ? 'var(--amber)' : 'var(--ink)'">{{
          containersLabel()
        }}</span>
        <span
          class="mono text-[10px]"
          [style.color]="anyContainerUnhealthy() ? 'var(--amber)' : 'var(--ink-mute)'"
          >· {{ containersDetail() }}</span
        >
      </div>

      <span
        class="hidden h-3 w-px bg-[var(--line-strong)] sm:inline-block"
        aria-hidden="true"
      ></span>

      <div class="flex items-center gap-2 text-[12px]" data-testid="health-bridge">
        <span class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
          >ide_bridge</span
        >
        <span
          class="dot"
          [style.background]="bridgeConnected() ? 'var(--green)' : 'var(--ink-mute)'"
        ></span>
        <span [style.color]="bridgeConnected() ? 'var(--ink)' : 'var(--ink-mute)'">{{
          bridgeConnected() ? 'connected' : 'disconnected'
        }}</span>
        <span class="mono text-[10px] text-[var(--ink-mute)]">· {{ bridgeDetail() }}</span>
        @if (bridgeShowConnectLink()) {
          <a
            routerLink="/integrations"
            fragment="ide-bridge"
            class="mono text-[10px] text-[var(--accent)] hover:underline"
            data-testid="bridge-connect-link"
            >connect →</a
          >
        }
      </div>

      <span
        class="hidden h-3 w-px bg-[var(--line-strong)] sm:inline-block"
        aria-hidden="true"
      ></span>

      <div class="flex items-center gap-2 text-[12px]" data-testid="health-mcpos">
        <span class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
          >mcp_os</span
        >
        <span
          class="dot"
          [style.background]="mcpOsRunning() ? 'var(--green)' : 'var(--ink-mute)'"
        ></span>
        <span [style.color]="mcpOsRunning() ? 'var(--ink)' : 'var(--ink-mute)'">{{
          mcpOsRunning() ? 'running' : 'stopped'
        }}</span>
      </div>

      <div class="ml-auto flex items-center gap-2">
        <button
          type="button"
          class="mono flex-shrink-0 rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-50 disabled:cursor-not-allowed"
          appTooltip="Refresh"
          placement="bottom"
          data-testid="logs-refresh"
          [disabled]="loading()"
          (click)="refresh()"
        >
          ↻<span class="hidden sm:inline"> refresh</span>
        </button>
        <button
          type="button"
          class="mono flex-shrink-0 rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid="logs-export"
          [disabled]="diagnosticsExporting() || !projectState.activeProject"
          (click)="exportDiagnostics()"
          appTooltip="Collects app logs, container logs, and system info into a sanitized ZIP (no tokens or secrets)."
          placement="bottom"
        >
          {{ diagnosticsExporting() ? 'exporting…' : 'export diagnostics' }}
        </button>
      </div>
    </div>

    @if (detailsOpen()) {
      <div
        id="logs-status-details"
        class="border-b border-[var(--line)] bg-[var(--bg-1)] px-4 py-3 md:px-6"
        data-testid="logs-status-details"
      >
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <div class="mono mb-1 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
              containers
            </div>
            @if (containerArray().length === 0) {
              <div class="mono text-[11px] text-[var(--ink-mute)]">no containers</div>
            } @else {
              <ul class="space-y-0.5">
                @for (c of containerArray(); track c.name) {
                  <li
                    class="mono flex items-center gap-2 text-[11px]"
                    [attr.data-testid]="'health-container-' + stripPrefix(c.name)"
                  >
                    <span
                      class="dot"
                      [style.background]="c.healthy ? 'var(--green)' : 'var(--amber)'"
                    ></span>
                    <span class="text-[var(--ink)]">{{ stripPrefix(c.name) }}</span>
                    <span class="text-[var(--ink-mute)]">· {{ c.status }}</span>
                  </li>
                }
              </ul>
            }
          </div>
          <div>
            <div class="mono mb-1 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
              detected ides
            </div>
            @if (detectedIdes().length === 0) {
              <div class="mono text-[11px] text-[var(--ink-mute)]">none detected</div>
            } @else {
              <ul class="space-y-0.5">
                @for (ide of detectedIdes(); track ide.ide_name) {
                  <li class="mono text-[11px]" data-testid="health-ide-row">
                    <span class="text-[var(--ink)]">{{ ide.ide_name }}</span>
                    <span class="text-[var(--ink-mute)]"> :{{ ide.port ?? '—' }}</span>
                  </li>
                }
              </ul>
            }
          </div>
        </div>
      </div>
    }

    <div
      class="flex flex-wrap items-center gap-3 border-b border-[var(--line)] bg-[var(--bg-1)] px-4 py-2 md:px-6"
      data-testid="logs-filters"
    >
      <div
        class="mono flex overflow-hidden rounded border border-[var(--line)] text-[11px]"
        role="group"
        aria-label="Log level filter"
        data-testid="logs-level-chips"
      >
        @for (lvl of levelChips; track lvl) {
          <button
            type="button"
            class="px-2.5 py-1"
            [style.background]="filters().level === lvl ? 'var(--bg-2)' : 'transparent'"
            [style.color]="filters().level === lvl ? 'var(--ink)' : 'var(--ink-mute)'"
            [attr.aria-pressed]="filters().level === lvl"
            [attr.data-testid]="'logs-level-' + lvl"
            (click)="setLevel(lvl)"
          >
            {{ lvl }}
          </button>
        }
      </div>

      <label class="mono flex items-center gap-2 text-[11px] text-[var(--ink-mute)]">
        <span>source</span>
        <select
          class="mono min-w-[12rem] rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
          data-testid="logs-source-select"
          aria-label="Filter logs by source"
          [value]="filters().source"
          (change)="onSourceChange($event)"
        >
          @for (opt of sourceOptions(); track opt.value) {
            <option [value]="opt.value">{{ opt.label }}</option>
          }
        </select>
      </label>
    </div>

    @if (error()) {
      <div
        class="border-b border-[var(--line)] bg-[var(--bg-1)] px-4 py-2 md:px-6"
        data-testid="logs-error"
        role="alert"
      >
        <div
          class="rounded ring-1 ring-red-500/40 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-300 mono"
        >
          {{ error() }}
        </div>
      </div>
    }

    <div
      #logScroll
      class="flex-1 overflow-y-auto bg-[var(--bg)] p-4 text-[12px] md:p-6"
      data-testid="logs-scroll"
      role="log"
      aria-live="polite"
      aria-label="Application logs"
    >
      <div class="mono w-full" data-testid="logs-list">
        @if (loading() && lines().length === 0) {
          <p
            class="mono text-[12px] text-[var(--ink-mute)] py-8 text-center"
            data-testid="logs-loading"
          >
            Loading logs…
          </p>
        } @else if (visibleLines().length === 0) {
          <p
            class="mono text-[12px] text-[var(--ink-mute)] py-8 text-center"
            data-testid="logs-empty"
          >
            @if (lines().length === 0) {
              No logs captured yet.
            } @else {
              No log lines match the selected filters.
            }
          </p>
        } @else {
          @for (line of visibleLines(); track $index) {
            <div
              class="flex items-start gap-3 py-1 hover:bg-[var(--bg-1)]"
              data-testid="logs-line"
              [style.background]="line.level === 'error' ? 'rgba(239, 68, 68, 0.05)' : null"
            >
              <span
                class="w-[152px] flex-shrink-0 text-[var(--ink-mute)] tabular-nums"
                data-testid="logs-time"
                [title]="line.time"
              >
                {{ formatTime(line.time) }}
              </span>
              <span
                class="hidden w-80 flex-shrink-0 truncate md:inline-block"
                [style.color]="sourceColour(line)"
                [title]="line.source"
                data-testid="logs-source"
              >
                {{ line.source }}
              </span>
              <span
                class="w-12 flex-shrink-0 md:w-14"
                [style.color]="levelColour(line)"
                data-testid="logs-level"
              >
                {{ line.level }}
              </span>
              <span
                class="min-w-0 flex-1 break-words"
                [style.color]="line.level === 'error' ? '#fca5a5' : 'var(--ink-dim)'"
                data-testid="logs-message"
              >
                {{ line.message }}
              </span>
            </div>
          }
          <div class="py-6 text-center">
            <span class="text-[11px] text-[var(--ink-mute)]">
              ▼ streaming · <span class="text-[var(--accent)]">live</span>
              <span class="caret ml-1"></span>
            </span>
          </div>
        }
      </div>
    </div>

    <app-modal-overlay
      [open]="exportDialogOpen()"
      kicker="✓ export complete"
      kickerColor="green"
      modalTitle="Diagnostics archive saved"
      body="The sanitized ZIP is ready. Share the path below with support or attach the file directly."
      [note]="diagnosticsPath()"
      [primaryLabel]="copyButtonLabel()"
      secondaryLabel="close"
      testId="export-diagnostics-overlay"
      primaryTestId="export-diagnostics-copy"
      secondaryTestId="export-diagnostics-close"
      (primary)="copyDiagnosticsPath()"
      (secondary)="closeExportDialog()"
      (closed)="closeExportDialog()"
    />
  `,
  host: {
    class: 'flex h-full flex-1 flex-col overflow-hidden bg-[var(--bg)] text-[var(--ink)]',
  },
})
export class LogsViewComponent implements OnInit, OnDestroy {
  @ViewChild('logScroll') private logScroll: ElementRef<HTMLDivElement> | null = null;

  /** All parsed log lines from the most recent fetch. */
  readonly lines = signal<LogLine[]>([]);
  /** Active filter selection (level + source). */
  readonly filters = signal<LogFilters>({ level: 'all', source: 'all' });
  /** Loading state — true during the initial fetch. */
  readonly loading = signal<boolean>(true);
  /** Error message from the last fetch, empty when healthy. */
  readonly error = signal<string>('');
  private readonly systemHealth = inject(SystemHealthService);
  /** Latest health report shown above the logs (null until first fetch). */
  readonly health = this.systemHealth.health;
  /** Whether the expandable details row is open. */
  readonly detailsOpen = signal<boolean>(false);
  /** True while a diagnostics export is in flight. */
  readonly diagnosticsExporting = signal<boolean>(false);
  /** Path to the most recently exported diagnostics ZIP (empty when none). */
  readonly diagnosticsPath = signal<string>('');
  /** Visibility of the post-export confirmation dialog. */
  readonly exportDialogOpen = signal<boolean>(false);
  /** Whether the path was just copied — flips the primary button label briefly. */
  readonly diagnosticsCopied = signal<boolean>(false);
  /** Label for the modal's primary button (toggles after a successful copy). */
  readonly copyButtonLabel = computed<string>(() =>
    this.diagnosticsCopied() ? 'copied ✓' : 'copy path'
  );

  /** Distinct source names found in the current log set plus `'all'`. */
  readonly sources = computed<string[]>(() => {
    const distinct = new Set<string>();
    for (const line of this.lines()) distinct.add(line.source);
    return [
      'all',
      ...Array.from(distinct)
        .filter((s) => s !== 'all')
        .sort(),
    ];
  });

  /** Per-source line counts for the source select. */
  private readonly sourceCounts = computed<Map<string, number>>(() => {
    const counts = new Map<string, number>();
    for (const line of this.lines()) {
      counts.set(line.source, (counts.get(line.source) ?? 0) + 1);
    }
    return counts;
  });

  /** Source dropdown options with line counts (`all` shows the total). */
  readonly sourceOptions = computed<{ value: string; label: string }[]>(() => {
    const counts = this.sourceCounts();
    const total = this.lines().length;
    return this.sources().map((src) => {
      if (src === 'all') return { value: 'all', label: `all sources (${total})` };
      return { value: src, label: `${src} (${counts.get(src) ?? 0})` };
    });
  });

  /** Lines after applying the current filters. */
  readonly visibleLines = computed<LogLine[]>(() => {
    const f = this.filters();
    return this.lines().filter((l) => {
      if (f.level !== 'all' && l.level !== f.level) return false;
      if (f.source !== 'all' && l.source !== f.source) return false;
      return true;
    });
  });

  readonly levelChips = LEVEL_CHIPS;

  /** Whether the overall system is healthy. */
  readonly overallHealthy = computed<boolean>(() => this.health()?.overall_healthy ?? false);

  /** Whether the VM is reported as running. */
  readonly vmRunning = computed<boolean>(() => {
    const vm = this.health()?.vm;
    return typeof vm === 'object' && vm !== null ? vm.running === true : false;
  });

  /** Headline label for the VM card. */
  readonly vmLabel = computed<string>(() => {
    const vm = this.health()?.vm;
    if (!vm || typeof vm !== 'object') return 'no data';
    return `${vm.vm_type ?? 'vm'}: ${vm.running ? 'running' : 'stopped'}`;
  });

  /** Detail line under the VM card label. */
  readonly vmDetail = computed<string>(() => {
    const vm = this.health()?.vm;
    if (!vm || typeof vm !== 'object') return '—';
    return vm.running ? 'kernel-level isolation' : 'not started';
  });

  /** True when at least one container is not healthy. */
  readonly anyContainerUnhealthy = computed<boolean>(() => {
    const containers = this.containerArray();
    return containers.some((c) => !c.healthy);
  });

  /** Headline label for the containers card. */
  readonly containersLabel = computed<string>(() => {
    const containers = this.containerArray();
    const total = containers.length;
    const up = containers.filter((c) => c.healthy).length;
    if (total === 0) return 'no containers';
    return `${up} of ${total} up`;
  });

  /** Detail line for the containers card — shows the first unhealthy container if any. */
  readonly containersDetail = computed<string>(() => {
    const containers = this.containerArray();
    const unhealthy = containers.find((c) => !c.healthy);
    if (unhealthy) return `${stripContainerPrefix(unhealthy.name)}: ${unhealthy.status}`;
    return 'all healthy';
  });

  /**
   * SSOT for "is an IDE actively connected": true only when the user has
   * selected an IDE via `select_ide` and that IDE is still detected. The
   * bridge daemon may be `running` (scanning) without any IDE routed
   * through it — that is `disconnected`, not `connected`.
   */
  readonly bridgeConnected = computed<boolean>(() => {
    const b = this.health()?.ide_bridge;
    if (!b || typeof b !== 'object') return false;
    return b.selected_ide !== null && b.selected_ide !== undefined;
  });

  /**
   * Detail line for the bridge card — IDE name + port when connected, a count
   * when bridges are detected but none selected, or `no IDE detected`. The
   * "connect" call-to-action is rendered as a separate routerLink (see
   * `bridgeShowConnectLink`) so users can jump straight to the
   * `/integrations` table where the actual connection happens.
   */
  readonly bridgeDetail = computed<string>(() => {
    const b = this.health()?.ide_bridge;
    if (!b || typeof b !== 'object') return '—';
    const sel = b.selected_ide;
    if (sel) return `${sel.ide_name} :${sel.port ?? '—'}`;
    const detected = Array.isArray(b.detected_ides) ? b.detected_ides : [];
    if (detected.length === 0) return 'no IDE detected';
    return `${detected.length} detected`;
  });

  /**
   * Whether to render the inline `connect →` anchor next to the bridge
   * detail. Visible only when the daemon has at least one detected IDE but
   * none has been selected — clicking the link takes the user to the
   * `/integrations` view anchored at `#ide-bridge`.
   */
  readonly bridgeShowConnectLink = computed<boolean>(() => {
    const b = this.health()?.ide_bridge;
    if (!b || typeof b !== 'object') return false;
    if (b.selected_ide) return false;
    const detected = Array.isArray(b.detected_ides) ? b.detected_ides : [];
    return detected.length > 0;
  });

  /** True when the host-side mcp-os worker is reported as running. */
  readonly mcpOsRunning = computed<boolean>(() => {
    const m = this.health()?.mcp_os;
    return typeof m === 'object' && m !== null ? m.running === true : false;
  });

  /** Detected IDEs surfaced in the expandable details row. */
  readonly detectedIdes = computed(() => {
    const b = this.health()?.ide_bridge;
    if (!b || typeof b !== 'object') return [];
    return Array.isArray(b.detected_ides) ? b.detected_ides : [];
  });

  /** Defensive accessor — returns an array even when the health snapshot is malformed. */
  readonly containerArray = computed<{ name: string; status: string; healthy: boolean }[]>(() => {
    const containers = this.health()?.containers;
    return Array.isArray(containers) ? containers : [];
  });

  protected readonly projectState = inject(ProjectStateService);
  private readonly tauri = inject(TauriService);
  private readonly injector = inject(Injector);
  private unsubProjectSettled: (() => void) | null = null;

  /**
   * Kicks off the initial log fetch + health refresh + polling. Re-runs the
   * fetch whenever the project lifecycle settles so the view recovers from
   * the boot race where the shell loads `activeProject` after this component
   * has already mounted (without this, the user sees a "No active project"
   * banner even though the project pill in the header reads correctly).
   */
  async ngOnInit(): Promise<void> {
    void this.forceMaxLogLevel();
    await this.refresh();
    // SystemHealthService owns the polling loop and the project-settled
    // health refresh; we just kick it off and read its `health` signal.
    // Await so the initial snapshot is committed before view tests assert
    // on it.
    await this.systemHealth.ensurePolling();
    this.unsubProjectSettled = this.projectState.onProjectSettled(() => {
      void this.refresh();
    });
  }

  /** Cancels the project-settled subscription (health polling lives in the service). */
  ngOnDestroy(): void {
    if (this.unsubProjectSettled) {
      this.unsubProjectSettled();
      this.unsubProjectSettled = null;
    }
  }

  /**
   * Pin the log surface to the bottom after Angular commits the freshly
   * rendered rows to the DOM. `afterNextRender({ write })` is the official
   * post-render hook (Angular 16+) and runs in the browser only, after the
   * commit — so `scrollHeight` reflects the final layout, unlike
   * `ngAfterViewChecked` + `requestAnimationFrame` which fired before the
   * `@for` block had finished extending the document.
   */
  private scrollToBottom(): void {
    afterNextRender(
      {
        write: () => {
          const el = this.logScroll?.nativeElement;
          if (el) el.scrollTop = el.scrollHeight;
        },
      },
      { injector: this.injector }
    );
  }

  /** Re-fetch the tail of compose logs and re-parse into typed lines. */
  protected async refresh(): Promise<void> {
    const project = this.projectState.activeProject;
    if (!project) {
      // While the shell still boots the project lifecycle the active project
      // is transiently null — surface a quiet loading state instead of an
      // error banner, the onProjectSettled callback re-runs this fetch as
      // soon as the project is ready.
      if (this.projectState.status === 'loading') {
        this.loading.set(true);
        this.error.set('');
      } else {
        this.loading.set(false);
        this.error.set('No active project');
      }
      return;
    }
    this.loading.set(true);
    try {
      const raw = await this.tauri.invoke<string>('get_compose_logs', {
        project,
        tail: LOGS_TAIL_LINES,
      });
      const parsed = raw
        .split(/\r?\n/)
        .filter((l) => l.length > 0)
        .map(parseLogLine);
      this.lines.set(parsed);
      this.error.set('');
      this.scrollToBottom();
      this.reconcileSourceFilter(parsed);
    } catch (e: unknown) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Force a health refresh outside the regular cadence — used by the
   * "Refresh" button in the toolbar. The polling loop and per-project
   * refresh are owned by `SystemHealthService`.
   */
  protected refreshHealth(): Promise<void> {
    return this.systemHealth.refresh();
  }

  /**
   * Triggers a backend export of diagnostics. On success surfaces the output
   * path through a confirmation dialog (mockup-aligned); failures are routed
   * to the error banner so the toolbar stays calm.
   */
  protected async exportDiagnostics(): Promise<void> {
    const project = this.projectState.activeProject;
    if (!project) return;
    this.diagnosticsExporting.set(true);
    this.diagnosticsPath.set('');
    this.diagnosticsCopied.set(false);
    try {
      const path = await this.tauri.invoke<string>('export_diagnostics', { project });
      const trimmed = (path ?? '').trim();
      this.diagnosticsPath.set(trimmed);
      // Only open the dialog when we actually have something to show — an
      // empty path would render an empty `note` and confuse the user.
      if (trimmed.length > 0) {
        this.exportDialogOpen.set(true);
      }
    } catch (e: unknown) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.diagnosticsExporting.set(false);
    }
  }

  /**
   * Copies the diagnostics path to the clipboard and flips the primary button
   * label to `copied ✓` for a short moment. Falls back to the error banner if
   * the clipboard API rejects (e.g. permission denied).
   */
  protected async copyDiagnosticsPath(): Promise<void> {
    const path = this.diagnosticsPath();
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      this.diagnosticsCopied.set(true);
    } catch (e: unknown) {
      this.error.set(e instanceof Error ? e.message : String(e));
      this.exportDialogOpen.set(false);
    }
  }

  /** Close the confirmation dialog and reset its transient copy state. */
  protected closeExportDialog(): void {
    this.exportDialogOpen.set(false);
    this.diagnosticsCopied.set(false);
  }

  /**
   * Format a parsed timestamp for display.
   *
   * - ISO stamps from `nerdctl compose logs --timestamps`
   *   (e.g. `2026-04-28T11:32:56.123456Z`) are shortened to
   *   `YYYY-MM-DD HH:MM:SS`.
   * - Bracketed `HH:MM:SS[.ms]` stamps emitted by the application inside
   *   the container are prefixed with today's date so the column always
   *   carries a day — without this, two consecutive entries logged on
   *   different days are indistinguishable. The fallback is a best-effort
   *   approximation: we use the host's current date, which is correct for
   *   the tail-N most recent entries we display, but the day prefix is
   *   only a hint when the container clock or timezone diverges from the
   *   host (for example, a containerised process logging in UTC while the
   *   host shows local time).
   *
   * The original raw value is always exposed through `[title]` so the
   * approximation is recoverable on hover.
   * @param raw - the parsed `time` field from a log line
   */
  protected formatTime(raw: string): string {
    if (!raw) return '';
    const isoMatch = FORMAT_TIME_ISO_RE.exec(raw);
    if (isoMatch) return `${isoMatch[1]} ${isoMatch[2]}`;
    const hmsMatch = FORMAT_TIME_HMS_RE.exec(raw);
    if (hmsMatch) return `${this.todayIso()} ${hmsMatch[1]}`;
    return raw;
  }

  /** Today's date in ISO `YYYY-MM-DD` form — extracted for ease of mocking in tests. */
  protected todayIso(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Returns the colour token used for a log line's source label.
   * @param line - the parsed log line
   */
  protected sourceColour(line: LogLine): string {
    if (line.level === 'error') return '#f87171';
    if (line.level === 'warn') return 'var(--amber)';
    return 'var(--teal)';
  }

  /**
   * Returns the colour token used for a log line's level label.
   * @param line - the parsed log line
   */
  protected levelColour(line: LogLine): string {
    if (line.level === 'error') return '#f87171';
    if (line.level === 'warn') return 'var(--amber)';
    if (line.level === 'debug') return 'var(--ink-mute)';
    return 'var(--ink-mute)';
  }

  /** Toggle visibility of the expandable per-container / detected-IDE row. */
  protected toggleDetails(): void {
    this.detailsOpen.update((v) => !v);
  }

  /** Strip the `speedwave_<project>_` prefix from a container name for display. */
  protected readonly stripPrefix = stripContainerPrefix;

  /**
   * Select a level chip.
   * @param level - Level to filter on, or `'all'` to disable the filter.
   */
  protected setLevel(level: LogLevel): void {
    this.filters.update((f) => ({ ...f, level }));
  }

  /**
   * Select a source from the dropdown.
   * @param source - Source to filter on, or `'all'` to disable the filter.
   */
  protected setSource(source: string): void {
    this.filters.update((f) => ({ ...f, source }));
  }

  /**
   * Native `<select>` change handler — narrows `EventTarget` to `HTMLSelectElement`.
   * @param event - DOM change event from the source dropdown.
   */
  protected onSourceChange(event: Event): void {
    const target = event.target as HTMLSelectElement | null;
    if (target) this.setSource(target.value);
  }

  /**
   * If the active source filter no longer appears in the latest log set
   * (container stopped, name changed), fall back to `all` so the empty
   * "no logs match" state can't be triggered by stale selection alone.
   * @param lines - Most recent parsed log batch.
   */
  private reconcileSourceFilter(lines: readonly LogLine[]): void {
    const active = this.filters().source;
    if (active === 'all') return;
    if (lines.some((l) => l.source === active)) return;
    this.filters.update((f) => ({ ...f, source: 'all' }));
  }

  /** Force trace-level diagnostics on init; failures log at debug. */
  private async forceMaxLogLevel(): Promise<void> {
    try {
      await this.tauri.invoke('set_log_level', { level: FORCED_LOG_LEVEL });
    } catch (err) {
      // Backend unavailable in browser dev mode (expected) or the command
      // was renamed/removed (regression). Log so a typo surfaces during
      // development without breaking log rendering, which doesn't depend
      // on the trace-level upgrade.
      console.debug('[logs-view] set_log_level failed', err);
    }
  }
}
