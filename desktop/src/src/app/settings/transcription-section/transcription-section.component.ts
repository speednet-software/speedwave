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
import type { RecommendedModelAck } from '../../models/transcript';
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
                {{ busy() ? progressLabel() : 'download model' }}
              </button>
            }
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
  /** Disables the button while a download/remove is in flight. */
  readonly busy = signal(false);
  /** Live download progress label (e.g. `downloading 42%`). */
  readonly progressLabel = signal('downloading…');
  /** Local error string. */
  readonly error = signal('');

  private readonly transcription = inject(TranscriptionService);
  private readonly cdr = inject(ChangeDetectorRef);

  /** Reads the recommended model + its download state on first paint. */
  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  /** Re-reads the recommended-model state from the backend. */
  private async refresh(): Promise<void> {
    try {
      this.model.set(await this.transcription.recommendedModel());
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
    this.busy.set(true);
    this.progressLabel.set('downloading…');
    this.cdr.markForCheck();
    try {
      const { done } = await this.transcription.downloadModel(key, (p) => {
        if (p.total_bytes) {
          const pct = Math.round((p.downloaded_bytes / p.total_bytes) * 100);
          this.progressLabel.set(`downloading ${pct}%`);
          this.cdr.markForCheck();
        }
      });
      await done;
      await this.refresh();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.error.set(msg);
      this.errorOccurred.emit(msg);
    }
    this.busy.set(false);
    this.cdr.markForCheck();
  }

  /**
   * Removes the downloaded model.
   * @param key - the model catalogue key.
   */
  async remove(key: string): Promise<void> {
    this.busy.set(true);
    try {
      await this.transcription.deleteModel(key);
      await this.refresh();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.error.set(msg);
      this.errorOccurred.emit(msg);
    }
    this.busy.set(false);
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
