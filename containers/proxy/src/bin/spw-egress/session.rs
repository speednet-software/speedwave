use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

use crate::allowlist::ConfigStore;
use crate::head::{parse_connect, read_head, TargetError};
use crate::resolve::{is_forbidden_target, Resolver};
use crate::sni::{client_hello_sni, read_first_record, SniError};
use crate::splice::splice;

pub(crate) const DECISION_TARGET: &str = "spw_egress::decision";

const ESTABLISHED: &[u8] = b"HTTP/1.1 200 Connection Established\r\n\r\n";
const BAD_REQUEST: &[u8] =
    b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const FORBIDDEN: &[u8] =
    b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const METHOD_NOT_ALLOWED: &[u8] =
    b"HTTP/1.1 405 Method Not Allowed\r\nAllow: CONNECT\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const BAD_GATEWAY: &[u8] =
    b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

#[derive(Clone, Copy, Debug)]
pub(crate) struct Limits {
    pub(crate) head_timeout: Duration,
    pub(crate) dns_timeout: Duration,
    pub(crate) connect_timeout: Duration,
    pub(crate) hello_timeout: Duration,
    pub(crate) idle_timeout: Duration,
    pub(crate) max_bytes: u64,
}

impl Limits {
    pub(crate) const PRODUCTION: Self = Self {
        head_timeout: Duration::from_secs(10),
        dns_timeout: Duration::from_secs(5),
        connect_timeout: Duration::from_secs(10),
        hello_timeout: Duration::from_secs(10),
        idle_timeout: Duration::from_secs(300),
        max_bytes: 1 << 30,
    };
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DenyReason {
    BadRequest,
    Method,
    IpLiteral,
    ConfigUnavailable,
    NotAllowlisted,
    DnsFailure,
    PrivateAddress,
    ConnectFailed,
    NotClientHello,
    NoSni,
    SniMismatch,
}

impl DenyReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::BadRequest => "bad_request",
            Self::Method => "method",
            Self::IpLiteral => "ip_literal",
            Self::ConfigUnavailable => "config_unavailable",
            Self::NotAllowlisted => "not_allowlisted",
            Self::DnsFailure => "dns_failure",
            Self::PrivateAddress => "private_address",
            Self::ConnectFailed => "connect_failed",
            Self::NotClientHello => "not_client_hello",
            Self::NoSni => "no_sni",
            Self::SniMismatch => "sni_mismatch",
        }
    }

    fn response(self) -> Option<&'static [u8]> {
        match self {
            Self::BadRequest => Some(BAD_REQUEST),
            Self::Method => Some(METHOD_NOT_ALLOWED),
            Self::IpLiteral
            | Self::ConfigUnavailable
            | Self::NotAllowlisted
            | Self::PrivateAddress => Some(FORBIDDEN),
            Self::DnsFailure | Self::ConnectFailed => Some(BAD_GATEWAY),
            Self::NotClientHello | Self::NoSni | Self::SniMismatch => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Decision {
    pub(crate) host: Option<String>,
    pub(crate) port: Option<u16>,
    pub(crate) denied: Option<DenyReason>,
}

impl Decision {
    fn deny(host: Option<String>, port: Option<u16>, reason: DenyReason) -> Self {
        Self {
            host,
            port,
            denied: Some(reason),
        }
    }

    pub(crate) fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "event": "egress",
            "decision": if self.denied.is_some() { "deny" } else { "allow" },
            "host": self.host,
            "port": self.port,
            "reason": self.denied.map(DenyReason::as_str),
        })
    }
}

struct Tunnel {
    upstream: TcpStream,
    first_bytes: Vec<u8>,
    decision: Decision,
}

pub(crate) struct Egress<R: Resolver> {
    config: ConfigStore,
    resolver: R,
    forbidden: fn(IpAddr) -> bool,
    limits: Limits,
}

impl<R: Resolver> Egress<R> {
    pub(crate) fn new(config_path: PathBuf, resolver: R) -> Self {
        Self {
            config: ConfigStore::new(config_path),
            resolver,
            forbidden: is_forbidden_target,
            limits: Limits::PRODUCTION,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_policy(
        config_path: PathBuf,
        resolver: R,
        forbidden: fn(IpAddr) -> bool,
        limits: Limits,
    ) -> Self {
        Self {
            config: ConfigStore::new(config_path),
            resolver,
            forbidden,
            limits,
        }
    }

    pub(crate) async fn handle(&self, mut client: TcpStream) -> Decision {
        match self.open(&mut client).await {
            Err(decision) => {
                log_decision(&decision);
                if let Some(response) = decision.denied.and_then(DenyReason::response) {
                    let _ = client.write_all(response).await;
                }
                let _ = client.shutdown().await;
                decision
            }
            Ok(mut tunnel) => {
                log_decision(&tunnel.decision);
                if tunnel.upstream.write_all(&tunnel.first_bytes).await.is_ok() {
                    let sent = u64::try_from(tunnel.first_bytes.len()).unwrap_or(u64::MAX);
                    splice(
                        client,
                        tunnel.upstream,
                        self.limits.idle_timeout,
                        self.limits.max_bytes,
                        sent,
                    )
                    .await;
                }
                tunnel.decision
            }
        }
    }

    async fn open(&self, client: &mut TcpStream) -> Result<Tunnel, Decision> {
        let raw = read_head(client, self.limits.head_timeout)
            .await
            .map_err(|_| Decision::deny(None, None, DenyReason::BadRequest))?;
        let (host, port) = parse_connect(&raw.head).map_err(|e| match e {
            TargetError::Method => Decision::deny(None, None, DenyReason::Method),
            TargetError::Malformed => Decision::deny(None, None, DenyReason::BadRequest),
            TargetError::IpLiteral { ip, port } => {
                Decision::deny(ip.map(|ip| ip.to_string()), port, DenyReason::IpLiteral)
            }
        })?;
        let deny = |reason| Decision::deny(Some(host.clone()), Some(port), reason);
        let allowlist = self
            .config
            .current()
            .ok_or_else(|| deny(DenyReason::ConfigUnavailable))?;
        if !allowlist.allows(&host, port) {
            return Err(deny(DenyReason::NotAllowlisted));
        }
        let addrs =
            tokio::time::timeout(self.limits.dns_timeout, self.resolver.resolve(&host, port))
                .await
                .ok()
                .and_then(Result::ok)
                .filter(|addrs| !addrs.is_empty())
                .ok_or_else(|| deny(DenyReason::DnsFailure))?;
        if addrs.iter().any(|addr| (self.forbidden)(addr.ip())) {
            return Err(deny(DenyReason::PrivateAddress));
        }
        let pinned = SocketAddr::new(addrs[0].ip(), port);
        let upstream =
            tokio::time::timeout(self.limits.connect_timeout, TcpStream::connect(pinned))
                .await
                .ok()
                .and_then(Result::ok)
                .ok_or_else(|| deny(DenyReason::ConnectFailed))?;
        client
            .write_all(ESTABLISHED)
            .await
            .map_err(|_| deny(DenyReason::NotClientHello))?;
        let first = read_first_record(client, raw.leftover, self.limits.hello_timeout)
            .await
            .map_err(|_| deny(DenyReason::NotClientHello))?;
        let sni = client_hello_sni(&first.bytes[..first.record_len]).map_err(|e| match e {
            SniError::NoSni => deny(DenyReason::NoSni),
            SniError::NotClientHello => deny(DenyReason::NotClientHello),
        })?;
        if sni != host {
            return Err(deny(DenyReason::SniMismatch));
        }
        Ok(Tunnel {
            upstream,
            first_bytes: first.bytes,
            decision: Decision {
                host: Some(host),
                port: Some(port),
                denied: None,
            },
        })
    }
}

fn log_decision(decision: &Decision) {
    log::info!(target: DECISION_TARGET, "{}", decision.to_json());
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::unwrap_used,
        reason = "test fixture setup, failure aborts the test"
    )]
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use tokio::io::AsyncReadExt;
    use tokio::net::TcpListener;

    use super::*;
    use crate::sni::fixtures::{client_hello, client_hello_for};

    const TEST_HOST: &str = "upstream.test";

    struct ScriptedResolver {
        answers: Mutex<VecDeque<Vec<IpAddr>>>,
        calls: AtomicUsize,
    }

    impl ScriptedResolver {
        fn new(answers: &[&[&str]]) -> Arc<Self> {
            Arc::new(Self {
                answers: Mutex::new(
                    answers
                        .iter()
                        .map(|ips| ips.iter().map(|ip| ip.parse().unwrap()).collect())
                        .collect(),
                ),
                calls: AtomicUsize::new(0),
            })
        }
    }

    impl Resolver for Arc<ScriptedResolver> {
        async fn resolve(&self, _host: &str, port: u16) -> std::io::Result<Vec<SocketAddr>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let ips = self.answers.lock().unwrap().pop_front().unwrap_or_default();
            Ok(ips
                .into_iter()
                .map(|ip| SocketAddr::new(ip, port))
                .collect())
        }
    }

    struct FailingResolver;

    impl Resolver for FailingResolver {
        async fn resolve(&self, _host: &str, _port: u16) -> std::io::Result<Vec<SocketAddr>> {
            Err(std::io::Error::other("no such host"))
        }
    }

    fn forbid_ten_slash_eight(ip: IpAddr) -> bool {
        matches!(ip, IpAddr::V4(v4) if v4.octets()[0] == 10)
    }

    fn test_limits() -> Limits {
        Limits {
            head_timeout: Duration::from_secs(5),
            dns_timeout: Duration::from_secs(5),
            connect_timeout: Duration::from_secs(5),
            hello_timeout: Duration::from_secs(5),
            idle_timeout: Duration::from_secs(5),
            max_bytes: 1 << 20,
        }
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        path: PathBuf,
    }

    fn config(allow: &[String]) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("egress.json");
        let json = serde_json::json!({ "version": 1, "allow": allow });
        std::fs::write(&path, json.to_string()).unwrap();
        Fixture { _dir: dir, path }
    }

    async fn echo_upstream() -> (u16, tokio::task::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut seen = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = socket.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    return seen;
                }
                seen.extend_from_slice(&buf[..n]);
                if socket.write_all(&buf[..n]).await.is_err() {
                    return seen;
                }
            }
        });
        (port, task)
    }

    async fn run<R: Resolver>(egress: Egress<R>) -> (TcpStream, tokio::task::JoinHandle<Decision>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            egress.handle(socket).await
        });
        (TcpStream::connect(addr).await.unwrap(), task)
    }

    async fn response_line(client: &mut TcpStream) -> String {
        let mut response = Vec::new();
        let mut byte = [0u8; 1];
        while !response.ends_with(b"\r\n\r\n") {
            if client.read(&mut byte).await.unwrap() == 0 {
                break;
            }
            response.push(byte[0]);
        }
        String::from_utf8(response)
            .unwrap()
            .lines()
            .next()
            .unwrap_or_default()
            .to_string()
    }

    async fn connect(client: &mut TcpStream, target: &str) -> String {
        let head = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n");
        client.write_all(head.as_bytes()).await.unwrap();
        response_line(client).await
    }

    async fn assert_closed(client: &mut TcpStream) {
        let mut rest = Vec::new();
        let _ = client.read_to_end(&mut rest).await;
        assert!(rest.is_empty());
    }

    fn denied(host: Option<&str>, port: Option<u16>, reason: DenyReason) -> Decision {
        Decision::deny(host.map(str::to_string), port, reason)
    }

    #[tokio::test]
    async fn allowlisted_host_is_tunnelled_with_the_client_hello_forwarded_first() {
        let (port, upstream) = echo_upstream().await;
        let fixture = config(&[format!("{TEST_HOST}:{port}")]);
        let resolver = ScriptedResolver::new(&[&["127.0.0.1"]]);
        let egress = Egress::with_policy(
            fixture.path.clone(),
            Arc::clone(&resolver),
            forbid_ten_slash_eight,
            test_limits(),
        );
        let (mut client, task) = run(egress).await;
        let target = format!("{TEST_HOST}:{port}");
        assert_eq!(
            connect(&mut client, &target).await,
            "HTTP/1.1 200 Connection Established"
        );
        let hello = client_hello_for("Upstream.TEST");
        client.write_all(&hello).await.unwrap();
        client.write_all(b"after-hello").await.unwrap();
        let mut echoed = vec![0u8; hello.len() + 11];
        client.read_exact(&mut echoed).await.unwrap();
        drop(client);
        let seen = upstream.await.unwrap();
        let mut expected = hello.clone();
        expected.extend_from_slice(b"after-hello");
        assert_eq!(seen, expected);
        assert_eq!(echoed, expected);
        let decision = task.await.unwrap();
        assert_eq!(
            decision,
            Decision {
                host: Some(TEST_HOST.to_string()),
                port: Some(port),
                denied: None
            }
        );
        assert_eq!(resolver.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn dns_rebinding_cannot_swap_the_address_after_the_check() {
        let (port, upstream) = echo_upstream().await;
        let fixture = config(&[format!("{TEST_HOST}:{port}")]);
        let resolver = ScriptedResolver::new(&[&["127.0.0.1"], &["10.0.0.1"]]);
        let egress = Egress::with_policy(
            fixture.path.clone(),
            Arc::clone(&resolver),
            forbid_ten_slash_eight,
            test_limits(),
        );
        let (mut client, task) = run(egress).await;
        assert_eq!(
            connect(&mut client, &format!("{TEST_HOST}:{port}")).await,
            "HTTP/1.1 200 Connection Established"
        );
        let hello = client_hello_for(TEST_HOST);
        client.write_all(&hello).await.unwrap();
        let mut echoed = vec![0u8; hello.len()];
        client.read_exact(&mut echoed).await.unwrap();
        drop(client);
        assert_eq!(upstream.await.unwrap(), hello);
        assert!(task.await.unwrap().denied.is_none());
        assert_eq!(resolver.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn any_private_answer_refuses_the_connection_before_connecting() {
        for answer in [
            &["1.1.1.1", "10.0.0.1"][..],
            &["127.0.0.1"],
            &["100.64.0.1"],
            &["169.254.169.254"],
            &["::ffff:192.168.1.1"],
            &["fd00::1"],
        ] {
            let fixture = config(&["api.example.com:443".to_string()]);
            let resolver = ScriptedResolver::new(&[answer]);
            let egress = Egress::new(fixture.path.clone(), Arc::clone(&resolver));
            let (mut client, task) = run(egress).await;
            assert_eq!(
                connect(&mut client, "api.example.com:443").await,
                "HTTP/1.1 403 Forbidden",
                "{answer:?}"
            );
            assert_closed(&mut client).await;
            assert_eq!(
                task.await.unwrap(),
                denied(
                    Some("api.example.com"),
                    Some(443),
                    DenyReason::PrivateAddress
                )
            );
        }
    }

    #[tokio::test]
    async fn host_outside_the_allowlist_is_refused_without_resolving() {
        let fixture = config(&["api.example.com:443".to_string()]);
        let resolver = ScriptedResolver::new(&[&["1.1.1.1"]]);
        let egress = Egress::new(fixture.path.clone(), Arc::clone(&resolver));
        let (mut client, task) = run(egress).await;
        assert_eq!(
            connect(&mut client, "evil.example.net:443").await,
            "HTTP/1.1 403 Forbidden"
        );
        assert_eq!(
            task.await.unwrap(),
            denied(
                Some("evil.example.net"),
                Some(443),
                DenyReason::NotAllowlisted
            )
        );
        assert_eq!(resolver.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn port_mismatch_is_not_allowlisted() {
        let fixture = config(&["api.example.com:443".to_string()]);
        let egress = Egress::new(fixture.path.clone(), FailingResolver);
        let (mut client, task) = run(egress).await;
        assert_eq!(
            connect(&mut client, "api.example.com:22").await,
            "HTTP/1.1 403 Forbidden"
        );
        assert_eq!(task.await.unwrap().denied, Some(DenyReason::NotAllowlisted));
    }

    #[tokio::test]
    async fn get_request_is_answered_405() {
        let fixture = config(&[]);
        let egress = Egress::new(fixture.path.clone(), FailingResolver);
        let (mut client, task) = run(egress).await;
        client
            .write_all(b"GET http://api.example.com/ HTTP/1.1\r\nHost: api.example.com\r\n\r\n")
            .await
            .unwrap();
        assert_eq!(
            response_line(&mut client).await,
            "HTTP/1.1 405 Method Not Allowed"
        );
        assert_closed(&mut client).await;
        assert_eq!(task.await.unwrap(), denied(None, None, DenyReason::Method));
    }

    #[tokio::test]
    async fn malformed_and_oversized_heads_are_answered_400() {
        let mut oversized = b"CONNECT a.example.com:443 HTTP/1.1\r\nX: ".to_vec();
        oversized.resize(crate::head::MAX_HEAD_BYTES, b'a');
        for head in [
            b"CONNECT api.example.com HTTP/1.1\r\n\r\n".to_vec(),
            oversized,
        ] {
            let fixture = config(&[]);
            let egress = Egress::new(fixture.path.clone(), FailingResolver);
            let (mut client, task) = run(egress).await;
            client.write_all(&head).await.unwrap();
            assert_eq!(response_line(&mut client).await, "HTTP/1.1 400 Bad Request");
            assert_eq!(
                task.await.unwrap(),
                denied(None, None, DenyReason::BadRequest)
            );
        }
    }

    #[tokio::test]
    async fn ip_literal_target_is_refused() {
        let fixture = config(&["api.example.com:443".to_string()]);
        let egress = Egress::new(fixture.path.clone(), FailingResolver);
        let (mut client, task) = run(egress).await;
        assert_eq!(
            connect(&mut client, "169.254.169.254:80").await,
            "HTTP/1.1 403 Forbidden"
        );
        assert_eq!(
            task.await.unwrap(),
            denied(Some("169.254.169.254"), Some(80), DenyReason::IpLiteral)
        );
    }

    #[tokio::test]
    async fn missing_config_denies_everything() {
        let dir = tempfile::tempdir().unwrap();
        let egress = Egress::new(dir.path().join("absent.json"), FailingResolver);
        let (mut client, task) = run(egress).await;
        assert_eq!(
            connect(&mut client, "api.example.com:443").await,
            "HTTP/1.1 403 Forbidden"
        );
        assert_eq!(
            task.await.unwrap().denied,
            Some(DenyReason::ConfigUnavailable)
        );
    }

    #[tokio::test]
    async fn resolver_failure_is_answered_502() {
        let fixture = config(&["api.example.com:443".to_string()]);
        let egress = Egress::new(fixture.path.clone(), FailingResolver);
        let (mut client, task) = run(egress).await;
        assert_eq!(
            connect(&mut client, "api.example.com:443").await,
            "HTTP/1.1 502 Bad Gateway"
        );
        assert_eq!(task.await.unwrap().denied, Some(DenyReason::DnsFailure));
    }

    #[tokio::test]
    async fn empty_resolver_answer_is_a_dns_failure() {
        let fixture = config(&["api.example.com:443".to_string()]);
        let egress = Egress::new(fixture.path.clone(), ScriptedResolver::new(&[&[]]));
        let (mut client, task) = run(egress).await;
        assert_eq!(
            connect(&mut client, "api.example.com:443").await,
            "HTTP/1.1 502 Bad Gateway"
        );
        assert_eq!(task.await.unwrap().denied, Some(DenyReason::DnsFailure));
    }

    #[tokio::test]
    async fn unreachable_upstream_is_answered_502() {
        let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = closed.local_addr().unwrap().port();
        drop(closed);
        let fixture = config(&[format!("{TEST_HOST}:{port}")]);
        let egress = Egress::with_policy(
            fixture.path.clone(),
            ScriptedResolver::new(&[&["127.0.0.1"]]),
            forbid_ten_slash_eight,
            test_limits(),
        );
        let (mut client, task) = run(egress).await;
        assert_eq!(
            connect(&mut client, &format!("{TEST_HOST}:{port}")).await,
            "HTTP/1.1 502 Bad Gateway"
        );
        assert_eq!(task.await.unwrap().denied, Some(DenyReason::ConnectFailed));
    }

    async fn tunnel_then_send(first: &[u8]) -> (Decision, Vec<u8>) {
        let (port, upstream) = echo_upstream().await;
        let fixture = config(&[format!("{TEST_HOST}:{port}")]);
        let egress = Egress::with_policy(
            fixture.path.clone(),
            ScriptedResolver::new(&[&["127.0.0.1"]]),
            forbid_ten_slash_eight,
            test_limits(),
        );
        let (mut client, task) = run(egress).await;
        assert_eq!(
            connect(&mut client, &format!("{TEST_HOST}:{port}")).await,
            "HTTP/1.1 200 Connection Established"
        );
        client.write_all(first).await.unwrap();
        assert_closed(&mut client).await;
        let decision = task.await.unwrap();
        drop(client);
        (decision, upstream.await.unwrap())
    }

    #[tokio::test]
    async fn sni_that_differs_from_the_connect_host_is_refused() {
        let (decision, seen) = tunnel_then_send(&client_hello_for("evil.example.net")).await;
        assert_eq!(decision.denied, Some(DenyReason::SniMismatch));
        assert!(seen.is_empty());
    }

    #[tokio::test]
    async fn client_hello_without_sni_is_refused() {
        let (decision, seen) =
            tunnel_then_send(&client_hello(&[(0x000a, vec![0x00, 0x02, 0x00, 0x1d])])).await;
        assert_eq!(decision.denied, Some(DenyReason::NoSni));
        assert!(seen.is_empty());
    }

    #[tokio::test]
    async fn plaintext_after_connect_is_refused() {
        let (decision, seen) =
            tunnel_then_send(b"GET / HTTP/1.1\r\nHost: upstream.test\r\n\r\n").await;
        assert_eq!(decision.denied, Some(DenyReason::NotClientHello));
        assert!(seen.is_empty());
    }

    #[tokio::test]
    async fn allowlist_change_applies_to_the_next_connect_without_restart() {
        let fixture = config(&[]);
        let resolver = ScriptedResolver::new(&[&["10.0.0.1"]]);
        let egress = Arc::new(Egress::new(fixture.path.clone(), Arc::clone(&resolver)));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = {
            let egress = Arc::clone(&egress);
            tokio::spawn(async move {
                let mut decisions = Vec::new();
                for _ in 0..2 {
                    let (socket, _) = listener.accept().await.unwrap();
                    decisions.push(egress.handle(socket).await);
                }
                decisions
            })
        };
        let mut first = TcpStream::connect(addr).await.unwrap();
        assert_eq!(
            connect(&mut first, "api.example.com:443").await,
            "HTTP/1.1 403 Forbidden"
        );
        assert_closed(&mut first).await;
        std::fs::write(
            &fixture.path,
            r#"{"version":1,"allow":["api.example.com:443"]}"#,
        )
        .unwrap();
        let mut second = TcpStream::connect(addr).await.unwrap();
        assert_eq!(
            connect(&mut second, "api.example.com:443").await,
            "HTTP/1.1 403 Forbidden"
        );
        let decisions = server.await.unwrap();
        assert_eq!(decisions[0].denied, Some(DenyReason::NotAllowlisted));
        assert_eq!(decisions[1].denied, Some(DenyReason::PrivateAddress));
    }

    #[test]
    fn decision_log_lines_carry_only_the_schema_fields() {
        let allow = Decision {
            host: Some("api.figma.com".to_string()),
            port: Some(443),
            denied: None,
        };
        assert_eq!(
            allow.to_json(),
            serde_json::json!({"event":"egress","decision":"allow","host":"api.figma.com","port":443,"reason":null})
        );
        assert_eq!(
            denied(None, None, DenyReason::Method).to_json(),
            serde_json::json!({"event":"egress","decision":"deny","host":null,"port":null,"reason":"method"})
        );
    }

    #[test]
    fn every_deny_reason_has_a_distinct_wire_name() {
        let all = [
            DenyReason::BadRequest,
            DenyReason::Method,
            DenyReason::IpLiteral,
            DenyReason::ConfigUnavailable,
            DenyReason::NotAllowlisted,
            DenyReason::DnsFailure,
            DenyReason::PrivateAddress,
            DenyReason::ConnectFailed,
            DenyReason::NotClientHello,
            DenyReason::NoSni,
            DenyReason::SniMismatch,
        ];
        let names: std::collections::BTreeSet<_> = all.iter().map(|r| r.as_str()).collect();
        assert_eq!(names.len(), all.len());
    }
}
