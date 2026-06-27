// Shared HTTP utilities for Tauri commands that make outbound requests from
// the Desktop host process.

/// Maximum response body size (5 MiB) to prevent OOM from rogue servers.
pub(crate) const MAX_RESPONSE_BODY_BYTES: usize = 5 * 1024 * 1024; // 5 MiB

/// Default request timeout (ADR-041). A stalled upstream must not hang the
/// command; discovery probes override this per-request with their own value.
pub(crate) const DEFAULT_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Reads a response body chunk-by-chunk, aborting if the accumulated size
/// exceeds `MAX_RESPONSE_BODY_BYTES`.
///
/// `label` is included in error messages to identify the failed HTTP operation.
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
/// no redirect following (SSRF defence), a default request timeout, Speedwave
/// User-Agent, plus any caller-supplied default headers (e.g. `Authorization`).
pub(crate) fn build_hardened_client(
    default_headers: Option<reqwest::header::HeaderMap>,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(DEFAULT_REQUEST_TIMEOUT)
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
/// Returns `None` for any host other than `HOST_GATEWAY_ALIAS`.
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
        // Changing this value requires updating Redmine + LLM discovery tests.
        assert_eq!(MAX_RESPONSE_BODY_BYTES, 5 * 1024 * 1024);
    }

    #[test]
    fn test_hardened_client_has_default_timeout() {
        // ADR-041 baseline: a stalled upstream must not hang a command forever.
        assert!(DEFAULT_REQUEST_TIMEOUT > std::time::Duration::ZERO);
        assert!(build_hardened_client(None).is_ok());
    }

    #[test]
    fn test_rewrite_alias_host_docker_internal() {
        assert_eq!(
            rewrite_container_alias_to_loopback("host.docker.internal"),
            Some("127.0.0.1")
        );
    }

    // Deprecated aliases must not re-enter the rewrite path.

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
