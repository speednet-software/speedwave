//! wasm-bindgen binding over `speedwave-pii-engine`, built for the Node-hosted hub
//! (`wasm-pack build --target nodejs`); everything here is a thin, fail-closed wrapper.

use serde::Serialize;
use speedwave_pii_engine::{
    compile_policy_v3, default_policy_json as core_default_policy_json, detokenize_json, scan_json,
    CompiledPolicy, Detection, DetectionAction, EngineKey,
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
    /// Compiles `policy_json` (policy.json v3: rules + keywords) and decodes `key_hex` (64
    /// hex chars, 32 bytes); either failure is returned as `Err`, never a panic (fail-closed).
    /// Keywords are parsed and carried on the compiled policy but never masked/unmasked here
    /// — the proxy is the only layer that acts on them (`alias_text`/`unalias_text`).
    #[wasm_bindgen(constructor)]
    pub fn new(policy_json: &str, key_hex: &str) -> Result<PiiEngine, JsError> {
        let policy = compile_policy_v3(policy_json).map_err(|e| JsError::new(&e.to_string()))?;
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

/// Thin re-export of the core's compiled-in default policy.json v3: SSOT for the TS
/// "no POLICY_FILE" path; the proxy (native) calls the core function directly.
#[wasm_bindgen]
pub fn default_policy_json() -> String {
    core_default_policy_json()
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;

    #[test]
    fn default_policy_json_compiles_and_covers_every_builtin_rule() {
        let json = default_policy_json();
        let policy = compile_policy_v3(&json).expect("default policy.json v3 must compile");
        assert_eq!(policy.rules().len(), 7);
        assert!(policy.keywords().is_empty());
    }

    #[test]
    fn default_policy_json_is_deterministic() {
        assert_eq!(default_policy_json(), default_policy_json());
    }

    #[test]
    fn v3_policy_with_keywords_compiles_and_carries_them_uninterpreted() {
        let json = serde_json::json!({
            "version": 3,
            "source": { "policies": ["strict"], "forced": [] },
            "rules": [
                {
                    "id": "EMAIL",
                    "displayName": "E-mail address",
                    "patterns": ["[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}"],
                    "caseSensitive": true,
                    "tokenize": true,
                    "log": false
                }
            ],
            "keywords": [
                { "match": "Coca-Cola", "alias": "Brandex", "caseSensitive": false }
            ]
        })
        .to_string();

        let policy = compile_policy_v3(&json).expect("valid v3 policy with keywords compiles");
        assert_eq!(policy.rules().len(), 1);
        // Hub never masks/unmasks keywords (the proxy does) — they are only carried through.
        assert_eq!(policy.keywords().len(), 1);
        assert_eq!(policy.keywords()[0].match_text, "Coca-Cola");
    }
}
