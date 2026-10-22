use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::time::Instant;

const BUF_LEN: usize = 16 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SpliceEnd {
    Closed,
    Idle,
    ByteCap,
    Error,
}

struct Meter {
    start: Instant,
    last_activity_ms: AtomicU64,
    total: AtomicU64,
}

impl Meter {
    fn new(already_sent: u64) -> Self {
        Self {
            start: Instant::now(),
            last_activity_ms: AtomicU64::new(0),
            total: AtomicU64::new(already_sent),
        }
    }

    fn elapsed_ms(&self) -> u64 {
        u64::try_from(self.start.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    fn touch(&self) {
        self.last_activity_ms
            .store(self.elapsed_ms(), Ordering::Relaxed);
    }

    fn idle_for(&self) -> Duration {
        let last = self.last_activity_ms.load(Ordering::Relaxed);
        Duration::from_millis(self.elapsed_ms().saturating_sub(last))
    }

    fn add(&self, n: usize) -> u64 {
        let n = u64::try_from(n).unwrap_or(u64::MAX);
        self.total.fetch_add(n, Ordering::Relaxed).saturating_add(n)
    }
}

async fn pump<R, W>(mut reader: R, mut writer: W, meter: &Meter, max_bytes: u64) -> SpliceEnd
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; BUF_LEN];
    loop {
        let n = match reader.read(&mut buf).await {
            Ok(0) => {
                let _ = writer.shutdown().await;
                return SpliceEnd::Closed;
            }
            Ok(n) => n,
            Err(_) => return SpliceEnd::Error,
        };
        if meter.add(n) > max_bytes {
            return SpliceEnd::ByteCap;
        }
        meter.touch();
        if writer.write_all(&buf[..n]).await.is_err() {
            return SpliceEnd::Error;
        }
    }
}

async fn idle_watch(meter: &Meter, idle: Duration) {
    loop {
        let quiet = meter.idle_for();
        if quiet >= idle {
            return;
        }
        tokio::time::sleep(idle - quiet).await;
    }
}

pub(crate) async fn splice<C, U>(
    client: C,
    upstream: U,
    idle: Duration,
    max_bytes: u64,
    already_sent: u64,
) -> SpliceEnd
where
    C: AsyncRead + AsyncWrite + Unpin,
    U: AsyncRead + AsyncWrite + Unpin,
{
    let meter = Meter::new(already_sent);
    let (client_read, client_write) = tokio::io::split(client);
    let (upstream_read, upstream_write) = tokio::io::split(upstream);
    let outbound = pump(client_read, upstream_write, &meter, max_bytes);
    let inbound = pump(upstream_read, client_write, &meter, max_bytes);
    let watchdog = idle_watch(&meter, idle);
    tokio::pin!(outbound, inbound, watchdog);
    let (mut outbound_done, mut inbound_done) = (false, false);
    loop {
        tokio::select! {
            end = &mut outbound, if !outbound_done => {
                if end != SpliceEnd::Closed {
                    return end;
                }
                outbound_done = true;
            }
            end = &mut inbound, if !inbound_done => {
                if end != SpliceEnd::Closed {
                    return end;
                }
                inbound_done = true;
            }
            () = &mut watchdog => return SpliceEnd::Idle,
        }
        if outbound_done && inbound_done {
            return SpliceEnd::Closed;
        }
    }
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::unwrap_used,
        reason = "test fixture setup, failure aborts the test"
    )]
    use super::*;

    const IDLE: Duration = Duration::from_secs(30);

    #[tokio::test]
    async fn bytes_flow_both_ways_and_close_ends_the_splice() {
        let (mut client, client_side) = tokio::io::duplex(1024);
        let (upstream_side, mut upstream) = tokio::io::duplex(1024);
        let task = tokio::spawn(splice(client_side, upstream_side, IDLE, 1 << 20, 0));
        client.write_all(b"ping").await.unwrap();
        let mut buf = [0u8; 4];
        upstream.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"ping");
        upstream.write_all(b"pong").await.unwrap();
        client.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"pong");
        drop(client);
        let mut rest = Vec::new();
        upstream.read_to_end(&mut rest).await.unwrap();
        assert!(rest.is_empty());
        drop(upstream);
        assert_eq!(task.await.unwrap(), SpliceEnd::Closed);
    }

    #[tokio::test]
    async fn half_close_keeps_the_other_direction_open() {
        let (mut client, client_side) = tokio::io::duplex(1024);
        let (upstream_side, mut upstream) = tokio::io::duplex(1024);
        let task = tokio::spawn(splice(client_side, upstream_side, IDLE, 1 << 20, 0));
        client.write_all(b"request").await.unwrap();
        client.shutdown().await.unwrap();
        let mut request = Vec::new();
        upstream.read_to_end(&mut request).await.unwrap();
        assert_eq!(request, b"request");
        upstream.write_all(b"response").await.unwrap();
        drop(upstream);
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        assert_eq!(response, b"response");
        assert_eq!(task.await.unwrap(), SpliceEnd::Closed);
    }

    #[tokio::test]
    async fn exceeding_the_byte_cap_ends_the_splice() {
        let (mut client, client_side) = tokio::io::duplex(1024);
        let (upstream_side, _upstream) = tokio::io::duplex(1 << 16);
        let task = tokio::spawn(splice(client_side, upstream_side, IDLE, 10, 4));
        client.write_all(b"1234567").await.unwrap();
        assert_eq!(task.await.unwrap(), SpliceEnd::ByteCap);
    }

    #[tokio::test]
    async fn quiet_connection_hits_the_idle_timeout() {
        let (_client, client_side) = tokio::io::duplex(1024);
        let (upstream_side, _upstream) = tokio::io::duplex(1024);
        let end = splice(
            client_side,
            upstream_side,
            Duration::from_millis(50),
            1 << 20,
            0,
        )
        .await;
        assert_eq!(end, SpliceEnd::Idle);
    }

    #[tokio::test]
    async fn activity_postpones_the_idle_timeout() {
        let (mut client, client_side) = tokio::io::duplex(1024);
        let (upstream_side, mut upstream) = tokio::io::duplex(1024);
        let started = Instant::now();
        let task = tokio::spawn(splice(
            client_side,
            upstream_side,
            Duration::from_secs(1),
            1 << 20,
            0,
        ));
        for _ in 0..4 {
            tokio::time::sleep(Duration::from_millis(200)).await;
            client.write_all(b"x").await.unwrap();
            let mut one = [0u8; 1];
            upstream.read_exact(&mut one).await.unwrap();
        }
        assert_eq!(task.await.unwrap(), SpliceEnd::Idle);
        assert!(started.elapsed() >= Duration::from_millis(1700));
    }
}
