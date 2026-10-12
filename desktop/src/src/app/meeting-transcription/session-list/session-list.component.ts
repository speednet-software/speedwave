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
import { formatBytes } from '../../shared/format-bytes';
import type { TranscriptSummary } from '../../models/transcript';
import { isSessionOngoing } from '../../models/transcript';
import {
  formatDuration,
  formatRecordingDate,
  recordingName,
  statusChip,
  type StatusChip,
} from '../recording-format';

/** Tooltip on the Continue recording action. */
const CONTINUE_TOOLTIP =
  'Adds a new part to this recording. When you stop, the whole recording is transcribed again.';
/** Tooltip on the Transcribe action. */
const TRANSCRIBE_TOOLTIP = 'Runs the transcription on the recorded audio again.';
/** Tooltip on the Delete action. */
const DELETE_TOOLTIP =
  'Removes the audio and the transcript from this machine. This cannot be undone.';
/** Why rows cannot be opened while a recording runs. */
const ROW_LOCKED_TOOLTIP = 'Stop the recording to open another one.';

/** One rendered row: the summary plus everything the template derives from it. */
interface RecordingRow {
  rec: TranscriptSummary;
  name: string;
  /** Start time, shown under a user title (the default name already is the start time). */
  when: string | null;
  duration: string;
  size: string;
  chip: StatusChip;
}

/**
 * Recordings list (left pane): one card per recording with its name, length, status and the
 * first line of its transcript, plus Continue / Transcribe / Delete. Delete asks first, alone or
 * for a selection. Rows refresh from the backend's change events, never on a timer.
 */
@Component({
  selector: 'app-session-list',
  standalone: true,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div data-testid="session-list">
      <div class="mb-2 flex items-baseline justify-between gap-2">
        <h2 class="mono text-[11px] uppercase tracking-widest text-[var(--ink-mute)]">
          Recordings ({{ rows().length }})
        </h2>
        @if (rows().length > 0) {
          <span class="mono text-[10px] text-[var(--ink-mute)]" data-testid="recordings-size">
            {{ totalSize() }} on disk
          </span>
        }
      </div>

      @if (rows().length === 0) {
        <ol
          class="space-y-1 rounded-md border border-dashed border-[var(--line)] p-3 text-[12px] text-[var(--ink-mute)]"
          data-testid="recordings-empty"
        >
          <li>1. Start recording.</li>
          <li>2. Stop when the meeting ends; the transcript appears here.</li>
          <li>3. Summarize it in chat.</li>
        </ol>
      } @else {
        <div class="mb-2 flex items-center gap-2 text-[11px]">
          @if (selecting()) {
            <button
              type="button"
              class="mono rounded border border-red-500/40 px-2 py-0.5 text-red-300 hover:bg-red-500/10 disabled:opacity-40"
              data-testid="delete-selected"
              [disabled]="selected().size === 0 || busy()"
              (click)="pendingBulkDelete.set(true)"
            >
              Delete {{ selected().size }} ({{ selectedSize() }})
            </button>
            <button
              type="button"
              class="mono rounded border border-[var(--line)] px-2 py-0.5 text-[var(--ink-mute)] hover:text-[var(--ink)]"
              data-testid="cancel-select"
              (click)="stopSelecting()"
            >
              Cancel
            </button>
          } @else {
            <button
              type="button"
              class="mono rounded border border-[var(--line)] px-2 py-0.5 text-[var(--ink-mute)] hover:text-[var(--ink)]"
              data-testid="start-select"
              (click)="selecting.set(true)"
            >
              Select
            </button>
          }
        </div>
        @if (pendingBulkDelete()) {
          <div
            class="mb-2 rounded-md border border-red-500/40 bg-red-500/[0.06] p-2 text-[12px]"
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
      }

      <ul class="space-y-2">
        @for (row of rows(); track row.rec.id) {
          @let rec = row.rec;
          @let ongoing = isOngoing(rec);
          <li
            class="rounded-md border border-[var(--line)] bg-[var(--bg-1)] p-2 text-[12px]"
            [class.ring-1]="rec.id === selectedId()"
            [class.ring-[var(--accent)]]="rec.id === selectedId()"
          >
            @if (pendingDeleteId() === rec.id) {
              <div
                role="alertdialog"
                aria-label="Confirm deleting the recording"
                [attr.data-testid]="'delete-confirm-' + rec.id"
              >
                <p class="text-[var(--ink)]">
                  Delete "{{ row.name }}"{{
                    row.duration ? ' (' + row.duration + ', ' + row.size + ')' : ''
                  }}?
                </p>
                <p class="mt-1 text-[11px] text-[var(--ink-mute)]">
                  The audio and the transcript are removed from this machine. This cannot be undone.
                </p>
                <div class="mt-2 flex gap-2">
                  <button
                    type="button"
                    class="mono rounded border border-red-500/40 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-500/10"
                    [attr.data-testid]="'delete-yes-' + rec.id"
                    (click)="remove(rec.id)"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    class="mono rounded border border-[var(--line)] px-2 py-0.5 text-[11px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
                    [attr.data-testid]="'delete-no-' + rec.id"
                    (click)="pendingDeleteId.set(null)"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            } @else {
              <div class="flex items-start gap-2">
                @if (selecting()) {
                  <input
                    type="checkbox"
                    class="mt-1"
                    [attr.aria-label]="'Select ' + row.name"
                    [attr.data-testid]="'select-' + rec.id"
                    [checked]="selected().has(rec.id)"
                    [disabled]="ongoing"
                    (change)="toggleSelected(rec.id)"
                  />
                }
                <span
                  class="block min-w-0 flex-1"
                  [appTooltip]="rowLocked(rec) ? rowLockedTooltip : ''"
                  placement="right"
                >
                  <button
                    type="button"
                    class="block w-full min-w-0 text-left disabled:cursor-not-allowed disabled:opacity-50"
                    [attr.data-testid]="'open-' + rec.id"
                    [disabled]="rowLocked(rec)"
                    (click)="open(rec)"
                  >
                    <span class="block truncate font-medium text-[var(--ink)]">{{ row.name }}</span>
                    <span
                      class="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-[var(--ink-mute)]"
                    >
                      @if (row.when) {
                        <span>{{ row.when }}</span>
                        <span aria-hidden="true">·</span>
                      }
                      @if (row.duration) {
                        <span>{{ row.duration }}</span>
                        <span aria-hidden="true">·</span>
                      }
                      <span
                        class="mono rounded px-1"
                        [class]="chipClass(row.chip)"
                        [appTooltip]="row.chip.tooltip"
                        placement="top"
                        [attr.data-testid]="'status-' + rec.id"
                        >{{ row.chip.label }}</span
                      >
                    </span>
                    @if (rec.preview) {
                      <span
                        class="mt-1 line-clamp-2 block text-[11px] text-[var(--ink-dim)]"
                        [attr.data-testid]="'preview-' + rec.id"
                        >{{ rec.preview }}</span
                      >
                    }
                  </button>
                </span>
              </div>
              @if (!selecting()) {
                <div class="mt-1 flex items-center gap-2 text-[10px]">
                  @if (rec.status.state === 'done' && !recordingInProgress()) {
                    <span [appTooltip]="continueTooltip" placement="bottom">
                      <button
                        type="button"
                        class="mono rounded border border-[var(--line)] px-2 py-0.5 text-[var(--ink)] hover:bg-[var(--bg-2)]"
                        [attr.data-testid]="'resume-' + rec.id"
                        (click)="resume(rec)"
                      >
                        Continue recording
                      </button>
                    </span>
                  }
                  @if (rec.status.state === 'failed') {
                    <span [appTooltip]="transcribeTooltip" placement="bottom">
                      <button
                        type="button"
                        class="mono rounded border border-[var(--line)] px-2 py-0.5 text-[var(--ink)] hover:bg-[var(--bg-2)] disabled:opacity-40"
                        [attr.data-testid]="'transcribe-' + rec.id"
                        [disabled]="busy()"
                        (click)="transcribe(rec)"
                      >
                        Transcribe
                      </button>
                    </span>
                  }
                  @if (!ongoing) {
                    <span class="ml-auto" [appTooltip]="deleteTooltip" placement="bottom">
                      <button
                        type="button"
                        class="mono rounded px-2 py-0.5 text-[var(--ink-mute)] hover:bg-red-500/10 hover:text-red-300"
                        [attr.data-testid]="'delete-' + rec.id"
                        (click)="pendingDeleteId.set(rec.id)"
                      >
                        Delete
                      </button>
                    </span>
                  }
                </div>
              }
            }
          </li>
        }
      </ul>
    </div>
  `,
})
export class SessionListComponent implements OnInit {
  /** Emits the recording the user opened (the parent shows it in the right pane). */
  readonly opened = output<TranscriptSummary>();
  /** Forwards errors to the parent banner, the one place errors render. */
  readonly errorOccurred = output<string>();

  /** Id of the recording open in the right pane (for the highlight). */
  readonly selectedId = signal<string | null>(null);
  /** Recording whose inline delete confirmation is showing. */
  readonly pendingDeleteId = signal<string | null>(null);
  /** Whether the list is in multi-select mode. */
  readonly selecting = signal(false);
  /** Ids ticked in multi-select mode. */
  readonly selected = signal<ReadonlySet<string>>(new Set());
  /** Whether the bulk-delete confirmation is showing. */
  readonly pendingBulkDelete = signal(false);
  /** True while a delete or transcribe call runs. */
  readonly busy = signal(false);

  protected readonly continueTooltip = CONTINUE_TOOLTIP;
  protected readonly transcribeTooltip = TRANSCRIBE_TOOLTIP;
  protected readonly deleteTooltip = DELETE_TOOLTIP;
  protected readonly rowLockedTooltip = ROW_LOCKED_TOOLTIP;

  private readonly transcription = inject(TranscriptionService);
  /** True while any recording captures; done rows hide Continue then. */
  readonly recordingInProgress = this.transcription.recording;

  /** Rows in display order (the backend sorts newest first). */
  readonly rows = computed<RecordingRow[]>(() => {
    const now = new Date();
    return this.transcription.recordings().map((rec) => ({
      rec,
      name: recordingName(rec, now),
      when: rec.title?.trim() ? formatRecordingDate(rec.created_at, now) : null,
      duration: formatDuration(rec.duration_secs),
      size: formatBytes(rec.size_bytes),
      chip: statusChip(rec.status),
    }));
  });

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
   * Whether a recording's status can still change (no delete, no selection).
   * @param rec - the recording.
   */
  isOngoing(rec: TranscriptSummary): boolean {
    return isSessionOngoing(rec.status);
  }

  /**
   * A row other than the running recording cannot be opened while one records.
   * @param rec - the recording.
   */
  rowLocked(rec: TranscriptSummary): boolean {
    const recordingId = this.transcription.recordingSessionId();
    return recordingId !== null && recordingId !== rec.id;
  }

  /**
   * Chip colours per tone.
   * @param chip - the chip to colour.
   */
  chipClass(chip: StatusChip): string {
    switch (chip.tone) {
      case 'live':
        return 'bg-red-500/15 text-red-300';
      case 'busy':
        return 'bg-amber-500/15 text-amber-300';
      case 'ok':
        return 'bg-[var(--bg-2)] text-[var(--ink-mute)]';
      case 'error':
        return 'bg-red-500/15 text-red-300';
    }
  }

  /**
   * Marks a recording as the open one (for the row highlight).
   * @param id - recording id, or `null` to clear.
   */
  markSelected(id: string | null): void {
    this.selectedId.set(id);
  }

  /**
   * Opens a recording in the right pane.
   * @param rec - the recording.
   */
  open(rec: TranscriptSummary): void {
    if (this.rowLocked(rec)) return;
    this.selectedId.set(rec.id);
    this.opened.emit(rec);
  }

  /**
   * Continues a finished recording: a new part is appended to it.
   * @param rec - the recording to continue.
   */
  async resume(rec: TranscriptSummary): Promise<void> {
    try {
      await this.transcription.resumeRecording(
        rec.id,
        this.transcription.liveTranscriptPreferred()
      );
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
      return;
    }
    this.selectedId.set(rec.id);
  }

  /**
   * Transcribes a failed recording's audio again and opens it so the progress shows.
   * @param rec - the failed recording.
   */
  async transcribe(rec: TranscriptSummary): Promise<void> {
    this.busy.set(true);
    try {
      await this.transcription.transcribe(rec.id);
      if (this.selectedId() !== rec.id) this.open(rec);
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Deletes one recording (audio and transcript) after its confirmation.
   * @param id - the recording id.
   */
  async remove(id: string): Promise<void> {
    this.pendingDeleteId.set(null);
    this.busy.set(true);
    try {
      await this.transcription.delete(id);
      if (this.selectedId() === id) this.selectedId.set(null);
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Ticks or unticks a recording in multi-select mode.
   * @param id - the recording id.
   */
  toggleSelected(id: string): void {
    const next = new Set(this.selected());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.selected.set(next);
  }

  /** Leaves multi-select mode and clears the selection. */
  stopSelecting(): void {
    this.selecting.set(false);
    this.selected.set(new Set());
    this.pendingBulkDelete.set(false);
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
        if (this.selectedId() === id) this.selectedId.set(null);
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
}
