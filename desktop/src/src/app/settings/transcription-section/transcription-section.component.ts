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

/** One row of the model card: a model this host needs, with the copy that explains why. */
interface ModelRow {
  entry: RecommendedModelEntry;
  title: string;
  hint: string;
  /** Test-id suffix; empty for the live row so the existing ids keep resolving. */
  idSuffix: string;
}

/**
 * Settings → Meeting transcription (ADR-056): models auto-selected for this hardware — one for the
 * live pass and, where they differ, one for the offline pass. Download/remove only, no model list.
 */
@Component({
  selector: 'app-transcription-section',
  imports: [],
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
        Speedwave can record system audio and your microphone on this machine and transcribe it
        locally. The model download uses the network; transcription itself stays on-device.
      </p>

      @if (error()) {
        <p class="mt-2 text-[12px] text-red-300" data-testid="transcription-error">{{ error() }}</p>
      }

      @if (model(); as m) {
        <div class="mt-4 space-y-3 rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-3">
          <div class="mono text-[11px] text-[var(--ink-mute)]" data-testid="accel-label">
            Acceleration: {{ m.accel_label }}
          </div>

          @for (row of modelRows(); track row.entry.key) {
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-[12px] text-[var(--ink)]">{{ row.title }}</div>
                @if (row.entry.downloaded) {
                  <div
                    class="text-[11px] text-[var(--ink-mute)]"
                    [attr.data-testid]="'model-state' + row.idSuffix"
                  >
                    Downloaded ({{ row.entry.display_name }}) · {{ row.hint }}
                  </div>
                } @else {
                  <div
                    class="text-[11px] text-[var(--ink-mute)]"
                    [attr.data-testid]="'model-state' + row.idSuffix"
                  >
                    Not downloaded · {{ size(row.entry) }} · {{ row.hint }}
                  </div>
                }
              </div>

              @if (row.entry.downloaded) {
                <button
                  type="button"
                  class="mono rounded border border-red-500/40 px-3 py-1 text-[11px] text-red-300 hover:bg-red-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
                  [attr.data-testid]="'remove-model' + row.idSuffix"
                  [disabled]="busy()"
                  (click)="remove(row.entry.key)"
                >
                  remove
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
      }

      @if (isMacos()) {
        <div
          class="mt-4 space-y-3 rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-3"
          data-testid="transcription-permissions"
        >
          <div class="mono text-[11px] text-[var(--ink-mute)]">Permissions</div>

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
                class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)]"
                data-testid="request-mic-permission"
                (click)="requestMic()"
              >
                request access
              </button>
            } @else if (micStatus() === 'denied') {
              <button
                type="button"
                class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)]"
                data-testid="open-mic-privacy"
                (click)="openMicPane()"
              >
                open System Settings
              </button>
            }
          </div>

          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-[12px] text-[var(--ink)]">System Audio Recording</div>
              <div class="text-[11px] text-[var(--ink-mute)]">
                Asked on the first recording; if recordings stay silent, re-enable Speedwave here.
              </div>
            </div>
            <button
              type="button"
              class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)]"
              data-testid="open-audio-privacy"
              (click)="openAudioPane()"
            >
              open System Settings
            </button>
          </div>
        </div>
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
    const live: RecommendedModelEntry = {
      key: m.key,
      display_name: m.display_name,
      size_bytes: m.size_bytes,
      downloaded: m.downloaded,
      downloading: m.downloading,
    };
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

  private readonly transcription = inject(TranscriptionService);
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
        return 'Granted';
      case 'denied':
        return 'Denied — recordings fall back to system audio only';
      case 'undetermined':
        return 'Not asked yet — macOS will show a prompt';
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
    if (!p?.total_bytes) return 'downloading…';
    return `downloading ${Math.round((p.downloaded_bytes / p.total_bytes) * 100)}%`;
  });

  /** Reads the recommended model + its download state on first paint. */
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
      // Permissions rows are informational — the section still works without them.
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
        // Backend download survived a webview reload — reattach progress.
        await this.transcription.resumeDownloadTracking(inFlight.entry.key);
      } else if (!inFlight && tracked !== null) {
        // Stale tracking for a download the backend already finished.
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
      : 'download model';
  }

  /**
   * Human-readable download size for a model.
   * @param m - the model entry.
   */
  size(m: RecommendedModelEntry): string {
    return formatBytes(m.size_bytes);
  }
}
