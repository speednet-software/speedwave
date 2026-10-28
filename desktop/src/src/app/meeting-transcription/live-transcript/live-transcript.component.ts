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
import { IconComponent } from '../../shared/icon.component';
import { ChatStateService, NEW_CONVERSATION_STREAMING } from '../../services/chat-state.service';
import { TranscriptionService, type SendTarget } from '../../services/transcription.service';
import type { Segment, TranscriptSession, TranscriptStatus } from '../../models/transcript';
import { formatBytes } from '../../shared/format-bytes';
import {
  formatDuration,
  formatRecordingDate,
  STATE_LABEL,
  recordingName,
  shownTranscriptQuality,
  transcriptQuality,
  LANGUAGE_NAME,
} from '../recording-format';

/** Tooltip on "Attach to new chat". */
const NEW_CHAT_TOOLTIP =
  'Opens a new chat with the transcript attached and a prompt you can edit. Nothing is sent until you press Send.';
/** Hint under "Attach to current chat" in the attach menu. */
const CURRENT_CHAT_HINT = 'Keeps the open conversation. Nothing is sent until you press Send.';
/** Tooltip on Transcribe. */
const TRANSCRIBE_TOOLTIP = 'Runs the transcription on the recorded audio.';
/** Tooltip on Later while the transcription runs. */
const LATER_RUNNING_TOOLTIP =
  'Stops the transcription so it does not slow this computer down. The audio is kept; Transcribe starts it again from the beginning.';
/** Tooltip on Later while the transcription waits in the queue. */
const LATER_QUEUED_TOOLTIP =
  'Takes this recording out of the queue. The audio is kept; Transcribe it when you are ready.';
/** Classes of the accent (primary) half of the attach button. */
const PRIMARY_BTN = 'bg-[var(--accent)] text-[var(--on-accent)] hover:opacity-90';
/** Classes of the attach button when Transcribe is the primary action. */
const SECONDARY_BTN =
  'bg-[var(--bg-2)] text-[var(--ink)] ring-1 ring-inset ring-[var(--line-strong)] hover:bg-[var(--bg-3)]';
/** Tooltip on Export. */
const EXPORT_TOOLTIP = 'Saves the transcript as Markdown.';
/** How long the "Copied" confirmation stays. */
const COPIED_FEEDBACK_MS = 2000;
const DECODE_START_PROGRESS = 0.05;
const DECODE_DONE_PROGRESS = 0.6;
const DIARIZE_START_PROGRESS = 0.62;
const DIARIZE_DONE_PROGRESS = 0.85;
const ETA_PACE_WINDOW_MS = 120_000;
const ETA_MIN_PACE_SPAN_MS = 30_000;
const ETA_MIN_MOVED = 0.05;
const ETA_MIN_ELAPSED_MS = 5000;

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
  /** 'You' / 'Meeting', 'Meeting · Speaker N' or, untagged, 'Speaker N' when diarized; else null. */
  speaker: string | null;
  speakerColor: string | null;
  text: string;
}

const SPEAKER_COLORS = ['var(--teal)', 'var(--violet)', 'var(--amber)', 'var(--green)'];

const MICROPHONE_ONLY_NO_LABELS =
  'Speaker labels are not available for a microphone-only recording.';

function speakerOf(seg: Segment): Pick<TranscriptLine, 'speaker' | 'speakerColor'> {
  if (seg.source === 'mic') return { speaker: 'You', speakerColor: null };
  const n = seg.speaker_id;
  const labelled = n != null && n >= 1;
  const speakerColor = labelled ? (SPEAKER_COLORS[n - 1] ?? null) : null;
  if (seg.source === 'system') {
    if (!labelled) return { speaker: 'Meeting', speakerColor: null };
    return { speaker: `Meeting · Speaker ${n}`, speakerColor };
  }
  if (!labelled) return { speaker: null, speakerColor: null };
  return { speaker: `Speaker ${n}`, speakerColor };
}

/** The quality line under the title: its words and colour. */
interface QualityLine {
  text: string;
  cls: string;
}

/** Which of the pane's menus is open. */
type OpenMenu = 'chat' | 'more' | null;

interface ProgressSample {
  at: number;
  progress: number;
}

interface ProgressTrack {
  sessionId: string;
  samples: ProgressSample[];
}

/**
 * Transcript pane (right): the open recording's name (renamable), how and with which model its
 * transcript was made, the progress with a time estimate and Later (puts the transcription off),
 * one row of actions (attach to a chat, Copy, Export, and a menu with Transcribe again, Show audio
 * file, Continue recording and Delete), and the transcript itself. Errors go to the parent.
 */
@Component({
  selector: 'app-live-transcript',
  standalone: true,
  imports: [TooltipDirective, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex min-h-0 flex-1 flex-col',
    '(document:click)': 'onDocumentClick($event)',
    '(document:keydown.escape)': 'closeMenus()',
  },
  template: `
    <section class="flex h-full min-h-0 flex-col" data-testid="live-transcript">
      <p class="sr-only" aria-live="polite" data-testid="status-announcement">
        {{ announcement() }}
      </p>

      @if (session(); as s) {
        <header
          class="border-b border-[var(--line)] px-8 pb-3.5 pt-4"
          data-testid="transcript-header"
        >
          @if (renaming()) {
            <div class="-mx-1.5">
              <input
                #titleInput
                type="text"
                maxlength="120"
                class="h-8 w-full max-w-xl rounded border border-[var(--accent)] bg-[var(--bg-2)] px-1.5 text-[17px] font-semibold leading-8 text-[var(--ink)] outline-none placeholder:font-normal placeholder:text-[var(--ink-mute)]"
                aria-label="Recording name"
                aria-describedby="title-input-hint"
                data-testid="title-input"
                [value]="s.title ?? ''"
                [placeholder]="defaultName()"
                (keydown.enter)="saveTitle($any($event.target).value, true)"
                (keydown.escape)="cancelRename()"
                (blur)="saveTitle($any($event.target).value)"
              />
              <p id="title-input-hint" class="mt-0.5 px-1.5 text-[10px] text-[var(--ink-mute)]">
                Enter to save · Esc to cancel · leave empty to use the start time
              </p>
            </div>
          } @else {
            <h2 class="-mx-1.5 min-w-0">
              <button
                #renameBtn
                type="button"
                class="group flex h-8 max-w-full items-center gap-2 rounded px-1.5 text-left hover:bg-[var(--bg-2)] focus-visible:bg-[var(--bg-2)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
                data-testid="rename-btn"
                [attr.aria-label]="'Rename recording: ' + name()"
                [appTooltip]="'Rename'"
                placement="bottom"
                (click)="startRename()"
              >
                <span
                  class="truncate text-[17px] font-semibold text-[var(--ink)]"
                  data-testid="transcript-title"
                  >{{ name() }}</span
                >
                <app-icon
                  name="pencil"
                  class="h-3.5 w-3.5 text-[var(--ink-mute)] opacity-60 group-hover:text-[var(--ink)] group-hover:opacity-100 group-focus-visible:opacity-100"
                />
              </button>
            </h2>
          }
          <div
            class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-[var(--ink-mute)]"
            data-testid="transcript-meta"
          >
            <span>{{ meta() }}</span>
            @if (quality(); as q) {
              <span aria-hidden="true">·</span>
              <span
                class="inline-flex items-center gap-1.5"
                [class]="q.cls"
                data-testid="transcript-quality"
              >
                <span class="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true"></span>
                {{ q.text }}
                @if (eta()) {
                  <span data-testid="finalize-eta">· {{ eta() }}</span>
                }
              </span>
            }
          </div>

          @if (status() === 'finalizing') {
            <div class="mt-2 flex max-w-xl items-center gap-3">
              <div
                class="h-1 min-w-0 flex-1 overflow-hidden rounded bg-[var(--bg-2)]"
                data-testid="finalize-bar"
                role="progressbar"
                [attr.aria-label]="quality()?.text ?? 'Transcribing'"
                aria-valuemin="0"
                aria-valuemax="100"
                [attr.aria-valuenow]="finalizePct()"
              >
                <div class="h-full bg-[var(--amber)]" [style.width.%]="finalizePct()"></div>
              </div>
              <span [appTooltip]="laterTooltip()" placement="bottom">
                <button
                  type="button"
                  class="mono shrink-0 whitespace-nowrap rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-0.5 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40"
                  data-testid="later-btn"
                  [attr.aria-label]="'Transcribe later. ' + laterTooltip()"
                  [disabled]="working()"
                  (click)="postpone()"
                >
                  Later
                </button>
              </span>
            </div>
          }

          @if (smallerModel(); as kind) {
            <div
              class="mt-3 flex max-w-3xl items-center justify-between gap-3 rounded-md border border-[var(--amber)]/40 bg-[var(--amber-soft)] px-3 py-2 text-[12.5px] leading-relaxed text-[var(--ink)]"
              data-testid="smaller-model-banner"
            >
              <span>
                @if (kind === 'live') {
                  This is the live text from the recording, made with a smaller model. Expect more
                  mistakes.
                } @else {
                  This transcript was made with the smaller model because the high-quality one was
                  not downloaded. Expect more mistakes.
                }
              </span>
              @if (bestModelReady()) {
                <button
                  type="button"
                  class="mono shrink-0 rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40"
                  data-testid="banner-transcribe"
                  [disabled]="working()"
                  (click)="transcribe()"
                >
                  {{ kind === 'live' ? 'Transcribe' : 'Transcribe again' }}
                </button>
              } @else {
                <button
                  type="button"
                  class="mono shrink-0 rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40"
                  data-testid="download-best-model"
                  [disabled]="downloadBusy()"
                  (click)="downloadBestModel()"
                >
                  {{ downloadLabel() }}
                </button>
              }
            </div>
          }

          @if (failureReason(); as reason) {
            <p class="mt-2 text-[12px] text-[var(--red)]" data-testid="failure-reason">
              Transcription failed: {{ reason }}
            </p>
          }

          @if (showActions()) {
            <div class="mt-3 flex flex-wrap items-center gap-2 text-[12px]" data-menu-root>
              @if (needsTranscription()) {
                <span [appTooltip]="transcribeTooltip" placement="bottom">
                  <button
                    type="button"
                    class="mono rounded bg-[var(--accent)] px-3 py-1.5 font-semibold text-[var(--on-accent)] hover:opacity-90 disabled:opacity-40"
                    data-testid="transcribe-btn"
                    [disabled]="working()"
                    (click)="transcribe()"
                  >
                    Transcribe
                  </button>
                </span>
              }
              <span class="relative inline-flex">
                <span [appTooltip]="sendBlockedReason() || newChatTooltip" placement="bottom">
                  <button
                    type="button"
                    class="mono rounded-l px-3 py-1.5 font-semibold disabled:pointer-events-none disabled:opacity-40"
                    [class]="needsTranscription() ? secondaryBtn : primaryBtn"
                    data-testid="send-to-chat-btn"
                    [attr.aria-label]="ariaLabel('Attach to new chat', sendBlockedReason())"
                    [disabled]="sending() || sendBlockedReason() !== ''"
                    (click)="stageForChat()"
                  >
                    {{ sending() ? 'Opening…' : 'Attach to new chat' }}
                  </button>
                </span>
                <button
                  type="button"
                  class="rounded-r border-l border-black/25 px-1.5 py-1.5"
                  [class]="needsTranscription() ? secondaryBtn : primaryBtn"
                  aria-label="More ways to attach"
                  aria-haspopup="menu"
                  data-testid="chat-menu-btn"
                  [attr.aria-expanded]="openMenu() === 'chat'"
                  (click)="toggleMenu('chat')"
                >
                  <app-icon name="chevron-down" class="h-3 w-3" />
                </button>
                @if (openMenu() === 'chat') {
                  <div
                    class="absolute left-0 top-full z-20 mt-1 min-w-[15rem] rounded-lg border border-[var(--line-strong)] bg-[var(--bg-2)] p-1 shadow-xl"
                    role="menu"
                    data-testid="chat-menu"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      class="flex w-full flex-col items-start rounded px-2.5 py-1.5 text-left text-[12.5px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40"
                      data-testid="append-to-chat-btn"
                      [attr.aria-label]="ariaLabel('Attach to current chat', appendBlockedReason())"
                      [disabled]="sending() || appendBlockedReason() !== ''"
                      (click)="stageForChat('current-chat')"
                    >
                      Attach to current chat
                      <span class="text-[11px] text-[var(--ink-mute)]">{{
                        appendBlockedReason() || currentChatHint
                      }}</span>
                    </button>
                  </div>
                }
              </span>
              <button
                type="button"
                class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1.5 text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40"
                data-testid="copy-btn"
                [attr.aria-label]="copied() ? 'Copied to clipboard' : 'Copy transcript'"
                [disabled]="!hasTranscript()"
                (click)="copyMarkdown()"
              >
                {{ copied() ? 'Copied' : 'Copy' }}
              </button>
              <span [appTooltip]="exportTooltip" placement="bottom">
                <button
                  type="button"
                  class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1.5 text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40"
                  data-testid="export-btn"
                  [disabled]="working() || !hasTranscript()"
                  (click)="exportMarkdown()"
                >
                  Export
                </button>
              </span>
              <span class="relative inline-flex">
                <button
                  type="button"
                  class="rounded px-2 py-1.5 text-[var(--ink-dim)] hover:bg-[var(--bg-2)] hover:text-[var(--ink)]"
                  [class.ring-1]="openMenu() === 'more'"
                  [class.ring-[var(--accent)]]="openMenu() === 'more'"
                  aria-label="More actions"
                  aria-haspopup="menu"
                  data-testid="more-btn"
                  [attr.aria-expanded]="openMenu() === 'more'"
                  (click)="toggleMenu('more')"
                >
                  <app-icon name="more-horizontal" class="h-4 w-4" />
                </button>
                @if (openMenu() === 'more') {
                  <div
                    class="absolute left-0 top-full z-20 mt-1 w-64 rounded-lg border border-[var(--line-strong)] bg-[var(--bg-2)] p-1 text-[12.5px] shadow-xl"
                    role="menu"
                    data-testid="more-menu"
                  >
                    @if (hasTranscript()) {
                      <button
                        type="button"
                        role="menuitem"
                        class="flex w-full flex-col rounded px-2.5 py-1.5 text-left text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40"
                        data-testid="retranscribe-item"
                        [disabled]="working()"
                        (click)="transcribe()"
                      >
                        Transcribe again
                        <span class="text-[11px] text-[var(--ink-mute)]">{{
                          retranscribeHint()
                        }}</span>
                      </button>
                    }
                    <button
                      type="button"
                      role="menuitem"
                      class="flex w-full items-center rounded px-2.5 py-1.5 text-left text-[var(--ink)] hover:bg-[var(--bg-3)]"
                      data-testid="reveal-btn"
                      (click)="revealAudio()"
                    >
                      Show audio file
                    </button>
                    @if (canContinue()) {
                      <button
                        type="button"
                        role="menuitem"
                        class="flex w-full flex-col rounded px-2.5 py-1.5 text-left text-[var(--ink)] hover:bg-[var(--bg-3)]"
                        data-testid="resume-item"
                        (click)="continueRecording()"
                      >
                        Continue recording
                        <span class="text-[11px] text-[var(--ink-mute)]"
                          >Adds a new part to this recording</span
                        >
                      </button>
                    }
                    @if (status() !== 'finalizing') {
                      <div class="my-1 h-px bg-[var(--line)]" role="separator"></div>
                      <button
                        type="button"
                        role="menuitem"
                        class="flex w-full items-center justify-between gap-4 rounded px-2.5 py-1.5 text-left text-[var(--red)] hover:bg-[var(--bg-3)]"
                        data-testid="delete-item"
                        (click)="askDelete()"
                      >
                        Delete recording…
                        <span class="text-[11px] text-[var(--ink-mute)]">{{ sizeLine() }}</span>
                      </button>
                    }
                  </div>
                }
              </span>
              <span class="text-[11.5px] text-[var(--ink-mute)]" data-testid="chat-privacy-note">{{
                sendBlockedReason() || 'Nothing is sent until you press Send.'
              }}</span>
            </div>
          }

          @if (confirmingDelete()) {
            <div
              class="mt-3 max-w-xl rounded-md border border-[var(--red)]/40 bg-[var(--red-soft)] p-3 text-[12.5px]"
              role="alertdialog"
              aria-label="Confirm deleting the recording"
              data-testid="delete-confirm"
            >
              <p class="text-[var(--ink)]">
                Delete "{{ name() }}"{{ sizeLine() ? ' (' + sizeLine() + ')' : '' }}?
              </p>
              <p class="mt-1 text-[11.5px] text-[var(--ink-mute)]">
                The audio and the transcript are removed from this machine. This cannot be undone.
              </p>
              <div class="mt-2 flex gap-2">
                <button
                  type="button"
                  class="mono rounded border border-[var(--red)]/40 px-2.5 py-1 text-[11.5px] text-[var(--red)] hover:bg-[var(--red-soft)] disabled:opacity-40"
                  data-testid="delete-yes"
                  [disabled]="working()"
                  (click)="remove()"
                >
                  Delete
                </button>
                <button
                  type="button"
                  class="mono rounded border border-[var(--line)] px-2.5 py-1 text-[11.5px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
                  data-testid="delete-no"
                  (click)="confirmingDelete.set(false)"
                >
                  Cancel
                </button>
              </div>
            </div>
          }
        </header>
      }

      <div
        #body
        class="min-h-0 flex-1 overflow-y-auto px-8 py-5"
        data-testid="transcript-body"
        (scroll)="onBodyScroll()"
      >
        <div class="max-w-[72ch]">
          @if (emptyText(); as empty) {
            <p
              class="text-[13px] leading-relaxed text-[var(--ink-mute)]"
              data-testid="transcript-empty"
            >
              {{ empty }}
            </p>
          }
          @for (line of lines(); track $index) {
            <div class="mb-3.5">
              <div class="mb-0.5 flex items-center gap-1.5 text-[11px] tabular-nums">
                <span class="text-[var(--ink-mute)]">{{ line.startLabel }}</span>
                @if (line.speaker) {
                  <span
                    class="inline-flex items-center gap-1 rounded bg-[var(--bg-2)] px-1 font-medium text-[var(--ink-dim)]"
                    data-testid="line-speaker"
                  >
                    @if (line.speakerColor) {
                      <span
                        class="h-1.5 w-1.5 rounded-full"
                        aria-hidden="true"
                        data-testid="line-speaker-dot"
                        [style.background-color]="line.speakerColor"
                      ></span>
                    }
                    {{ line.speaker }}</span
                  >
                }
              </div>
              <p class="text-[14px] leading-relaxed text-[var(--ink)]">{{ line.text }}</p>
            </div>
          }
          @if (draft()) {
            <p
              class="mb-2 whitespace-pre-line text-[14px] italic leading-relaxed text-[var(--ink-mute)]"
              data-testid="live-draft"
            >
              {{ draft() }}
            </p>
          }
        </div>
      </div>
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
  /** The menu that is open, if any. */
  readonly openMenu = signal<OpenMenu>(null);
  /** Whether the delete confirmation is showing. */
  readonly confirmingDelete = signal(false);

  protected readonly newChatTooltip = NEW_CHAT_TOOLTIP;
  protected readonly currentChatHint = CURRENT_CHAT_HINT;
  protected readonly transcribeTooltip = TRANSCRIBE_TOOLTIP;
  protected readonly exportTooltip = EXPORT_TOOLTIP;
  protected readonly primaryBtn = PRIMARY_BTN;
  protected readonly secondaryBtn = SECONDARY_BTN;

  private readonly transcription = inject(TranscriptionService);
  private readonly chat = inject(ChatStateService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly clipboard = inject(Clipboard);

  /** The Settings switch "Tell speakers apart in the meeting audio", read when the pane opens. */
  private readonly speakerAttribution = this.transcription.speakerAttribution();

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
      ...speakerOf(seg),
      text: seg.text.trim(),
    }));
  });

  /** Lifecycle state of the active session ('' if none). */
  readonly status = computed<TranscriptStatus['state'] | ''>(
    () => this.session()?.status.state ?? ''
  );

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

  /** The model the offline pass ran (or runs) with, from the list row or the snapshot. */
  private readonly finalizeModel = computed(
    () => this.summary()?.finalize_model ?? this.session()?.models_used.finalize ?? null
  );

  /** Start time (under a title), length, source and the language it is transcribed in. */
  readonly meta = computed(() => {
    const s = this.session();
    if (!s) return '';
    const parts = [
      s.title ? formatRecordingDate(s.created_at) : '',
      formatDuration(this.summary()?.duration_secs ?? 0),
      s.audio_source.label,
      LANGUAGE_NAME[s.language],
    ];
    return parts.filter(Boolean).join(' · ');
  });

  /** Quality of the transcript on screen; null when there is none or it is not known. */
  private readonly shownQuality = computed(() => {
    const status = this.session()?.status;
    if (!status) return null;
    return shownTranscriptQuality(
      { status, finalize_model: this.finalizeModel(), segment_count: this.lines().length },
      this.transcription.highQualityModel()?.key
    );
  });

  /**
   * The state line: only what needs a look (recording, transcribing, put off, failed, a smaller
   * model). A good finished transcript gets none and never names its model.
   */
  readonly quality = computed<QualityLine | null>(() => {
    const amber = 'text-[var(--amber)]';
    switch (this.status()) {
      case 'recording':
        return { text: STATE_LABEL.recording, cls: 'text-[var(--red)]' };
      case 'paused':
        return { text: STATE_LABEL.paused, cls: amber };
      case 'finalizing':
        if (this.summary()?.queued) {
          return { text: 'Waiting for another transcription to finish', cls: amber };
        }
        return transcriptQuality(
          this.finalizeModel(),
          this.transcription.highQualityModel()?.key
        ) === 'smaller'
          ? { text: 'Transcribing with the smaller model', cls: amber }
          : { text: this.transcribingLabel(), cls: amber };
      case 'done':
      case 'postponed':
        if (this.smallerModel()) return { text: 'Made with a smaller model', cls: amber };
        if (this.status() === 'postponed') {
          return { text: STATE_LABEL.postponed, cls: 'text-[var(--ink-dim)]' };
        }
        return this.microphoneOnlyWithoutLabels()
          ? { text: MICROPHONE_ONLY_NO_LABELS, cls: 'text-[var(--ink-dim)]' }
          : null;
      case 'failed':
        return { text: STATE_LABEL.failed, cls: 'text-[var(--red)]' };
      default:
        return null;
    }
  });

  /** Speaker labels were asked for, but a recording of the microphone alone is never diarized. */
  private readonly microphoneOnlyWithoutLabels = computed(() => {
    return this.speakerAttribution && this.session()?.audio_source.source.kind === 'microphone';
  });

  /**
   * How the transcript on screen came from a smaller model: a fallback offline pass, or only the
   * live text; null for a good one. The banner offers the fix.
   */
  readonly smallerModel = computed(() => {
    const quality = this.shownQuality();
    return quality === 'smaller' || quality === 'live' ? quality : null;
  });

  /** Whether the high-quality model is on disk, so Transcribe again would use it. */
  readonly bestModelReady = computed(
    () => this.transcription.highQualityModel()?.downloaded === true
  );

  /** A model download is running (this one or another). */
  readonly downloadBusy = computed(() => this.transcription.downloadingModelKey() !== null);

  /** Download button text, with progress while it runs. */
  readonly downloadLabel = computed(() => {
    const best = this.transcription.highQualityModel();
    if (best && this.transcription.downloadingModelKey() === best.key) {
      const p = this.transcription.downloadProgress();
      return p?.total_bytes
        ? `Downloading ${Math.round((p.downloaded_bytes / p.total_bytes) * 100)}%`
        : 'Downloading…';
    }
    return best
      ? `Download high-quality model (${formatBytes(best.size_bytes)})`
      : 'Download high-quality model';
  });

  /** Actions show once the capture is over: transcribing, finished, put off or failed. */
  readonly showActions = computed(() =>
    ['finalizing', 'done', 'postponed', 'failed'].includes(this.status())
  );

  /** A recording with no transcript to show (failed, or put off without live text): Transcribe leads. */
  readonly needsTranscription = computed(
    () => this.status() === 'failed' || (this.status() === 'postponed' && this.lines().length === 0)
  );

  /** What Later does: drop out of the queue, or stop the running transcription. */
  readonly laterTooltip = computed(() =>
    this.summary()?.queued ? LATER_QUEUED_TOOLTIP : LATER_RUNNING_TOOLTIP
  );

  /** Whether there is a transcript to copy, export or transcribe again: finished, or live text only. */
  readonly hasTranscript = computed(
    () => ['done', 'postponed'].includes(this.status()) && this.lines().length > 0
  );

  /** Continue recording: a finished recording, not an imported file, while nothing else records. */
  readonly canContinue = computed(
    () =>
      this.status() === 'done' &&
      this.session()?.audio_source.source.kind !== 'imported_file' &&
      !this.transcription.recording() &&
      this.transcription.pausedRecording() === null
  );

  /** "13 min · 12 MB" for the delete item and its confirmation. */
  readonly sizeLine = computed(() => {
    const row = this.summary();
    if (!row) return '';
    return [formatDuration(row.duration_secs), formatBytes(row.size_bytes)]
      .filter(Boolean)
      .join(' · ');
  });

  /** Which model Transcribe again would use. */
  readonly retranscribeHint = computed(() => {
    const model = this.bestModelReady()
      ? 'with the high-quality model'
      : 'with the model on this machine';
    return this.session()?.models_used.diarization
      ? `${model}. Speaker numbers can change.`
      : model;
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
        return 'Open a recording, or press Record to start one.';
      case 'recording':
        return this.session()?.models_used.live
          ? 'Listening…'
          : 'Recording. The transcript appears after you stop.';
      case 'paused':
        return 'Paused. Nothing is being recorded. Resume to add more, or stop to transcribe.';
      case 'finalizing':
        return 'The transcript appears here when transcription finishes. You can start another recording meanwhile.';
      case 'failed':
        return 'No transcript yet. Transcribe runs it again on the recorded audio.';
      case 'postponed':
        return 'Transcription was put off, so it does not slow this computer down. Press Transcribe when you are ready.';
      default:
        return 'No speech was recognized in this recording.';
    }
  });

  /** Screen-reader announcement of the open recording's state. */
  readonly announcement = computed(() => {
    switch (this.status()) {
      case 'recording':
        return 'Recording';
      case 'paused':
        return 'Recording paused';
      case 'finalizing':
        return 'Transcribing';
      case 'done':
        return 'Transcript ready';
      case 'postponed':
        return 'Transcription put off';
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
    () => this.transcriptBlockedReason() || this.chat.newChatBlockedReason()
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

  private readonly progressTrack = signal<ProgressTrack | null>(null);

  readonly eta = computed(() => {
    const st = this.session()?.status;
    if (st?.state !== 'finalizing') return '';
    if (st.progress >= DIARIZE_START_PROGRESS && st.progress < DIARIZE_DONE_PROGRESS) {
      return 'telling speakers apart';
    }
    if (st.progress >= DECODE_DONE_PROGRESS) return 'almost done';
    const track = this.progressTrack();
    if (!track || track.sessionId !== this.sessionId()) return '';
    const anchor = track.samples[0];
    const latest = track.samples[track.samples.length - 1];
    if (
      latest.progress - anchor.progress < ETA_MIN_MOVED ||
      latest.at - anchor.at < ETA_MIN_ELAPSED_MS
    ) {
      return '';
    }
    const windowed = track.samples.find((s) => latest.at - s.at <= ETA_PACE_WINDOW_MS) ?? anchor;
    const from = latest.at - windowed.at >= ETA_MIN_PACE_SPAN_MS ? windowed : anchor;
    const moved = latest.progress - from.progress;
    if (moved <= 0) return '';
    const leftMs = ((latest.at - from.at) / moved) * (DECODE_DONE_PROGRESS - latest.progress);
    return leftMs < 60_000
      ? 'less than a minute left'
      : `about ${Math.ceil(leftMs / 60_000)} min left`;
  });

  /** The scrollable transcript body. */
  private readonly body = viewChild<ElementRef<HTMLDivElement>>('body');
  /** The title button that opens renaming (focus returns to it afterwards). */
  private readonly renameBtn = viewChild<ElementRef<HTMLButtonElement>>('renameBtn');
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
      this.confirmingDelete.set(false);
      this.openMenu.set(null);
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
      const track = untracked(() => this.progressTrack());
      if (st?.state !== 'finalizing' || st.progress < DECODE_START_PROGRESS) {
        if (track) this.progressTrack.set(null);
        return;
      }
      const sample = { at: Date.now(), progress: st.progress };
      if (!track || track.sessionId !== id) {
        this.progressTrack.set({ sessionId: id, samples: [sample] });
      } else if (sample.progress !== track.samples[track.samples.length - 1].progress) {
        const kept = track.samples.filter(
          (s, i) => i === 0 || s.at >= sample.at - ETA_PACE_WINDOW_MS
        );
        this.progressTrack.set({ ...track, samples: [...kept, sample] });
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

  /**
   * Opens one menu, or closes it when it is already open.
   * @param menu - the menu to toggle.
   */
  toggleMenu(menu: Exclude<OpenMenu, null>): void {
    this.openMenu.set(this.openMenu() === menu ? null : menu);
  }

  /** Closes any open menu. */
  closeMenus(): void {
    this.openMenu.set(null);
  }

  /**
   * Closes the open menu on a click outside the actions row.
   * @param event - any click in the document.
   */
  onDocumentClick(event: MouseEvent): void {
    if (this.openMenu() === null) return;
    const target = event.target as Element | null;
    if (!target?.closest?.('[data-menu-root]')) this.closeMenus();
  }

  /** Shows the delete confirmation. */
  askDelete(): void {
    this.closeMenus();
    this.confirmingDelete.set(true);
  }

  /** Deletes the open recording (audio and transcript) after its confirmation. */
  async remove(): Promise<void> {
    await this.runWorking(async (id) => {
      await this.transcription.delete(id);
      this.confirmingDelete.set(false);
    });
  }

  /** Records a new part onto the open finished recording. */
  async continueRecording(): Promise<void> {
    const s = this.session();
    this.closeMenus();
    if (!s || !this.canContinue()) return;
    try {
      await this.transcription.resumeRecording(s.id, this.transcription.liveTranscriptPreferred());
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
  }

  /** Downloads the high-quality model, for a later Transcribe again. */
  async downloadBestModel(): Promise<void> {
    const best = this.transcription.highQualityModel();
    if (!best) return;
    try {
      await this.transcription.downloadModel(best.key);
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
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

  /** Closes the title field without saving and puts focus back on the title. */
  cancelRename(): void {
    this.renaming.set(false);
    this.focusTitle();
  }

  /**
   * Stores the typed title (blank restores the default name) and closes the field.
   * @param value - the field's text.
   * @param refocus - put focus back on the title (Enter); a blur leaves it where the user clicked.
   */
  async saveTitle(value: string, refocus = false): Promise<void> {
    const s = this.session();
    if (!this.renaming() || !s) return;
    this.renaming.set(false);
    if (refocus) this.focusTitle();
    if (value.trim() === (s.title ?? '').trim()) return;
    try {
      await this.transcription.rename(s.id, value);
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
  }

  /** Puts the running or queued transcription off; the audio waits for Transcribe. */
  async postpone(): Promise<void> {
    await this.runWorking((id) => this.transcription.postpone(id));
  }

  /** Runs the transcription over the recording's audio (failed, put off, or finished). */
  async transcribe(): Promise<void> {
    this.closeMenus();
    await this.runWorking((id) => this.transcription.transcribe(id));
  }

  /** Saves the transcript as Markdown where the user picks. */
  async exportMarkdown(): Promise<void> {
    await this.runWorking((id) => this.transcription.exportMarkdown(id));
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
    this.closeMenus();
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

  /**
   * Runs one backend action on the open recording with `working` set, sending a failure to the
   * parent banner.
   * @param action - the call to make with the open recording's id.
   */
  private async runWorking(action: (id: string) => Promise<unknown>): Promise<void> {
    const s = this.session();
    if (!s) return;
    this.working.set(true);
    try {
      await action(s.id);
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    } finally {
      this.working.set(false);
    }
  }

  /** "Transcribing 45 min of audio" when the model of the pass is not known. */
  private transcribingLabel(): string {
    const length = formatDuration(this.summary()?.duration_secs ?? 0);
    return length ? `Transcribing ${length} of audio` : 'Transcribing';
  }

  /** Moves focus back to the title button once it is rendered again. */
  private focusTitle(): void {
    afterNextRender(
      { write: () => this.renameBtn()?.nativeElement.focus() },
      { injector: this.injector }
    );
  }

  /** Why the transcript itself cannot go to a chat yet ('' when it can). */
  private transcriptBlockedReason(): string {
    switch (this.status()) {
      case 'recording':
      case 'paused':
        return 'Stop the recording first';
      case 'finalizing':
        return 'Available when the transcript is ready.';
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
