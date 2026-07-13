//! Ed25519 plugin signature verification (install gate + runtime invariant). See ADR-051.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Speednet Ed25519 public key for verifying plugin signatures, embedded at compile time.
const SPEEDNET_SIGNING_PUBLIC_KEY: &[u8; 32] = b"\x13\x27\xf5\x88\xa1\xeb\xb6\x22\
\xf2\x78\x08\xee\x7d\x86\x4a\xb2\xdf\xcd\xe4\xe6\x5b\x02\xdf\xee\x73\xf7\xe3\x77\
\x92\x49\xe7\xc6";

/// Reads and parses `SIGNATURE`, returning the raw 64-byte detached signature.
fn read_signature_file(plugin_dir: &Path) -> anyhow::Result<[u8; 64]> {
    use base64::Engine;
    let sig_path = plugin_dir.join("SIGNATURE");
    if !sig_path.exists() {
        anyhow::bail!(
            "Plugin signature file not found at {}. Only signed plugins from portal.speednet.pl are accepted.",
            sig_path.display()
        );
    }
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
    let mut out = [0u8; 64];
    out.copy_from_slice(&sig_bytes);
    Ok(out)
}

/// Returns true if the debug-only `SPEEDWAVE_ALLOW_UNSIGNED` bypass is active.
#[cfg(debug_assertions)]
fn unsigned_bypass_active() -> bool {
    std::env::var("SPEEDWAVE_ALLOW_UNSIGNED").is_ok()
}

#[cfg(not(debug_assertions))]
fn unsigned_bypass_active() -> bool {
    false
}

/// Verifies a pre-computed Ed25519 digest against the SIGNATURE file in `plugin_dir`.
fn verify_plugin_signature_with_digest(plugin_dir: &Path, digest: &[u8]) -> anyhow::Result<()> {
    let sig_bytes = read_signature_file(plugin_dir)?;
    let public_key = ed25519_dalek::VerifyingKey::from_bytes(SPEEDNET_SIGNING_PUBLIC_KEY)
        .map_err(|e| anyhow::anyhow!("Invalid embedded public key: {e}"))?;
    let signature = ed25519_dalek::Signature::from_bytes(&sig_bytes);
    use ed25519_dalek::Verifier;
    public_key.verify(digest, &signature).map_err(|_| {
        anyhow::anyhow!(
            "Plugin signature verification failed. The plugin may have been tampered with."
        )
    })?;
    Ok(())
}

/// Cache entry: content digest the verdict was computed for, plus the verdict
/// (error stored as `String` since `anyhow::Error` is not `Clone`).
struct CacheEntry {
    content_digest: [u8; 32],
    verified: Result<(), String>,
}

fn cache() -> &'static Mutex<HashMap<PathBuf, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolves the cache key by canonicalising `plugin_dir`. Returns None if the
/// path does not exist; logs and returns None if canonicalize otherwise fails.
fn cache_key(plugin_dir: &Path) -> Option<PathBuf> {
    match plugin_dir.canonicalize() {
        Ok(p) => Some(p),
        Err(_) if !plugin_dir.exists() => None,
        Err(e) => {
            log::warn!(
                "cannot canonicalize plugin dir {} ({e}); signature caching disabled for this path",
                plugin_dir.display()
            );
            None
        }
    }
}

/// Locks the verdict cache, recovering from a poisoned mutex by taking the
/// inner value and logging the poison.
fn lock_cache() -> std::sync::MutexGuard<'static, HashMap<PathBuf, CacheEntry>> {
    cache().lock().unwrap_or_else(|poisoned| {
        log::error!("signing verdict cache mutex was poisoned; recovering inner value");
        poisoned.into_inner()
    })
}

/// Drops any cached verdict for `plugin_dir`. Call before removing the directory
/// (canonicalize fails once the path is gone) and after install.
pub fn invalidate_cache(plugin_dir: &Path) {
    if let Some(key) = cache_key(plugin_dir) {
        lock_cache().remove(&key);
    }
}

#[cfg(test)]
fn invalidate_cache_all() {
    lock_cache().clear();
}

/// Verifies a plugin's Ed25519 signature, caching the verdict keyed by canonicalised path AND SHA-256 digest.
/// Debug-only `SPEEDWAVE_ALLOW_UNSIGNED=1` skips verification.
pub fn verify_plugin_signature_cached(plugin_dir: &Path) -> anyhow::Result<()> {
    if unsigned_bypass_active() {
        log::warn!("SPEEDWAVE_ALLOW_UNSIGNED set — skipping signature verification");
        return Ok(());
    }

    let digest = compute_plugin_digest(plugin_dir)?;
    let digest_arr: [u8; 32] = digest
        .as_slice()
        .try_into()
        .map_err(|_| anyhow::anyhow!("digest must be 32 bytes"))?;

    if let Some(key) = cache_key(plugin_dir) {
        if let Some(entry) = lock_cache().get(&key) {
            if entry.content_digest == digest_arr {
                return entry.verified.clone().map_err(|msg| anyhow::anyhow!(msg));
            }
        }
    }

    let verified = verify_plugin_signature_with_digest(plugin_dir, &digest);
    let stored: Result<(), String> = match &verified {
        Ok(()) => Ok(()),
        Err(e) => Err(e.to_string()),
    };
    if let Some(key) = cache_key(plugin_dir) {
        lock_cache().insert(
            key,
            CacheEntry {
                content_digest: digest_arr,
                verified: stored,
            },
        );
    }
    verified
}

/// Verifies the Ed25519 signature of a plugin directory.
/// Public entry point; delegates to [`verify_plugin_signature_cached`].
pub fn verify_plugin_signature(plugin_dir: &Path) -> anyhow::Result<()> {
    verify_plugin_signature_cached(plugin_dir)
}

/// Test-only verifier accepting a custom Ed25519 public key.
#[cfg(test)]
pub fn verify_plugin_signature_with_key(
    plugin_dir: &Path,
    public_key: &[u8; 32],
) -> anyhow::Result<()> {
    let sig_bytes = read_signature_file(plugin_dir)?;
    let digest = compute_plugin_digest(plugin_dir)?;
    let public_key = ed25519_dalek::VerifyingKey::from_bytes(public_key)
        .map_err(|e| anyhow::anyhow!("Invalid public key: {e}"))?;
    let signature = ed25519_dalek::Signature::from_bytes(&sig_bytes);
    use ed25519_dalek::Verifier;
    public_key
        .verify(&digest, &signature)
        .map_err(|e| anyhow::anyhow!("verify failed: {e}"))?;
    Ok(())
}

/// Hex digest of the plugin tree — the same bytes the Ed25519 signature
/// covers. Content-addressed plugin image tags derive from it (ADR-072).
pub(crate) fn plugin_tree_digest_hex(plugin_dir: &Path) -> anyhow::Result<String> {
    Ok(crate::bundle::bytes_to_hex(&compute_plugin_digest(
        plugin_dir,
    )?))
}

/// Computes a deterministic SHA-256 digest of all files in the plugin directory,
/// excluding the SIGNATURE file. Files are sorted by relative path for determinism.
fn compute_plugin_digest(plugin_dir: &Path) -> anyhow::Result<Vec<u8>> {
    use sha2::{Digest, Sha256};

    let mut files: Vec<std::path::PathBuf> = Vec::new();
    collect_files_recursive(plugin_dir, &mut files)?;

    // Relative path normalized to posix '/' on every host (matches sign script).
    let mut entries: Vec<(String, &std::path::PathBuf)> = files
        .iter()
        .map(|file| {
            // Bail rather than fold an absolute path into the digest.
            let rel = file.strip_prefix(plugin_dir).map_err(|_| {
                anyhow::anyhow!("plugin file is not under plugin_dir: {}", file.display())
            })?;
            // A non-UTF-8 component must abort, never be silently dropped.
            let posix = rel
                .components()
                .map(|c| {
                    c.as_os_str().to_str().ok_or_else(|| {
                        anyhow::anyhow!("plugin path is not valid UTF-8: {}", rel.display())
                    })
                })
                .collect::<anyhow::Result<Vec<_>>>()?
                .join("/");
            Ok((posix, file))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;

    // Byte sort on the posix path matches Python's as_posix() string sort.
    entries.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));

    let mut hasher = Sha256::new();
    for (rel, file) in &entries {
        // Hash: relative path (length-prefixed) + file contents (length-prefixed).
        let rel_bytes = rel.as_bytes();
        hasher.update((rel_bytes.len() as u64).to_le_bytes());
        hasher.update(rel_bytes);
        let content = std::fs::read(file)?;
        hasher.update((content.len() as u64).to_le_bytes());
        hasher.update(&content);
    }

    Ok(hasher.finalize().to_vec())
}

fn collect_files_recursive(dir: &Path, out: &mut Vec<std::path::PathBuf>) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        // symlink_metadata rejects symlinks rather than following them.
        let file_type = std::fs::symlink_metadata(&path)?.file_type();
        if file_type.is_symlink() {
            anyhow::bail!(
                "plugin contains symlink which is not allowed: {}",
                path.display()
            );
        }
        if file_type.is_dir() {
            collect_files_recursive(&path, out)?;
        } else if path.file_name().map(|n| n != "SIGNATURE").unwrap_or(true) {
            out.push(path);
        }
    }
    Ok(())
}

/// Generates an Ed25519 keypair for testing (test-only).
#[cfg(test)]
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

/// Signs a plugin directory with the given private key (test-only).
/// Writes the SIGNATURE file.
#[cfg(test)]
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
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test code asserts via unwrap/expect"
)]
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
        let _guard = ENV_MUTEX.lock().unwrap();
        // Clear in case the shell or a prior test leaked it.
        std::env::remove_var("SPEEDWAVE_ALLOW_UNSIGNED");

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

    /// Verifies that in debug builds, SPEEDWAVE_ALLOW_UNSIGNED is NOT set by default.
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
    fn test_compute_digest_path_content_boundary() {
        // Without length-prefixing, "ab"+"cd" would collide with "a"+"bcd".
        let tmp1 = tempfile::tempdir().unwrap();
        std::fs::write(tmp1.path().join("ab"), b"cd").unwrap();

        let tmp2 = tempfile::tempdir().unwrap();
        std::fs::write(tmp2.path().join("a"), b"bcd").unwrap();

        let d1 = compute_plugin_digest(tmp1.path()).unwrap();
        let d2 = compute_plugin_digest(tmp2.path()).unwrap();
        assert_ne!(
            d1, d2,
            "Different path/content splits must produce different digests"
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

    /// Pins that `CHANGELOG.md` (surfaced verbatim in the Desktop UI) is covered by the digest:
    /// excluding it would let a local tamper of the rendered changelog survive verification.
    #[test]
    fn test_compute_digest_includes_changelog_md() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("plugin.json"), r#"{"name":"test"}"#).unwrap();
        let d1 = compute_plugin_digest(dir).unwrap();

        std::fs::write(dir.join("CHANGELOG.md"), "## 1.0.0\n- entry\n").unwrap();
        let d2 = compute_plugin_digest(dir).unwrap();
        assert_ne!(d1, d2, "adding CHANGELOG.md must change the digest");

        std::fs::write(dir.join("CHANGELOG.md"), "## 1.0.0\n- tampered\n").unwrap();
        let d3 = compute_plugin_digest(dir).unwrap();
        assert_ne!(d2, d3, "modifying CHANGELOG.md must change the digest");
    }

    /// A symlink anywhere inside the plugin tree must abort digest computation.
    #[cfg(unix)]
    #[test]
    fn test_compute_digest_rejects_file_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("plugin.json"), r#"{"name":"test"}"#).unwrap();
        // Symlink to an outside-the-tree path; target need not exist.
        std::os::unix::fs::symlink("/etc/passwd", dir.join("evil.md")).unwrap();

        let err = compute_plugin_digest(dir).expect_err("symlink must abort digest");
        assert!(
            err.to_string().contains("symlink"),
            "expected symlink rejection, got: {err}"
        );
    }

    /// Same invariant for directory symlinks.
    #[cfg(unix)]
    #[test]
    fn test_compute_digest_rejects_dir_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("plugin.json"), r#"{"name":"test"}"#).unwrap();
        std::os::unix::fs::symlink("/etc", dir.join("hijacked")).unwrap();

        let err = compute_plugin_digest(dir).expect_err("dir-symlink must abort digest");
        assert!(
            err.to_string().contains("symlink"),
            "expected symlink rejection, got: {err}"
        );
    }

    /// "X.ts" must sort before "X/…" (byte '.' < '/') to match the Python sign script.
    #[test]
    fn test_sort_file_before_same_prefix_directory() {
        use sha2::{Digest, Sha256};

        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();

        // "schemas.ts" file at the same level as "schemas/" directory
        std::fs::write(dir.join("schemas.ts"), b"file").unwrap();
        std::fs::create_dir(dir.join("schemas")).unwrap();
        std::fs::write(dir.join("schemas").join("index.ts"), b"index").unwrap();

        let actual = compute_plugin_digest(dir).unwrap();

        // Expected digest: "schemas.ts" hashed before "schemas/index.ts" ('.' 0x2E < '/' 0x2F).
        let mut hasher = Sha256::new();
        for (rel, content) in [
            (b"schemas.ts" as &[u8], b"file" as &[u8]),
            (b"schemas/index.ts", b"index"),
        ] {
            hasher.update((rel.len() as u64).to_le_bytes());
            hasher.update(rel);
            hasher.update((content.len() as u64).to_le_bytes());
            hasher.update(content);
        }
        let expected = hasher.finalize().to_vec();

        assert_eq!(
            actual, expected,
            "file 'X.ts' must sort BEFORE 'X/<files>' (POSIX byte order, matching Python sign script)"
        );
    }

    /// The hashed relative path must always use forward slashes, regardless of
    /// host OS separator (matches the sign script's `as_posix()`).
    #[test]
    fn test_compute_digest_uses_posix_separators_for_nested_paths() {
        use sha2::{Digest, Sha256};

        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::create_dir_all(dir.join("claude-resources").join("skills")).unwrap();
        std::fs::write(
            dir.join("claude-resources").join("skills").join("foo.md"),
            b"body",
        )
        .unwrap();

        let actual = compute_plugin_digest(dir).unwrap();

        // Expected digest: relative path hashed with '/' separators.
        let mut hasher = Sha256::new();
        let rel = b"claude-resources/skills/foo.md" as &[u8];
        let content = b"body" as &[u8];
        hasher.update((rel.len() as u64).to_le_bytes());
        hasher.update(rel);
        hasher.update((content.len() as u64).to_le_bytes());
        hasher.update(content);
        let expected = hasher.finalize().to_vec();

        assert_eq!(
            actual, expected,
            "nested-path digest must use posix '/' separators on every host"
        );
    }

    /// A plugin file whose name is not valid UTF-8 must abort digest computation.
    #[cfg(unix)]
    #[test]
    fn test_compute_digest_rejects_non_utf8_filename() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;

        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("plugin.json"), r#"{"name":"ok"}"#).unwrap();
        // 0xFF is never valid UTF-8; APFS/HFS+ reject it at write time, so skip there.
        let bad = OsStr::from_bytes(b"bad\xff.md");
        if std::fs::write(dir.join(bad), b"body").is_err() {
            return;
        }

        let err = compute_plugin_digest(dir).expect_err("non-UTF-8 name must abort digest");
        assert!(
            err.to_string().contains("not valid UTF-8"),
            "expected UTF-8 rejection, got: {err}"
        );
    }

    // --- cache + test-only verifier tests ---
    // Cache is process-global; these tests take ENV_MUTEX and call invalidate_cache_all().

    /// Helper: signs `dir` with a freshly-generated keypair, returns the public key.
    fn sign_with_fresh_key(dir: &Path) -> [u8; 32] {
        let (priv_key, pub_key) = generate_keypair();
        sign_plugin(dir, &priv_key).unwrap();
        let mut k = [0u8; 32];
        k.copy_from_slice(&pub_key);
        k
    }

    #[test]
    fn test_verify_with_key_accepts_fixture_keypair() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("plugin.json"), r#"{"name":"ok"}"#).unwrap();
        let pk = sign_with_fresh_key(dir);

        verify_plugin_signature_with_key(dir, &pk).expect("freshly-signed plugin must verify");
    }

    #[test]
    fn test_verify_with_key_rejects_tamper_after_sign() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("plugin.json"), r#"{"name":"ok"}"#).unwrap();
        let pk = sign_with_fresh_key(dir);

        // Modify a non-SIGNATURE file in place.
        std::fs::write(dir.join("plugin.json"), r#"{"name":"EVIL"}"#).unwrap();

        let err = verify_plugin_signature_with_key(dir, &pk)
            .expect_err("tampered plugin must fail verification");
        assert!(err.to_string().contains("verify failed"));
    }

    #[test]
    fn test_cache_invalidates_on_content_change() {
        let _guard = ENV_MUTEX.lock().unwrap();
        // Clear the bypass so the real verifier path runs.
        std::env::remove_var("SPEEDWAVE_ALLOW_UNSIGNED");
        invalidate_cache_all();

        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("plugin.json"), r#"{"name":"ok"}"#).unwrap();
        // Non-Speednet key: verify rejects and caches; we check the cached digest tracks content.
        let _pk = sign_with_fresh_key(dir);
        assert!(verify_plugin_signature_cached(dir).is_err());
        let key = cache_key(dir).expect("dir must canonicalize");
        let digest_before = cache()
            .lock()
            .unwrap()
            .get(&key)
            .expect("cache populated after first verify")
            .content_digest;

        // Cache keyed by digest; a file change forces recompute and overwrites the stale entry.
        std::fs::write(dir.join("plugin.json"), r#"{"name":"changed"}"#).unwrap();
        assert!(verify_plugin_signature_cached(dir).is_err());
        let digest_after = cache()
            .lock()
            .unwrap()
            .get(&key)
            .expect("cache still populated after re-verify")
            .content_digest;
        assert_ne!(
            digest_before, digest_after,
            "content change must force the cache to store a fresh digest"
        );
    }

    #[test]
    fn test_invalidate_cache_drops_entry() {
        let _guard = ENV_MUTEX.lock().unwrap();
        std::env::remove_var("SPEEDWAVE_ALLOW_UNSIGNED");
        invalidate_cache_all();

        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("plugin.json"), r#"{"name":"ok"}"#).unwrap();
        let _pk = sign_with_fresh_key(dir);

        // Populate the cache.
        let _ = verify_plugin_signature_cached(dir);
        let key = cache_key(dir).expect("dir must canonicalize");
        assert!(
            cache().lock().unwrap().contains_key(&key),
            "cache should have an entry after verify"
        );

        invalidate_cache(dir);
        assert!(
            !cache().lock().unwrap().contains_key(&key),
            "cache must drop the entry after invalidate"
        );
    }
}
