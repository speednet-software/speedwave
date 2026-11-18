use chrono::{DateTime, Utc};

use crate::consts;

pub(super) fn needs_refresh(
    now: DateTime<Utc>,
    last_refresh_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
) -> bool {
    let remaining_ms = expires_at.signed_duration_since(now).num_milliseconds();
    let lifetime_ms = expires_at
        .signed_duration_since(last_refresh_at)
        .num_milliseconds();
    remaining_ms <= 0
        || lifetime_ms <= 0
        || remaining_ms.saturating_mul(100)
            < lifetime_ms.saturating_mul(consts::OAUTH_REFRESH_REMAINING_PERCENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(secs: i64) -> DateTime<Utc> {
        DateTime::<Utc>::from_timestamp(1_800_000_000 + secs, 0).unwrap_or_default()
    }

    #[test]
    fn fresh_token_is_not_due() {
        assert!(!needs_refresh(at(0), at(0), at(43_200)));
        assert!(!needs_refresh(at(3_600), at(0), at(43_200)));
    }

    #[test]
    fn token_is_due_below_a_quarter_of_its_lifetime() {
        assert!(!needs_refresh(at(32_400), at(0), at(43_200)));
        assert!(needs_refresh(at(32_401), at(0), at(43_200)));
    }

    #[test]
    fn threshold_scales_with_the_lifetime() {
        assert!(!needs_refresh(at(2_700), at(0), at(3_600)));
        assert!(needs_refresh(at(2_701), at(0), at(3_600)));
    }

    #[test]
    fn expired_token_is_due() {
        assert!(needs_refresh(at(100), at(0), at(100)));
        assert!(needs_refresh(at(200), at(0), at(100)));
    }

    #[test]
    fn nonsensical_lifetime_is_due() {
        assert!(needs_refresh(at(0), at(500), at(100)));
        assert!(needs_refresh(at(0), at(100), at(100)));
    }
}
