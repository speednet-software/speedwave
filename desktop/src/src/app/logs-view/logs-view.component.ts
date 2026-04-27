import {
  AfterViewChecked,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import type { HealthReport } from '../models/health';

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

/** Polling cadence for the system health grid (ms). */
export const HEALTH_REFRESH_INTERVAL_MS = 5000;

const COMPOSE_RE = /^([\w.-]+)\s*\|\s*(.*)$/;
const BRACKETED_TIME_RE = /^\[(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]\s*(.*)$/;
const ISO_TIME_RE = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+(.*)$/;
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
 * Logs view — fetches the compose-log tail, renders filtered/parsed lines,
 * and surfaces an aggregated system-health grid above the log stream.
 */
@Component({
  selector: 'app-logs-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="flex h-11 flex-shrink-0 items-center gap-3 border-b border-[var(--line)] bg-[var(--bg-1)] px-4 md:px-6"
      data-testid="logs-header"
    >
      <h1 class="view-title truncate text-[14px] text-[var(--ink)]" data-testid="logs-title">
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
        <span
          class="mono flex items-center gap-1.5 text-[11px] text-[var(--ink)]"
          data-testid="logs-project-pill"
        >
          <span
            class="inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-[var(--violet)] text-[8px] font-bold text-[#07090f]"
          >
            {{ projectMonogram() }}
          </span>
          <span>{{ activeProjectName() || 'no project' }}</span>
        </span>
      </div>
    </div>

    <div
      class="border-b border-[var(--line)] bg-[var(--bg-1)] px-4 py-4 md:px-6"
      data-testid="logs-health-grid"
    >
      <div class="mx-auto grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div
          class="rounded border border-[var(--line)] bg-[var(--bg-2)] p-3"
          data-testid="health-overall"
        >
          <div class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
            overall
          </div>
          <div
            class="mt-1 flex items-center gap-2 text-[14px]"
            [style.color]="overallHealthy() ? 'var(--green)' : 'var(--accent)'"
          >
            <span
              class="dot"
              [style.background]="overallHealthy() ? 'var(--green)' : 'var(--accent)'"
            ></span>
            {{ overallHealthy() ? 'healthy' : 'degraded' }}
          </div>
          <div class="mono mt-1 text-[10px] text-[var(--ink-mute)]">
            {{ overallDetail() }}
          </div>
        </div>

        <div
          class="rounded border border-[var(--line)] bg-[var(--bg-2)] p-3"
          data-testid="health-vm"
        >
          <div class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">vm</div>
          <div
            class="mt-1 flex items-center gap-2 text-[14px]"
            [style.color]="vmRunning() ? 'var(--green)' : 'var(--accent)'"
          >
            <span
              class="dot"
              [style.background]="vmRunning() ? 'var(--green)' : 'var(--accent)'"
            ></span>
            {{ vmLabel() }}
          </div>
          <div class="mono mt-1 text-[10px] text-[var(--ink-mute)]">
            {{ vmDetail() }}
          </div>
        </div>

        <div
          class="rounded border border-[var(--line)] bg-[var(--bg-2)] p-3"
          data-testid="health-containers"
        >
          <div class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
            containers
          </div>
          <div
            class="mt-1 flex items-center gap-2 text-[14px]"
            [style.color]="anyContainerUnhealthy() ? 'var(--amber)' : 'var(--green)'"
          >
            <span
              class="dot"
              [style.background]="anyContainerUnhealthy() ? 'var(--amber)' : 'var(--green)'"
            ></span>
            {{ containersLabel() }}
          </div>
          <div
            class="mono mt-1 text-[10px]"
            [style.color]="anyContainerUnhealthy() ? 'var(--amber)' : 'var(--ink-mute)'"
          >
            {{ containersDetail() }}
          </div>
        </div>

        <div
          class="rounded border border-[var(--line)] bg-[var(--bg-2)] p-3"
          data-testid="health-bridge"
        >
          <div class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
            ide_bridge
          </div>
          <div
            class="mt-1 flex items-center gap-2 text-[14px]"
            [style.color]="bridgeRunning() ? 'var(--green)' : 'var(--ink-mute)'"
          >
            <span
              class="dot"
              [style.background]="bridgeRunning() ? 'var(--green)' : 'var(--ink-mute)'"
            ></span>
            {{ bridgeRunning() ? 'connected' : 'disconnected' }}
          </div>
          <div class="mono mt-1 text-[10px] text-[var(--ink-mute)]">
            {{ bridgeDetail() }}
          </div>
        </div>
      </div>
    </div>

    <div
      class="border-b border-[var(--line)] bg-[var(--bg-1)] px-4 py-2 md:px-6"
      data-testid="logs-filters"
    >
      <div class="mx-auto flex max-w-3xl items-center gap-2">
        <div
          class="mono flex overflow-hidden rounded border border-[var(--line)] text-[11px]"
          role="group"
          aria-label="Log source filter"
          data-testid="logs-source-chips"
        >
          @for (src of sources(); track src) {
            <button
              type="button"
              class="px-2.5 py-1 whitespace-nowrap"
              [style.background]="filters().source === src ? 'var(--bg-2)' : 'transparent'"
              [style.color]="filters().source === src ? 'var(--ink)' : 'var(--ink-mute)'"
              [attr.aria-pressed]="filters().source === src"
              [attr.data-testid]="'logs-source-' + src"
              (click)="setSource(src)"
            >
              {{ src }}
            </button>
          }
        </div>
        <button
          type="button"
          class="mono ml-auto flex-shrink-0 rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-50 disabled:cursor-not-allowed"
          title="Refresh"
          data-testid="logs-refresh"
          [disabled]="loading()"
          (click)="refresh()"
        >
          ↻<span class="hidden sm:inline"> refresh</span>
        </button>
        <button
          type="button"
          class="mono flex-shrink-0 rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)]"
          data-testid="logs-export"
          (click)="exportDiagnostics()"
        >
          export diagnostics
        </button>
      </div>
      <div
        class="mono mx-auto mt-2 flex max-w-3xl overflow-hidden rounded border border-[var(--line)] text-[11px]"
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
    </div>

    @if (error()) {
      <div
        class="border-b border-[var(--line)] bg-[var(--bg-1)] px-4 py-2 md:px-6"
        data-testid="logs-error"
        role="alert"
      >
        <div
          class="mx-auto max-w-3xl rounded ring-1 ring-red-500/40 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-300 mono"
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
      <div class="mono mx-auto max-w-3xl" data-testid="logs-list">
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
              class="flex gap-3 py-1 hover:bg-[var(--bg-1)]"
              data-testid="logs-line"
              [style.background]="line.level === 'error' ? 'rgba(239, 68, 68, 0.05)' : null"
            >
              <span class="w-24 flex-shrink-0 text-[var(--ink-mute)]" data-testid="logs-time">
                {{ line.time }}
              </span>
              <span
                class="hidden w-16 flex-shrink-0 md:inline-block"
                [style.color]="sourceColour(line)"
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
                class="min-w-0 break-words"
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
  `,
  host: {
    class: 'flex h-full flex-1 flex-col overflow-hidden bg-[var(--bg)] text-[var(--ink)]',
  },
})
export class LogsViewComponent implements OnInit, OnDestroy, AfterViewChecked {
  @ViewChild('logScroll') private logScroll: ElementRef<HTMLDivElement> | null = null;

  /** All parsed log lines from the most recent fetch. */
  readonly lines = signal<LogLine[]>([]);
  /** Active filter selection (level + source). */
  readonly filters = signal<LogFilters>({ level: 'all', source: 'all' });
  /** Loading state — true during the initial fetch. */
  readonly loading = signal<boolean>(true);
  /** Error message from the last fetch, empty when healthy. */
  readonly error = signal<string>('');
  /** Latest health report shown above the logs (null until first fetch). */
  readonly health = signal<HealthReport | null>(null);
  /** Active project name, exposed for the project pill. */
  readonly activeProjectName = signal<string | null>(null);

  /** Distinct source names found in the current log set plus `'all'`. */
  readonly sources = computed<string[]>(() => {
    const distinct = new Set<string>();
    for (const line of this.lines()) distinct.add(line.source);
    // Filter 'all' from observed sources so the hard-coded chip is never duplicated.
    return [
      'all',
      ...Array.from(distinct)
        .filter((s) => s !== 'all')
        .sort(),
    ];
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

  /** First two letters of the active project (for the violet monogram). */
  readonly projectMonogram = computed<string>(() => {
    const name = this.activeProjectName();
    if (!name) return '··';
    return name.slice(0, 2).toLowerCase();
  });

  /** Whether the overall system is healthy. */
  readonly overallHealthy = computed<boolean>(() => this.health()?.overall_healthy ?? false);

  /** Detail line for the overall health card. */
  readonly overallDetail = computed<string>(() => {
    const r = this.health();
    if (!r) return 'no data';
    return r.overall_healthy ? 'all checks pass' : 'one or more checks failing';
  });

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

  /** True when the IDE bridge is running. */
  readonly bridgeRunning = computed<boolean>(() => {
    const b = this.health()?.ide_bridge;
    return typeof b === 'object' && b !== null ? b.running === true : false;
  });

  /** Detail line for the bridge card. */
  readonly bridgeDetail = computed<string>(() => {
    const b = this.health()?.ide_bridge;
    if (!b || typeof b !== 'object') return '—';
    if (!b.running) return 'no IDE attached';
    const ides = Array.isArray(b.detected_ides) ? b.detected_ides : [];
    if (ides.length === 0) return `:${b.port ?? '—'}`;
    const top = ides[0];
    return `${top.ide_name} :${top.port ?? '—'}`;
  });

  /** Defensive accessor — returns an array even when the health snapshot is malformed. */
  private containerArray(): { name: string; status: string; healthy: boolean }[] {
    const containers = this.health()?.containers;
    return Array.isArray(containers) ? containers : [];
  }

  private readonly tauri = inject(TauriService);
  private readonly projectState = inject(ProjectStateService);
  private scrollDirty = false;
  private healthRefreshTimer: ReturnType<typeof setInterval> | null = null;

  /** Kicks off the initial log fetch + health refresh + polling. */
  async ngOnInit(): Promise<void> {
    this.activeProjectName.set(this.projectState.activeProject);
    await this.refresh();
    await this.refreshHealth();
    this.healthRefreshTimer = setInterval(() => {
      void this.refreshHealth();
    }, HEALTH_REFRESH_INTERVAL_MS);
  }

  /** Cancels the health-poll interval. */
  ngOnDestroy(): void {
    if (this.healthRefreshTimer !== null) {
      clearInterval(this.healthRefreshTimer);
      this.healthRefreshTimer = null;
    }
  }

  /** Auto-scroll to bottom when new lines arrive. */
  ngAfterViewChecked(): void {
    if (this.scrollDirty && this.logScroll) {
      const el = this.logScroll.nativeElement;
      el.scrollTop = el.scrollHeight;
      this.scrollDirty = false;
    }
  }

  /** Re-fetch the tail of compose logs and re-parse into typed lines. */
  protected async refresh(): Promise<void> {
    const project = this.projectState.activeProject;
    this.activeProjectName.set(project);
    if (!project) {
      this.loading.set(false);
      this.error.set('No active project');
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
      this.scrollDirty = true;
    } catch (e: unknown) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.loading.set(false);
    }
  }

  /** Re-fetch the system health report — non-fatal on error. */
  protected async refreshHealth(): Promise<void> {
    const project = this.projectState.activeProject;
    if (!project) return;
    try {
      const report = await this.tauri.invoke<HealthReport>('get_health', { project });
      // Only commit a structurally valid report — otherwise keep prior snapshot.
      if (report && typeof report === 'object' && 'vm' in report && 'ide_bridge' in report) {
        this.health.set(report);
      }
    } catch {
      // Health is non-critical; keep the previous snapshot.
    }
  }

  /**
   * Triggers a backend export of diagnostics (best-effort).
   */
  protected async exportDiagnostics(): Promise<void> {
    try {
      await this.tauri.invoke('export_diagnostics', {
        project: this.projectState.activeProject,
      });
    } catch (e: unknown) {
      this.error.set(e instanceof Error ? e.message : String(e));
    }
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

  /**
   * Select a level chip.
   * @param level - Level to filter on, or `'all'` to disable the filter.
   */
  protected setLevel(level: LogLevel): void {
    this.filters.update((f) => ({ ...f, level }));
  }

  /**
   * Select a source chip.
   * @param source - Source to filter on, or `'all'` to disable the filter.
   */
  protected setSource(source: string): void {
    this.filters.update((f) => ({ ...f, source }));
  }
}
