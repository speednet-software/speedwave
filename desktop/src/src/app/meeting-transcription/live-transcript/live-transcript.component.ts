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
import { Router } from '@angular/router';

import { TranscriptionService } from '../../services/transcription.service';
import type { Segment, TranscriptSession } from '../../models/transcript';

/**
 * Seconds → `MM:SS`. Segment timestamps are serde `Duration` `{secs,nanos}`; the caller passes
 * `.secs`, so sub-second precision isn't shown.
 * @param secs - whole seconds since the recording started
 */
function fmtTs(secs: number): string {
  return `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
}

/** A timestamped transcript line, for rendering. */
interface TranscriptLine {
  startLabel: string;
  text: string;
}

/**
 * Live transcript view (right pane): segments (offline `final_segments` if run, else
 * `live_segments`), finalize progress bar, and a "Send to chat" button behind a confirm dialog.
 */
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
        @if (lines().length === 0) {
          <p class="text-[12px] text-[var(--ink-mute)]">No transcript yet.</p>
        }
        @for (line of lines(); track $index) {
          <div class="mb-2">
            <div class="mb-0.5 flex items-center gap-1 text-[11px]">
              <span class="text-[var(--ink-mute)]">{{ line.startLabel }}</span>
            </div>
            <p class="text-[13px] leading-relaxed text-[var(--ink)]">{{ line.text }}</p>
          </div>
        }
      </div>

      @if (session()) {
        <div class="mt-2 border-t border-[var(--line)] pt-2">
          <button
            type="button"
            class="mono rounded bg-[var(--accent)] px-3 py-1 text-[12px] font-medium text-[var(--bg)] hover:opacity-90 disabled:opacity-40"
            data-testid="send-to-chat-btn"
            [disabled]="sending() || status() === 'recording'"
            (click)="sendToChat()"
          >
            {{ sending() ? 'sending…' : 'Send to chat' }}
          </button>
          <span class="mono ml-2 text-[10px] text-[var(--ink-mute)]">
            @if (status() === 'recording') {
              stop recording first
            } @else {
              drops the transcript into the chat and opens it
            }
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

  /** `true` while a "Send to chat" call is in flight. */
  readonly sending = signal(false);
  /** Local error string. */
  readonly error = signal('');

  /** Effective segments: `final_segments` if the offline pass ran, else live. */
  private readonly segments = computed<Segment[]>(() => {
    const s = this.session();
    if (!s) return [];
    return s.final_segments ?? s.live_segments;
  });

  /** Segments rendered as plain timestamped lines. */
  readonly lines = computed<TranscriptLine[]>(() =>
    this.segments().map((seg) => ({
      startLabel: fmtTs(seg.start.secs),
      text: seg.text.trim(),
    }))
  );

  /** Lifecycle state of the active session ('' if none). */
  readonly status = computed(() => this.session()?.status.state ?? '');
  /** Finalize progress 0–100 (0 when not finalizing). */
  readonly finalizePct = computed(() => {
    const st = this.session()?.status;
    return st?.state === 'finalizing' ? Math.round(st.progress * 100) : 0;
  });

  private readonly transcription = inject(TranscriptionService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly router = inject(Router);

  /** Confirms, drops the transcript into the chat, then opens the chat tab. */
  async sendToChat(): Promise<void> {
    const s = this.session();
    if (!s || s.status.state === 'recording') return;
    const ok = window.confirm(
      'This drops the transcript text into the chat (sent to your configured LLM provider). Continue?'
    );
    if (!ok) return;
    this.sending.set(true);
    this.error.set('');
    try {
      await this.transcription.sendToChat(s.id);
      // Open the chat so the user sees the message they just sent.
      await this.router.navigate(['/chat']);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.error.set(msg);
      this.errorOccurred.emit(msg);
    }
    this.sending.set(false);
    this.cdr.markForCheck();
  }
}
