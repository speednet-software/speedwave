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

import { TooltipDirective } from '../../shared/tooltip.directive';
import { ChatStateService, NEW_CONVERSATION_STREAMING } from '../../services/chat-state.service';
import { TranscriptionService, type SendTarget } from '../../services/transcription.service';
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
 * Maps linear RMS to a 0-100 meter width on a dB scale (-60..0 dBFS) — speech RMS sits around
 * 0.005-0.15, which a linear meter would render as a near-invisible sliver.
 * @param rms - linear RMS in 0..1.
 */
function rmsToPct(rms: number): number {
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.round(Math.min(100, Math.max(0, ((db + 60) / 60) * 100)));
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
 * `live_segments`), finalize progress bar, and the send-to-chat actions behind a confirm dialog.
 */
@Component({
  selector: 'app-live-transcript',
  standalone: true,
  imports: [TooltipDirective],
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

      @if (status() === 'recording' && meterBars().length > 0) {
        <div class="mb-2 space-y-1" data-testid="audio-level-meter">
          @for (bar of meterBars(); track bar.label) {
            <div class="flex items-center gap-2">
              <span class="mono w-14 shrink-0 text-[10px] text-[var(--ink-mute)]">{{
                bar.label
              }}</span>
              <div class="h-1.5 flex-1 overflow-hidden rounded bg-[var(--bg-2)]">
                <div
                  class="h-full bg-[var(--accent)] transition-[width] duration-150"
                  [style.width.%]="bar.pct"
                ></div>
              </div>
            </div>
          }
        </div>
      }

      @if (recordOnly()) {
        <p class="mb-2 text-[12px] text-[var(--ink-mute)]" data-testid="record-only-hint">
          Live transcript is off — the transcript will appear after you stop recording.
        </p>
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
        <div class="mt-2 flex flex-wrap items-center gap-2 border-t border-[var(--line)] pt-2">
          <span [appTooltip]="sendBlockedReason()" placement="top">
            <button
              type="button"
              class="mono rounded bg-[var(--accent)] px-3 py-1 text-[12px] font-medium text-[var(--bg)] hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
              data-testid="send-to-chat-btn"
              [attr.aria-label]="ariaLabel('Send to new chat', sendBlockedReason())"
              [disabled]="sending() || sendBlockedReason() !== ''"
              (click)="sendToChat()"
            >
              {{ sending() ? 'sending…' : 'Send to new chat' }}
            </button>
          </span>
          <span [appTooltip]="appendBlockedReason()" placement="top">
            <button
              type="button"
              class="mono rounded px-3 py-1 text-[12px] font-medium text-[var(--ink)] ring-1 ring-[var(--line)] hover:bg-[var(--bg-2)] disabled:pointer-events-none disabled:opacity-40"
              data-testid="append-to-chat-btn"
              [attr.aria-label]="ariaLabel('Add to current chat', appendBlockedReason())"
              [disabled]="sending() || appendBlockedReason() !== ''"
              (click)="sendToChat('current-chat')"
            >
              Add to current chat
            </button>
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

  /** `true` while a send call is in flight. */
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
    // Sort a copy: the stored order is append order, and sort() is stable.
    const ordered = [...this.segments()].sort(bySegmentStart);
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

  /** Record-only session: recording with no live pass — the meter is the only feedback. */
  readonly recordOnly = computed(
    () => this.status() === 'recording' && this.session()?.models_used.live == null
  );

  /**
   * Why sending is blocked ('' when it is not) — the service owns every reason but
   * the recording gate, so the disabled state matches what the send would refuse.
   */
  readonly sendBlockedReason = computed(() =>
    this.status() === 'recording'
      ? 'Stop the recording first'
      : this.chat.newConversationBlockedReason()
  );

  /**
   * Narrower than {@link sendBlockedReason} on purpose: an open conversation implies a
   * ready project, and `sendMessage` waits out a session start instead of refusing.
   */
  readonly appendBlockedReason = computed(() => {
    if (this.status() === 'recording') return 'Stop the recording first';
    if (this.chat.isStreamingFromState()) return NEW_CONVERSATION_STREAMING;
    return this.chat.hasConversation() ? '' : 'No open chat to add to';
  });

  /** Loudness bars: label per captured channel, level as 0–100 for the width binding. */
  readonly meterBars = computed<{ label: string; pct: number }[]>(() => {
    const kind = this.session()?.audio_source.source.kind;
    const levels = this.transcription.audioLevels();
    if (!levels || levels.length === 0) {
      // Recording but no level event yet (capture still spinning up): show the
      // expected channels at 0% — a flat bar reads "silent", a missing meter
      // reads "broken". Channel count comes from the source shape.
      if (this.status() !== 'recording' || !kind) return [];
      return kind === 'mixed'
        ? [
            { label: 'Meeting', pct: 0 },
            { label: 'You', pct: 0 },
          ]
        : [{ label: kind === 'microphone' ? 'You' : 'Meeting', pct: 0 }];
    }
    if (levels.length === 2) {
      return [
        { label: 'Meeting', pct: rmsToPct(levels[0]) },
        { label: 'You', pct: rmsToPct(levels[1]) },
      ];
    }
    return [{ label: kind === 'microphone' ? 'You' : 'Meeting', pct: rmsToPct(levels[0]) }];
  });
  /** Finalize progress 0–100 (0 when not finalizing). */
  readonly finalizePct = computed(() => {
    const st = this.session()?.status;
    return st?.state === 'finalizing' ? Math.round(st.progress * 100) : 0;
  });

  private readonly transcription = inject(TranscriptionService);
  private readonly chat = inject(ChatStateService);
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

  /**
   * Button label carrying its blocked reason: a `disabled` button fires no hover or
   * focus events, so the tooltip alone never reaches keyboard or screen-reader users.
   * @param label - the visible button text.
   * @param reason - the blocked reason, '' when the button is live.
   */
  ariaLabel(label: string, reason: string): string {
    return reason ? `${label} (unavailable: ${reason})` : label;
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

  /**
   * Confirms, drops the transcript into a chat, then opens the chat tab.
   * @param target - `'new-chat'` (default) or `'current-chat'` to keep the active thread.
   */
  async sendToChat(target: SendTarget = 'new-chat'): Promise<void> {
    const s = this.session();
    const blocked = target === 'new-chat' ? this.sendBlockedReason() : this.appendBlockedReason();
    if (!s || blocked) return;
    const where =
      target === 'new-chat'
        ? 'This starts a new chat and drops the transcript text into it'
        : 'This drops the transcript text into your current chat';
    const ok = window.confirm(`${where} (sent to your configured LLM provider). Continue?`);
    if (!ok) return;
    this.sending.set(true);
    this.error.set('');
    try {
      await this.transcription.sendToChat(s.id, target);
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
