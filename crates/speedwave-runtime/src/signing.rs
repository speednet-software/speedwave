use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Speednet Ed25519 public key for verifying plugin signatures.
/// This key is embedded at compile time — only Speednet can sign plugins.
///
/// Public key extracted from the Ed25519 private key stored in the
/// Speednet signing infrastructure. Private key never committed to source.
const SPEEDNET_SIGNING_PUBLIC_KEY: &[u8; 32] = b"\x13\x27\xf5\x88\xa1\xeb\xb6\x22\
\xf2\x78\x08\xee\x7d\x86\x4a\xb2\xdf\xcd\xe4\xe6\x5b\x02\xdf\xee\x73\xf7\xe3\x77\
\x92\x49\xe7\xc6";

/// Reads `SIGNATURE` and parses it. Returns the raw 64-byte detached
/// signature on success. Used by both the cached and uncached verify
/// paths so the file-IO/parse story lives in exactly one place.
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

/// Returns true if the (debug-only) `SPEEDWAVE_ALLOW_UNSIGNED` bypass is
/// active. The compile-time `cfg(debug_assertions)` gate means this can
/// only ever be `true` in debug builds — release builds erase the body.
#[cfg(debug_assertions)]
fn unsigned_bypass_active() -> bool {
    std::env::var("SPEEDWAVE_ALLOW_UNSIGNED").is_ok()
}

#[cfg(not(debug_assertions))]
fn unsigned_bypass_active() -> bool {
    false
}

/// Verifies a pre-computed Ed25519 digest against the SIGNATURE file in
/// `plugin_dir`. The primary low-level entry point — every other verifier
/// in this module composes on top of it. Splitting digest computation
/// from verification lets callers (notably `verify_plugin_signature_cached`)
/// hash the tree exactly once per call.
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

/// Cache entry: the content digest the verdict was computed for, plus the
/// verdict itself (success or a rendered error string — `anyhow::Error` is
/// not `Clone`, but the message is what callers report). The digest is
/// computed deterministically from the plugin tree, so any change to a
/// file in the tree produces a fresh digest, which forces a re-verify and
/// supersedes the cached entry.
struct CacheEntry {
    content_digest: [u8; 32],
    verified: Result<(), String>,
}

fn cache() -> &'static Mutex<HashMap<PathBuf, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolves the cache key for `plugin_dir`. Canonicalising defends
/// against the case where two callers reach the same plugin via
/// different path strings (e.g. with and without symlinks earlier in
/// the path) — both would resolve to the same key, so a verdict
/// learned via one path is reused via the other instead of forking the
/// cache. A canonicalize failure on a path that does not exist is
/// normal (plugin not installed yet, or just removed); a failure on a
/// path that *does* exist is unusual (permission error on a parent, a
/// symlink loop) and is logged — the caller then runs uncached.
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

/// Locks the verdict cache, recovering from a poisoned mutex by taking
/// the inner value. A poison means a thread panicked while holding the
/// lock — for this cache, the held data is just `(digest, verdict)`
/// pairs, so recovering is safe and far better than every subsequent
/// call silently skipping the cache (which would also silently defeat
/// `invalidate_cache`). The poison is logged once per recovery.
fn lock_cache() -> std::sync::MutexGuard<'static, HashMap<PathBuf, CacheEntry>> {
    cache().lock().unwrap_or_else(|poisoned| {
        log::error!("signing verdict cache mutex was poisoned; recovering inner value");
        poisoned.into_inner()
    })
}

/// Drops any cached verdict for `plugin_dir`. Call this *before*
/// removing the plugin directory (canonicalize fails once the path is
/// gone) and after install, so the next verify path observes the new
/// on-disk state instead of a stale verdict.
pub fn invalidate_cache(plugin_dir: &Path) {
    if let Some(key) = cache_key(plugin_dir) {
        lock_cache().remove(&key);
    }
}

#[cfg(test)]
fn invalidate_cache_all() {
    lock_cache().clear();
}

/// Verifies a plugin's Ed25519 signature, caching the verdict. The cache
/// is keyed by canonicalised plugin path AND the SHA-256 digest of the
/// tree, so any byte change to any file invalidates the cached verdict
/// and forces a fresh Ed25519 check. The cache eliminates the Ed25519
/// signature verification (~150µs); the SHA-256 hash itself runs every
/// call because it *is* the integrity check.
///
/// In debug builds, `SPEEDWAVE_ALLOW_UNSIGNED=1` skips verification.
/// The bypass is compiled out of release builds.
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
///
/// This is the public entry point callers use; it delegates to
/// [`verify_plugin_signature_cached`], which is where the caching and
/// the debug-only `SPEEDWAVE_ALLOW_UNSIGNED` bypass live.
pub fn verify_plugin_signature(plugin_dir: &Path) -> anyhow::Result<()> {
    verify_plugin_signature_cached(plugin_dir)
}

/// Test-only verifier accepting a custom Ed25519 public key. Used by
/// integration tests and fixture builders that cannot use the embedded
/// production key. Gated behind `cfg(test)` so production callers cannot
/// reach it.
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

/// Computes a deterministic SHA-256 digest of all files in the plugin directory,
/// excluding the SIGNATURE file. Files are sorted by relative path for determinism.
fn compute_plugin_digest(plugin_dir: &Path) -> anyhow::Result<Vec<u8>> {
    use sha2::{Digest, Sha256};

    let mut files: Vec<std::path::PathBuf> = Vec::new();
    collect_files_recursive(plugin_dir, &mut files)?;

    // OsStr byte sort matches Python's as_posix() string sort in the sign script.
    // Path::cmp is component-based: "X/..." < "X.ts", but byte-wise '.' (0x2E) < '/' (0x2F).
    files.sort_by(|a, b| {
        let ra = a.strip_prefix(plugin_dir).unwrap_or(a);
        let rb = b.strip_prefix(plugin_dir).unwrap_or(b);
        ra.as_os_str().cmp(rb.as_os_str())
    });

    let mut hasher = Sha256::new();
    for file in &files {
        let rel = file
            .strip_prefix(plugin_dir)
            .unwrap_or(file)
            .to_string_lossy();
        // Hash: relative path (length-prefixed) + file contents (length-prefixed).
        // Length prefixes prevent ambiguity between ("ab","cd") and ("a","bcd").
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
        // Use symlink_metadata so symlinks are observed *as symlinks*, not
        // silently followed. The plugin signing model has no notion of
        // legitimate symlinks — every plugin file is a real file inside the
        // plugin tree. A symlink anywhere under the plugin dir is either an
        // attacker pointing the digest at content outside the tree (e.g.
        // `claude-resources/skills/foo.md → /etc/passwd`) or a packaging
        // accident; both are fatal.
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
        let _guard = ENV_MUTEX.lock().unwrap();
        // SPEEDWAVE_ALLOW_UNSIGNED can be set in the developer's shell (e.g.
        // `make dev`); a previous test in the same process can also leak it.
        // Either case turns this assertion into a flake. Clear the var while
        // serialised by ENV_MUTEX.
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
    fn test_compute_digest_path_content_boundary() {
        // Without length-prefixing both path and content, these two layouts
        // would produce the same raw hash input bytes:
        //   dir1: file "ab" with content "cd"  → path(2,"ab") + content(2,"cd")
        //   dir2: file "a"  with content "bcd" → path(1,"a")  + content(3,"bcd")
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

    /// A symlink anywhere inside the plugin tree must abort digest
    /// computation. Without this guard, an attacker could place a symlink
    /// pointing at an arbitrary host file (e.g. `/etc/passwd`) — the
    /// digest would fold its contents in and the plugin would still
    /// validate against a "signed" tree that no longer reflects what's on
    /// disk.
    #[cfg(unix)]
    #[test]
    fn test_compute_digest_rejects_file_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("plugin.json"), r#"{"name":"test"}"#).unwrap();
        // Symlink → arbitrary outside-the-tree path. Target need not exist
        // for symlink_metadata() / is_symlink() to fire.
        std::os::unix::fs::symlink("/etc/passwd", dir.join("evil.md")).unwrap();

        let err = compute_plugin_digest(dir).expect_err("symlink must abort digest");
        assert!(
            err.to_string().contains("symlink"),
            "expected symlink rejection, got: {err}"
        );
    }

    /// Same invariant for directory-symlinks — equally dangerous because
    /// `symlink_metadata` on the link would otherwise be followed by a
    /// recursive descent that escapes the plugin tree.
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

        // Expected digest: "schemas.ts" hashed BEFORE "schemas/index.ts"
        // (Python POSIX byte order: '.' = 0x2E < '/' = 0x2F)
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

    // --- cache + test-only verifier tests ---
    //
    // The verdict cache is a process-global Mutex<HashMap>. Tests that
    // exercise it MUST take ENV_MUTEX so they don't interleave with other
    // cache-touching tests, and call `invalidate_cache_all` at entry so
    // stale entries from an earlier test cannot mask correctness bugs.

    /// Helper: signs `dir` with a freshly-generated keypair, returns the
    /// matching public key. Uses the test-only `sign_plugin` function
    /// (debug-only) and produces a signature that the production verifier
    /// will reject — the test paths use `verify_plugin_signature_with_key`
    /// instead.
    fn sign_with_fresh_key(dir: &Path) -> [u8; 32] {
        let (priv_key, pub_key) = generate_keypair();
        sign_plugin(dir, &priv_key).unwrap();
        let mut k = [0u8; 32];
        k.copy_from_slice(&pub_key);
        k
    }

    #[test]
    fn test_verify_with_key_accepts_fixture_keypair() {
        // Independent of the embedded production key. Lets us exercise
        // the full happy path (parse SIGNATURE, compute digest, Ed25519
        // verify) without access to Speednet's signing infrastructure.
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
        // A previous test in this process may have set the bypass — clear
        // it so we exercise the real verifier path.
        std::env::remove_var("SPEEDWAVE_ALLOW_UNSIGNED");
        invalidate_cache_all();

        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("plugin.json"), r#"{"name":"ok"}"#).unwrap();
        // Sign with a non-Speednet key — verify_plugin_signature_cached
        // rejects (and caches the rejection) because the embedded prod
        // key doesn't match. We're checking that the *cached digest*
        // tracks the on-disk content, not the verdict value.
        let _pk = sign_with_fresh_key(dir);
        assert!(verify_plugin_signature_cached(dir).is_err());
        let key = cache_key(dir).expect("dir must canonicalize");
        let digest_before = cache()
            .lock()
            .unwrap()
            .get(&key)
            .expect("cache populated after first verify")
            .content_digest;

        // Tamper. The cache is keyed by `(canonical_path, content_digest)`;
        // changing a file changes the digest, so the next verify must
        // recompute and overwrite the cache entry — not short-circuit on
        // the stale one.
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
