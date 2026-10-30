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

import { TauriService } from '../../services/tauri.service';
import { TranscriptionService } from '../../services/transcription.service';
import {
  SPEAKER_NAME_MAX_CHARS,
  type MicPermissionStatus,
  type RecommendedModelEntry,
} from '../../models/transcript';
import { formatBytes } from '../../shared/format-bytes';
import { ToggleComponent } from '../../shared/toggle.component';

/** One row of the model card: a model this host needs, with the copy that explains why. */
interface ModelRow {
  entry: RecommendedModelEntry;
  title: string;
  hint: string;
  /** Test-id suffix; empty for the live row so the existing ids keep resolving. */
  idSuffix: string;
}

const SPEAKER_COST_TEXT = {
  macos: { text: 'Adds under a minute per hour of recording.', warn: false },
  windows: {
    discrete: { text: 'Adds some time after each recording.', warn: false },
    integrated: { text: 'Adds about 3 minutes per hour of recording.', warn: false },
    none: {
      text: 'No graphics acceleration here: runs on the processor and takes longer after each recording.',
      warn: true,
    },
  },
};

/**
 * Settings → Meeting transcription (ADR-056), written for someone who does not know what a model
 * is: one status line (ready, or the one download that makes it ready), the live-text choice, the
 * optional speaker attribution after Stop (ADR-098), permissions, and the disk the recordings
 * take. Model names, acceleration and removing models sit in a collapsed Technical details.
 */
@Component({
  selector: 'app-transcription-section',
  imports: [ToggleComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <section
      id="section-transcription"
      class="border-t border-[var(--line)] pt-6"
      data-testid="settings-section-transcription"
    >
      <h2 class="view-title view-title-section text-[var(--ink)]">Meeting transcription</h2>
      <p class="mt-1 text-[12.5px] leading-relaxed text-[var(--ink-dim)]">
        Speedwave records system audio and your microphone and turns it into text on this machine.
        Audio never leaves your computer.
      </p>

      @if (error()) {
        <p class="mt-2 text-[12px] text-red-300" data-testid="transcription-error">{{ error() }}</p>
      }

      @if (best(); as b) {
        <div
          class="mt-4 flex items-center justify-between gap-3 rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-3"
          data-testid="transcription-status"
        >
          <div>
            <div class="flex items-center gap-2 text-[12.5px] text-[var(--ink)]">
              <span
                class="h-2 w-2 rounded-full"
                [class]="b.downloaded ? 'bg-emerald-400' : 'bg-amber-400'"
                aria-hidden="true"
              ></span>
              {{ statusTitle() }}
            </div>
            <div class="mt-0.5 text-[11.5px] text-[var(--ink-mute)]">{{ statusDetail() }}</div>
          </div>
          @if (!b.downloaded) {
            <button
              type="button"
              class="mono shrink-0 rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:cursor-not-allowed disabled:opacity-40"
              data-testid="download-best-model"
              [disabled]="busy()"
              (click)="download(b.key)"
            >
              {{ downloadLabel(b) }}
            </button>
          }
        </div>
      }

      <div class="mt-4 rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-3">
        <div class="mono mb-2 text-[11px] uppercase tracking-wider text-[var(--ink-mute)]">
          While recording
        </div>
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-[12px] text-[var(--ink)]">Show live text while recording</div>
            <div class="text-[11px] leading-relaxed text-[var(--ink-mute)]">
              Text appears as people speak. Uses more CPU and battery, and live text has more
              mistakes; the final transcript is always made after you stop.
              @if (liveModel(); as lm) {
                @if (!lm.downloaded) {
                  Turning it on needs an extra download ({{ size(lm) }}).
                }
              }
            </div>
          </div>
          <app-toggle
            testId="live-transcript-toggle"
            ariaLabel="Show live text while recording"
            [checked]="liveTranscript()"
            (changed)="onLiveToggle($event)"
          />
        </div>
        @if (liveTranscript() && liveModel(); as lm) {
          @if (!lm.downloaded) {
            <div class="mt-2 flex items-center justify-between gap-3 text-[11px] text-amber-300">
              <span>Live text needs its model before the next recording.</span>
              <button
                type="button"
                class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40"
                data-testid="download-live-model"
                [disabled]="busy()"
                (click)="download(lm.key)"
              >
                {{ downloadLabel(lm) }}
              </button>
            </div>
          }
        }
      </div>

      <div
        class="mt-4 rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-3"
        data-testid="speaker-attribution"
      >
        <div class="mono mb-2 text-[11px] uppercase tracking-wider text-[var(--ink-mute)]">
          After you stop
        </div>
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-[12px] text-[var(--ink)]">
              Tell speakers apart in the meeting audio
            </div>
            <div class="text-[11px] leading-relaxed text-[var(--ink-mute)]">
              Labels the people in the meeting audio as Speaker 1, Speaker 2, …, which you can name
              in the transcript. Also for an imported file and a recording of other people only.
              Your microphone stays "You"; a recording of your microphone alone gets no labels. Runs
              on this computer.
            </div>
          </div>
          <app-toggle
            testId="speaker-attribution-toggle"
            ariaLabel="Tell speakers apart in the meeting audio"
            [checked]="speakerAttribution()"
            (changed)="onSpeakerToggle($event)"
          />
        </div>
        @if (speakerCost(); as cost) {
          <p
            class="mt-2 text-[11px] leading-relaxed"
            [class]="cost.warn ? 'text-amber-300' : 'text-[var(--ink-mute)]'"
            data-testid="speaker-hardware"
          >
            {{ cost.text }}
          </p>
        }
        @if (speakerAttribution() && diarizationModel(); as dm) {
          @if (!dm.downloaded) {
            <div class="mt-2 flex items-center justify-between gap-3 text-[11px] text-amber-300">
              <span>Needs one download ({{ size(dm) }}).</span>
              <button
                type="button"
                class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40"
                data-testid="download-diarization-model"
                [disabled]="busy()"
                (click)="download(dm.key)"
              >
                {{ downloadLabel(dm) }}
              </button>
            </div>
          }
        }
        <details class="mt-2" data-testid="speaker-limits">
          <summary class="cursor-pointer select-none text-[11.5px] text-[var(--ink-dim)]">
            Limits
          </summary>
          <ul
            class="mt-2 list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-[var(--ink-mute)]"
          >
            <li>
              One person can get two labels and one label can cover two people, most often when
              people talk over each other.
            </li>
            <li>
              Up to 8 people. Transcribing again can number them differently, so the names you gave
              are offered again instead of kept.
            </li>
            <li>People in the room with you are picked up by your microphone and labelled You.</li>
          </ul>
        </details>
      </div>

      <div
        class="mt-4 rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-3"
        data-testid="your-name"
      >
        <label
          for="transcription-your-name"
          class="mono mb-2 block text-[11px] uppercase tracking-wider text-[var(--ink-mute)]"
        >
          Your name
        </label>
        <input
          id="transcription-your-name"
          type="text"
          class="h-8 w-full max-w-xs rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 text-[12.5px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-mute)] focus:border-[var(--accent)]"
          placeholder="Not set"
          aria-describedby="transcription-your-name-hint"
          data-testid="your-name-input"
          [attr.maxlength]="nameMaxChars"
          [value]="yourName()"
          (change)="onYourNameChange($event)"
          (keydown.enter)="onYourNameChange($event)"
        />
        <p
          id="transcription-your-name-hint"
          class="mt-1.5 text-[11px] leading-relaxed text-[var(--ink-mute)]"
        >
          Used instead of "You" in exports and in what Claude gets. The transcript in the app keeps
          showing "You". Stored on this computer only.
        </p>
      </div>

      @if (isMacos()) {
        <div
          class="mt-4 space-y-3 rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-3"
          data-testid="transcription-permissions"
        >
          <div class="mono text-[11px] uppercase tracking-wider text-[var(--ink-mute)]">
            Permissions
          </div>

          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-[12px] text-[var(--ink)]">Microphone</div>
              <div class="text-[11px] text-[var(--ink-mute)]" data-testid="mic-permission-state">
                {{ micStatusLabel() }}
              </div>
            </div>
            @if (micStatus() === 'undetermined') {
              <button
                type="button"
                class="mono shrink-0 whitespace-nowrap rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)]"
                data-testid="request-mic-permission"
                (click)="requestMic()"
              >
                Ask for access
              </button>
            } @else if (micStatus() === 'denied') {
              <button
                type="button"
                class="mono shrink-0 whitespace-nowrap rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)]"
                data-testid="open-mic-privacy"
                (click)="openMicPane()"
              >
                Open System Settings
              </button>
            }
          </div>

          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-[12px] text-[var(--ink)]">
                System audio (other people in the meeting)
              </div>
              <div class="text-[11px] text-[var(--ink-mute)]">
                macOS asks the first time you record. If recordings have no voices of other people,
                turn it on for Speedwave.
              </div>
            </div>
            <button
              type="button"
              class="mono shrink-0 whitespace-nowrap rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)]"
              data-testid="open-audio-privacy"
              (click)="openAudioPane()"
            >
              Open System Settings
            </button>
          </div>
        </div>
      }

      @if (model(); as m) {
        <details
          class="mt-4 rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-3"
          data-testid="transcription-technical"
        >
          <summary class="cursor-pointer select-none text-[12px] text-[var(--ink-dim)]">
            Technical details
          </summary>
          <div class="mt-2 space-y-3">
            <div class="mono text-[11px] text-[var(--ink-mute)]" data-testid="accel-label">
              Acceleration: {{ m.accel_label }}
            </div>

            @for (row of modelRows(); track row.entry.key) {
              <div
                class="flex items-center justify-between gap-3 border-t border-[var(--line)] pt-2"
              >
                <div>
                  <div class="text-[12px] text-[var(--ink)]">{{ row.title }}</div>
                  <div
                    class="text-[11px] text-[var(--ink-mute)]"
                    [attr.data-testid]="'model-state' + row.idSuffix"
                  >
                    @if (row.entry.downloaded) {
                      Downloaded ({{ row.entry.display_name }}) · {{ row.hint }}
                    } @else {
                      Not downloaded · {{ size(row.entry) }} · {{ row.hint }}
                    }
                  </div>
                </div>

                @if (row.entry.downloaded) {
                  <button
                    type="button"
                    class="mono rounded border border-red-500/40 px-3 py-1 text-[11px] text-red-300 hover:bg-red-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
                    [attr.data-testid]="'remove-model' + row.idSuffix"
                    [disabled]="busy()"
                    (click)="remove(row.entry.key)"
                  >
                    Remove
                  </button>
                } @else {
                  <button
                    type="button"
                    class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40 disabled:cursor-not-allowed"
                    [attr.data-testid]="'download-model' + row.idSuffix"
                    [disabled]="busy()"
                    (click)="download(row.entry.key)"
                  >
                    {{ downloadLabel(row.entry) }}
                  </button>
                }
              </div>
            }
          </div>
        </details>
      }
    </section>
  `,
})
export class TranscriptionSectionComponent implements OnInit {
  private readonly transcription = inject(TranscriptionService);

  /** Forwards errors to the Settings shell banner. */
  readonly errorOccurred = output<string>();

  readonly model = this.transcription.recommended;

  /**
   * Rows the card renders: the live model, plus the offline one when it is a different model, plus
   * the speaker-diarization model once it is on disk or downloading.
   */
  readonly modelRows = computed<ModelRow[]>(() => {
    const m = this.model();
    if (!m) {
      return [];
    }
    const live = m.live;
    const rows: ModelRow[] = m.finalize
      ? [
          {
            entry: live,
            title: 'Live transcription model',
            hint: 'fast enough to keep up while you record',
            idSuffix: '',
          },
          {
            entry: m.finalize,
            title: 'Final transcript model',
            hint: 'higher quality, runs after you stop recording',
            idSuffix: '-finalize',
          },
        ]
      : [
          {
            entry: live,
            title: 'Speech recognition model',
            hint: 'best quality for your hardware',
            idSuffix: '',
          },
        ];
    if (m.diarization.downloaded || m.diarization.downloading) {
      rows.push({
        entry: m.diarization,
        title: 'Speaker model',
        hint: 'tells speakers apart in the meeting audio after you stop',
        idSuffix: '-diarization',
      });
    }
    return rows;
  });

  readonly diarizationModel = computed(() => this.model()?.diarization ?? null);

  readonly speakerCost = computed(() => {
    const m = this.model();
    if (!m) return null;
    return this.isMacos() ? SPEAKER_COST_TEXT.macos : SPEAKER_COST_TEXT.windows[m.gpu_class];
  });
  /** Local error string. */
  readonly error = signal('');

  /** The model a high-quality transcript needs on this machine. */
  readonly best = computed(() => {
    const m = this.model();
    return m ? (m.finalize ?? m.live) : null;
  });

  /** The live-text model, when it is a separate download from the high-quality one. */
  readonly liveModel = computed(() => {
    const m = this.model();
    return m?.finalize ? m.live : null;
  });

  /** Status line title: ready, ready with the smaller model, or not ready. */
  readonly statusTitle = computed(() => {
    const m = this.model();
    const best = this.best();
    if (!m || !best) return '';
    if (best.downloaded) return 'Ready to record';
    return m.live.downloaded ? 'Ready to record, with the smaller model' : 'Not ready to record';
  });

  /** Status line detail. */
  readonly statusDetail = computed(() => {
    const m = this.model();
    const best = this.best();
    if (!m || !best) return '';
    if (best.downloaded) return 'Speech recognition is downloaded and runs on this machine.';
    if (m.live.downloaded) {
      return `Transcripts have more mistakes until the high-quality model (${this.size(best)}) is downloaded.`;
    }
    return `Speech recognition needs one download (${this.size(best)}). After that it works offline.`;
  });

  /** Whether new recordings show live text (off unless the user turned it on). */
  readonly liveTranscript = signal(this.transcription.liveTranscriptPreferred());
  readonly speakerAttribution = signal(this.transcription.speakerAttribution());
  /** The user's own name for exports and Claude ('' when not set). */
  readonly yourName = signal(this.transcription.yourName());
  protected readonly nameMaxChars = SPEAKER_NAME_MAX_CHARS;

  private readonly tauri = inject(TauriService);
  private readonly cdr = inject(ChangeDetectorRef);

  /** Permissions rows are macOS-only (TCC); Windows has no per-app prompt. */
  readonly isMacos = signal(false);
  /** Mic-consent state (null while loading). */
  readonly micStatus = signal<MicPermissionStatus | null>(null);

  /** Human label for the mic-consent state. */
  readonly micStatusLabel = computed(() => {
    switch (this.micStatus()) {
      case 'granted':
        return 'Allowed';
      case 'denied':
        return 'Not allowed. Recordings have only the other people, not you.';
      case 'undetermined':
        return 'Not asked yet. macOS asks the first time you record.';
      default:
        return 'Checking…';
    }
  });

  /** `true` while a remove is in flight (download state lives in the service). */
  private readonly removeBusy = signal(false);

  /**
   * Download-in-flight — from the service, so a remounted section still sees it.
   */
  readonly downloading = computed(() => this.transcription.downloadingModelKey() !== null);

  /** Disables both buttons while a download or remove is in flight. */
  readonly busy = computed(() => this.downloading() || this.removeBusy());

  /** Live download progress label (e.g. `downloading 42%`). */
  readonly progressLabel = computed(() => {
    const p = this.transcription.downloadProgress();
    if (!p?.total_bytes) return 'Downloading…';
    return `Downloading ${Math.round((p.downloaded_bytes / p.total_bytes) * 100)}%`;
  });

  /** Reads the recommended model and permissions on first paint. */
  async ngOnInit(): Promise<void> {
    await Promise.all([this.refresh(), this.refreshPermissions()]);
  }

  /** Reads the platform + mic-consent state; non-fatal on failure. */
  private async refreshPermissions(): Promise<void> {
    try {
      const platform = await this.tauri.invoke<string>('get_platform');
      this.isMacos.set(platform === 'macos');
      if (platform === 'macos') {
        this.micStatus.set(await this.transcription.microphonePermissionStatus());
      }
    } catch {
      this.isMacos.set(false);
    }
    this.cdr.markForCheck();
  }

  /** Shows the mic-consent prompt, then re-reads the state. */
  async requestMic(): Promise<void> {
    try {
      await this.transcription.requestMicrophonePermission();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.error.set(msg);
      this.errorOccurred.emit(msg);
    }
    await this.refreshPermissions();
  }

  /**
   * Persists the live-text choice for the next recording.
   * @param event - the toggle's change event.
   */
  onLiveToggle(event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    this.liveTranscript.set(on);
    this.transcription.setLiveTranscriptPreferred(on);
  }

  /**
   * Persists the speaker-attribution choice; it applies from the next offline pass.
   * @param event - the toggle's change event.
   */
  onSpeakerToggle(event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    this.speakerAttribution.set(on);
    this.transcription.setSpeakerAttribution(on);
  }

  /**
   * Stores the typed name, normalised (a blank one removes it), and shows what was stored.
   * @param event - the field's change or Enter event.
   */
  onYourNameChange(event: Event): void {
    const field = event.target as HTMLInputElement;
    const stored = this.transcription.setYourName(field.value);
    field.value = stored;
    this.yourName.set(stored);
  }

  /** Opens System Settings → Privacy → Microphone. */
  async openMicPane(): Promise<void> {
    await this.transcription.openMicrophonePrivacyPane().catch(() => undefined);
  }

  /** Opens System Settings → Privacy → Audio Recording. */
  async openAudioPane(): Promise<void> {
    await this.transcription.openAudioCapturePrivacyPane().catch(() => undefined);
  }

  /** Re-reads the recommended-model state and re-syncs download tracking. */
  private async refresh(): Promise<void> {
    try {
      await this.transcription.loadRecommendedModel();
      const inFlight = this.modelRows().find((r) => r.entry.downloading);
      const tracked = this.transcription.downloadingModelKey();
      if (inFlight && tracked !== inFlight.entry.key) {
        await this.transcription.resumeDownloadTracking(inFlight.entry.key);
      } else if (!inFlight && tracked !== null) {
        this.transcription.clearDownloadTracking();
      }
      this.error.set('');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.error.set(msg);
      this.errorOccurred.emit(msg);
    }
    this.cdr.markForCheck();
  }

  /**
   * Downloads the recommended model, surfacing progress on the button.
   * @param key - the model catalogue key.
   */
  async download(key: string): Promise<void> {
    try {
      await this.transcription.downloadModel(key);
      this.error.set('');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.error.set(msg);
      this.errorOccurred.emit(msg);
    }
    this.cdr.markForCheck();
  }

  /**
   * Removes the downloaded model.
   * @param key - the model catalogue key.
   */
  async remove(key: string): Promise<void> {
    this.removeBusy.set(true);
    try {
      await this.transcription.deleteModel(key);
      this.error.set('');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.error.set(msg);
      this.errorOccurred.emit(msg);
    }
    this.removeBusy.set(false);
    this.cdr.markForCheck();
  }

  /**
   * Button copy for one row: progress only on the model actually downloading.
   * @param entry - the model this row renders.
   */
  downloadLabel(entry: RecommendedModelEntry): string {
    return this.transcription.downloadingModelKey() === entry.key
      ? this.progressLabel()
      : `Download (${this.size(entry)})`;
  }

  /**
   * Human-readable download size for a model.
   * @param m - the model entry.
   */
  size(m: RecommendedModelEntry): string {
    return formatBytes(m.size_bytes);
  }
}
