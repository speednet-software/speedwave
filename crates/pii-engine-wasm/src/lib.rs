//! wasm-bindgen binding over `speedwave-pii-engine`, built for the Node-hosted hub
//! (`wasm-pack build --target nodejs`); everything here is a thin, fail-closed wrapper.

use serde::Serialize;
use speedwave_pii_engine::{
    compile_policy_v2, detokenize_json, scan_json, CompiledPolicy, Detection, DetectionAction,
    EngineKey,
};
use wasm_bindgen::prelude::*;

/// One category's outcome as serialized for the hub: lowercase action, per-category count.
#[derive(Serialize)]
struct DetectionOut {
    category: String,
    action: &'static str,
    count: u32,
}

impl From<&Detection> for DetectionOut {
    fn from(d: &Detection) -> Self {
        Self {
            category: d.category.clone(),
            action: match d.action {
                DetectionAction::Tokenized => "tokenized",
                DetectionAction::Passed => "passed",
            },
            count: d.count,
        }
    }
}

/// `tokenize` output: the scanned value plus its per-category detection aggregate.
#[derive(Serialize)]
struct TokenizeOut {
    value: serde_json::Value,
    detections: Vec<DetectionOut>,
}

/// A compiled policy plus tokenization key, ready to scan or detokenize JSON values.
#[wasm_bindgen]
pub struct PiiEngine {
    policy: CompiledPolicy,
    key: EngineKey,
}

#[wasm_bindgen]
impl PiiEngine {
    /// Compiles `policy_json` (policy.json v2) and decodes `key_hex` (64 hex chars, 32
    /// bytes); either failure is returned as `Err`, never a panic (fail-closed).
    #[wasm_bindgen(constructor)]
    pub fn new(policy_json: &str, key_hex: &str) -> Result<PiiEngine, JsError> {
        let policy = compile_policy_v2(policy_json).map_err(|e| JsError::new(&e.to_string()))?;
        let key = EngineKey::from_hex(key_hex).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(Self { policy, key })
    }

    /// Scans `value_json` (a `JSON.stringify`d string, object, or array) and returns a JSON
    /// string `{"value": <scanned>, "detections": [{"category","action","count"}, ...]}`.
    pub fn tokenize(&self, value_json: &str) -> Result<String, JsError> {
        let mut value: serde_json::Value =
            serde_json::from_str(value_json).map_err(|e| JsError::new(&e.to_string()))?;
        let detections = scan_json(&self.policy, &self.key, &mut value)
            .map_err(|e| JsError::new(&e.to_string()))?;
        let out = TokenizeOut {
            value,
            detections: detections.iter().map(DetectionOut::from).collect(),
        };
        serde_json::to_string(&out).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Detokenizes every token span in `value_json`, all-or-nothing: the first invalid or
    /// tampered token aborts with `Err` and leaves no partial result.
    pub fn detokenize(&self, value_json: &str) -> Result<String, JsError> {
        let mut value: serde_json::Value =
            serde_json::from_str(value_json).map_err(|e| JsError::new(&e.to_string()))?;
        detokenize_json(&self.key, &mut value).map_err(|e| JsError::new(&e.to_string()))?;
        serde_json::to_string(&value).map_err(|e| JsError::new(&e.to_string()))
    }
}
