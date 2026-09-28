/// Maximum response body size (5 MiB) to prevent OOM from rogue servers.
pub(crate) const MAX_RESPONSE_BODY_BYTES: usize = 5 * 1024 * 1024;

/// Default request timeout (ADR-041). A stalled upstream must not hang the
/// command; discovery probes override this per-request with their own value.
pub(crate) const DEFAULT_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Reads a body chunk-by-chunk, aborting past `MAX_RESPONSE_BODY_BYTES`.
/// `label` identifies the failed HTTP operation in error messages.
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

/// Builds a `reqwest::Client` with the ADR-041 hardening baseline: no redirects,
/// default timeout, Speedwave UA, plus caller-supplied default headers.
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

/// `err` and every `source()` under it, joined with `: `; reqwest's own Display stops at
/// "error sending request", which hides whether DNS, TCP or TLS failed.
pub(crate) fn error_chain(err: &dyn std::error::Error) -> String {
    let mut chain = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        chain.push_str(": ");
        chain.push_str(&cause.to_string());
        source = cause.source();
    }
    chain
}

/// Translates the container host alias to `127.0.0.1` (host-side only).
/// Returns `None` for any host other than `HOST_GATEWAY_ALIAS`.
pub(crate) fn rewrite_container_alias_to_loopback(host: &str) -> Option<&'static str> {
    if host == speedwave_runtime::consts::HOST_GATEWAY_ALIAS {
        Some("127.0.0.1")
    } else {
        None
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code")]
mod tests {
    use super::*;

    #[test]
    fn test_max_response_body_bytes_is_5_mib() {
        assert_eq!(MAX_RESPONSE_BODY_BYTES, 5 * 1024 * 1024);
    }

    #[test]
    fn test_hardened_client_has_default_timeout() {
        assert!(DEFAULT_REQUEST_TIMEOUT > std::time::Duration::ZERO);
        assert!(build_hardened_client(None).is_ok());
    }

    #[derive(Debug)]
    struct Layer {
        message: &'static str,
        source: Option<Box<Layer>>,
    }

    impl std::fmt::Display for Layer {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.message)
        }
    }

    impl std::error::Error for Layer {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            self.source
                .as_deref()
                .map(|inner| inner as &(dyn std::error::Error + 'static))
        }
    }

    #[test]
    fn test_error_chain_joins_every_source() {
        let err = Layer {
            message: "error sending request",
            source: Some(Box::new(Layer {
                message: "client error (Connect)",
                source: Some(Box::new(Layer {
                    message: "Connection refused",
                    source: None,
                })),
            })),
        };
        assert_eq!(
            error_chain(&err),
            "error sending request: client error (Connect): Connection refused"
        );
    }

    #[test]
    fn test_error_chain_of_a_sourceless_error_is_its_message() {
        let err = std::io::Error::other("plain failure");
        assert_eq!(error_chain(&err), "plain failure");
    }

    #[tokio::test]
    async fn test_error_chain_names_the_cause_of_a_refused_connection() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let err = build_hardened_client(None)
            .unwrap()
            .get(format!("http://127.0.0.1:{port}/v1/models"))
            .send()
            .await
            .unwrap_err();
        let chain = error_chain(&err);
        assert!(chain.len() > err.to_string().len(), "{chain}");
        assert!(chain.contains("os error"), "{chain}");
    }

    #[test]
    fn test_rewrite_alias_host_docker_internal() {
        assert_eq!(
            rewrite_container_alias_to_loopback("host.docker.internal"),
            Some("127.0.0.1")
        );
    }

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
