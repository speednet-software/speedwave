import { Injectable, inject, signal, type Signal } from '@angular/core';
import { type UnlistenFn } from '@tauri-apps/api/event';

import type {
  AudioSource,
  CapabilitiesAck,
  AudioSourceInfo,
  GpuClass,
  CaptureWarning,
  DownloadProgress,
  Language,
  MicPermission,
  MicPermissionStatus,
  ModelsAck,
  RecommendedModelAck,
  StartAck,
  SubscribeAck,
  TranscriptEvent,
  TranscriptSession,
} from '../models/transcript';
import { ChatStateService, NEW_CONVERSATION_STREAMING } from './chat-state.service';
import { TauriService } from './tauri.service';
import { LoggerService } from './logger.service';

/** Event name the Rust backend emits per model-download progress update. */
const MODEL_PROGRESS_EVENT = 'transcription_model_status';

/** Poll interval for detecting completion of a download this webview did not itself start. */
const RESUMED_DOWNLOAD_POLL_MS = 2000;

/** localStorage key for the live-transcript preference. Exported so tests assert the real key. */
export const LIVE_TRANSCRIPT_STORAGE_KEY = 'speedwave-live-transcript';

/** Where a transcript send lands: a fresh conversation, or the one on screen. */
export type SendTarget = 'new-chat' | 'current-chat';

/** Instruction prepended to a transcript sent to chat, per session language. */
const SEND_TO_CHAT_INSTRUCTIONS: Record<Language, string> = {
  pl:
    'Poniżej transkrypt spotkania. Przygotuj zwięzłe podsumowanie: najważniejsze wątki, ' +
    'podjęte decyzje i listę zadań (kto, co, na kiedy — jeśli padło). ' +
    'Transkrypt może zawierać błędy rozpoznawania mowy; niejasne fragmenty oznacz.',
  en:
    'Below is a meeting transcript. Write a concise summary: key topics, decisions made, ' +
    'and an action item list (who, what, by when — where stated). ' +
    'The transcript may contain speech-recognition errors; flag unclear fragments.',
};

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

  private readonly downloadingModelKeySignal = signal<string | null>(null);
  private readonly downloadProgressSignal = signal<DownloadProgress | null>(null);
  private downloadUnlisten: UnlistenFn | null = null;
  private downloadPollTimer: ReturnType<typeof setInterval> | undefined;
  private readonly captureWarningSignal = signal<CaptureWarning | null>(null);
  private readonly recordingSessionIdSignal = signal<string | null>(null);
  private readonly recordingSourceSignal = signal<AudioSource | null>(null);
  private readonly recordingLanguageSignal = signal<Language | null>(null);
  private readonly liveDraftSignal = signal<string>('');
  private readonly audioLevelsSignal = signal<number[] | null>(null);
  private readonly gpuClassSignal = signal<GpuClass | null>(null);

  /** Current session (live snapshot updated by incoming events). */
  readonly active: Signal<TranscriptSession | null> = this.activeSignal.asReadonly();

  /**
   * Session id of the in-progress recording — service-level so it survives the
   * record tab being destroyed on navigation (the backend driver keeps going).
   */
  readonly recordingSessionId: Signal<string | null> = this.recordingSessionIdSignal.asReadonly();

  /**
   * Source/language of the in-progress recording — service-level so a remounted
   * `RecordingControlsComponent` can restore its picker selection instead of showing defaults.
   */
  readonly recordingSource: Signal<AudioSource | null> = this.recordingSourceSignal.asReadonly();
  readonly recordingLanguage: Signal<Language | null> = this.recordingLanguageSignal.asReadonly();

  /** Latest capture-health warning for the active session (null = none). */
  readonly captureWarning: Signal<CaptureWarning | null> = this.captureWarningSignal.asReadonly();

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

  /**
   * Capabilities, compiled backends, probed `gpu_class`, and the host-computed acceleration
   * label. Side effect: caches `gpu_class`, which `liveTranscriptPreferred()` reads (before
   * the first call it assumes 'discrete', i.e. live on).
   */
  async getCapabilities(): Promise<CapabilitiesAck> {
    const ack = await this.tauri.invoke<CapabilitiesAck>('transcription_capabilities');
    this.gpuClassSignal.set(ack.gpu_class);
    return ack;
  }

  /**
   * Whether the next recording should run the live pass: the user's stored choice, else on only
   * where a discrete GPU makes live text worth its cost (ADR-056 Am. 13).
   */
  liveTranscriptPreferred(): boolean {
    try {
      const stored = localStorage.getItem(LIVE_TRANSCRIPT_STORAGE_KEY);
      if (stored === 'on') return true;
      if (stored === 'off') return false;
    } catch {
      // Private mode / quota — fall through to the hardware default.
    }
    return (this.gpuClassSignal() ?? 'discrete') === 'discrete';
  }

  /**
   * Persists the live-transcript choice (tolerates private-mode/quota failures).
   * @param live - the user's pick.
   */
  setLiveTranscriptPreferred(live: boolean): void {
    try {
      localStorage.setItem(LIVE_TRANSCRIPT_STORAGE_KEY, live ? 'on' : 'off');
    } catch {
      // Best-effort: losing the preference only costs a default next session.
    }
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
    return this.applyStartAck(ack, source, language);
  }

  /**
   * Resumes a finished recording: a new part appends to the same transcript.
   * @param sessionId - the Done session to reopen.
   * @param live - false = record-only (no live pass; transcript arrives after stop).
   */
  async resumeRecording(sessionId: string, live: boolean): Promise<StartAck> {
    const ack = await this.tauri.invoke<StartAck>('resume_transcription', { sessionId, live });
    return this.applyStartAck(ack, ack.snapshot.audio_source.source, ack.snapshot.language);
  }

  /**
   * Applies a start/resume ack: snapshot, live listener, recording signals.
   * @param ack - the backend acknowledgement to apply.
   * @param source - the capture source now recording.
   * @param language - the forced language now recording.
   */
  private async applyStartAck(
    ack: StartAck,
    source: AudioSource,
    language: Language
  ): Promise<StartAck> {
    this.activateSnapshot(ack.snapshot);
    try {
      await this.attachListener(ack.event_name);
    } catch (e) {
      // The backend capture already runs; stop it rather than orphan it.
      try {
        await this.tauri.invoke<void>('stop_transcription', { sessionId: ack.session_id });
        this.recordingSessionIdSignal.set(null);
        this.recordingSourceSignal.set(null);
        this.recordingLanguageSignal.set(null);
      } catch {
        // Stop failed — keep the id so the Stop control still targets the session.
        this.recordingSessionIdSignal.set(ack.session_id);
      }
      throw e;
    }
    this.recordingSessionIdSignal.set(ack.session_id);
    this.recordingSourceSignal.set(source);
    this.recordingLanguageSignal.set(language);
    return ack;
  }

  /**
   * Signals the driver to stop and transition to the offline pass.
   * @param sessionId - the recording to stop.
   */
  async stopRecording(sessionId: string): Promise<void> {
    try {
      await this.tauri.invoke<void>('stop_transcription', { sessionId });
    } finally {
      if (this.recordingSessionIdSignal() === sessionId) {
        this.recordingSessionIdSignal.set(null);
        this.recordingSourceSignal.set(null);
        this.recordingLanguageSignal.set(null);
      }
    }
  }

  /**
   * Re-attaches the live stream of the in-progress recording after the record
   * tab was destroyed and recreated (the driver never stopped).
   */
  async resumeActiveRecording(): Promise<void> {
    const id = this.recordingSessionIdSignal();
    if (id && !this.patchUnlisten) await this.subscribeToTranscript(id);
  }

  /**
   * Subscribes to an existing session's snapshot + live event stream. Refuses to switch away
   * from an in-progress recording's own session, which would otherwise drop its live listener.
   * @param sessionId - the session to attach to.
   */
  async subscribeToTranscript(sessionId: string): Promise<SubscribeAck> {
    const recordingId = this.recordingSessionIdSignal();
    if (recordingId !== null && recordingId !== sessionId) {
      throw new Error('a recording is in progress — stop it before viewing another session');
    }
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

  /** All persisted sessions (newest first). */
  list(): Promise<TranscriptSession[]> {
    return this.tauri.invoke<TranscriptSession[]>('list_transcripts');
  }

  /**
   * Loads a single session by id.
   * @param sessionId - the session to load.
   */
  get(sessionId: string): Promise<TranscriptSession> {
    return this.tauri.invoke<TranscriptSession>('get_transcript', { sessionId });
  }

  /**
   * Deletes a session directory (audio + transcript).
   * @param sessionId - the session to delete.
   */
  delete(sessionId: string): Promise<void> {
    return this.tauri.invoke<void>('delete_transcript', { sessionId });
  }

  /**
   * Renders the session as a timestamped markdown transcript.
   * @param sessionId - the session to render.
   */
  getMarkdown(sessionId: string): Promise<string> {
    return this.tauri.invoke<string>('get_transcript_markdown', { sessionId });
  }

  /**
   * Sends the transcript to Claude with a summarization instruction on top, in the session language.
   * @param sessionId - the session to send.
   * @param target - `'new-chat'` (default) opens a fresh conversation first; `'current-chat'` appends.
   */
  async sendToChat(sessionId: string, target: SendTarget = 'new-chat'): Promise<void> {
    // Read the transcript before touching the chat: a failed read must not wipe
    // the conversation the user was in.
    const [session, md] = await Promise.all([this.get(sessionId), this.getMarkdown(sessionId)]);
    const instruction = SEND_TO_CHAT_INSTRUCTIONS[session.language] ?? SEND_TO_CHAT_INSTRUCTIONS.en;
    if (target === 'new-chat') {
      await this.chatState.startNewConversation();
    } else if (this.chatState.isStreamingFromState()) {
      // sendMessage silently drops a send mid-stream — refuse instead of opening
      // a chat that never received the transcript.
      throw new Error(NEW_CONVERSATION_STREAMING);
    }
    await this.chatState.sendMessage(`${instruction}\n\n${md}`, 'Meeting transcript');
  }

  /** The single best model for this hardware + its download state. */
  recommendedModel(): Promise<RecommendedModelAck> {
    return this.tauri.invoke<RecommendedModelAck>('recommended_transcription_model');
  }

  /** Status of all Whisper models on disk. */
  listModels(): Promise<ModelsAck> {
    return this.tauri.invoke<ModelsAck>('list_transcription_models');
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
      // Inside try: a failed listener attach must also clear the tracking.
      await this.beginDownloadTracking(modelId);
      await this.tauri.invoke<void>('download_transcription_model', { modelId });
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
      const ack = await this.recommendedModel();
      // The offline-pass model is a separate entry, so match `modelId` against both; keying only
      // off the live one would poll forever while the other model downloads.
      const entry = ack.live.key === modelId ? ack.live : ack.finalize;
      if (entry?.key === modelId && !entry.downloading) {
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
    this.clearDownloadTracking(); // drop a stale listener before re-attaching
    this.downloadingModelKeySignal.set(modelId);
    this.downloadUnlisten = await this.tauri.listen<DownloadProgress>(MODEL_PROGRESS_EVENT, (e) => {
      if (e.payload.model_key === modelId) this.downloadProgressSignal.set(e.payload);
    });
  }

  /**
   * Deletes a downloaded model.
   * @param modelId - catalogue key.
   */
  deleteModel(modelId: string): Promise<void> {
    return this.tauri.invoke<void>('delete_transcription_model', { modelId });
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
    this.captureWarningSignal.set(null); // warnings are per-session
    if (snapshot.id !== this.recordingSessionIdSignal()) {
      this.liveDraftSignal.set(''); // a genuinely different session starts with no draft
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
      case 'audio_level':
        this.audioLevelsSignal.set(ev.levels);
        break;
      case 'status_changed':
        next.status = ev.status;
        // A draft/meter is only meaningful while recording (e.g. stale on failure).
        if (ev.status.state !== 'recording') {
          this.liveDraftSignal.set('');
          this.audioLevelsSignal.set(null);
        }
        break;
      case 'finalize_progress':
        next.status = { state: 'finalizing', progress: ev.progress };
        break;
      case 'final_segments_ready':
        // The offline pass produced a higher-quality transcript; swap it in.
        next.final_segments = ev.segments;
        break;
      case 'finished':
        next.status = { state: 'done' };
        this.liveDraftSignal.set('');
        break;
      case 'capture_warning':
        this.captureWarningSignal.set(ev.warning);
        break;
      case 'capture_warning_cleared':
        // Only the banner for the recovered warning goes away.
        if (this.captureWarningSignal() === ev.warning) {
          this.captureWarningSignal.set(null);
        }
        break;
    }
    this.lastSeq = ev.seq;
    this.activeSignal.set(next);
  }
}
