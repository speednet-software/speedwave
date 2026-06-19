import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import { TranscriptionService } from '../../services/transcription.service';
import type { Segment, TranscriptSession } from '../../models/transcript';

/**
 * Seconds → `MM:SS`.
 * @param secs - whole seconds since recording started.
 */
function fmtTs(secs: number): string {
  return `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
}

/** A segment grouped under one speaker run, for rendering. */
interface SpeakerRun {
  speaker: number | null;
  startLabel: string;
  text: string;
}

/** Live transcript view: segments grouped by speaker, rename, finalize progress, Send-to-Claude. */
@Component({
  selector: 'app-live-transcript',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="flex h-full flex-col" data-testid="live-transcript">
      @if (error()) {
        <p class="mb-2 text-[12px] text-red-300">{{ error() }}</p>
      }

      @if (status() === 'finalizing') {
        <div class="mb-2 text-[12px] text-[var(--ink-mute)]" data-testid="finalize-bar">
          Re-transcribing with a higher-quality model… {{ finalizePct() }}%
          <div class="mt-1 h-1 w-full overflow-hidden rounded bg-[var(--bg-2)]">
            <div class="h-full bg-[var(--accent)]" [style.width.%]="finalizePct()"></div>
          </div>
        </div>
      }

      <div class="flex-1 overflow-y-auto" data-testid="transcript-body">
        @if (runs().length === 0) {
          <p class="text-[12px] text-[var(--ink-mute)]">No transcript yet.</p>
        }
        @for (run of runs(); track $index) {
          <div class="mb-2">
            <div class="mb-0.5 flex items-center gap-1 text-[11px]">
              <button
                type="button"
                class="mono rounded bg-[var(--bg-2)] px-1.5 py-0.5 text-[var(--ink)] hover:bg-[var(--bg-3)]"
                [attr.data-testid]="'speaker-chip-' + $index"
                [title]="'Speaker labels are approximate and may change after the recording stops. Click to rename.'"
                (click)="rename(run.speaker)"
              >
                {{ speakerLabel(run.speaker) }}
                <span aria-hidden="true">⚠</span>
              </button>
              <span class="text-[var(--ink-mute)]">{{ run.startLabel }}</span>
            </div>
            <p class="text-[13px] leading-relaxed text-[var(--ink)]">{{ run.text }}</p>
          </div>
        }
      </div>

      @if (session()) {
        <div class="mt-2 border-t border-[var(--line)] pt-2">
          <button
            type="button"
            class="mono rounded bg-[var(--accent)] px-3 py-1 text-[12px] font-medium text-[var(--bg)] hover:opacity-90 disabled:opacity-40"
            data-testid="send-to-claude-btn"
            [disabled]="sending()"
            (click)="sendToClaude()"
          >
            {{ sending() ? 'sending…' : 'Send to Claude' }}
          </button>
          <span class="mono ml-2 text-[10px] text-[var(--ink-mute)]">
            sends the transcript text to your configured LLM provider
          </span>
        </div>
      }
    </section>
  `,
})
export class LiveTranscriptComponent {
  /** The session to render. The parent passes the service's active signal. */
  readonly session = input<TranscriptSession | null>(null);
  /** Forwards errors to the parent banner. */
  readonly errorOccurred = output<string>();

  /** `true` while a "Send to Claude" call is in flight. */
  readonly sending = signal(false);
  /** Local error string. */
  readonly error = signal('');

  /** Effective segments: `final_segments` if the offline pass ran, else live. */
  private readonly segments = computed<Segment[]>(() => {
    const s = this.session();
    if (!s) return [];
    return s.final_segments ?? s.live_segments;
  });

  /** Segments grouped into consecutive-same-speaker runs. */
  readonly runs = computed<SpeakerRun[]>(() => {
    const out: SpeakerRun[] = [];
    for (const seg of this.segments()) {
      const last = out[out.length - 1];
      if (last && last.speaker === seg.speaker) {
        last.text += (last.text ? ' ' : '') + seg.text.trim();
      } else {
        out.push({
          speaker: seg.speaker,
          startLabel: fmtTs(seg.start.secs),
          text: seg.text.trim(),
        });
      }
    }
    return out;
  });

  /** Lifecycle state of the active session ('' if none). */
  readonly status = computed(() => this.session()?.status.state ?? '');
  /** Finalize progress 0–100 (0 when not finalizing). */
  readonly finalizePct = computed(() => {
    const st = this.session()?.status;
    return st?.state === 'finalizing' ? Math.round(st.progress * 100) : 0;
  });

  private readonly transcription = inject(TranscriptionService);
  private readonly cdr = inject(ChangeDetectorRef);

  /**
   * Display label: user name, or `Speaker N` (1-indexed), or `Speaker ?` if unassigned.
   * @param id - speaker id or `null`.
   */
  speakerLabel(id: number | null): string {
    if (id === null) return 'Speaker ?';
    const name = this.session()?.speaker_names?.[id];
    return name ?? `Speaker ${id + 1}`;
  }

  /**
   * Prompt to rename speaker and persist.
   * @param id - speaker id (`null` is ignored).
   */
  async rename(id: number | null): Promise<void> {
    const s = this.session();
    if (!s || id === null) return;
    const current = this.speakerLabel(id);
    const next = window.prompt(`Rename ${current}:`, current);
    if (next === null) return; // cancelled
    try {
      await this.transcription.relabelSpeaker(s.id, id, next.trim());
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.error.set(msg);
      this.errorOccurred.emit(msg);
      this.cdr.markForCheck();
    }
  }

  /** Confirms, then sends the transcript markdown to the active chat. */
  async sendToClaude(): Promise<void> {
    const s = this.session();
    if (!s) return;
    const ok = window.confirm(
      'This sends the transcript text to your configured LLM provider. Continue?'
    );
    if (!ok) return;
    this.sending.set(true);
    this.error.set('');
    try {
      await this.transcription.sendToChat(s.id);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.error.set(msg);
      this.errorOccurred.emit(msg);
    }
    this.sending.set(false);
    this.cdr.markForCheck();
  }
}
