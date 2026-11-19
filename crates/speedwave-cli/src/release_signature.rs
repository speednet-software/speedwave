use anyhow::Context;
use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use self_update::update::ReleaseAsset;
use std::path::Path;

pub(crate) const UPDATER_PUBKEY: &str = env!("SPEEDWAVE_UPDATER_PUBKEY");

const SIGNATURE_SUFFIX: &str = ".sig";

pub(crate) fn archive_asset(assets: &[ReleaseAsset], target: &str) -> Option<ReleaseAsset> {
    assets
        .iter()
        .find(|asset| asset.name().contains(target) && !asset.name().ends_with(SIGNATURE_SUFFIX))
        .cloned()
}

pub(crate) fn signature_asset(
    assets: &[ReleaseAsset],
    archive: &ReleaseAsset,
) -> Option<ReleaseAsset> {
    let name = format!("{}{SIGNATURE_SUFFIX}", archive.name());
    assets.iter().find(|asset| asset.name() == name).cloned()
}

pub(crate) fn verify_archive(
    archive: &Path,
    signature_b64: &str,
    pubkey_b64: &str,
    version: &str,
) -> anyhow::Result<()> {
    let public_key = PublicKey::decode(&decode_text(pubkey_b64)?)
        .context("the embedded updater public key is not a minisign public key")?;
    let signature = Signature::decode(&decode_text(signature_b64)?)
        .context("the release signature is not a minisign signature")?;
    let data = std::fs::read(archive)
        .with_context(|| format!("cannot read the downloaded archive {}", archive.display()))?;
    public_key
        .verify(&data, &signature, true)
        .context("the archive does not match its signature")?;
    verify_signed_version(signature.trusted_comment(), version)
}

fn verify_signed_version(trusted_comment: &str, version: &str) -> anyhow::Result<()> {
    let signed = trusted_comment
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"))
        .context("the signature is not bound to a release version")?;
    anyhow::ensure!(
        signed.trim_start_matches('v') == version.trim_start_matches('v'),
        "the signature is bound to version {signed}, not {version}"
    );
    Ok(())
}

fn decode_text(base64_text: &str) -> anyhow::Result<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_text.trim())
        .context("invalid base64")?;
    String::from_utf8(bytes).context("decoded text is not UTF-8")
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test assertions may unwrap freely")]
mod tests {
    use super::*;

    const SIGNATURE: &str = include_str!("../test-fixtures/release-signature/archive.tar.gz.sig");
    const UNVERSIONED_SIGNATURE: &str =
        include_str!("../test-fixtures/release-signature/archive.tar.gz.unversioned.sig");
    const SIGNED_VERSION: &str = "1.2.3";
    const PUBKEY: &str = include_str!("../test-fixtures/release-signature/public-key.txt");

    fn fixture_archive() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("test-fixtures")
            .join("release-signature")
            .join("archive.tar.gz")
    }

    fn asset(name: &str) -> ReleaseAsset {
        ReleaseAsset::new(name, format!("https://example.invalid/{name}"))
    }

    #[test]
    fn verify_archive_accepts_a_signature_with_a_trailing_newline() {
        verify_archive(
            &fixture_archive(),
            &format!("{SIGNATURE}\n"),
            PUBKEY,
            SIGNED_VERSION,
        )
        .unwrap();
    }

    #[test]
    fn verify_archive_accepts_the_signed_version_with_a_v_prefix() {
        verify_archive(&fixture_archive(), SIGNATURE, PUBKEY, "v1.2.3").unwrap();
    }

    #[test]
    fn verify_archive_rejects_a_signature_bound_to_another_version() {
        let err = verify_archive(&fixture_archive(), SIGNATURE, PUBKEY, "1.2.4").unwrap_err();
        assert!(
            format!("{err:#}").contains("bound to version 1.2.3"),
            "{err:#}"
        );
    }

    #[test]
    fn verify_archive_rejects_a_signature_without_a_version() {
        let err = verify_archive(
            &fixture_archive(),
            UNVERSIONED_SIGNATURE,
            PUBKEY,
            SIGNED_VERSION,
        )
        .unwrap_err();
        assert!(
            format!("{err:#}").contains("not bound to a release version"),
            "{err:#}"
        );
    }

    #[test]
    fn verify_archive_rejects_an_empty_signature() {
        assert!(verify_archive(&fixture_archive(), "", PUBKEY, SIGNED_VERSION).is_err());
    }

    #[test]
    fn verify_archive_rejects_a_malformed_public_key() {
        assert!(
            verify_archive(&fixture_archive(), SIGNATURE, "not base64!", SIGNED_VERSION).is_err()
        );
    }

    #[test]
    fn verify_archive_rejects_an_archive_that_cannot_be_read() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing.tar.gz");
        assert!(verify_archive(&missing, SIGNATURE, PUBKEY, SIGNED_VERSION).is_err());
    }

    #[test]
    fn embedded_updater_pubkey_is_a_minisign_public_key() {
        PublicKey::decode(&decode_text(UPDATER_PUBKEY).unwrap()).unwrap();
    }

    #[test]
    fn archive_asset_is_none_for_a_target_without_an_archive() {
        let assets = [
            asset("speedwave-v1.0.0-aarch64-apple-darwin.tar.gz"),
            asset("speedwave-v1.0.0-x86_64-pc-windows-msvc.zip.sig"),
        ];
        assert!(archive_asset(&assets, "x86_64-pc-windows-msvc").is_none());
    }
}
