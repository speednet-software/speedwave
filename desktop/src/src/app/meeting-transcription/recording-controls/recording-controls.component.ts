import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  OnInit,
  computed,
  effect,
  inject,
  output,
  signal,
} from '@angular/core';

import { TranscriptionService } from '../../services/transcription.service';
import { LoggerService } from '../../services/logger.service';
import { TooltipDirective } from '../../shared/tooltip.directive';
import type { AudioSource, AudioSourceInfo, Language } from '../../models/transcript';
import { formatClock } from '../recording-format';

/** Tooltip on Start recording. */
const START_TOOLTIP =
  'Records system audio and your microphone on this machine. Nothing leaves your computer.';
/** Tooltip on Stop. */
const STOP_TOOLTIP =
  'Stops the capture and transcribes the audio. This takes a few minutes for a long meeting.';
/** Shortcut that starts or stops a recording while this view is open. */
const RECORD_SHORTCUT_HINT = '⌘⇧R';

/** A named input device for the microphone dropdown. */
interface MicChoice {
  uid: string;
  name: string;
}

/**
 * A source's mic device id, or null if it isn't a named-mic source.
 * @param s - the audio source.
 */
function micDeviceId(s: AudioSource): string | null {
  return s.kind === 'microphone' && s.device ? s.device : null;
}

/**
 * Strips the `Microphone: ` prefix from a source label for the dropdown.
 * @param label - the source's display label.
 */
function micName(label: string): string {
  return label.replace(/^Microphone:\s*/, '');
}

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
 * Recording controls. Idle: language (PL/EN, never auto-detected), source, microphone and Start.
 * Recording: the elapsed time, a loudness meter per channel and Stop. Emits `started`/`stopped`;
 * errors go to the parent banner only. ⌘⇧R / Ctrl+Shift+R starts or stops.
 */
@Component({
  selector: 'app-recording-controls',
  standalone: true,
  imports: [TooltipDirective],
  host: { '(document:keydown)': 'onKeydown($event)' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      class="rounded-md border border-[var(--line)] bg-[var(--bg-1)] p-3"
      data-testid="recording-controls"
    >
      @if (recording()) {
        <div class="flex items-center gap-4" data-testid="recording-view">
          <div class="flex items-center gap-2">
            <span
              class="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500"
              aria-hidden="true"
            ></span>
            <span
              class="mono text-2xl tabular-nums text-[var(--ink)]"
              data-testid="recording-clock"
              role="timer"
              aria-label="Recording time"
              >{{ clock() }}</span
            >
          </div>
          <div class="flex-1 space-y-1" data-testid="audio-level-meter">
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
          <span [appTooltip]="stopTooltip" [tooltipKbd]="shortcutHint" placement="left">
            <button
              type="button"
              class="mono rounded border border-red-500/50 bg-red-500/10 px-4 py-1.5 text-[12px] text-red-300 hover:bg-red-500/20 disabled:opacity-40"
              data-testid="stop-btn"
              [disabled]="busy()"
              (click)="stop()"
            >
              {{ busy() ? 'stopping…' : 'Stop' }}
            </button>
          </span>
        </div>
        @if (!recordingLive()) {
          <p class="mt-2 text-[11px] text-[var(--ink-mute)]" data-testid="after-stop-note">
            Transcript appears after you stop.
          </p>
        }
      } @else {
        <h3 class="mono mb-2 text-[11px] uppercase tracking-widest text-[var(--ink-mute)]">
          New recording
        </h3>
        <div class="flex flex-wrap items-center gap-3 text-[12px]">
          <label class="flex items-center gap-1">
            <span class="text-[var(--ink-mute)]">Language</span>
            <select
              class="rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-0.5"
              data-testid="language-select"
              (change)="onLanguage($any($event.target).value)"
            >
              <option value="pl" [selected]="language() === 'pl'">Polish</option>
              <option value="en" [selected]="language() === 'en'">English</option>
            </select>
          </label>

          <label class="flex items-center gap-1">
            <span class="text-[var(--ink-mute)]">Source</span>
            <select
              class="rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-0.5"
              data-testid="source-select"
              (change)="onSource(+$any($event.target).value)"
            >
              @for (s of sources(); track $index) {
                <option [value]="$index" [selected]="$index === sourceIndex()">
                  {{ s.label }}
                </option>
              }
            </select>
          </label>

          @if (micSelectable() && mics().length > 0) {
            <label class="flex items-center gap-1">
              <span class="text-[var(--ink-mute)]">Microphone</span>
              <select
                class="rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-0.5"
                data-testid="mic-select"
                (change)="onMic($any($event.target).value)"
              >
                <option value="" [selected]="micDevice() === null">System default</option>
                @for (m of mics(); track m.uid) {
                  <option [value]="m.uid" [selected]="m.uid === micDevice()">{{ m.name }}</option>
                }
              </select>
            </label>
          }
        </div>

        @if (mixedSourceSelected()) {
          <p class="mono mt-1 text-[10px] text-[var(--ink-mute)]" data-testid="mixed-source-note">
            Records the other participants (system audio) and your microphone. Your OS may ask for
            microphone and audio-recording permission the first time.
          </p>
        }

        @if (modelsKnown() && !hasModel()) {
          <p class="mono mt-2 text-[10px] text-[var(--ink-mute)]" data-testid="no-model-note">
            No speech-to-text model is downloaded yet. Download it in Settings → Meeting
            transcription; the download uses the network.
          </p>
        }

        @if (hasModel() && missingFinalizeModel(); as missing) {
          <p class="mono mt-2 text-[10px] text-amber-300" data-testid="finalize-model-warning">
            The final-pass model ({{ missing }}) is not downloaded, so the transcript produced after
            you stop falls back to the lower-quality live model. Download it in Settings → Meeting
            transcription.
          </p>
        }

        <div class="mt-3">
          <span [appTooltip]="startTooltip" [tooltipKbd]="shortcutHint" placement="right">
            <button
              type="button"
              class="mono rounded bg-[var(--accent)] px-3 py-1 text-[12px] font-medium text-[var(--bg)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              data-testid="start-btn"
              [disabled]="!canStart()"
              (click)="start()"
            >
              {{ busy() ? 'starting…' : 'Start recording' }}
            </button>
          </span>
        </div>
      }
    </section>
  `,
})
export class RecordingControlsComponent implements OnInit {
  /** Emitted with the new session id once recording starts. */
  readonly started = output<string>();
  /** Emitted with the stopped session id. */
  readonly stopped = output<string>();
  /** Forwards errors to the parent banner. */
  readonly errorOccurred = output<string>();

  /** Forced language (never auto-detect). */
  readonly language = signal<Language>('pl');
  /** Audio sources from the host backend. */
  readonly sources = signal<AudioSourceInfo[]>([]);
  /** Index into `sources()` of the chosen source. */
  readonly sourceIndex = signal(0);
  /** Disables Start/Stop while a transition is in flight. */
  readonly busy = signal(false);
  /** `false` until the model list has been read at least once. */
  readonly modelsKnown = signal(false);
  /** `true` if at least one Whisper model is downloaded (Start needs one). */
  readonly hasModel = signal(false);
  /**
   * Display name of this host's finalize-pass model when it is not downloaded, else null.
   * Start stays allowed — the offline pass falls back to the live model — but the quality
   * cost must be visible before the recording, not discovered in the finished transcript.
   */
  readonly missingFinalizeModel = signal<string | null>(null);
  /** `true` when the chosen source is the mixed (system + mic) one. */
  readonly mixedSourceSelected = computed(
    () => this.sources()[this.sourceIndex()]?.source.kind === 'mixed'
  );
  /** Chosen mic device id (UID on macOS, name on Windows); null = system default. */
  readonly micDevice = signal<string | null>(null);
  /** Named input devices, derived from the source list. */
  readonly mics = computed<MicChoice[]>(() =>
    this.sources()
      .filter((s) => micDeviceId(s.source) !== null)
      .map((s) => ({ uid: micDeviceId(s.source) as string, name: micName(s.label) }))
  );
  /** Whether the chosen source uses a mic (mixed or mic-only) — shows the picker. */
  readonly micSelectable = computed(() => {
    const k = this.sources()[this.sourceIndex()]?.source.kind;
    return k === 'mixed' || k === 'microphone';
  });

  private readonly transcription = inject(TranscriptionService);
  private readonly log = inject(LoggerService);
  private readonly cdr = inject(ChangeDetectorRef);

  /**
   * `true` while a recording is in progress — read from the service so it
   * survives this tab being destroyed on navigation (the driver keeps going).
   */
  readonly recording = this.transcription.recording;

  /** Whether the running recording shows live text (then no "appears after you stop" note). */
  readonly recordingLive = computed(() => this.transcription.recordingLive() === true);

  /** Whether Start can be pressed now. */
  readonly canStart = computed(
    () => !this.busy() && this.sources().length > 0 && !(this.modelsKnown() && !this.hasModel())
  );

  protected readonly startTooltip = START_TOOLTIP;
  protected readonly stopTooltip = STOP_TOOLTIP;
  protected readonly shortcutHint = RECORD_SHORTCUT_HINT;

  /** Wall-clock tick that drives the elapsed-time display while recording. */
  private readonly now = signal(Date.now());

  /** Elapsed time of the running recording (or its resumed part). */
  readonly clock = computed(() => {
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

  /** Ticks the clock once a second, only while a recording runs. */
  constructor() {
    let timer: ReturnType<typeof setInterval> | undefined;
    const clear = (): void => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    effect(() => {
      if (this.recording()) {
        this.now.set(Date.now());
        if (timer === undefined) timer = setInterval(() => this.now.set(Date.now()), 1000);
      } else {
        clear();
      }
    });
    inject(DestroyRef).onDestroy(clear);
  }

  /** Loads capabilities + source list + model availability on first paint. */
  async ngOnInit(): Promise<void> {
    try {
      const list = await this.transcription.listAudioSources();
      this.sources.set(list);
      const inProgressSource = this.transcription.recordingSource();
      if (inProgressSource) {
        this.restoreFromInProgressRecording(list, inProgressSource);
      } else {
        const mixedIdx = list.findIndex((s) => s.source.kind === 'mixed');
        const sysIdx = list.findIndex((s) => s.source.kind === 'system_wide');
        this.sourceIndex.set(mixedIdx >= 0 ? mixedIdx : sysIdx >= 0 ? sysIdx : 0);
      }
      const inProgressLanguage = this.transcription.recordingLanguage();
      if (inProgressLanguage) this.language.set(inProgressLanguage);
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
    await this.refreshModelAvailability();
    this.cdr.markForCheck();
  }

  /**
   * Restores the picker selection of a recording already in progress.
   * @param list - the freshly-loaded source list.
   * @param source - the in-progress recording's source.
   */
  private restoreFromInProgressRecording(list: AudioSourceInfo[], source: AudioSource): void {
    const idx = list.findIndex((s) => s.source.kind === source.kind);
    if (idx >= 0) this.sourceIndex.set(idx);
    if (source.kind === 'mixed') this.micDevice.set(source.mic);
    else if (source.kind === 'microphone') this.micDevice.set(source.device);
  }

  /**
   * Re-reads whether a Whisper model is downloaded. The parent calls this after
   * a model download finishes so the Start button un-disables.
   */
  async refreshModelAvailability(): Promise<void> {
    try {
      const ack = await this.transcription.listModels();
      this.hasModel.set(ack.whisper.some((m) => m.downloaded));
      this.modelsKnown.set(true);
    } catch {
      this.modelsKnown.set(false);
    }
    try {
      const fin = (await this.transcription.recommendedModel()).finalize;
      this.missingFinalizeModel.set(
        fin && !fin.downloaded && !fin.downloading ? fin.display_name : null
      );
    } catch (e: unknown) {
      this.log.warn(`recommended-model check failed: ${e instanceof Error ? e.message : e}`);
      this.missingFinalizeModel.set(null);
    }
    this.cdr.markForCheck();
  }

  /**
   * Updates the forced language.
   * @param v - 'pl' or 'en'.
   */
  onLanguage(v: string): void {
    if (v === 'pl' || v === 'en') this.language.set(v);
  }

  /**
   * Updates the chosen source index.
   * @param i - index into `sources()`.
   */
  onSource(i: number): void {
    if (i >= 0 && i < this.sources().length) this.sourceIndex.set(i);
  }

  /**
   * Updates the chosen mic device.
   * @param uid - device id, or '' for the system default.
   */
  onMic(uid: string): void {
    this.micDevice.set(uid === '' ? null : uid);
  }

  /**
   * Overlays the chosen mic onto a mixed/mic source (no-op for others).
   * @param src - the picked source.
   */
  private applyMic(src: AudioSource): AudioSource {
    const mic = this.micDevice();
    if (src.kind === 'mixed') return { ...src, mic };
    if (src.kind === 'microphone') return { ...src, device: mic };
    return src;
  }

  /**
   * ⌘⇧R / Ctrl+Shift+R starts a recording, or stops the running one.
   * @param event - the document keydown.
   */
  onKeydown(event: KeyboardEvent): void {
    if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== 'r') {
      return;
    }
    event.preventDefault();
    if (this.recording()) {
      if (!this.busy()) void this.stop();
    } else if (this.canStart()) {
      void this.start();
    }
  }

  /** Starts recording the chosen source in the chosen language. */
  async start(): Promise<void> {
    const picked: AudioSource | undefined = this.sources()[this.sourceIndex()]?.source;
    if (!picked) {
      this.errorOccurred.emit('no audio source selected');
      return;
    }
    const src = this.applyMic(picked);
    this.busy.set(true);
    try {
      if (src.kind !== 'system_wide' && !(await this.ensureMicConsent())) {
        return;
      }
      const ack = await this.transcription.startRecording(
        src,
        this.language(),
        this.transcription.liveTranscriptPreferred()
      );
      this.started.emit(ack.session_id);
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
      this.cdr.markForCheck();
    }
  }

  /**
   * Resolves mic consent before a mic-including capture starts; on refusal
   * surfaces the error and, for an earlier refusal, deep-links to Settings.
   */
  private async ensureMicConsent(): Promise<boolean> {
    const verdict = await this.transcription.requestMicrophonePermission();
    if (verdict === 'granted') return true;
    if (verdict === 'previously_denied') {
      await this.transcription.openMicrophonePrivacyPane().catch(() => undefined);
    }
    this.errorOccurred.emit(
      'microphone permission denied — enable Speedwave under System Settings → ' +
        'Privacy & Security → Microphone, then start again'
    );
    return false;
  }

  /** Stops the in-progress recording. */
  async stop(): Promise<void> {
    const id = this.transcription.recordingSessionId();
    if (!id) return;
    this.busy.set(true);
    try {
      await this.transcription.stopRecording(id);
      this.stopped.emit(id);
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
    this.busy.set(false);
    this.cdr.markForCheck();
  }
}
