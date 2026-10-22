//! CONNECT-only egress proxy for one custom MCP server: allowlisted `host:port`
//! targets on public addresses only, with the TLS SNI pinned to the CONNECT host.

use std::future::Future;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::net::TcpListener;
use tokio::sync::Semaphore;

mod allowlist;
mod head;
mod host;
mod resolve;
mod session;
mod sni;
mod splice;

use resolve::{Resolver, SystemResolver};
use session::{Egress, DECISION_TARGET};

const DEFAULT_CONFIG_PATH: &str = "/config/egress.json";
const DEFAULT_LISTEN: &str = "0.0.0.0:3128";
const MAX_CONNECTIONS: usize = 256;
const ACCEPT_ERROR_BACKOFF: Duration = Duration::from_millis(100);

fn init_logger() {
    env_logger::Builder::new()
        .filter_level(log::LevelFilter::Info)
        .target(env_logger::Target::Stdout)
        .format(|buf, record| {
            if record.target() == DECISION_TARGET {
                writeln!(buf, "{}", record.args())
            } else {
                let line = serde_json::json!({
                    "event": "log",
                    "level": record.level().as_str(),
                    "message": record.args().to_string(),
                });
                writeln!(buf, "{line}")
            }
        })
        .init();
}

async fn shutdown_signal() {
    let interrupt = async {
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = interrupt => {}
        () = terminate => {}
    }
}

async fn serve<R: Resolver>(
    listener: TcpListener,
    egress: Arc<Egress<R>>,
    shutdown: impl Future<Output = ()>,
) {
    let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    tokio::pin!(shutdown);
    loop {
        let permit = tokio::select! {
            () = &mut shutdown => return,
            permit = Arc::clone(&permits).acquire_owned() => match permit {
                Ok(permit) => permit,
                Err(_) => return,
            },
        };
        let socket = tokio::select! {
            () = &mut shutdown => return,
            accepted = listener.accept() => match accepted {
                Ok((socket, _)) => socket,
                Err(e) => {
                    log::warn!("failed to accept an egress connection: {e}");
                    tokio::time::sleep(ACCEPT_ERROR_BACKOFF).await;
                    continue;
                }
            },
        };
        let egress = Arc::clone(&egress);
        tokio::spawn(async move {
            let _permit = permit;
            egress.handle(socket).await;
        });
    }
}

#[tokio::main]
async fn main() {
    init_logger();
    let config_path = std::env::var("SPW_EGRESS_CONFIG")
        .map_or_else(|_| PathBuf::from(DEFAULT_CONFIG_PATH), PathBuf::from);
    let listen = std::env::var("SPW_EGRESS_LISTEN").unwrap_or_else(|_| DEFAULT_LISTEN.to_string());
    let listener = match TcpListener::bind(&listen).await {
        Ok(listener) => listener,
        Err(e) => {
            log::error!("failed to bind the egress listener on {listen}: {e}");
            std::process::exit(1);
        }
    };
    log::info!(
        "egress listening on {listen} with allowlist {}",
        config_path.display()
    );
    let egress = Arc::new(Egress::new(config_path, SystemResolver));
    serve(listener, egress, shutdown_signal()).await;
    log::info!("egress shutting down");
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::unwrap_used,
        reason = "test fixture setup, failure aborts the test"
    )]
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    use super::*;

    #[tokio::test]
    async fn serve_handles_connections_until_shutdown() {
        let dir = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let egress = Arc::new(Egress::new(dir.path().join("absent.json"), SystemResolver));
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(serve(listener, egress, async {
            let _ = stopped.await;
        }));
        let mut client = TcpStream::connect(addr).await.unwrap();
        client
            .write_all(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
            .await
            .unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        assert!(response.starts_with(b"HTTP/1.1 405 "));
        stop.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
        assert!(TcpStream::connect(addr).await.is_err());
    }
}
