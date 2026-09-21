/** Where the picker rows came from. Mirror of Rust `model_picker::PickerSource`. */
export type ModelPickerSource = 'claude_code' | 'catalog';

/**
 * One picker row per model; `wire_id` is what gets pinned and sent, `effort_levels` are the slider
 * stops (Claude Code's where it lists the model). Mirror of Rust `model_picker::PickerRow`.
 */
export interface ModelPickerRow {
  id: string;
  wire_id: string;
  is_default: boolean;
  display_name: string | null;
  description: string | null;
  requires_usage_credits: boolean;
  effort_levels: string[];
  default_effort: string | null;
}

/** Anthropic picker rows of one project plus the slider order. Mirror of Rust `model_picker::ModelPicker`. */
export interface ModelPicker {
  source: ModelPickerSource;
  rows: ModelPickerRow[];
  effort_order: string[];
}

const ONE_MILLION_SUFFIX = /(\[1m\])+$/;
const SNAPSHOT_DATE = /-\d{8}$/;

/**
 * Model identity without the `[1m]` suffixes and the `-YYYYMMDD` snapshot date.
 * Mirrors Rust `defaults::canonical_anthropic_model_id`.
 * @param modelId - Wire, pinned or observed model id.
 */
export function canonicalModelId(modelId: string): string {
  return withoutOneMillionSuffix(modelId).replace(SNAPSHOT_DATE, '');
}

/**
 * Model id without its trailing `[1m]` suffixes; everything else is kept verbatim.
 * @param modelId - Wire, pinned or observed model id.
 */
export function withoutOneMillionSuffix(modelId: string): string {
  return modelId.trim().replace(ONE_MILLION_SUFFIX, '');
}
