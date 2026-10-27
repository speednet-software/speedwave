import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { TranscriptionService } from '../services/transcription.service';
import { LoggerService } from '../services/logger.service';
import { IconComponent } from '../shared/icon.component';
import { formatBytes } from '../shared/format-bytes';
import {
  IMPORT_FORMATS_LABEL,
  type CaptureWarning,
  type TranscriptSession,
  type TranscriptSummary,
} from '../models/transcript';
import { RecordingControlsComponent } from './recording-controls/recording-controls.component';
import { RecordingBarComponent } from './recording-bar/recording-bar.component';
import { LiveTranscriptComponent } from './live-transcript/live-transcript.component';
import { SessionListComponent } from './session-list/session-list.component';

/**
 * Meeting transcription tab (beta-gated): Record in the header, the recording bar while a
 * recording captures or waits paused, the recordings list, and the open recording. Transcription
 * is local; only sending the transcript to chat uses the network. Without a model the view offers
 * the one download it needs.
 */
@Component({
  selector: 'app-meeting-transcription',
  standalone: true,
  imports: [
    RouterLink,
    IconComponent,
    RecordingControlsComponent,
    RecordingBarComponent,
    LiveTranscriptComponent,
    SessionListComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="flex h-full flex-1 flex-col overflow-hidden bg-[var(--bg)] text-[var(--ink)]">
      @if (transcription.modelReady() === false) {
        <section
          class="flex flex-1 flex-col items-center justify-center bg-[var(--bg)] p-8"
          data-testid="model-required-gate"
        >
          <div class="w-[32rem] rounded-xl border border-[var(--line-strong)] bg-[var(--bg-1)] p-6">
            <h2 class="text-[16px] font-semibold">One download before your first recording</h2>
            <p class="mt-2 text-[13px] leading-relaxed text-[var(--ink-dim)]">
              Speedwave needs its speech recognition model. It is downloaded once; after that,
              recording and transcription work on this machine, also offline.
            </p>
            @if (gateDownloading()) {
              <div class="mt-4" data-testid="gate-progress">
                <div
                  class="mb-1.5 flex justify-between text-[12px] tabular-nums text-[var(--ink-dim)]"
                >
                  <span>Downloading {{ gatePct() }}%</span>
                  <span>{{ gateBytes() }}</span>
                </div>
                <div class="h-1 overflow-hidden rounded bg-[var(--bg-2)]">
                  <div class="h-full bg-[var(--accent)]" [style.width.%]="gatePct()"></div>
                </div>
              </div>
            } @else {
              <div class="mt-4 flex items-center gap-3">
                <button
                  type="button"
                  class="mono rounded-md bg-[var(--accent)] px-3.5 py-1.5 text-[12.5px] font-semibold text-[var(--bg)] hover:opacity-90 disabled:opacity-40"
                  data-testid="gate-download"
                  [disabled]="!transcription.highQualityModel()"
                  (click)="downloadFromGate()"
                >
                  {{ gateDownloadLabel() }}
                </button>
                <a
                  routerLink="/settings"
                  fragment="section-transcription"
                  class="text-[12px] text-[var(--ink-dim)] hover:underline"
                  data-testid="download-model-link"
                  >Transcription settings</a
                >
              </div>
            }
            @if (error()) {
              <p class="mt-3 text-[12px] text-red-300" role="alert" data-testid="gate-error">
                {{ error() }}
              </p>
            }
          </div>
        </section>
      } @else {
        <header
          class="flex items-start justify-between gap-6 border-b border-[var(--line)] px-6 pb-3.5 pt-4"
        >
          <div class="min-w-0">
            <h1 class="text-lg font-semibold">Meeting transcription</h1>
            <p class="mt-0.5 text-[13px] text-[var(--ink-mute)]">
              Records and transcribes on this machine. Nothing leaves your computer until you attach
              a transcript to a chat and press Send.
            </p>
            <div class="mt-1.5 flex items-start gap-5 text-[12px] text-[var(--ink-dim)]">
              <details class="text-[var(--ink-mute)]" data-testid="how-it-works">
                <summary
                  class="cursor-pointer select-none text-[var(--ink-dim)] hover:text-[var(--ink)]"
                >
                  How it works
                </summary>
                <ul class="mt-2 max-w-2xl list-disc space-y-1 pl-5">
                  <li>
                    Record captures system audio and your microphone; the audio stays on this
                    machine.
                  </li>
                  <li>
                    Pause turns the microphone off; Resume adds to the same recording. Stop
                    transcribes it here, which takes a few minutes for a long meeting.
                  </li>
                  <li>
                    You can start the next recording while the last one is still being transcribed.
                  </li>
                  <li data-testid="import-how-it-works">
                    Import audio adds a recording made elsewhere, such as Teams, Zoom or a voice
                    recorder ({{ importFormats }}), and transcribes it on this machine in the
                    language chosen next to Record.
                  </li>
                  <li>
                    Attach to new chat opens a chat with the transcript attached; nothing is sent
                    until you press Send.
                  </li>
                  <li data-testid="quality-disclaimer">
                    Recognition quality depends on the speech: dictation reaches about 5% word error
                    rate, spontaneous meeting speech about 25-30% with every open model.
                  </li>
                </ul>
              </details>
              <a
                routerLink="/settings"
                fragment="section-transcription"
                class="inline-flex items-center gap-1 hover:text-[var(--ink)]"
                data-testid="transcription-settings-link"
              >
                <app-icon name="settings" class="h-3.5 w-3.5" />
                Transcription settings
              </a>
            </div>
          </div>
          @if (!transcription.captureOpen()) {
            <app-recording-controls
              (started)="onStarted()"
              (imported)="onOpenById($event)"
              (errorOccurred)="onError($event)"
            />
          }
        </header>

        @if (transcription.captureOpen()) {
          <app-recording-bar
            (opened)="onOpenById($event)"
            (stopped)="onStopped()"
            (errorOccurred)="onError($event)"
          />
        }

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
        @for (warning of captureWarnings(); track warning) {
          <div
            class="mx-6 mt-3 rounded ring-1 ring-amber-500/40 bg-amber-500/[0.06] px-3 py-2 text-[12px] text-amber-300"
            role="alert"
            data-testid="capture-warning"
          >
            {{ captureWarningText(warning) }}
            @if (warning === 'system_audio_silent') {
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
        <div class="flex min-h-0 flex-1 overflow-hidden">
          <aside class="flex w-80 shrink-0 flex-col border-r border-[var(--line)] xl:w-96">
            <app-session-list (opened)="onOpenSession($event)" (errorOccurred)="onError($event)" />
          </aside>
          <main class="flex min-w-0 flex-1 flex-col overflow-hidden">
            <app-live-transcript [session]="active()" (errorOccurred)="onError($event)" />
          </main>
        </div>
      }
    </section>
  `,
  host: { class: 'flex h-full flex-1' },
})
export class MeetingTranscriptionComponent implements OnInit, OnDestroy {
  /** Latest error string (rendered in a banner). */
  readonly error = signal('');

  protected readonly importFormats = IMPORT_FORMATS_LABEL;

  protected readonly transcription = inject(TranscriptionService);
  private readonly log = inject(LoggerService);

  /** The gate's download of the high-quality model is running. */
  readonly gateDownloading = computed(() => {
    const key = this.transcription.highQualityModel()?.key;
    return key !== undefined && this.transcription.downloadingModelKey() === key;
  });

  /** Gate download progress, 0-100. */
  readonly gatePct = computed(() => {
    const p = this.transcription.downloadProgress();
    return p?.total_bytes ? Math.round((p.downloaded_bytes / p.total_bytes) * 100) : 0;
  });

  /** "680 MB of 1.6 GB" while the gate downloads. */
  readonly gateBytes = computed(() => {
    const p = this.transcription.downloadProgress();
    if (!p) return '';
    const done = formatBytes(p.downloaded_bytes);
    return p.total_bytes ? `${done} of ${formatBytes(p.total_bytes)}` : done;
  });

  /** Gate button text, with the download size. */
  readonly gateDownloadLabel = computed(() => {
    const best = this.transcription.highQualityModel();
    return best ? `Download (${formatBytes(best.size_bytes)})` : 'Download';
  });

  /** The active session (live snapshot from the service). */
  readonly active = computed<TranscriptSession | null>(() => this.transcription.active());
  /** Whether the current error looks like a macOS permission denial. */
  readonly showOpenSettingsLink = computed(() => {
    const e = this.error().toLowerCase();
    return e.includes('permission') || e.includes('privacy') || e.includes('microphone');
  });
  /** Capture-health warnings raised for the active session (snapshot, then the event stream). */
  readonly captureWarnings = this.transcription.captureWarnings;
  /**
   * Banner copy for one raised capture warning.
   * @param warning - the raised warning to describe.
   * @returns the banner text.
   */
  captureWarningText(warning: CaptureWarning): string {
    switch (warning) {
      case 'system_audio_silent':
        return 'No system audio captured so far — the meeting voice may be missing. Check the System Audio Recording permission.';
      case 'microphone_stalled':
        return 'The microphone stopped delivering audio — recording continues with system audio only.';
      case 'system_audio_stalled':
        return 'System audio stopped delivering — recording continues with the microphone only.';
      case 'audio_dropped':
        return 'Some captured audio was dropped before it reached the recording — that span is missing from the recording and the transcript.';
      case 'recording_part_missing':
        return 'A resumed part of this recording contributed no audio — the transcript may be missing that span.';
      case 'speaker_attribution_failed':
        return 'Speakers could not be told apart for this recording; the transcript is complete without speaker labels.';
      case 'speaker_model_missing':
        return 'Speakers could not be told apart because the model is not downloaded yet. Download it in Settings and transcribe again.';
    }
  }

  /** Re-checks model availability when the window/tab regains focus. */
  private readonly onActivate = (): void => {
    if (document.visibilityState === 'hidden') return;
    void this.transcription.refreshModelReady();
  };

  /** Checks model availability on first paint and re-checks on re-activation. */
  async ngOnInit(): Promise<void> {
    window.addEventListener('focus', this.onActivate);
    document.addEventListener('visibilitychange', this.onActivate);
    await this.transcription.refreshModelState();
    try {
      await this.transcription.resumeActiveRecording();
    } catch (err) {
      this.log.warn(`resume active recording failed: ${String(err)}`);
    }
  }

  /** Detaches the live-stream listener unless a recording or its offline pass still needs it. */
  async ngOnDestroy(): Promise<void> {
    window.removeEventListener('focus', this.onActivate);
    document.removeEventListener('visibilitychange', this.onActivate);
    if (!this.transcription.liveStreamNeeded()) await this.transcription.detach();
  }

  /**
   * Records an error in the banner.
   * @param msg - the error message.
   */
  onError(msg: string): void {
    this.error.set(msg);
  }

  /**
   * Opens a recording in the right pane (subscribes to its live stream).
   * @param s - the recording's list row.
   */
  async onOpenSession(s: TranscriptSummary): Promise<void> {
    this.error.set('');
    try {
      await this.transcription.subscribeToTranscript(s.id);
    } catch (err: unknown) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Opens a recording by id (the recording bar's name).
   * @param id - the recording to open.
   */
  async onOpenById(id: string): Promise<void> {
    if (this.active()?.id === id) return;
    this.error.set('');
    try {
      await this.transcription.subscribeToTranscript(id);
    } catch (err: unknown) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  /** Downloads the high-quality model from the gate; the service lifts the gate when it lands. */
  async downloadFromGate(): Promise<void> {
    const best = this.transcription.highQualityModel();
    if (!best) return;
    this.error.set('');
    try {
      await this.transcription.downloadModel(best.key);
    } catch (err: unknown) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  /** After recording starts: clear the banner (the list highlights the new recording on its own). */
  onStarted(): void {
    this.error.set('');
  }

  /** After recording stops: the list follows on its own (status events), so only the banner clears. */
  onStopped(): void {
    this.error.set('');
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
