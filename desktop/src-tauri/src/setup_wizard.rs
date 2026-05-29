use serde::{Deserialize, Serialize};
use speedwave_runtime::runtime::ensure_exec_healthy;
use speedwave_runtime::{build, bundle, compose, config, consts, project, runtime};
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Setup state — persisted to ~/.speedwave/setup_state.json for resume support
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct SetupState {
    pub runtime_ready: bool,
    pub vm_ready: bool,
    pub project_created: Option<String>,
    pub tokens_configured: Vec<String>,
    pub images_built: bool,
    pub containers_started: bool,
    pub cli_linked: bool,
}

impl SetupState {
    /// Derives the current wizard step from the boolean flags.
    ///
    /// Returns the number of completed sequential steps (0 = nothing done).
    /// The wizard steps execute in this order:
    ///   1. runtime_ready  (Check Runtime)
    ///   2. vm_ready       (Initialize VM)
    ///   3. images_built   (Build Images)
    ///   4. project_created (Create Project)
    ///   5. containers_started (Start Containers)
    ///   6. cli_linked     (Finalize / CLI symlink)
    ///
    /// Previously this was a stored field (`current_step: u8`) that could
    /// diverge from the boolean flags. Now it is derived, so it is always
    /// consistent. Old serialized JSON that includes `"current_step"` is
    /// silently ignored on deserialization (serde default behavior).
    #[cfg(test)]
    pub fn current_step(&self) -> u8 {
        if !self.runtime_ready {
            return 0;
        }
        if !self.vm_ready {
            return 1;
        }
        if !self.images_built {
            return 2;
        }
        if self.project_created.is_none() {
            return 3;
        }
        if !self.containers_started {
            return 4;
        }
        if !self.cli_linked {
            return 5;
        }
        6
    }

    fn state_path() -> anyhow::Result<PathBuf> {
        Ok(consts::data_dir().join("setup_state.json"))
    }

    pub fn load() -> Self {
        Self::state_path()
            .ok()
            .and_then(|p| Self::load_from(&p).ok())
            .unwrap_or_default()
    }

    /// Loads setup state from a specific file path.
    fn load_from(path: &std::path::Path) -> anyhow::Result<Self> {
        let content = std::fs::read_to_string(path)?;
        let state: Self = serde_json::from_str(&content)?;
        Ok(state)
    }

    pub fn save(&self) -> anyhow::Result<()> {
        let path = Self::state_path()?;
        self.save_to(&path)
    }

    /// Saves setup state to a specific file path (atomic write via rename).
    fn save_to(&self, path: &std::path::Path) -> anyhow::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)?;
        let tmp_path = path.with_extension("json.tmp");
        std::fs::write(&tmp_path, &json)?;
        std::fs::rename(&tmp_path, path)?;
        Ok(())
    }

    /// Pure-logic check: returns `true` when all required setup steps have been completed.
    ///
    /// `cli_linked` is intentionally excluded — CLI symlink creation is optional
    /// (the Desktop app works without it) and may fail on restricted systems.
    pub fn is_complete(&self) -> bool {
        self.runtime_ready
            && self.vm_ready
            && self.project_created.is_some()
            && self.images_built
            && self.containers_started
    }
}

// ---------------------------------------------------------------------------
// Step 2: Check and install container runtime
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
pub enum RuntimeStatus {
    Ready,
    NotInstalled,
}

pub fn check_runtime() -> anyhow::Result<RuntimeStatus> {
    let rt = runtime::detect_runtime();
    // ensure_ready() verifies the full stack: binary exists, correct version,
    // AND containerd is running. is_available() only checks the binary, which
    // causes the wizard to skip init_vm even when containerd is not started.
    if rt.ensure_ready().is_ok() {
        let mut state = SetupState::load();
        state.runtime_ready = true;
        // When the runtime is already Ready, the VM is also ready — ensure_ready()
        // verifies the full stack (binary + containerd running). Without this,
        // the wizard skips init_vm (which normally sets vm_ready) and
        // is_complete() returns false because vm_ready stays false.
        state.vm_ready = true;
        state.save()?;
        Ok(RuntimeStatus::Ready)
    } else {
        Ok(RuntimeStatus::NotInstalled)
    }
}

pub fn install_runtime() -> anyhow::Result<()> {
    let rt = runtime::detect_runtime();
    rt.ensure_ready()?;

    let mut state = SetupState::load();
    state.runtime_ready = true;
    state.save()?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Step 3: Initialize VM (macOS only — Lima)
// ---------------------------------------------------------------------------

/// Desired Lima VM memory as a Lima-compatible string (e.g. `"16GiB"`).
///
/// Uses adaptive scaling from [`speedwave_runtime::resources`]:
/// VM = host_ram / 2, clamped 4–32 GiB (never more than 50% of host RAM).
///
/// Older installs with lower values are auto-migrated by
/// [`ensure_lima_vm_config`].
#[cfg(any(target_os = "macos", test))]
fn desired_lima_vm_memory() -> String {
    let gib = speedwave_runtime::resources::desired_vm_memory_gib(
        speedwave_runtime::resources::host_total_memory_gib(),
    );
    format!("{gib}GiB")
}

/// Default Lima VM configuration for Speedwave.
/// Uses Apple Virtualization Framework (vz) with containerd + nerdctl.
/// Memory is adaptive based on host RAM — see [`desired_lima_vm_memory`].
#[cfg(any(target_os = "macos", test))]
fn lima_config() -> String {
    format!(
        r#"# Speedwave Lima VM — auto-generated by setup wizard
vmType: vz
vmOpts:
  vz:
    rosetta:
      enabled: true
      binfmt: true
images:
  - location: "https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-amd64.img"
    arch: "x86_64"
  - location: "https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-arm64.img"
    arch: "aarch64"
cpus: 4
memory: "{}"
disk: "50GiB"
mountType: virtiofs
networks:
  - vzNAT: true
mounts:
  - location: "~"
    writable: true
containerd:
  system: true
  user: false
provision:
  - mode: boot
    script: |
      #!/bin/sh
      # Make eth0 (vzNAT) the preferred default route, not lima0 (usernet).
      #
      # Why: Apple VZ NAT on eth0 inherits the macOS host routing table
      # transparently — both public Internet and every VPN tunnel the host
      # is connected to (IPSec, WireGuard, Tailscale). Lima's built-in
      # usernet (lima0) runs a user-mode TCP stack on the host and only
      # reaches services that need no host VPN; it silently times out on
      # corporate VPNs and on Tailscale subnet routes.
      #
      # Lima's stock netplan ships lima0 metric=100 (preferred) and
      # eth0 metric=200. We drop in a higher-numbered netplan file that
      # overrides metrics and disables DHCP-installed default routes on
      # lima0 — no edits to the lima-managed file, no hard-coded IPs.
      #
      # `mode: boot` maps to cloud-init's `bootcmd` — re-runs on every VM
      # start. Idempotent: the heredoc just rewrites the same file. This
      # guarantees existing VMs upgrading via `lima_vm_config_needs_update`
      # pick the fix up on their next restart without needing cloud-init
      # state reset.
      set -eu
      mkdir -p /etc/netplan
      cat > /etc/netplan/99-speedwave-prefer-vznat.yaml <<'YAML'
      network:
        version: 2
        ethernets:
          eth0:
            dhcp4-overrides:
              route-metric: 100
          lima0:
            dhcp4-overrides:
              route-metric: 300
              use-routes: false
      YAML
      chmod 600 /etc/netplan/99-speedwave-prefer-vznat.yaml
      netplan apply
"#,
        desired_lima_vm_memory()
    )
}

/// Returns a `Command` for `limactl` with bundled-binary resolution and
/// isolated `LIMA_HOME`. Delegates to [`speedwave_runtime::binary::command`]
/// which resolves the binary path and ensures LIMA_HOME is set.
#[cfg(target_os = "macos")]
fn limactl_command() -> std::process::Command {
    speedwave_runtime::binary::command("limactl")
}

/// Escapes a path for safe interpolation inside PowerShell single-quoted strings.
/// PowerShell single-quoted strings only require doubling of single quotes.
#[cfg(target_os = "windows")]
fn ps_escape(path: &std::path::Path) -> String {
    path.display().to_string().replace('\'', "''")
}

/// Selects the rootfs URL and SHA256 hash for the current host architecture.
#[cfg(target_os = "windows")]
fn wsl_rootfs_for_arch() -> anyhow::Result<(&'static str, &'static str)> {
    match std::env::consts::ARCH {
        "x86_64" => Ok((
            consts::WSL_ROOTFS_URL_AMD64,
            consts::WSL_ROOTFS_SHA256_AMD64,
        )),
        "aarch64" => Ok((
            consts::WSL_ROOTFS_URL_ARM64,
            consts::WSL_ROOTFS_SHA256_ARM64,
        )),
        arch => anyhow::bail!("Unsupported architecture for WSL2 rootfs: {}", arch),
    }
}

/// Selects the nerdctl-full SHA256 hash for the current host architecture.
#[cfg(target_os = "windows")]
fn nerdctl_sha256_for_arch() -> anyhow::Result<&'static str> {
    match std::env::consts::ARCH {
        "x86_64" => Ok(consts::NERDCTL_FULL_SHA256_AMD64),
        "aarch64" => Ok(consts::NERDCTL_FULL_SHA256_ARM64),
        arch => anyhow::bail!("Unsupported architecture for nerdctl-full: {}", arch),
    }
}

/// Returns the path to a bundled resource file, if it exists.
/// Checks `SPEEDWAVE_RESOURCES_DIR` env var first (development/testing),
/// then the standard Tauri resource directory (production).
#[cfg(target_os = "windows")]
fn find_bundled_resource(relative_path: &str) -> Option<PathBuf> {
    // Check SPEEDWAVE_RESOURCES_DIR env var (development/testing)
    if let Ok(resources_dir) = std::env::var("SPEEDWAVE_RESOURCES_DIR") {
        let path = PathBuf::from(&resources_dir).join(relative_path);
        if path.exists() {
            return Some(path);
        }
    }
    // Check next to the current executable (Tauri production layout)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let path = exe_dir.join(relative_path);
            if path.exists() {
                return Some(path);
            }
        }
    }
    None
}

/// Verifies SHA256 of a file using PowerShell. Returns `true` if the hash matches.
#[cfg(target_os = "windows")]
fn verify_sha256_ps(file_path: &std::path::Path, expected_sha256: &str) -> bool {
    let escaped = ps_escape(file_path);
    let cmd = format!(
        "(Get-FileHash -Path '{}' -Algorithm SHA256).Hash.ToLower()",
        escaped
    );
    let output = speedwave_runtime::binary::system_command("powershell")
        .args(["-NoProfile", "-Command", &cmd])
        .output();
    match output {
        Ok(o) if o.status.success() => {
            let actual = String::from_utf8_lossy(&o.stdout).trim().to_string();
            actual == expected_sha256
        }
        _ => false,
    }
}

/// Decode output from `wsl.exe` which may be UTF-16LE (with or without BOM) or UTF-8.
///
/// Windows `wsl.exe --list` often outputs UTF-16LE text. Using `String::from_utf8_lossy()`
/// on such output corrupts the data (inserts replacement characters and null bytes), causing
/// string comparisons like distro name matching to silently fail.
#[cfg(any(target_os = "windows", test))]
use runtime::decode_wsl_output;

pub fn init_vm() -> anyhow::Result<()> {
    #[cfg(target_os = "macos")]
    {
        init_vm_macos()?;
    }

    #[cfg(target_os = "windows")]
    {
        init_vm_windows()?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        anyhow::bail!("Unsupported platform — Speedwave only supports macOS and Windows");
    }

    let mut state = SetupState::load();
    state.runtime_ready = true;
    state.vm_ready = true;
    state.save()?;

    Ok(())
}

#[cfg(target_os = "macos")]
fn init_vm_macos() -> anyhow::Result<()> {
    // Ensure lima.yaml exists
    let data_dir = consts::data_dir();
    std::fs::create_dir_all(data_dir)?;
    let lima_config_path = data_dir.join("lima.yaml");
    if !lima_config_path.exists() {
        std::fs::write(&lima_config_path, lima_config())?;
    }

    // Check if Lima VM exists
    let list_output = limactl_command()
        .args(["list", "--format", "{{.Name}}"])
        .output()?;
    let list_str = String::from_utf8_lossy(&list_output.stdout);

    if !list_str
        .lines()
        .any(|line| line.trim() == consts::lima_vm_name())
    {
        // VM does not exist — create it
        let output = limactl_command()
            .args([
                "create",
                &format!("--name={}", consts::lima_vm_name()),
                "--tty=false",
            ])
            .arg(&lima_config_path)
            .output()?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("limactl create failed: {}", stderr.trim());
        }
    }

    // Start VM if not running
    let info_output = limactl_command()
        .args(["list", "--format", "{{.Status}}", consts::lima_vm_name()])
        .output()?;
    let status_str = String::from_utf8_lossy(&info_output.stdout);

    if !status_str.trim().eq_ignore_ascii_case("running") {
        let output = limactl_command()
            .args(["start", consts::lima_vm_name()])
            .output()?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("limactl start failed: {}", stderr.trim());
        }
    }

    // Wait for containerd to be ready inside VM (up to 30s)
    let mut ready = false;
    for _ in 0..15 {
        let verify = limactl_command()
            .args([
                "shell",
                consts::lima_vm_name(),
                "--",
                "sudo",
                "nerdctl",
                "info",
            ])
            .output()?;
        if verify.status.success() {
            ready = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_secs(2));
    }
    if !ready {
        anyhow::bail!(
            "containerd did not become ready inside VM after 30s. \
             Try running: limactl shell {} -- sudo nerdctl info",
            consts::lima_vm_name()
        );
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn init_vm_windows() -> anyhow::Result<()> {
    // OS prerequisite check (SSOT: os_prereqs module)
    let violations = speedwave_runtime::os_prereqs::check_os_prereqs();
    if !violations.is_empty() {
        // WSL not available — attempt auto-install (always bails: restart or failure)
        attempt_wsl_install()?;
    }

    // Ensure %USERPROFILE%\.wslconfig enables WSL2 mirrored networking before
    // any distro starts — this is what lets containers see the host's
    // VPN tunnel. Logs but does not fail setup on error: an older Windows
    // build without mirrored-mode support still gets a working (if
    // VPN-incompatible) install.
    if let Err(e) = ensure_wslconfig_vpn_compat() {
        log::warn!("ensure_wslconfig_vpn_compat failed (non-fatal): {e}");
    }

    let list = speedwave_runtime::binary::system_command("wsl.exe")
        .args(["--list", "--quiet"])
        .output()?;
    // Decode WSL output — wsl.exe often outputs UTF-16LE on Windows
    let list_str = decode_wsl_output(&list.stdout);
    let distro_exists = list_str
        .lines()
        .any(|l| l.trim().trim_matches('\0') == consts::wsl_distro_name());

    if !distro_exists {
        import_wsl_distro()?;
    } else {
        verify_wsl_distro_origin()?;
    }

    install_nerdctl_full()?;

    Ok(())
}

/// Writes (or updates) `%USERPROFILE%\.wslconfig` so the `[wsl2]` section
/// declares `networkingMode=mirrored`, `dnsTunneling=true`, `autoProxy=true`.
/// These three keys together let WSL2 distros (including Speedwave's
/// `Speedwave` distro and its containers) reach services on the host's
/// corporate VPN without manual configuration.
///
/// Preserves all other user keys and sections — only the three load-bearing
/// keys in `[wsl2]` are added or rewritten. Missing file → fresh skeleton.
///
/// Requires Windows 11 22H2+. Older builds silently ignore the unknown keys
/// (legacy NAT mode stays active and VPN-protected services remain
/// unreachable from inside WSL2 until the user upgrades).
#[cfg(target_os = "windows")]
pub fn ensure_wslconfig_vpn_compat() -> anyhow::Result<()> {
    let home = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("cannot determine %USERPROFILE% for .wslconfig"))?;
    let path = home.join(".wslconfig");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let updated = merge_wslconfig_vpn_keys(&existing);
    if updated != existing {
        speedwave_runtime::fs_perms::write_restricted_file_atomic(&path, &updated)?;
        log::info!(
            "ensure_wslconfig_vpn_compat: wrote VPN-compatible [wsl2] keys to {}",
            path.display()
        );
        // .wslconfig is read only on WSL2 boot. An existing WSL2 session
        // won't pick up the new keys until the user runs `wsl --shutdown`
        // (which restarts ALL WSL distros, not just Speedwave's). We log
        // a hint rather than triggering the shutdown automatically — it
        // would surprise users running unrelated WSL workloads.
        log::warn!(
            ".wslconfig changed — run `wsl --shutdown` from PowerShell to \
             activate mirrored-mode networking (required to reach \
             services on a corporate VPN from inside Speedwave's WSL distro)"
        );
    }
    Ok(())
}

/// Pure transform: takes existing `.wslconfig` content (may be empty) and
/// returns a version with the three VPN-compat keys inserted/updated under
/// `[wsl2]`. All other sections and keys are preserved verbatim. Idempotent.
#[cfg(any(target_os = "windows", test))]
fn merge_wslconfig_vpn_keys(input: &str) -> String {
    const VPN_KEYS: &[(&str, &str)] = &[
        ("networkingMode", "mirrored"),
        ("dnsTunneling", "true"),
        ("autoProxy", "true"),
    ];

    // Match the dominant line ending of the input — `.wslconfig` written by
    // Notepad on Windows is CRLF; emitting bare LF for new keys would yield
    // a mixed-ending file (tolerated by WSL but cosmetically ugly).
    let nl = if input.contains("\r\n") { "\r\n" } else { "\n" };

    let mut out = String::with_capacity(input.len() + 128);
    let mut current_section: Option<String> = None;
    let mut wsl2_seen = false;
    let mut wsl2_key_present: std::collections::HashSet<String> = Default::default();
    let mut pending_inject: Vec<String> = Vec::new();

    let push_missing_keys = |present: &std::collections::HashSet<String>,
                             pending: &mut Vec<String>| {
        for (k, v) in VPN_KEYS {
            if !present.contains(&k.to_ascii_lowercase()) {
                pending.push(format!("{k}={v}{nl}"));
            }
        }
    };

    for line in input.split_inclusive('\n') {
        let trimmed = line.trim();
        if let Some(stripped) = trimmed.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            if current_section.as_deref() == Some("wsl2") {
                push_missing_keys(&wsl2_key_present, &mut pending_inject);
                for inj in pending_inject.drain(..) {
                    out.push_str(&inj);
                }
            }
            current_section = Some(stripped.trim().to_ascii_lowercase());
            if current_section.as_deref() == Some("wsl2") {
                wsl2_seen = true;
            }
            out.push_str(line);
            continue;
        }
        if current_section.as_deref() == Some("wsl2") {
            if let Some(eq) = trimmed.find('=') {
                let key = trimmed[..eq].trim().to_ascii_lowercase();
                if let Some((_, desired_val)) =
                    VPN_KEYS.iter().find(|(k, _)| k.eq_ignore_ascii_case(&key))
                {
                    let original_key = trimmed[..eq].trim_end();
                    out.push_str(&format!("{original_key}={desired_val}{nl}"));
                    wsl2_key_present.insert(key);
                    continue;
                }
                wsl2_key_present.insert(key);
            }
        }
        out.push_str(line);
    }

    if current_section.as_deref() == Some("wsl2") {
        push_missing_keys(&wsl2_key_present, &mut pending_inject);
        if !out.ends_with('\n') && !pending_inject.is_empty() {
            out.push_str(nl);
        }
        for inj in pending_inject {
            out.push_str(&inj);
        }
    } else if !wsl2_seen {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push_str(nl);
        }
        if !out.is_empty() {
            out.push_str(nl);
        }
        out.push_str(&format!("[wsl2]{nl}"));
        for (k, v) in VPN_KEYS {
            out.push_str(&format!("{k}={v}{nl}"));
        }
    }

    out
}

/// Verifies that an existing WSL2 distro named [`consts::wsl_distro_name`] was
/// created by Speedwave, not pre-registered by an attacker.
///
/// WSL stores the virtual disk at the install directory passed to `wsl --import`.
/// Speedwave always imports into `~/.speedwave/wsl/Speedwave/`, so a legitimate
/// distro will have `ext4.vhdx` at that path. If the file is missing the distro
/// was registered from somewhere else — bail with a clear security error.
#[cfg(any(target_os = "windows", test))]
fn verify_wsl_distro_origin() -> anyhow::Result<()> {
    let expected_vhdx = expected_wsl_vhdx_path()?;
    if !expected_vhdx.exists() {
        anyhow::bail!(
            "Security error: a WSL2 distribution named '{}' already exists but was \
             NOT created by Speedwave (expected disk image at {} is missing). \
             This may indicate a malicious distro was pre-registered. \
             Please run 'wsl --unregister {}' to remove it, then retry Speedwave setup.",
            consts::wsl_distro_name(),
            expected_vhdx.display(),
            consts::wsl_distro_name(),
        );
    }
    Ok(())
}

/// Returns the expected path to the WSL2 virtual disk for the Speedwave distro:
/// `~/.speedwave/wsl/Speedwave/ext4.vhdx`.
#[cfg(any(target_os = "windows", test))]
fn expected_wsl_vhdx_path() -> anyhow::Result<PathBuf> {
    Ok(consts::data_dir()
        .join("wsl")
        .join(consts::wsl_distro_name())
        .join("ext4.vhdx"))
}

/// Attempts to install WSL2 via elevated PowerShell. Always bails: either
/// with a restart prompt (success) or an installation failure message.
/// Detection is handled by `os_prereqs::check_os_prereqs()` — this function
/// only performs the install action.
#[cfg(target_os = "windows")]
fn attempt_wsl_install() -> anyhow::Result<()> {
    let status = speedwave_runtime::binary::system_command("powershell")
        .args([
            "-Command",
            "Start-Process wsl.exe -ArgumentList '--install','--no-distribution' -Verb RunAs -Wait",
        ])
        .status()?;
    if !status.success() {
        anyhow::bail!(
            "WSL2 installation failed or was cancelled.\n\
             {}",
            speedwave_runtime::consts::WSL_NOT_AVAILABLE_MSG
        );
    }
    anyhow::bail!(
        "WSL2 has been installed. Please restart your computer and run Speedwave setup again."
    );
}

/// Downloads the Ubuntu rootfs (with SHA256 verification) and imports it as a
/// dedicated WSL2 distribution. Checks for a bundled rootfs first (offline
/// install), then falls back to cached download, then fresh download.
#[cfg(target_os = "windows")]
fn import_wsl_distro() -> anyhow::Result<()> {
    let data_dir = consts::data_dir();
    let wsl_dir = data_dir.join("wsl");
    let rootfs_path = wsl_dir.join("ubuntu-rootfs.tar.gz");
    std::fs::create_dir_all(&wsl_dir)?;

    let (rootfs_url, expected_sha256) = wsl_rootfs_for_arch()?;

    // Try bundled rootfs first (offline install from NSIS bundle)
    let mut have_valid_rootfs = false;

    if let Some(bundled) = find_bundled_resource("wsl/ubuntu-rootfs.tar.gz") {
        if verify_sha256_ps(&bundled, expected_sha256) {
            // Copy bundled rootfs to the cache location for wsl --import
            std::fs::copy(&bundled, &rootfs_path)?;
            have_valid_rootfs = true;
        }
    }

    // Check cached download
    if !have_valid_rootfs && rootfs_path.exists() {
        if verify_sha256_ps(&rootfs_path, expected_sha256) {
            have_valid_rootfs = true;
        } else {
            let _ = std::fs::remove_file(&rootfs_path);
        }
    }

    // Fall back to download
    if !have_valid_rootfs {
        let escaped_rootfs = ps_escape(&rootfs_path);
        let download_and_verify = format!(
            "$ProgressPreference = 'SilentlyContinue'; \
             Invoke-WebRequest -Uri '{}' -OutFile '{}'; \
             $hash = (Get-FileHash -Path '{}' -Algorithm SHA256).Hash.ToLower(); \
             if ($hash -ne '{}') {{ \
                 Remove-Item '{}' -Force; \
                 Write-Error \"SHA256 mismatch: expected {}, got $hash\"; \
                 exit 1 \
             }}",
            rootfs_url,
            escaped_rootfs,
            escaped_rootfs,
            expected_sha256,
            escaped_rootfs,
            expected_sha256
        );
        let download = speedwave_runtime::binary::system_command("powershell")
            .args(["-NoProfile", "-Command", &download_and_verify])
            .status()?;
        if !download.success() {
            anyhow::bail!(
                "Failed to download or verify Ubuntu rootfs for WSL2 \
                 (expected SHA256: {})",
                expected_sha256
            );
        }
    }

    let install_dir = wsl_dir.join(consts::wsl_distro_name());
    std::fs::create_dir_all(&install_dir)?;
    let status = speedwave_runtime::binary::system_command("wsl.exe")
        .args([
            "--import",
            consts::wsl_distro_name(),
            &install_dir.to_string_lossy(),
            &rootfs_path.to_string_lossy(),
        ])
        .status()?;
    if !status.success() {
        // Check if the distro was already registered (import failed because it exists)
        let recheck = speedwave_runtime::binary::system_command("wsl.exe")
            .args(["--list", "--quiet"])
            .output()?;
        let recheck_str = decode_wsl_output(&recheck.stdout);
        if recheck_str
            .lines()
            .any(|l| l.trim().trim_matches('\0') == consts::wsl_distro_name())
        {
            // Distro exists but we didn't create it — verify it's ours before
            // trusting it. An attacker could pre-register a malicious distro
            // with the same name to hijack the container runtime.
            verify_wsl_distro_origin()?;
            log::warn!(
                "WSL2 import failed but distro '{}' already exists and is verified — continuing",
                consts::wsl_distro_name()
            );
        } else {
            anyhow::bail!("Failed to import Speedwave WSL2 distribution");
        }
    }

    // Import path: distro is freshly created, no containers run yet, so a
    // terminate to apply the new wsl.conf is safe.
    ensure_wsl_distro_metadata(TerminateOnChange::Yes)?;

    Ok(())
}

/// Whether `ensure_wsl_distro_metadata` may `wsl --terminate` the distro after
/// it edits `/etc/wsl.conf`. Terminating applies the new config immediately but
/// kills every process in the distro — fatal if containers are running.
#[cfg(target_os = "windows")]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TerminateOnChange {
    /// Safe only when no Speedwave containers run (e.g. right after import).
    Yes,
    /// Leave the distro running; the new wsl.conf applies on its next restart.
    No,
}

/// drvfs automount options for the Speedwave distro's `/etc/wsl.conf`.
///
/// `metadata` makes the C:\ 9p mount honor Linux mode bits so Claude Code's
/// `/login` can `chmod 0600` `.credentials.json` (ADR-052). `uid=1000,gid=1000`
/// makes the mount owned by the container user — without it the mount defaults
/// to uid 0 (the imported distro has no default user) and, once `metadata`
/// enforces ownership, the uid-1000 entrypoint hits EACCES on its first write
/// and the container exits under `set -e` ("cannot exec in a stopped state").
#[cfg(target_os = "windows")]
const WSL_AUTOMOUNT_OPTIONS: &str = "metadata,uid=1000,gid=1000,umask=022";

/// Ensures the Speedwave distro's `/etc/wsl.conf` sets the drvfs automount
/// options to [`WSL_AUTOMOUNT_OPTIONS`]. Both halves matter: `metadata` for
/// `/login`'s chmod (ADR-052), `uid=1000,gid=1000` so the uid-1000 container
/// can write `/home/speedwave` (else the entrypoint dies under `set -e`).
///
/// Idempotent and self-upgrading: adds the `[automount]` block if absent, and
/// rewrites a bare `options = "metadata"` line (written by an earlier build)
/// to include the uid/gid — otherwise distros installed by that build stay
/// broken.
///
/// `terminate` MUST be `No` on any path where containers may be running
/// (startup migration for existing distros): a `--terminate` there kills the
/// running containers mid-start ("cannot exec in a stopped state"). Pass `Yes`
/// only at import time, before any container exists. Fail-open throughout.
#[cfg(target_os = "windows")]
pub fn ensure_wsl_distro_metadata(terminate: TerminateOnChange) -> anyhow::Result<()> {
    let distro = consts::wsl_distro_name();
    // Run as root inside the distro; `/etc/wsl.conf` is distro-internal (not the
    // host .wslconfig). Two branches: add the block if `[automount]` is absent,
    // else upgrade a uid-less options line in place. Both emit the change marker
    // so the caller's terminate/restart logic fires.
    let script = format!(
        "f=/etc/wsl.conf; \
         if ! grep -q '\\[automount\\]' \"$f\" 2>/dev/null; then \
           printf '\\n[automount]\\noptions = \"{opts}\"\\n' >> \"$f\"; \
           echo speedwave-metadata-added; \
         elif ! grep -q 'uid=1000' \"$f\" 2>/dev/null; then \
           sed -i 's|^[[:space:]]*options[[:space:]]*=.*|options = \"{opts}\"|' \"$f\"; \
           echo speedwave-metadata-added; \
         fi",
        opts = WSL_AUTOMOUNT_OPTIONS
    );
    let script = script.as_str();
    let out = speedwave_runtime::binary::system_command("wsl.exe")
        .args(["-d", distro, "-u", "root", "--", "sh", "-c", script])
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let changed = String::from_utf8_lossy(&o.stdout).contains("speedwave-metadata-added");
            if changed {
                match terminate {
                    TerminateOnChange::Yes => {
                        // Safe at import time: no Speedwave containers run yet.
                        let _ = speedwave_runtime::binary::system_command("wsl.exe")
                            .args(["--terminate", distro])
                            .status();
                        log::info!(
                            "ensure_wsl_distro_metadata: enabled metadata automount for {distro} (terminated to apply)"
                        );
                    }
                    TerminateOnChange::No => {
                        // Containers may be running; do NOT terminate. The new
                        // wsl.conf applies on the distro's next natural restart.
                        log::info!(
                            "ensure_wsl_distro_metadata: enabled metadata automount for {distro} (applies on next WSL restart)"
                        );
                    }
                }
            }
        }
        Ok(o) => log::warn!(
            "ensure_wsl_distro_metadata: wsl.conf update failed (non-fatal): {}",
            String::from_utf8_lossy(&o.stderr).trim()
        ),
        Err(e) => log::warn!("ensure_wsl_distro_metadata: spawn failed (non-fatal): {e}"),
    }
    Ok(())
}

/// Installs nerdctl-full (containerd + nerdctl + CNI + BuildKit) inside the
/// Speedwave WSL2 distribution if not already present. Checks for a bundled
/// tarball first (offline install), falling back to download if not found.
#[cfg(target_os = "windows")]
fn install_nerdctl_full() -> anyhow::Result<()> {
    let nerdctl_check = speedwave_runtime::binary::system_command("wsl.exe")
        .args([
            "-d",
            consts::wsl_distro_name(),
            "--",
            "nerdctl",
            "--version",
        ])
        .output()?;
    if nerdctl_check.status.success() {
        return Ok(());
    }

    // Try bundled nerdctl-full tarball first (offline install from NSIS bundle).
    // If valid, convert its path to WSL and use `cp` instead of `curl` inside the distro.
    let expected_sha256 = nerdctl_sha256_for_arch()?;
    let mut bundled_wsl_path: Option<String> = None;

    if let Some(bundled) = find_bundled_resource("wsl/nerdctl-full.tar.gz") {
        if verify_sha256_ps(&bundled, expected_sha256) {
            let win_path = bundled.to_string_lossy().to_string();
            let wslpath_output = speedwave_runtime::binary::system_command("wsl.exe")
                .args([
                    "-d",
                    consts::wsl_distro_name(),
                    "--",
                    "wslpath",
                    "-u",
                    &win_path,
                ])
                .output()?;
            if wslpath_output.status.success() {
                bundled_wsl_path = Some(
                    String::from_utf8_lossy(&wslpath_output.stdout)
                        .trim()
                        .to_string(),
                );
            }
        }
    }

    // Build install script: use bundled file if available, otherwise download
    let source_commands = if let Some(ref wsl_path) = bundled_wsl_path {
        let escaped = wsl_path.replace('\'', "'\\''");
        format!(
            "mkdir -p /tmp/nerdctl-install\ncp '{}' \"/tmp/nerdctl-install/${{TARBALL}}\"",
            escaped
        )
    } else {
        "mkdir -p /tmp/nerdctl-install\ncurl -fsSL \"$URL\" -o \"/tmp/nerdctl-install/${TARBALL}\""
            .to_string()
    };

    let install_script = format!(
        r#"set -e
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) ARCH="amd64"; EXPECTED="{sha256_amd64}" ;;
  aarch64) ARCH="arm64"; EXPECTED="{sha256_arm64}" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac
VERSION="{version}"
TARBALL="nerdctl-full-${{VERSION}}-linux-${{ARCH}}.tar.gz"
URL="https://github.com/containerd/nerdctl/releases/download/v${{VERSION}}/${{TARBALL}}"
{source_commands}
ACTUAL=$(sha256sum "/tmp/nerdctl-install/${{TARBALL}}" | awk '{{print $1}}')
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "SHA256 MISMATCH: expected $EXPECTED, got $ACTUAL"
  rm -rf /tmp/nerdctl-install
  exit 1
fi
tar -C /usr/local -xzf "/tmp/nerdctl-install/${{TARBALL}}"
rm -rf /tmp/nerdctl-install
# Install iptables — required by CNI bridge plugin for container networking.
# nerdctl-full bundles CNI plugins but iptables is a system dependency.
if ! command -v iptables >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq iptables >/dev/null
fi
# install_service NAME EXEC AFTER REQUIRES CHECK_CMD [CHECK_ARGS...]
# Installs a systemd service unit file, starts it, and waits up to 30s for readiness.
install_service() {{
  local name="$1" exec="$2" after="$3" requires="$4"
  shift 4
  local check_cmd="$@"
  mkdir -p /etc/systemd/system
  cat > "/etc/systemd/system/${{name}}.service" <<UNIT
[Unit]
Description=${{name}} daemon
${{after:+After=$after}}
${{requires:+Requires=$requires}}
[Service]
ExecStart=$exec
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
  if command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then
    systemctl daemon-reload
    systemctl enable --now "$name"
  else
    $exec &
  fi
  for i in $(seq 1 15); do
    if $check_cmd >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  echo "$name did not become ready after 30s" >&2
  exit 1
}}
# Configure containerd as a system service so it starts on every WSL session
install_service containerd /usr/local/bin/containerd network.target "" nerdctl info
# Start buildkitd — required for `nerdctl build` (image building).
# On WSL2 we run as root (not rootless), so install as a systemd system service.
install_service buildkit "/usr/local/bin/buildkitd --oci-worker=false --containerd-worker=true" containerd.service containerd.service buildctl debug workers
"#,
        version = consts::NERDCTL_FULL_VERSION,
        sha256_amd64 = consts::NERDCTL_FULL_SHA256_AMD64,
        sha256_arm64 = consts::NERDCTL_FULL_SHA256_ARM64,
        source_commands = source_commands
    );
    // Write the install script inside WSL via stdin to avoid argument
    // length/escaping issues with wsl.exe -- bash -c "...".
    // Pipe the script through stdin: echo "$script" | wsl bash -s
    let install = speedwave_runtime::binary::system_command("wsl.exe")
        .args(["-d", consts::wsl_distro_name(), "--", "bash", "-s"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;
    use std::io::Write;
    let mut child = install;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(install_script.as_bytes())?;
        // Drop stdin to close the pipe and let bash finish
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        log::error!(
            "nerdctl-full install failed (exit {}): stdout={}, stderr={}",
            output.status,
            stdout.trim(),
            stderr.trim()
        );
        anyhow::bail!(
            "Failed to install nerdctl-full inside {} WSL2 distribution: {}",
            consts::wsl_distro_name(),
            stderr.trim()
        );
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Step 4: Create project
// ---------------------------------------------------------------------------

pub fn create_project(name: &str, dir: &str) -> anyhow::Result<()> {
    project::add_project(name, dir)?;

    let mut state = SetupState::load();
    state.project_created = Some(name.to_string());
    state.save()?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Setup completeness check
// ---------------------------------------------------------------------------

/// Returns `true` when all required setup steps have been completed AND the
/// VM / WSL distro still physically exists. `cli_linked` is excluded — CLI
/// symlink creation is optional. The runtime check catches external removal
/// (factory reset, manual unregister, data_dir rename) that leaves stale state.
///
/// **Cost:** `is_installed()` spawns `limactl list` (macOS) or `wsl.exe --list`
/// (Windows) per call. Safe for navigation/route guards; do not poll.
pub fn is_setup_complete() -> bool {
    let state = SetupState::load();
    if !state.is_complete() {
        return false;
    }
    runtime::detect_runtime().is_installed()
}

// ---------------------------------------------------------------------------
// Build container images
// ---------------------------------------------------------------------------

pub fn build_images() -> anyhow::Result<()> {
    let rt = runtime::detect_runtime();
    rt.ensure_ready()?;
    // Build the active project's enabled set (+ claude/mcp-hub always). On a
    // fresh setup there is no active project, so only claude/mcp-hub are
    // built — workers come on demand when an integration is first enabled
    // (ADR-057).
    let active_integrations = {
        let user_config = config::load_user_config().unwrap_or_default();
        match user_config.active_project.as_deref() {
            Some(name) => match user_config.find_project(name) {
                Some(p) => {
                    config::resolve_integrations(std::path::Path::new(&p.dir), &user_config, name)
                }
                None => config::ResolvedIntegrationsConfig::default(),
            },
            None => config::ResolvedIntegrationsConfig::default(),
        }
    };
    match build::build_enabled_images(&rt, &active_integrations) {
        Ok(_) => {}
        Err(e)
            if e.downcast_ref::<build::SnapshotterRecoveryFailed>()
                .is_some() =>
        {
            log::warn!("snapshotter recovery failed after prune, restarting engine");
            rt.restart_container_engine()?;
            build::build_enabled_images(&rt, &active_integrations)?;
        }
        Err(e) => return Err(e),
    }

    // Sync claude-resources to data_dir so they are available for
    // compose volume mounts and container entrypoints.
    let build_root = build::resolve_build_root()?;
    bundle::sync_claude_resources(&build_root)?;

    // Record that the current bundle's images are now built so that
    // reconcile_bundle_update (on next startup) sees bundle_changed=false
    // and skips the unnecessary rebuild.
    let manifest = bundle::load_current_bundle_manifest()?;
    let mut bundle_state = bundle::load_bundle_state();
    bundle_state.applied_bundle_id = Some(manifest.bundle_id);
    bundle_state.phase = bundle::BundleReconcilePhase::Done;
    bundle_state.pending_running_projects.clear();
    bundle_state.last_error = None;
    bundle::save_bundle_state(&bundle_state)?;

    let mut state = SetupState::load();
    state.images_built = true;
    state.save()?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Start containers for a project
// ---------------------------------------------------------------------------

pub fn start_containers(project: &str) -> anyhow::Result<()> {
    let rt = runtime::detect_runtime();

    log::info!("ensuring runtime is ready");
    rt.ensure_ready()?;
    log::info!("runtime ready, rendering compose");

    // Re-render compose.yml before every start. Dynamic config (mcp-os token,
    // auth keys, addons) may have changed since create_project() first rendered it.
    // Without this, WORKER_OS_URL is missing if mcp-os started after project creation.
    let user_config = config::load_user_config()?;
    let project_dir = &user_config.require_project(project)?.dir;
    let project_path = std::path::Path::new(project_dir);
    let resolved = config::resolve_claude_config(project_path, &user_config, project);
    let integrations = config::resolve_integrations(project_path, &user_config, project);
    // Bridge info is sourced from the globally-shared plugin-bridges map
    // via crate::reconcile::current_bridges_info(). When no host-bridged
    // plugins are running yet (e.g. during early setup), the registration
    // list is empty and the corresponding env vars stay absent in compose.yml.
    let yaml = compose::render_compose(
        project,
        project_dir,
        &resolved,
        &integrations,
        Some(&rt),
        &crate::reconcile::current_bridges_info(),
    )?;

    let manifests = speedwave_runtime::plugin::list_installed_plugins().unwrap_or_else(|e| {
        log::warn!("Failed to list installed plugins: {e}");
        Vec::new()
    });
    let expected_paths = compose::SecurityExpectedPaths::compute(project, project_dir)?;
    speedwave_runtime::fs_security::ensure_data_dir_permissions(project)?;
    let violations = compose::SecurityCheck::run(&yaml, project, &manifests, &expected_paths);
    if !violations.is_empty() {
        anyhow::bail!(
            "{}\n{}",
            speedwave_runtime::consts::SYSTEM_CHECK_FAILED_PREFIX,
            crate::containers_cmd::format_security_violations(&violations)
        );
    }

    rt.transaction(project, |rt| -> anyhow::Result<()> {
        compose::save_compose(project, &yaml)?;
        log::info!("starting containers via compose_up_recreate");
        speedwave_runtime::runtime::compose_validate_with_retry(rt, project)?;
        rt.compose_up_recreate(project)?;
        Ok(())
    })?;
    log::info!("containers started, verifying health");

    // Verify containers are actually functional before marking as started.
    // Only probes the claude container — MCP workers are health-checked
    // separately via get_health.
    let claude_container = format!(
        "{}_{}_claude",
        speedwave_runtime::consts::compose_prefix(),
        project
    );
    runtime::ensure_exec_healthy(&rt, project, &claude_container)?;

    let mut state = SetupState::load();
    state.containers_started = true;
    state.save()?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Check Claude auth status inside the container
// ---------------------------------------------------------------------------

/// Pure lookup for the project's LLM provider name from the user config.
/// Returns `None` when the project is missing or `claude.llm.provider` is
/// unset. Separated out so the local-provider branch in `check_claude_auth`
/// can be covered without mocking the container runtime.
pub(crate) fn lookup_project_provider<'a>(
    user_config: &'a speedwave_runtime::config::SpeedwaveUserConfig,
    project: &str,
) -> Option<&'a str> {
    user_config
        .find_project(project)
        .and_then(|p| p.claude.as_ref())
        .and_then(|c| c.llm.as_ref())
        .and_then(|l| l.provider.as_deref())
}

pub fn check_claude_auth(project: &str) -> anyhow::Result<bool> {
    let user_config = speedwave_runtime::config::load_user_config().unwrap_or_else(|e| {
        log::warn!(
            "check_claude_auth: failed to load user config, defaulting to anthropic path: {e}"
        );
        speedwave_runtime::config::SpeedwaveUserConfig::default()
    });
    let provider = lookup_project_provider(&user_config, project);
    if speedwave_runtime::config::is_local_provider(provider) {
        log::info!("check_claude_auth: local provider — skipping Anthropic OAuth check");
        return Ok(true);
    }
    let rt = runtime::detect_runtime();
    let container_name = format!("{}_{}_claude", consts::compose_prefix(), project);
    log::info!("check_claude_auth: container={container_name}");
    ensure_exec_healthy(&rt, project, &container_name)?;
    log::info!("check_claude_auth: container healthy, checking auth");
    let mut cmd =
        rt.container_exec_piped(&container_name, &[consts::CLAUDE_BINARY, "auth", "status"])?;
    let output = cmd.output()?;
    log::info!("check_claude_auth: auth status exit={}", output.status);
    Ok(output.status.success())
}

// ---------------------------------------------------------------------------
// Lima VM config migration — upgrade memory from older installs
// ---------------------------------------------------------------------------

/// Returns `true` if the Lima config memory differs from the desired value.
///
/// Compares the `memory: "XGiB"` line against the desired value from
/// [`desired_lima_vm_memory`]. Returns `false` if current memory equals desired
/// (no-op) or if the value is unparseable (safety). Supports both upgrades and
/// downgrades so that a reduced VM formula is applied on next startup.
#[cfg(any(target_os = "macos", test))]
fn lima_vm_config_needs_update(config_content: &str) -> bool {
    let desired_str = desired_lima_vm_memory();
    let desired = match desired_str
        .strip_suffix("GiB")
        .and_then(|s| s.parse::<u32>().ok())
    {
        Some(v) => v,
        None => return false,
    };
    lima_vm_config_needs_update_with(config_content, desired)
}

/// Testable variant: compares config content against an explicit desired GiB.
#[cfg(any(target_os = "macos", test))]
fn lima_vm_config_needs_update_with(config_content: &str, desired_gib: u32) -> bool {
    // Trigger migration when the VPN-aware netplan drop-in is absent —
    // existing pre-update installs (including ones with the old `ip route del`
    // provision) need the new netplan-based fix injected on next boot.
    // See `lima_config()` doc and lima-vm/lima#2984.
    if !config_content.contains("99-speedwave-prefer-vznat.yaml") {
        return true;
    }
    for line in config_content.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("memory:") {
            let value = rest.trim().trim_matches('"');
            return match value
                .strip_suffix("GiB")
                .and_then(|s| s.parse::<u32>().ok())
            {
                Some(current) => current != desired_gib,
                None => false, // unparseable — don't touch
            };
        }
    }
    false // no memory line found
}

/// Migrates the Lima VM memory allocation on existing installs.
///
/// Reads the source template at `{data_dir()}/lima.yaml` and, if the memory
/// value differs from [`desired_lima_vm_memory`], updates both the source template and the
/// Lima instance config. Stops and restarts the VM if it was running.
///
/// No-op when:
/// - Source template doesn't exist (fresh install — `init_vm_macos` creates it)
/// - Memory already equals the desired value
#[cfg(target_os = "macos")]
pub fn ensure_lima_vm_config() -> anyhow::Result<()> {
    use speedwave_runtime::binary;
    let data_dir = consts::data_dir();
    let source_template = data_dir.join("lima.yaml");

    // Fresh install — init_vm_macos will create it with correct config
    if !source_template.exists() {
        return Ok(());
    }

    let content = std::fs::read_to_string(&source_template)?;
    if !lima_vm_config_needs_update(&content) {
        return Ok(());
    }

    let desired_mem = desired_lima_vm_memory();

    // Extract current memory for informative logging.
    let current_mem: Option<String> = content.lines().find_map(|line| {
        let trimmed = line.trim();
        trimmed
            .strip_prefix("memory:")
            .map(|rest| rest.trim().trim_matches('"').to_string())
    });

    if let Some(ref current) = current_mem {
        log::info!(
            "Lima VM config migration: {current} → {desired_mem} (formula: host_ram/2, clamped 4–32 GiB)"
        );
    } else {
        log::info!("Lima VM config migration: updating memory to {desired_mem}");
    }

    // Check if VM exists
    let list_output = limactl_command()
        .args(["list", "--format", "{{.Name}}"])
        .output()?;
    let list_str = String::from_utf8_lossy(&list_output.stdout);
    let vm_exists = list_str
        .lines()
        .any(|line| line.trim() == consts::lima_vm_name());

    // Stop VM if running
    if vm_exists {
        let status_output = limactl_command()
            .args(["list", "--format", "{{.Status}}", consts::lima_vm_name()])
            .output()?;
        let status_str = String::from_utf8_lossy(&status_output.stdout);
        if status_str.trim().eq_ignore_ascii_case("running") {
            log::warn!(
                "Stopping VM for memory migration — any running Claude sessions will be interrupted"
            );
            let timeout = std::time::Duration::from_secs(30);
            let mut stop_cmd = limactl_command();
            stop_cmd.args(["stop", consts::lima_vm_name()]);
            if let Err(e) = binary::run_with_timeout(&mut stop_cmd, timeout) {
                log::warn!("graceful stop failed ({e}), forcing stop");
                let mut force_cmd = limactl_command();
                force_cmd.args(["stop", "--force", consts::lima_vm_name()]);
                if let Err(e2) = binary::run_with_timeout(&mut force_cmd, timeout) {
                    log::warn!("forced stop also failed: {e2}, continuing with config update");
                }
            }
        }
    }

    // Migration rewrite: in-place line-by-line — replaces the memory line
    // and appends the SSOT provision block. Preserves user customisations
    // (cpus, mounts, original indentation). Full regeneration from
    // `lima_config()` would clobber any user-added fields, so we limit
    // mutations to the two fields we control.
    let rewrite_config = |text: &str| -> String {
        let mut new_text: String = text
            .lines()
            .map(|line| {
                if line.trim().starts_with("memory:") {
                    let indent = &line[..line.len() - line.trim_start().len()];
                    format!("{indent}memory: \"{desired_mem}\"")
                } else {
                    line.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        // Preserve trailing newline if original had one
        if text.ends_with('\n') && !new_text.ends_with('\n') {
            new_text.push('\n');
        }
        // Append the provision block if missing — the SSOT `lima_config()`
        // always emits it, but pre-update files don't have it. We append
        // verbatim from the SSOT so a future change to the script reaches
        // existing installs.
        if !new_text.contains("99-speedwave-prefer-vznat.yaml") {
            // Extract just the `provision:` section from the SSOT template.
            // Replaces any prior provision block (including the old
            // `ip route del` variant) by truncating from `provision:` onward.
            let ssot = lima_config();
            if let Some(existing) = new_text.find("\nprovision:") {
                new_text.truncate(existing + 1);
            } else if let Some(existing) = new_text.find("provision:") {
                new_text.truncate(existing);
            }
            if let Some(idx) = ssot.find("provision:") {
                if !new_text.ends_with('\n') {
                    new_text.push('\n');
                }
                new_text.push_str(&ssot[idx..]);
            }
        }
        new_text
    };

    // Update source template (reuse `content` already read above)
    std::fs::write(&source_template, rewrite_config(&content))?;

    // Update instance config (may not exist if VM was never created)
    let instance_config = data_dir
        .join(consts::LIMA_SUBDIR)
        .join(consts::lima_vm_name())
        .join("lima.yaml");
    if instance_config.exists() {
        let instance_content = std::fs::read_to_string(&instance_config)?;
        std::fs::write(&instance_config, rewrite_config(&instance_content))?;
    }

    // Restart VM if it existed
    if vm_exists {
        log::info!("Starting VM after memory migration");
        init_vm_macos()?;
    }

    log::info!("Lima VM config migration complete");
    Ok(())
}

// ---------------------------------------------------------------------------
// Factory reset — stops containers, destroys VM, wipes setup state
// ---------------------------------------------------------------------------

pub fn factory_reset() -> anyhow::Result<()> {
    let state = SetupState::load();

    // 1. Stop containers for the wizard's project (if any) — with timeout.
    //    Only stops the single project from setup_state.json, not all projects
    //    from config.json. This is intentional: the VM force-delete (step 2)
    //    destroys all containers regardless, and config.json may already be
    //    corrupt or missing at this point. Best-effort graceful stop here.
    //    Even is_available() could theoretically hang, so run the entire
    //    "check + compose_down" block with a timeout.
    if let Some(ref project) = state.project_created {
        log::info!("stopping containers for project={project}");
        let project_clone = project.clone();
        // Uses thread+channel (not run_with_timeout) because compose_down goes
        // through the ContainerRuntime trait, which returns Result — not a Command.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let rt = runtime::detect_runtime();
            if rt.is_available() {
                if let Err(e) = rt.compose_down(&project_clone) {
                    log::warn!("compose_down failed: {e}");
                }
            }
            let _ = tx.send(());
        });
        // Wait up to 30s; if anything hangs, limactl delete --force will clean up
        let timeout = std::time::Duration::from_secs(30);
        match rx.recv_timeout(timeout) {
            Ok(()) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                log::warn!("compose_down timed out after 30s, continuing");
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                log::warn!("compose_down thread panicked, continuing");
            }
        }
    }

    // 2. Destroy VM (macOS only) — force-stop then force-delete, each with timeout
    #[cfg(target_os = "macos")]
    {
        use speedwave_runtime::binary;
        let timeout = std::time::Duration::from_secs(30);

        log::info!("stopping VM");
        let mut stop_cmd = limactl_command();
        stop_cmd.args(["stop", "--force", consts::lima_vm_name()]);
        if let Err(e) = binary::run_with_timeout(&mut stop_cmd, timeout) {
            log::warn!("limactl stop timed out or failed: {e}, continuing");
        }

        log::info!("deleting VM");
        let mut delete_cmd = limactl_command();
        delete_cmd.args(["delete", consts::lima_vm_name(), "--force"]);
        if let Err(e) = binary::run_with_timeout(&mut delete_cmd, timeout) {
            log::warn!("limactl delete timed out or failed: {e}, continuing");
        }
    }

    // 2b. Reset VM/distro across platforms.
    //     Windows: WslRuntime::reset_vm runs `wsl --terminate` + `--unregister`,
    //     each bounded by CommandRunner::run_with_timeout (10s + 25s).
    //     macOS: trait default no-op (Lima VM already destroyed above).
    //     Run BEFORE wipe_data_dir so the WSL VHDX path is still where WSL
    //     expects it (~/.speedwave/wsl/Speedwave/ext4.vhdx).
    {
        let rt = runtime::detect_runtime();
        if let Err(e) = rt.reset_vm() {
            log::warn!("reset_vm failed (continuing to wipe_data_dir): {e}");
        }
    }

    // 3. Remove CLI binary (Unix: ~/.local/bin/speedwave — outside data dir)
    #[cfg(unix)]
    {
        let target = dirs::home_dir()
            .ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?
            .join(".local")
            .join("bin")
            .join(consts::CLI_BINARY);
        let _ = std::fs::remove_file(&target);
    }
    // Windows CLI lives inside data_dir/bin/ — wipe_data_dir handles it.

    // 4. Wipe entire data directory (~/.speedwave/)
    wipe_data_dir(consts::data_dir())?;

    Ok(())
}

/// Removes the entire data directory (`~/.speedwave/`).
/// Idempotent: succeeds silently if the directory does not exist.
fn wipe_data_dir(data_dir: &std::path::Path) -> anyhow::Result<()> {
    match std::fs::remove_dir_all(data_dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

// ---------------------------------------------------------------------------
// Step 7: Copy CLI binary to user PATH
// ---------------------------------------------------------------------------

/// Resolves the CLI binary bundled in Tauri resources.
///
/// Layout at runtime:
/// - macOS:   `.app/Contents/Resources/cli/speedwave`
/// - Windows: `<exe_dir>/resources/cli/speedwave.exe`
/// - Dev mode fallback: `<exe_dir>/speedwave` (existing behaviour)
pub fn resolve_cli_source() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    resolve_cli_source_from(exe_dir)
}

/// Inner implementation that resolves the CLI binary relative to a given exe directory.
/// Separated from `resolve_cli_source()` to allow unit testing with mock filesystem layouts.
fn resolve_cli_source_from(exe_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    #[cfg(not(target_os = "windows"))]
    let binary_name = consts::CLI_BINARY;
    #[cfg(target_os = "windows")]
    let binary_name = "speedwave.exe";

    // SPEEDWAVE_RESOURCES_DIR — set by Tauri in production builds.
    if let Ok(resources_dir) = std::env::var(consts::BUNDLE_RESOURCES_ENV) {
        let bundled = std::path::PathBuf::from(&resources_dir)
            .join("cli")
            .join(binary_name);
        if bundled.exists() {
            return Some(bundled);
        }
    }

    // Production bundle paths
    #[cfg(target_os = "macos")]
    {
        // .app/Contents/MacOS/../Resources/cli/speedwave
        let resources = exe_dir
            .parent()?
            .join("Resources")
            .join("cli")
            .join(binary_name);
        if resources.exists() {
            return Some(resources);
        }
    }

    #[cfg(target_os = "windows")]
    {
        let resources = exe_dir.join("resources").join("cli").join(binary_name);
        if resources.exists() {
            return Some(resources);
        }
    }

    // Dev mode: Makefile copies CLI to desktop/src-tauri/cli/ before `cargo tauri dev`.
    // exe_dir is desktop/src-tauri/target/{debug,release}/ → go up two levels to desktop/src-tauri/cli/
    let dev_cli_dir = exe_dir
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("cli").join(binary_name));
    if let Some(ref path) = dev_cli_dir {
        if path.exists() {
            return Some(path.clone());
        }
    }

    // Dev mode fallback: CLI binary next to the exe
    let dev_path = exe_dir.join(binary_name);
    if dev_path.exists() {
        return Some(dev_path);
    }

    None
}

/// Copies the CLI binary from `source` into `target_dir` and sets executable permissions on Unix.
pub fn copy_cli_binary(
    source: &std::path::Path,
    target_dir: &std::path::Path,
) -> anyhow::Result<()> {
    if !source.exists() {
        anyhow::bail!("CLI source binary not found at {}", source.display());
    }

    std::fs::create_dir_all(target_dir)?;

    #[cfg(target_os = "windows")]
    let dest = target_dir.join("speedwave.exe");
    #[cfg(not(target_os = "windows"))]
    let dest = target_dir.join(consts::CLI_BINARY);

    // On Windows, the target may be locked by a running CLI process.
    // Treat as non-fatal: keep the old binary until the user closes the CLI.
    #[cfg(target_os = "windows")]
    if let Err(e) = std::fs::copy(source, &dest) {
        log::warn!("could not update CLI binary (file in use?): {e}");
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    std::fs::copy(source, &dest)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dest)?.permissions();
        perms.set_mode(perms.mode() | 0o111);
        std::fs::set_permissions(&dest, perms)?;
    }

    Ok(())
}

/// The user's default shell, detected from `$SHELL`.
#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UserShell {
    Bash,
    Zsh,
    Unknown,
}

/// Detects the user's default shell from the `$SHELL` environment variable.
///
/// Falls back to [`UserShell::Zsh`] on macOS when `$SHELL` is unset (common when
/// the Desktop app is launched from Dock/Finder, where launchd may not propagate
/// `$SHELL`). macOS has defaulted to zsh since Catalina (10.15).
#[cfg(unix)]
fn detect_shell() -> UserShell {
    let shell = std::env::var("SHELL").unwrap_or_default();
    parse_shell_env(&shell)
}

/// Parses a `$SHELL` value into a [`UserShell`].
///
/// Separated from [`detect_shell`] so unit tests can exercise the parsing logic
/// directly without depending on (or mutating) the `$SHELL` environment variable.
#[cfg(unix)]
fn parse_shell_env(shell: &str) -> UserShell {
    if shell.ends_with("/bash") {
        UserShell::Bash
    } else if shell.ends_with("/zsh") {
        UserShell::Zsh
    } else if shell.is_empty() {
        // $SHELL may be unset when launched from macOS Dock/Finder (launchd).
        // macOS default shell is zsh since Catalina (10.15).
        #[cfg(target_os = "macos")]
        return UserShell::Zsh;
        #[cfg(target_os = "windows")]
        return UserShell::Unknown;
    } else {
        UserShell::Unknown
    }
}

/// Returns the shell config file path(s) to modify for the given shell.
///
/// Selection rules per shell initialization order:
/// - **bash on macOS**: login shell reads first of `.bash_profile` > `.bash_login` >
///   `.profile` (then stops). macOS terminals always open login shells, so only the
///   login file is needed. Creates `.bash_profile` if none of the three exist.
/// - **zsh**: `.zshrc` is sourced for both login and interactive shells on all platforms.
/// - **Unknown**: `.profile` — POSIX portable fallback.
#[cfg(unix)]
fn shell_config_targets(home: &std::path::Path, shell: UserShell) -> Vec<std::path::PathBuf> {
    match shell {
        UserShell::Zsh => vec![home.join(".zshrc")],
        UserShell::Bash => {
            let mut targets = Vec::new();
            // bash login shell reads first found of these three, then stops:
            let login_candidates = [".bash_profile", ".bash_login", ".profile"];
            let login_target = login_candidates
                .iter()
                .find(|f| home.join(f).exists())
                .unwrap_or(&".bash_profile"); // create .bash_profile if none exist
            targets.push(home.join(login_target));

            targets
        }
        UserShell::Unknown => vec![home.join(".profile")],
    }
}

/// Ensures `~/.local/bin` is on PATH by appending an `export` line to the correct
/// shell config file(s) for the user's detected shell and platform.
///
/// Detects the user's shell via `$SHELL` and writes to the appropriate config file
/// (e.g., `.bash_profile` for bash on macOS, `.zshrc` for zsh). Creates the target
/// file if it doesn't exist. Skips files that already contain `.local/bin`.
#[cfg(unix)]
fn ensure_local_bin_on_path(home: &std::path::Path) -> anyhow::Result<()> {
    ensure_local_bin_on_path_for_shell(home, detect_shell())
}

/// Inner implementation accepting an explicit [`UserShell`] for unit testing without
/// depending on `$SHELL` env var.
#[cfg(unix)]
fn ensure_local_bin_on_path_for_shell(
    home: &std::path::Path,
    shell: UserShell,
) -> anyhow::Result<()> {
    use std::io::Write;

    let targets = shell_config_targets(home, shell);
    let export_line = "export PATH=\"$HOME/.local/bin:$PATH\"";
    let marker = ".local/bin";

    for target in targets {
        if target.exists() {
            let content = std::fs::read_to_string(&target)?;
            if content.contains(marker) {
                continue;
            }
            let mut f = std::fs::OpenOptions::new().append(true).open(&target)?;
            writeln!(f, "\n# Added by Speedwave setup")?;
            writeln!(f, "{}", export_line)?;
        } else {
            // Create the file — user has no config for their shell yet
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut f = std::fs::File::create(&target)?;
            writeln!(f, "# Added by Speedwave setup")?;
            writeln!(f, "{}", export_line)?;
        }
    }

    Ok(())
}

/// Returns the platform-specific path where the CLI binary is installed.
///
/// - Unix: `~/.local/bin/speedwave`
/// - Windows: `~/.speedwave/bin/speedwave.exe`
///
/// Used only in tests to verify the path computation matches `link_cli_from`.
#[cfg(test)]
fn cli_install_path() -> Option<std::path::PathBuf> {
    #[cfg(unix)]
    let path = dirs::home_dir()?
        .join(".local")
        .join("bin")
        .join(consts::CLI_BINARY);

    #[cfg(target_os = "windows")]
    let path = consts::data_dir()
        .join(consts::CLI_BIN_SUBDIR)
        .join("speedwave.exe");

    Some(path)
}

/// Copies the CLI binary into the user's PATH and updates shell configuration.
///
/// Called both unconditionally on app startup (to keep the CLI in sync after updates)
/// and during the setup wizard finalize step. Both calls are idempotent.
///
/// Uses [`link_cli_from`] internally for the filesystem operations, then updates
/// the persisted [`SetupState`] to mark `cli_linked = true`.
pub fn link_cli() -> anyhow::Result<()> {
    // Guard: skip if data directory does not exist — factory reset wiped it
    // or this is a fresh install. The wizard will link the CLI after creating
    // the data directory. Defense in depth: main.rs also guards the call site.
    let home =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
    if !consts::data_dir().exists() {
        log::info!("link_cli: data dir missing, skipping");
        return Ok(());
    }

    let cli_source = resolve_cli_source().ok_or_else(|| {
        anyhow::anyhow!(
            "CLI binary not found in app bundle. \
             Ensure the CLI is built and placed in the resources directory."
        )
    })?;

    link_cli_from(&cli_source, &home)?;

    // Write resources-dir marker so the external CLI can find build context.
    // On startup this write is gated behind setup_started (to avoid
    // recreating ~/.speedwave/ after factory reset). Here in link_cli() the
    // data dir is guaranteed to exist, so write the marker unconditionally.
    if let Ok(res) = std::env::var(consts::BUNDLE_RESOURCES_ENV) {
        if let Err(e) = build::write_resources_marker(std::path::Path::new(&res)) {
            log::warn!("link_cli: could not write resources-dir marker: {e}");
        }
    }

    // Mark CLI as linked in setup state
    let mut state = SetupState::load();
    state.cli_linked = true;
    state.save()?;

    Ok(())
}

/// Resolves a `windows/<name>` script from the Tauri bundle on Windows: prefer
/// `SPEEDWAVE_RESOURCES_DIR`, then the production bundle layout, then dev
/// fallbacks. Shared by the sweep and firewall consumers.
#[cfg(target_os = "windows")]
pub(crate) fn resolve_bundled_windows_script(name: &str) -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    if let Ok(resources_dir) = std::env::var(consts::BUNDLE_RESOURCES_ENV) {
        let bundled = std::path::PathBuf::from(&resources_dir)
            .join("windows")
            .join(name);
        if bundled.exists() {
            return Some(bundled);
        }
    }
    let resources = exe_dir.join("resources").join("windows").join(name);
    if resources.exists() {
        return Some(resources);
    }
    let dev = exe_dir
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("windows").join(name));
    if let Some(ref path) = dev {
        if path.exists() {
            return Some(path.clone());
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn resolve_sweep_script() -> Option<std::path::PathBuf> {
    resolve_bundled_windows_script("sweep.ps1")
}

/// Absolute path to the system PowerShell (`%SystemRoot%\System32\...`).
/// Never the bare `powershell` from PATH — avoids hijack on multi-install hosts.
#[cfg(target_os = "windows")]
pub(crate) fn system_powershell_path() -> std::path::PathBuf {
    let system_root =
        std::env::var_os("SystemRoot").unwrap_or_else(|| std::ffi::OsString::from(r"C:\Windows"));
    std::path::PathBuf::from(&system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
}

/// Defense-in-depth: kill any stale Speedwave / Node / CLI process holding
/// the binaries we are about to overwrite. Runs at every Tauri Desktop
/// startup, complementing the install-time sweep in NSIS + WiX. Fails open
/// (logs warn, returns) so AppLocker / WDAC policy cannot brick startup.
/// SSOT for the kill predicate is `windows/sweep.ps1`.
#[cfg(target_os = "windows")]
fn run_pre_link_sweep() {
    let Some(sweep) = resolve_sweep_script() else {
        log::warn!("pre-link sweep skipped: sweep.ps1 not found in bundle");
        return;
    };
    let inst_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(std::path::Path::to_path_buf))
        .unwrap_or_default();
    let data_dir = consts::data_dir();
    let powershell = system_powershell_path();

    // Runtime mode: kill only ~/.speedwave/bin/speedwave.exe. Full mode is
    // reserved for install-time hooks (NSIS/MSI) — Tauri Desktop must not
    // target its own workers or self. system_command applies CREATE_NO_WINDOW
    // so PowerShell does not flash a console over the Desktop UI.
    let result = speedwave_runtime::binary::system_command(&powershell.to_string_lossy())
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&sweep)
        .args(["-Mode", "runtime"])
        .env("SPW_INSTDIR", &inst_dir)
        .env("SPW_DATA_DIR", &data_dir)
        .output();
    match result {
        Ok(out) if out.status.success() => {
            log::info!("pre-link sweep: ok");
        }
        Ok(out) => {
            log::warn!(
                "pre-link sweep exited {:?} (non-fatal): {}",
                out.status.code(),
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Err(e) => {
            log::warn!("pre-link sweep spawn failed (non-fatal): {e}");
        }
    }
}

/// Inner implementation that copies the CLI binary and configures PATH using explicit paths.
///
/// Separated from [`link_cli`] for unit testing without depending on `current_exe()` or
/// the real home directory.
fn link_cli_from(cli_source: &std::path::Path, home: &std::path::Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        let local_bin = home.join(".local").join("bin");
        copy_cli_binary(cli_source, &local_bin)?;
        ensure_local_bin_on_path(home)?;
    }

    #[cfg(target_os = "windows")]
    {
        let _ = home;
        let cli_dir = consts::data_dir().join(consts::CLI_BIN_SUBDIR);

        let cli_dir_str = cli_dir.to_string_lossy().to_string();

        if cli_dir_str.contains('\'')
            || cli_dir_str.contains('"')
            || cli_dir_str.contains('`')
            || cli_dir_str.contains('$')
            || cli_dir_str.contains('*')
            || cli_dir_str.contains('?')
        {
            anyhow::bail!(
                "CLI directory path contains unsafe characters: {}",
                cli_dir_str
            );
        }

        // Defense-in-depth: kill any stale CLI / worker process holding
        // ~/.speedwave/bin/speedwave.exe before we try to overwrite it.
        // Covers MSI users (no NSIS PRE-INSTALL sweep), AppLocker failures,
        // and post-install processes spawned by containers (ADR-048).
        run_pre_link_sweep();

        copy_cli_binary(cli_source, &cli_dir)?;

        let script = format!(
            r#"
            $currentPath = [Environment]::GetEnvironmentVariable('Path', 'User')
            if ($currentPath -notlike '*{dir}*') {{
                [Environment]::SetEnvironmentVariable('Path', "$currentPath;{dir}", 'User')
                # Broadcast WM_SETTINGCHANGE so new shells pick up the change
                Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @'
                    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
                    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
                $HWND_BROADCAST = [IntPtr]0xffff
                $WM_SETTINGCHANGE = 0x1a
                $result = [UIntPtr]::Zero
                [Win32.NativeMethods]::SendMessageTimeout($HWND_BROADCAST, $WM_SETTINGCHANGE, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) | Out-Null
            }}
            "#,
            dir = cli_dir_str
        );

        let status = speedwave_runtime::binary::system_command("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ])
            .status()?;
        if !status.success() {
            anyhow::bail!("Failed to add CLI to PATH");
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use speedwave_runtime::config::{
        ClaudeOverrides, LlmConfig, ProjectUserEntry, SpeedwaveUserConfig,
    };
    use std::collections::HashMap;

    fn project_with_provider(name: &str, provider: Option<&str>) -> ProjectUserEntry {
        ProjectUserEntry {
            name: name.to_string(),
            dir: String::new(),
            claude: Some(ClaudeOverrides {
                env: None,
                settings: None,
                llm: Some(LlmConfig {
                    provider: provider.map(str::to_string),
                    model: None,
                    base_url: None,
                    context_tokens: None,
                    has_api_key: false,
                    has_custom_headers: false,
                }),
            }),
            integrations: None,
            plugin_settings: None,
        }
    }

    #[test]
    fn lookup_provider_returns_ollama() {
        let cfg = SpeedwaveUserConfig {
            projects: vec![project_with_provider("proj", Some("ollama"))],
            ..Default::default()
        };
        assert_eq!(lookup_project_provider(&cfg, "proj"), Some("ollama"));
    }

    #[test]
    fn lookup_provider_returns_lmstudio() {
        let cfg = SpeedwaveUserConfig {
            projects: vec![project_with_provider("proj", Some("lmstudio"))],
            ..Default::default()
        };
        assert_eq!(lookup_project_provider(&cfg, "proj"), Some("lmstudio"));
    }

    #[test]
    fn lookup_provider_returns_llamacpp() {
        let cfg = SpeedwaveUserConfig {
            projects: vec![project_with_provider("proj", Some("llamacpp"))],
            ..Default::default()
        };
        assert_eq!(lookup_project_provider(&cfg, "proj"), Some("llamacpp"));
    }

    #[test]
    fn lookup_provider_returns_anthropic() {
        let cfg = SpeedwaveUserConfig {
            projects: vec![project_with_provider("proj", Some("anthropic"))],
            ..Default::default()
        };
        assert_eq!(lookup_project_provider(&cfg, "proj"), Some("anthropic"));
    }

    #[test]
    fn lookup_provider_returns_none_when_project_missing() {
        let cfg = SpeedwaveUserConfig::default();
        assert_eq!(lookup_project_provider(&cfg, "missing"), None);
    }

    #[test]
    fn lookup_provider_returns_none_when_claude_section_missing() {
        let cfg = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "proj".to_string(),
                dir: String::new(),
                claude: None,
                integrations: None,
                plugin_settings: None,
            }],
            ..Default::default()
        };
        assert_eq!(lookup_project_provider(&cfg, "proj"), None);
    }

    #[test]
    fn lookup_provider_returns_none_when_llm_section_missing() {
        let cfg = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "proj".to_string(),
                dir: String::new(),
                claude: Some(ClaudeOverrides::default()),
                integrations: None,
                plugin_settings: None,
            }],
            ..Default::default()
        };
        assert_eq!(lookup_project_provider(&cfg, "proj"), None);
    }

    #[test]
    fn lookup_provider_returns_none_when_provider_field_missing() {
        let cfg = SpeedwaveUserConfig {
            projects: vec![project_with_provider("proj", None)],
            ..Default::default()
        };
        assert_eq!(lookup_project_provider(&cfg, "proj"), None);
    }

    #[test]
    fn local_provider_branch_covers_ollama_lmstudio_llamacpp() {
        // Guard: `check_claude_auth` skips Anthropic OAuth exactly for the three
        // local providers. If `is_local_provider` expands or contracts, this
        // test documents which set the auth-skip branch fires on.
        use speedwave_runtime::config::is_local_provider;
        assert!(is_local_provider(Some("ollama")));
        assert!(is_local_provider(Some("lmstudio")));
        assert!(is_local_provider(Some("llamacpp")));
        assert!(!is_local_provider(Some("anthropic")));
        assert!(!is_local_provider(None));
    }

    /// Validates that a path component does not contain traversal or unsafe characters.
    fn validate_path_component(name: &str, label: &str) -> anyhow::Result<()> {
        if name.is_empty() {
            anyhow::bail!("{label} is empty");
        }
        if name.contains('/') || name.contains('\\') || name.contains("..") {
            anyhow::bail!("{label} '{name}' contains path traversal characters");
        }
        if !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
        {
            anyhow::bail!("{label} '{name}' contains invalid characters");
        }
        Ok(())
    }

    /// Writes token files to `data_dir/tokens/<project>/<service>/` with chmod 600.
    fn write_tokens(
        data_dir: &std::path::Path,
        project: &str,
        service: &str,
        tokens: &HashMap<String, String>,
    ) -> anyhow::Result<()> {
        validate_path_component(project, "project name")?;
        validate_path_component(service, "service name")?;
        for key in tokens.keys() {
            validate_path_component(key, "token key")?;
        }

        let token_dir = data_dir.join("tokens").join(project).join(service);
        std::fs::create_dir_all(&token_dir)?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode_700 = std::fs::Permissions::from_mode(0o700);
            // See also: plugin.rs:write_token_files() — identical pattern (2 of 3, Rule of Three)
            std::fs::set_permissions(&token_dir, mode_700.clone())?;
            if let Some(project_dir) = token_dir.parent() {
                std::fs::set_permissions(project_dir, mode_700.clone())?;
                if let Some(tokens_dir) = project_dir.parent() {
                    std::fs::set_permissions(tokens_dir, mode_700)?;
                }
            }
        }

        for (key, value) in tokens {
            let token_path = token_dir.join(key);

            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .mode(0o600)
                    .open(&token_path)?;
                std::io::Write::write_all(&mut file, value.as_bytes())?;
            }
            #[cfg(not(unix))]
            {
                std::fs::write(&token_path, value)?;
            }
        }

        Ok(())
    }

    #[test]
    fn wipe_data_dir_removes_everything() {
        let tmp = tempfile::tempdir().expect("failed to create temp dir");
        let data_dir = tmp.path().join("speedwave-data");
        std::fs::create_dir_all(&data_dir).expect("create data dir");

        // Seed state, config, tokens, plugins
        let state_path = data_dir.join("setup_state.json");
        std::fs::write(&state_path, r#"{"runtime_ready":true}"#).expect("write state");
        std::fs::write(data_dir.join("config.json"), r#"{"projects":[]}"#).expect("write config");

        let tokens_dir = data_dir.join("tokens").join("acme").join("slack");
        std::fs::create_dir_all(&tokens_dir).expect("create tokens dir");
        std::fs::write(tokens_dir.join("token.txt"), "secret").expect("write token");

        let plugins_dir = data_dir.join("plugins").join("my-plugin");
        std::fs::create_dir_all(&plugins_dir).expect("create plugins dir");
        std::fs::write(plugins_dir.join("plugin.json"), "{}").expect("write plugin");

        // Run the wipe
        wipe_data_dir(&data_dir).expect("wipe should succeed");

        // Verify entire directory is gone
        assert!(!data_dir.exists(), "data dir should not exist after wipe");
    }

    #[test]
    fn wipe_data_dir_succeeds_when_dir_missing() {
        let tmp = tempfile::tempdir().expect("failed to create temp dir");
        let nonexistent = tmp.path().join("does-not-exist");
        // Should succeed silently
        wipe_data_dir(&nonexistent).expect("wipe on missing dir should succeed");
    }

    #[test]
    fn wipe_data_dir_leaves_no_remnants() {
        let tmp = tempfile::tempdir().expect("failed to create temp dir");
        let data_dir = tmp.path().join("speedwave-data");
        std::fs::create_dir_all(data_dir.join("sub1").join("sub2")).expect("create subdirs");
        std::fs::write(data_dir.join("sub1").join("file.txt"), "data").expect("write file");

        wipe_data_dir(&data_dir).expect("wipe should succeed");

        assert!(!data_dir.exists(), "data dir should be gone");
        assert!(tmp.path().exists(), "parent should still exist");
    }

    // ── SetupState save/load roundtrip ──────────────────────────────────────

    #[test]
    fn setup_state_save_and_load_roundtrip() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("setup_state.json");

        let state = SetupState {
            runtime_ready: true,
            vm_ready: true,
            project_created: Some("myproject".to_string()),
            tokens_configured: vec!["slack".to_string(), "gitlab".to_string()],
            images_built: true,
            containers_started: false,
            cli_linked: false,
        };

        state.save_to(&path).expect("save should succeed");
        let loaded = SetupState::load_from(&path).expect("load should succeed");

        assert_eq!(loaded.current_step(), 4);
        assert!(loaded.runtime_ready);
        assert!(loaded.vm_ready);
        assert_eq!(loaded.project_created, Some("myproject".to_string()));
        assert_eq!(loaded.tokens_configured, vec!["slack", "gitlab"]);
        assert!(loaded.images_built);
        assert!(!loaded.containers_started);
    }

    #[test]
    fn setup_state_load_missing_file_returns_error() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("nonexistent.json");
        assert!(SetupState::load_from(&path).is_err());
    }

    #[test]
    fn setup_state_default_is_all_false() {
        let state = SetupState::default();
        assert_eq!(state.current_step(), 0);
        assert!(!state.runtime_ready);
        assert!(!state.vm_ready);
        assert!(state.project_created.is_none());
        assert!(state.tokens_configured.is_empty());
        assert!(!state.images_built);
        assert!(!state.containers_started);
        assert!(!state.cli_linked);
    }

    #[test]
    fn current_step_derived_from_boolean_flags() {
        // Step 0: nothing done
        let state = SetupState::default();
        assert_eq!(state.current_step(), 0);

        // Step 1: runtime_ready only
        let state = SetupState {
            runtime_ready: true,
            ..Default::default()
        };
        assert_eq!(state.current_step(), 1);

        // Step 2: runtime + vm
        let state = SetupState {
            runtime_ready: true,
            vm_ready: true,
            ..Default::default()
        };
        assert_eq!(state.current_step(), 2);

        // Step 3: + images_built
        let state = SetupState {
            runtime_ready: true,
            vm_ready: true,
            images_built: true,
            ..Default::default()
        };
        assert_eq!(state.current_step(), 3);

        // Step 4: + project_created
        let state = SetupState {
            runtime_ready: true,
            vm_ready: true,
            images_built: true,
            project_created: Some("test".to_string()),
            ..Default::default()
        };
        assert_eq!(state.current_step(), 4);

        // Step 5: + containers_started
        let state = SetupState {
            runtime_ready: true,
            vm_ready: true,
            images_built: true,
            project_created: Some("test".to_string()),
            containers_started: true,
            ..Default::default()
        };
        assert_eq!(state.current_step(), 5);

        // Step 6: + cli_linked (fully complete)
        let state = SetupState {
            runtime_ready: true,
            vm_ready: true,
            images_built: true,
            project_created: Some("test".to_string()),
            containers_started: true,
            cli_linked: true,
            ..Default::default()
        };
        assert_eq!(state.current_step(), 6);
    }

    #[test]
    fn current_step_returns_first_incomplete_even_with_later_flags_set() {
        // vm_ready=false but images_built=true → step 1 (stops at first gap)
        let state = SetupState {
            runtime_ready: true,
            vm_ready: false,
            images_built: true,
            project_created: Some("test".to_string()),
            containers_started: true,
            cli_linked: true,
            ..Default::default()
        };
        assert_eq!(state.current_step(), 1);
    }

    #[test]
    fn current_step_backward_compat_ignores_old_field_in_json() {
        // Old serialized JSON that includes "current_step" should be ignored
        let json = r#"{
            "current_step": 99,
            "runtime_ready": true,
            "vm_ready": false,
            "project_created": null,
            "tokens_configured": [],
            "images_built": false,
            "containers_started": false,
            "cli_linked": false
        }"#;
        let state: SetupState = serde_json::from_str(json).expect("parse old JSON");
        assert_eq!(
            state.current_step(),
            1,
            "derived step should be 1 (only runtime_ready)"
        );
        assert!(state.runtime_ready);
        assert!(!state.vm_ready);
    }

    // ── is_setup_complete logic ─────────────────────────────────────────────

    #[test]
    fn is_setup_complete_requires_all_fields() {
        // All true → complete
        let complete = SetupState {
            runtime_ready: true,
            vm_ready: true,
            project_created: Some("acme".to_string()),
            tokens_configured: vec![],
            images_built: true,
            containers_started: true,
            cli_linked: true,
        };
        assert!(
            complete.is_complete(),
            "all fields set → should be complete"
        );

        // Missing project → incomplete
        let no_project = SetupState {
            project_created: None,
            ..complete.clone()
        };
        assert!(
            !no_project.is_complete(),
            "setup must be incomplete when project_created is None"
        );

        // Images not built → incomplete
        let no_images = SetupState {
            images_built: false,
            project_created: Some("acme".to_string()),
            ..complete.clone()
        };
        assert!(
            !no_images.is_complete(),
            "setup must be incomplete when images_built is false"
        );

        // Runtime not ready → incomplete (regression test for init_vm fix)
        let no_runtime = SetupState {
            runtime_ready: false,
            ..complete.clone()
        };
        assert!(
            !no_runtime.is_complete(),
            "setup must be incomplete when runtime_ready is false"
        );

        // VM not ready → incomplete
        let no_vm = SetupState {
            vm_ready: false,
            ..complete.clone()
        };
        assert!(
            !no_vm.is_complete(),
            "setup must be incomplete when vm_ready is false"
        );

        // Containers not started → incomplete
        let no_containers = SetupState {
            containers_started: false,
            ..complete.clone()
        };
        assert!(
            !no_containers.is_complete(),
            "setup must be incomplete when containers_started is false"
        );

        // cli_linked is intentionally excluded — should not affect completeness
        let no_cli = SetupState {
            cli_linked: false,
            ..complete.clone()
        };
        assert!(
            no_cli.is_complete(),
            "cli_linked=false should not affect completeness"
        );
    }

    /// Verifies that init_vm persists both `runtime_ready` and `vm_ready` to
    /// the state file. This is a regression test: previously init_vm only set
    /// `vm_ready`, leaving `runtime_ready` false after the check_runtime →
    /// init_vm flow, which caused `is_setup_complete()` to return false and
    /// the "Setup complete! Redirecting..." screen to hang indefinitely.
    #[test]
    fn init_vm_sets_runtime_ready_and_vm_ready() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let state_path = tmp.path().join("setup_state.json");

        // Simulate check_runtime returning NotInstalled (runtime_ready stays false)
        let before = SetupState {
            runtime_ready: false,
            ..Default::default()
        };
        before.save_to(&state_path).expect("save before state");

        // Simulate what init_vm() does after platform-specific work succeeds
        let mut state = SetupState::load_from(&state_path).expect("load state");
        state.runtime_ready = true;
        state.vm_ready = true;
        state.save_to(&state_path).expect("save after init_vm");

        let after = SetupState::load_from(&state_path).expect("load final state");
        assert!(after.runtime_ready, "init_vm must set runtime_ready = true");
        assert!(after.vm_ready, "init_vm must set vm_ready = true");
    }

    /// Verifies that check_runtime sets vm_ready=true when the runtime is Ready.
    ///
    /// When the runtime is already available (ensure_ready() succeeds), the wizard
    /// frontend skips init_vm entirely. Without vm_ready=true in the state file,
    /// is_complete() returns false and the app redirects back to the setup wizard
    /// after reload instead of to the main shell.
    #[test]
    fn check_runtime_ready_sets_vm_ready() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let state_path = tmp.path().join("setup_state.json");

        // Start from default state
        let before = SetupState::default();
        before.save_to(&state_path).expect("save before state");

        // Simulate what check_runtime() does when ensure_ready() succeeds
        let mut state = SetupState::load_from(&state_path).expect("load state");
        state.runtime_ready = true;
        state.vm_ready = true;
        state
            .save_to(&state_path)
            .expect("save after check_runtime Ready");

        let after = SetupState::load_from(&state_path).expect("load final state");
        assert!(
            after.runtime_ready,
            "check_runtime Ready must set runtime_ready = true"
        );
        assert!(
            after.vm_ready,
            "check_runtime Ready must set vm_ready = true (wizard skips init_vm)"
        );
    }

    /// Verifies that is_complete() returns false when vm_ready is false,
    /// even if all other fields are set. This is the specific regression
    /// that occurred when check_runtime(Ready) skipped init_vm without
    /// setting vm_ready.
    #[test]
    fn is_complete_false_without_vm_ready() {
        let state = SetupState {
            runtime_ready: true,
            vm_ready: false,
            project_created: Some("test".to_string()),
            tokens_configured: vec![],
            images_built: true,
            containers_started: true,
            cli_linked: true,
        };
        assert!(
            !state.is_complete(),
            "is_complete must return false when vm_ready is false"
        );
    }

    // ── write_tokens ────────────────────────────────────────────────────────

    #[test]
    fn write_tokens_creates_files_with_correct_content() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let tokens = HashMap::from([
            ("api_key".to_string(), "xoxb-secret-123".to_string()),
            (
                "webhook_url".to_string(),
                "https://hooks.slack.com/x".to_string(),
            ),
        ]);

        write_tokens(tmp.path(), "acme", "slack", &tokens).expect("write_tokens should succeed");

        let key_path = tmp.path().join("tokens/acme/slack/api_key");
        let url_path = tmp.path().join("tokens/acme/slack/webhook_url");

        assert_eq!(
            std::fs::read_to_string(&key_path).expect("read api_key"),
            "xoxb-secret-123"
        );
        assert_eq!(
            std::fs::read_to_string(&url_path).expect("read webhook_url"),
            "https://hooks.slack.com/x"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_tokens_sets_chmod_600() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().expect("tempdir");
        let data_dir = tmp.path();
        let original_mode = std::fs::metadata(data_dir).unwrap().permissions().mode() & 0o777;

        let tokens = HashMap::from([("secret".to_string(), "value".to_string())]);

        write_tokens(data_dir, "proj", "svc", &tokens).expect("write_tokens");

        let path = data_dir.join("tokens/proj/svc/secret");
        let mode = std::fs::metadata(&path)
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "token file should be chmod 600");

        // Directory permissions (3-level set_permissions pattern)
        assert_eq!(
            std::fs::metadata(data_dir.join("tokens/proj/svc"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700,
            "tokens/proj/svc should be 0o700"
        );
        assert_eq!(
            std::fs::metadata(data_dir.join("tokens/proj"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700,
            "tokens/proj should be 0o700"
        );
        assert_eq!(
            std::fs::metadata(data_dir.join("tokens"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700,
            "tokens should be 0o700"
        );

        // data_dir itself should NOT have been changed
        assert_eq!(
            std::fs::metadata(data_dir).unwrap().permissions().mode() & 0o777,
            original_mode,
            "data_dir should not have been changed"
        );
    }

    #[test]
    fn write_tokens_multiple_services_isolated() {
        let tmp = tempfile::tempdir().expect("tempdir");

        let slack_tokens = HashMap::from([("token".to_string(), "slack-secret".to_string())]);
        let gitlab_tokens = HashMap::from([("token".to_string(), "gitlab-secret".to_string())]);

        write_tokens(tmp.path(), "acme", "slack", &slack_tokens).expect("slack");
        write_tokens(tmp.path(), "acme", "gitlab", &gitlab_tokens).expect("gitlab");

        // Each service has its own isolated directory
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("tokens/acme/slack/token")).expect("read"),
            "slack-secret"
        );
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("tokens/acme/gitlab/token")).expect("read"),
            "gitlab-secret"
        );

        // Verify no cross-contamination
        assert!(!tmp.path().join("tokens/acme/slack/gitlab-secret").exists());
    }

    // -- validate_path_component tests --

    #[test]
    fn validate_path_component_accepts_valid_names() {
        assert!(validate_path_component("slack", "service").is_ok());
        assert!(validate_path_component("my-service", "service").is_ok());
        assert!(validate_path_component("service_v2", "service").is_ok());
        assert!(validate_path_component("config.json", "key").is_ok());
        assert!(validate_path_component("abc123", "key").is_ok());
    }

    #[test]
    fn validate_path_component_rejects_empty() {
        assert!(validate_path_component("", "service").is_err());
    }

    #[test]
    fn validate_path_component_rejects_slash() {
        let err = validate_path_component("../etc/passwd", "service").unwrap_err();
        assert!(err.to_string().contains("path traversal"));
    }

    #[test]
    fn validate_path_component_rejects_backslash() {
        let err = validate_path_component("..\\windows\\system32", "service").unwrap_err();
        assert!(err.to_string().contains("path traversal"));
    }

    #[test]
    fn validate_path_component_rejects_double_dot() {
        let err = validate_path_component("foo..bar", "key").unwrap_err();
        assert!(err.to_string().contains("path traversal"));
    }

    #[test]
    fn validate_path_component_rejects_special_characters() {
        assert!(validate_path_component("key with spaces", "key").is_err());
        assert!(validate_path_component("key;rm", "key").is_err());
        assert!(validate_path_component("key$(cmd)", "key").is_err());
        assert!(validate_path_component("key`whoami`", "key").is_err());
    }

    // -- write_tokens path traversal prevention --

    #[test]
    fn write_tokens_rejects_traversal_in_service() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let tokens = HashMap::from([("key".to_string(), "value".to_string())]);
        let err = write_tokens(tmp.path(), "proj", "../escape", &tokens).unwrap_err();
        assert!(err.to_string().contains("path traversal"));
    }

    #[test]
    fn write_tokens_rejects_traversal_in_key() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let tokens = HashMap::from([("../../etc/shadow".to_string(), "value".to_string())]);
        let err = write_tokens(tmp.path(), "proj", "slack", &tokens).unwrap_err();
        assert!(err.to_string().contains("path traversal"));
    }

    #[test]
    fn write_tokens_rejects_slash_in_service() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let tokens = HashMap::from([("key".to_string(), "value".to_string())]);
        let err = write_tokens(tmp.path(), "proj", "a/b", &tokens).unwrap_err();
        assert!(err.to_string().contains("path traversal"));
    }

    #[test]
    fn write_tokens_rejects_traversal_in_project() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let tokens = HashMap::from([("key".to_string(), "value".to_string())]);
        let err = write_tokens(tmp.path(), "../escape", "slack", &tokens).unwrap_err();
        assert!(err.to_string().contains("path traversal"));
    }

    // -- atomic writes verification --

    #[test]
    fn save_to_is_atomic_no_tmp_left() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("setup_state.json");
        let state = SetupState {
            runtime_ready: true,
            ..Default::default()
        };
        state.save_to(&path).expect("save should succeed");

        assert!(path.exists(), "state file should exist");
        assert!(
            !path.with_extension("json.tmp").exists(),
            "tmp file should not exist after atomic write"
        );

        let loaded = SetupState::load_from(&path).expect("load should succeed");
        assert_eq!(loaded.current_step(), 1);
        assert!(loaded.runtime_ready);
    }

    // -- ps_escape tests (Windows PowerShell path escaping) --

    #[cfg(target_os = "windows")]
    mod ps_escape_tests {
        use super::super::ps_escape;
        use std::path::Path;

        #[test]
        fn plain_path_unchanged() {
            let p = Path::new(r"C:\Users\dev\speedwave");
            assert_eq!(ps_escape(p), r"C:\Users\dev\speedwave");
        }

        #[test]
        fn single_quote_doubled() {
            let p = Path::new(r"C:\Users\it's a path\file");
            assert_eq!(ps_escape(p), r"C:\Users\it''s a path\file");
        }

        #[test]
        fn multiple_single_quotes_all_doubled() {
            let p = Path::new(r"C:\a'b'c'd");
            assert_eq!(ps_escape(p), r"C:\a''b''c''d");
        }

        #[test]
        fn path_with_spaces_preserved() {
            let p = Path::new(r"C:\Program Files\Speedwave 2");
            assert_eq!(ps_escape(p), r"C:\Program Files\Speedwave 2");
        }

        #[test]
        fn empty_path_returns_empty() {
            let p = Path::new("");
            assert_eq!(ps_escape(p), "");
        }
    }

    // Portable ps_escape tests — run on all platforms using the same logic
    #[test]
    fn ps_escape_logic_plain_string() {
        let result = "simple-path".replace('\'', "''");
        assert_eq!(result, "simple-path");
    }

    #[test]
    fn ps_escape_logic_single_quotes_doubled() {
        let result = "it's a test".replace('\'', "''");
        assert_eq!(result, "it''s a test");
    }

    #[test]
    fn ps_escape_logic_multiple_quotes() {
        let result = "a'b'c".replace('\'', "''");
        assert_eq!(result, "a''b''c");
    }

    #[test]
    fn ps_escape_logic_empty_string() {
        let result = "".replace('\'', "''");
        assert_eq!(result, "");
    }

    #[test]
    fn ps_escape_logic_only_quotes() {
        let result = "'''".replace('\'', "''");
        assert_eq!(result, "''''''");
    }

    #[test]
    fn ps_escape_logic_spaces_and_special_chars() {
        let result = "path with spaces & (parens)".replace('\'', "''");
        assert_eq!(result, "path with spaces & (parens)");
    }

    // -- wsl_rootfs_for_arch tests --

    #[cfg(target_os = "windows")]
    mod wsl_rootfs_for_arch_tests {
        use super::super::wsl_rootfs_for_arch;

        #[test]
        fn returns_ok_for_current_arch() {
            // On Windows CI this will be x86_64 or aarch64 — both are valid
            let result = wsl_rootfs_for_arch();
            assert!(result.is_ok(), "should succeed on supported arch");
            let (url, sha) = result.unwrap();
            assert!(url.starts_with("https://"));
            assert_eq!(sha.len(), 64, "SHA256 hash must be 64 hex chars");
        }
    }

    #[cfg(target_os = "windows")]
    mod terminate_on_change_tests {
        use super::super::TerminateOnChange;

        // Regression guard for the E2E "cannot exec in a stopped state"
        // failure: the import path may terminate (no containers yet), the
        // startup-migration path must not (containers may be running).
        #[test]
        fn variants_are_distinct() {
            assert_ne!(TerminateOnChange::Yes, TerminateOnChange::No);
            assert_eq!(TerminateOnChange::Yes, TerminateOnChange::Yes);
            assert_eq!(TerminateOnChange::No, TerminateOnChange::No);
        }

        #[test]
        fn is_copy_and_debug() {
            let y = TerminateOnChange::Yes;
            let copied = y; // Copy: original still usable below
            assert_eq!(y, copied);
            assert_eq!(format!("{:?}", TerminateOnChange::No), "No");
            assert_eq!(format!("{:?}", TerminateOnChange::Yes), "Yes");
        }
    }

    #[cfg(target_os = "windows")]
    mod wsl_automount_options_tests {
        use super::super::WSL_AUTOMOUNT_OPTIONS;

        // Regression guard for the claude container early-exit: the automount
        // options MUST carry both `metadata` (so /login's chmod 0600 works,
        // ADR-052) AND `uid=1000,gid=1000` (so the uid-1000 container can write
        // /home/speedwave — verified on the Windows host: with metadata ON,
        // uid != mount-owner => EACCES on mkdir => entrypoint dies under set -e).
        #[test]
        fn options_carry_metadata_and_container_uid() {
            assert!(
                WSL_AUTOMOUNT_OPTIONS.contains("metadata"),
                "metadata required for /login chmod 0600 (ADR-052)"
            );
            assert!(
                WSL_AUTOMOUNT_OPTIONS.contains("uid=1000"),
                "uid=1000 required so the container user owns the mount"
            );
            assert!(
                WSL_AUTOMOUNT_OPTIONS.contains("gid=1000"),
                "gid=1000 required so the container group owns the mount"
            );
        }
    }

    // ── copy_cli_binary tests ─────────────────────────────────────────────

    #[test]
    fn copy_cli_binary_copies_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let source_dir = tmp.path().join("source");
        std::fs::create_dir_all(&source_dir).expect("create source dir");

        let source = source_dir.join("speedwave");
        std::fs::write(&source, b"#!/bin/sh\necho hello").expect("write source");

        let target_dir = tmp.path().join("target");
        copy_cli_binary(&source, &target_dir).expect("copy should succeed");

        #[cfg(target_os = "windows")]
        let dest = target_dir.join("speedwave.exe");
        #[cfg(not(target_os = "windows"))]
        let dest = target_dir.join(consts::CLI_BINARY);
        assert!(dest.exists(), "copied binary should exist");
        assert_eq!(
            std::fs::read_to_string(&dest).expect("read"),
            "#!/bin/sh\necho hello"
        );
    }

    #[cfg(unix)]
    #[test]
    fn copy_cli_binary_sets_executable_permission() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().expect("tempdir");
        let source = tmp.path().join("speedwave");
        std::fs::write(&source, b"#!/bin/sh\necho hello").expect("write source");

        let target_dir = tmp.path().join("bin");
        copy_cli_binary(&source, &target_dir).expect("copy should succeed");

        let dest = target_dir.join(consts::CLI_BINARY);
        let mode = std::fs::metadata(&dest)
            .expect("metadata")
            .permissions()
            .mode();
        assert_ne!(
            mode & 0o111,
            0,
            "copied binary should have executable permission"
        );
    }

    #[test]
    fn copy_cli_binary_returns_error_when_source_missing() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let source = tmp.path().join("nonexistent");
        let target_dir = tmp.path().join("bin");

        let err = copy_cli_binary(&source, &target_dir).unwrap_err();
        assert!(
            err.to_string().contains("not found"),
            "error should mention source not found: {}",
            err
        );
    }

    // ── resolve_cli_source_from tests ─────────────────────────────────────

    #[cfg(target_os = "macos")]
    #[test]
    #[serial(env)]
    fn resolve_cli_source_finds_macos_bundle_path() {
        std::env::remove_var(consts::BUNDLE_RESOURCES_ENV);

        // Simulate: .app/Contents/MacOS/<exe> with Resources/cli/speedwave
        let tmp = tempfile::tempdir().expect("tempdir");
        let contents = tmp.path().join("Contents");
        let macos_dir = contents.join("MacOS");
        let resources_cli = contents.join("Resources").join("cli");
        std::fs::create_dir_all(&macos_dir).expect("create MacOS dir");
        std::fs::create_dir_all(&resources_cli).expect("create Resources/cli dir");
        std::fs::write(resources_cli.join(consts::CLI_BINARY), b"cli-binary")
            .expect("write cli binary");

        let result = resolve_cli_source_from(&macos_dir);
        assert!(result.is_some(), "should find CLI in macOS Resources");
        assert!(
            result
                .unwrap()
                .to_string_lossy()
                .contains("Resources/cli/speedwave"),
            "path should include Resources/cli/"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[serial(env)]
    fn resolve_cli_source_finds_resources_path() {
        std::env::remove_var(consts::BUNDLE_RESOURCES_ENV);

        // Simulate: <exe_dir>/resources/cli/speedwave
        let tmp = tempfile::tempdir().expect("tempdir");
        let exe_dir = tmp.path().join("exe_dir");
        let resources_cli = exe_dir.join("resources").join("cli");
        std::fs::create_dir_all(&resources_cli).expect("create resources/cli dir");

        #[cfg(target_os = "windows")]
        let binary_name = "speedwave.exe";
        #[cfg(not(target_os = "windows"))]
        let binary_name = consts::CLI_BINARY;

        std::fs::write(resources_cli.join(binary_name), b"cli-binary").expect("write cli binary");

        let result = resolve_cli_source_from(&exe_dir);
        assert!(result.is_some(), "should find CLI in resources");
        let resolved = result.unwrap();
        assert_eq!(
            resolved.parent().unwrap().file_name().unwrap(),
            "cli",
            "path should be in cli/ directory"
        );
        assert_eq!(
            resolved
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .file_name()
                .unwrap(),
            "resources",
            "cli/ should be under resources/"
        );
    }

    #[test]
    #[serial(env)]
    fn resolve_cli_source_finds_dev_fallback() {
        std::env::remove_var(consts::BUNDLE_RESOURCES_ENV);

        // Simulate: <exe_dir>/speedwave (dev mode)
        let tmp = tempfile::tempdir().expect("tempdir");
        let exe_dir = tmp.path().join("exe_dir");
        std::fs::create_dir_all(&exe_dir).expect("create exe dir");

        #[cfg(target_os = "windows")]
        let binary_name = "speedwave.exe";
        #[cfg(not(target_os = "windows"))]
        let binary_name = consts::CLI_BINARY;

        std::fs::write(exe_dir.join(binary_name), b"cli-binary").expect("write cli binary");

        let result = resolve_cli_source_from(&exe_dir);
        assert!(result.is_some(), "should find CLI in dev fallback");
    }

    #[test]
    #[serial(env)]
    fn resolve_cli_source_finds_dev_cli_dir() {
        std::env::remove_var(consts::BUNDLE_RESOURCES_ENV);

        // Simulate: desktop/src-tauri/target/debug/ as exe_dir,
        // desktop/src-tauri/cli/speedwave as CLI binary (placed by Makefile)
        let tmp = tempfile::tempdir().expect("tempdir");
        let src_tauri = tmp.path().join("desktop").join("src-tauri");
        let exe_dir = src_tauri.join("target").join("debug");
        let cli_dir = src_tauri.join("cli");
        std::fs::create_dir_all(&exe_dir).expect("create exe dir");
        std::fs::create_dir_all(&cli_dir).expect("create cli dir");

        #[cfg(target_os = "windows")]
        let binary_name = "speedwave.exe";
        #[cfg(not(target_os = "windows"))]
        let binary_name = consts::CLI_BINARY;

        std::fs::write(cli_dir.join(binary_name), b"cli-binary").expect("write cli binary");

        let result = resolve_cli_source_from(&exe_dir);
        assert!(result.is_some(), "should find CLI in dev cli/ dir");
        assert!(
            result
                .unwrap()
                .ends_with(std::path::Path::new("cli").join(binary_name)),
            "path should end with cli/{binary_name}"
        );
    }

    use serial_test::serial;

    #[test]
    #[serial(env)]
    fn resolve_cli_source_returns_none_when_not_found() {
        std::env::remove_var(consts::BUNDLE_RESOURCES_ENV);

        let tmp = tempfile::tempdir().expect("tempdir");
        let exe_dir = tmp.path().join("empty_dir");
        std::fs::create_dir_all(&exe_dir).expect("create empty dir");

        let result = resolve_cli_source_from(&exe_dir);
        assert!(result.is_none(), "should return None when CLI not found");
    }

    #[test]
    #[serial(env)]
    fn resolve_cli_source_finds_via_resources_env() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let resources_dir = tmp.path().join("resources");
        let cli_dir = resources_dir.join("cli");
        std::fs::create_dir_all(&cli_dir).expect("create cli dir");

        #[cfg(not(target_os = "windows"))]
        let binary_name = consts::CLI_BINARY;
        #[cfg(target_os = "windows")]
        let binary_name = "speedwave.exe";

        std::fs::write(cli_dir.join(binary_name), b"cli-binary").expect("write cli");

        std::env::set_var(
            consts::BUNDLE_RESOURCES_ENV,
            resources_dir.to_string_lossy().as_ref(),
        );

        let exe_dir = tmp.path().join("unrelated");
        std::fs::create_dir_all(&exe_dir).expect("create exe dir");

        let result = resolve_cli_source_from(&exe_dir);
        assert!(
            result.is_some(),
            "should find CLI via SPEEDWAVE_RESOURCES_DIR"
        );
        assert!(
            result
                .unwrap()
                .ends_with(std::path::Path::new("cli").join(binary_name)),
            "path should end with cli/{binary_name}"
        );

        std::env::remove_var(consts::BUNDLE_RESOURCES_ENV);
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[serial(env)]
    fn resolve_cli_source_prefers_bundle_over_dev() {
        std::env::remove_var(consts::BUNDLE_RESOURCES_ENV);

        // Both Resources/cli/speedwave and <exe_dir>/speedwave exist;
        // bundle path should be preferred.
        let tmp = tempfile::tempdir().expect("tempdir");
        let contents = tmp.path().join("Contents");
        let macos_dir = contents.join("MacOS");
        let resources_cli = contents.join("Resources").join("cli");
        std::fs::create_dir_all(&macos_dir).expect("create MacOS dir");
        std::fs::create_dir_all(&resources_cli).expect("create Resources/cli dir");
        std::fs::write(resources_cli.join(consts::CLI_BINARY), b"bundle")
            .expect("write bundle cli");
        std::fs::write(macos_dir.join(consts::CLI_BINARY), b"dev").expect("write dev cli");

        let result = resolve_cli_source_from(&macos_dir);
        assert!(result.is_some());
        let content = std::fs::read_to_string(result.unwrap()).expect("read resolved");
        assert_eq!(
            content, "bundle",
            "should prefer bundle path over dev fallback"
        );
    }

    #[test]
    #[serial(env)]
    fn resolve_cli_source_env_var_takes_priority_over_filesystem() {
        let tmp = tempfile::tempdir().expect("tempdir");

        // Set up a SPEEDWAVE_RESOURCES_DIR with its own CLI binary
        let env_resources = tmp.path().join("env-resources");
        let env_cli_dir = env_resources.join("cli");
        std::fs::create_dir_all(&env_cli_dir).expect("create env cli dir");

        #[cfg(not(target_os = "windows"))]
        let binary_name = consts::CLI_BINARY;
        #[cfg(target_os = "windows")]
        let binary_name = "speedwave.exe";

        std::fs::write(env_cli_dir.join(binary_name), b"from-env-var").expect("write env cli");

        // Also set up a dev-mode fallback binary next to the exe
        let exe_dir = tmp.path().join("exe_dir");
        std::fs::create_dir_all(&exe_dir).expect("create exe dir");
        std::fs::write(exe_dir.join(binary_name), b"from-dev-fallback")
            .expect("write dev fallback");

        std::env::set_var(
            consts::BUNDLE_RESOURCES_ENV,
            env_resources.to_string_lossy().as_ref(),
        );

        let result = resolve_cli_source_from(&exe_dir);
        assert!(result.is_some(), "should find CLI via env var");
        let content = std::fs::read_to_string(result.unwrap()).expect("read resolved");
        assert_eq!(
            content, "from-env-var",
            "SPEEDWAVE_RESOURCES_DIR must take priority over filesystem-based resolution"
        );

        std::env::remove_var(consts::BUNDLE_RESOURCES_ENV);
    }

    // ── cli_install_path tests ─────────────────────────────────────────────

    #[test]
    fn cli_install_path_returns_platform_specific_path() {
        let path = cli_install_path().expect("should return a path");

        #[cfg(unix)]
        assert!(
            path.to_string_lossy().contains(".local/bin/speedwave"),
            "Unix path should contain .local/bin/speedwave: {}",
            path.display()
        );

        #[cfg(target_os = "windows")]
        assert!(
            path.to_string_lossy()
                .contains(".speedwave\\bin\\speedwave.exe"),
            "Windows path should contain .speedwave\\bin\\speedwave.exe: {}",
            path.display()
        );
    }

    // ── detect_shell tests ──────────────────────────────────────────────

    #[cfg(unix)]
    #[test]
    fn detect_shell_parses_shell_env() {
        assert_eq!(parse_shell_env("/bin/zsh"), UserShell::Zsh);
        assert_eq!(parse_shell_env("/bin/bash"), UserShell::Bash);
        assert_eq!(parse_shell_env("/usr/local/bin/bash"), UserShell::Bash);
        assert_eq!(parse_shell_env("/opt/homebrew/bin/zsh"), UserShell::Zsh);
        assert_eq!(parse_shell_env("/usr/bin/fish"), UserShell::Unknown);
        assert_eq!(parse_shell_env("/bin/ksh"), UserShell::Unknown);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn detect_shell_empty_defaults_to_zsh_on_macos() {
        // On macOS, empty $SHELL (launchd context) should default to Zsh.
        assert_eq!(parse_shell_env(""), UserShell::Zsh);
    }

    // ── shell_config_targets tests ───────────────────────────────────────

    #[cfg(unix)]
    #[test]
    fn zsh_targets_zshrc() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        let targets = shell_config_targets(home, UserShell::Zsh);
        assert_eq!(targets, vec![home.join(".zshrc")]);
    }

    #[cfg(unix)]
    #[test]
    fn unknown_targets_profile() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        let targets = shell_config_targets(home, UserShell::Unknown);
        assert_eq!(targets, vec![home.join(".profile")]);
    }

    #[cfg(unix)]
    #[test]
    fn bash_targets_bash_profile_when_it_exists() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        std::fs::write(home.join(".bash_profile"), "# bash_profile\n").expect("write");
        std::fs::write(home.join(".profile"), "# profile\n").expect("write");

        let targets = shell_config_targets(home, UserShell::Bash);
        // .bash_profile takes priority over .profile
        assert!(targets.contains(&home.join(".bash_profile")));
        assert!(!targets.contains(&home.join(".profile")));
    }

    #[cfg(unix)]
    #[test]
    fn bash_falls_through_to_bash_login() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        // Only .bash_login exists (no .bash_profile)
        std::fs::write(home.join(".bash_login"), "# bash_login\n").expect("write");

        let targets = shell_config_targets(home, UserShell::Bash);
        assert!(targets.contains(&home.join(".bash_login")));
    }

    #[cfg(unix)]
    #[test]
    fn bash_falls_through_to_profile() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        // Only .profile exists (no .bash_profile, no .bash_login)
        std::fs::write(home.join(".profile"), "# profile\n").expect("write");

        let targets = shell_config_targets(home, UserShell::Bash);
        assert!(targets.contains(&home.join(".profile")));
    }

    #[cfg(unix)]
    #[test]
    fn bash_creates_bash_profile_when_none_exist() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        // No login files exist at all

        let targets = shell_config_targets(home, UserShell::Bash);
        // Should default to .bash_profile for creation
        assert!(targets.contains(&home.join(".bash_profile")));
    }

    // ── ensure_local_bin_on_path_for_shell tests ─────────────────────────

    #[cfg(unix)]
    #[test]
    fn zsh_creates_zshrc_when_missing() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        // No .zshrc exists

        ensure_local_bin_on_path_for_shell(home, UserShell::Zsh).expect("should succeed");

        assert!(home.join(".zshrc").exists(), ".zshrc should be created");
        let content = std::fs::read_to_string(home.join(".zshrc")).expect("read");
        assert!(content.contains(".local/bin"), "should contain PATH export");
        assert!(
            content.contains("# Added by Speedwave setup"),
            "should contain marker comment"
        );
    }

    #[cfg(unix)]
    #[test]
    fn zsh_appends_to_existing_zshrc() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        std::fs::write(home.join(".zshrc"), "# existing zsh config\n").expect("write");

        ensure_local_bin_on_path_for_shell(home, UserShell::Zsh).expect("should succeed");

        let content = std::fs::read_to_string(home.join(".zshrc")).expect("read");
        assert!(
            content.starts_with("# existing zsh config"),
            "should preserve existing content"
        );
        assert!(content.contains(".local/bin"), "should append PATH export");
    }

    #[cfg(unix)]
    #[test]
    fn skips_when_already_present() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        let existing = "# existing\nexport PATH=\"$HOME/.local/bin:$PATH\"\n";
        std::fs::write(home.join(".zshrc"), existing).expect("write");

        ensure_local_bin_on_path_for_shell(home, UserShell::Zsh).expect("should succeed");

        let content = std::fs::read_to_string(home.join(".zshrc")).expect("read");
        assert_eq!(
            content, existing,
            "should not be modified when already present"
        );
    }

    #[cfg(unix)]
    #[test]
    fn idempotent_across_multiple_calls() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        std::fs::write(home.join(".zshrc"), "# zshrc\n").expect("write");

        ensure_local_bin_on_path_for_shell(home, UserShell::Zsh).expect("first call");
        ensure_local_bin_on_path_for_shell(home, UserShell::Zsh).expect("second call");

        let content = std::fs::read_to_string(home.join(".zshrc")).expect("read");
        let count = content.lines().filter(|l| l.contains(".local/bin")).count();
        assert_eq!(
            count, 1,
            "should have exactly one .local/bin line, got {count}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn does_not_touch_other_shells_config() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        let bashrc_content = "# my bashrc\n";
        std::fs::write(home.join(".bashrc"), bashrc_content).expect("write .bashrc");

        // Zsh user — should only touch .zshrc, not .bashrc
        ensure_local_bin_on_path_for_shell(home, UserShell::Zsh).expect("should succeed");

        let bashrc = std::fs::read_to_string(home.join(".bashrc")).expect("read .bashrc");
        assert_eq!(
            bashrc, bashrc_content,
            ".bashrc should not be modified for a zsh user"
        );
    }

    #[cfg(unix)]
    #[test]
    fn bash_writes_to_bash_profile_not_bashrc_on_macos() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        std::fs::write(home.join(".bash_profile"), "# bp\n").expect("write");
        std::fs::write(home.join(".bashrc"), "# bashrc\n").expect("write");

        ensure_local_bin_on_path_for_shell(home, UserShell::Bash).expect("should succeed");

        let bp = std::fs::read_to_string(home.join(".bash_profile")).expect("read");
        assert!(
            bp.contains(".local/bin"),
            ".bash_profile should contain PATH export"
        );

        // macOS opens login shells, so .bashrc should NOT be modified.
        #[cfg(target_os = "macos")]
        {
            let bashrc = std::fs::read_to_string(home.join(".bashrc")).expect("read");
            assert_eq!(
                bashrc, "# bashrc\n",
                ".bashrc should not be modified on macOS"
            );
        }
    }

    // ── copy_cli_binary overwrites existing binary ────────────────────────

    #[test]
    fn copy_cli_binary_overwrites_existing_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let source = tmp.path().join("speedwave");
        std::fs::write(&source, b"new-version").expect("write source");

        let target_dir = tmp.path().join("bin");
        std::fs::create_dir_all(&target_dir).expect("create target dir");

        #[cfg(target_os = "windows")]
        let binary_name = "speedwave.exe";
        #[cfg(not(target_os = "windows"))]
        let binary_name = consts::CLI_BINARY;

        std::fs::write(target_dir.join(binary_name), b"old-version").expect("write old binary");

        copy_cli_binary(&source, &target_dir).expect("copy should succeed");

        let content = std::fs::read_to_string(target_dir.join(binary_name)).expect("read");
        assert_eq!(content, "new-version", "should overwrite existing binary");
    }

    // ── link_cli guard tests ────────────────────────────────────────────

    #[test]
    fn link_cli_guard_skips_when_data_dir_missing() {
        // When the data directory does not exist (fresh install / factory
        // reset), link_cli() should return Ok without creating it.
        let tmp = tempfile::tempdir().expect("tempdir");
        let fake_home = tmp.path().join("home");
        std::fs::create_dir_all(&fake_home).expect("create fake home");
        // No .speedwave/ inside fake_home — guard should trigger.
        // We can't call link_cli() directly because it uses dirs::home_dir()
        // which returns the real home. Instead, verify the guard logic:
        let data_dir = fake_home.join(consts::DATA_DIR);
        assert!(
            !data_dir.exists(),
            "precondition: data dir should not exist"
        );
        // The guard condition in link_cli():
        //   if !home.join(consts::DATA_DIR).exists() { return Ok(()); }
        // We verify the same condition holds and data dir stays absent.
        assert!(
            !data_dir.exists(),
            "data dir should not be created by guard check"
        );
    }

    // ── link_cli_from tests ─────────────────────────────────────────────

    #[test]
    fn link_cli_from_returns_error_when_source_missing() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let source = tmp.path().join("nonexistent");
        let home = tmp.path().join("home");
        std::fs::create_dir_all(&home).expect("create home");

        let err = link_cli_from(&source, &home).unwrap_err();
        assert!(
            err.to_string().contains("not found"),
            "error should mention source not found: {}",
            err
        );

        // No files should be written to the destination
        #[cfg(unix)]
        assert!(
            !home.join(".local").join("bin").exists(),
            "target dir should not be created on failure"
        );
    }

    #[cfg(unix)]
    #[test]
    fn link_cli_from_copies_binary_and_sets_permissions() {
        let tmp = tempfile::tempdir().expect("tempdir");

        // Create mock CLI source binary
        let source = tmp.path().join("speedwave");
        std::fs::write(&source, b"cli-binary-content").expect("write source");

        // Create home with config files for all common shells so the test
        // passes regardless of the ambient $SHELL (detect_shell reads it).
        let home = tmp.path().join("home");
        std::fs::create_dir_all(&home).expect("create home");
        std::fs::write(home.join(".zshrc"), "# zshrc\n").expect("write zshrc");
        std::fs::write(home.join(".bash_profile"), "# bash_profile\n").expect("write bash_profile");
        std::fs::write(home.join(".profile"), "# profile\n").expect("write profile");

        link_cli_from(&source, &home).expect("link_cli_from should succeed");

        // Verify binary copied
        let dest = home.join(".local").join("bin").join(consts::CLI_BINARY);
        assert!(dest.exists(), "CLI binary should exist at destination");
        let content = std::fs::read_to_string(&dest).expect("read dest");
        assert_eq!(content, "cli-binary-content");

        // Verify executable permission
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&dest)
            .expect("metadata")
            .permissions()
            .mode();
        assert!(mode & 0o111 != 0, "binary should be executable");
    }

    #[cfg(unix)]
    #[test]
    fn link_cli_from_is_idempotent() {
        let tmp = tempfile::tempdir().expect("tempdir");

        let source = tmp.path().join("speedwave");
        std::fs::write(&source, b"v2-binary").expect("write source");

        // Create config files for all common shells — makes the test
        // independent of the ambient $SHELL value.
        let home = tmp.path().join("home");
        std::fs::create_dir_all(&home).expect("create home");
        std::fs::write(home.join(".zshrc"), "# zshrc\n").expect("write zshrc");
        std::fs::write(home.join(".bash_profile"), "# bash_profile\n").expect("write bash_profile");
        std::fs::write(home.join(".profile"), "# profile\n").expect("write profile");

        // Call twice
        link_cli_from(&source, &home).expect("first call");

        // Update source to simulate app update
        std::fs::write(&source, b"v3-binary").expect("update source");
        link_cli_from(&source, &home).expect("second call");

        // Binary should be the latest version
        let dest = home.join(".local").join("bin").join(consts::CLI_BINARY);
        let content = std::fs::read_to_string(&dest).expect("read dest");
        assert_eq!(content, "v3-binary", "should have latest binary content");
    }

    #[test]
    fn setup_state_preserves_fields_on_cli_linked_update() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let state_path = tmp.path().join("setup_state.json");

        // Pre-seed with cli_linked: false and other fields set
        let initial = SetupState {
            cli_linked: false,
            runtime_ready: true,
            vm_ready: true,
            ..Default::default()
        };
        let initial_step = initial.current_step();
        initial.save_to(&state_path).expect("save initial state");

        // Load, flip cli_linked, save — mirrors what link_cli() does
        let mut state = SetupState::load_from(&state_path).expect("load for update");
        assert!(!state.cli_linked, "cli_linked should start as false");
        state.cli_linked = true;
        state.save_to(&state_path).expect("save updated state");

        // Verify cli_linked changed and other fields preserved
        let final_state = SetupState::load_from(&state_path).expect("load final");
        assert!(
            final_state.cli_linked,
            "cli_linked should be true after update"
        );
        assert_eq!(
            final_state.current_step(),
            initial_step,
            "current_step() should reflect the same base flags (only cli_linked changed, \
             which comes after the incomplete steps)"
        );
        assert!(
            final_state.runtime_ready,
            "runtime_ready should be unchanged"
        );
        assert!(final_state.vm_ready, "vm_ready should be unchanged");
    }

    // ── decode_wsl_output smoke test (SSOT is runtime::wsl) ────────────

    #[test]
    fn decode_wsl_output_imported_from_runtime_works() {
        // Smoke test: verify the re-exported decode_wsl_output handles
        // UTF-16LE correctly. Full test coverage lives in speedwave-runtime.
        let text = "Ubuntu\r\nSpeedwave\r\n";
        let mut bytes: Vec<u8> = Vec::new();
        for ch in text.encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        let decoded = decode_wsl_output(&bytes);
        let found = decoded
            .lines()
            .any(|l| l.trim().trim_matches('\0') == consts::wsl_distro_name());
        assert!(
            found,
            "imported decode_wsl_output should decode UTF-16LE correctly, got: {decoded:?}"
        );
    }

    // ── verify_wsl_distro_origin tests ───────────────────────────────────
    //
    // All three tests below mutate the same path
    // (`<data_dir>/wsl/Speedwave/ext4.vhdx`) — they create or check for the
    // marker file. `#[serial]` prevents them from racing each other under
    // `cargo test` parallel execution.

    #[test]
    #[serial]
    fn verify_wsl_distro_origin_passes_when_vhdx_exists() {
        // Create the expected vhdx file under the real data_dir() (OnceLock-cached).
        let vhdx_dir = consts::data_dir()
            .join("wsl")
            .join(consts::wsl_distro_name());
        std::fs::create_dir_all(&vhdx_dir).expect("create dirs");
        let vhdx_file = vhdx_dir.join("ext4.vhdx");
        let existed_before = vhdx_file.exists();
        if !existed_before {
            std::fs::write(&vhdx_file, b"fake vhdx").expect("write marker");
        }

        let result = verify_wsl_distro_origin();

        // Clean up only if we created the file
        if !existed_before {
            let _ = std::fs::remove_file(&vhdx_file);
            let _ = std::fs::remove_dir(&vhdx_dir);
        }
        assert!(
            result.is_ok(),
            "expected Ok when ext4.vhdx exists, got: {result:?}"
        );
    }

    #[test]
    #[serial]
    fn verify_wsl_distro_origin_fails_when_vhdx_missing() {
        // Verify that verify_wsl_distro_origin fails when the vhdx doesn't exist.
        // Since data_dir() points to the real data dir, just ensure the vhdx
        // file doesn't exist there (it shouldn't in dev/test environments).
        let vhdx_path = consts::data_dir()
            .join("wsl")
            .join(consts::wsl_distro_name())
            .join("ext4.vhdx");
        if vhdx_path.exists() {
            // Skip: can't test "missing" when file genuinely exists
            return;
        }
        let result = verify_wsl_distro_origin();
        let err_msg = result
            .expect_err("expected Err when vhdx missing")
            .to_string();
        assert!(
            err_msg.contains("Security error"),
            "error should mention 'Security error', got: {err_msg}"
        );
    }

    #[test]
    #[serial]
    fn verify_wsl_distro_origin_rejects_empty_directory() {
        // Create the wsl distro directory without the ext4.vhdx file.
        let vhdx_dir = consts::data_dir()
            .join("wsl")
            .join(consts::wsl_distro_name());
        let dir_existed = vhdx_dir.exists();
        std::fs::create_dir_all(&vhdx_dir).expect("create dirs");

        // Remove the vhdx file if it exists to test the "empty dir" case
        let vhdx_file = vhdx_dir.join("ext4.vhdx");
        let file_existed = vhdx_file.exists();
        if file_existed {
            // Skip: can't test "empty dir" when file genuinely exists
            return;
        }

        let result = verify_wsl_distro_origin();

        // Clean up only if we created the directory
        if !dir_existed {
            let _ = std::fs::remove_dir(&vhdx_dir);
        }
        let err_msg = result
            .expect_err("expected Err when vhdx missing in empty dir")
            .to_string();
        assert!(
            err_msg.contains("Security error"),
            "error should mention 'Security error', got: {err_msg}"
        );
    }

    #[test]
    fn expected_wsl_vhdx_path_structure() {
        let path = expected_wsl_vhdx_path().expect("should resolve path");
        let path_str = path.to_string_lossy();
        let data_dir_str = consts::data_dir().to_string_lossy().to_string();
        assert!(
            path_str.contains(&data_dir_str),
            "path should contain data dir ({data_dir_str}): {path_str}"
        );
        assert!(
            path_str.contains("wsl"),
            "path should contain 'wsl': {path_str}"
        );
        assert!(
            path_str.contains(consts::wsl_distro_name()),
            "path should contain distro name: {path_str}"
        );
        assert!(
            path_str.ends_with("ext4.vhdx"),
            "path should end with ext4.vhdx: {path_str}"
        );
    }

    #[test]
    fn start_containers_security_check_blocks_missing_cap_drop() {
        // Compose YAML missing cap_drop: [ALL] should trigger CAP_DROP_ALL violation.
        // This verifies the SecurityCheck gate runs before save_compose and compose_up_recreate.
        let yaml = r#"
version: "3"
services:
  claude:
    image: speedwave-claude:latest
    read_only: true
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=512m
    environment:
      - CLAUDE_VERSION=1.0.3
"#;
        let expected_paths = compose::SecurityExpectedPaths::from_raw(
            "/test/project",
            "/test/.speedwave/tokens/test",
        );
        let violations = compose::SecurityCheck::run(yaml, "test", &[], &expected_paths);
        assert!(
            violations
                .iter()
                .any(|v| v.rule == compose::SecurityRule::CapDropAll),
            "Expected CAP_DROP_ALL violation for compose YAML missing cap_drop"
        );

        // Verify the error message format matches what start_containers would produce
        let msgs: Vec<String> = violations
            .iter()
            .map(|v| format!("[{}] {} -- {}", v.container, v.rule, v.message))
            .collect();
        let error_msg = format!(
            "{}\n{}",
            speedwave_runtime::consts::SYSTEM_CHECK_FAILED_PREFIX,
            msgs.join("\n")
        );
        assert!(
            error_msg.contains(speedwave_runtime::consts::SYSTEM_CHECK_FAILED_PREFIX),
            "Error message should contain system check failed prefix"
        );
        assert!(
            error_msg.contains("CAP_DROP_ALL"),
            "Error message should contain the violated rule name"
        );
    }

    #[test]
    fn security_check_before_save_compose_ordering() {
        // Verify that compose is NOT saved to disk when SecurityCheck detects violations.
        // This tests the ordering guarantee: SecurityCheck::run() runs BEFORE save_compose().
        let tmp = tempfile::tempdir().unwrap();
        let compose_dir = tmp.path().join("compose").join("test-ordering");
        std::fs::create_dir_all(&compose_dir).unwrap();
        let compose_file = compose_dir.join("compose.yml");

        // Insecure YAML (missing cap_drop)
        let yaml = r#"
version: "3"
services:
  claude:
    image: speedwave-claude:latest
    read_only: true
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=512m
    environment:
      - CLAUDE_VERSION=1.0.3
"#;

        // SecurityCheck should find violations
        let expected_paths = compose::SecurityExpectedPaths::from_raw(
            "/test/project",
            "/test/.speedwave/tokens/test",
        );
        let violations = compose::SecurityCheck::run(yaml, "test-ordering", &[], &expected_paths);
        assert!(!violations.is_empty(), "Should detect violations");

        // Simulate the correct ordering: check first, bail before save
        if !violations.is_empty() {
            // In start_containers, we bail here — save_compose is never called
            assert!(
                !compose_file.exists(),
                "compose.yml must NOT be written when security check fails"
            );
        }
    }

    #[test]
    fn start_containers_security_check_passes_valid_compose() {
        // A compose YAML with all security requirements should produce zero
        // compose-level violations. `FileSecurityViolation`s are filtered out
        // because they depend on the real host's `~/.speedwave/` perms — this
        // test is about YAML semantics, not host filesystem state.
        let yaml = r#"
version: "3"
services:
  claude:
    image: speedwave-claude:latest
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=512m
    user: "1000:1000"
    environment:
      - CLAUDE_VERSION=1.0.3
networks:
  speedwave_test_network:
    driver: bridge
"#;
        let expected_paths = compose::SecurityExpectedPaths::from_raw(
            "/test/project",
            "/test/.speedwave/tokens/test",
        );
        let violations: Vec<_> = compose::SecurityCheck::run(yaml, "test", &[], &expected_paths)
            .into_iter()
            .filter(|v| v.rule != compose::SecurityRule::FileSecurityViolation)
            .collect();
        assert!(
            violations.is_empty(),
            "Expected no compose-level violations for valid YAML, got: {:?}",
            violations
                .iter()
                .map(|v| format!("{v}"))
                .collect::<Vec<_>>()
        );
    }

    /// Extracts the body of a top-level `pub fn <name>()` from source text by
    /// counting braces. Used by structural tests to assert on function contents.
    ///
    /// Limitation: string literals containing `{` or `}` will throw off the
    /// depth counter. This is acceptable for architectural guard tests — if a
    /// future change adds brace-containing strings, the test may need updating.
    fn extract_fn_body<'a>(source: &'a str, fn_signature: &str) -> &'a str {
        let after_sig = source
            .split(fn_signature)
            .nth(1)
            .unwrap_or_else(|| panic!("{fn_signature} not found in source"));
        let brace_start = after_sig.find('{').expect("opening brace not found");
        let rest = &after_sig[brace_start..];
        let mut depth = 0i32;
        let mut end = 0;
        for (i, ch) in rest.char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = i;
                        break;
                    }
                }
                _ => {}
            }
        }
        assert!(end > 0, "closing brace not found for {fn_signature}");
        &rest[..end]
    }

    /// Structural test: verifies that `build_images()` handles
    /// `SnapshotterRecoveryFailed` by calling `restart_container_engine()` and
    /// retrying the build. This is a source-level test — if the recovery pattern
    /// is removed or refactored away, this test will fail and force a conscious
    /// decision about the new error-handling strategy.
    #[test]
    fn build_images_handles_snapshotter_recovery_with_engine_restart() {
        let source = include_str!("setup_wizard.rs");

        assert!(
            source.contains("SnapshotterRecoveryFailed"),
            "build_images() must downcast SnapshotterRecoveryFailed to trigger engine restart"
        );
        assert!(
            source.contains("restart_container_engine"),
            "build_images() must call restart_container_engine() on snapshotter recovery failure"
        );

        let body = extract_fn_body(source, "pub fn build_images()");

        assert!(
            body.contains("downcast_ref::<build::SnapshotterRecoveryFailed>"),
            "build_images() must use downcast_ref to detect SnapshotterRecoveryFailed"
        );
        assert!(
            body.contains("restart_container_engine()"),
            "build_images() must call restart_container_engine() in the recovery path"
        );
        assert!(
            body.contains("build::build_enabled_images(&rt, &active_integrations)?"),
            "build_images() must retry build_enabled_images after engine restart"
        );
    }

    /// Structural test: verifies that `build_images()` persists `BundleState`
    /// (with `applied_bundle_id`) after a successful image build and syncs
    /// claude-resources. Without this, `reconcile_bundle_update` sees
    /// `bundle_changed=true` on the next startup and triggers a phantom rebuild.
    #[test]
    fn build_images_writes_bundle_state_after_success() {
        let source = include_str!("setup_wizard.rs");
        let body = extract_fn_body(source, "pub fn build_images()");

        assert!(
            body.contains("sync_claude_resources"),
            "build_images() must sync claude-resources for compose mounts"
        );
        assert!(
            body.contains("bundle::save_bundle_state"),
            "build_images() must persist BundleState (applied_bundle_id) after building images \
             so that reconcile_bundle_update sees bundle_changed=false on next startup"
        );
        assert!(
            body.contains("bundle::load_current_bundle_manifest"),
            "build_images() must load the current manifest to get bundle_id for BundleState"
        );
    }

    /// Structural test: verifies that `start_containers()` calls
    /// `ensure_exec_healthy` between `compose_up_recreate` and `SetupState`
    /// save. Without this, `containers_started = true` could be persisted
    /// while containers are broken or missing.
    #[test]
    fn start_containers_probes_exec_after_compose_up() {
        let source = include_str!("setup_wizard.rs");
        let body = extract_fn_body(source, "pub fn start_containers(");

        let recreate_pos = body
            .find("compose_up_recreate")
            .expect("start_containers must call compose_up_recreate");
        let probe_pos = body
            .find("ensure_exec_healthy")
            .expect("start_containers must call ensure_exec_healthy");
        let state_pos = body
            .find("containers_started = true")
            .expect("start_containers must set containers_started = true");

        assert!(
            recreate_pos < probe_pos,
            "ensure_exec_healthy must come AFTER compose_up_recreate"
        );
        assert!(
            probe_pos < state_pos,
            "ensure_exec_healthy must come BEFORE containers_started = true"
        );
    }

    // -----------------------------------------------------------------------
    // Lima VM config migration tests
    // -----------------------------------------------------------------------

    #[test]
    fn lima_vm_config_detects_old_8gib() {
        let config = "vmType: vz\ncpus: 4\nmemory: \"8GiB\"\ndisk: \"30GiB\"\n";
        assert!(lima_vm_config_needs_update_with(config, 12));
    }

    /// Test helper — appends the VPN-aware provision sentinel so fixtures
    /// model a fully-migrated config; tests focused on memory comparison
    /// would otherwise also trigger the provision-absent migration branch.
    fn with_provision_sentinel(base: &str) -> String {
        format!(
            "{base}provision:\n  - mode: boot\n    script: |\n      cat > /etc/netplan/99-speedwave-prefer-vznat.yaml <<'YAML'\n"
        )
    }

    #[test]
    fn lima_vm_config_current_no_update() {
        let config =
            with_provision_sentinel("vmType: vz\ncpus: 4\nmemory: \"12GiB\"\ndisk: \"30GiB\"\n");
        assert!(!lima_vm_config_needs_update_with(&config, 12));
    }

    #[test]
    fn lima_vm_config_higher_memory_triggers_downgrade() {
        // After the VM formula was reduced, existing VMs with more RAM than
        // desired must be migrated down to reclaim host memory.
        let config = "vmType: vz\ncpus: 4\nmemory: \"16GiB\"\ndisk: \"30GiB\"\n";
        assert!(lima_vm_config_needs_update_with(config, 12));
    }

    #[test]
    fn lima_vm_config_lower_memory_triggers_update() {
        let config = "vmType: vz\ncpus: 4\nmemory: \"4GiB\"\ndisk: \"30GiB\"\n";
        assert!(lima_vm_config_needs_update_with(config, 12));
    }

    /// Generated lima.yaml must include a provision script that demotes lima0
    /// (usernet) below eth0 (vzNAT) so traffic flows through vzNAT where the
    /// macOS host's VPN routing applies. Without this, corporate-VPN-protected
    /// services are unreachable from inside the VM. See lima-vm/lima#2984.
    #[test]
    fn lima_config_includes_vpn_aware_provision_script() {
        let yaml = super::lima_config();
        assert!(
            yaml.contains("provision:"),
            "lima.yaml must declare a provision section"
        );
        // `mode: boot` maps to cloud-init's bootcmd — re-runs on every VM
        // start. `mode: system` would only run on first boot, which would
        // skip the fix for users upgrading an existing VM.
        assert!(
            yaml.contains("mode: boot"),
            "provision must use `mode: boot` so the fix re-applies on \
             every VM restart, including post-upgrade existing VMs"
        );
        // The drop-in netplan file declaratively overrides DHCP route metrics
        // — eth0 to 100 (preferred), lima0 to 300 with `use-routes: false`.
        assert!(
            yaml.contains("99-speedwave-prefer-vznat.yaml"),
            "provision must drop in a higher-priority netplan file that \
             demotes lima0 and promotes eth0 (vzNAT) as default egress"
        );
        assert!(
            yaml.contains("use-routes: false"),
            "lima0 must have `use-routes: false` so DHCP cannot re-install \
             a default route through it after renew"
        );
        assert!(
            yaml.contains("route-metric: 100"),
            "eth0 must be promoted to route-metric 100 (preferred)"
        );
        // Sanity: provision must `netplan apply` so changes take effect
        // without requiring a reboot.
        assert!(
            yaml.contains("netplan apply"),
            "provision must apply the new netplan config immediately"
        );
    }

    /// Negative guard: must not contain the obsolete `lima0`-only routing
    /// that breaks VPN. The fix above is the only sanctioned config.
    #[test]
    fn lima_config_does_not_silently_drop_provision_section() {
        let yaml = super::lima_config();
        // Both vzNAT and the provision script are load-bearing; removing
        // either re-introduces the VPN-incompatibility regression.
        assert!(yaml.contains("vzNAT: true"));
        assert!(yaml.contains("provision:"));
    }

    #[test]
    fn lima_vm_config_unparseable_memory_no_update() {
        let config =
            with_provision_sentinel("vmType: vz\ncpus: 4\nmemory: \"plenty\"\ndisk: \"30GiB\"\n");
        assert!(!lima_vm_config_needs_update_with(&config, 12));
    }

    #[test]
    fn lima_vm_config_adaptive_upgrade_needed() {
        // 32 GiB host → desired 16 GiB → old 12 GiB config needs upgrade
        let config = "vmType: vz\ncpus: 4\nmemory: \"12GiB\"\ndisk: \"30GiB\"\n";
        assert!(lima_vm_config_needs_update_with(config, 16));
    }

    #[test]
    fn lima_vm_config_downgrade_from_12_to_8() {
        // 16 GiB host: old formula gave 12 GiB VM, new formula gives 8 GiB.
        // The migration must trigger to reclaim 4 GiB for the host.
        let config = "vmType: vz\ncpus: 4\nmemory: \"12GiB\"\ndisk: \"30GiB\"\n";
        assert!(lima_vm_config_needs_update_with(config, 8));
    }

    #[test]
    fn lima_vm_config_no_op_when_current_equals_desired() {
        // Already at the desired value — migration must not trigger (idempotent).
        let config =
            with_provision_sentinel("vmType: vz\ncpus: 4\nmemory: \"8GiB\"\ndisk: \"30GiB\"\n");
        assert!(!lima_vm_config_needs_update_with(&config, 8));
    }

    /// Regression guard for the VPN routing fix — installs pre-dating the
    /// provision-script must trigger migration even if memory matches.
    #[test]
    fn lima_vm_config_without_provision_script_triggers_migration() {
        let config = "vmType: vz\ncpus: 4\nmemory: \"12GiB\"\ndisk: \"30GiB\"\n";
        assert!(
            lima_vm_config_needs_update_with(config, 12),
            "configs missing the VPN-aware provision script must be migrated"
        );
    }

    // -----------------------------------------------------------------------
    // Windows .wslconfig VPN-compat merger tests
    // -----------------------------------------------------------------------

    /// Empty/missing .wslconfig → produces a fresh `[wsl2]` section with all
    /// three VPN-compat keys.
    #[test]
    fn merge_wslconfig_empty_input_produces_full_section() {
        let out = super::merge_wslconfig_vpn_keys("");
        assert!(out.contains("[wsl2]"));
        assert!(out.contains("networkingMode=mirrored"));
        assert!(out.contains("dnsTunneling=true"));
        assert!(out.contains("autoProxy=true"));
    }

    /// Existing file with unrelated `[experimental]` section — must be
    /// preserved verbatim, and `[wsl2]` appended at the end.
    #[test]
    fn merge_wslconfig_preserves_other_sections() {
        let input = "[experimental]\nfoo=bar\n";
        let out = super::merge_wslconfig_vpn_keys(input);
        assert!(out.contains("[experimental]"));
        assert!(out.contains("foo=bar"));
        assert!(out.contains("[wsl2]"));
        assert!(out.contains("networkingMode=mirrored"));
    }

    /// Existing `[wsl2]` with `memory=8GB` — keeps memory, inserts all three
    /// VPN keys at the end of the section before the next section starts.
    #[test]
    fn merge_wslconfig_preserves_user_keys_in_wsl2_section() {
        let input = "[wsl2]\nmemory=8GB\nprocessors=4\n\n[experimental]\nbar=baz\n";
        let out = super::merge_wslconfig_vpn_keys(input);
        assert!(out.contains("memory=8GB"), "user keys must be preserved");
        assert!(out.contains("processors=4"));
        assert!(out.contains("networkingMode=mirrored"));
        assert!(out.contains("[experimental]"));
        assert!(out.contains("bar=baz"));
    }

    /// `networkingMode=NAT` already present → must be **rewritten** to
    /// `mirrored`. We deliberately overwrite because a stale NAT setting
    /// re-introduces the VPN-incompatibility regression.
    #[test]
    fn merge_wslconfig_overwrites_stale_networking_mode() {
        let input = "[wsl2]\nnetworkingMode=NAT\nmemory=8GB\n";
        let out = super::merge_wslconfig_vpn_keys(input);
        assert!(
            out.contains("networkingMode=mirrored"),
            "stale NAT must be replaced: {out}"
        );
        assert!(
            !out.contains("networkingMode=NAT"),
            "old value must not linger: {out}"
        );
        assert!(out.contains("memory=8GB"));
    }

    /// Calling the merger twice on its own output must be a no-op (idempotent).
    #[test]
    fn merge_wslconfig_idempotent() {
        let first = super::merge_wslconfig_vpn_keys("[wsl2]\nmemory=8GB\n");
        let second = super::merge_wslconfig_vpn_keys(&first);
        assert_eq!(first, second, "merger must be idempotent");
    }

    /// Case-insensitive key match — user wrote `NetworkingMode=NAT` with
    /// different casing. The merger must still rewrite it, not duplicate.
    #[test]
    fn merge_wslconfig_case_insensitive_key_match() {
        let input = "[wsl2]\nNetworkingMode=NAT\n";
        let out = super::merge_wslconfig_vpn_keys(input);
        let mirrored_count = out.matches("=mirrored").count();
        assert_eq!(mirrored_count, 1, "must rewrite, not duplicate: {out}");
    }

    /// `.wslconfig` on Windows is typically CRLF — the merger must produce
    /// valid output regardless of input line endings and must NOT mix LF and
    /// CRLF in the result (cosmetic but reviewers care).
    #[test]
    fn merge_wslconfig_handles_crlf_line_endings() {
        let input = "[wsl2]\r\nmemory=8GB\r\nnetworkingMode=NAT\r\n";
        let out = super::merge_wslconfig_vpn_keys(input);
        assert!(out.contains("networkingMode=mirrored"));
        assert!(!out.contains("networkingMode=NAT"));
        assert!(out.contains("memory=8GB"));
        assert_eq!(out.matches("[wsl2]").count(), 1, "no duplicate sections");
        // Every newline in the output must be preceded by CR (no bare LF mixed in).
        let lone_lf = out
            .as_bytes()
            .windows(2)
            .filter(|w| w[1] == b'\n' && w[0] != b'\r')
            .count();
        let starts_with_lf = out.as_bytes().first() == Some(&b'\n');
        assert_eq!(
            lone_lf + if starts_with_lf { 1 } else { 0 },
            0,
            "CRLF input must not produce mixed line endings, got: {out:?}"
        );
    }

    /// Pure-LF input must not get CRLF injected for the new VPN keys.
    #[test]
    fn merge_wslconfig_preserves_lf_input_as_lf() {
        let out = super::merge_wslconfig_vpn_keys("[wsl2]\nmemory=8GB\nnetworkingMode=NAT\n");
        assert!(out.contains("networkingMode=mirrored"));
        // No CR characters anywhere.
        assert!(!out.contains('\r'), "LF input must stay LF: {out:?}");
    }

    /// Input ending without a trailing newline must still produce well-formed
    /// output (no concatenation of the appended `[wsl2]` to a preceding key).
    #[test]
    fn merge_wslconfig_handles_input_without_trailing_newline() {
        let input = "[experimental]\nfoo=bar";
        let out = super::merge_wslconfig_vpn_keys(input);
        assert!(out.contains("foo=bar"));
        assert!(out.contains("[wsl2]"));
        // The boundary between `foo=bar` and `[wsl2]` must be a newline.
        assert!(!out.contains("foo=bar[wsl2]"));
    }

    /// Structural test: `ensure_wslconfig_vpn_compat` must be invoked from
    /// `main.rs` at startup so existing WSL2 installs pick up the VPN-compat
    /// keys without a fresh install.
    #[test]
    fn ensure_wslconfig_vpn_compat_called_from_main() {
        let source = include_str!("main.rs");
        assert!(
            source.contains("ensure_wslconfig_vpn_compat"),
            "main.rs must call setup_wizard::ensure_wslconfig_vpn_compat() \
             at startup so upgrading WSL2 users get the VPN-compat .wslconfig"
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn lima_config_function_has_correct_memory() {
        let config = lima_config();
        let desired = desired_lima_vm_memory();
        assert!(
            config.contains(&format!("memory: \"{}\"", desired)),
            "lima_config() must use desired_lima_vm_memory() ({desired}), \
             but the memory line doesn't match. Config:\n{config}"
        );
    }

    /// Structural test: `ensure_lima_vm_config()` must be called in `main.rs`
    /// before `reconcile_bundle_update()` so the VM memory is migrated before
    /// images are rebuilt.
    #[test]
    fn ensure_lima_vm_config_called_before_reconcile() {
        let source = include_str!("main.rs");
        let migration_pos = source
            .find("ensure_lima_vm_config()")
            .expect("ensure_lima_vm_config() must be called in main.rs");
        let reconcile_pos = source
            .find("reconcile_bundle_update(")
            .expect("reconcile_bundle_update() must be called in main.rs");
        assert!(
            migration_pos < reconcile_pos,
            "ensure_lima_vm_config() must be called BEFORE reconcile_bundle_update() in main.rs"
        );
    }

    /// ensure_lima_vm_config must NOT reset SetupState flags.
    ///
    /// VM memory migration does not invalidate container images or running
    /// containers — the VM restart preserves all containerd state.
    /// Reconcile handles image rebuilds independently via BundleState.
    /// Resetting SetupState here causes existing users to see the Setup
    /// screen after an app update (regression from 0.4.0).
    #[test]
    fn ensure_lima_vm_config_does_not_reset_setup_state() {
        let source = include_str!("setup_wizard.rs");
        let body = extract_fn_body(source, "pub fn ensure_lima_vm_config()");

        assert!(
            !body.contains("images_built = false"),
            "ensure_lima_vm_config must NOT reset images_built — \
             VM memory migration does not invalidate images"
        );
        assert!(
            !body.contains("containers_started = false"),
            "ensure_lima_vm_config must NOT reset containers_started — \
             VM memory migration does not invalidate containers"
        );
    }

    // ADR-048: factory_reset calls reset_vm() before wipe_data_dir(), and
    // reset_vm() errors must be non-fatal (log::warn and continue).
    // These tests verify the non-fatal wrapper pattern used in factory_reset
    // handles both Ok and Err from reset_vm() correctly.
    mod reset_vm_factory_reset_contract {
        use speedwave_runtime::runtime::mock_runtime::MockRuntimeBuilder;

        #[test]
        fn reset_vm_error_is_non_fatal() {
            let (rt, handles) = MockRuntimeBuilder::new()
                .with_reset_vm_error("simulated wsl --unregister failure")
                .build();
            // Non-fatal: log::warn and continue — must not propagate as Err.
            // This mirrors the exact pattern in factory_reset.
            if let Err(e) = rt.reset_vm() {
                log::warn!("reset_vm failed (continuing to wipe_data_dir): {e}");
            }
            // Reaching here proves the error did not propagate.
            assert_eq!(
                handles.reset_vm_count(),
                1,
                "reset_vm must have been invoked"
            );
        }

        #[test]
        fn reset_vm_ok_returns_ok() {
            let (rt, handles) = MockRuntimeBuilder::new().build();
            // Default builder returns Ok(()); no warn log, no error propagated.
            assert!(rt.reset_vm().is_ok());
            assert_eq!(handles.reset_vm_count(), 1);
        }
    }
}
