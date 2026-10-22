use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};

const CONTENT_TYPE_HANDSHAKE: u8 = 0x16;
const HANDSHAKE_CLIENT_HELLO: u8 = 0x01;
const EXTENSION_SERVER_NAME: u16 = 0x0000;
const NAME_TYPE_HOST_NAME: u8 = 0x00;
const RECORD_HEADER_LEN: usize = 5;
const MAX_RECORD_LEN: usize = 16 * 1024;
const MAX_SESSION_ID_LEN: usize = 32;
const MAX_SNI_LEN: usize = 253;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SniError {
    NotClientHello,
    NoSni,
}

pub(crate) struct FirstRecord {
    pub(crate) bytes: Vec<u8>,
    pub(crate) record_len: usize,
}

struct Cursor<'a> {
    buf: &'a [u8],
}

impl<'a> Cursor<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf }
    }

    fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], SniError> {
        if self.buf.len() < n {
            return Err(SniError::NotClientHello);
        }
        let (head, tail) = self.buf.split_at(n);
        self.buf = tail;
        Ok(head)
    }

    fn u8(&mut self) -> Result<u8, SniError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, SniError> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    fn u24(&mut self) -> Result<usize, SniError> {
        let b = self.take(3)?;
        Ok(usize::from(b[0]) << 16 | usize::from(b[1]) << 8 | usize::from(b[2]))
    }

    fn vec8(&mut self) -> Result<&'a [u8], SniError> {
        let n = usize::from(self.u8()?);
        self.take(n)
    }

    fn vec16(&mut self) -> Result<&'a [u8], SniError> {
        let n = usize::from(self.u16()?);
        self.take(n)
    }
}

fn record_body_len(header: &[u8]) -> Result<usize, SniError> {
    let mut cursor = Cursor::new(header);
    if cursor.u8()? != CONTENT_TYPE_HANDSHAKE || cursor.u8()? != 0x03 {
        return Err(SniError::NotClientHello);
    }
    cursor.u8()?;
    let len = usize::from(cursor.u16()?);
    if len == 0 || len > MAX_RECORD_LEN {
        return Err(SniError::NotClientHello);
    }
    Ok(len)
}

pub(crate) async fn read_first_record<R: AsyncRead + Unpin>(
    reader: &mut R,
    initial: Vec<u8>,
    limit: Duration,
) -> Result<FirstRecord, SniError> {
    tokio::time::timeout(limit, read_record(reader, initial))
        .await
        .map_err(|_| SniError::NotClientHello)?
}

async fn read_record<R: AsyncRead + Unpin>(
    reader: &mut R,
    mut bytes: Vec<u8>,
) -> Result<FirstRecord, SniError> {
    let mut chunk = [0u8; 4096];
    let mut needed = RECORD_HEADER_LEN;
    let mut body_len = None;
    loop {
        if body_len.is_none() && bytes.len() >= RECORD_HEADER_LEN {
            let len = record_body_len(&bytes[..RECORD_HEADER_LEN])?;
            body_len = Some(len);
            needed = RECORD_HEADER_LEN + len;
        }
        if body_len.is_some() && bytes.len() >= needed {
            return Ok(FirstRecord {
                bytes,
                record_len: needed,
            });
        }
        let n = reader
            .read(&mut chunk)
            .await
            .map_err(|_| SniError::NotClientHello)?;
        if n == 0 {
            return Err(SniError::NotClientHello);
        }
        bytes.extend_from_slice(&chunk[..n]);
    }
}

pub(crate) fn client_hello_sni(record: &[u8]) -> Result<String, SniError> {
    let header = record
        .get(..RECORD_HEADER_LEN)
        .ok_or(SniError::NotClientHello)?;
    let body_len = record_body_len(header)?;
    if record.len() != RECORD_HEADER_LEN + body_len {
        return Err(SniError::NotClientHello);
    }
    let mut handshake = Cursor::new(&record[RECORD_HEADER_LEN..]);
    if handshake.u8()? != HANDSHAKE_CLIENT_HELLO {
        return Err(SniError::NotClientHello);
    }
    let hello_len = handshake.u24()?;
    let mut hello = Cursor::new(handshake.take(hello_len)?);
    if !handshake.is_empty() {
        return Err(SniError::NotClientHello);
    }
    hello.take(2)?;
    hello.take(32)?;
    if hello.vec8()?.len() > MAX_SESSION_ID_LEN {
        return Err(SniError::NotClientHello);
    }
    let suites = hello.vec16()?;
    if suites.is_empty() || suites.len() % 2 != 0 {
        return Err(SniError::NotClientHello);
    }
    if hello.vec8()?.is_empty() {
        return Err(SniError::NotClientHello);
    }
    if hello.is_empty() {
        return Err(SniError::NoSni);
    }
    let mut extensions = Cursor::new(hello.vec16()?);
    if !hello.is_empty() {
        return Err(SniError::NotClientHello);
    }
    let mut server_name = None;
    while !extensions.is_empty() {
        let kind = extensions.u16()?;
        let data = extensions.vec16()?;
        if kind == EXTENSION_SERVER_NAME {
            if server_name.is_some() {
                return Err(SniError::NotClientHello);
            }
            server_name = Some(parse_server_name(data)?);
        }
    }
    server_name.ok_or(SniError::NoSni)
}

fn parse_server_name(data: &[u8]) -> Result<String, SniError> {
    let mut outer = Cursor::new(data);
    let mut list = Cursor::new(outer.vec16()?);
    if !outer.is_empty() {
        return Err(SniError::NotClientHello);
    }
    let mut host = None;
    while !list.is_empty() {
        let name_type = list.u8()?;
        let name = list.vec16()?;
        if name_type == NAME_TYPE_HOST_NAME {
            if host.is_some() {
                return Err(SniError::NotClientHello);
            }
            host = Some(name);
        }
    }
    let name = host.ok_or(SniError::NoSni)?;
    if name.is_empty() || name.len() > MAX_SNI_LEN || !name.iter().all(u8::is_ascii_graphic) {
        return Err(SniError::NotClientHello);
    }
    Ok(String::from_utf8_lossy(name).to_ascii_lowercase())
}

#[cfg(test)]
pub(crate) mod fixtures {
    fn u16_be(n: usize) -> [u8; 2] {
        u16::try_from(n).unwrap_or(u16::MAX).to_be_bytes()
    }

    pub(crate) fn sni_extension(names: &[(u8, &str)]) -> (u16, Vec<u8>) {
        let mut list = Vec::new();
        for (kind, name) in names {
            list.push(*kind);
            list.extend_from_slice(&u16_be(name.len()));
            list.extend_from_slice(name.as_bytes());
        }
        let mut data = u16_be(list.len()).to_vec();
        data.extend_from_slice(&list);
        (0x0000, data)
    }

    pub(crate) fn client_hello(extensions: &[(u16, Vec<u8>)]) -> Vec<u8> {
        let mut exts = Vec::new();
        for (kind, data) in extensions {
            exts.extend_from_slice(&kind.to_be_bytes());
            exts.extend_from_slice(&u16_be(data.len()));
            exts.extend_from_slice(data);
        }
        let mut hello = vec![0x03, 0x03];
        hello.extend_from_slice(&[0x5a; 32]);
        hello.push(0);
        hello.extend_from_slice(&[0x00, 0x02, 0x13, 0x01]);
        hello.extend_from_slice(&[0x01, 0x00]);
        hello.extend_from_slice(&u16_be(exts.len()));
        hello.extend_from_slice(&exts);
        let len = hello.len();
        let mut handshake = vec![0x01];
        handshake.extend_from_slice(&[(len >> 16) as u8, (len >> 8) as u8, len as u8]);
        handshake.extend_from_slice(&hello);
        let mut record = vec![0x16, 0x03, 0x01];
        record.extend_from_slice(&u16_be(handshake.len()));
        record.extend_from_slice(&handshake);
        record
    }

    pub(crate) fn client_hello_for(host: &str) -> Vec<u8> {
        client_hello(&[
            (0x000a, vec![0x00, 0x02, 0x00, 0x1d]),
            sni_extension(&[(0, host)]),
            (0x002b, vec![0x02, 0x03, 0x04]),
        ])
    }
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::unwrap_used,
        reason = "test fixture setup, failure aborts the test"
    )]
    use super::fixtures::{client_hello, client_hello_for, sni_extension};
    use super::*;

    #[test]
    fn sni_is_extracted_among_other_extensions_and_lowercased() {
        assert_eq!(
            client_hello_sni(&client_hello_for("API.Figma.com")),
            Ok("api.figma.com".to_string())
        );
    }

    #[test]
    fn hello_without_extensions_has_no_sni() {
        let mut record = client_hello(&[]);
        record.truncate(record.len() - 2);
        let body_len = record.len() - RECORD_HEADER_LEN;
        record[3..5].copy_from_slice(&u16::try_from(body_len).unwrap().to_be_bytes());
        let hello_len = body_len - 4;
        record[6..9].copy_from_slice(&u32::try_from(hello_len).unwrap().to_be_bytes()[1..]);
        assert_eq!(client_hello_sni(&record), Err(SniError::NoSni));
    }

    #[test]
    fn hello_with_extensions_but_no_server_name_has_no_sni() {
        let record = client_hello(&[(0x000a, vec![0x00, 0x02, 0x00, 0x1d])]);
        assert_eq!(client_hello_sni(&record), Err(SniError::NoSni));
    }

    #[test]
    fn server_name_without_a_host_name_entry_has_no_sni() {
        let record = client_hello(&[sni_extension(&[(1, "other")])]);
        assert_eq!(client_hello_sni(&record), Err(SniError::NoSni));
    }

    #[test]
    fn duplicate_server_name_extensions_are_refused() {
        let record = client_hello(&[
            sni_extension(&[(0, "a.example.com")]),
            sni_extension(&[(0, "b.example.com")]),
        ]);
        assert_eq!(client_hello_sni(&record), Err(SniError::NotClientHello));
    }

    #[test]
    fn two_host_names_in_one_extension_are_refused() {
        let record = client_hello(&[sni_extension(&[(0, "a.example.com"), (0, "b.example.com")])]);
        assert_eq!(client_hello_sni(&record), Err(SniError::NotClientHello));
    }

    #[test]
    fn non_printable_or_empty_names_are_refused() {
        for name in ["", "a b.com", "a\u{0}.com"] {
            let record = client_hello(&[sni_extension(&[(0, name)])]);
            assert_eq!(
                client_hello_sni(&record),
                Err(SniError::NotClientHello),
                "{name:?}"
            );
        }
    }

    #[test]
    fn truncated_records_are_refused_at_every_length() {
        let record = client_hello_for("api.figma.com");
        for len in 0..record.len() {
            assert_eq!(
                client_hello_sni(&record[..len]),
                Err(SniError::NotClientHello),
                "length {len}"
            );
        }
    }

    #[test]
    fn hello_truncated_inside_a_consistent_record_is_refused() {
        let full = client_hello_for("api.figma.com");
        for cut in 1..(full.len() - RECORD_HEADER_LEN) {
            let mut record = full[..full.len() - cut].to_vec();
            let body_len = record.len() - RECORD_HEADER_LEN;
            record[3..5].copy_from_slice(&u16::try_from(body_len).unwrap().to_be_bytes());
            assert_eq!(
                client_hello_sni(&record),
                Err(SniError::NotClientHello),
                "cut {cut}"
            );
        }
    }

    #[test]
    fn hello_shorter_than_its_record_is_refused() {
        let mut record = client_hello_for("api.figma.com");
        record.push(0);
        let body_len = record.len() - RECORD_HEADER_LEN;
        record[3..5].copy_from_slice(&u16::try_from(body_len).unwrap().to_be_bytes());
        assert_eq!(client_hello_sni(&record), Err(SniError::NotClientHello));
    }

    #[test]
    fn wrong_content_type_or_handshake_type_is_refused() {
        let mut application_data = client_hello_for("api.figma.com");
        application_data[0] = 0x17;
        assert_eq!(
            client_hello_sni(&application_data),
            Err(SniError::NotClientHello)
        );
        let mut server_hello = client_hello_for("api.figma.com");
        server_hello[5] = 0x02;
        assert_eq!(
            client_hello_sni(&server_hello),
            Err(SniError::NotClientHello)
        );
        assert_eq!(
            client_hello_sni(b"GET / HTTP/1.1\r\n\r\n"),
            Err(SniError::NotClientHello)
        );
    }

    #[test]
    fn oversized_record_length_is_refused() {
        assert_eq!(
            record_body_len(&[0x16, 0x03, 0x01, 0x40, 0x01]),
            Err(SniError::NotClientHello)
        );
        assert_eq!(
            record_body_len(&[0x16, 0x03, 0x01, 0x00, 0x00]),
            Err(SniError::NotClientHello)
        );
        assert_eq!(record_body_len(&[0x16, 0x03, 0x03, 0x40, 0x00]), Ok(16384));
    }

    #[tokio::test]
    async fn first_record_is_read_from_leftover_and_stream() {
        let record = client_hello_for("api.figma.com");
        let (initial, rest) = record.split_at(3);
        let mut trailing = rest.to_vec();
        trailing.extend_from_slice(b"early");
        let mut reader = trailing.as_slice();
        let first = read_first_record(&mut reader, initial.to_vec(), Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(first.record_len, record.len());
        assert_eq!(&first.bytes[..first.record_len], record.as_slice());
        assert_eq!(&first.bytes[first.record_len..], b"early");
    }

    #[tokio::test]
    async fn stream_closed_mid_record_is_refused() {
        let record = client_hello_for("api.figma.com");
        let mut reader = &record[..record.len() - 1];
        assert!(matches!(
            read_first_record(&mut reader, Vec::new(), Duration::from_secs(5)).await,
            Err(SniError::NotClientHello)
        ));
    }

    #[tokio::test]
    async fn non_tls_first_bytes_are_refused_without_waiting() {
        let mut reader: &[u8] = b"GET / HTTP/1.1\r\n\r\n";
        assert!(matches!(
            read_first_record(&mut reader, Vec::new(), Duration::from_secs(5)).await,
            Err(SniError::NotClientHello)
        ));
    }

    #[tokio::test]
    async fn silent_client_times_out() {
        let (_client, mut server) = tokio::io::duplex(64);
        assert!(matches!(
            read_first_record(&mut server, Vec::new(), Duration::from_millis(20)).await,
            Err(SniError::NotClientHello)
        ));
    }
}
