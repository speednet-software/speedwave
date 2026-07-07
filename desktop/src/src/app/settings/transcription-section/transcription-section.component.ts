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
import type { MicPermissionStatus, RecommendedModelAck } from '../../models/transcript';
import { formatBytes } from '../../shared/format-bytes';

/**
 * Settings → Meeting transcription (ADR-056). One auto-selected model for this
 * hardware (large-v3 on GPU, large-v3-turbo on CPU) with a single download /
 * remove control. No toggle, no model list, no per-feature defaults.
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

          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-[12px] text-[var(--ink)]">Speech recognition model</div>
              @if (m.downloaded) {
                <div class="text-[11px] text-[var(--ink-mute)]" data-testid="model-state">
                  Downloaded ({{ m.display_name }}) · best quality for your hardware
                </div>
              } @else {
                <div class="text-[11px] text-[var(--ink-mute)]" data-testid="model-state">
                  Not downloaded · {{ size(m) }} · best quality for your hardware
                </div>
              }
            </div>

            @if (m.downloaded) {
              <button
                type="button"
                class="mono rounded border border-red-500/40 px-3 py-1 text-[11px] text-red-300 hover:bg-red-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="remove-model"
                [disabled]="busy()"
                (click)="remove(m.key)"
              >
                remove
              </button>
            } @else {
              <button
                type="button"
                class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="download-model"
                [disabled]="busy()"
                (click)="download(m.key)"
              >
                {{ downloading() ? progressLabel() : 'download model' }}
              </button>
            }
          </div>
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

  /** The recommended model + its state; `null` while loading. */
  readonly model = signal<RecommendedModelAck | null>(null);
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
    await this.refresh();
    await this.refreshPermissions();
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
      if (ack.downloading && this.transcription.downloadingModelKey() !== ack.key) {
        // Backend download survived a webview reload — reattach progress.
        await this.transcription.resumeDownloadTracking(ack.key);
      } else if (!ack.downloading && this.transcription.downloadingModelKey() === ack.key) {
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
   * Human-readable download size for a model.
   * @param m - the recommended-model ack.
   */
  size(m: RecommendedModelAck): string {
    return formatBytes(m.size_bytes);
  }
}
