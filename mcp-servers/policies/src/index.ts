/**
 * Thin TypeScript wrapper over the compiled WASM PII engine (`crates/pii-engine-wasm`):
 * policy/key loading plus tokenize/detokenize, consumed by the hub.
 * @module speedwave/policy-engine
 */

// Types
export { PIIType, ALL_PII_TYPES } from './types.js';

// WASM engine wrapper
export { loadEngine } from './engine.js';
export type { Detection, TokenizeResult, PiiEngine } from './engine.js';
