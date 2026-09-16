use super::MAIN_WINDOW_LABEL;
use tauri::Manager;

/// Returns `true` if a click should be suppressed (debounced): elapsed since
/// the previous click (`now_ms.saturating_sub(prev_ms)`) is `< threshold_ms`.
pub(crate) fn should_debounce(prev_ms: u64, now_ms: u64, threshold_ms: u64) -> bool {
    now_ms.saturating_sub(prev_ms) < threshold_ms
}

/// Whether `CloseRequested` should be intercepted: `true` prevents close + hides,
/// `false` lets the close proceed (app exits).
pub(crate) fn should_prevent_close(window_label: &str, tray_available: bool) -> bool {
    window_label == MAIN_WINDOW_LABEL && tray_available
}

/// Returns `true` if the `Destroyed` event should trigger cleanup (main window only).
pub(crate) fn should_run_cleanup(window_label: &str) -> bool {
    window_label == MAIN_WINDOW_LABEL
}

/// Whether a `Focused` event should notify the frontend: main window regaining
/// focus only — lets a throttled poll (e.g. OAuth completion) catch up.
pub(crate) fn should_emit_focus_event(window_label: &str, focused: bool) -> bool {
    window_label == MAIN_WINDOW_LABEL && focused
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(!should_debounce(1000, 1500, 500));
    }

    #[test]
    fn debounce_suppresses_when_clock_goes_backward() {
        assert!(should_debounce(5000, 3000, 500));
    }

    #[test]
    fn debounce_allows_first_click_ever() {
        assert!(!should_debounce(0, 1_700_000_000_000, 500));
    }

    #[test]
    fn debounce_suppresses_zero_elapsed() {
        assert!(should_debounce(1000, 1000, 500));
    }

    #[test]
    fn debounce_allows_with_zero_threshold() {
        assert!(!should_debounce(1000, 1000, 0));
    }

    #[test]
    fn debounce_handles_u64_max_prev() {
        assert!(should_debounce(u64::MAX, 1000, 500));
    }

    #[test]
    fn debounce_handles_u64_max_now() {
        assert!(!should_debounce(0, u64::MAX, 500));
    }

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
        assert!(!should_run_cleanup("main2"));
        assert!(!should_run_cleanup("main-dialog"));
    }

    #[test]
    fn focus_event_emitted_for_main_window_gaining_focus() {
        assert!(should_emit_focus_event(MAIN_WINDOW_LABEL, true));
    }

    #[test]
    fn focus_event_skipped_for_main_window_losing_focus() {
        assert!(!should_emit_focus_event(MAIN_WINDOW_LABEL, false));
    }

    #[test]
    fn focus_event_skipped_for_dialog_window_gaining_focus() {
        assert!(!should_emit_focus_event("dialog", true));
    }

    #[test]
    fn focus_event_skipped_for_empty_label() {
        assert!(!should_emit_focus_event("", true));
    }
}
