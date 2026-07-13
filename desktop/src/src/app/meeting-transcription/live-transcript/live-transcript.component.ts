import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
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

/**
 * Chronological comparator on segment start times.
 * @param a - left segment
 * @param b - right segment
 */
function bySegmentStart(a: Segment, b: Segment): number {
  return a.start.secs - b.start.secs || a.start.nanos - b.start.nanos;
}

/**
 * `true` when `segs` is already in chronological order.
 * @param segs - segments in storage order
 */
function isChronological(segs: Segment[]): boolean {
  for (let i = 1; i < segs.length; i++) {
    if (bySegmentStart(segs[i - 1], segs[i]) > 0) return false;
  }
  return true;
}

/** A timestamped transcript line, for rendering. */
interface TranscriptLine {
  startLabel: string;
  /** Channel label ('You' / 'Meeting') on paired captures, else null. */
  speaker: string | null;
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

      <div
        #body
        class="flex-1 overflow-y-auto"
        data-testid="transcript-body"
        (scroll)="onBodyScroll()"
      >
        @if (lines().length === 0) {
          <p class="text-[12px] text-[var(--ink-mute)]">No transcript yet.</p>
        }
        @for (line of lines(); track $index) {
          <div class="mb-2">
            <div class="mb-0.5 flex items-center gap-1 text-[11px]">
              <span class="text-[var(--ink-mute)]">{{ line.startLabel }}</span>
              @if (line.speaker) {
                <span
                  class="rounded bg-[var(--bg-2)] px-1 font-medium text-[var(--ink-mute)]"
                  data-testid="line-speaker"
                  >{{ line.speaker }}</span
                >
              }
            </div>
            <p class="text-[13px] leading-relaxed text-[var(--ink)]">{{ line.text }}</p>
          </div>
        }
        @if (draft()) {
          <p
            class="mb-2 whitespace-pre-line text-[13px] italic leading-relaxed text-[var(--ink-mute)]"
            data-testid="live-draft"
          >
            {{ draft() }}
          </p>
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

  /**
   * Segments as timestamped lines, chronological — per-channel decode cycles
   * can append a mic segment after a later system one (or vice versa).
   */
  readonly lines = computed<TranscriptLine[]>(() => {
    const segs = this.segments();
    // Segments are almost always already chronological — sort only on disorder.
    const ordered = isChronological(segs) ? segs : [...segs].sort(bySegmentStart);
    return ordered.map((seg) => ({
      startLabel: fmtTs(seg.start.secs),
      speaker: seg.source === 'mic' ? 'You' : seg.source === 'system' ? 'Meeting' : null,
      text: seg.text.trim(),
    }));
  });

  /** Lifecycle state of the active session ('' if none). */
  readonly status = computed(() => this.session()?.status.state ?? '');

  /** Uncommitted decode tail, shown as a muted line only while recording. */
  readonly draft = computed(() =>
    this.status() === 'recording' ? this.transcription.liveDraft() : ''
  );
  /** Finalize progress 0–100 (0 when not finalizing). */
  readonly finalizePct = computed(() => {
    const st = this.session()?.status;
    return st?.state === 'finalizing' ? Math.round(st.progress * 100) : 0;
  });

  private readonly transcription = inject(TranscriptionService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);

  /** The scrollable transcript body. */
  private readonly body = viewChild<ElementRef<HTMLDivElement>>('body');
  /** False once the user scrolls up; re-arms when they return to the bottom. */
  private readonly stickToBottom = signal(true);
  /** Id-only view of the session, so snapshot updates don't retrigger effects. */
  private readonly sessionId = computed(() => this.session()?.id ?? '');

  /** Wires the auto-scroll effects (constructor = injection context). */
  constructor() {
    // A newly opened session starts pinned: live tail while recording, top when
    // reading a finished transcript (never inherit the previous session's scroll).
    effect(() => {
      this.sessionId();
      this.stickToBottom.set(true);
      if (untracked(() => this.status()) === 'recording') {
        this.scrollToBottom();
      } else {
        this.scrollToTop();
      }
    });
    // Follow the live tail while recording, unless the user scrolled up to read.
    effect(() => {
      this.lines();
      this.draft();
      if (this.status() === 'recording' && this.stickToBottom()) this.scrollToBottom();
    });
  }

  /** Tracks whether the user sits at (within 50 px of) the bottom. */
  onBodyScroll(): void {
    const el = this.body()?.nativeElement;
    if (!el) return;
    this.stickToBottom.set(el.scrollHeight - el.scrollTop - el.clientHeight < 50);
  }

  /** Pins the transcript body to the bottom after Angular commits new lines. */
  private scrollToBottom(): void {
    afterNextRender(
      {
        write: () => {
          const el = this.body()?.nativeElement;
          if (el) el.scrollTop = el.scrollHeight;
        },
      },
      { injector: this.injector }
    );
  }

  /** Resets the transcript body to the top (opening a finished session). */
  private scrollToTop(): void {
    afterNextRender(
      {
        write: () => {
          const el = this.body()?.nativeElement;
          if (el) el.scrollTop = 0;
        },
      },
      { injector: this.injector }
    );
  }

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
