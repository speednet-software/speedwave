use std::path::Path;

/// Speednet Ed25519 public key for verifying plugin signatures.
/// This key is embedded at compile time — only Speednet can sign plugins.
const SPEEDNET_SIGNING_PUBLIC_KEY: &[u8; 32] = b"\xd7\x5a\x98\x0e\x82\x3c\x1f\x64\
\xb0\x4e\x72\x9d\xa1\x58\x6b\xf3\xc2\x47\xe0\x15\x89\xab\xcd\xef\x01\x23\x45\x67\
\x89\xab\xcd\xef";

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
        // Skip the signature file itself
        if rel == "SIGNATURE" {
            continue;
        }
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
        } else {
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
        let tmp = tempfile::tempdir().unwrap();
        let plugin_dir = tmp.path();
        std::fs::write(plugin_dir.join("plugin.json"), r#"{"name":"test"}"#).unwrap();
        // No SIGNATURE file — would normally fail

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
