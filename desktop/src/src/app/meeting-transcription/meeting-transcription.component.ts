import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';

import { TranscriptionService } from '../services/transcription.service';
import { LoggerService } from '../services/logger.service';
import type { TranscriptSession } from '../models/transcript';
import { RecordingControlsComponent } from './recording-controls/recording-controls.component';
import { LiveTranscriptComponent } from './live-transcript/live-transcript.component';
import { SessionListComponent } from './session-list/session-list.component';
import { ModelManagerComponent } from './model-manager/model-manager.component';

/**
 * Meeting transcription tab — opt-in (the empty-state links to Settings until
 * the user toggles it on). When enabled: left pane = recordings + model
 * manager; right pane = recording controls + the live transcript. Audio is
 * transcribed locally; model downloads and "Send to Claude" use the network —
 * the banner says so.
 */
@Component({
  selector: 'app-meeting-transcription',
  standalone: true,
  imports: [
    RecordingControlsComponent,
    LiveTranscriptComponent,
    SessionListComponent,
    ModelManagerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="flex h-full flex-1 flex-col overflow-hidden bg-[var(--bg)] text-[var(--ink)]">
      <header class="flex items-center justify-between border-b border-[var(--line)] px-6 py-4">
        <div>
          <h1 class="text-lg font-semibold">Meeting transcription</h1>
          <p class="text-sm text-[var(--ink-mute)]">
            Audio is transcribed locally on this machine. Model downloads and "Send to Claude" use
            the network.
          </p>
          <p class="mt-1 text-xs text-[var(--ink-mute)]" data-testid="quality-disclaimer">
            Quality varies by content: read speech (e.g. dictation) is ~5% word error rate;
            spontaneous meeting speech is ~25-30% across all open models (industry-wide limit).
          </p>
        </div>
      </header>

      @if (enabled() === false) {
        <div class="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <p class="max-w-md text-sm text-[var(--ink-mute)]">
            Meeting transcription is off. Enable it in Settings to record audio from this machine,
            transcribe it locally, and optionally send the transcript to Claude.
          </p>
          <button
            type="button"
            class="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--bg)] hover:opacity-90"
            data-testid="enable-in-settings"
            (click)="goToSettings()"
          >
            Enable in Settings →
          </button>
        </div>
      } @else if (enabled() === true) {
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
        <div class="flex flex-1 gap-4 overflow-hidden p-6">
          <aside class="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto">
            <app-session-list (opened)="onOpenSession($event)" (errorOccurred)="onError($event)" />
            <app-model-manager (errorOccurred)="onError($event)" (changed)="onModelsChanged()" />
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
  /** Recording controls (re-checked when the model list changes). */
  @ViewChild(RecordingControlsComponent) private recordingControls?: RecordingControlsComponent;

  /** `null` while loading, `true`/`false` once the toggle is known. */
  readonly enabled = signal<boolean | null>(null);
  /** Latest error string (rendered in a banner). */
  readonly error = signal('');

  private readonly transcription = inject(TranscriptionService);
  private readonly router = inject(Router);
  private readonly log = inject(LoggerService);

  /** The active session (live snapshot from the service). */
  readonly active = computed<TranscriptSession | null>(() => this.transcription.active());
  /** Whether the current error looks like a macOS permission denial. */
  readonly showOpenSettingsLink = computed(() => {
    const e = this.error().toLowerCase();
    return e.includes('permission') || e.includes('privacy') || e.includes('microphone');
  });

  /** Loads the opt-in toggle on first paint. */
  async ngOnInit(): Promise<void> {
    try {
      this.enabled.set(await this.transcription.isEnabled());
    } catch (err) {
      this.log.warn(`meeting-transcription init failed: ${String(err)}`);
      this.enabled.set(false);
    }
  }

  /** Detaches the live-stream listener when the tab is destroyed. */
  async ngOnDestroy(): Promise<void> {
    await this.transcription.detach();
  }

  /** Navigates to Settings (where the opt-in toggle lives). */
  goToSettings(): void {
    void this.router.navigateByUrl('/settings');
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
   * After recording starts: the controls already subscribed via `startRecording`,
   * so we just clear the banner and refresh the recordings list.
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

  /** The model list changed — re-check whether recording is now possible. */
  onModelsChanged(): void {
    void this.recordingControls?.refreshModelAvailability();
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
