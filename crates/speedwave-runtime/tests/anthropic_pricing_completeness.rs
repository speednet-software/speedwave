//! Drift guard: every `ANTHROPIC_MODELS` entry (and each 1M family's `[1m]`
//! variant) must carry usable pricing the serialized catalog exposes.

#![expect(
    clippy::expect_used,
    reason = "test code: expect on fixtures is the sanctioned boundary"
)]

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
    // Guard the base rate of every catalog id.
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
    // Require `pricing_1m` exactly when the family is 1M-context.
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
    // Wire form must carry `input`/`output` under `pricing` (and `pricing_1m` for 1M families).
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

#[test]
fn million_context_variants_bill_at_standard_rates() {
    // Claude 4.6+ includes the full 1M window at standard pricing — every catalog
    // family is 4.6+ (platform.claude.com/docs/en/about-claude/pricing, Long context).
    for m in ANTHROPIC_MODELS {
        if let Some(p1m) = &m.pricing_1m {
            assert_eq!(
                p1m, &m.pricing,
                "{}: the [1m] variant must bill at the base rate",
                m.id
            );
        }
    }
}

#[test]
fn sonnet_5_is_priced_below_sonnet_46() {
    // Sonnet 5 ($2/$10) sits below Sonnet 4.6 ($3/$15) — the launch price became
    // the standard price (pricing page note, 2026-08). Guards against a shared const.
    let find = |id: &str| {
        ANTHROPIC_MODELS
            .iter()
            .find(|m| m.id == id)
            .unwrap_or_else(|| panic!("{id} missing from catalog"))
    };
    let s5 = find("claude-sonnet-5");
    let s46 = find("claude-sonnet-4-6");
    assert!(s5.pricing.input < s46.pricing.input);
    assert!(s5.pricing.cached_input < s46.pricing.cached_input);
    assert!(s5.pricing.cache_write < s46.pricing.cache_write);
    assert!(s5.pricing.output < s46.pricing.output);
}
