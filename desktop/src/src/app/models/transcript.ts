// Mirror of speedwave_runtime::transcription's serde types. Rust derives
// `#[serde(rename_all = "snake_case")]` everywhere — field names match.

/** PL/EN (forced; never auto-detected). */
export type Language = 'pl' | 'en';

/** Compiled whisper.cpp acceleration backends (build-time, not host-probe). */
export type Backend = 'cpu' | 'metal' | 'vulkan';

/** Probed host GPU class — mirrors Rust `GpuClass` (ADR-085). */
export type GpuClass = 'none' | 'integrated' | 'discrete';

/** What the host's capture backend can do. */
export interface CaptureCapabilities {
  supports_system_audio: boolean;
  supports_microphone: boolean;
  note: string | null;
}

/** What to capture. */
export type AudioSource =
  | { kind: 'system_wide' }
  | { kind: 'microphone'; device: string | null }
  | { kind: 'mixed'; mic: string | null };

/** A capturable source the user can pick. */
export interface AudioSourceInfo {
  source: AudioSource;
  label: string;
}

/** A word with its time span (populated only when word_timestamps is set). */
export interface Word {
  text: string;
  /** Serde-serialized `Duration` = `{ secs, nanos }`. */
  start: { secs: number; nanos: number };
  end: { secs: number; nanos: number };
}

/** Channel a segment was decoded from (absent on mono captures and old transcripts). */
export type TranscriptSource = 'system' | 'mic';

/** One transcript segment. */
export interface Segment {
  start: { secs: number; nanos: number };
  end: { secs: number; nanos: number };
  text: string;
  words: Word[];
  source?: TranscriptSource | null;
}

/** Which models were used for each pass of a session. */
export interface ModelsUsed {
  /** Live-pass model key; null = record-only for the current part (drives the record-only UI). */
  live: string | null;
  finalize: string | null;
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
  /** Extra audio parts recorded by resumes (absent on never-resumed sessions). */
  audio_parts?: string[];
  models_used: ModelsUsed;
  last_seq: number;
}

/** Non-fatal capture-health warnings — mirrors Rust `CaptureWarning`. */
export type CaptureWarning =
  | 'system_audio_silent'
  | 'microphone_stalled'
  | 'system_audio_stalled'
  | 'audio_dropped'
  | 'recording_part_missing';

/** `request_microphone_permission` outcome — mirrors Rust `MicPermission`. */
export type MicPermission = 'granted' | 'denied' | 'previously_denied';

/** `microphone_permission_status` state — mirrors Rust `MicPermissionStatus`. */
export type MicPermissionStatus = 'granted' | 'denied' | 'undetermined';

/** Live event on a `transcript_event::<id>` channel. `seq` is monotonic per session. */
export type TranscriptEvent =
  | { kind: 'segment_appended'; seq: number; segment: Segment }
  | { kind: 'live_draft'; seq: number; text: string }
  | { kind: 'status_changed'; seq: number; status: TranscriptStatus }
  | { kind: 'finalize_progress'; seq: number; progress: number }
  | { kind: 'capture_warning'; seq: number; warning: CaptureWarning }
  | { kind: 'capture_warning_cleared'; seq: number; warning: CaptureWarning }
  | {
      kind: 'final_segments_ready';
      seq: number;
      segments: Segment[];
    }
  | { kind: 'audio_level'; seq: number; levels: number[] }
  | { kind: 'finished'; seq: number };

/** `transcription_capabilities` command return type. */
export interface CapabilitiesAck {
  capabilities: CaptureCapabilities;
  backends: Backend[];
  gpu_class: GpuClass;
  /** Acceleration label computed host-side (`accel::accel_label()`) — render verbatim. */
  accel_label: string;
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
  total_bytes_used: number;
}

/** One model the pipeline needs, with its on-disk state. */
export interface RecommendedModelEntry {
  key: string;
  display_name: string;
  size_bytes: number;
  downloaded: boolean;
  downloading: boolean;
}

/**
 * `recommended_transcription_model` — the live model plus the offline-pass model when this
 * host needs a different one. Mirrors Rust `RecommendedModelAck`.
 */
export interface RecommendedModelAck {
  live: RecommendedModelEntry;
  finalize: RecommendedModelEntry | null;
  accel_label: string;
}

/** Per-update payload of the `transcription_model_status` Tauri event. */
export interface DownloadProgress {
  model_key: string;
  downloaded_bytes: number;
  total_bytes: number | null;
}
