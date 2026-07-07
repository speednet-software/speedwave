// Resolves microphone consent from the GUI app process so the TCC prompt can
// fire and the grant lands under the app bundle id (spawned CLIs inherit it).

use serde::Serialize;

/// Outcome of a mic-consent resolution; mirrored by `models/transcript.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MicPermission {
    /// Mic access is (now, or already) granted.
    Granted,
    /// The user declined the consent prompt just shown.
    Denied,
    /// Consent was refused earlier — only System Settings can re-enable it.
    PreviouslyDenied,
}

/// Pre-prompt decision derived from a raw `AVAuthorizationStatus` value.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StatusDecision {
    Granted,
    PreviouslyDenied,
    NeedsPrompt,
    Denied,
}

/// Maps `AVAuthorizationStatus` (0..=3); unknown future values fail closed.
#[cfg(any(target_os = "macos", test))]
fn classify_authorization_status(raw: isize) -> StatusDecision {
    match raw {
        0 => StatusDecision::NeedsPrompt,
        1 | 2 => StatusDecision::PreviouslyDenied,
        3 => StatusDecision::Granted,
        _ => StatusDecision::Denied,
    }
}

/// Non-prompting mic-consent state; mirrored by `models/transcript.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MicPermissionStatus {
    /// Mic access is granted.
    Granted,
    /// Consent was refused (or restricted by policy).
    Denied,
    /// Never asked — the prompt will appear on the first request.
    Undetermined,
}

/// Status shown in Settings for a pre-prompt decision.
#[cfg(any(target_os = "macos", test))]
fn status_from_decision(d: StatusDecision) -> MicPermissionStatus {
    match d {
        StatusDecision::Granted => MicPermissionStatus::Granted,
        StatusDecision::NeedsPrompt => MicPermissionStatus::Undetermined,
        StatusDecision::PreviouslyDenied | StatusDecision::Denied => MicPermissionStatus::Denied,
    }
}

#[cfg(target_os = "macos")]
// FFI boundary — `unsafe_code` is allowed only here; each block carries SAFETY docs.
#[allow(unsafe_code)]
mod imp {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVCaptureDevice, AVMediaTypeAudio};

    use super::{classify_authorization_status, MicPermission, StatusDecision};

    /// Current `AVAuthorizationStatus` for audio, classified — never prompts.
    pub fn status_decision() -> Result<StatusDecision, String> {
        // SAFETY: pure status query; AVMediaTypeAudio is a linked constant.
        let raw = unsafe {
            let Some(media) = AVMediaTypeAudio else {
                return Err("AVMediaTypeAudio unavailable".to_string());
            };
            AVCaptureDevice::authorizationStatusForMediaType(media).0
        };
        Ok(classify_authorization_status(raw))
    }

    /// Resolves consent: prompts when undetermined, never re-prompts otherwise.
    pub async fn resolve() -> Result<MicPermission, String> {
        match status_decision()? {
            StatusDecision::Granted => Ok(MicPermission::Granted),
            StatusDecision::PreviouslyDenied => Ok(MicPermission::PreviouslyDenied),
            StatusDecision::Denied => Ok(MicPermission::Denied),
            StatusDecision::NeedsPrompt => {
                let granted = tauri::async_runtime::spawn_blocking(request_access_blocking)
                    .await
                    .map_err(|e| format!("microphone consent task failed: {e}"))?;
                Ok(if granted {
                    MicPermission::Granted
                } else {
                    MicPermission::Denied
                })
            }
        }
    }

    /// Shows the OS consent prompt and blocks until the user answers it.
    fn request_access_blocking() -> bool {
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        // AVFoundation may invoke the handler on any queue — Mutex keeps it `Fn`+`Sync`.
        let tx = std::sync::Mutex::new(Some(tx));
        let handler = RcBlock::new(move |granted: Bool| {
            if let Some(sender) = tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = sender.send(granted.as_bool());
            }
        });
        // SAFETY: media type is a linked non-null constant; AVFoundation retains
        // the handler block until it fires the async callback.
        unsafe {
            let Some(media) = AVMediaTypeAudio else {
                return false;
            };
            AVCaptureDevice::requestAccessForMediaType_completionHandler(media, &handler);
        }
        // The user may ponder the prompt for minutes; the cap is only a hang guard.
        rx.recv_timeout(std::time::Duration::from_secs(600))
            .unwrap_or(false)
    }
}

/// Resolves mic consent before a capture spawn: shows the macOS TCC prompt when
/// undetermined; reports granted on platforms without a per-app mic prompt.
#[tauri::command]
pub async fn request_microphone_permission() -> Result<MicPermission, String> {
    #[cfg(target_os = "macos")]
    {
        imp::resolve().await
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(MicPermission::Granted)
    }
}

/// Reports the mic-consent state without ever showing a prompt (Settings UI);
/// platforms without a per-app mic prompt always report granted.
#[tauri::command]
pub fn microphone_permission_status() -> Result<MicPermissionStatus, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(status_from_decision(imp::status_decision()?))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(MicPermissionStatus::Granted)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn mic_permission_serializes_snake_case() {
        assert_eq!(
            serde_json::to_value(MicPermission::Granted).unwrap(),
            "granted"
        );
        assert_eq!(
            serde_json::to_value(MicPermission::Denied).unwrap(),
            "denied"
        );
        assert_eq!(
            serde_json::to_value(MicPermission::PreviouslyDenied).unwrap(),
            "previously_denied"
        );
    }

    #[test]
    fn classify_authorization_status_maps_every_av_status() {
        assert_eq!(
            classify_authorization_status(0),
            StatusDecision::NeedsPrompt
        );
        assert_eq!(
            classify_authorization_status(1),
            StatusDecision::PreviouslyDenied
        );
        assert_eq!(
            classify_authorization_status(2),
            StatusDecision::PreviouslyDenied
        );
        assert_eq!(classify_authorization_status(3), StatusDecision::Granted);
        // Unknown future statuses fail closed: no prompt, reported as denied.
        assert_eq!(classify_authorization_status(4), StatusDecision::Denied);
        assert_eq!(classify_authorization_status(-1), StatusDecision::Denied);
    }

    #[test]
    fn mic_permission_matches_ts_union() {
        let all = [
            MicPermission::Granted,
            MicPermission::Denied,
            MicPermission::PreviouslyDenied,
        ];
        // Exhaustiveness gate: a new variant fails to compile until added above.
        for p in all {
            match p {
                MicPermission::Granted
                | MicPermission::Denied
                | MicPermission::PreviouslyDenied => {}
            }
        }
        let mut rust: Vec<String> = all
            .iter()
            .map(|p| {
                serde_json::to_value(p)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        rust.sort();

        let src = include_str!("../../src/src/app/models/transcript.ts");
        let marker = "export type MicPermission =";
        let idx = src
            .find(marker)
            .expect("transcript.ts must declare `export type MicPermission`");
        let union = src[idx + marker.len()..].split(';').next().unwrap_or("");
        let mut ts: Vec<String> = union
            .split('|')
            .map(|s| s.trim().trim_matches('\'').to_string())
            .filter(|s| !s.is_empty())
            .collect();
        ts.sort();

        assert_eq!(
            rust, ts,
            "TS MicPermission union must match Rust MicPermission serde strings"
        );
    }

    #[test]
    fn mic_permission_status_serializes_snake_case_and_matches_ts_union() {
        let all = [
            MicPermissionStatus::Granted,
            MicPermissionStatus::Denied,
            MicPermissionStatus::Undetermined,
        ];
        // Exhaustiveness gate: a new variant fails to compile until added above.
        for s in all {
            match s {
                MicPermissionStatus::Granted
                | MicPermissionStatus::Denied
                | MicPermissionStatus::Undetermined => {}
            }
        }
        let mut rust: Vec<String> = all
            .iter()
            .map(|s| {
                serde_json::to_value(s)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        rust.sort();

        let src = include_str!("../../src/src/app/models/transcript.ts");
        let marker = "export type MicPermissionStatus =";
        let idx = src
            .find(marker)
            .expect("transcript.ts must declare `export type MicPermissionStatus`");
        let union = src[idx + marker.len()..].split(';').next().unwrap_or("");
        let mut ts: Vec<String> = union
            .split('|')
            .map(|s| s.trim().trim_matches('\'').to_string())
            .filter(|s| !s.is_empty())
            .collect();
        ts.sort();

        assert_eq!(
            rust, ts,
            "TS MicPermissionStatus union must match Rust serde strings"
        );
    }

    #[test]
    fn status_from_decision_never_prompts_and_fails_closed() {
        assert_eq!(
            status_from_decision(StatusDecision::Granted),
            MicPermissionStatus::Granted
        );
        assert_eq!(
            status_from_decision(StatusDecision::NeedsPrompt),
            MicPermissionStatus::Undetermined
        );
        assert_eq!(
            status_from_decision(StatusDecision::PreviouslyDenied),
            MicPermissionStatus::Denied
        );
        assert_eq!(
            status_from_decision(StatusDecision::Denied),
            MicPermissionStatus::Denied
        );
    }

    #[cfg(not(target_os = "macos"))]
    #[tokio::test]
    async fn request_microphone_permission_reports_granted_off_macos() {
        // Windows desktop apps get no per-app mic prompt — the command must not gate.
        assert_eq!(
            request_microphone_permission().await,
            Ok(MicPermission::Granted)
        );
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn microphone_permission_status_reports_granted_off_macos() {
        assert_eq!(
            microphone_permission_status(),
            Ok(MicPermissionStatus::Granted)
        );
    }
}
