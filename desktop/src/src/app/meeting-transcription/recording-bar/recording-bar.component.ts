import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  output,
  signal,
} from '@angular/core';

import { TranscriptionService } from '../../services/transcription.service';
import { TooltipDirective } from '../../shared/tooltip.directive';
import { IconComponent } from '../../shared/icon.component';
import {
  LANGUAGE_NAME,
  RECORD_SHORTCUT_HINT,
  formatClock,
  recordingName,
} from '../recording-format';

/** Shortcut that pauses or resumes the recording while this view is open. */
const PAUSE_SHORTCUT_HINT = '⌘⇧P';
/** Tooltip on Stop. */
const STOP_TOOLTIP =
  'Stops the capture and transcribes the audio. This takes a few minutes for a long meeting.';
/** Tooltip on Pause. */
const PAUSE_TOOLTIP =
  'Stops capturing and turns the microphone off. Resume adds to the same recording.';

/**
 * Maps linear RMS to a 0-100 meter width on a dB scale (-60..0 dBFS): speech RMS sits around
 * 0.005-0.15, which a linear meter would render as a near-invisible sliver.
 * @param rms - linear RMS in 0..1.
 */
function rmsToPct(rms: number): number {
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.round(Math.min(100, Math.max(0, ((db + 60) / 60) * 100)));
}

/**
 * Recording bar (full width under the view header) for the recording that is capturing or paused,
 * whichever recording the pane shows. Capturing: name, clock, a loudness meter per channel, Pause
 * and Stop. Paused: the stopped clock, Resume and Stop and transcribe. ⌘⇧P pauses or resumes,
 * ⌘⇧R stops (resumes while paused). Errors go to the parent banner.
 */
@Component({
  selector: 'app-recording-bar',
  standalone: true,
  imports: [TooltipDirective, IconComponent],
  host: { '(document:keydown)': 'onKeydown($event)' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="flex items-center gap-5 border-b px-6 py-2.5"
      [class]="
        paused() ? 'border-amber-500/35 bg-amber-500/[0.06]' : 'border-red-500/35 bg-red-500/[0.06]'
      "
      data-testid="recording-view"
      [attr.data-state]="paused() ? 'paused' : 'recording'"
    >
      @if (paused()) {
        <app-icon name="pause" class="h-4 w-4 text-amber-300" [strokeWidth]="2.5" />
      } @else {
        <span
          class="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500 shadow-[0_0_0_4px_rgba(239,68,68,0.2)]"
          aria-hidden="true"
        ></span>
      }
      <button
        type="button"
        class="min-w-0 text-left text-[12px] leading-snug text-[var(--ink-dim)] hover:text-[var(--ink)]"
        data-testid="recording-label"
        [attr.aria-label]="'Open ' + name()"
        (click)="openRecording()"
      >
        <span class="block truncate text-[13px] font-semibold text-[var(--ink)]"
          >{{ paused() ? 'Paused' : 'Recording' }}: {{ name() }}</span
        >
        <span class="block truncate">{{ detail() }}</span>
      </button>
      <span
        class="mono text-[22px] tabular-nums"
        [class]="paused() ? 'text-[var(--ink-mute)]' : 'text-[var(--ink)]'"
        data-testid="recording-clock"
        role="timer"
        aria-label="Recording time"
        >{{ clock() }}</span
      >
      @if (!paused()) {
        <div class="flex max-w-[22rem] flex-1 flex-col gap-1" data-testid="audio-level-meter">
          @for (bar of meterBars(); track bar.label) {
            <div class="flex items-center gap-2">
              <span class="mono w-14 shrink-0 text-[10px] text-[var(--ink-mute)]">{{
                bar.label
              }}</span>
              <div class="h-1.5 flex-1 overflow-hidden rounded bg-[var(--bg-2)]">
                <div
                  class="h-full bg-[var(--accent)] transition-[width] duration-150"
                  [style.width.%]="bar.pct"
                ></div>
              </div>
            </div>
          }
        </div>
      }
      <span class="flex-1"></span>
      @if (paused()) {
        <span
          [appTooltip]="'Records a new part of this recording.'"
          [tooltipKbd]="pauseHint"
          placement="bottom"
        >
          <button
            type="button"
            class="mono inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12px] font-semibold text-[var(--bg)] hover:opacity-90 disabled:opacity-40"
            data-testid="resume-btn"
            [disabled]="busy()"
            (click)="resume()"
          >
            <app-icon name="microphone" class="h-3.5 w-3.5" [strokeWidth]="2" />
            {{ busy() ? 'Resuming…' : 'Resume' }}
          </button>
        </span>
        <span [appTooltip]="stopTooltip" placement="bottom">
          <button
            type="button"
            class="mono inline-flex items-center gap-1.5 rounded-md border border-red-500/45 bg-red-500/10 px-3 py-1.5 text-[12px] text-red-300 hover:bg-red-500/20 disabled:opacity-40"
            data-testid="stop-btn"
            [disabled]="busy()"
            (click)="stop()"
          >
            <app-icon name="stop" class="h-3 w-3" [strokeWidth]="2.5" />
            Stop and transcribe
          </button>
        </span>
      } @else {
        <span [appTooltip]="pauseTooltip" [tooltipKbd]="pauseHint" placement="bottom">
          <button
            type="button"
            class="mono inline-flex items-center gap-1.5 rounded-md border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1.5 text-[12px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40"
            data-testid="pause-btn"
            [disabled]="busy()"
            (click)="pause()"
          >
            <app-icon name="pause" class="h-3.5 w-3.5" [strokeWidth]="2.5" />
            {{ busy() ? 'Pausing…' : 'Pause' }}
          </button>
        </span>
        <span [appTooltip]="stopTooltip" [tooltipKbd]="stopHint" placement="bottom">
          <button
            type="button"
            class="mono inline-flex items-center gap-1.5 rounded-md border border-red-500/45 bg-red-500/10 px-3 py-1.5 text-[12px] text-red-300 hover:bg-red-500/20 disabled:opacity-40"
            data-testid="stop-btn"
            [disabled]="busy()"
            (click)="stop()"
          >
            <app-icon name="stop" class="h-3 w-3" [strokeWidth]="2.5" />
            {{ busy() ? 'Stopping…' : 'Stop' }}
          </button>
        </span>
      }
    </div>
  `,
})
export class RecordingBarComponent {
  /** Asks the parent to open the recording in the pane. */
  readonly opened = output<string>();
  /** Emitted with the stopped session id. */
  readonly stopped = output<string>();
  /** Forwards errors to the parent banner. */
  readonly errorOccurred = output<string>();

  /** Disables the buttons while a pause, resume or stop is in flight. */
  readonly busy = signal(false);

  protected readonly pauseHint = PAUSE_SHORTCUT_HINT;
  protected readonly stopHint = RECORD_SHORTCUT_HINT;
  protected readonly stopTooltip = STOP_TOOLTIP;
  protected readonly pauseTooltip = PAUSE_TOOLTIP;

  private readonly transcription = inject(TranscriptionService);

  /** The paused recording when nothing captures. */
  readonly paused = computed(
    () => !this.transcription.recording() && this.transcription.pausedRecording() !== null
  );

  /** Id of the recording this bar controls. */
  readonly sessionId = computed(
    () =>
      this.transcription.recordingSessionId() ?? this.transcription.pausedRecording()?.id ?? null
  );

  /** Its list row, once the list has it. */
  private readonly summary = computed(() => {
    const id = this.sessionId();
    return this.transcription.recordings().find((r) => r.id === id) ?? null;
  });

  /** Its name: the title, else the local start time. */
  readonly name = computed(() => {
    const row = this.summary();
    if (row) return recordingName(row);
    const open = this.transcription.active();
    return open && open.id === this.sessionId() ? recordingName(open) : 'New recording';
  });

  /** Second line: language and source while capturing, what a pause means while paused. */
  readonly detail = computed(() => {
    if (this.paused()) return 'Nothing is being recorded. The microphone is off.';
    const lang = this.transcription.recordingLanguage() ?? this.summary()?.language ?? 'pl';
    const source = this.summary()?.source_label ?? '';
    return [LANGUAGE_NAME[lang], source].filter(Boolean).join(' · ');
  });

  /** Wall-clock tick that drives the elapsed-time display while recording. */
  private readonly now = signal(Date.now());

  /** Recorded length: running while capturing, stopped at the recorded audio while paused. */
  readonly clock = computed(() => {
    if (this.paused()) {
      return formatClock((this.transcription.pausedRecording()?.duration_secs ?? 0) * 1000);
    }
    const started = this.transcription.recordingStartedAt();
    return started === null ? '00:00' : formatClock(this.now() - started);
  });

  /** Loudness bars: one per captured channel, 0-100 for the width binding. */
  readonly meterBars = computed<{ label: string; pct: number }[]>(() => {
    const kind = this.transcription.recordingSource()?.kind;
    const levels = this.transcription.audioLevels() ?? [];
    if (kind === 'mixed' || levels.length === 2) {
      return [
        { label: 'Meeting', pct: rmsToPct(levels[0] ?? 0) },
        { label: 'You', pct: rmsToPct(levels[1] ?? 0) },
      ];
    }
    return [{ label: kind === 'microphone' ? 'You' : 'Meeting', pct: rmsToPct(levels[0] ?? 0) }];
  });

  /** Ticks the clock once a second, only while a recording captures. */
  constructor() {
    let timer: ReturnType<typeof setInterval> | undefined;
    const clear = (): void => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    effect(() => {
      if (this.transcription.recording()) {
        this.now.set(Date.now());
        if (timer === undefined) timer = setInterval(() => this.now.set(Date.now()), 1000);
      } else {
        clear();
      }
    });
    inject(DestroyRef).onDestroy(clear);
  }

  /**
   * ⌘⇧P pauses or resumes; ⌘⇧R stops a capture and resumes a paused recording.
   * @param event - the document keydown.
   */
  onKeydown(event: KeyboardEvent): void {
    if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return;
    const key = event.key.toLowerCase();
    if (key !== 'p' && key !== 'r') return;
    event.preventDefault();
    if (this.busy()) return;
    if (this.paused()) void this.resume();
    else if (key === 'p') void this.pause();
    else void this.stop();
  }

  /** Opens the recording in the pane. */
  openRecording(): void {
    const id = this.sessionId();
    if (id) this.opened.emit(id);
  }

  /** Pauses the capture. */
  async pause(): Promise<void> {
    const id = this.transcription.recordingSessionId();
    if (!id) return;
    await this.run(() => this.transcription.pauseRecording(id));
  }

  /** Resumes the paused recording with a new part. */
  async resume(): Promise<void> {
    const id = this.transcription.pausedRecording()?.id;
    if (!id) return;
    await this.run(async () => {
      await this.transcription.resumeRecording(id, this.transcription.liveTranscriptPreferred());
    });
  }

  /** Stops the capture (or the paused recording) and starts its transcription. */
  async stop(): Promise<void> {
    const id = this.sessionId();
    if (!id) return;
    const ok = await this.run(() => this.transcription.stopRecording(id));
    if (ok) this.stopped.emit(id);
  }

  /**
   * Runs one transition with the buttons disabled; a failure goes to the banner.
   * @param action - the transition.
   * @returns whether it succeeded.
   */
  private async run(action: () => Promise<void>): Promise<boolean> {
    this.busy.set(true);
    try {
      await action();
      return true;
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
