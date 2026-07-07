import { Injectable, inject, signal, type Signal } from '@angular/core';
import { type UnlistenFn } from '@tauri-apps/api/event';

import type {
  AudioSource,
  CapabilitiesAck,
  AudioSourceInfo,
  CaptureWarning,
  DownloadProgress,
  Language,
  ModelsAck,
  RecommendedModelAck,
  StartAck,
  SubscribeAck,
  TranscriptEvent,
  TranscriptSession,
} from '../models/transcript';
import { ChatStateService } from './chat-state.service';
import { TauriService } from './tauri.service';
import { LoggerService } from './logger.service';

/** Event name the Rust backend emits per model-download progress update. */
const MODEL_PROGRESS_EVENT = 'transcription_model_status';

/**
 * Meeting-transcription state + Tauri-command facade. Mirrors the ADR-056
 * snapshot+seq delivery: `subscribeToTranscript` applies a snapshot, then
 * listens for events with `seq > lastSeq` idempotently.
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
  private readonly captureWarningSignal = signal<CaptureWarning | null>(null);
  private readonly recordingSessionIdSignal = signal<string | null>(null);

  /** Current session (live snapshot updated by incoming events). */
  readonly active: Signal<TranscriptSession | null> = this.activeSignal.asReadonly();

  /**
   * Session id of the in-progress recording — service-level so it survives the
   * record tab being destroyed on navigation (the backend driver keeps going).
   */
  readonly recordingSessionId: Signal<string | null> = this.recordingSessionIdSignal.asReadonly();

  /** Latest capture-health warning for the active session (null = none). */
  readonly captureWarning: Signal<CaptureWarning | null> = this.captureWarningSignal.asReadonly();

  /**
   * Download-in-flight key — service-level so it survives component remounts.
   */
  readonly downloadingModelKey: Signal<string | null> = this.downloadingModelKeySignal.asReadonly();

  /** Latest progress payload for the in-flight download (null before first). */
  readonly downloadProgress: Signal<DownloadProgress | null> =
    this.downloadProgressSignal.asReadonly();

  /** Capture capabilities + compiled whisper.cpp backends for this build. */
  getCapabilities(): Promise<CapabilitiesAck> {
    return this.tauri.invoke<CapabilitiesAck>('transcription_capabilities');
  }

  /** Audio sources the user can pick from (depends on host + capabilities). */
  listAudioSources(): Promise<AudioSourceInfo[]> {
    return this.tauri.invoke<AudioSourceInfo[]>('list_audio_sources');
  }

  /**
   * Starts recording the given source, then subscribes to its live stream.
   * @param source - what to capture (system / mic / mixed).
   * @param language - forced PL/EN; never auto-detected.
   */
  async startRecording(source: AudioSource, language: Language): Promise<StartAck> {
    const ack = await this.tauri.invoke<StartAck>('start_transcription', {
      params: { source, language },
    });
    this.activateSnapshot(ack.snapshot);
    this.recordingSessionIdSignal.set(ack.session_id);
    await this.attachListener(ack.event_name);
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
   * Subscribes to an existing session's snapshot + live event stream.
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
   * Renders the transcript as markdown and sends it to Claude via the chat path.
   * @param sessionId - the session to send.
   */
  async sendToChat(sessionId: string): Promise<void> {
    const md = await this.getMarkdown(sessionId);
    await this.chatState.sendMessage(md, 'Meeting transcript');
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
   * Starts a model download tracked in the service signals (backend enforces
   * single-flight per model; the local guard just fails fast).
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
   * Re-attaches progress tracking to a download the backend reports as still
   * running (webview reloaded mid-download — the invoke promise is gone).
   * @param modelId - catalogue key the backend flagged as `downloading`.
   */
  async resumeDownloadTracking(modelId: string): Promise<void> {
    if (this.downloadingModelKeySignal() === modelId) return;
    await this.beginDownloadTracking(modelId);
  }

  /** Drops download tracking (used when the backend no longer reports one). */
  clearDownloadTracking(): void {
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

  /** Opens the macOS System Settings → Privacy → Microphone pane (no-op elsewhere). */
  openMicrophonePrivacyPane(): Promise<void> {
    return this.tauri.invoke<void>('open_microphone_pane');
  }

  /** Opens the macOS System Settings → Privacy → Audio Recording pane (no-op elsewhere). */
  openAudioCapturePrivacyPane(): Promise<void> {
    return this.tauri.invoke<void>('open_audio_capture_pane');
  }

  /**
   * Applies a freshly-received snapshot (resets lastSeq).
   * @param snapshot - server-supplied current state.
   */
  private activateSnapshot(snapshot: TranscriptSession): void {
    this.lastSeq = snapshot.last_seq ?? 0;
    this.captureWarningSignal.set(null); // warnings are per-session
    this.activeSignal.set(snapshot);
  }

  private async attachListener(eventName: string): Promise<void> {
    await this.detach();
    this.patchUnlisten = await this.tauri.listen<TranscriptEvent>(eventName, (e) => {
      this.applyEvent(e.payload);
    });
  }

  /**
   * Idempotent event application: ignores `seq <= lastSeq` (already captured
   * via the snapshot path).
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
      case 'segments_replaced':
        next.live_segments = [...cur.live_segments.slice(0, ev.from_index), ...ev.segments];
        break;
      case 'status_changed':
        next.status = ev.status;
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
        break;
      case 'capture_warning':
        this.captureWarningSignal.set(ev.warning);
        break;
    }
    this.lastSeq = ev.seq;
    this.activeSignal.set(next);
  }
}
