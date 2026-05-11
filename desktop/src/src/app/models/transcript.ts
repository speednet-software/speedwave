// Mirror of speedwave_runtime::transcription's serde types. Rust derives
// `#[serde(rename_all = "snake_case")]` everywhere — field names match.

/** PL/EN (forced; never auto-detected). */
export type Language = 'pl' | 'en';

/** Compiled whisper.cpp acceleration backends (build-time, not host-probe). */
export type Backend = 'cpu' | 'metal' | 'cuda' | 'vulkan';

/** What the host's capture backend can do. */
export interface CaptureCapabilities {
  supports_per_process: boolean;
  supports_system_audio: boolean;
  supports_microphone: boolean;
  note: string | null;
}

/** How a process to capture is identified. */
export type ProcessSelector = { by: 'pid'; pid: number } | { by: 'node_id'; id: string };

/** What to capture. */
export type AudioSource =
  | { kind: 'system_wide' }
  | { kind: 'process'; selector: ProcessSelector }
  | { kind: 'microphone'; device: string | null }
  | { kind: 'mixed'; system: AudioSource; mic: string | null };

/** A capturable source the user can pick. */
export interface AudioSourceInfo {
  source: AudioSource;
  label: string;
  app_id: string | null;
}

/** A word with its time span (populated only when word_timestamps is set). */
export interface Word {
  text: string;
  /** Serde-serialized `Duration` = `{ secs, nanos }`. */
  start: { secs: number; nanos: number };
  end: { secs: number; nanos: number };
}

/** One transcript segment. */
export interface Segment {
  start: { secs: number; nanos: number };
  end: { secs: number; nanos: number };
  text: string;
  words: Word[];
  /** Speaker id (0-indexed); `null` until diarization stamps it. */
  speaker: number | null;
}

/** Which models were used for each pass of a session. */
export interface ModelsUsed {
  live: string | null;
  finalize: string | null;
  diarization_segmentation: string | null;
  diarization_embedding: string | null;
}

/** Lifecycle of a recording. */
export type TranscriptStatus =
  | { state: 'recording' }
  | { state: 'finalizing'; progress: number }
  | { state: 'done' }
  | { state: 'failed'; reason: string };

/** One transcript session — the persisted artifact. */
export interface TranscriptSession {
  id: string;
  /** RFC 3339 (`YYYY-MM-DDTHH:MM:SSZ`). */
  created_at: string;
  language: Language;
  audio_source: AudioSourceInfo;
  status: TranscriptStatus;
  live_segments: Segment[];
  final_segments: Segment[] | null;
  audio_path: string | null;
  speaker_names: Record<number, string>;
  models_used: ModelsUsed;
  last_seq: number;
}

/** Live event on a `transcript_event::<id>` channel. `seq` is monotonic per session. */
export type TranscriptEvent =
  | { kind: 'segment_appended'; seq: number; segment: Segment }
  | { kind: 'segments_replaced'; seq: number; from_index: number; segments: Segment[] }
  | { kind: 'speaker_assigned'; seq: number; segment_index: number; speaker: number }
  | { kind: 'status_changed'; seq: number; status: TranscriptStatus }
  | { kind: 'speaker_relabeled'; seq: number; speaker_names: Record<number, string> }
  | { kind: 'finalize_progress'; seq: number; progress: number }
  | {
      kind: 'final_segments_ready';
      seq: number;
      segments: Segment[];
      speaker_names: Record<number, string>;
    }
  | { kind: 'finished'; seq: number };

/** `transcription_capabilities` command return type. */
export interface CapabilitiesAck {
  capabilities: CaptureCapabilities;
  backends: Backend[];
}

/** `start_transcription` command return type. */
export interface StartAck {
  session_id: string;
  event_name: string;
  snapshot: TranscriptSession;
}

/** `subscribe_transcript` command return type. */
export interface SubscribeAck {
  event_name: string;
  snapshot: TranscriptSession;
}

/** Status of one catalogue model on disk. */
export interface ModelStatusEntry {
  key: string;
  downloaded: boolean;
  size_bytes: number;
  path: string | null;
}

/** `list_transcription_models` command return type. */
export interface ModelsAck {
  whisper: ModelStatusEntry[];
  diarization: ModelStatusEntry[];
  total_bytes_used: number;
}

/** Per-update payload of the `transcription_model_status` Tauri event. */
export interface DownloadProgress {
  model_key: string;
  downloaded_bytes: number;
  total_bytes: number | null;
}
