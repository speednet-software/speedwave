// Window management helpers — tray debounce, close/destroy guards,
// show/hide with macOS activation policy.

use super::MAIN_WINDOW_LABEL;
use tauri::Manager;

/// Returns `true` if a click should be suppressed (debounced).
///
/// A click is suppressed when the elapsed time since the previous click
/// (`now_ms.saturating_sub(prev_ms)`) is less than `threshold_ms`. Uses saturating
/// subtraction so that a backward clock jump suppresses rather than
/// double-toggles.
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub(crate) fn should_debounce(prev_ms: u64, now_ms: u64, threshold_ms: u64) -> bool {
    now_ms.saturating_sub(prev_ms) < threshold_ms
}

/// Determines what the `CloseRequested` handler should do.
///
/// Returns `true` when the close should be intercepted (prevent close + hide).
/// Returns `false` when the close should proceed normally (app exits).
pub(crate) fn should_prevent_close(window_label: &str, tray_available: bool) -> bool {
    window_label == MAIN_WINDOW_LABEL && tray_available
}

/// Returns `true` if the `Destroyed` event should trigger cleanup.
///
/// Only the main window destruction runs cleanup — dialog or secondary
/// windows must not prematurely stop services.
pub(crate) fn should_run_cleanup(window_label: &str) -> bool {
    window_label == MAIN_WINDOW_LABEL
}

/// Shows the main window and restores the macOS activation policy to Regular
/// so the app reappears in the Dock and Cmd+Tab after being hidden.
pub(crate) fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        if let Err(e) = window.show() {
            log::warn!("failed to show window: {e}");
        }
        if let Err(e) = window.set_focus() {
            log::warn!("failed to set focus: {e}");
        }
        #[cfg(target_os = "macos")]
        {
            if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
                log::warn!("failed to set activation policy to Regular: {e}");
            }
        }
    } else {
        log::warn!("main window not found");
    }
}

/// Hides the main window and switches the macOS activation policy to Accessory
/// so the app disappears from the Dock and Cmd+Tab (tray-only mode).
pub(crate) fn hide_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        if let Err(e) = window.hide() {
            log::warn!("failed to hide window: {e}");
        }
        #[cfg(target_os = "macos")]
        {
            if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Accessory) {
                log::warn!("failed to set activation policy to Accessory: {e}");
            }
        }
    } else {
        log::warn!("main window not found");
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    // -- Tray click debounce --

    #[test]
    fn debounce_suppresses_click_within_threshold() {
        assert!(should_debounce(1000, 1200, 500));
    }

    #[test]
    fn debounce_allows_click_after_threshold() {
        assert!(!should_debounce(1000, 1501, 500));
    }

    #[test]
    fn debounce_allows_click_at_exact_threshold() {
        // At exactly 500ms elapsed, the click should go through
        // (condition is strict less-than).
        assert!(!should_debounce(1000, 1500, 500));
    }

    #[test]
    fn debounce_suppresses_when_clock_goes_backward() {
        // Clock jumped backward: now < prev. saturating_sub returns 0,
        // which is < threshold → suppressed. This is the safe behavior.
        assert!(should_debounce(5000, 3000, 500));
    }

    #[test]
    fn debounce_allows_first_click_ever() {
        // prev=0 (initial AtomicU64 value), now is any reasonable time.
        // Elapsed time is huge → not debounced.
        assert!(!should_debounce(0, 1_700_000_000_000, 500));
    }

    #[test]
    fn debounce_suppresses_zero_elapsed() {
        // Same timestamp (simultaneous events).
        assert!(should_debounce(1000, 1000, 500));
    }

    #[test]
    fn debounce_allows_with_zero_threshold() {
        // Zero threshold means "never debounce" (0 < 0 is false).
        assert!(!should_debounce(1000, 1000, 0));
    }

    #[test]
    fn debounce_handles_u64_max_prev() {
        // prev is u64::MAX, now is small (extreme backward jump).
        // saturating_sub(u64::MAX) = 0 → suppressed.
        assert!(should_debounce(u64::MAX, 1000, 500));
    }

    #[test]
    fn debounce_handles_u64_max_now() {
        // now is u64::MAX, prev is 0 → huge elapsed → allowed.
        assert!(!should_debounce(0, u64::MAX, 500));
    }

    // -- CloseRequested branching --

    #[test]
    fn prevent_close_main_window_with_tray() {
        assert!(should_prevent_close(MAIN_WINDOW_LABEL, true));
    }

    #[test]
    fn allow_close_main_window_without_tray() {
        assert!(!should_prevent_close(MAIN_WINDOW_LABEL, false));
    }

    #[test]
    fn allow_close_non_main_window_with_tray() {
        assert!(!should_prevent_close("dialog", true));
    }

    #[test]
    fn allow_close_non_main_window_without_tray() {
        assert!(!should_prevent_close("dialog", false));
    }

    #[test]
    fn allow_close_empty_label() {
        assert!(!should_prevent_close("", true));
    }

    // -- Destroyed cleanup guard --

    #[test]
    fn cleanup_runs_for_main_window() {
        assert!(should_run_cleanup(MAIN_WINDOW_LABEL));
    }

    #[test]
    fn cleanup_skips_for_dialog_window() {
        assert!(!should_run_cleanup("dialog"));
    }

    #[test]
    fn cleanup_skips_for_empty_label() {
        assert!(!should_run_cleanup(""));
    }

    #[test]
    fn cleanup_skips_for_similar_label() {
        // "main2" or "main-dialog" should not trigger cleanup.
        assert!(!should_run_cleanup("main2"));
        assert!(!should_run_cleanup("main-dialog"));
    }
}
