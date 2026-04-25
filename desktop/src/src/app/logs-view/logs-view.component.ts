import {
  AfterViewChecked,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';

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
 * Logs view — fetches the compose-log tail and renders filtered, parsed lines.
 *
 * Owns the level/source filter chips and auto-scrolls to the bottom whenever a
 * fresh batch is loaded.
 */
@Component({
  selector: 'app-logs-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './logs-view.component.html',
  host: { class: 'block bg-sw-bg-darkest min-h-screen p-6 text-sw-text' },
})
export class LogsViewComponent implements OnInit, AfterViewChecked {
  @ViewChild('logScroll') private logScroll: ElementRef<HTMLDivElement> | null = null;

  /** All parsed log lines from the most recent fetch. */
  readonly lines = signal<LogLine[]>([]);
  /** Active filter selection (level + source). */
  readonly filters = signal<LogFilters>({ level: 'all', source: 'all' });
  /** Loading state — true during the initial fetch. */
  readonly loading = signal<boolean>(true);
  /** Error message from the last fetch, empty when healthy. */
  readonly error = signal<string>('');

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

  private readonly tauri = inject(TauriService);
  private readonly projectState = inject(ProjectStateService);
  private scrollDirty = false;

  /** Kicks off the initial log fetch. */
  async ngOnInit(): Promise<void> {
    await this.refresh();
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
