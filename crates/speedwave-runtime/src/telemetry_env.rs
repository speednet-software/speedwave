//! SSOT for the mapping between telemetry fields and the `OTEL_*` /
//! `CLAUDE_CODE_ENABLE_TELEMETRY` env vars Claude Code reads. Every OTEL key
//! name is written exactly once here; resolve_telemetry and the env map read it.

use crate::config::{OtlpProtocol, ResolvedTelemetry};
use std::collections::HashMap;

/// The master telemetry switch — mapped separately (never an OTEL_* key).
pub const ENABLE_KEY: &str = "CLAUDE_CODE_ENABLE_TELEMETRY";

/// A telemetry field that maps to an env var. Each variant's env key is defined
/// once in [`env_key_for`]; `Enabled` is special (→ [`ENABLE_KEY`], not an OTEL key).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TelemetryField {
    /// Master switch (`CLAUDE_CODE_ENABLE_TELEMETRY`).
    Enabled,
    /// Collector endpoint URL.
    Endpoint,
    /// OTLP transport protocol.
    Protocol,
    /// Metrics exporter on/off.
    ExportMetrics,
    /// Logs/events exporter on/off.
    ExportLogs,
    /// Collector auth headers (secret).
    Headers,
    /// Custom resource attributes (team/cost tags).
    ResourceAttributes,
    /// Include the account UUID attribute in metrics.
    IncludeAccountUuid,
    /// Privacy gate: log user prompt content.
    LogUserPrompts,
    /// Privacy gate: log assistant response content.
    LogAssistantResponses,
    /// Privacy gate: log tool command/parameter details.
    LogToolDetails,
    /// Privacy gate: log raw API request/response bodies.
    LogRawApiBodies,
    /// Metrics export interval (ms).
    MetricExportInterval,
    /// Logs export interval (ms).
    LogsExportInterval,
}

impl TelemetryField {
    /// Every field, for iterating the field↔env-key mapping.
    pub const ALL: &'static [TelemetryField] = &[
        Self::Enabled,
        Self::Endpoint,
        Self::Protocol,
        Self::ExportMetrics,
        Self::ExportLogs,
        Self::Headers,
        Self::ResourceAttributes,
        Self::IncludeAccountUuid,
        Self::LogUserPrompts,
        Self::LogAssistantResponses,
        Self::LogToolDetails,
        Self::LogRawApiBodies,
        Self::MetricExportInterval,
        Self::LogsExportInterval,
    ];
}

/// The `OTEL_*` env key for a field, or `None` for `Enabled` (uses `ENABLE_KEY`).
pub fn env_key_for(field: TelemetryField) -> Option<&'static str> {
    use TelemetryField::*;
    Some(match field {
        Enabled => return None,
        Endpoint => "OTEL_EXPORTER_OTLP_ENDPOINT",
        Protocol => "OTEL_EXPORTER_OTLP_PROTOCOL",
        ExportMetrics => "OTEL_METRICS_EXPORTER",
        ExportLogs => "OTEL_LOGS_EXPORTER",
        Headers => "OTEL_EXPORTER_OTLP_HEADERS",
        ResourceAttributes => "OTEL_RESOURCE_ATTRIBUTES",
        IncludeAccountUuid => "OTEL_METRICS_INCLUDE_ACCOUNT_UUID",
        LogUserPrompts => "OTEL_LOG_USER_PROMPTS",
        LogAssistantResponses => "OTEL_LOG_ASSISTANT_RESPONSES",
        LogToolDetails => "OTEL_LOG_TOOL_DETAILS",
        LogRawApiBodies => "OTEL_LOG_RAW_API_BODIES",
        MetricExportInterval => "OTEL_METRIC_EXPORT_INTERVAL",
        LogsExportInterval => "OTEL_LOGS_EXPORT_INTERVAL",
    })
}

fn protocol_wire(p: OtlpProtocol) -> &'static str {
    match p {
        OtlpProtocol::Grpc => "grpc",
        OtlpProtocol::HttpProtobuf => "http/protobuf",
        OtlpProtocol::HttpJson => "http/json",
    }
}

fn key(f: TelemetryField) -> String {
    env_key_for(f).expect("field is env-mapped").to_string()
}

/// Full telemetry env for the resolved config. When disabled, only the master
/// switch (`0`) is emitted — no endpoint, headers, or exporters.
pub fn telemetry_env_map(t: &ResolvedTelemetry) -> HashMap<String, String> {
    use TelemetryField as F;
    let mut m = HashMap::new();
    if !t.enabled {
        m.insert(ENABLE_KEY.to_string(), "0".into());
        return m;
    }
    m.insert(ENABLE_KEY.to_string(), "1".into());
    if let Some(ep) = &t.endpoint {
        m.insert(key(F::Endpoint), ep.clone());
    }
    m.insert(key(F::Protocol), protocol_wire(t.protocol).into());
    if t.export_metrics {
        m.insert(key(F::ExportMetrics), "otlp".into());
    }
    if t.export_logs {
        m.insert(key(F::ExportLogs), "otlp".into());
    }
    if let Some(h) = &t.headers {
        m.insert(key(F::Headers), h.clone());
    }
    if let Some(ra) = &t.resource_attributes {
        m.insert(key(F::ResourceAttributes), ra.clone());
    }
    m.insert(key(F::IncludeAccountUuid), bool_str(t.include_account_uuid));
    m.insert(key(F::LogUserPrompts), bool01(t.log_user_prompts));
    m.insert(
        key(F::LogAssistantResponses),
        bool01(t.log_assistant_responses),
    );
    m.insert(key(F::LogToolDetails), bool01(t.log_tool_details));
    m.insert(key(F::LogRawApiBodies), bool01(t.log_raw_api_bodies));
    if let Some(v) = t.metric_export_interval_ms {
        m.insert(key(F::MetricExportInterval), v.to_string());
    }
    if let Some(v) = t.logs_export_interval_ms {
        m.insert(key(F::LogsExportInterval), v.to_string());
    }
    m
}

/// The subset of the telemetry env whose keys MDM locked — the payload for the
/// native managed-settings.json `env` block.
pub fn locked_env_map(t: &ResolvedTelemetry) -> HashMap<String, String> {
    telemetry_env_map(t)
        .into_iter()
        .filter(|(k, _)| t.locked_keys.contains(k))
        .collect()
}

fn bool01(b: bool) -> String {
    if b { "1" } else { "0" }.into()
}
fn bool_str(b: bool) -> String {
    if b { "true" } else { "false" }.into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::OtlpProtocol;
    use std::collections::BTreeSet;

    #[test]
    fn every_lockable_field_has_a_unique_env_key() {
        let mut seen = BTreeSet::new();
        for f in TelemetryField::ALL {
            if let Some(k) = env_key_for(*f) {
                assert!(seen.insert(k), "duplicate OTEL key for {f:?}");
            }
        }
        assert!(seen.contains("OTEL_EXPORTER_OTLP_ENDPOINT"));
        assert!(seen.contains("OTEL_EXPORTER_OTLP_HEADERS"));
    }

    #[test]
    fn enable_field_has_no_otel_key() {
        assert_eq!(env_key_for(TelemetryField::Enabled), None);
        assert_eq!(ENABLE_KEY, "CLAUDE_CODE_ENABLE_TELEMETRY");
    }

    fn enabled_sample() -> ResolvedTelemetry {
        ResolvedTelemetry {
            enabled: true,
            endpoint: Some("https://c.example.com:4318".into()),
            protocol: OtlpProtocol::HttpProtobuf,
            export_metrics: true,
            export_logs: true,
            headers: Some("Authorization=Bearer tok".into()),
            resource_attributes: Some("team=platform".into()),
            include_account_uuid: false,
            log_user_prompts: false,
            log_assistant_responses: false,
            log_tool_details: false,
            log_raw_api_bodies: false,
            metric_export_interval_ms: Some(10000),
            logs_export_interval_ms: None,
            locked_keys: Default::default(),
            any_locked: false,
            kill_switch: false,
        }
    }

    #[test]
    fn maps_core_enable_endpoint_exporters() {
        let m = telemetry_env_map(&enabled_sample());
        assert_eq!(m.get("CLAUDE_CODE_ENABLE_TELEMETRY").unwrap(), "1");
        assert_eq!(
            m.get("OTEL_EXPORTER_OTLP_ENDPOINT").unwrap(),
            "https://c.example.com:4318"
        );
        assert_eq!(
            m.get("OTEL_EXPORTER_OTLP_PROTOCOL").unwrap(),
            "http/protobuf"
        );
        assert_eq!(m.get("OTEL_METRICS_EXPORTER").unwrap(), "otlp");
        assert_eq!(m.get("OTEL_LOGS_EXPORTER").unwrap(), "otlp");
        assert_eq!(
            m.get("OTEL_EXPORTER_OTLP_HEADERS").unwrap(),
            "Authorization=Bearer tok"
        );
        assert_eq!(m.get("OTEL_METRIC_EXPORT_INTERVAL").unwrap(), "10000");
        assert!(!m.contains_key("OTEL_LOGS_EXPORT_INTERVAL"));
    }

    #[test]
    fn disabled_emits_only_master_switch_off() {
        let mut t = enabled_sample();
        t.enabled = false;
        t.endpoint = None;
        t.headers = None;
        t.export_metrics = false;
        t.export_logs = false;
        let m = telemetry_env_map(&t);
        assert_eq!(m.get("CLAUDE_CODE_ENABLE_TELEMETRY").unwrap(), "0");
        assert!(!m.contains_key("OTEL_EXPORTER_OTLP_ENDPOINT"));
        assert!(!m.contains_key("OTEL_EXPORTER_OTLP_HEADERS"));
    }

    #[test]
    fn locked_env_map_contains_only_locked_keys() {
        let mut t = enabled_sample();
        t.locked_keys.insert("OTEL_EXPORTER_OTLP_ENDPOINT".into());
        let m = locked_env_map(&t);
        assert_eq!(m.len(), 1);
        assert_eq!(
            m.get("OTEL_EXPORTER_OTLP_ENDPOINT").unwrap(),
            "https://c.example.com:4318"
        );
    }

    #[test]
    fn every_lockable_key_is_emittable_by_env_map() {
        let full = ResolvedTelemetry {
            enabled: true,
            endpoint: Some("https://c:4318".into()),
            protocol: OtlpProtocol::Grpc,
            export_metrics: true,
            export_logs: true,
            headers: Some("Authorization=Bearer x".into()),
            resource_attributes: Some("a=b".into()),
            include_account_uuid: true,
            log_user_prompts: true,
            log_assistant_responses: true,
            log_tool_details: true,
            log_raw_api_bodies: true,
            metric_export_interval_ms: Some(1),
            logs_export_interval_ms: Some(1),
            locked_keys: Default::default(),
            any_locked: false,
            kill_switch: false,
        };
        let emittable: BTreeSet<String> = telemetry_env_map(&full).into_keys().collect();
        for f in TelemetryField::ALL {
            if let Some(k) = env_key_for(*f) {
                assert!(
                    emittable.contains(k),
                    "SSOT lockable key {k} is not emittable by telemetry_env_map — MDM lock would silently drop"
                );
            }
        }
    }
}
