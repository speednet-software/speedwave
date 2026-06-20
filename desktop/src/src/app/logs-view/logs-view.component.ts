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
import { HEALTH_REFRESH_INTERVAL_MS, SystemHealthService } from '../services/system-health.service';
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

const COMPOSE_RE = /^([\w.-]+)\s*\|\s*(.*)$/;
// `[HH:MM:SS]` or `[<ISO>]`; ISO is `mcp-shared`'s `ts()`.
const BRACKETED_TIME_RE =
  /^\[(\d{2}:\d{2}:\d{2}(?:\.\d+)?|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]\s*(.*)$/;
// ISO 8601 prefix (UTC, millis, or local-offset) — SSOT format: `log_ts::log_timestamp()` / `mcp-shared`'s `ts()`.
const ISO_TIME_RE =
  /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+(.*)$/;
/** A parseable ISO date+time prefix — `formatTime` parses it and re-renders in the host's local zone. */
const FORMAT_TIME_ISO_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
/** Bare `HH:MM:SS` (no day, no zone) from external tooling — dated with today's date as a hint. */
const FORMAT_TIME_HMS_RE = /^(\d{2}:\d{2}:\d{2})/;
const LEVEL_RE = /^(DEBUG|INFO|WARN|WARNING|ERROR|TRACE)\s+(.*)$/i;
/** Drain prefix the Rust `log_file` writer puts on captured stdout/stderr lines — pure noise in the message. */
const DRAIN_PREFIX_RE = /^(?:STDOUT|STDERR): (.*)$/;

/**
 * Parse a single compose-log line into `LogLine`. Tolerant — never throws.
 * @param raw - A single log line as emitted by `get_all_logs`.
 */
export function parseLogLine(raw: string): LogLine {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { time: '', source: 'log', level: 'info', message: '' };
  }
  const composeMatch = COMPOSE_RE.exec(trimmed);
  const source = composeMatch ? composeMatch[1] : 'log';
  const rest = composeMatch ? composeMatch[2] : trimmed;

  // Head: nerdctl `--timestamps`, Rust drain, or `[<ISO>]`.
  let time = '';
  let afterTime = rest;
  const headMatch = BRACKETED_TIME_RE.exec(rest) ?? ISO_TIME_RE.exec(rest);
  if (headMatch) {
    time = headMatch[1];
    afterTime = headMatch[2];
  }
  // Drop the `STDOUT: `/`STDERR: ` drain marker (capture noise only).
  const drainMatch = DRAIN_PREFIX_RE.exec(afterTime);
  let cleaned = drainMatch ? drainMatch[1] : afterTime;
  // Inline `[<ISO>]` from the worker's `ts()` — promote to time if absent, else strip.
  const inlineMatch = BRACKETED_TIME_RE.exec(cleaned);
  if (inlineMatch) {
    if (!time) time = inlineMatch[1];
    cleaned = inlineMatch[2];
  }

  const levelMatch = LEVEL_RE.exec(cleaned);
  const level: LogLevel = levelMatch ? normalizeLevel(levelMatch[1]) : 'info';
  const message = levelMatch ? levelMatch[2] : cleaned;

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
 * Interleave per-source blocks into one chronological stream.
 * @param lines - Parsed log lines in backend (block) order.
 */
export function sortLogLinesByTime(lines: LogLine[]): LogLine[] {
  const keys: number[] = new Array<number>(lines.length).fill(NaN);
  let lastKey = NaN;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].time ? Date.parse(lines[i].time) : NaN;
    if (!Number.isNaN(t)) lastKey = t;
    keys[i] = lastKey;
  }
  let nextKey = NaN;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!Number.isNaN(keys[i])) {
      nextKey = keys[i];
    } else if (!Number.isNaN(nextKey)) {
      keys[i] = nextKey;
    }
  }
  const keyed = lines.map((line, i) => ({ line, key: keys[i] }));
  // Stable sort (ES2019+); NaN keys sort before timestamped lines.
  return keyed
    .sort((a, b) => {
      if (Number.isNaN(a.key) && Number.isNaN(b.key)) return 0;
      if (Number.isNaN(a.key)) return -1;
      if (Number.isNaN(b.key)) return 1;
      return a.key - b.key;
    })
    .map((k) => k.line);
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
      @if (!healthLoaded()) {
        <div class="flex items-center gap-2 text-[13px]" data-testid="health-checking">
          <span class="dot" [style.background]="'var(--ink-mute)'"></span>
          <span class="text-[var(--ink-mute)]">checking system health…</span>
        </div>
      } @else {
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
      }

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
                    [attr.data-testid]="'health-container-' + c.name"
                  >
                    <span
                      class="dot"
                      [style.background]="c.healthy ? 'var(--green)' : 'var(--amber)'"
                    ></span>
                    <span class="text-[var(--ink)]">{{ c.name }}</span>
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
                class="hidden w-32 flex-shrink-0 truncate md:inline-block lg:w-48"
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
                [style.color]="line.level === 'error' ? 'var(--red)' : 'var(--ink-dim)'"
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
  /** False until the first health snapshot lands — render neutral, not "degraded". */
  readonly healthLoaded = computed<boolean>(() => this.health() !== null);

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
    if (unhealthy) return `${unhealthy.name}: ${unhealthy.status}`;
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
  /** Live-tail poll handle — re-fetches the log buffer on the health cadence. */
  private logsTimer: ReturnType<typeof setInterval> | null = null;
  /** Guard: a silent poll skips when the previous fetch hasn't returned yet. */
  private refreshInFlight = false;
  /** Last raw response — silent polls bail out when the buffer is byte-identical. */
  private lastRaw = '';

  /**
   * Kicks off the initial log fetch + health refresh + polling, re-running when the project settles.
   */
  async ngOnInit(): Promise<void> {
    await this.refresh();
    // SystemHealthService owns polling and the project-settled refresh; we read its `health` signal.
    await this.systemHealth.ensurePolling();
    // Live-tail: silent refresh on the health cadence; sticky-scroll if at bottom.
    this.logsTimer = setInterval(() => void this.refresh(true), HEALTH_REFRESH_INTERVAL_MS);
    this.unsubProjectSettled = this.projectState.onProjectSettled(() => {
      void this.refresh();
    });
  }

  /** Cancels the project-settled subscription and the live-tail poll. */
  ngOnDestroy(): void {
    if (this.unsubProjectSettled) {
      this.unsubProjectSettled();
      this.unsubProjectSettled = null;
    }
    if (this.logsTimer) {
      clearInterval(this.logsTimer);
      this.logsTimer = null;
    }
  }

  /** Pin the log surface to the bottom after Angular commits new rows. */
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

  /** True when the log scroll region is at (or within ~50px of) the bottom. */
  private isAtBottom(): boolean {
    const el = this.logScroll?.nativeElement;
    if (!el) return true; // no element yet → behave like a fresh tail
    return el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  }

  /**
   * Re-fetch + re-parse the merged buffer. `silent`: no spinner; sticky scroll only.
   * @param silent - True for the background poll.
   */
  protected async refresh(silent = false): Promise<void> {
    // Skip silent ticks while a fetch is in flight — slow nerdctl shouldn't fan out.
    if (silent && this.refreshInFlight) return;
    const project = this.projectState.activeProject;
    if (!project) {
      // Project transiently null during shell boot — quiet loading, no banner.
      if (this.projectState.status === 'loading') {
        if (!silent) this.loading.set(true);
        this.error.set('');
      } else if (!silent) {
        this.loading.set(false);
        this.error.set('No active project');
      }
      return;
    }
    const stickToBottom = silent ? this.isAtBottom() : true;
    if (!silent) this.loading.set(true);
    this.refreshInFlight = true;
    try {
      // `get_all_logs` merges host-side logs + `compose logs`. `<source> | …` prefix
      // is recognised by `parseLogLine` (COMPOSE_RE) — new sources auto-appear.
      const raw = await this.tauri.invoke<string>('get_all_logs', {
        project,
        tail: LOGS_TAIL_LINES,
      });
      this.error.set('');
      // Skip the re-parse + signal write when the buffer is byte-identical (idle system).
      if (silent && raw === this.lastRaw) return;
      this.lastRaw = raw;
      const parsed = sortLogLinesByTime(
        raw
          .split(/\r?\n/)
          .filter((l) => l.length > 0)
          .map(parseLogLine)
      );
      this.lines.set(parsed);
      if (stickToBottom) this.scrollToBottom();
      this.reconcileSourceFilter(parsed);
    } catch (e: unknown) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.refreshInFlight = false;
      if (!silent) this.loading.set(false);
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

  /** Copies the diagnostics path to the clipboard; on rejection surfaces the error banner. */
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
   * Render a parsed timestamp for the time column — always in the host's
   * local timezone (`YYYY-MM-DD HH:MM:SS`), whatever offset the source wrote:
   * an ISO stamp with `Z`/`±HH:MM` (nerdctl `--timestamps` is UTC; Speedwave
   * loggers carry an offset) is parsed and re-rendered locally; a bare
   * `HH:MM:SS[.ms]` (external tooling, no day/zone) is dated with today and
   * kept as-is. The raw value stays in `[title]` on hover.
   * @param raw - the parsed `time` field from a log line
   */
  protected formatTime(raw: string): string {
    if (!raw) return '';
    if (FORMAT_TIME_ISO_RE.test(raw)) {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) {
        const p2 = (n: number) => String(n).padStart(2, '0');
        return (
          `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
          `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
        );
      }
    }
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
    if (line.level === 'error') return 'var(--red)';
    if (line.level === 'warn') return 'var(--amber)';
    return 'var(--accent)';
  }

  /**
   * Returns the colour token used for a log line's level label.
   * @param line - the parsed log line
   */
  protected levelColour(line: LogLine): string {
    if (line.level === 'error') return 'var(--red)';
    if (line.level === 'warn') return 'var(--amber)';
    return 'var(--ink-mute)';
  }

  /** Toggle visibility of the expandable per-container / detected-IDE row. */
  protected toggleDetails(): void {
    this.detailsOpen.update((v) => !v);
  }

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
   * Fall back to `all` if the active source filter no longer appears in the latest log set.
   * @param lines - Most recent parsed log batch.
   */
  private reconcileSourceFilter(lines: readonly LogLine[]): void {
    const active = this.filters().source;
    if (active === 'all') return;
    if (lines.some((l) => l.source === active)) return;
    this.filters.update((f) => ({ ...f, source: 'all' }));
  }
}
