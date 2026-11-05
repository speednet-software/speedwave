//! Git smart-HTTP transport: `ANY /git/{host}/{*path}` streams fetch and push traffic to an
//! allowlisted repository of a configured forge, injecting the integration token the `claude`
//! container never sees.

use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, HeaderMap, HeaderName, Method, StatusCode},
    response::Response,
};
use base64::Engine;

use crate::router::{Config, GitForge};
use crate::{audit, CALLER_AUTH_HEADER};

const REQUEST_HEADERS: [HeaderName; 6] = [
    header::CONTENT_TYPE,
    header::ACCEPT,
    header::ACCEPT_ENCODING,
    header::CONTENT_ENCODING,
    HeaderName::from_static("git-protocol"),
    header::USER_AGENT,
];

const RESPONSE_HEADERS: [HeaderName; 5] = [
    header::CONTENT_TYPE,
    header::CONTENT_ENCODING,
    header::CACHE_CONTROL,
    header::EXPIRES,
    header::PRAGMA,
];

#[derive(Debug, PartialEq)]
struct GitRequest<'a> {
    repo: String,
    suffix: &'static str,
    service: &'static str,
    query: Option<&'a str>,
}

/// Handles one git transport request and writes its audit row.
pub async fn handler(State(cfg): State<Arc<Config>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let rest_of_path = parts.uri.path().strip_prefix("/git/").unwrap_or_default();
    let (host, rest) = rest_of_path.split_once('/').unwrap_or((rest_of_path, ""));
    let classified = classify(&parts.method, rest, parts.uri.query());

    let response = if !caller_authorized(&cfg, &parts.headers) {
        log::warn!("rejected /git request with missing or invalid caller auth");
        status_response(StatusCode::UNAUTHORIZED)
    } else {
        match (cfg.git_forges.iter().find(|f| f.host == host), &classified) {
            (Some(forge), Some(git)) if forge.allows(&git.repo) => {
                forward(&cfg.client, forge, git, &parts.method, &parts.headers, body).await
            }
            (Some(_), Some(git)) => not_listed_response(host, &git.repo),
            _ => status_response(StatusCode::FORBIDDEN),
        }
    };

    let repo = classified.as_ref().map(|g| g.repo.as_str());
    let service = classified.as_ref().map(|g| g.service);
    log::info!(
        "git {} host={host} repo={} service={} status={}",
        parts.method,
        repo.unwrap_or("-"),
        service.unwrap_or("-"),
        response.status().as_u16()
    );
    audit::write_git_audit(
        cfg.audit_dir.as_deref(),
        parts.method.as_str(),
        host,
        repo,
        service,
        response.status().as_u16(),
    );
    response
}

fn classify<'a>(method: &Method, rest: &str, query: Option<&'a str>) -> Option<GitRequest<'a>> {
    let segments: Vec<&str> = rest.split('/').collect();
    let (repo_segments, suffix, service) = match segments.as_slice() {
        [repo @ .., "info", "refs"] if method == Method::GET => {
            let service = match query? {
                "service=git-upload-pack" => "git-upload-pack",
                "service=git-receive-pack" => "git-receive-pack",
                _ => return None,
            };
            (repo, "info/refs", service)
        }
        [repo @ .., "git-upload-pack"] if method == Method::POST && query.is_none() => {
            (repo, "git-upload-pack", "git-upload-pack")
        }
        [repo @ .., "git-receive-pack"] if method == Method::POST && query.is_none() => {
            (repo, "git-receive-pack", "git-receive-pack")
        }
        _ => return None,
    };
    let valid = !repo_segments.is_empty()
        && repo_segments[0] != "api"
        && repo_segments
            .iter()
            .all(|s| !s.is_empty() && *s != "." && *s != ".." && !s.contains(['%', '\\']));
    valid.then(|| GitRequest {
        repo: repo_segments.join("/"),
        suffix,
        service,
        query,
    })
}

fn caller_authorized(cfg: &Config, headers: &HeaderMap) -> bool {
    let Some(expected) = cfg.caller_token.as_deref() else {
        return false;
    };
    headers
        .get(CALLER_AUTH_HEADER)
        .and_then(|v| v.to_str().ok())
        == Some(expected)
}

fn status_response(status: StatusCode) -> Response {
    let mut resp = Response::new(Body::empty());
    *resp.status_mut() = status;
    resp
}

fn not_listed_response(host: &str, repo: &str) -> Response {
    let entry = crate::router::normalise(repo);
    let mut resp = Response::new(Body::from(format!(
        "Speedwave: {host}/{repo} is not on this project's repository list. \
         A person adds the entry {entry} in Speedwave Desktop: Integrations, the GitHub or GitLab panel, Repositories.\n"
    )));
    *resp.status_mut() = StatusCode::FORBIDDEN;
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    resp
}

async fn forward(
    client: &reqwest::Client,
    forge: &GitForge,
    git: &GitRequest<'_>,
    method: &Method,
    headers: &HeaderMap,
    body: Body,
) -> Response {
    let Some(token) = read_token(forge) else {
        log::error!("git token for {} is missing or empty", forge.host);
        return status_response(StatusCode::SERVICE_UNAVAILABLE);
    };
    let mut url = format!(
        "{}/{}/{}",
        forge.base_url.trim_end_matches('/'),
        git.repo,
        git.suffix
    );
    if let Some(q) = git.query {
        url.push('?');
        url.push_str(q);
    }
    let credentials =
        base64::engine::general_purpose::STANDARD.encode(format!("{}:{token}", forge.login));
    let mut auth = match header::HeaderValue::from_str(&format!("Basic {credentials}")) {
        Ok(v) => v,
        Err(_) => {
            log::error!(
                "git token for {} cannot be encoded as a header value",
                forge.host
            );
            return status_response(StatusCode::SERVICE_UNAVAILABLE);
        }
    };
    auth.set_sensitive(true);

    let mut upstream = client.request(method.clone(), url);
    for name in &REQUEST_HEADERS {
        if let Some(v) = headers.get(name) {
            upstream = upstream.header(name, v);
        }
    }
    upstream = upstream.header(header::AUTHORIZATION, auth);
    if method == Method::POST {
        upstream = upstream.body(reqwest::Body::wrap_stream(body.into_data_stream()));
    }

    let upstream_resp = match upstream.send().await {
        Ok(r) => r,
        Err(e) => {
            log::warn!("git upstream {} request failed: {e}", forge.host);
            return status_response(StatusCode::BAD_GATEWAY);
        }
    };
    let status = upstream_resp.status();
    let upstream_headers = upstream_resp.headers().clone();
    let mut resp = Response::new(Body::from_stream(upstream_resp.bytes_stream()));
    *resp.status_mut() = status;
    for name in &RESPONSE_HEADERS {
        if let Some(v) = upstream_headers.get(name) {
            resp.headers_mut().insert(name.clone(), v.clone());
        }
    }
    resp
}

fn read_token(forge: &GitForge) -> Option<String> {
    let raw = std::fs::read_to_string(&forge.token_file).ok()?;
    let token = raw.trim();
    (!token.is_empty()).then(|| token.to_string())
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::unwrap_used,
        reason = "test fixture setup, failure aborts the test"
    )]
    use super::*;
    use crate::build_router;
    use axum::extract::State as AxState;
    use axum::http::Request as HttpRequest;
    use bytes::Bytes;
    use futures_util::StreamExt;
    use http_body_util::BodyExt;
    use tokio::sync::Mutex;
    use tower::ServiceExt;

    const CALLER: &str = "caller-secret";
    const TOKEN: &str = "ghs_supersecret";

    #[derive(Debug, Clone)]
    struct Seen {
        method: String,
        path_and_query: String,
        authorization: Option<String>,
        caller_header: bool,
        body_len: usize,
    }

    type Log = Arc<Mutex<Vec<Seen>>>;

    async fn upstream_handler(AxState(log): AxState<Log>, req: Request) -> Response {
        let (parts, body) = req.into_parts();
        let mut stream = body.into_data_stream();
        let mut body_len = 0;
        while let Some(chunk) = stream.next().await {
            body_len += chunk.unwrap().len();
        }
        log.lock().await.push(Seen {
            method: parts.method.to_string(),
            path_and_query: parts.uri.path_and_query().unwrap().to_string(),
            authorization: parts
                .headers
                .get(header::AUTHORIZATION)
                .map(|v| v.to_str().unwrap().to_string()),
            caller_header: parts.headers.contains_key(CALLER_AUTH_HEADER),
            body_len,
        });
        let mut resp = Response::new(Body::from("001e# service=git-upload-pack\n"));
        resp.headers_mut().insert(
            header::CONTENT_TYPE,
            "application/x-git-upload-pack-advertisement"
                .parse()
                .unwrap(),
        );
        resp.headers_mut()
            .insert("x-internal", "leak".parse().unwrap());
        resp
    }

    async fn spawn_upstream() -> (String, Log) {
        let log: Log = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = axum::Router::new()
            .fallback(upstream_handler)
            .with_state(log.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), log)
    }

    struct Fixture {
        app: axum::Router,
        log: Log,
        audit: tempfile::TempDir,
        _tokens: tempfile::TempDir,
    }

    async fn fixture(caller_token: Option<&str>, token: Option<&str>) -> Fixture {
        fixture_allowing(caller_token, token, &["owner/repo"]).await
    }

    async fn fixture_allowing(
        caller_token: Option<&str>,
        token: Option<&str>,
        repositories: &[&str],
    ) -> Fixture {
        let (base_url, log) = spawn_upstream().await;
        let tokens = tempfile::tempdir().unwrap();
        let token_file = tokens.path().join("token");
        if let Some(t) = token {
            std::fs::write(&token_file, format!("{t}\n")).unwrap();
        }
        let audit = tempfile::tempdir().unwrap();
        let cfg = Config {
            caller_token: caller_token.map(str::to_string),
            git_forges: vec![GitForge {
                host: "github.com".to_string(),
                base_url,
                login: "x-access-token".to_string(),
                token_file,
                repositories: repositories.iter().map(|r| r.to_string()).collect(),
            }],
            audit_dir: Some(audit.path().to_path_buf()),
            ..Config::default()
        };
        Fixture {
            app: build_router(Arc::new(cfg)),
            log,
            audit,
            _tokens: tokens,
        }
    }

    fn req(method: &str, uri: &str, caller: Option<&str>, body: Body) -> HttpRequest<Body> {
        let mut b = HttpRequest::builder().method(method).uri(uri);
        if let Some(c) = caller {
            b = b.header(CALLER_AUTH_HEADER, c);
        }
        b.body(body).unwrap()
    }

    fn audit_rows(f: &Fixture) -> Vec<serde_json::Value> {
        std::fs::read_to_string(f.audit.path().join("audit-proxy.jsonl"))
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[tokio::test]
    async fn info_refs_reaches_upstream_with_basic_auth_and_without_caller_header() {
        let f = fixture(Some(CALLER), Some(TOKEN)).await;
        let resp = f
            .app
            .clone()
            .oneshot(req(
                "GET",
                "/git/github.com/owner/repo.git/info/refs?service=git-upload-pack",
                Some(CALLER),
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers()[header::CONTENT_TYPE],
            "application/x-git-upload-pack-advertisement"
        );
        assert!(!resp.headers().contains_key("x-internal"));
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"001e# service=git-upload-pack\n");

        let seen = f.log.lock().await.clone();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].method, "GET");
        assert_eq!(
            seen[0].path_and_query,
            "/owner/repo.git/info/refs?service=git-upload-pack"
        );
        let expected = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{TOKEN}"))
        );
        assert_eq!(seen[0].authorization.as_deref(), Some(expected.as_str()));
        assert!(!seen[0].caller_header);
    }

    #[tokio::test]
    async fn large_receive_pack_body_streams_upstream_and_is_audited_without_token() {
        let f = fixture(Some(CALLER), Some(TOKEN)).await;
        let chunk = Bytes::from(vec![7u8; 1024 * 1024]);
        let stream = futures_util::stream::iter(
            (0..40).map(move |_| Ok::<_, std::io::Error>(chunk.clone())),
        );
        let resp = f
            .app
            .clone()
            .oneshot(req(
                "POST",
                "/git/github.com/owner/repo/git-receive-pack",
                Some(CALLER),
                Body::from_stream(stream),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        resp.into_body().collect().await.unwrap();

        let seen = f.log.lock().await.clone();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].method, "POST");
        assert_eq!(seen[0].body_len, 40 * 1024 * 1024);

        let rows = audit_rows(&f);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["layer"], "git");
        assert_eq!(rows[0]["method"], "POST");
        assert_eq!(rows[0]["host"], "github.com");
        assert_eq!(rows[0]["repo"], "owner/repo");
        assert_eq!(rows[0]["service"], "git-receive-pack");
        assert_eq!(rows[0]["status"], 200);
        let raw = std::fs::read_to_string(f.audit.path().join("audit-proxy.jsonl")).unwrap();
        assert!(!raw.contains(TOKEN) && !raw.contains(CALLER));
    }

    #[tokio::test]
    async fn disallowed_requests_get_403_and_never_reach_upstream() {
        let f = fixture(Some(CALLER), Some(TOKEN)).await;
        let cases = [
            ("GET", "/git/github.com/api/v4/projects"),
            (
                "GET",
                "/git/github.com/api/repo/info/refs?service=git-upload-pack",
            ),
            ("GET", "/git/github.com/owner/repo/info/refs?service=other"),
            ("GET", "/git/github.com/owner/repo/info/refs"),
            ("GET", "/git/github.com/owner/repo/git-receive-pack"),
            ("POST", "/git/github.com/owner/repo/git-upload-pack?x=1"),
            (
                "POST",
                "/git/github.com/owner/repo/info/refs?service=git-upload-pack",
            ),
            (
                "GET",
                "/git/github.com/owner/../repo/info/refs?service=git-upload-pack",
            ),
            (
                "GET",
                "/git/github.com/owner/%2e%2e/info/refs?service=git-upload-pack",
            ),
            ("GET", "/git/github.com/info/refs?service=git-upload-pack"),
            ("POST", "/git/evil.example/owner/repo/git-upload-pack"),
        ];
        for (method, uri) in cases {
            let resp = f
                .app
                .clone()
                .oneshot(req(method, uri, Some(CALLER), Body::empty()))
                .await
                .unwrap();
            assert_eq!(resp.status(), 403, "{method} {uri}");
        }
        assert!(f.log.lock().await.is_empty());
        let rows = audit_rows(&f);
        assert_eq!(rows.len(), cases.len());
        assert!(rows.iter().all(|r| r["status"] == 403));
    }

    #[tokio::test]
    async fn repository_outside_the_allowlist_gets_403_without_upstream_and_is_audited() {
        let f = fixture(Some(CALLER), Some(TOKEN)).await;
        let cases = [
            (
                "GET",
                "/git/github.com/other/repo/info/refs?service=git-upload-pack",
            ),
            (
                "GET",
                "/git/github.com/owner/repo-fork.git/info/refs?service=git-receive-pack",
            ),
            ("POST", "/git/github.com/other/repo/git-upload-pack"),
            ("POST", "/git/github.com/owner/other/git-receive-pack"),
            ("POST", "/git/github.com/group/owner/repo/git-receive-pack"),
        ];
        for (method, uri) in cases {
            let resp = f
                .app
                .clone()
                .oneshot(req(method, uri, Some(CALLER), Body::empty()))
                .await
                .unwrap();
            assert_eq!(resp.status(), 403, "{method} {uri}");
        }
        assert!(f.log.lock().await.is_empty());
        let rows = audit_rows(&f);
        assert_eq!(rows.len(), cases.len());
        assert!(rows.iter().all(|r| r["status"] == 403));
        assert_eq!(rows[0]["repo"], "other/repo");
        assert_eq!(rows[0]["service"], "git-upload-pack");
    }

    #[tokio::test]
    async fn repository_outside_the_allowlist_is_named_in_a_plain_text_body_git_shows() {
        let f = fixture(Some(CALLER), Some(TOKEN)).await;
        let resp = f
            .app
            .clone()
            .oneshot(req(
                "GET",
                "/git/github.com/other/repo.git/info/refs?service=git-receive-pack",
                Some(CALLER),
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), 403);
        assert_eq!(
            resp.headers()[header::CONTENT_TYPE],
            "text/plain; charset=utf-8"
        );
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8(body.to_vec()).unwrap();
        assert!(
            text.starts_with(
                "Speedwave: github.com/other/repo.git is not on this project's repository list. \
                 A person adds the entry other/repo in Speedwave Desktop"
            ),
            "{text}"
        );

        let unknown_host = f
            .app
            .clone()
            .oneshot(req(
                "GET",
                "/git/example.com/other/repo/info/refs?service=git-upload-pack",
                Some(CALLER),
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(unknown_host.status(), 403);
        let body = unknown_host.into_body().collect().await.unwrap().to_bytes();
        assert!(body.is_empty());
    }

    #[tokio::test]
    async fn allowlist_ignores_letter_case_and_the_git_suffix() {
        let f = fixture_allowing(
            Some(CALLER),
            Some(TOKEN),
            &["Owner/Repo.git", "group/sub/repo"],
        )
        .await;
        for uri in [
            "/git/github.com/OWNER/repo/info/refs?service=git-upload-pack",
            "/git/github.com/owner/REPO.git/info/refs?service=git-receive-pack",
            "/git/github.com/Group/Sub/Repo.git/info/refs?service=git-upload-pack",
        ] {
            let resp = f
                .app
                .clone()
                .oneshot(req("GET", uri, Some(CALLER), Body::empty()))
                .await
                .unwrap();
            assert_eq!(resp.status(), 200, "{uri}");
        }
        let seen = f.log.lock().await.clone();
        assert_eq!(seen.len(), 3);
        assert_eq!(
            seen[0].path_and_query,
            "/OWNER/repo/info/refs?service=git-upload-pack"
        );
    }

    #[tokio::test]
    async fn empty_allowlist_rejects_every_repository() {
        let f = fixture_allowing(Some(CALLER), Some(TOKEN), &[]).await;
        for (method, uri) in [
            (
                "GET",
                "/git/github.com/owner/repo/info/refs?service=git-upload-pack",
            ),
            ("POST", "/git/github.com/owner/repo/git-receive-pack"),
        ] {
            let resp = f
                .app
                .clone()
                .oneshot(req(method, uri, Some(CALLER), Body::empty()))
                .await
                .unwrap();
            assert_eq!(resp.status(), 403, "{method} {uri}");
        }
        assert!(f.log.lock().await.is_empty());
        let rows = audit_rows(&f);
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r["status"] == 403));
    }

    #[tokio::test]
    async fn wrong_or_missing_caller_header_gets_401() {
        let f = fixture(Some(CALLER), Some(TOKEN)).await;
        for caller in [None, Some("wrong")] {
            let resp = f
                .app
                .clone()
                .oneshot(req(
                    "GET",
                    "/git/github.com/owner/repo/info/refs?service=git-upload-pack",
                    caller,
                    Body::empty(),
                ))
                .await
                .unwrap();
            assert_eq!(resp.status(), 401);
        }
        assert!(f.log.lock().await.is_empty());
    }

    #[tokio::test]
    async fn config_without_caller_token_rejects_every_git_request() {
        let f = fixture(None, Some(TOKEN)).await;
        let resp = f
            .app
            .clone()
            .oneshot(req(
                "GET",
                "/git/github.com/owner/repo/info/refs?service=git-upload-pack",
                Some("anything"),
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), 401);
        assert!(f.log.lock().await.is_empty());
    }

    #[tokio::test]
    async fn missing_or_empty_token_file_gets_503() {
        for token in [None, Some("  ")] {
            let f = fixture(Some(CALLER), token).await;
            let resp = f
                .app
                .clone()
                .oneshot(req(
                    "GET",
                    "/git/github.com/owner/repo/info/refs?service=git-upload-pack",
                    Some(CALLER),
                    Body::empty(),
                ))
                .await
                .unwrap();
            assert_eq!(resp.status(), 503);
            assert!(f.log.lock().await.is_empty());
        }
    }

    #[test]
    fn git_forges_deserialize_from_proxy_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("proxy.json");
        std::fs::write(
            &path,
            r#"{"routes":[],"git_forges":[{"host":"github.com","base_url":"https://github.com","login":"x-access-token","token_file":"/git-tokens/github/token","repositories":["speednet-software/speedwave"]},{"host":"gitlab.com","base_url":"https://gitlab.com","login":"oauth2","token_file":"/git-tokens/gitlab/token"}]}"#,
        )
        .unwrap();
        let cfg = Config::load_from(&path).unwrap();
        assert_eq!(cfg.git_forges.len(), 2);
        assert_eq!(cfg.git_forges[0].host, "github.com");
        assert_eq!(
            cfg.git_forges[0].token_file,
            std::path::PathBuf::from("/git-tokens/github/token")
        );
        assert_eq!(
            cfg.git_forges[0].repositories,
            ["speednet-software/speedwave"]
        );
        assert!(cfg.git_forges[0].allows("Speednet-Software/Speedwave.git"));
        assert!(cfg.git_forges[1].repositories.is_empty());
        assert!(!cfg.git_forges[1].allows("owner/repo"));
    }
}
