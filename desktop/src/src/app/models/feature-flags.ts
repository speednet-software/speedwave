/** Event the backend emits with the full flag map after a flag changes; mirrors Rust `FEATURE_FLAGS_CHANGED_EVENT`. */
export const FEATURE_FLAGS_CHANGED_EVENT = 'feature-flags-changed';

/** Feature flag keys; mirrors Rust `Feature`. */
export type FeatureFlag = 'office' | 'telemetry_settings';

/** Every flag with its state; mirrors the `get_feature_flags` result. */
export type FeatureFlags = Record<FeatureFlag, boolean>;
