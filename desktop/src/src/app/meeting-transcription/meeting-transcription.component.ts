import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { TranscriptionService } from '../services/transcription.service';
import { LoggerService } from '../services/logger.service';
import type { TranscriptSession } from '../models/transcript';
import { RecordingControlsComponent } from './recording-controls/recording-controls.component';
import { LiveTranscriptComponent } from './live-transcript/live-transcript.component';
import { SessionListComponent } from './session-list/session-list.component';

/**
 * Meeting transcription tab (beta-gated): recordings list + controls/live transcript. Transcription
 * is local; only "Send to Claude" uses the network. No model yet → gate points to Settings.
 */
@Component({
  selector: 'app-meeting-transcription',
  standalone: true,
  imports: [RouterLink, RecordingControlsComponent, LiveTranscriptComponent, SessionListComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="flex h-full flex-1 flex-col overflow-hidden bg-[var(--bg)] text-[var(--ink)]">
      @if (modelReady() === false) {
        <section
          class="flex flex-1 flex-col items-center justify-center bg-[var(--bg)] p-8"
          data-testid="model-required-gate"
        >
          <div class="mono max-w-md text-center text-[12.5px] text-[var(--ink-dim)]">
            <p class="text-[var(--amber)]">⬇ model required</p>
            <p class="mt-2">
              Download the local speech-recognition model to start transcribing. It runs entirely on
              this machine.
            </p>
            <a
              routerLink="/settings"
              fragment="section-transcription"
              class="mono mt-4 inline-block text-[var(--accent)] hover:underline"
              data-testid="download-model-link"
              >download model in settings →</a
            >
          </div>
        </section>
      } @else {
        <header class="flex items-center justify-between border-b border-[var(--line)] px-6 py-4">
          <div>
            <h1 class="text-lg font-semibold">Meeting transcription</h1>
            <p class="text-sm text-[var(--ink-mute)]">
              Audio is transcribed locally on this machine. "Send to chat" uses the network.
            </p>
            <p class="mt-1 text-xs text-[var(--ink-mute)]" data-testid="quality-disclaimer">
              Quality varies by content: read speech (e.g. dictation) is ~5% word error rate;
              spontaneous meeting speech is ~25-30% across all open models (industry-wide limit).
            </p>
          </div>
        </header>

        @if (error()) {
          <div
            class="mx-6 mt-3 rounded ring-1 ring-red-500/40 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-300"
            role="alert"
            data-testid="meeting-transcription-error"
          >
            {{ error() }}
            @if (showOpenSettingsLink()) {
              <button
                type="button"
                class="mono ml-2 underline"
                data-testid="open-mic-settings"
                (click)="openMicrophoneSettings()"
              >
                Open Privacy settings →
              </button>
            }
          </div>
        }
        @if (captureWarningText(); as warning) {
          <div
            class="mx-6 mt-3 rounded ring-1 ring-amber-500/40 bg-amber-500/[0.06] px-3 py-2 text-[12px] text-amber-300"
            role="alert"
            data-testid="capture-warning"
          >
            {{ warning }}
            @if (captureWarning() === 'system_audio_silent') {
              <button
                type="button"
                class="mono ml-2 underline"
                data-testid="open-audio-settings"
                (click)="openMicrophoneSettings()"
              >
                Open Privacy settings →
              </button>
            }
          </div>
        }
        <div class="flex flex-1 gap-4 overflow-hidden p-6">
          <aside class="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto">
            <app-session-list (opened)="onOpenSession($event)" (errorOccurred)="onError($event)" />
          </aside>
          <main class="flex flex-1 flex-col gap-4 overflow-hidden">
            <app-recording-controls
              (started)="onStarted($event)"
              (stopped)="onStopped($event)"
              (errorOccurred)="onError($event)"
            />
            <div
              class="flex-1 overflow-hidden rounded-md border border-[var(--line)] bg-[var(--bg-1)] p-3"
            >
              <app-live-transcript [session]="active()" (errorOccurred)="onError($event)" />
            </div>
          </main>
        </div>
      }
    </section>
  `,
  host: { class: 'flex h-full flex-1' },
})
export class MeetingTranscriptionComponent implements OnInit, OnDestroy {
  /** Left pane's recordings list (refreshed after start/stop/delete). */
  @ViewChild(SessionListComponent) private sessionList?: SessionListComponent;

  /** Latest error string (rendered in a banner). */
  readonly error = signal('');
  /** `null` while loading, `true` if the model is downloaded, `false` shows the gate. */
  readonly modelReady = signal<boolean | null>(null);

  private readonly transcription = inject(TranscriptionService);
  private readonly log = inject(LoggerService);

  /** The active session (live snapshot from the service). */
  readonly active = computed<TranscriptSession | null>(() => this.transcription.active());
  /** Whether the current error looks like a macOS permission denial. */
  readonly showOpenSettingsLink = computed(() => {
    const e = this.error().toLowerCase();
    return e.includes('permission') || e.includes('privacy') || e.includes('microphone');
  });
  /** Capture-health warning for the active session (from the live event stream). */
  readonly captureWarning = this.transcription.captureWarning;
  /** Banner copy for the active capture warning. */
  readonly captureWarningText = computed(() => {
    switch (this.captureWarning()) {
      case 'system_audio_silent':
        return 'No system audio captured so far — the meeting voice may be missing. Check the System Audio Recording permission.';
      case 'microphone_stalled':
        return 'The microphone stopped delivering audio — recording continues with system audio only.';
      case 'system_audio_stalled':
        return 'System audio stopped delivering — recording continues with the microphone only.';
      case 'audio_dropped':
        return 'Some captured audio was dropped because the transcriber could not keep up — that span is missing from the recording.';
      case 'recording_part_missing':
        return 'A resumed part of this recording contributed no audio — the transcript may be missing that span.';
      default:
        return null;
    }
  });

  /** Refreshes the recordings list once the active session settles (snapshot is one-shot). */
  constructor() {
    let last: string | undefined;
    effect(() => {
      const state = this.transcription.active()?.status.state;
      if (state && state !== last && (state === 'done' || state === 'failed')) {
        void this.sessionList?.refresh();
      }
      last = state;
    });
  }

  /** Re-checks model availability when the window/tab regains focus. */
  private readonly onActivate = (): void => {
    void this.refreshModelReady();
  };

  /** Checks model availability on first paint and re-checks on re-activation. */
  async ngOnInit(): Promise<void> {
    // Registered before any await so a rejected resume below can never skip them.
    window.addEventListener('focus', this.onActivate);
    document.addEventListener('visibilitychange', this.onActivate);
    await this.refreshModelReady();
    try {
      // Re-attach the live stream if a recording was left running while this tab
      // was destroyed on navigation (the backend driver never stopped).
      await this.transcription.resumeActiveRecording();
    } catch (err) {
      this.log.warn(`resume active recording failed: ${String(err)}`);
    }
  }

  /** Detaches the live-stream listener and removes activation listeners. */
  async ngOnDestroy(): Promise<void> {
    window.removeEventListener('focus', this.onActivate);
    document.removeEventListener('visibilitychange', this.onActivate);
    await this.transcription.detach();
  }

  /**
   * Lifts the gate when any Whisper model is downloaded — the same predicate
   * recording-controls uses for `hasModel()`. Fails open on a read error.
   */
  private async refreshModelReady(): Promise<void> {
    if (document.visibilityState === 'hidden') return;
    try {
      const ack = await this.transcription.listModels();
      this.modelReady.set(ack.whisper.some((m) => m.downloaded));
    } catch (err) {
      // Don't trap the user behind the gate on a transient read error.
      this.log.warn(`model-availability check failed: ${String(err)}`);
      this.modelReady.set(true);
    }
  }

  /**
   * Records an error in the banner.
   * @param msg - the error message.
   */
  onError(msg: string): void {
    this.error.set(msg);
  }

  /**
   * Opens a session in the right pane (subscribes to its live stream).
   * @param s - the session.
   */
  async onOpenSession(s: TranscriptSession): Promise<void> {
    this.error.set('');
    try {
      await this.transcription.subscribeToTranscript(s.id);
    } catch (err: unknown) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * After recording starts: clear the banner and refresh the recordings list.
   * @param _sessionId - the new session id (unused — the controls own the stream).
   */
  onStarted(_sessionId: string): void {
    this.error.set('');
    void this.sessionList?.refresh();
  }

  /**
   * After recording stops: refresh the list (status moved to Finalizing/Done).
   * @param _sessionId - the stopped session id (unused — the offline pass is server-side).
   */
  onStopped(_sessionId: string): void {
    void this.sessionList?.refresh();
  }

  /** Deep-links to the macOS Microphone / Audio Recording privacy panes. */
  async openMicrophoneSettings(): Promise<void> {
    try {
      await this.transcription.openMicrophonePrivacyPane();
      await this.transcription.openAudioCapturePrivacyPane();
    } catch (err) {
      this.log.warn(`open privacy pane failed: ${String(err)}`);
    }
  }
}
