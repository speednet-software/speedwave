import {
  ChangeDetectionStrategy,
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
import { Clipboard } from '@angular/cdk/clipboard';

import { TooltipDirective } from '../../shared/tooltip.directive';
import { ChatStateService, NEW_CONVERSATION_STREAMING } from '../../services/chat-state.service';
import { TranscriptionService, type SendTarget } from '../../services/transcription.service';
import type { Segment, TranscriptSession } from '../../models/transcript';
import { formatDuration, formatRecordingDate, recordingName } from '../recording-format';

/** Tooltip on "Attach to new chat". */
const NEW_CHAT_TOOLTIP =
  'Opens a new chat with the transcript attached and a prompt you can edit. Nothing is sent until you press Send.';
/** Tooltip on "Attach to current chat". */
const CURRENT_CHAT_TOOLTIP =
  'Attaches the transcript to the open conversation. Nothing is sent until you press Send.';
/** Tooltip on Transcribe. */
const TRANSCRIBE_TOOLTIP = 'Runs the transcription on the recorded audio again.';
/** Tooltip on Export. */
const EXPORT_TOOLTIP = 'Saves the transcript as Markdown.';
/** How long the "Copied" confirmation stays. */
const COPIED_FEEDBACK_MS = 2000;
/**
 * Progress at which the offline pass has decoded every part (`run_finalize` reports 0.05 → 0.60
 * while decoding, then installs the result); the time estimate extrapolates to this point.
 */
const DECODE_DONE_PROGRESS = 0.6;

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

/** A timestamped transcript line, for rendering. */
interface TranscriptLine {
  startLabel: string;
  /** Channel label ('You' / 'Meeting') on paired captures, else null. */
  speaker: string | null;
  text: string;
}

/** Where the transcription progress stood when this pane first saw it, for the time estimate. */
interface ProgressAnchor {
  sessionId: string;
  at: number;
  progress: number;
}

/**
 * Transcript pane (right): the open recording's name (renamable), its transcript, the
 * transcription progress with a time estimate, Transcribe for a failed recording, Export / Copy /
 * Show audio file, and the actions that attach the transcript to a chat. Errors go to the parent.
 */
@Component({
  selector: 'app-live-transcript',
  standalone: true,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="flex h-full flex-col" data-testid="live-transcript">
      <p class="sr-only" aria-live="polite" data-testid="status-announcement">
        {{ announcement() }}
      </p>

      @if (session(); as s) {
        @if (status() !== 'recording') {
          <header class="mb-2 border-b border-[var(--line)] pb-2" data-testid="transcript-header">
            @if (renaming()) {
              <input
                #titleInput
                type="text"
                maxlength="120"
                class="w-full rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-0.5 text-[14px] text-[var(--ink)]"
                aria-label="Recording name"
                data-testid="title-input"
                [value]="s.title ?? ''"
                [placeholder]="defaultName()"
                (keydown.enter)="saveTitle($any($event.target).value)"
                (keydown.escape)="renaming.set(false)"
                (blur)="saveTitle($any($event.target).value)"
              />
            } @else {
              <div class="flex items-center gap-2">
                <h2
                  class="truncate text-[14px] font-medium text-[var(--ink)]"
                  data-testid="transcript-title"
                >
                  {{ name() }}
                </h2>
                <button
                  type="button"
                  class="mono shrink-0 text-[10px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
                  data-testid="rename-btn"
                  (click)="startRename()"
                >
                  Rename
                </button>
              </div>
            }
            <div class="mt-0.5 text-[10px] text-[var(--ink-mute)]" data-testid="transcript-meta">
              {{ meta() }}
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
              @if (status() === 'failed') {
                <span [appTooltip]="transcribeTooltip" placement="top">
                  <button
                    type="button"
                    class="mono rounded bg-[var(--accent)] px-2 py-0.5 font-medium text-[var(--bg)] hover:opacity-90 disabled:opacity-40"
                    data-testid="transcribe-btn"
                    [disabled]="working()"
                    (click)="transcribe()"
                  >
                    Transcribe
                  </button>
                </span>
              }
              @if (status() === 'done' && lines().length > 0) {
                <span [appTooltip]="exportTooltip" placement="top">
                  <button
                    type="button"
                    class="mono rounded px-2 py-0.5 text-[var(--ink)] ring-1 ring-[var(--line)] hover:bg-[var(--bg-2)] disabled:opacity-40"
                    data-testid="export-btn"
                    [disabled]="working()"
                    (click)="exportMarkdown()"
                  >
                    Export
                  </button>
                </span>
                <button
                  type="button"
                  class="mono rounded px-2 py-0.5 text-[var(--ink)] ring-1 ring-[var(--line)] hover:bg-[var(--bg-2)]"
                  data-testid="copy-btn"
                  [attr.aria-label]="copied() ? 'Copied to clipboard' : 'Copy transcript'"
                  (click)="copyMarkdown()"
                >
                  {{ copied() ? 'Copied' : 'Copy' }}
                </button>
              }
              <button
                type="button"
                class="mono rounded px-2 py-0.5 text-[var(--ink-mute)] hover:text-[var(--ink)]"
                data-testid="reveal-btn"
                (click)="revealAudio()"
              >
                Show audio file
              </button>
            </div>
            @if (failureReason(); as reason) {
              <p class="mt-2 text-[11px] text-red-300" data-testid="failure-reason">
                Transcription failed: {{ reason }}
              </p>
            }
          </header>
        }
      }

      @if (status() === 'finalizing') {
        <div class="mb-2 text-[12px] text-[var(--ink-mute)]" data-testid="finalize-bar">
          {{ finalizeLabel() }}… {{ finalizePct() }}%
          @if (eta()) {
            <span data-testid="finalize-eta">· {{ eta() }}</span>
          }
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
        @if (emptyText(); as empty) {
          <p class="text-[12px] text-[var(--ink-mute)]" data-testid="transcript-empty">
            {{ empty }}
          </p>
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

      @if (session() && status() !== 'recording') {
        <div class="mt-2 border-t border-[var(--line)] pt-2">
          <div class="flex flex-wrap items-center gap-2">
            <span [appTooltip]="sendBlockedReason() || newChatTooltip" placement="top">
              <button
                type="button"
                class="mono rounded bg-[var(--accent)] px-3 py-1 text-[12px] font-medium text-[var(--bg)] hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
                data-testid="send-to-chat-btn"
                [attr.aria-label]="ariaLabel('Attach to new chat', sendBlockedReason())"
                [disabled]="sending() || sendBlockedReason() !== ''"
                (click)="stageForChat()"
              >
                {{ sending() ? 'opening…' : 'Attach to new chat' }}
              </button>
            </span>
            <span [appTooltip]="appendBlockedReason() || currentChatTooltip" placement="top">
              <button
                type="button"
                class="mono rounded px-3 py-1 text-[12px] font-medium text-[var(--ink)] ring-1 ring-[var(--line)] hover:bg-[var(--bg-2)] disabled:pointer-events-none disabled:opacity-40"
                data-testid="append-to-chat-btn"
                [attr.aria-label]="ariaLabel('Attach to current chat', appendBlockedReason())"
                [disabled]="sending() || appendBlockedReason() !== ''"
                (click)="stageForChat('current-chat')"
              >
                Attach to current chat
              </button>
            </span>
          </div>
          <p class="mt-1 text-[10px] text-[var(--ink-mute)]" data-testid="chat-privacy-note">
            Opens the chat with the transcript attached. Nothing is sent until you press Send.
          </p>
        </div>
      }
    </section>
  `,
})
export class LiveTranscriptComponent {
  /** The session to render. The parent passes the service's active signal. */
  readonly session = input<TranscriptSession | null>(null);
  /** Forwards errors to the parent banner, the one place errors render. */
  readonly errorOccurred = output<string>();

  /** `true` while the staging call is in flight. */
  readonly sending = signal(false);
  /** `true` while a transcribe or export call runs. */
  readonly working = signal(false);
  /** Whether the title is being edited. */
  readonly renaming = signal(false);
  /** Shows "Copied" for a moment after a copy. */
  readonly copied = signal(false);

  protected readonly newChatTooltip = NEW_CHAT_TOOLTIP;
  protected readonly currentChatTooltip = CURRENT_CHAT_TOOLTIP;
  protected readonly transcribeTooltip = TRANSCRIBE_TOOLTIP;
  protected readonly exportTooltip = EXPORT_TOOLTIP;

  private readonly transcription = inject(TranscriptionService);
  private readonly chat = inject(ChatStateService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly clipboard = inject(Clipboard);

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
    const ordered = [...this.segments()].sort(bySegmentStart);
    return ordered.map((seg) => ({
      startLabel: fmtTs(seg.start.secs),
      speaker: seg.source === 'mic' ? 'You' : seg.source === 'system' ? 'Meeting' : null,
      text: seg.text.trim(),
    }));
  });

  /** Lifecycle state of the active session ('' if none). */
  readonly status = computed(() => this.session()?.status.state ?? '');

  /** The open recording's list row (duration, size), once the list has it. */
  private readonly summary = computed(() => {
    const id = this.session()?.id;
    return this.transcription.recordings().find((r) => r.id === id) ?? null;
  });

  /** Shown name: the title, else the local start time. */
  readonly name = computed(() => {
    const s = this.session();
    return s ? recordingName(s) : '';
  });

  /** The name a cleared title falls back to (the input's placeholder). */
  readonly defaultName = computed(() => {
    const s = this.session();
    return s ? formatRecordingDate(s.created_at) : '';
  });

  /** Start time (under a title), length and source. */
  readonly meta = computed(() => {
    const s = this.session();
    if (!s) return '';
    const parts = [
      s.title ? formatRecordingDate(s.created_at) : '',
      formatDuration(this.summary()?.duration_secs ?? 0),
      s.audio_source.label,
    ];
    return parts.filter(Boolean).join(' · ');
  });

  /** Why the last transcription failed, while the session is failed. */
  readonly failureReason = computed(() => {
    const st = this.session()?.status;
    return st?.state === 'failed' ? st.reason : '';
  });

  /** Uncommitted decode tail, shown as a muted line only while recording. */
  readonly draft = computed(() =>
    this.status() === 'recording' ? this.transcription.liveDraft() : ''
  );

  /** One line explaining an empty transcript body ('' when there is text, or nothing to say). */
  readonly emptyText = computed(() => {
    if (this.lines().length > 0 || this.draft()) return '';
    switch (this.status()) {
      case '':
        return 'Open a recording, or start a new one.';
      case 'recording':
        return this.session()?.models_used.live ? 'Listening…' : '';
      case 'finalizing':
        return '';
      case 'failed':
        return 'No transcript yet. Transcribe runs it again on the recorded audio.';
      default:
        return 'No speech was recognized in this recording.';
    }
  });

  /** Screen-reader announcement of the open recording's state. */
  readonly announcement = computed(() => {
    switch (this.status()) {
      case 'recording':
        return 'Recording';
      case 'finalizing':
        return 'Transcribing';
      case 'done':
        return 'Transcript ready';
      case 'failed':
        return 'Transcription failed';
      default:
        return '';
    }
  });

  /**
   * Why sending is blocked ('' when it is not) — the service owns every reason but the
   * transcript-readiness gates, so the disabled state matches what the send would refuse.
   */
  readonly sendBlockedReason = computed(
    () => this.transcriptBlockedReason() || this.chat.newConversationBlockedReason()
  );

  /**
   * Narrower than {@link sendBlockedReason} on purpose: an open conversation implies a
   * ready project, and `sendMessage` waits out a session start instead of refusing.
   */
  readonly appendBlockedReason = computed(() => {
    const own = this.transcriptBlockedReason();
    if (own) return own;
    if (this.chat.isStreamingFromState()) return NEW_CONVERSATION_STREAMING;
    return this.chat.hasConversation() ? '' : 'No open chat to attach to';
  });

  /** Finalize progress 0–100 (0 when not finalizing). */
  readonly finalizePct = computed(() => {
    const st = this.session()?.status;
    return st?.state === 'finalizing' ? Math.round(st.progress * 100) : 0;
  });

  /** What the transcription pass is doing, in words. */
  readonly finalizeLabel = computed(() => {
    if (this.session()?.models_used.live) return 'Re-transcribing with the higher-quality model';
    const length = formatDuration(this.summary()?.duration_secs ?? 0);
    return length ? `Transcribing ${length} of audio` : 'Transcribing the recording';
  });

  /** Where the progress stood when this pane first saw the pass running. */
  private readonly progressAnchor = signal<ProgressAnchor | null>(null);

  /** Rough time left, re-read on every progress event, once there is enough to extrapolate. */
  readonly eta = computed(() => {
    const st = this.session()?.status;
    const anchor = this.progressAnchor();
    if (st?.state !== 'finalizing' || !anchor || anchor.sessionId !== this.session()?.id) return '';
    const moved = st.progress - anchor.progress;
    const elapsedMs = Date.now() - anchor.at;
    if (moved < 0.05 || elapsedMs < 5000 || st.progress >= DECODE_DONE_PROGRESS) return '';
    const leftMs = (elapsedMs / moved) * (DECODE_DONE_PROGRESS - st.progress);
    return leftMs < 60_000
      ? 'less than a minute left'
      : `about ${Math.ceil(leftMs / 60_000)} min left`;
  });

  /** The scrollable transcript body. */
  private readonly body = viewChild<ElementRef<HTMLDivElement>>('body');
  /** The title field while renaming. */
  private readonly titleInput = viewChild<ElementRef<HTMLInputElement>>('titleInput');
  /** False once the user scrolls up; re-arms when they return to the bottom. */
  private readonly stickToBottom = signal(true);
  /** Id-only view of the session, so snapshot updates don't retrigger effects. */
  private readonly sessionId = computed(() => this.session()?.id ?? '');
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;

  /** Wires the auto-scroll and progress-anchor effects (constructor = injection context). */
  constructor() {
    effect(() => {
      this.sessionId();
      this.stickToBottom.set(true);
      this.renaming.set(false);
      if (untracked(() => this.status()) === 'recording') {
        this.scrollToBottom();
      } else {
        this.scrollToTop();
      }
    });
    effect(() => {
      this.lines();
      this.draft();
      if (this.status() === 'recording' && this.stickToBottom()) this.scrollToBottom();
    });
    effect(() => {
      const st = this.session()?.status;
      const id = this.sessionId();
      const anchor = untracked(() => this.progressAnchor());
      if (st?.state !== 'finalizing') {
        if (anchor) this.progressAnchor.set(null);
      } else if (!anchor || anchor.sessionId !== id) {
        this.progressAnchor.set({ sessionId: id, at: Date.now(), progress: st.progress });
      }
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

  /** Opens the title field, focused. */
  startRename(): void {
    this.renaming.set(true);
    afterNextRender(
      {
        write: () => {
          const el = this.titleInput()?.nativeElement;
          el?.focus();
          el?.select();
        },
      },
      { injector: this.injector }
    );
  }

  /**
   * Stores the typed title (blank restores the default name) and closes the field.
   * @param value - the field's text.
   */
  async saveTitle(value: string): Promise<void> {
    const s = this.session();
    if (!this.renaming() || !s) return;
    this.renaming.set(false);
    if (value.trim() === (s.title ?? '').trim()) return;
    try {
      await this.transcription.rename(s.id, value);
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
  }

  /** Runs the transcription again over the failed recording's audio. */
  async transcribe(): Promise<void> {
    const s = this.session();
    if (!s) return;
    this.working.set(true);
    try {
      await this.transcription.transcribe(s.id);
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    } finally {
      this.working.set(false);
    }
  }

  /** Saves the transcript as Markdown where the user picks. */
  async exportMarkdown(): Promise<void> {
    const s = this.session();
    if (!s) return;
    this.working.set(true);
    try {
      await this.transcription.exportMarkdown(s.id);
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    } finally {
      this.working.set(false);
    }
  }

  /** Copies the Markdown transcript to the clipboard. */
  async copyMarkdown(): Promise<void> {
    const s = this.session();
    if (!s) return;
    try {
      const md = await this.transcription.getMarkdown(s.id);
      if (!this.clipboard.copy(md)) {
        this.errorOccurred.emit('could not copy the transcript to the clipboard');
        return;
      }
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
      return;
    }
    this.copied.set(true);
    clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => this.copied.set(false), COPIED_FEEDBACK_MS);
  }

  /** Shows the recording's audio file in Finder or Explorer. */
  async revealAudio(): Promise<void> {
    const s = this.session();
    if (!s) return;
    try {
      await this.transcription.revealAudio(s.id);
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Stages the transcript for the chat composer, then opens the chat tab so the user can edit
   * the prompt before sending. Nothing leaves the machine here.
   * @param target - `'new-chat'` (default) or `'current-chat'` to keep the active thread.
   */
  async stageForChat(target: SendTarget = 'new-chat'): Promise<void> {
    const s = this.session();
    const blocked = target === 'new-chat' ? this.sendBlockedReason() : this.appendBlockedReason();
    if (!s || blocked) return;
    this.sending.set(true);
    try {
      await this.transcription.stageForChat(s.id, target);
      await this.router.navigate(['/chat']);
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
    this.sending.set(false);
  }

  /** Why the transcript itself cannot go to a chat yet ('' when it can). */
  private transcriptBlockedReason(): string {
    switch (this.status()) {
      case 'recording':
        return 'Stop the recording first';
      case 'finalizing':
        return 'Wait until the transcript is ready';
      default:
        return this.lines().length === 0 ? 'This recording has no transcript yet' : '';
    }
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
}
