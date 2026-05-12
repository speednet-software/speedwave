import { Injectable, inject, signal, type Signal } from '@angular/core';
import { type UnlistenFn } from '@tauri-apps/api/event';

import type {
  AudioSource,
  CapabilitiesAck,
  AudioSourceInfo,
  DownloadProgress,
  Language,
  ModelsAck,
  Segment,
  SpeakerNamePairs,
  StartAck,
  SubscribeAck,
  TranscriptEvent,
  TranscriptionConfig,
  TranscriptSession,
} from '../models/transcript';
import { ChatStateService } from './chat-state.service';
import { TauriService } from './tauri.service';

/** Event name the Rust backend emits per model-download progress update. */
const MODEL_PROGRESS_EVENT = 'transcription_model_status';

/**
 * Converts the wire `[[id, name], …]` pairs into a `{ id: name }` record.
 * @param pairs - speaker-name pairs as carried inside a `TranscriptEvent`.
 */
function pairsToRecord(pairs: SpeakerNamePairs): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [id, name] of pairs) out[id] = name;
  return out;
}

/**
 * Meeting-transcription state + Tauri-command facade. Mirrors the ADR-056
 * snapshot+seq delivery: `subscribeToTranscript` applies a snapshot, then
 * listens for events with `seq > lastSeq` idempotently.
 */
@Injectable({ providedIn: 'root' })
export class TranscriptionService {
  private readonly tauri = inject(TauriService);
  private readonly chatState = inject(ChatStateService);

  private readonly activeSignal = signal<TranscriptSession | null>(null);
  private lastSeq = 0;
  private patchUnlisten: UnlistenFn | null = null;

  /** Current session (live snapshot updated by incoming events). */
  readonly active: Signal<TranscriptSession | null> = this.activeSignal.asReadonly();

  /** `true` if the user toggled meeting transcription on in Settings. */
  isEnabled(): Promise<boolean> {
    return this.tauri.invoke<boolean>('transcription_enabled');
  }

  /**
   * Persists the on/off toggle.
   * @param enabled - `true` to enable, `false` to disable.
   */
  setEnabled(enabled: boolean): Promise<void> {
    return this.tauri.invoke<void>('set_transcription_enabled', { enabled });
  }

  /** Reads the full meeting-transcription preferences block. */
  getConfig(): Promise<TranscriptionConfig> {
    return this.tauri.invoke<TranscriptionConfig>('get_transcription_config');
  }

  /**
   * Persists the full meeting-transcription preferences block (whole replace).
   * @param config - the new preferences.
   */
  setConfig(config: TranscriptionConfig): Promise<void> {
    return this.tauri.invoke<void>('set_transcription_config', { config });
  }

  /** Capture capabilities + compiled whisper.cpp backends for this build. */
  getCapabilities(): Promise<CapabilitiesAck> {
    return this.tauri.invoke<CapabilitiesAck>('transcription_capabilities');
  }

  /** Audio sources the user can pick from (depends on host + capabilities). */
  listAudioSources(): Promise<AudioSourceInfo[]> {
    return this.tauri.invoke<AudioSourceInfo[]>('list_audio_sources');
  }

  /**
   * Starts recording (the real capture lands in Phase 4).
   * @param source - what to capture.
   * @param language - forced PL/EN; never auto-detected.
   */
  async startRecording(source: AudioSource, language: Language): Promise<StartAck> {
    const ack = await this.tauri.invoke<StartAck>('start_transcription', {
      source,
      language,
      liveModelOverride: null,
    });
    this.activateSnapshot(ack.snapshot);
    await this.attachListener(ack.event_name);
    return ack;
  }

  /**
   * Signals the driver to stop and transition to the offline pass.
   * @param sessionId - the recording to stop.
   */
  stopRecording(sessionId: string): Promise<void> {
    return this.tauri.invoke<void>('stop_transcription', { sessionId });
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
        console.warn('transcription detach failed:', e);
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
   * Drops the recorded audio file (the transcript stays).
   * @param sessionId - the session whose audio to discard.
   */
  discardAudio(sessionId: string): Promise<void> {
    return this.tauri.invoke<void>('discard_transcript_audio', { sessionId });
  }

  /**
   * Assigns a user-supplied display name to a speaker.
   * @param sessionId - the session.
   * @param speakerId - 0-indexed speaker id.
   * @param name - new label; empty string clears it.
   */
  relabelSpeaker(sessionId: string, speakerId: number, name: string): Promise<void> {
    return this.tauri.invoke<void>('relabel_speaker', { sessionId, speakerId, name });
  }

  /**
   * Renders the session as markdown (with the "approximate labels" footer).
   * @param sessionId - the session to render.
   */
  getMarkdown(sessionId: string): Promise<string> {
    return this.tauri.invoke<string>('get_transcript_markdown', { sessionId });
  }

  /**
   * Renders the transcript as markdown and sends it to Claude via the existing
   * chat path. The UI should show a confirm dialog before calling this — the
   * markdown leaves the machine.
   * @param sessionId - the session to send.
   */
  async sendToChat(sessionId: string): Promise<void> {
    const md = await this.getMarkdown(sessionId);
    await this.chatState.sendMessage(md, 'Meeting transcript');
  }

  /** Status of all Whisper + diarization models on disk. */
  listModels(): Promise<ModelsAck> {
    return this.tauri.invoke<ModelsAck>('list_transcription_models');
  }

  /**
   * Starts a model download (off-thread) and routes progress to `onProgress`.
   * @param modelId - catalogue key.
   * @param onProgress - optional progress callback.
   */
  downloadModel(
    modelId: string,
    onProgress?: (p: DownloadProgress) => void
  ): Promise<{ done: Promise<void>; unlisten: UnlistenFn }> {
    return this.tauri
      .listen<DownloadProgress>(MODEL_PROGRESS_EVENT, (e) => {
        if (e.payload.model_key === modelId) onProgress?.(e.payload);
      })
      .then((unlisten) => ({
        done: this.tauri
          .invoke<void>('download_transcription_model', { modelId })
          .finally(() => unlisten()),
        unlisten,
      }));
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
      case 'speaker_assigned':
        next.live_segments = cur.live_segments.map((s, i) =>
          i === ev.segment_index ? ({ ...s, speaker: ev.speaker } as Segment) : s
        );
        if (cur.final_segments) {
          next.final_segments = cur.final_segments.map((s, i) =>
            i === ev.segment_index ? ({ ...s, speaker: ev.speaker } as Segment) : s
          );
        }
        break;
      case 'status_changed':
        next.status = ev.status;
        break;
      case 'speaker_relabeled':
        next.speaker_names = pairsToRecord(ev.speaker_names);
        break;
      case 'finalize_progress':
        next.status = { state: 'finalizing', progress: ev.progress };
        break;
      case 'final_segments_ready':
        // The offline pass produced a higher-quality transcript; swap it in.
        // Speaker IDs were already remapped server-side to keep user relabels.
        next.final_segments = ev.segments;
        next.speaker_names = pairsToRecord(ev.speaker_names);
        break;
      case 'finished':
        next.status = { state: 'done' };
        break;
    }
    this.lastSeq = ev.seq;
    this.activeSignal.set(next);
  }
}
