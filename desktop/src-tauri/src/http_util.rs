// Shared HTTP utilities for Tauri commands that make outbound requests from
// the Desktop host process.
//
// Extracted from `redmine_api_cmd` when a second caller (`llm_cmd`) needed the
// same size-bounded body reader (Rule of Three — two concrete consumers).
// Future outbound-HTTP commands should import from here rather than copy the
// streaming-body guard or reinvent the size limit.

/// Maximum response body size the Desktop will buffer from an outbound HTTP
/// request. Chosen to fit any legitimate JSON API response (Redmine project
/// lists, LLM model listings) while bounding OOM risk from a rogue or
/// misconfigured endpoint returning gigabytes of data via chunked transfer
/// encoding.
pub(crate) const MAX_RESPONSE_BODY_BYTES: usize = 5 * 1024 * 1024; // 5 MiB

/// Reads a response body chunk-by-chunk, aborting if the accumulated size
/// exceeds `MAX_RESPONSE_BODY_BYTES`. Prevents OOM from rogue servers using
/// chunked transfer encoding (no Content-Length header).
///
/// `label` is included in error messages so callers can identify which HTTP
/// operation failed (e.g. "Credentials validation", "LLM model discovery").
pub(crate) async fn read_body_limited(
    resp: reqwest::Response,
    label: &str,
) -> Result<Vec<u8>, String> {
    if let Some(len) = resp.content_length() {
        if len > MAX_RESPONSE_BODY_BYTES as u64 {
            return Err(format!(
                "{label} response too large ({len} bytes, limit {MAX_RESPONSE_BODY_BYTES})"
            ));
        }
    }

    let mut buf = Vec::with_capacity(
        resp.content_length()
            .map(|l| l as usize)
            .unwrap_or(4096)
            .min(MAX_RESPONSE_BODY_BYTES),
    );

    let mut stream = resp;
    while let Some(chunk) = stream
        .chunk()
        .await
        .map_err(|e| format!("Failed to read {label} response chunk: {e}"))?
    {
        if buf.len().saturating_add(chunk.len()) > MAX_RESPONSE_BODY_BYTES {
            return Err(format!(
                "{label} response too large (exceeded {MAX_RESPONSE_BODY_BYTES} byte limit)"
            ));
        }
        buf.extend_from_slice(&chunk);
    }

    Ok(buf)
}

/// Builds a `reqwest::Client` with the ADR-041 host-side hardening baseline:
/// no redirect following (SSRF defence), Speedwave User-Agent, plus any
/// caller-supplied default headers (e.g. `Authorization: Bearer …`, custom
/// per-tenant headers). Body-size cap and Content-Type allow-list are applied
/// per-request by [`read_body_limited`] / callsite policy.
///
/// Two callsites today (LLM probe, Redmine API) — extracting here keeps the
/// four hardening constants travelling together. Adding a third outbound
/// client = reuse this, do not retype the four lines.
pub(crate) fn build_hardened_client(
    default_headers: Option<reqwest::header::HeaderMap>,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(format!("Speedwave-Desktop/{}", env!("CARGO_PKG_VERSION")));
    if let Some(headers) = default_headers {
        builder = builder.default_headers(headers);
    }
    builder
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))
}

/// Translates the canonical container-side host alias to `127.0.0.1`. Host-side only.
///
/// Inside containers, `HOST_GATEWAY_ALIAS` resolves via `extra_hosts`. From the
/// Desktop host process the alias is absent (Speedwave doesn't bundle Docker
/// Desktop's resolver, and Lima's native `host.lima.internal` injection only
/// applies inside the VM — not on the macOS host) — this function rewrites it
/// to `127.0.0.1` before issuing HTTP requests.
///
/// Previously-supported aliases (`host.lima.internal`, `host.speedwave.internal`,
/// `host.containers.internal`) all return `None` after the SSOT consolidation;
/// callers must canonicalize to `HOST_GATEWAY_ALIAS` before invoking.
pub(crate) fn rewrite_container_alias_to_loopback(host: &str) -> Option<&'static str> {
    if host == speedwave_runtime::consts::HOST_GATEWAY_ALIAS {
        Some("127.0.0.1")
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn test_max_response_body_bytes_is_5_mib() {
        // Guard: changing this value affects multiple callers (Redmine + LLM
        // discovery). Update both tests and downstream error-message assertions
        // if you bump the limit.
        assert_eq!(MAX_RESPONSE_BODY_BYTES, 5 * 1024 * 1024);
    }

    #[test]
    fn test_rewrite_alias_host_docker_internal() {
        assert_eq!(
            rewrite_container_alias_to_loopback("host.docker.internal"),
            Some("127.0.0.1")
        );
    }

    // Regression negatives: deprecated aliases removed in the host-gateway SSOT
    // consolidation must not re-enter the rewrite path.

    #[test]
    fn test_rewrite_alias_deprecated_lima_returns_none() {
        assert_eq!(
            rewrite_container_alias_to_loopback("host.lima.internal"),
            None
        );
    }

    #[test]
    fn test_rewrite_alias_deprecated_containers_returns_none() {
        assert_eq!(
            rewrite_container_alias_to_loopback("host.containers.internal"),
            None
        );
    }

    #[test]
    fn test_rewrite_alias_deprecated_speedwave_returns_none() {
        assert_eq!(
            rewrite_container_alias_to_loopback("host.speedwave.internal"),
            None
        );
    }

    #[test]
    fn test_rewrite_alias_passthrough_localhost() {
        assert_eq!(rewrite_container_alias_to_loopback("localhost"), None);
    }

    #[test]
    fn test_rewrite_alias_passthrough_public_domain() {
        assert_eq!(rewrite_container_alias_to_loopback("example.com"), None);
    }

    #[test]
    fn test_rewrite_alias_passthrough_ipv4() {
        assert_eq!(rewrite_container_alias_to_loopback("192.168.1.1"), None);
    }
}
