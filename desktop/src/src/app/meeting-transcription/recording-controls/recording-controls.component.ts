import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnInit,
  inject,
  output,
  signal,
} from '@angular/core';

import { TranscriptionService } from '../../services/transcription.service';
import type {
  AudioSource,
  AudioSourceInfo,
  Backend,
  CaptureCapabilities,
  Language,
} from '../../models/transcript';

/**
 * Joins compiled backends into a short "Acceleration: …" string.
 * @param backends - whisper.cpp backends compiled into this build.
 */
function accelLabel(backends: Backend[]): string {
  if (backends.includes('metal')) return 'Acceleration: Metal';
  if (backends.includes('cuda')) return 'Acceleration: CUDA';
  if (backends.includes('vulkan')) return 'Acceleration: Vulkan';
  return 'Acceleration: CPU only';
}

/**
 * Recording controls: language toggle (PL/EN — never auto-detected), audio
 * source picker (per-app entries only when the host backend supports it), an
 * acceleration badge, and Start/Stop. Emits `started`/`stopped` so the parent
 * can subscribe to / detach from the session's live stream.
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

        <span class="mono text-[10px] text-[var(--ink-mute)]" data-testid="accel-badge">
          {{ accel() }}
        </span>
      </div>

      @if (capabilities() && !capabilities()!.supports_per_process) {
        <p class="mono mt-1 text-[10px] text-[var(--ink-mute)]" data-testid="per-app-note">
          {{ capabilities()!.note ?? 'Per-app capture isn’t available on this host.' }}
        </p>
      }

      @if (modelsKnown() && !hasModel()) {
        <p class="mono mt-2 text-[10px] text-[var(--ink-mute)]" data-testid="no-model-note">
          No speech-to-text model is downloaded yet. Download one in the Models panel (the smallest,
          'small', is about 488 MB) — downloads use the network.
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
  /** Host capture capabilities (drives the per-app note). */
  readonly capabilities = signal<CaptureCapabilities | null>(null);
  /** Compiled-backends acceleration label. */
  readonly accel = signal('Acceleration: CPU only');
  /** `true` while a recording is in progress. */
  readonly recording = signal(false);
  /** Disables Start/Stop while a transition is in flight. */
  readonly busy = signal(false);
  /** Local error string. */
  readonly error = signal('');
  /** `false` until the model list has been read at least once. */
  readonly modelsKnown = signal(false);
  /** `true` if at least one Whisper model is downloaded (Start needs one). */
  readonly hasModel = signal(false);
  /** The active session id (set on start, cleared on stop). */
  private activeSessionId: string | null = null;

  private readonly transcription = inject(TranscriptionService);
  private readonly cdr = inject(ChangeDetectorRef);

  /** Loads capabilities + source list + model availability on first paint. */
  async ngOnInit(): Promise<void> {
    try {
      const caps = await this.transcription.getCapabilities();
      this.capabilities.set(caps.capabilities);
      this.accel.set(accelLabel(caps.backends));
      const list = await this.transcription.listAudioSources();
      this.sources.set(list);
      // Default to "System (everything)" if present.
      const sysIdx = list.findIndex((s) => s.source.kind === 'system_wide');
      this.sourceIndex.set(sysIdx >= 0 ? sysIdx : 0);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.error.set(msg);
      this.errorOccurred.emit(msg);
    }
    await this.refreshModelAvailability();
    this.cdr.markForCheck();
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

  /** Starts recording the chosen source in the chosen language. */
  async start(): Promise<void> {
    const src: AudioSource | undefined = this.sources()[this.sourceIndex()]?.source;
    if (!src) {
      this.error.set('no audio source selected');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      const ack = await this.transcription.startRecording(src, this.language());
      this.activeSessionId = ack.session_id;
      this.recording.set(true);
      this.started.emit(ack.session_id);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.error.set(msg);
      this.errorOccurred.emit(msg);
    }
    this.busy.set(false);
    this.cdr.markForCheck();
  }

  /** Stops the in-progress recording. */
  async stop(): Promise<void> {
    const id = this.activeSessionId;
    if (!id) return;
    this.busy.set(true);
    try {
      await this.transcription.stopRecording(id);
      this.recording.set(false);
      this.activeSessionId = null;
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
