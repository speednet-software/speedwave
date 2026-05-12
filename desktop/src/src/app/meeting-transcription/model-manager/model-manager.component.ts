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
import type { DownloadProgress, ModelStatusEntry } from '../../models/transcript';

/**
 * Bytes → human size (GB/MB), one decimal.
 * @param n - byte count.
 */
function humanBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${n} B`;
}

/** Per-model download progress, keyed by catalogue key. */
interface ProgressState {
  downloaded: number;
  total: number | null;
}

/**
 * Whisper + diarization model list with download / delete. Downloads use the
 * network — the line at the bottom says so. The UI reads the catalogue from the
 * backend (`list_transcription_models`) and never hard-codes model names.
 */
@Component({
  selector: 'app-model-manager',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      class="rounded-md border border-[var(--line)] bg-[var(--bg-1)] p-3"
      data-testid="model-manager"
    >
      <h3 class="mono mb-2 text-[11px] uppercase tracking-widest text-[var(--ink-mute)]">Models</h3>
      @if (error()) {
        <p class="mb-2 text-[12px] text-red-300" data-testid="model-manager-error">{{ error() }}</p>
      }

      <div class="mono mb-1 mt-2 text-[10px] uppercase text-[var(--ink-mute)]">speech-to-text</div>
      <ul class="space-y-1">
        @for (m of whisper(); track m.key) {
          <li class="flex items-center gap-2 text-[12px]">
            <span class="text-[var(--ink)]">{{ m.key }}</span>
            <span class="text-[var(--ink-mute)]">{{ sizeLabel(m) }}</span>
            <span class="text-[10px] text-[var(--ink-mute)]">{{ rowAction(m) }}</span>
            <span class="ml-auto flex gap-1">
              @if (!m.downloaded && !isDownloading(m.key)) {
                <button
                  type="button"
                  class="mono rounded border border-[var(--line-strong)] px-2 py-0.5 text-[10px] hover:bg-[var(--bg-2)]"
                  [attr.data-testid]="'download-' + m.key"
                  (click)="download(m.key)"
                >
                  download
                </button>
              }
              @if (m.downloaded) {
                <button
                  type="button"
                  class="mono rounded border border-red-500/40 px-2 py-0.5 text-[10px] text-red-300 hover:bg-red-500/10"
                  [attr.data-testid]="'delete-' + m.key"
                  (click)="delete(m.key)"
                >
                  delete
                </button>
              }
            </span>
          </li>
        }
      </ul>

      <div class="mono mb-1 mt-3 text-[10px] uppercase text-[var(--ink-mute)]">
        speaker diarization
      </div>
      <ul class="space-y-1">
        @for (m of diarization(); track m.key) {
          <li class="flex items-center gap-2 text-[12px]">
            <span class="text-[var(--ink)]">{{ m.key }}</span>
            <span class="text-[var(--ink-mute)]">{{ sizeLabel(m) }}</span>
            <span class="text-[10px] text-[var(--ink-mute)]">{{ rowAction(m) }}</span>
            <span class="ml-auto flex gap-1">
              @if (!m.downloaded && !isDownloading(m.key)) {
                <button
                  type="button"
                  class="mono rounded border border-[var(--line-strong)] px-2 py-0.5 text-[10px] hover:bg-[var(--bg-2)]"
                  [attr.data-testid]="'download-' + m.key"
                  (click)="download(m.key)"
                >
                  download
                </button>
              }
              @if (m.downloaded) {
                <button
                  type="button"
                  class="mono rounded border border-red-500/40 px-2 py-0.5 text-[10px] text-red-300 hover:bg-red-500/10"
                  [attr.data-testid]="'delete-' + m.key"
                  (click)="delete(m.key)"
                >
                  delete
                </button>
              }
            </span>
          </li>
        }
      </ul>

      <p class="mono mt-3 text-[10px] text-[var(--ink-mute)]">
        Models use {{ totalUsedLabel() }} on disk; downloads use the network.
      </p>
    </section>
  `,
})
export class ModelManagerComponent implements OnInit {
  /** Forwards errors to the parent banner. */
  readonly errorOccurred = output<string>();
  /**
   * Emitted after the model list changes (download/delete) so the parent can
   *  re-check whether recording is now possible.
   */
  readonly changed = output<void>();

  /** Whisper catalogue entries + on-disk status. */
  readonly whisper = signal<ModelStatusEntry[]>([]);
  /** Diarization catalogue entries + on-disk status. */
  readonly diarization = signal<ModelStatusEntry[]>([]);
  /** Total bytes the downloaded models occupy. */
  readonly totalUsed = signal(0);
  /** In-flight downloads, keyed by model key. */
  readonly downloading = signal<Record<string, ProgressState>>({});
  /** Local error string (also forwarded via `errorOccurred`). */
  readonly error = signal('');

  private readonly transcription = inject(TranscriptionService);
  private readonly cdr = inject(ChangeDetectorRef);

  /** Loads the model catalogue + disk status on first paint. */
  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  /** Re-reads the model catalogue / disk status and notifies the parent. */
  async refresh(): Promise<void> {
    try {
      const ack = await this.transcription.listModels();
      this.whisper.set(ack.whisper);
      this.diarization.set(ack.diarization);
      this.totalUsed.set(ack.total_bytes_used);
      this.error.set('');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.error.set(msg);
      this.errorOccurred.emit(msg);
    }
    this.changed.emit();
    this.cdr.markForCheck();
  }

  /**
   * Downloads the model with catalogue `key` and refreshes the list when done.
   * @param key - catalogue key.
   */
  async download(key: string): Promise<void> {
    this.downloading.update((d) => ({ ...d, [key]: { downloaded: 0, total: null } }));
    this.cdr.markForCheck();
    try {
      const { done } = await this.transcription.downloadModel(key, (p: DownloadProgress) => {
        this.downloading.update((d) => ({
          ...d,
          [key]: { downloaded: p.downloaded_bytes, total: p.total_bytes },
        }));
        this.cdr.markForCheck();
      });
      await done;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.error.set(msg);
      this.errorOccurred.emit(msg);
    } finally {
      this.downloading.update((d) => {
        const next = { ...d };
        delete next[key];
        return next;
      });
      await this.refresh();
    }
  }

  /**
   * Deletes the downloaded model with catalogue `key` and refreshes the list.
   * @param key - catalogue key.
   */
  async delete(key: string): Promise<void> {
    try {
      await this.transcription.deleteModel(key);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.error.set(msg);
      this.errorOccurred.emit(msg);
    }
    await this.refresh();
  }

  /**
   * Size label for a row (on-disk size if downloaded, else catalogue size).
   * @param m - the model row.
   */
  sizeLabel(m: ModelStatusEntry): string {
    return humanBytes(m.size_bytes);
  }

  /** Total-disk-usage label for the footer line. */
  totalUsedLabel(): string {
    return humanBytes(this.totalUsed());
  }

  /**
   * Short text for the row's action cell. The template can't host complex
   * controls per row in a one-liner, so this returns a status string and the
   * actual download/delete are invoked from the (templated) buttons below.
   * @param m - the model row.
   */
  rowAction(m: ModelStatusEntry): string {
    const prog = this.downloading()[m.key];
    if (prog) {
      if (prog.total) {
        const pct = Math.round((prog.downloaded / prog.total) * 100);
        return `downloading ${pct}%`;
      }
      return `downloading ${humanBytes(prog.downloaded)}`;
    }
    return m.downloaded ? 'downloaded' : 'not downloaded';
  }

  /**
   * `true` if the model with catalogue `key` is mid-download.
   * @param key - catalogue key.
   */
  isDownloading(key: string): boolean {
    return key in this.downloading();
  }
}
