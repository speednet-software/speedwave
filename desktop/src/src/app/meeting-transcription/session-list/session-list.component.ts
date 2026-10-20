import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';

import { TranscriptionService } from '../../services/transcription.service';
import { TooltipDirective } from '../../shared/tooltip.directive';
import { IconComponent } from '../../shared/icon.component';
import { formatBytes } from '../../shared/format-bytes';
import type { TranscriptSummary } from '../../models/transcript';
import { isSessionOngoing } from '../../models/transcript';
import {
  dayGroupLabel,
  formatDuration,
  formatStartTime,
  recordingName,
  statusChip,
  type StatusChip,
} from '../recording-format';

/** One rendered row: the summary plus everything the template derives from it. */
interface RecordingRow {
  rec: TranscriptSummary;
  name: string;
  /** Start time, shown under a user title (the default name already is the start time). */
  when: string | null;
  duration: string;
  chip: StatusChip | null;
  /** Whether the row can be ticked (a recording that can still change cannot). */
  selectable: boolean;
}

/** Rows of one day, under its heading. */
interface DayGroup {
  label: string;
  rows: RecordingRow[];
}

/**
 * Recordings list (left pane): search, recordings grouped by day, one compact row each with its
 * name, length, start time and first line, and a chip only when its state needs a look. Every
 * action on one recording lives in the right pane; Select deletes several at once.
 */
@Component({
  selector: 'app-session-list',
  standalone: true,
  imports: [TooltipDirective, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    <div class="flex min-h-0 flex-1 flex-col" data-testid="session-list">
      <div class="border-b border-[var(--line)] px-3 pb-2.5 pt-3">
        @if (selecting()) {
          <div class="flex items-center gap-2 text-[12px]" data-testid="bulk-bar">
            <input
              type="checkbox"
              class="h-3.5 w-3.5 accent-[var(--accent)]"
              aria-label="Select all recordings"
              data-testid="select-all-toggle"
              [checked]="allSelected()"
              [indeterminate]="someSelected()"
              (change)="toggleAll()"
            />
            <span class="flex-1 whitespace-nowrap text-[var(--ink)]" data-testid="selected-count"
              >{{ selected().size }} selected
              <span class="text-[11px] text-[var(--ink-mute)]">· {{ selectedSize() }}</span></span
            >
            <button
              type="button"
              class="mono rounded border border-red-500/40 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-500/10 disabled:opacity-40"
              data-testid="delete-selected"
              [disabled]="selected().size === 0 || busy()"
              (click)="pendingBulkDelete.set(true)"
            >
              Delete
            </button>
            <button
              type="button"
              class="mono rounded border border-[var(--line)] px-2 py-0.5 text-[11px] text-[var(--ink-dim)] hover:text-[var(--ink)]"
              data-testid="cancel-select"
              (click)="stopSelecting()"
            >
              Done
            </button>
          </div>
          <div class="mt-2 flex items-center gap-2 text-[11px] text-[var(--ink-mute)]">
            <button
              type="button"
              class="text-[var(--accent)] hover:underline disabled:opacity-40"
              data-testid="select-all"
              [disabled]="allSelected()"
              (click)="selectAll()"
            >
              Select all ({{ selectableIds().length }})
            </button>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              class="text-[var(--ink-dim)] hover:underline disabled:opacity-40"
              data-testid="clear-selection"
              [disabled]="selected().size === 0"
              (click)="clearSelection()"
            >
              Clear
            </button>
            <span class="ml-auto">Shift-click selects a range</span>
          </div>
          @if (pendingBulkDelete()) {
            <div
              class="mt-2 rounded-md border border-red-500/40 bg-red-500/[0.06] p-2 text-[12px]"
              role="alertdialog"
              aria-label="Confirm deleting the selected recordings"
              data-testid="bulk-delete-confirm"
            >
              <p class="text-[var(--ink)]">
                Delete {{ selected().size }} recordings ({{ selectedSize() }})? Their audio and
                transcripts are removed from this machine. This cannot be undone.
              </p>
              <div class="mt-2 flex gap-2">
                <button
                  type="button"
                  class="mono rounded border border-red-500/40 px-2 py-0.5 text-red-300 hover:bg-red-500/10"
                  data-testid="bulk-delete-yes"
                  (click)="removeSelected()"
                >
                  Delete
                </button>
                <button
                  type="button"
                  class="mono rounded border border-[var(--line)] px-2 py-0.5 text-[var(--ink-mute)] hover:text-[var(--ink)]"
                  data-testid="bulk-delete-no"
                  (click)="pendingBulkDelete.set(false)"
                >
                  Cancel
                </button>
              </div>
            </div>
          }
        } @else {
          <label
            class="flex items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink-mute)] focus-within:border-[var(--accent)]"
          >
            <app-icon name="search" class="h-3.5 w-3.5" />
            <input
              type="search"
              class="min-w-0 flex-1 bg-transparent text-[var(--ink)] outline-none placeholder:text-[var(--ink-mute)]"
              placeholder="Search recordings"
              aria-label="Search recordings"
              data-testid="recordings-search"
              [value]="query()"
              (input)="query.set($any($event.target).value)"
            />
          </label>
          <div
            class="mono mt-2.5 flex items-center justify-between text-[10.5px] uppercase tracking-wider text-[var(--ink-mute)]"
          >
            <span data-testid="recordings-count">Recordings · {{ allRows().length }}</span>
            <span class="flex items-center gap-3">
              @if (allRows().length > 0) {
                <span data-testid="recordings-size">{{ totalSize() }}</span>
                <button
                  type="button"
                  class="normal-case tracking-normal text-[11px] text-[var(--ink-dim)] hover:text-[var(--ink)]"
                  data-testid="start-select"
                  (click)="selecting.set(true)"
                >
                  Select
                </button>
              }
            </span>
          </div>
        }
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto pb-3">
        @if (allRows().length === 0) {
          <ol
            class="m-3 space-y-1 rounded-md border border-dashed border-[var(--line)] p-3 text-[12px] text-[var(--ink-mute)]"
            data-testid="recordings-empty"
          >
            <li>1. Press Record.</li>
            <li>2. Stop when the meeting ends; the transcript appears here.</li>
            <li>3. Attach it to a chat and ask about it.</li>
          </ol>
        } @else if (groups().length === 0) {
          <p class="m-3 text-[12px] text-[var(--ink-mute)]" data-testid="recordings-no-match">
            No recording matches "{{ query().trim() }}".
          </p>
        }
        @for (group of groups(); track group.label) {
          <h3
            class="mono px-3.5 pb-1 pt-3 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
          >
            {{ group.label }}
          </h3>
          <ul>
            @for (row of group.rows; track row.rec.id) {
              @let rec = row.rec;
              @let active = rec.id === selectedId();
              @let ticked = selected().has(rec.id);
              <li
                class="border-l-2"
                [class]="
                  active
                    ? 'border-l-[var(--accent)] bg-[var(--bg-2)]'
                    : ticked
                      ? 'border-l-transparent bg-[var(--accent-soft)]'
                      : 'border-l-transparent hover:bg-[var(--bg-1)]'
                "
                [attr.data-active]="active ? 'true' : null"
                [attr.data-testid]="'row-' + rec.id"
              >
                <button
                  type="button"
                  class="flex w-full min-w-0 items-start gap-2.5 px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50"
                  [attr.data-testid]="'open-' + rec.id"
                  [attr.aria-current]="active && !selecting() ? 'true' : null"
                  [attr.aria-pressed]="selecting() ? ticked : null"
                  [disabled]="selecting() && !row.selectable"
                  (click)="onRowClick(row, $event)"
                >
                  @if (selecting()) {
                    <input
                      type="checkbox"
                      tabindex="-1"
                      class="pointer-events-none mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
                      aria-hidden="true"
                      [attr.data-testid]="'select-' + rec.id"
                      [checked]="ticked"
                      [disabled]="!row.selectable"
                    />
                  }
                  <span class="block min-w-0 flex-1">
                    <span class="flex items-center gap-1.5 text-[13px]">
                      <span class="min-w-0 flex-1 truncate font-medium text-[var(--ink)]">{{
                        row.name
                      }}</span>
                      @if (row.chip; as chip) {
                        <span
                          class="mono shrink-0 rounded px-1.5 text-[10px]"
                          [class]="chipClass(chip)"
                          [appTooltip]="chip.tooltip"
                          placement="top"
                          [attr.data-testid]="'status-' + rec.id"
                          >{{ chip.label }}</span
                        >
                      }
                      @if (row.duration) {
                        <span class="shrink-0 text-[11px] tabular-nums text-[var(--ink-mute)]">{{
                          row.duration
                        }}</span>
                      }
                    </span>
                    @if (row.when || rec.preview) {
                      <span
                        class="mt-0.5 flex gap-1.5 whitespace-nowrap text-[11.5px] text-[var(--ink-mute)]"
                      >
                        @if (row.when) {
                          <span class="shrink-0">{{ row.when }}</span>
                        }
                        @if (row.when && rec.preview) {
                          <span aria-hidden="true">·</span>
                        }
                        @if (rec.preview) {
                          <span
                            class="truncate text-[var(--ink-dim)]"
                            [attr.data-testid]="'preview-' + rec.id"
                            >{{ rec.preview }}</span
                          >
                        }
                      </span>
                    }
                  </span>
                </button>
              </li>
            }
          </ul>
        }
      </div>
    </div>
  `,
})
export class SessionListComponent implements OnInit {
  /** Emits the recording the user opened (the parent shows it in the right pane). */
  readonly opened = output<TranscriptSummary>();
  /** Forwards errors to the parent banner, the one place errors render. */
  readonly errorOccurred = output<string>();

  /** Search text as typed. */
  readonly query = signal('');
  /** Whether the list is in multi-select mode. */
  readonly selecting = signal(false);
  /** Ids ticked in multi-select mode. */
  readonly selected = signal<ReadonlySet<string>>(new Set());
  /** Whether the bulk-delete confirmation is showing. */
  readonly pendingBulkDelete = signal(false);
  /** True while a bulk delete runs. */
  readonly busy = signal(false);
  /** The row a plain click last ticked or unticked, where a Shift-click range starts. */
  private readonly anchorId = signal<string | null>(null);

  private readonly transcription = inject(TranscriptionService);
  /**
   * Id of the recording open in the right pane, read from the service so the highlight survives
   * the list being destroyed and rebuilt on navigation, as the pane does.
   */
  readonly selectedId = computed(() => this.transcription.active()?.id ?? null);

  /** Every row in display order (the backend sorts newest first). */
  readonly allRows = computed<RecordingRow[]>(() => {
    const now = new Date();
    const best = this.transcription.highQualityModel()?.key ?? null;
    return this.transcription.recordings().map((rec) => ({
      rec,
      name: recordingName(rec, now),
      when: rec.title?.trim() ? formatStartTime(rec.created_at) : null,
      duration: formatDuration(rec.duration_secs),
      chip: statusChip(rec, best),
      selectable: !isSessionOngoing(rec.status),
    }));
  });

  /** Rows matching the search (name, start time or first line), in display order. */
  readonly visibleRows = computed<RecordingRow[]>(() => {
    const q = this.query().trim().toLocaleLowerCase();
    if (!q) return this.allRows();
    return this.allRows().filter(
      (row) =>
        row.name.toLocaleLowerCase().includes(q) ||
        (row.rec.preview ?? '').toLocaleLowerCase().includes(q)
    );
  });

  /** Visible rows under one heading per day. */
  readonly groups = computed<DayGroup[]>(() => {
    const now = new Date();
    const out: DayGroup[] = [];
    for (const row of this.visibleRows()) {
      const label = dayGroupLabel(row.rec.created_at, now);
      const last = out[out.length - 1];
      if (last?.label === label) last.rows.push(row);
      else out.push({ label, rows: [row] });
    }
    return out;
  });

  /** Ids Select all ticks: the visible rows that can be deleted. */
  readonly selectableIds = computed(() =>
    this.visibleRows()
      .filter((r) => r.selectable)
      .map((r) => r.rec.id)
  );

  /** Every selectable visible row is ticked. */
  readonly allSelected = computed(() => {
    const ids = this.selectableIds();
    return ids.length > 0 && ids.every((id) => this.selected().has(id));
  });

  /** Some, but not all, are ticked (the header box shows a dash). */
  readonly someSelected = computed(() => this.selected().size > 0 && !this.allSelected());

  /** Disk use of every recording. */
  readonly totalSize = computed(() =>
    formatBytes(this.transcription.recordings().reduce((sum, r) => sum + r.size_bytes, 0))
  );

  /** Disk use of the ticked recordings. */
  readonly selectedSize = computed(() => {
    const ids = this.selected();
    return formatBytes(
      this.transcription
        .recordings()
        .filter((r) => ids.has(r.id))
        .reduce((sum, r) => sum + r.size_bytes, 0)
    );
  });

  /** Starts following the backend's change events and loads the list. */
  async ngOnInit(): Promise<void> {
    await this.transcription.watchRecordings();
    const err = this.transcription.recordingsError();
    if (err) this.errorOccurred.emit(err);
  }

  /**
   * Chip colours per tone.
   * @param chip - the chip to colour.
   */
  chipClass(chip: StatusChip): string {
    switch (chip.tone) {
      case 'live':
      case 'error':
        return 'bg-red-500/15 text-red-300';
      case 'busy':
        return 'bg-amber-500/15 text-amber-300';
      case 'muted':
        return 'bg-[var(--bg-3)] text-[var(--ink-dim)]';
    }
  }

  /**
   * Opens a row, or in select mode ticks it (Shift extends from the last ticked row).
   * @param row - the clicked row.
   * @param event - the click, read for Shift.
   */
  onRowClick(row: RecordingRow, event: MouseEvent): void {
    if (!this.selecting()) {
      this.opened.emit(row.rec);
      return;
    }
    if (!row.selectable) return;
    if (event.shiftKey && this.anchorId() !== null) {
      this.selectRange(this.anchorId() as string, row.rec.id);
      return;
    }
    this.toggleSelected(row.rec.id);
  }

  /**
   * Ticks or unticks one recording and makes it the start of the next Shift range.
   * @param id - the recording id.
   */
  toggleSelected(id: string): void {
    const next = new Set(this.selected());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.selected.set(next);
    this.anchorId.set(id);
  }

  /** Header box: ticks every selectable visible row, or clears when all are ticked. */
  toggleAll(): void {
    if (this.allSelected()) this.clearSelection();
    else this.selectAll();
  }

  /** Ticks every selectable visible row. */
  selectAll(): void {
    this.selected.set(new Set([...this.selected(), ...this.selectableIds()]));
  }

  /** Unticks everything. */
  clearSelection(): void {
    this.selected.set(new Set());
    this.anchorId.set(null);
    this.pendingBulkDelete.set(false);
  }

  /** Leaves multi-select mode and clears the selection. */
  stopSelecting(): void {
    this.selecting.set(false);
    this.clearSelection();
  }

  /** Deletes every ticked recording; the first failure is reported, the rest still run. */
  async removeSelected(): Promise<void> {
    const ids = [...this.selected()];
    this.pendingBulkDelete.set(false);
    this.busy.set(true);
    const failures: string[] = [];
    for (const id of ids) {
      try {
        await this.transcription.delete(id);
      } catch (e: unknown) {
        failures.push(e instanceof Error ? e.message : String(e));
      }
    }
    this.busy.set(false);
    this.stopSelecting();
    if (failures.length > 0) {
      this.errorOccurred.emit(
        `${failures.length} of ${ids.length} recordings could not be deleted: ${failures[0]}`
      );
    }
  }

  /**
   * Ticks every selectable visible row between two rows, both included.
   * @param fromId - where the range starts.
   * @param toId - where it ends.
   */
  private selectRange(fromId: string, toId: string): void {
    const order = this.visibleRows().map((r) => r.rec.id);
    const a = order.indexOf(fromId);
    const b = order.indexOf(toId);
    if (a < 0 || b < 0) {
      this.toggleSelected(toId);
      return;
    }
    const selectable = new Set(this.selectableIds());
    const range = order
      .slice(Math.min(a, b), Math.max(a, b) + 1)
      .filter((id) => selectable.has(id));
    this.selected.set(new Set([...this.selected(), ...range]));
  }
}
