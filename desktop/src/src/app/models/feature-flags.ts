export const FEATURE_FLAGS_CHANGED_EVENT = 'feature-flags-changed';

/** Feature flag keys; mirrors Rust `Feature`. */
export type FeatureFlag = 'office' | 'telemetry_settings';

/** Every flag with its state; mirrors the `get_feature_flags` result. */
export type FeatureFlags = Record<FeatureFlag, boolean>;

export const ALL_OFF: FeatureFlags = { office: false, telemetry_settings: false };
