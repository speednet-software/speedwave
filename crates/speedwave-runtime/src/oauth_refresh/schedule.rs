use std::time::Duration;

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

pub(super) fn retry_delay(failures: u32) -> Duration {
    let doublings = failures.saturating_sub(1).min(16);
    consts::OAUTH_REFRESH_CHECK_INTERVAL
        .saturating_mul(1 << doublings)
        .min(consts::OAUTH_REFRESH_BACKOFF_MAX)
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

    #[test]
    fn retry_delay_doubles_from_ten_seconds_and_stops_at_two_minutes() {
        let table = [
            (1, 10),
            (2, 20),
            (3, 40),
            (4, 80),
            (5, 120),
            (6, 120),
            (7, 120),
        ];
        for (failures, secs) in table {
            assert_eq!(
                retry_delay(failures),
                Duration::from_secs(secs),
                "{failures}"
            );
        }
    }

    #[test]
    fn retry_delay_stays_capped_for_huge_counts_and_starts_at_ten_seconds_for_zero() {
        assert_eq!(retry_delay(0), Duration::from_secs(10));
        assert_eq!(retry_delay(u32::MAX), Duration::from_secs(120));
    }
}
