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
 * Meeting transcription tab (beta-gated by the route guard). Left pane =
 * recordings list; right pane = recording controls + the live transcript. Audio
 * is transcribed locally; the speech model is downloaded in Settings. "Send to
 * Claude" uses the network — the banner says so. When no model is downloaded
 * yet, a gate (like the Claude auth gate) points the user to Settings.
 */
@Component({
  selector: 'app-meeting-transcription',
  standalone: true,
  imports: [RouterLink, RecordingControlsComponent, LiveTranscriptComponent, SessionListComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="flex h-full flex-1 flex-col overflow-hidden bg-[var(--bg)] text-[var(--ink)]">
      <header class="flex items-center justify-between border-b border-[var(--line)] px-6 py-4">
        <div>
          <h1 class="text-lg font-semibold">Meeting transcription</h1>
          <p class="text-sm text-[var(--ink-mute)]">
            Audio is transcribed locally on this machine. "Send to Claude" uses the network.
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

  /** Checks whether the speech model is downloaded; if not, the gate shows. */
  async ngOnInit(): Promise<void> {
    try {
      this.modelReady.set((await this.transcription.recommendedModel()).downloaded);
    } catch (err) {
      // Don't trap the user behind the gate on a transient read error.
      this.log.warn(`recommended-model check failed: ${String(err)}`);
      this.modelReady.set(true);
    }
  }

  /** Detaches the live-stream listener when the tab is destroyed. */
  async ngOnDestroy(): Promise<void> {
    await this.transcription.detach();
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
