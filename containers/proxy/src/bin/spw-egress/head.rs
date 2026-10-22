use std::net::IpAddr;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};

use crate::host::{normalize_hostname, parse_port, HostError};

pub(crate) const MAX_HEAD_BYTES: usize = 8 * 1024;
const HEAD_TERMINATOR: &[u8] = b"\r\n\r\n";

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct RawHead {
    pub(crate) head: Vec<u8>,
    pub(crate) leftover: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum HeadError {
    Oversized,
    Closed,
    TimedOut,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TargetError {
    Method,
    Malformed,
    IpLiteral {
        ip: Option<IpAddr>,
        port: Option<u16>,
    },
}

pub(crate) async fn read_head<R: AsyncRead + Unpin>(
    reader: &mut R,
    limit: Duration,
) -> Result<RawHead, HeadError> {
    tokio::time::timeout(limit, read_until_blank_line(reader))
        .await
        .map_err(|_| HeadError::TimedOut)?
}

async fn read_until_blank_line<R: AsyncRead + Unpin>(reader: &mut R) -> Result<RawHead, HeadError> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let n = reader
            .read(&mut chunk)
            .await
            .map_err(|_| HeadError::Closed)?;
        if n == 0 {
            return Err(HeadError::Closed);
        }
        let scan_from = buf.len().saturating_sub(HEAD_TERMINATOR.len() - 1);
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf[scan_from..]
            .windows(HEAD_TERMINATOR.len())
            .position(|w| w == HEAD_TERMINATOR)
        {
            let end = scan_from + pos + HEAD_TERMINATOR.len();
            if end > MAX_HEAD_BYTES {
                return Err(HeadError::Oversized);
            }
            let leftover = buf.split_off(end);
            return Ok(RawHead {
                head: buf,
                leftover,
            });
        }
        if buf.len() >= MAX_HEAD_BYTES {
            return Err(HeadError::Oversized);
        }
    }
}

pub(crate) fn parse_connect(head: &[u8]) -> Result<(String, u16), TargetError> {
    let line_end = head
        .windows(2)
        .position(|w| w == b"\r\n")
        .ok_or(TargetError::Malformed)?;
    let line = std::str::from_utf8(&head[..line_end]).map_err(|_| TargetError::Malformed)?;
    let mut parts = line.split(' ');
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(TargetError::Malformed);
    };
    if method.is_empty() || !method.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err(TargetError::Malformed);
    }
    if method != "CONNECT" {
        return Err(TargetError::Method);
    }
    if version != "HTTP/1.1" {
        return Err(TargetError::Malformed);
    }
    parse_authority(target)
}

fn parse_authority(target: &str) -> Result<(String, u16), TargetError> {
    let (host, port) = target.rsplit_once(':').ok_or(TargetError::Malformed)?;
    let port = parse_port(port);
    match normalize_hostname(host) {
        Ok(host) => port.map(|p| (host, p)).ok_or(TargetError::Malformed),
        Err(HostError::IpLiteral(ip)) => Err(TargetError::IpLiteral { ip, port }),
        Err(HostError::Invalid) => Err(TargetError::Malformed),
    }
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::unwrap_used,
        reason = "test fixture setup, failure aborts the test"
    )]
    use super::*;

    async fn read(bytes: &[u8]) -> Result<RawHead, HeadError> {
        let mut reader = bytes;
        read_head(&mut reader, Duration::from_secs(5)).await
    }

    #[tokio::test]
    async fn connect_head_is_split_from_trailing_bytes() {
        let raw = read(
            b"CONNECT api.figma.com:443 HTTP/1.1\r\nHost: api.figma.com:443\r\n\r\n\x16\x03\x01",
        )
        .await
        .unwrap();
        assert!(raw.head.ends_with(b"\r\n\r\n"));
        assert_eq!(raw.leftover, b"\x16\x03\x01");
        assert_eq!(
            parse_connect(&raw.head),
            Ok(("api.figma.com".to_string(), 443))
        );
    }

    #[tokio::test]
    async fn head_split_across_reads_is_reassembled() {
        let (mut client, mut server) = tokio::io::duplex(64);
        let writer = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            for part in [&b"CONNECT a.example.com:443 HTTP/1.1\r"[..], b"\n\r", b"\n"] {
                client.write_all(part).await.unwrap();
                tokio::task::yield_now().await;
            }
            client
        });
        let raw = read_head(&mut server, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(
            parse_connect(&raw.head),
            Ok(("a.example.com".to_string(), 443))
        );
        assert!(raw.leftover.is_empty());
        drop(writer.await.unwrap());
    }

    #[tokio::test]
    async fn oversized_head_is_refused() {
        let mut bytes = b"CONNECT a.example.com:443 HTTP/1.1\r\n".to_vec();
        while bytes.len() <= MAX_HEAD_BYTES {
            bytes.extend_from_slice(b"X-Pad: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r\n");
        }
        bytes.extend_from_slice(b"\r\n");
        assert_eq!(read(&bytes).await, Err(HeadError::Oversized));
    }

    #[tokio::test]
    async fn head_that_ends_exactly_at_the_cap_is_accepted() {
        let mut bytes = b"CONNECT a.example.com:443 HTTP/1.1\r\nX-Pad: ".to_vec();
        bytes.resize(MAX_HEAD_BYTES - 4, b'a');
        bytes.extend_from_slice(b"\r\n\r\n");
        assert_eq!(read(&bytes).await.unwrap().head.len(), MAX_HEAD_BYTES);
    }

    #[tokio::test]
    async fn closed_connection_before_blank_line_is_an_error() {
        assert_eq!(read(b"").await, Err(HeadError::Closed));
        assert_eq!(
            read(b"CONNECT a.example.com:443 HTTP/1.1\r\n").await,
            Err(HeadError::Closed)
        );
    }

    #[tokio::test]
    async fn silent_client_times_out() {
        let (_client, mut server) = tokio::io::duplex(64);
        assert_eq!(
            read_head(&mut server, Duration::from_millis(20)).await,
            Err(HeadError::TimedOut)
        );
    }

    #[test]
    fn non_connect_methods_are_refused_as_method() {
        for line in [
            "GET http://example.com/ HTTP/1.1",
            "POST / HTTP/1.1",
            "OPTIONS * HTTP/1.1",
        ] {
            let head = format!("{line}\r\n\r\n");
            assert_eq!(
                parse_connect(head.as_bytes()),
                Err(TargetError::Method),
                "{line}"
            );
        }
    }

    #[test]
    fn malformed_request_lines_are_refused() {
        for line in [
            "CONNECT",
            "CONNECT a.example.com:443",
            "CONNECT a.example.com:443 HTTP/1.0",
            "CONNECT a.example.com:443 HTTP/1.1 extra",
            "CONNECT  a.example.com:443 HTTP/1.1",
            "connect a.example.com:443 HTTP/1.1",
            "CONNECT a.example.com HTTP/1.1",
            "CONNECT a.example.com:0 HTTP/1.1",
            "CONNECT a.example.com:https HTTP/1.1",
            "CONNECT bad_host.com:443 HTTP/1.1",
            "CONNECT a.example.com.:443 HTTP/1.1",
            "",
        ] {
            let head = format!("{line}\r\n\r\n");
            assert_eq!(
                parse_connect(head.as_bytes()),
                Err(TargetError::Malformed),
                "{line:?}"
            );
        }
        assert_eq!(
            parse_connect(b"CONNECT \xff:443 HTTP/1.1\r\n\r\n"),
            Err(TargetError::Malformed)
        );
        assert_eq!(parse_connect(b"no line end"), Err(TargetError::Malformed));
    }

    #[test]
    fn ip_literal_targets_are_refused_with_the_parsed_address() {
        assert_eq!(
            parse_connect(b"CONNECT 10.0.0.1:443 HTTP/1.1\r\n\r\n"),
            Err(TargetError::IpLiteral {
                ip: Some("10.0.0.1".parse().unwrap()),
                port: Some(443)
            })
        );
        assert_eq!(
            parse_connect(b"CONNECT [::1]:443 HTTP/1.1\r\n\r\n"),
            Err(TargetError::IpLiteral {
                ip: Some("::1".parse().unwrap()),
                port: Some(443)
            })
        );
        assert_eq!(
            parse_connect(b"CONNECT 127.1:443 HTTP/1.1\r\n\r\n"),
            Err(TargetError::IpLiteral {
                ip: None,
                port: Some(443)
            })
        );
    }

    #[test]
    fn target_host_is_lowercased() {
        assert_eq!(
            parse_connect(b"CONNECT API.Figma.com:443 HTTP/1.1\r\n\r\n"),
            Ok(("api.figma.com".to_string(), 443))
        );
    }
}
