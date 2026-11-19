//! Minisign verification of the CLI release archives against the Desktop updater key.

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
    const OTHER_PUBKEY: &str =
        include_str!("../test-fixtures/release-signature/other-public-key.txt");

    fn fixture_archive() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("test-fixtures")
            .join("release-signature")
            .join("archive.tar.gz")
    }

    fn archive_with_trailing_byte(dir: &Path) -> std::path::PathBuf {
        let mut bytes = std::fs::read(fixture_archive()).unwrap();
        bytes.push(0);
        let path = dir.join("archive.tar.gz");
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn with_flipped_signature_byte(signature_b64: &str) -> String {
        let engine = base64::engine::general_purpose::STANDARD;
        let text = String::from_utf8(engine.decode(signature_b64.trim()).unwrap()).unwrap();
        let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
        let mut raw = engine.decode(&lines[1]).unwrap();
        raw[20] ^= 0xff;
        lines[1] = engine.encode(raw);
        engine.encode(lines.join("\n"))
    }

    fn asset(name: &str) -> ReleaseAsset {
        ReleaseAsset::new(name, format!("https://example.invalid/{name}"))
    }

    #[test]
    fn verify_archive_accepts_an_archive_signed_with_the_matching_key() {
        verify_archive(&fixture_archive(), SIGNATURE, PUBKEY, SIGNED_VERSION).unwrap();
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
    fn verify_archive_rejects_an_archive_changed_after_signing() {
        let dir = tempfile::tempdir().unwrap();
        let tampered = archive_with_trailing_byte(dir.path());
        assert!(verify_archive(&tampered, SIGNATURE, PUBKEY, SIGNED_VERSION).is_err());
    }

    #[test]
    fn verify_archive_rejects_a_corrupted_signature() {
        let corrupted = with_flipped_signature_byte(SIGNATURE);
        assert!(verify_archive(&fixture_archive(), &corrupted, PUBKEY, SIGNED_VERSION).is_err());
    }

    #[test]
    fn verify_archive_rejects_a_missing_signature() {
        assert!(verify_archive(&fixture_archive(), "", PUBKEY, SIGNED_VERSION).is_err());
    }

    #[test]
    fn verify_archive_rejects_a_signature_made_with_another_key() {
        let err = verify_archive(&fixture_archive(), SIGNATURE, OTHER_PUBKEY, SIGNED_VERSION)
            .unwrap_err();
        assert!(format!("{err:#}").contains("different key"), "{err:#}");
    }

    #[test]
    fn verify_archive_rejects_a_malformed_public_key() {
        assert!(
            verify_archive(&fixture_archive(), SIGNATURE, "not base64!", SIGNED_VERSION).is_err()
        );
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
    fn verify_archive_accepts_the_signed_version_with_a_v_prefix() {
        verify_archive(&fixture_archive(), SIGNATURE, PUBKEY, "v1.2.3").unwrap();
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
    fn archive_asset_skips_the_signature_file_of_the_same_target() {
        let assets = [
            asset("speedwave-v1.0.0-aarch64-apple-darwin.tar.gz.sig"),
            asset("speedwave-v1.0.0-aarch64-apple-darwin.tar.gz"),
        ];
        let found = archive_asset(&assets, "aarch64-apple-darwin").unwrap();
        assert_eq!(found.name(), "speedwave-v1.0.0-aarch64-apple-darwin.tar.gz");
    }

    #[test]
    fn archive_asset_is_none_for_a_target_without_an_archive() {
        let assets = [
            asset("speedwave-v1.0.0-aarch64-apple-darwin.tar.gz"),
            asset("speedwave-v1.0.0-x86_64-pc-windows-msvc.zip.sig"),
        ];
        assert!(archive_asset(&assets, "x86_64-pc-windows-msvc").is_none());
    }

    #[test]
    fn signature_asset_is_the_archive_name_with_the_sig_suffix() {
        let archive = asset("speedwave-v1.0.0-x86_64-pc-windows-msvc.zip");
        let assets = [
            asset("speedwave-v1.0.0-aarch64-apple-darwin.tar.gz.sig"),
            archive.clone(),
            asset("speedwave-v1.0.0-x86_64-pc-windows-msvc.zip.sig"),
        ];
        let found = signature_asset(&assets, &archive).unwrap();
        assert_eq!(
            found.name(),
            "speedwave-v1.0.0-x86_64-pc-windows-msvc.zip.sig"
        );
    }

    #[test]
    fn signature_asset_is_none_when_the_release_has_no_signature() {
        let archive = asset("speedwave-v1.0.0-x86_64-pc-windows-msvc.zip");
        let assets = [archive.clone()];
        assert!(signature_asset(&assets, &archive).is_none());
    }
}
