import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnInit,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';

import { TranscriptionService } from '../../services/transcription.service';
import type { AudioSource, AudioSourceInfo, Backend, Language } from '../../models/transcript';

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
 * Joins compiled backends into a short "Acceleration: …" string.
 * @param backends - whisper.cpp backends compiled into this build.
 */
function accelLabel(backends: Backend[]): string {
  if (backends.includes('metal')) return 'Acceleration: Metal';
  return 'Acceleration: CPU only';
}

/**
 * Recording controls: language toggle (PL/EN, never auto-detected), audio source picker
 * (Whole meeting / System / Microphone), acceleration badge, Start/Stop; emits `started`/`stopped`.
 */
@Component({
  selector: 'app-recording-controls',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      class="rounded-md border border-[var(--line)] bg-[var(--bg-1)] p-3"
      data-testid="recording-controls"
    >
      <h3 class="mono mb-2 text-[11px] uppercase tracking-widest text-[var(--ink-mute)]">Record</h3>
      @if (error()) {
        <p class="mb-2 text-[12px] text-red-300" data-testid="recording-error">{{ error() }}</p>
      }

      <div class="flex flex-wrap items-center gap-3 text-[12px]">
        <label class="flex items-center gap-1">
          <span class="text-[var(--ink-mute)]">Language</span>
          <select
            class="rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-0.5"
            data-testid="language-select"
            [disabled]="recording()"
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
            [disabled]="recording()"
            (change)="onSource(+$any($event.target).value)"
          >
            @for (s of sources(); track $index) {
              <option [value]="$index" [selected]="$index === sourceIndex()">{{ s.label }}</option>
            }
          </select>
        </label>

        @if (micSelectable() && mics().length > 0) {
          <label class="flex items-center gap-1">
            <span class="text-[var(--ink-mute)]">Microphone</span>
            <select
              class="rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-0.5"
              data-testid="mic-select"
              [disabled]="recording()"
              (change)="onMic($any($event.target).value)"
            >
              <option value="" [selected]="micDevice() === null">System default</option>
              @for (m of mics(); track m.uid) {
                <option [value]="m.uid" [selected]="m.uid === micDevice()">{{ m.name }}</option>
              }
            </select>
          </label>
        }

        <span class="mono text-[10px] text-[var(--ink-mute)]" data-testid="accel-badge">
          {{ accel() }}
        </span>
      </div>

      @if (mixedSourceSelected()) {
        <p class="mono mt-1 text-[10px] text-[var(--ink-mute)]" data-testid="mixed-source-note">
          Recording the whole meeting captures system audio (the other participants) and your
          microphone. Your OS may ask for microphone and audio-recording permission the first time.
        </p>
      }

      @if (modelsKnown() && !hasModel()) {
        <p class="mono mt-2 text-[10px] text-[var(--ink-mute)]" data-testid="no-model-note">
          No speech-to-text model is downloaded yet. Download it in Settings → Meeting transcription
          — the download uses the network.
        </p>
      }

      <div class="mt-3">
        @if (!recording()) {
          <button
            type="button"
            class="mono rounded bg-[var(--accent)] px-3 py-1 text-[12px] font-medium text-[var(--bg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid="start-btn"
            [disabled]="busy() || sources().length === 0 || (modelsKnown() && !hasModel())"
            (click)="start()"
          >
            {{ busy() ? 'starting…' : 'Start recording' }}
          </button>
        } @else {
          <button
            type="button"
            class="mono rounded border border-red-500/50 bg-red-500/10 px-3 py-1 text-[12px] text-red-300 hover:bg-red-500/20 disabled:opacity-40"
            data-testid="stop-btn"
            [disabled]="busy()"
            (click)="stop()"
          >
            {{ busy() ? 'stopping…' : 'Stop recording' }}
          </button>
        }
      </div>
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
  /** Compiled whisper.cpp backends for this build. */
  readonly backends = signal<Backend[]>([]);
  /** Derived acceleration label. */
  readonly accel = computed(() => accelLabel(this.backends()));
  /** Disables Start/Stop while a transition is in flight. */
  readonly busy = signal(false);
  /** Local error string. */
  readonly error = signal('');
  /** `false` until the model list has been read at least once. */
  readonly modelsKnown = signal(false);
  /** `true` if at least one Whisper model is downloaded (Start needs one). */
  readonly hasModel = signal(false);
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
  private readonly cdr = inject(ChangeDetectorRef);

  /**
   * `true` while a recording is in progress — read from the service so it
   * survives this tab being destroyed on navigation (the driver keeps going).
   */
  readonly recording = computed(() => this.transcription.recordingSessionId() !== null);

  /** Loads backends + source list + model availability on first paint. */
  async ngOnInit(): Promise<void> {
    try {
      const caps = await this.transcription.getCapabilities();
      this.backends.set(caps.backends);
      const list = await this.transcription.listAudioSources();
      this.sources.set(list);
      const inProgressSource = this.transcription.recordingSource();
      if (inProgressSource) {
        // A recording started before this instance existed (remount) — restore its
        // picker selection instead of showing the compile-time defaults.
        this.restoreFromInProgressRecording(list, inProgressSource);
      } else {
        // Default to "Whole meeting" (mixed) if offered, else "System
        // (everything)", else the first entry.
        const mixedIdx = list.findIndex((s) => s.source.kind === 'mixed');
        const sysIdx = list.findIndex((s) => s.source.kind === 'system_wide');
        this.sourceIndex.set(mixedIdx >= 0 ? mixedIdx : sysIdx >= 0 ? sysIdx : 0);
      }
      const inProgressLanguage = this.transcription.recordingLanguage();
      if (inProgressLanguage) this.language.set(inProgressLanguage);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.error.set(msg);
      this.errorOccurred.emit(msg);
    }
    await this.refreshModelAvailability();
    this.cdr.markForCheck();
  }

  /**
   * Restores `sourceIndex`/`micDevice` to match the source of a recording already in progress.
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
      // Non-fatal — leave Start enabled and let start() surface any error.
      this.modelsKnown.set(false);
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

  /** Starts recording the chosen source in the chosen language. */
  async start(): Promise<void> {
    const picked: AudioSource | undefined = this.sources()[this.sourceIndex()]?.source;
    if (!picked) {
      this.error.set('no audio source selected');
      return;
    }
    const src = this.applyMic(picked);
    this.busy.set(true);
    this.error.set('');
    try {
      if (src.kind !== 'system_wide' && !(await this.ensureMicConsent())) {
        return;
      }
      const ack = await this.transcription.startRecording(src, this.language());
      this.started.emit(ack.session_id);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.error.set(msg);
      this.errorOccurred.emit(msg);
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
      // Nothing to re-prompt — only the Settings pane can restore access.
      await this.transcription.openMicrophonePrivacyPane().catch(() => undefined);
    }
    const msg =
      'microphone permission denied — enable Speedwave under System Settings → ' +
      'Privacy & Security → Microphone, then start again';
    this.error.set(msg);
    this.errorOccurred.emit(msg);
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
      const msg = e instanceof Error ? e.message : String(e);
      this.error.set(msg);
      this.errorOccurred.emit(msg);
    }
    this.busy.set(false);
    this.cdr.markForCheck();
  }
}
