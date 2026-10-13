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
import type {
  MicPermissionStatus,
  RecommendedModelAck,
  RecommendedModelEntry,
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

/**
 * Settings → Meeting transcription (ADR-056), written for someone who does not know what a model
 * is: one status line (ready, or the one download that makes it ready), the live-text choice,
 * permissions, and the disk the recordings take. Model names, acceleration and removing models sit
 * in a collapsed Technical details.
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
  /** Forwards errors to the Settings shell banner. */
  readonly errorOccurred = output<string>();

  /** The recommended models + their state; `null` while loading. */
  readonly model = signal<RecommendedModelAck | null>(null);

  /** Rows the card renders: the live model, plus the offline one when it is a different model. */
  readonly modelRows = computed<ModelRow[]>(() => {
    const m = this.model();
    if (!m) {
      return [];
    }
    const live = m.live;
    if (!m.finalize) {
      return [
        {
          entry: live,
          title: 'Speech recognition model',
          hint: 'best quality for your hardware',
          idSuffix: '',
        },
      ];
    }
    return [
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
    ];
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

  private readonly transcription = inject(TranscriptionService);

  /** Whether new recordings show live text (off unless the user turned it on). */
  readonly liveTranscript = signal(this.transcription.liveTranscriptPreferred());
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
      const ack = await this.transcription.recommendedModel();
      this.model.set(ack);
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
      await this.refresh();
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
      await this.refresh();
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
