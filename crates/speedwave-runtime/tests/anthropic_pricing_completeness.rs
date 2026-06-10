//! Cross-language drift guard: the Desktop cost meter prices turns purely from
//! `list_anthropic_models` (the serialized `ANTHROPIC_MODELS`), so a Rust-side
//! model bump that ships an entry without usable pricing — or a 1M-context
//! family missing its `[1m]` rate — silently leaves the frontend unable to
//! price the served id. These assertions fail the build before that reaches
//! the UI. They complement the in-module unit tests in `defaults.rs` from the
//! public-API surface the frontend actually consumes.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use speedwave_runtime::defaults::{ModelPricing, ANTHROPIC_MODELS};

/// Per-MTok rates must be real positive prices, not placeholder zeros — a zero
/// rate renders a misleading $0.000 turn in the cost meter.
fn assert_priced(model_id: &str, label: &str, p: &ModelPricing) {
    assert!(
        p.input > 0.0,
        "{model_id} {label}: input rate must be a positive per-MTok price (was {})",
        p.input
    );
    assert!(
        p.output > 0.0,
        "{model_id} {label}: output rate must be a positive per-MTok price (was {})",
        p.output
    );
    assert!(
        p.cached_input >= 0.0,
        "{model_id} {label}: cache-read rate must not be negative (was {})",
        p.cached_input
    );
    assert!(
        p.cache_write > 0.0,
        "{model_id} {label}: cache-write rate must be a positive per-MTok price (was {})",
        p.cache_write
    );
}

#[test]
fn every_catalog_entry_is_priced() {
    // The frontend derives pricing at runtime from this catalog; a price-less
    // entry would surface a turn with no cost. Guard the base rate of every id.
    assert!(
        !ANTHROPIC_MODELS.is_empty(),
        "catalog must not be empty — the cost meter has nothing to price"
    );
    for m in ANTHROPIC_MODELS {
        assert_priced(m.id, "base", &m.pricing);
    }
}

#[test]
fn million_context_entries_have_a_priced_1m_variant() {
    // The served id for a 1M family carries the `[1m]` suffix
    // (`anthropic_default_models_env`); without `pricing_1m` the cost meter
    // cannot price that id. Require the variant exactly when (and only when)
    // the family is 1M-context.
    for m in ANTHROPIC_MODELS {
        let is_million = m.context_tokens >= 1_000_000;
        match (&m.pricing_1m, is_million) {
            (Some(p), true) => assert_priced(m.id, "[1m]", p),
            (None, false) => {}
            (Some(_), false) => panic!(
                "{}: has pricing_1m but is sub-1M ({} tokens) — there is no [1m] id to price",
                m.id, m.context_tokens
            ),
            (None, true) => panic!(
                "{}: is 1M-context ({} tokens) but ships no pricing_1m — the [1m] id would be unpriced",
                m.id, m.context_tokens
            ),
        }
    }
}

#[test]
fn catalog_serializes_pricing_for_the_frontend() {
    // `list_anthropic_models` serializes the catalog to JSON for the webview;
    // every entry's wire form must carry `input`/`output` under both `pricing`
    // and (for 1M families) `pricing_1m`, since the frontend reads those keys.
    let value =
        serde_json::to_value(ANTHROPIC_MODELS).expect("catalog must serialize for the frontend");
    let entries = value.as_array().expect("catalog serializes as an array");
    assert_eq!(entries.len(), ANTHROPIC_MODELS.len());

    for entry in entries {
        let pricing = entry
            .get("pricing")
            .expect("each entry carries a `pricing` block on the wire");
        assert!(pricing.get("input").and_then(|v| v.as_f64()).is_some());
        assert!(pricing.get("output").and_then(|v| v.as_f64()).is_some());

        let is_million = entry
            .get("context_tokens")
            .and_then(|v| v.as_u64())
            .expect("each entry carries context_tokens")
            >= 1_000_000;
        let priced_1m = entry.get("pricing_1m").is_some_and(|v| !v.is_null());
        assert_eq!(
            priced_1m, is_million,
            "pricing_1m presence on the wire must mirror a 1M context window"
        );
    }
}
