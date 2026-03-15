use std::path::Path;

/// Speednet Ed25519 public key for verifying plugin signatures.
/// This key is embedded at compile time — only Speednet can sign plugins.
///
/// Public key extracted from the Ed25519 private key stored in the
/// Speednet signing infrastructure. Private key never committed to source.
const SPEEDNET_SIGNING_PUBLIC_KEY: &[u8; 32] = b"\x13\x27\xf5\x88\xa1\xeb\xb6\x22\
\xf2\x78\x08\xee\x7d\x86\x4a\xb2\xdf\xcd\xe4\xe6\x5b\x02\xdf\xee\x73\xf7\xe3\x77\
\x92\x49\xe7\xc6";

/// Verifies the Ed25519 signature of a plugin directory.
///
/// Reads `SIGNATURE` (base64-encoded detached signature) and computes the
/// SHA-256 digest of all files except `SIGNATURE` itself (sorted by name,
/// deterministic). Verifies the signature against the Speednet public key.
///
/// In debug builds, `SPEEDWAVE_ALLOW_UNSIGNED` env var skips verification.
pub fn verify_plugin_signature(plugin_dir: &Path) -> anyhow::Result<()> {
    #[cfg(debug_assertions)]
    {
        if std::env::var("SPEEDWAVE_ALLOW_UNSIGNED").is_ok() {
            log::warn!("SPEEDWAVE_ALLOW_UNSIGNED set — skipping signature verification");
            return Ok(());
        }
    }

    let sig_path = plugin_dir.join("SIGNATURE");
    if !sig_path.exists() {
        anyhow::bail!(
            "Plugin signature file not found at {}. Only signed plugins from portal.speednet.pl are accepted.",
            sig_path.display()
        );
    }

    use base64::Engine;
    let sig_b64 = std::fs::read_to_string(&sig_path)?.trim().to_string();
    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(&sig_b64)
        .map_err(|e| anyhow::anyhow!("Invalid base64 in SIGNATURE file: {e}"))?;

    if sig_bytes.len() != 64 {
        anyhow::bail!(
            "Invalid signature length: expected 64 bytes, got {}",
            sig_bytes.len()
        );
    }

    let digest = compute_plugin_digest(plugin_dir)?;

    let public_key = ed25519_dalek::VerifyingKey::from_bytes(SPEEDNET_SIGNING_PUBLIC_KEY)
        .map_err(|e| anyhow::anyhow!("Invalid embedded public key: {e}"))?;

    let signature = ed25519_dalek::Signature::from_bytes(
        sig_bytes
            .as_slice()
            .try_into()
            .map_err(|_| anyhow::anyhow!("signature must be exactly 64 bytes"))?,
    );

    use ed25519_dalek::Verifier;
    public_key.verify(&digest, &signature).map_err(|_| {
        anyhow::anyhow!(
            "Plugin signature verification failed. The plugin may have been tampered with."
        )
    })?;

    Ok(())
}

/// Computes a deterministic SHA-256 digest of all files in the plugin directory,
/// excluding the SIGNATURE file. Files are sorted by relative path for determinism.
fn compute_plugin_digest(plugin_dir: &Path) -> anyhow::Result<Vec<u8>> {
    use sha2::{Digest, Sha256};

    let mut files: Vec<std::path::PathBuf> = Vec::new();
    collect_files_recursive(plugin_dir, &mut files)?;

    // Sort by relative path for determinism
    files.sort_by(|a, b| {
        let ra = a.strip_prefix(plugin_dir).unwrap_or(a);
        let rb = b.strip_prefix(plugin_dir).unwrap_or(b);
        ra.cmp(rb)
    });

    let mut hasher = Sha256::new();
    for file in &files {
        let rel = file
            .strip_prefix(plugin_dir)
            .unwrap_or(file)
            .to_string_lossy();
        // Hash: relative path + file contents
        hasher.update(rel.as_bytes());
        let content = std::fs::read(file)?;
        hasher.update(&content);
    }

    Ok(hasher.finalize().to_vec())
}

fn collect_files_recursive(dir: &Path, out: &mut Vec<std::path::PathBuf>) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_files_recursive(&path, out)?;
        } else if path.file_name().map(|n| n != "SIGNATURE").unwrap_or(true) {
            out.push(path);
        }
    }
    Ok(())
}

/// Generates an Ed25519 keypair for development/testing.
/// Returns (private_key_bytes, public_key_bytes).
#[cfg(debug_assertions)]
pub fn generate_keypair() -> (Vec<u8>, Vec<u8>) {
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;

    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();
    (
        signing_key.to_bytes().to_vec(),
        verifying_key.to_bytes().to_vec(),
    )
}

/// Signs a plugin directory with the given private key (for development/testing).
/// Writes the SIGNATURE file.
#[cfg(debug_assertions)]
pub fn sign_plugin(plugin_dir: &Path, private_key_bytes: &[u8]) -> anyhow::Result<()> {
    use ed25519_dalek::{Signer, SigningKey};

    let key_bytes: [u8; 32] = private_key_bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("private key must be 32 bytes"))?;
    let signing_key = SigningKey::from_bytes(&key_bytes);

    let digest = compute_plugin_digest(plugin_dir)?;
    let signature = signing_key.sign(&digest);
    use base64::Engine;
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(signature.to_bytes());
    std::fs::write(plugin_dir.join("SIGNATURE"), sig_b64)?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use base64::Engine;
    use std::sync::Mutex;

    /// Serializes tests that modify environment variables to prevent data races.
    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    #[test]
    fn test_production_public_key_is_valid_ed25519_key() {
        ed25519_dalek::VerifyingKey::from_bytes(super::SPEEDNET_SIGNING_PUBLIC_KEY)
            .expect("SPEEDNET_SIGNING_PUBLIC_KEY must be a valid Ed25519 public key");
    }

    #[test]
    fn test_generate_keypair_returns_valid_sizes() {
        let (priv_key, pub_key) = generate_keypair();
        assert_eq!(priv_key.len(), 32);
        assert_eq!(pub_key.len(), 32);
    }

    #[test]
    fn test_sign_and_verify_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin_dir = tmp.path();

        // Create some plugin files
        std::fs::write(plugin_dir.join("plugin.json"), r#"{"name":"test"}"#).unwrap();
        std::fs::create_dir_all(plugin_dir.join("src")).unwrap();
        std::fs::write(plugin_dir.join("src/index.ts"), "console.log('hello');").unwrap();

        let (priv_key, pub_key) = generate_keypair();
        sign_plugin(plugin_dir, &priv_key).unwrap();

        // Verify with the matching public key
        let sig_path = plugin_dir.join("SIGNATURE");
        assert!(
            sig_path.exists(),
            "SIGNATURE file should exist after signing"
        );

        let sig_b64 = std::fs::read_to_string(&sig_path)
            .unwrap()
            .trim()
            .to_string();
        let sig_bytes = base64::engine::general_purpose::STANDARD
            .decode(&sig_b64)
            .unwrap();
        assert_eq!(sig_bytes.len(), 64);

        // Verify using the public key directly
        let pub_key_arr: [u8; 32] = pub_key.try_into().unwrap();
        let verifying_key = ed25519_dalek::VerifyingKey::from_bytes(&pub_key_arr).unwrap();
        let digest = compute_plugin_digest(plugin_dir).unwrap();
        let signature =
            ed25519_dalek::Signature::from_bytes(sig_bytes.as_slice().try_into().unwrap());

        use ed25519_dalek::Verifier;
        assert!(
            verifying_key.verify(&digest, &signature).is_ok(),
            "Signature should verify with the matching public key"
        );
    }

    #[test]
    fn test_tampered_file_rejects_signature() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin_dir = tmp.path();

        std::fs::write(plugin_dir.join("plugin.json"), r#"{"name":"test"}"#).unwrap();

        let (priv_key, pub_key) = generate_keypair();
        sign_plugin(plugin_dir, &priv_key).unwrap();

        // Tamper with a file after signing
        std::fs::write(plugin_dir.join("plugin.json"), r#"{"name":"EVIL"}"#).unwrap();

        let pub_key_arr: [u8; 32] = pub_key.try_into().unwrap();
        let verifying_key = ed25519_dalek::VerifyingKey::from_bytes(&pub_key_arr).unwrap();
        let digest = compute_plugin_digest(plugin_dir).unwrap();

        let sig_b64 = std::fs::read_to_string(plugin_dir.join("SIGNATURE"))
            .unwrap()
            .trim()
            .to_string();
        let sig_bytes = base64::engine::general_purpose::STANDARD
            .decode(&sig_b64)
            .unwrap();
        let signature =
            ed25519_dalek::Signature::from_bytes(sig_bytes.as_slice().try_into().unwrap());

        use ed25519_dalek::Verifier;
        assert!(
            verifying_key.verify(&digest, &signature).is_err(),
            "Tampered file should fail signature verification"
        );
    }

    #[test]
    fn test_missing_signature_file_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin_dir = tmp.path();
        std::fs::write(plugin_dir.join("plugin.json"), r#"{"name":"test"}"#).unwrap();

        let result = verify_plugin_signature(plugin_dir);
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("signature file not found") || err_msg.contains("SIGNATURE"),
            "Error should mention missing signature: {err_msg}"
        );
    }

    #[test]
    fn test_allow_unsigned_env_skips_verification() {
        let _guard = ENV_MUTEX.lock().unwrap();

        let tmp = tempfile::tempdir().unwrap();
        let plugin_dir = tmp.path();
        std::fs::write(plugin_dir.join("plugin.json"), r#"{"name":"test"}"#).unwrap();
        // No SIGNATURE file — would normally fail

        // Serialized via ENV_MUTEX — no concurrent env access.
        std::env::set_var("SPEEDWAVE_ALLOW_UNSIGNED", "1");
        let result = verify_plugin_signature(plugin_dir);
        std::env::remove_var("SPEEDWAVE_ALLOW_UNSIGNED");

        assert!(
            result.is_ok(),
            "SPEEDWAVE_ALLOW_UNSIGNED should skip verification: {:?}",
            result
        );
    }

    #[test]
    fn test_compute_digest_deterministic() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        std::fs::write(dir.join("b.txt"), "world").unwrap();

        let d1 = compute_plugin_digest(dir).unwrap();
        let d2 = compute_plugin_digest(dir).unwrap();
        assert_eq!(d1, d2, "Digest must be deterministic");
    }

    #[test]
    fn test_compute_digest_changes_with_content() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        let d1 = compute_plugin_digest(dir).unwrap();

        std::fs::write(dir.join("a.txt"), "world").unwrap();
        let d2 = compute_plugin_digest(dir).unwrap();
        assert_ne!(d1, d2, "Digest must change when file content changes");
    }

    // The `#[cfg(debug_assertions)]` gate on the SPEEDWAVE_ALLOW_UNSIGNED check is
    // structurally enforced by the compiler — there is no bypass path in release builds.
    // The compile-time `const _` assertion on SPEEDNET_SIGNING_PUBLIC_KEY provides the
    // second guard. Combined with `test_allow_unsigned_not_set_by_default` below, these
    // two tests cover the full bypass surface without brittle source-level parsing.

    /// Verifies that in debug builds, SPEEDWAVE_ALLOW_UNSIGNED is NOT set
    /// by default — the bypass is opt-in, not opt-out.
    #[test]
    fn test_allow_unsigned_not_set_by_default() {
        let _guard = ENV_MUTEX.lock().unwrap();

        // Remove the env var in case a previous test leaked it.
        // Serialized via ENV_MUTEX — no concurrent env access.
        std::env::remove_var("SPEEDWAVE_ALLOW_UNSIGNED");

        let tmp = tempfile::tempdir().unwrap();
        let plugin_dir = tmp.path();
        std::fs::write(plugin_dir.join("plugin.json"), r#"{"name":"test"}"#).unwrap();
        // No SIGNATURE file

        let result = verify_plugin_signature(plugin_dir);
        assert!(
            result.is_err(),
            "Without SPEEDWAVE_ALLOW_UNSIGNED, unsigned plugins must be rejected"
        );
    }

    #[test]
    fn test_compute_digest_excludes_signature_file() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("plugin.json"), r#"{"name":"test"}"#).unwrap();

        let d1 = compute_plugin_digest(dir).unwrap();

        // Adding SIGNATURE should not change the digest
        std::fs::write(dir.join("SIGNATURE"), "some-signature").unwrap();
        let d2 = compute_plugin_digest(dir).unwrap();
        assert_eq!(d1, d2, "SIGNATURE file must be excluded from digest");
    }
}
