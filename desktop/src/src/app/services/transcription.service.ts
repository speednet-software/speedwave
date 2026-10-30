import { Injectable, computed, inject, signal, type Signal } from '@angular/core';
import { type UnlistenFn } from '@tauri-apps/api/event';

import type {
  AudioSource,
  AudioSourceInfo,
  AudioSourceKind,
  CaptureWarning,
  DownloadProgress,
  Language,
  MicPermission,
  MicPermissionStatus,
  ModelsAck,
  RecommendedModelAck,
  RecommendedModelEntry,
  StartAck,
  SubscribeAck,
  TranscriptEvent,
  TranscriptSession,
  TranscriptSummary,
} from '../models/transcript';
import { effectiveSegments, isSessionOngoing } from '../models/transcript';
import { recordingName } from '../meeting-transcription/recording-format';
import {
  normalizeSpeakerName,
  speakersOf,
  uniqueSpeakerNames,
} from '../meeting-transcription/speaker-names';
import { ChatStateService } from './chat-state.service';
import { TauriService } from './tauri.service';
import { LoggerService } from './logger.service';

/** Event name the Rust backend emits per model-download progress update. */
const MODEL_PROGRESS_EVENT = 'transcription_model_status';

/** Poll interval for detecting completion of a download this webview did not itself start. */
const RESUMED_DOWNLOAD_POLL_MS = 2000;

/**
 * localStorage key for the live-transcript preference (only `'on'` turns it on). The `-v2` key
 * resets every earlier choice once, since live text went from default-on to opt-in.
 */
export const LIVE_TRANSCRIPT_STORAGE_KEY = 'speedwave-live-transcript-v2';

/** Pre-`-v2` key, removed on first use so a stale default-on pick does not linger. */
const LEGACY_LIVE_TRANSCRIPT_STORAGE_KEY = 'speedwave-live-transcript';

const SPEAKER_ATTRIBUTION_STORAGE_KEY = 'speedwave-speaker-attribution';

/** localStorage key of the user's own name, used instead of "You" in exports and in chats. */
const YOUR_NAME_STORAGE_KEY = 'speedwave-your-name';

/** localStorage key set once the user was asked for their name before a first export. */
const YOUR_NAME_ASKED_STORAGE_KEY = 'speedwave-your-name-asked';

/** localStorage key of the language, source and microphone the last recording used. */
export const RECORDING_CHOICE_STORAGE_KEY = 'speedwave-recording-choice';

/** What the next recording starts with, remembered from the last one. */
export interface RecordingChoice {
  language: Language;
  source: AudioSourceKind;
  mic: string | null;
}

/** App-wide event the backend emits when a recordings-list row changes (Rust `TRANSCRIPTS_CHANGED_EVENT`). */
const TRANSCRIPTS_CHANGED_EVENT = 'transcripts_changed';

/** Where a transcript send lands: a fresh conversation, or the one on screen. */
export type SendTarget = 'new-chat' | 'current-chat';

/** Default prompt loaded into the chat composer with a staged transcript, per session language. */
const TRANSCRIPT_PROMPT_DEFAULTS: Record<Language, string> = {
  pl:
    'W załączniku transkrypt spotkania. Przygotuj zwięzłe podsumowanie: najważniejsze wątki, ' +
    'podjęte decyzje i listę zadań (kto, co, na kiedy — jeśli padło). ' +
    'Transkrypt może zawierać błędy rozpoznawania mowy; niejasne fragmenty oznacz.',
  en:
    'Attached is a meeting transcript. Write a concise summary: key topics, decisions made, ' +
    'and an action item list (who, what, by when — where stated). ' +
    'The transcript may contain speech-recognition errors; flag unclear fragments.',
};

const SPEAKER_LABELS_PROMPT: Record<Language, string> = {
  pl:
    " Etykiety 'Speaker N' są przybliżone; imiona przypisuj tylko na podstawie treści " +
    'i zaznacz niepewne przypisania.',
  en:
    " 'Speaker N' labels are approximate; assign names only on evidence in the text " +
    'and flag uncertain attributions.',
};

const NAMED_SPEAKERS_PROMPT: Record<
  Language,
  {
    named: (names: string) => string;
    one: (label: string) => string;
    many: (labels: string) => string;
    approximate: string;
  }
> = {
  pl: {
    named: (names) => ` Imiona mówców (${names}) podał użytkownik: traktuj je jako pewne.`,
    one: (label) => ` ${label} nie ma imienia; nazywaj tę osobę tą etykietą i nie zgaduj imienia.`,
    many: (labels) =>
      ` ${labels} nie mają imion; nazywaj te osoby ich etykietami i nie zgaduj imion.`,
    approximate:
      ' Etykiety są przybliżone: jedna osoba może dostać dwie etykiety, a jedna etykieta może ' +
      'objąć dwie osoby.',
  },
  en: {
    named: (names) => ` Speaker names (${names}) were set by the user: treat them as certain.`,
    one: (label) =>
      ` ${label} is unnamed; refer to that speaker by the label and do not guess a name.`,
    many: (labels) =>
      ` ${labels} are unnamed; refer to them by their labels and do not guess names.`,
    approximate:
      ' Labels are approximate: one person can get two labels and one label can cover two people.',
  },
};

/**
 * What the chat prompt says about the speaker labels of a diarized transcript: the user's names
 * as certain and no guessing for the rest, or, with no speaker named, names only on evidence.
 * @param session - the diarized session.
 * @param yourName - the user's own name, '' when not set.
 */
function speakerLabelsPrompt(session: TranscriptSession, yourName: string): string {
  const segments = effectiveSegments(session);
  const speakers = speakersOf(segments, session.named_speakers ?? {});
  const named = speakers.flatMap((s) => (s.name ? [s.name] : []));
  if (named.length === 0) return SPEAKER_LABELS_PROMPT[session.language];
  const own = yourName && segments.some((seg) => seg.source === 'mic') ? [yourName] : [];
  const unnamed = speakers
    .filter((s) => !s.name)
    .sort((a, b) => a.id - b.id)
    .map((s) => s.label);
  const text = NAMED_SPEAKERS_PROMPT[session.language];
  return (
    text.named(uniqueSpeakerNames([...own, ...named]).join(', ')) +
    unnamedSentence(text, unnamed) +
    text.approximate
  );
}

/**
 * The sentence that tells the model not to guess names for the unnamed labels; '' without any.
 * @param text - the prompt texts of the session's language.
 * @param unnamed - the labels of the unnamed speakers.
 */
function unnamedSentence(
  text: (typeof NAMED_SPEAKERS_PROMPT)[Language],
  unnamed: string[]
): string {
  if (unnamed.length === 0) return '';
  if (unnamed.length === 1) return text.one(unnamed[0]);
  return text.many(unnamed.join(', '));
}

/**
 * Reads one localStorage key, tolerating a storage that throws.
 * @param key - the key.
 * @param onFailure - what to read when storage throws.
 */
function readStored(key: string, onFailure: string | null = null): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return onFailure;
  }
}

/**
 * Writes one localStorage key, or removes it for null, ignoring a storage that throws.
 * @param key - the key.
 * @param value - the value, or null to remove the key.
 */
function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

const sameJson = <T>(a: T, b: T): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Meeting-transcription state + Tauri-command facade. Mirrors ADR-056 snapshot+seq delivery:
 * `subscribeToTranscript` applies a snapshot, then applies events with `seq > lastSeq`.
 */
@Injectable({ providedIn: 'root' })
export class TranscriptionService {
  private readonly tauri = inject(TauriService);
  private readonly chatState = inject(ChatStateService);
  private readonly log = inject(LoggerService);

  private readonly activeSignal = signal<TranscriptSession | null>(null);
  private lastSeq = 0;
  private patchUnlisten: UnlistenFn | null = null;
  private recordingUnlisten: UnlistenFn | null = null;
  private recordingSeq = 0;

  private readonly downloadingModelKeySignal = signal<string | null>(null);
  private readonly downloadProgressSignal = signal<DownloadProgress | null>(null);
  private downloadUnlisten: UnlistenFn | null = null;
  private downloadPollTimer: ReturnType<typeof setInterval> | undefined;
  private readonly recordingSessionIdSignal = signal<string | null>(null);
  private readonly recordingSourceSignal = signal<AudioSource | null>(null);
  private readonly recordingLanguageSignal = signal<Language | null>(null);
  private readonly recordingLiveSignal = signal<boolean | null>(null);
  private readonly recordingStartedAtSignal = signal<number | null>(null);
  private readonly liveDraftSignal = signal<string>('');
  private readonly audioLevelsSignal = signal<number[] | null>(null);
  private readonly recordingWarningsSignal = signal<readonly CaptureWarning[]>([]);
  private readonly recommendedSignal = signal<RecommendedModelAck | null>(null, {
    equal: sameJson,
  });
  private recommendedReads = 0;
  private readonly modelReadySignal = signal<boolean | null>(null);
  private modelReadyReads = 0;
  private readonly recordingsSignal = signal<TranscriptSummary[]>([]);
  private readonly recordingsErrorSignal = signal('');
  private recordingsUnlisten: UnlistenFn | null = null;
  private recordingsRefresh: Promise<void> | null = null;
  private recordingsStale = false;

  /** Current session (live snapshot updated by incoming events). */
  readonly active: Signal<TranscriptSession | null> = this.activeSignal.asReadonly();

  /**
   * Session id of the in-progress recording — service-level so it survives the
   * record tab being destroyed on navigation (the backend driver keeps going).
   */
  readonly recordingSessionId: Signal<string | null> = this.recordingSessionIdSignal.asReadonly();

  readonly recording: Signal<boolean> = computed(() => this.recordingSessionIdSignal() !== null);

  /** The paused recording, from the list, so it is found again after a restart; null when none. */
  readonly pausedRecording: Signal<TranscriptSummary | null> = computed(
    () => this.recordingsSignal().find((r) => r.status.state === 'paused') ?? null
  );

  /** A recording is capturing or paused: it still owns the recording bar and its controls. */
  readonly captureOpen: Signal<boolean> = computed(
    () => this.recording() || this.pausedRecording() !== null
  );

  /** Whether the shown session can still change, so its event stream must stay attached. */
  readonly liveStreamNeeded: Signal<boolean> = computed(() => {
    const status = this.activeSignal()?.status;
    return status !== undefined && isSessionOngoing(status);
  });

  /** Recordings being transcribed or waiting their turn, newest first. */
  readonly transcribing: Signal<TranscriptSummary[]> = computed(() =>
    this.recordingsSignal().filter((r) => r.status.state === 'finalizing')
  );

  /**
   * The model a high-quality transcript is made with on this machine, with its download state;
   * null until {@link loadRecommendedModel} has read it.
   */
  readonly highQualityModel: Signal<RecommendedModelEntry | null> = computed(() => {
    const ack = this.recommendedSignal();
    return ack ? (ack.finalize ?? ack.live) : null;
  });

  readonly recommended: Signal<RecommendedModelAck | null> = this.recommendedSignal.asReadonly();

  readonly modelReady: Signal<boolean | null> = this.modelReadySignal.asReadonly();

  /**
   * Source/language of the in-progress recording — service-level so a remounted
   * `RecordingControlsComponent` can restore its picker selection instead of showing defaults.
   */
  readonly recordingSource: Signal<AudioSource | null> = this.recordingSourceSignal.asReadonly();
  readonly recordingLanguage: Signal<Language | null> = this.recordingLanguageSignal.asReadonly();

  /**
   * How the in-flight recording actually started, from the host's `models_used.live`; `null` when
   * nothing is recording, or when a failed start's rollback left the mode unknown.
   */
  readonly recordingLive: Signal<boolean | null> = this.recordingLiveSignal.asReadonly();

  /** `Date.now()` when the in-flight recording (or its resumed part) started; null otherwise. */
  readonly recordingStartedAt: Signal<number | null> = this.recordingStartedAtSignal.asReadonly();

  /** Every recording on disk, newest first; kept current by the backend's change events. */
  readonly recordings: Signal<TranscriptSummary[]> = this.recordingsSignal.asReadonly();

  /** Why the last recordings-list read failed ('' after a good read). */
  readonly recordingsError: Signal<string> = this.recordingsErrorSignal.asReadonly();

  /**
   * Capture warnings to show: those of the running recording, whichever recording is open, plus
   * any the open one still carries.
   */
  readonly captureWarnings: Signal<readonly CaptureWarning[]> = computed(() => {
    const open = this.activeSignal();
    const recordingId = this.recordingSessionIdSignal();
    const fromOpen = open && open.id !== recordingId ? (open.active_warnings ?? []) : [];
    const fromRecording =
      recordingId === null
        ? []
        : open?.id === recordingId
          ? (open.active_warnings ?? [])
          : this.recordingWarningsSignal();
    return [...new Set([...fromRecording, ...fromOpen])];
  });

  /** Uncommitted tail of the latest live decode ('' = none); replace-only. */
  readonly liveDraft: Signal<string> = this.liveDraftSignal.asReadonly();

  /** Latest per-channel capture RMS ([system, mic] or one entry; null until the first `audio_level` event of a recording). */
  readonly audioLevels: Signal<number[] | null> = this.audioLevelsSignal.asReadonly();

  /**
   * Download-in-flight key — service-level so it survives component remounts.
   */
  readonly downloadingModelKey: Signal<string | null> = this.downloadingModelKeySignal.asReadonly();

  /** Latest progress payload for the in-flight download (null before first). */
  readonly downloadProgress: Signal<DownloadProgress | null> =
    this.downloadProgressSignal.asReadonly();

  /** Drops the pre-`-v2` live-transcript key so its stored choice never applies again. */
  constructor() {
    writeStored(LEGACY_LIVE_TRANSCRIPT_STORAGE_KEY, null);
  }

  /** Whether the next recording should show live text while it records; off unless the user opted in. */
  liveTranscriptPreferred(): boolean {
    return readStored(LIVE_TRANSCRIPT_STORAGE_KEY) === 'on';
  }

  /**
   * Persists the live-transcript choice (tolerates private-mode/quota failures).
   * @param live - the user's pick.
   */
  setLiveTranscriptPreferred(live: boolean): void {
    writeStored(LIVE_TRANSCRIPT_STORAGE_KEY, live ? 'on' : 'off');
  }

  /** Whether the offline pass tells meeting speakers apart; off unless the user turned it on. */
  speakerAttribution(): boolean {
    return readStored(SPEAKER_ATTRIBUTION_STORAGE_KEY) === 'on';
  }

  /**
   * Persists the speaker-attribution choice for the next offline pass (tolerates storage failures).
   * @param on - the user's pick.
   */
  setSpeakerAttribution(on: boolean): void {
    writeStored(SPEAKER_ATTRIBUTION_STORAGE_KEY, on ? 'on' : 'off');
  }

  /** The user's own name for exports and chats; '' when not set. */
  yourName(): string {
    return readStored(YOUR_NAME_STORAGE_KEY) ?? '';
  }

  /**
   * Stores the user's own name (tolerates storage failures); a blank one removes it.
   * @param name - the name as typed.
   * @returns the stored name, '' when removed.
   */
  setYourName(name: string): string {
    const stored = normalizeSpeakerName(name);
    writeStored(YOUR_NAME_STORAGE_KEY, stored || null);
    return stored;
  }

  /** Whether the user was already asked for their name before an export. */
  yourNameAsked(): boolean {
    return readStored(YOUR_NAME_ASKED_STORAGE_KEY, 'yes') === 'yes';
  }

  /** Records that the user was asked for their name, so the question comes once. */
  markYourNameAsked(): void {
    writeStored(YOUR_NAME_ASKED_STORAGE_KEY, 'yes');
  }

  /** The language, source and microphone the last recording used; null when none is stored. */
  recordingChoice(): RecordingChoice | null {
    const raw = readStored(RECORDING_CHOICE_STORAGE_KEY);
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as Partial<RecordingChoice>;
      if (v.language !== 'pl' && v.language !== 'en') return null;
      if (v.source !== 'system_wide' && v.source !== 'microphone' && v.source !== 'mixed') {
        return null;
      }
      return {
        language: v.language,
        source: v.source,
        mic: typeof v.mic === 'string' ? v.mic : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Remembers the choice for the next recording (tolerates private-mode/quota failures).
   * @param choice - language, source kind and microphone as picked.
   */
  setRecordingChoice(choice: RecordingChoice): void {
    writeStored(RECORDING_CHOICE_STORAGE_KEY, JSON.stringify(choice));
  }

  /** Audio sources the user can pick from (depends on host + capabilities). */
  listAudioSources(): Promise<AudioSourceInfo[]> {
    return this.tauri.invoke<AudioSourceInfo[]>('list_audio_sources');
  }

  /**
   * Starts recording the given source, then subscribes to its live stream.
   * @param source - what to capture (system / mic / mixed).
   * @param language - forced PL/EN; never auto-detected.
   * @param live - false = record-only (no live pass; transcript arrives after stop).
   */
  async startRecording(source: AudioSource, language: Language, live: boolean): Promise<StartAck> {
    const ack = await this.tauri.invoke<StartAck>('start_transcription', {
      params: { source, language, live },
    });
    return this.applyStartAck(ack, source, language, 0);
  }

  /**
   * Asks the host for an audio file and transcribes it like a stopped recording, with speaker
   * labels when the Settings switch is on.
   * @param language - forced PL/EN the file is transcribed in.
   * @returns the new recording's id, or null when the file picker was closed.
   */
  importFile(language: Language): Promise<string | null> {
    return this.tauri.invoke<string | null>('import_transcription', {
      language,
      speakerMode: this.speakerAttribution(),
    });
  }

  /**
   * Resumes a finished or paused recording: a new part appends to the same transcript, and the
   * clock goes on from the length already recorded.
   * @param sessionId - the Done or Paused session to reopen.
   * @param live - false = record-only (no live pass; transcript arrives after stop).
   */
  async resumeRecording(sessionId: string, live: boolean): Promise<StartAck> {
    const recordedSecs = this.recordingsSignal().find((r) => r.id === sessionId)?.duration_secs;
    const ack = await this.tauri.invoke<StartAck>('resume_transcription', { sessionId, live });
    return this.applyStartAck(
      ack,
      ack.snapshot.audio_source.source,
      ack.snapshot.language,
      recordedSecs ?? 0
    );
  }

  /**
   * Pauses the running recording: the capture ends and the microphone is released; the session
   * waits as paused for {@link resumeRecording} or {@link stopRecording}.
   * @param sessionId - the recording to pause.
   */
  async pauseRecording(sessionId: string): Promise<void> {
    try {
      await this.tauri.invoke<void>('pause_transcription', { sessionId });
    } finally {
      this.clearInProgressRecording(sessionId);
    }
    await this.refreshRecordings();
  }

  /**
   * Applies a start/resume ack: snapshot, live listeners, recording signals.
   * @param ack - the backend acknowledgement to apply.
   * @param source - the capture source now recording.
   * @param language - the forced language now recording.
   * @param recordedSecs - audio the session already holds, where the clock starts.
   */
  private async applyStartAck(
    ack: StartAck,
    source: AudioSource,
    language: Language,
    recordedSecs: number
  ): Promise<StartAck> {
    this.activateSnapshot(ack.snapshot);
    try {
      await this.attachListener(ack.event_name);
      await this.attachRecordingListener(ack.event_name, ack.snapshot);
    } catch (e) {
      try {
        await this.tauri.invoke<void>('stop_transcription', {
          sessionId: ack.session_id,
          speakerMode: this.speakerAttribution(),
        });
        this.resetInProgressRecording();
      } catch {
        this.recordingSessionIdSignal.set(ack.session_id);
      }
      throw e;
    }
    this.recordingSessionIdSignal.set(ack.session_id);
    this.recordingSourceSignal.set(source);
    this.recordingLanguageSignal.set(language);
    this.recordingLiveSignal.set(ack.snapshot.models_used.live != null);
    this.recordingStartedAtSignal.set(Date.now() - Math.max(0, recordedSecs) * 1000);
    return ack;
  }

  /**
   * Signals the driver to stop and transition to the offline pass.
   * @param sessionId - the recording to stop.
   */
  async stopRecording(sessionId: string): Promise<void> {
    try {
      await this.tauri.invoke<void>('stop_transcription', {
        sessionId,
        speakerMode: this.speakerAttribution(),
      });
    } finally {
      this.clearInProgressRecording(sessionId);
    }
  }

  /**
   * Re-attaches the open recording's event stream after the view was destroyed and recreated
   * (the driver or the offline pass kept going); opens the running recording when none is open.
   */
  async resumeActiveRecording(): Promise<void> {
    const id = this.activeSignal()?.id ?? this.recordingSessionIdSignal();
    if (id && !this.patchUnlisten) await this.subscribeToTranscript(id);
  }

  /**
   * Subscribes to an existing session's snapshot + live event stream. A running recording keeps
   * its own listener, so any other recording can be opened meanwhile.
   * @param sessionId - the session to attach to.
   */
  async subscribeToTranscript(sessionId: string): Promise<SubscribeAck> {
    const ack = await this.tauri.invoke<SubscribeAck>('subscribe_transcript', { sessionId });
    this.activateSnapshot(ack.snapshot);
    await this.attachListener(ack.event_name);
    return ack;
  }

  /** Stops listening for events on the current session (the snapshot stays). */
  async detach(): Promise<void> {
    if (this.patchUnlisten) {
      try {
        this.patchUnlisten();
      } catch (e) {
        this.log.warn(`transcription detach failed: ${String(e)}`);
      }
      this.patchUnlisten = null;
    }
  }

  /**
   * Starts following the backend's change events (once per app run) and reads the list now.
   * The list is never polled: every create, rename, delete, status or progress change re-reads it.
   */
  async watchRecordings(): Promise<void> {
    if (!this.recordingsUnlisten) {
      this.recordingsUnlisten = await this.tauri.listen<string>(TRANSCRIPTS_CHANGED_EVENT, () => {
        void this.refreshRecordings();
      });
    }
    await this.refreshRecordings();
  }

  /** Re-reads the recordings list; calls during a read coalesce into one follow-up read. */
  refreshRecordings(): Promise<void> {
    if (this.recordingsRefresh) {
      this.recordingsStale = true;
      return this.recordingsRefresh;
    }
    this.recordingsRefresh = (async () => {
      do {
        this.recordingsStale = false;
        try {
          this.recordingsSignal.set(
            await this.tauri.invoke<TranscriptSummary[]>('list_transcripts')
          );
          this.recordingsErrorSignal.set('');
        } catch (e) {
          this.recordingsErrorSignal.set(e instanceof Error ? e.message : String(e));
        }
      } while (this.recordingsStale);
      this.recordingsRefresh = null;
    })();
    return this.recordingsRefresh;
  }

  /**
   * Renames a recording; a blank title restores the default name.
   * @param sessionId - the recording to rename.
   * @param title - the new title as typed.
   * @returns the title the backend stored (normalised), or null when cleared.
   */
  async rename(sessionId: string, title: string): Promise<string | null> {
    const stored = await this.tauri.invoke<string | null>('rename_transcript', {
      sessionId,
      title,
    });
    const cur = this.activeSignal();
    if (cur?.id === sessionId) this.activeSignal.set({ ...cur, title: stored });
    this.recordingsSignal.update((list) =>
      list.map((r) => (r.id === sessionId ? { ...r, title: stored } : r))
    );
    return stored;
  }

  /**
   * Names a speaker of a recording's transcript; a blank name takes the name away. The open
   * session takes the stored name only while it still shows the transcript the name was given for.
   * @param sessionId - the recording.
   * @param speaker - the speaker number.
   * @param name - the name as typed.
   * @returns the name the backend stored, or null when taken away.
   */
  async renameSpeaker(sessionId: string, speaker: number, name: string): Promise<string | null> {
    const transcript = this.activeSignal()?.final_segments;
    const stored = await this.tauri.invoke<string | null>('rename_speaker', {
      sessionId,
      speaker,
      name,
    });
    const cur = this.activeSignal();
    if (cur?.id === sessionId && cur.final_segments === transcript) {
      const named = { ...cur.named_speakers };
      if (stored === null) delete named[String(speaker)];
      else named[String(speaker)] = stored;
      this.activeSignal.set({ ...cur, named_speakers: named });
    }
    return stored;
  }

  /**
   * Puts off a running or queued transcription so it stops using the processor; the recording
   * waits as `postponed` until {@link transcribe}. A running pass loses its progress.
   * @param sessionId - the recording whose transcription to put off.
   */
  postpone(sessionId: string): Promise<void> {
    return this.tauri.invoke<void>('postpone_transcription', { sessionId });
  }

  /**
   * Runs the transcription again over a failed, put-off or finished recording's audio, then
   * re-attaches the open pane to it so the progress shows.
   * @param sessionId - the recording to transcribe.
   */
  async transcribe(sessionId: string): Promise<void> {
    await this.tauri.invoke<void>('transcribe_transcript', {
      sessionId,
      speakerMode: this.speakerAttribution(),
    });
    if (this.activeSignal()?.id === sessionId) await this.subscribeToTranscript(sessionId);
  }

  /**
   * Saves the transcript as Markdown where the user picks, with the user's name on their lines.
   * @param sessionId - the recording to export.
   * @returns false when the user cancelled the save dialog.
   */
  exportMarkdown(sessionId: string): Promise<boolean> {
    return this.tauri.invoke<boolean>('export_transcript', {
      sessionId,
      yourName: this.yourName() || null,
    });
  }

  /**
   * Shows the recording's audio file in Finder or Explorer.
   * @param sessionId - the recording to reveal.
   */
  revealAudio(sessionId: string): Promise<void> {
    return this.tauri.invoke<void>('reveal_transcript_audio', { sessionId });
  }

  /**
   * Loads a single session by id.
   * @param sessionId - the session to load.
   */
  get(sessionId: string): Promise<TranscriptSession> {
    return this.tauri.invoke<TranscriptSession>('get_transcript', { sessionId });
  }

  /**
   * Deletes a session directory (audio + transcript); clears the shown session if it was this one.
   * @param sessionId - the session to delete.
   */
  async delete(sessionId: string): Promise<void> {
    await this.tauri.invoke<void>('delete_transcript', { sessionId });
    this.recordingsSignal.update((list) => list.filter((r) => r.id !== sessionId));
    if (this.activeSignal()?.id !== sessionId) return;
    await this.detach();
    this.activeSignal.set(null);
  }

  /**
   * Renders the session as a timestamped markdown transcript, with the user's name on their lines.
   * @param sessionId - the session to render.
   */
  getMarkdown(sessionId: string): Promise<string> {
    return this.tauri.invoke<string>('get_transcript_markdown', {
      sessionId,
      yourName: this.yourName() || null,
    });
  }

  /**
   * Stages the transcript for the chat composer: the default prompt goes into the text field, the
   * markdown rides along with whatever the user sends next.
   * @param sessionId - the session to stage.
   * @param target - `'new-chat'` (default) opens a new chat first; `'current-chat'` keeps the tab that was active.
   */
  async stageForChat(sessionId: string, target: SendTarget = 'new-chat'): Promise<void> {
    const originTabId = this.chatState.activeTabId();
    const [session, md] = await Promise.all([this.get(sessionId), this.getMarkdown(sessionId)]);
    const tabId =
      target === 'new-chat' ? await this.chatState.openNewChat(originTabId) : originTabId;
    const store = this.chatState.claimTab(tabId);
    store.stageTranscript({ markdown: md, name: recordingName(session) });
    store.composerPromptDraft.set(
      TRANSCRIPT_PROMPT_DEFAULTS[session.language] +
        (session.models_used.diarization ? speakerLabelsPrompt(session, this.yourName()) : '')
    );
  }

  /** The single best model for this hardware + its download state. */
  recommendedModel(): Promise<RecommendedModelAck> {
    return this.tauri.invoke<RecommendedModelAck>('recommended_transcription_model');
  }

  /**
   * Reads the recommended models into {@link recommended} and returns them; a failure keeps the
   * last read and rethrows, and a read overtaken by a newer one writes nothing.
   */
  async loadRecommendedModel(): Promise<RecommendedModelAck> {
    const read = ++this.recommendedReads;
    const ack = await this.recommendedModel();
    if (read === this.recommendedReads) this.recommendedSignal.set(ack);
    return ack;
  }

  /** Status of all Whisper models on disk. */
  listModels(): Promise<ModelsAck> {
    return this.tauri.invoke<ModelsAck>('list_transcription_models');
  }

  /** Re-reads {@link modelReady}; a read error fails open so the gate never locks a working setup out. */
  async refreshModelReady(): Promise<void> {
    const read = ++this.modelReadyReads;
    let ready: boolean;
    try {
      ready = (await this.listModels()).whisper.some((m) => m.downloaded);
    } catch (e) {
      this.log.warn(`model-availability check failed: ${String(e)}`);
      ready = true;
    }
    if (read === this.modelReadyReads) this.modelReadySignal.set(ready);
  }

  /** Re-reads {@link recommended} and {@link modelReady} together; neither read's failure rejects. */
  async refreshModelState(): Promise<void> {
    await Promise.all([
      this.loadRecommendedModel().catch((e) =>
        this.log.warn(`recommended-model read failed: ${String(e)}`)
      ),
      this.refreshModelReady(),
    ]);
  }

  /**
   * Starts a model download tracked in the service signals (backend enforces single-flight per
   * model; the local guard just fails fast).
   * @param modelId - catalogue key.
   */
  async downloadModel(modelId: string): Promise<void> {
    if (this.downloadingModelKeySignal() !== null) {
      throw new Error(`a model download is already in progress`);
    }
    try {
      await this.beginDownloadTracking(modelId);
      await this.tauri.invoke<void>('download_transcription_model', { modelId });
      await this.refreshModelState();
    } finally {
      this.clearDownloadTracking();
    }
  }

  /**
   * Re-attaches progress tracking to a download the backend reports as still running (webview
   * reloaded mid-download), then polls until it settles since no owning caller will clear it.
   * @param modelId - catalogue key the backend flagged as `downloading`.
   */
  async resumeDownloadTracking(modelId: string): Promise<void> {
    if (this.downloadingModelKeySignal() === modelId) return;
    await this.beginDownloadTracking(modelId);
    this.stopDownloadPoll();
    this.downloadPollTimer = setInterval(
      () => void this.pollResumedDownload(modelId),
      RESUMED_DOWNLOAD_POLL_MS
    );
  }

  private async pollResumedDownload(modelId: string): Promise<void> {
    if (this.downloadingModelKeySignal() !== modelId) {
      this.stopDownloadPoll();
      return;
    }
    try {
      const ack = await this.loadRecommendedModel();
      const entry = [ack.live, ack.finalize, ack.diarization].find((e) => e?.key === modelId);
      if (entry && !entry.downloading) {
        this.stopDownloadPoll();
        await this.refreshModelReady();
        this.clearDownloadTracking();
      }
    } catch (e) {
      this.log.warn(`resumed download poll failed: ${String(e)}`);
    }
  }

  private stopDownloadPoll(): void {
    if (this.downloadPollTimer !== undefined) {
      clearInterval(this.downloadPollTimer);
      this.downloadPollTimer = undefined;
    }
  }

  /** Drops download tracking (used when the backend no longer reports one). */
  clearDownloadTracking(): void {
    this.stopDownloadPoll();
    if (this.downloadUnlisten) {
      try {
        this.downloadUnlisten();
      } catch (e) {
        this.log.warn(`download progress unlisten failed: ${String(e)}`);
      }
      this.downloadUnlisten = null;
    }
    this.downloadingModelKeySignal.set(null);
    this.downloadProgressSignal.set(null);
  }

  private async beginDownloadTracking(modelId: string): Promise<void> {
    this.clearDownloadTracking();
    this.downloadingModelKeySignal.set(modelId);
    this.downloadUnlisten = await this.tauri.listen<DownloadProgress>(MODEL_PROGRESS_EVENT, (e) => {
      if (e.payload.model_key === modelId) this.downloadProgressSignal.set(e.payload);
    });
  }

  /**
   * Deletes a downloaded model.
   * @param modelId - catalogue key.
   */
  async deleteModel(modelId: string): Promise<void> {
    await this.tauri.invoke<void>('delete_transcription_model', { modelId });
    await this.refreshModelState();
  }

  /**
   * Resolves mic consent in-process (main-app TCC identity); macOS shows the
   * prompt when undetermined, other platforms always report granted.
   */
  requestMicrophonePermission(): Promise<MicPermission> {
    return this.tauri.invoke<MicPermission>('request_microphone_permission');
  }

  /** Mic-consent state for the Settings panel — never shows a prompt. */
  microphonePermissionStatus(): Promise<MicPermissionStatus> {
    return this.tauri.invoke<MicPermissionStatus>('microphone_permission_status');
  }

  /** Opens the macOS System Settings → Privacy → Microphone pane (no-op elsewhere). */
  openMicrophonePrivacyPane(): Promise<void> {
    return this.tauri.invoke<void>('open_microphone_pane');
  }

  /** Opens the macOS System Settings → Privacy → Audio Recording pane (no-op elsewhere). */
  openAudioCapturePrivacyPane(): Promise<void> {
    return this.tauri.invoke<void>('open_audio_capture_pane');
  }

  /**
   * Applies a freshly-received snapshot (resets lastSeq). Keeps the live draft when
   * re-subscribing to the same in-progress recording — the snapshot never carries one.
   * @param snapshot - server-supplied current state.
   */
  private activateSnapshot(snapshot: TranscriptSession): void {
    this.lastSeq = snapshot.last_seq ?? 0;
    if (snapshot.id !== this.recordingSessionIdSignal()) {
      this.liveDraftSignal.set('');
    } else if (snapshot.status.state !== 'recording') {
      this.liveDraftSignal.set('');
      this.clearInProgressRecording(snapshot.id);
    }
    this.activeSignal.set(snapshot);
  }

  private async attachListener(eventName: string): Promise<void> {
    await this.detach();
    this.patchUnlisten = await this.tauri.listen<TranscriptEvent>(eventName, (e) => {
      this.applyEvent(e.payload);
    });
  }

  /**
   * Follows the running recording on its own channel, whichever recording the pane shows: its
   * loudness, its capture warnings, and the status change that ends the capture.
   * @param eventName - the recording's event channel.
   * @param snapshot - the recording's state at start.
   */
  private async attachRecordingListener(
    eventName: string,
    snapshot: TranscriptSession
  ): Promise<void> {
    this.dropRecordingListener();
    this.recordingSeq = snapshot.last_seq ?? 0;
    this.recordingWarningsSignal.set(snapshot.active_warnings ?? []);
    this.recordingUnlisten = await this.tauri.listen<TranscriptEvent>(eventName, (e) => {
      this.applyRecordingEvent(snapshot.id, e.payload);
    });
  }

  /**
   * Applies one event of the running recording's channel.
   * @param sessionId - the recording the listener was attached for.
   * @param ev - incoming event.
   */
  private applyRecordingEvent(sessionId: string, ev: TranscriptEvent): void {
    if (ev.seq <= this.recordingSeq) return;
    this.recordingSeq = ev.seq;
    switch (ev.kind) {
      case 'audio_level':
        this.audioLevelsSignal.set(ev.levels);
        break;
      case 'capture_warning':
        this.recordingWarningsSignal.update((w) =>
          w.includes(ev.warning) ? w : [...w, ev.warning]
        );
        break;
      case 'capture_warning_cleared':
        this.recordingWarningsSignal.update((w) => w.filter((x) => x !== ev.warning));
        break;
      case 'status_changed':
        if (ev.status.state !== 'recording') this.clearInProgressRecording(sessionId);
        break;
      case 'finished':
        this.clearInProgressRecording(sessionId);
        break;
      default:
        break;
    }
  }

  private dropRecordingListener(): void {
    if (this.recordingUnlisten) {
      try {
        this.recordingUnlisten();
      } catch (e) {
        this.log.warn(`recording listener detach failed: ${String(e)}`);
      }
      this.recordingUnlisten = null;
    }
  }

  private clearInProgressRecording(sessionId: string): void {
    if (this.recordingSessionIdSignal() !== sessionId) return;
    this.resetInProgressRecording();
  }

  private resetInProgressRecording(): void {
    this.dropRecordingListener();
    this.recordingSessionIdSignal.set(null);
    this.recordingSourceSignal.set(null);
    this.recordingLanguageSignal.set(null);
    this.recordingLiveSignal.set(null);
    this.recordingStartedAtSignal.set(null);
    this.audioLevelsSignal.set(null);
    this.recordingWarningsSignal.set([]);
  }

  /**
   * Idempotent event application: ignores `seq <= lastSeq` (already captured via the snapshot path).
   * @param ev - incoming event.
   */
  applyEvent(ev: TranscriptEvent): void {
    if (ev.seq <= this.lastSeq) return;
    const cur = this.activeSignal();
    if (!cur) return;
    const next: TranscriptSession = { ...cur, last_seq: ev.seq };
    switch (ev.kind) {
      case 'segment_appended':
        next.live_segments = [...cur.live_segments, ev.segment];
        break;
      case 'live_draft':
        this.liveDraftSignal.set(ev.text);
        break;
      case 'status_changed':
        next.status = ev.status;
        if (ev.status.state !== 'recording') {
          this.liveDraftSignal.set('');
          this.clearInProgressRecording(cur.id);
        }
        break;
      case 'finalize_progress':
        next.status = { state: 'finalizing', progress: ev.progress };
        break;
      case 'final_segments_ready':
        next.final_segments = ev.segments;
        next.named_speakers = {};
        next.previous_speaker_names = ev.previous_speaker_names;
        break;
      case 'finished':
        next.status = { state: 'done' };
        this.liveDraftSignal.set('');
        this.clearInProgressRecording(cur.id);
        break;
      case 'capture_warning': {
        const raised = next.active_warnings ?? [];
        next.active_warnings = raised.includes(ev.warning) ? raised : [...raised, ev.warning];
        break;
      }
      case 'capture_warning_cleared':
        next.active_warnings = (next.active_warnings ?? []).filter((w) => w !== ev.warning);
        break;
    }
    this.lastSeq = ev.seq;
    this.activeSignal.set(next);
  }
}
