use std::future::Future;
use std::io;
use std::net::{IpAddr, SocketAddr};

pub(crate) trait Resolver: Send + Sync + 'static {
    fn resolve(
        &self,
        host: &str,
        port: u16,
    ) -> impl Future<Output = io::Result<Vec<SocketAddr>>> + Send;
}

pub(crate) struct SystemResolver;

impl Resolver for SystemResolver {
    async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
        Ok(tokio::net::lookup_host((host, port)).await?.collect())
    }
}

pub(crate) fn is_forbidden_target(ip: IpAddr) -> bool {
    let embedded = match ip {
        IpAddr::V6(v6) => ip_policy::embedded_ipv4(v6).map(IpAddr::V4),
        IpAddr::V4(_) => None,
    };
    is_forbidden_address(ip) || embedded.is_some_and(is_forbidden_address)
}

fn is_forbidden_address(ip: IpAddr) -> bool {
    ip_policy::is_private_or_reserved(ip)
        || match ip {
            IpAddr::V4(v4) => v4.is_multicast() || v4.octets()[0] >= 240,
            IpAddr::V6(v6) => v6.is_multicast(),
        }
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::unwrap_used,
        reason = "test fixture setup, failure aborts the test"
    )]
    use super::*;

    fn forbidden(ip: &str) -> bool {
        is_forbidden_target(ip.parse().unwrap())
    }

    #[test]
    fn private_loopback_cgnat_and_link_local_targets_are_forbidden() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.5.2",
            "100.64.0.1",
            "169.254.169.254",
            "198.18.0.1",
            "0.0.0.0",
            "::1",
            "fd00::1",
            "fe80::1",
        ] {
            assert!(forbidden(ip), "{ip}");
        }
    }

    #[test]
    fn mapped_and_nat64_embeddings_of_private_ipv4_are_forbidden() {
        for ip in [
            "::ffff:10.0.0.1",
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
            "64:ff9b::a00:1",
            "64:ff9b::7f00:1",
        ] {
            assert!(forbidden(ip), "{ip}");
        }
    }

    #[test]
    fn compatible_6to4_and_teredo_forms_of_private_ipv4_are_forbidden() {
        for ip in [
            "::10.0.0.1",
            "::127.0.0.1",
            "::169.254.169.254",
            "::0.0.0.2",
            "2002:7f00:1::",
            "2002:a00:1::1",
            "2002:a9fe:a9fe::",
            "2002:c0a8:502:ffff:ffff:ffff:ffff:ffff",
            "2002:e000:1::",
            "64:ff9b::e000:1",
            "64:ff9b::f000:1",
        ] {
            assert!(forbidden(ip), "{ip}");
        }
    }

    #[test]
    fn teredo_and_local_use_nat64_are_forbidden_whatever_they_embed() {
        for ip in [
            "2001::1",
            "2001:0:4136:e378:8000:63bf:3fff:fdd2",
            "2001:0:808:808::",
            "64:ff9b:1::101:101",
            "64:ff9b:1::a00:1",
        ] {
            assert!(forbidden(ip), "{ip}");
        }
    }

    #[test]
    fn multicast_broadcast_and_class_e_are_forbidden() {
        for ip in [
            "224.0.0.1",
            "239.255.255.250",
            "240.0.0.1",
            "255.255.255.255",
            "ff02::1",
        ] {
            assert!(forbidden(ip), "{ip}");
        }
    }

    #[test]
    fn public_addresses_and_their_embeddings_are_allowed() {
        for ip in [
            "1.1.1.1",
            "8.8.8.8",
            "2606:4700::1111",
            "::ffff:1.1.1.1",
            "64:ff9b::101:101",
            "::8.8.8.8",
            "2002:808:808::",
            "2002:101:101::1",
            "2001:4860:4860::8888",
            "2001:1::1",
            "64:ff9b:2::1",
        ] {
            assert!(!forbidden(ip), "{ip}");
        }
    }
}
