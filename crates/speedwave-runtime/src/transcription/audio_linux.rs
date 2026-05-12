//! Linux audio capture: shell-out to `pw-record` (PipeWire) or `parec`
//! (PulseAudio) — no fiddling with ALSA via cpal (KISS, ADR-056). We detect
//! which sound server is running, capture a monitor source (system audio) or a
//! specific node/sink-input, and emit 16 kHz mono f32 chunks.
//!
//! Both tools can output the target rate/format directly:
//!   PipeWire: `pw-record --target <node> --rate 16000 --channels 1 --format f32 -`
//!   PulseAudio: `parec --device <source> --rate 16000 --channels 1 --format float32le`
//! so the Rust side just frames the raw byte stream into `AudioChunk`s. A
//! `Mixed` (system + mic) capture runs two such processes and sums their PCM in
//! one shared `MixBuffer` via per-process reader threads (ADR-056 decision 15).

use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::audio::{
    AudioCapture, AudioChunk, AudioSource, AudioSourceInfo, AudioStream, CaptureCapabilities,
    CaptureError, ProcessSelector, CHUNK_DURATION,
};
use super::mix::{MixBuffer, MixSource};

/// Approximate chunk size in frames (~200 ms at 16 kHz) — the granularity at
/// which we hand audio to the engine.
const CHUNK_FRAMES: usize = 3200;
/// 16 kHz — the (only) output rate.
const TARGET_RATE: u32 = 16_000;

/// Which sound server we found on this host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SoundServer {
    /// PipeWire daemon present — use `pw-record` / `pw-cli`.
    PipeWire,
    /// PulseAudio (or pipewire-pulse only) — use `parec` / `pactl`.
    PulseAudio,
}

/// Linux capture backend. Detects the sound server lazily on first use.
pub struct LinuxAudioCapture {
    server: Option<SoundServer>,
}

impl LinuxAudioCapture {
    /// Constructs the backend and probes for a usable sound server. The probe
    /// is cheap (`command -v` + a `--version` call) and the result is cached.
    pub fn new() -> Self {
        Self {
            server: detect_sound_server(),
        }
    }

    /// Returns the detected server or a `NoDevice` error if none is usable.
    fn server(&self) -> Result<SoundServer, CaptureError> {
        self.server.ok_or_else(|| {
            CaptureError::NoDevice(
                "no usable sound server found (need PipeWire's pw-record or PulseAudio's parec)"
                    .to_string(),
            )
        })
    }
}

impl Default for LinuxAudioCapture {
    fn default() -> Self {
        Self::new()
    }
}

/// True if `tool` resolves on PATH (`sh -c "command -v <tool>"`).
fn tool_exists(tool: &str) -> bool {
    Command::new("sh")
        .args(["-c", &format!("command -v {tool}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// True if a PipeWire daemon is actually running (not just the CLI installed).
fn pipewire_running() -> bool {
    // `pw-cli info 0` succeeds only against a live daemon.
    Command::new("pw-cli")
        .args(["info", "0"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// True if a PulseAudio (or pipewire-pulse) server answers.
fn pulse_running() -> bool {
    Command::new("pactl")
        .arg("info")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Picks the sound server to use: PipeWire if `pw-record` + a live daemon,
/// else PulseAudio if `parec` + a live server, else `None`.
fn detect_sound_server() -> Option<SoundServer> {
    if tool_exists("pw-record") && pipewire_running() {
        return Some(SoundServer::PipeWire);
    }
    if tool_exists("parec") && pulse_running() {
        return Some(SoundServer::PulseAudio);
    }
    None
}

impl AudioCapture for LinuxAudioCapture {
    fn capabilities(&self) -> CaptureCapabilities {
        match self.server {
            None => CaptureCapabilities {
                supports_per_process: false,
                supports_system_audio: false,
                supports_microphone: false,
                note: Some(
                    "No PipeWire/PulseAudio server found — meeting transcription needs one"
                        .to_string(),
                ),
            },
            Some(SoundServer::PipeWire) => CaptureCapabilities {
                // PipeWire can target an individual stream node.
                supports_per_process: true,
                supports_system_audio: true,
                supports_microphone: true,
                note: Some("PipeWire (pw-record)".to_string()),
            },
            Some(SoundServer::PulseAudio) => CaptureCapabilities {
                // Per-app capture on classic PulseAudio means moving a
                // sink-input to a null sink — fiddly; keep it monitor-only
                // for v1 (a future iteration can wire sink-input routing).
                supports_per_process: false,
                supports_system_audio: true,
                supports_microphone: true,
                note: Some(
                    "PulseAudio (parec) — per-app capture not available; system audio only"
                        .to_string(),
                ),
            },
        }
    }

    fn enumerate_sources(&self) -> Result<Vec<AudioSourceInfo>, CaptureError> {
        let server = self.server()?;
        let mut sources = vec![
            // "Whole meeting" (system monitor + default mic) first — the product
            // default for meeting transcription; works on both servers.
            AudioSourceInfo {
                source: AudioSource::Mixed {
                    system: Box::new(AudioSource::SystemWide),
                    mic: None,
                },
                label: "Whole meeting (system audio + your microphone)".to_string(),
                app_id: None,
            },
            AudioSourceInfo {
                source: AudioSource::SystemWide,
                label: "System (everything)".to_string(),
                app_id: None,
            },
        ];
        match server {
            SoundServer::PipeWire => enumerate_pipewire(&mut sources)?,
            SoundServer::PulseAudio => enumerate_pulse(&mut sources)?,
        }
        Ok(sources)
    }

    fn start(&self, source: AudioSource) -> Result<Box<dyn AudioStream>, CaptureError> {
        let server = self.server()?;
        // Mixed = two children (system monitor + mic) summed into one MixBuffer.
        if let AudioSource::Mixed { system, mic } = &source {
            let (sys_child, mic_child) = match server {
                SoundServer::PipeWire => spawn_mixed_pw_record(system, mic)?,
                SoundServer::PulseAudio => spawn_mixed_parec(system, mic)?,
            };
            return Ok(Box::new(MixedRawPcmStream::new(sys_child, mic_child)?));
        }
        let mut child = match server {
            SoundServer::PipeWire => spawn_pw_record(&source)?,
            SoundServer::PulseAudio => spawn_parec(&source)?,
        };
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| CaptureError::Failed("capture tool stdout not piped".to_string()))?;
        drain_stderr(&mut child);
        Ok(Box::new(RawPcmStream {
            child,
            stdout,
            done: false,
        }))
    }
}

/// Spawns a background thread that drains a child's stderr into the log so the
/// child can't deadlock on a full pipe.
fn drain_stderr(child: &mut Child) {
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                log::debug!(target: "transcription::capture", "linux-capture: {line}");
            }
        });
    }
}

/// `AudioStream` over a child tool's raw f32-LE mono PCM on stdout. Dropping it
/// kills the tool.
struct RawPcmStream {
    child: Child,
    stdout: std::process::ChildStdout,
    done: bool,
}

impl AudioStream for RawPcmStream {
    fn next_chunk(&mut self) -> Result<Option<AudioChunk>, CaptureError> {
        if self.done {
            return Ok(None);
        }
        // Read up to CHUNK_FRAMES f32 samples (4 bytes each). A short read at
        // EOF is fine — we emit whatever we got, then stop on the next call.
        let want = CHUNK_FRAMES * 4;
        let mut buf = vec![0u8; want];
        let mut filled = 0;
        while filled < want {
            let n = self
                .stdout
                .read(&mut buf[filled..])
                .map_err(|e| CaptureError::Failed(format!("read capture PCM: {e}")))?;
            if n == 0 {
                break; // EOF
            }
            filled += n;
        }
        if filled == 0 {
            self.done = true;
            let _ = self.child.wait();
            return Ok(None);
        }
        // Ignore a trailing partial sample (shouldn't happen, but be safe).
        let usable = filled - (filled % 4);
        let mut samples = Vec::with_capacity(usable / 4);
        for f in buf[..usable].chunks_exact(4) {
            samples.push(f32::from_le_bytes([f[0], f[1], f[2], f[3]]));
        }
        // We don't get precise per-chunk offsets from the tools; the driver
        // tracks elapsed time itself. Report a zero offset (the engine treats
        // chunks as contiguous when offsets are unavailable).
        Ok(Some(AudioChunk {
            samples,
            offset: Duration::ZERO,
        }))
    }
}

impl Drop for RawPcmStream {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// `AudioStream` for a mixed Linux capture: two child tools (system monitor +
/// mic, both already 16 kHz mono f32-LE) drained by background threads into one
/// shared `MixBuffer` that sums them. Dropping it kills both children, which
/// makes the reader threads see EOF and exit.
struct MixedRawPcmStream {
    /// System-side capture child (e.g. `pw-record --target @DEFAULT_MONITOR@`).
    sys_child: Child,
    /// Mic-side capture child.
    mic_child: Child,
    /// Buffer both reader threads push into; `next_chunk` pops from it.
    buf: Arc<Mutex<MixBuffer>>,
    /// Reader-thread handles — joined on drop after the children are killed.
    readers: Vec<std::thread::JoinHandle<()>>,
}

impl MixedRawPcmStream {
    /// Wires up both children: takes their stdouts, drains their stderrs, and
    /// spawns one reader thread per side that feeds the shared `MixBuffer`.
    fn new(mut sys_child: Child, mut mic_child: Child) -> Result<Self, CaptureError> {
        let sys_out = sys_child
            .stdout
            .take()
            .ok_or_else(|| CaptureError::Failed("system capture stdout not piped".to_string()))?;
        let mic_out = mic_child
            .stdout
            .take()
            .ok_or_else(|| CaptureError::Failed("mic capture stdout not piped".to_string()))?;
        drain_stderr(&mut sys_child);
        drain_stderr(&mut mic_child);
        let buf = Arc::new(Mutex::new(MixBuffer::new(true)));
        let readers = vec![
            spawn_pcm_reader(sys_out, Arc::clone(&buf), MixSource::System),
            spawn_pcm_reader(mic_out, Arc::clone(&buf), MixSource::Mic),
        ];
        Ok(Self {
            sys_child,
            mic_child,
            buf,
            readers,
        })
    }
}

/// Reads raw f32-LE mono PCM from `stdout` and pushes ~`CHUNK_FRAMES`-sample
/// runs into the shared `MixBuffer`, tagged with `source`, tracking a running
/// offset (the tools give us no timestamps). Exits on EOF.
fn spawn_pcm_reader(
    mut stdout: std::process::ChildStdout,
    buf: Arc<Mutex<MixBuffer>>,
    source: MixSource,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut byte_pos: u64 = 0; // bytes read from this stream so far
        let want = CHUNK_FRAMES * 4;
        loop {
            let mut chunk = vec![0u8; want];
            let mut filled = 0;
            while filled < want {
                match stdout.read(&mut chunk[filled..]) {
                    Ok(0) => break,
                    Ok(n) => filled += n,
                    Err(_) => break,
                }
            }
            if filled == 0 {
                // EOF — mark the buffer finished from this side and exit. (If
                // the *other* side is still going, MixBuffer keeps padding this
                // side with silence; finish() makes it drain on the last pop.)
                if let Ok(mut b) = buf.lock() {
                    b.finish();
                }
                return;
            }
            let usable = filled - (filled % 4);
            let mut samples = Vec::with_capacity(usable / 4);
            for f in chunk[..usable].chunks_exact(4) {
                samples.push(f32::from_le_bytes([f[0], f[1], f[2], f[3]]));
            }
            let offset_ns = byte_pos / 4 * 1_000_000_000 / TARGET_RATE as u64;
            if let Ok(mut b) = buf.lock() {
                b.push(source, offset_ns, &samples);
            }
            byte_pos += usable as u64;
        }
    })
}

impl AudioStream for MixedRawPcmStream {
    fn next_chunk(&mut self) -> Result<Option<AudioChunk>, CaptureError> {
        let want = ((TARGET_RATE as u128 * CHUNK_DURATION.as_millis() / 1000) as usize).max(1);
        // Poll the mix buffer; ~200 ms chunk cadence, 20 ms poll. A ~2 s stall
        // (both children stopped without an EOF, e.g. a device vanished) →
        // Ok(None) so the driver finalizes rather than spins forever.
        const STALL_GIVE_UP: Duration = Duration::from_secs(2);
        let mut waited = Duration::ZERO;
        loop {
            {
                let mut b = self
                    .buf
                    .lock()
                    .map_err(|_| CaptureError::Failed("mix buffer poisoned".to_string()))?;
                let start_ns = b.offset_ns();
                let chunk = b
                    .pop(want, want)
                    .or_else(|| (waited >= STALL_GIVE_UP).then(|| b.pop(1, want)).flatten());
                if let Some(samples) = chunk {
                    return Ok(Some(AudioChunk {
                        samples,
                        offset: Duration::from_nanos(start_ns),
                    }));
                }
            }
            if waited >= STALL_GIVE_UP {
                return Ok(None);
            }
            std::thread::sleep(Duration::from_millis(20));
            waited += Duration::from_millis(20);
        }
    }
}

impl Drop for MixedRawPcmStream {
    fn drop(&mut self) {
        // Kill both children; the reader threads then see EOF and exit, which
        // we join to avoid leaking threads.
        for child in [&mut self.sys_child, &mut self.mic_child] {
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        for h in self.readers.drain(..) {
            let _ = h.join();
        }
    }
}

// --- PipeWire ---------------------------------------------------------------

/// Spawns `pw-record` for the requested source.
fn spawn_pw_record(source: &AudioSource) -> Result<Child, CaptureError> {
    let mut cmd = Command::new("pw-record");
    cmd.args(["--rate", "16000", "--channels", "1", "--format", "f32"]);
    match source {
        AudioSource::SystemWide => {
            // No --target: pw-record defaults to the default sink's monitor
            // when given `-`? Not reliably — be explicit by asking for the
            // default sink's monitor. PipeWire exposes this as the
            // "@DEFAULT_MONITOR@" target alias.
            cmd.args(["--target", "@DEFAULT_MONITOR@"]);
        }
        AudioSource::Process { selector } => {
            let id = node_id_of(selector)?;
            cmd.args(["--target", &id]);
        }
        AudioSource::Microphone { device } => {
            let target = device
                .clone()
                .unwrap_or_else(|| "@DEFAULT_SOURCE@".to_string());
            cmd.args(["--target", &target]);
        }
        AudioSource::Mixed { .. } => {
            // Mixed is handled by spawn_mixed_pw_record (two processes).
            return Err(CaptureError::Failed(
                "mixed capture must go through spawn_mixed_pw_record".to_string(),
            ));
        }
    }
    cmd.arg("-");
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| CaptureError::Failed(format!("spawn pw-record: {e}")))
}

/// Spawns two `pw-record` processes for a `Mixed` source: the system side
/// (recursing on `system`, which must be `SystemWide` or a PipeWire `Process`
/// node — not a nested `Mixed`/`Microphone`) and the mic side (`mic` device, or
/// `@DEFAULT_SOURCE@`). Returns `(system_child, mic_child)`.
fn spawn_mixed_pw_record(
    system: &AudioSource,
    mic: &Option<String>,
) -> Result<(Child, Child), CaptureError> {
    let sys_child = match system {
        AudioSource::SystemWide | AudioSource::Process { .. } => spawn_pw_record(system)?,
        other => {
            return Err(CaptureError::Unsupported(format!(
                "mixed capture's system source must be System or a PipeWire node, got {other:?}"
            )))
        }
    };
    let mic_target = mic
        .clone()
        .unwrap_or_else(|| "@DEFAULT_SOURCE@".to_string());
    let mic_child = pw_record_target(&mic_target)?;
    Ok((sys_child, mic_child))
}

/// Spawns a `pw-record` capturing exactly `target` at 16 kHz mono f32 to stdout.
fn pw_record_target(target: &str) -> Result<Child, CaptureError> {
    Command::new("pw-record")
        .args([
            "--rate",
            "16000",
            "--channels",
            "1",
            "--format",
            "f32",
            "--target",
            target,
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| CaptureError::Failed(format!("spawn pw-record: {e}")))
}

/// Parses `pw-cli list-objects Node` for audio sink-monitor + source + stream
/// nodes and appends them as sources. Best-effort: a parse miss just yields a
/// shorter list, never an error (we already have `SystemWide`).
fn enumerate_pipewire(out: &mut Vec<AudioSourceInfo>) -> Result<(), CaptureError> {
    let output = Command::new("pw-cli")
        .args(["list-objects", "Node"])
        .output()
        .map_err(|e| CaptureError::Failed(format!("spawn pw-cli: {e}")))?;
    if !output.status.success() {
        // The server might have gone away between detect and now.
        return Ok(());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for node in parse_pw_nodes(&text) {
        out.push(AudioSourceInfo {
            source: AudioSource::Process {
                selector: ProcessSelector::NodeId {
                    id: node.id.clone(),
                },
            },
            label: node.label,
            app_id: None,
        });
    }
    Ok(())
}

/// A parsed PipeWire stream node worth offering to the user.
#[derive(Debug, PartialEq, Eq)]
struct PwNode {
    id: String,
    label: String,
}

/// Extracts `id` + a human label from `pw-cli list-objects Node` output. The
/// format is `id <N>, type PipeWire:Interface:Node/...` followed by indented
/// `property: value` lines until the next `id` block.
fn parse_pw_nodes(text: &str) -> Vec<PwNode> {
    let mut nodes = Vec::new();
    let mut current_id: Option<String> = None;
    let mut media_class: Option<String> = None;
    let mut name: Option<String> = None;
    let mut app_name: Option<String> = None;

    let flush = |nodes: &mut Vec<PwNode>,
                 id: &Option<String>,
                 class: &Option<String>,
                 name: &Option<String>,
                 app: &Option<String>| {
        let (Some(id), Some(class)) = (id, class) else {
            return;
        };
        // We only care about stream outputs/inputs that an app produces —
        // those are the "per-app" capturable nodes. Monitor of a sink is
        // covered by SystemWide already.
        if class == "Stream/Output/Audio" || class == "Stream/Input/Audio" {
            let label = app
                .clone()
                .or_else(|| name.clone())
                .unwrap_or_else(|| format!("node {id}"));
            nodes.push(PwNode {
                id: id.clone(),
                label,
            });
        }
    };

    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("id ") {
            // New block — flush the previous one.
            flush(&mut nodes, &current_id, &media_class, &name, &app_name);
            current_id = rest
                .split(|c: char| c == ',' || c.is_whitespace())
                .next()
                .map(|s| s.to_string());
            media_class = None;
            name = None;
            app_name = None;
            continue;
        }
        if let Some((key, value)) = trimmed.split_once('=') {
            let key = key.trim().trim_matches('*').trim();
            let value = value.trim().trim_matches('"');
            match key {
                "media.class" => media_class = Some(value.to_string()),
                "node.name" => name = Some(value.to_string()),
                "application.name" => app_name = Some(value.to_string()),
                _ => {}
            }
        }
    }
    // Flush the final block.
    flush(&mut nodes, &current_id, &media_class, &name, &app_name);
    nodes
}

// --- PulseAudio -------------------------------------------------------------

/// Spawns `parec` for the requested source. PulseAudio per-app capture isn't
/// offered (capabilities reflects that), so `Process` is rejected here.
fn spawn_parec(source: &AudioSource) -> Result<Child, CaptureError> {
    let mut cmd = Command::new("parec");
    cmd.args([
        "--rate",
        "16000",
        "--channels",
        "1",
        "--format",
        "float32le",
    ]);
    match source {
        AudioSource::SystemWide => {
            // Default sink's monitor source. `@DEFAULT_MONITOR@` is a Pulse
            // alias for "monitor of the default sink".
            cmd.args(["--device", "@DEFAULT_MONITOR@"]);
        }
        AudioSource::Microphone { device } => {
            let dev = device
                .clone()
                .unwrap_or_else(|| "@DEFAULT_SOURCE@".to_string());
            cmd.args(["--device", &dev]);
        }
        AudioSource::Process { .. } => {
            return Err(CaptureError::Unsupported(
                "per-app capture is not available on PulseAudio — use System audio".to_string(),
            ));
        }
        AudioSource::Mixed { .. } => {
            // Mixed is handled by spawn_mixed_parec (two processes).
            return Err(CaptureError::Failed(
                "mixed capture must go through spawn_mixed_parec".to_string(),
            ));
        }
    }
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| CaptureError::Failed(format!("spawn parec: {e}")))
}

/// Spawns two `parec` processes for a `Mixed` source: the default sink's monitor
/// (the system side; the inner `system` must be `SystemWide` — PulseAudio has no
/// per-app capture in v1) and the mic source (`mic` device or `@DEFAULT_SOURCE@`).
fn spawn_mixed_parec(
    system: &AudioSource,
    mic: &Option<String>,
) -> Result<(Child, Child), CaptureError> {
    match system {
        AudioSource::SystemWide => {}
        AudioSource::Process { .. } => {
            return Err(CaptureError::Unsupported(
                "per-app capture is not available on PulseAudio — use System audio".to_string(),
            ))
        }
        other => {
            return Err(CaptureError::Unsupported(format!(
                "mixed capture's system source must be System on PulseAudio, got {other:?}"
            )))
        }
    }
    let sys_child = parec_device("@DEFAULT_MONITOR@")?;
    let mic_device = mic
        .clone()
        .unwrap_or_else(|| "@DEFAULT_SOURCE@".to_string());
    let mic_child = parec_device(&mic_device)?;
    Ok((sys_child, mic_child))
}

/// Spawns a `parec` capturing exactly `device` at 16 kHz mono float32le to stdout.
fn parec_device(device: &str) -> Result<Child, CaptureError> {
    Command::new("parec")
        .args([
            "--rate",
            "16000",
            "--channels",
            "1",
            "--format",
            "float32le",
            "--device",
            device,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| CaptureError::Failed(format!("spawn parec: {e}")))
}

/// Parses `pactl list short sources` for `.monitor` and input sources, and
/// `pactl list short sink-inputs` for running app streams. Best-effort.
fn enumerate_pulse(out: &mut Vec<AudioSourceInfo>) -> Result<(), CaptureError> {
    if let Ok(output) = Command::new("pactl")
        .args(["list", "short", "sources"])
        .output()
    {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            for src in parse_pactl_sources(&text) {
                out.push(AudioSourceInfo {
                    source: AudioSource::Microphone {
                        device: Some(src.name.clone()),
                    },
                    label: src.label,
                    app_id: None,
                });
            }
        }
    }
    Ok(())
}

/// A parsed PulseAudio source row.
#[derive(Debug, PartialEq, Eq)]
struct PulseSource {
    name: String,
    label: String,
}

/// Parses `pactl list short sources` — tab-separated: `index<TAB>name<TAB>driver<TAB>spec<TAB>state`.
/// We surface non-monitor input sources as mic options and keep monitors out
/// (SystemWide covers the default monitor; named monitors are rare).
fn parse_pactl_sources(text: &str) -> Vec<PulseSource> {
    let mut sources = Vec::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 2 {
            continue;
        }
        let name = cols[1].trim();
        if name.is_empty() || name.ends_with(".monitor") {
            continue;
        }
        // Friendly-ish label from the source name's last dotted segment.
        let label = name.rsplit('.').next().unwrap_or(name).to_string();
        sources.push(PulseSource {
            name: name.to_string(),
            label,
        });
    }
    sources
}

// --- shared helpers ---------------------------------------------------------

/// Extracts a PipeWire node id from a `ProcessSelector`, rejecting raw PIDs
/// (Linux capture targets nodes, not OS processes).
fn node_id_of(selector: &ProcessSelector) -> Result<String, CaptureError> {
    match selector {
        ProcessSelector::NodeId { id } => Ok(id.clone()),
        ProcessSelector::Pid { pid } => Err(CaptureError::Unsupported(format!(
            "Linux capture needs a PipeWire node id, got PID {pid}"
        ))),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn no_server_yields_unusable_capabilities() {
        let cap = LinuxAudioCapture { server: None };
        let c = cap.capabilities();
        assert!(!c.supports_system_audio);
        assert!(!c.supports_per_process);
        assert!(!c.supports_microphone);
        assert!(c.note.unwrap().contains("PipeWire"));
    }

    #[test]
    fn pipewire_advertises_per_process() {
        let cap = LinuxAudioCapture {
            server: Some(SoundServer::PipeWire),
        };
        let c = cap.capabilities();
        assert!(c.supports_system_audio);
        assert!(c.supports_per_process);
        assert_eq!(c.note.as_deref(), Some("PipeWire (pw-record)"));
    }

    #[test]
    fn pulseaudio_is_monitor_only() {
        let cap = LinuxAudioCapture {
            server: Some(SoundServer::PulseAudio),
        };
        let c = cap.capabilities();
        assert!(c.supports_system_audio);
        assert!(!c.supports_per_process, "no per-app on classic Pulse in v1");
        assert!(c.supports_microphone);
    }

    #[test]
    fn enumerate_without_server_errors() {
        let cap = LinuxAudioCapture { server: None };
        let err = cap.enumerate_sources().unwrap_err();
        assert!(matches!(err, CaptureError::NoDevice(_)));
    }

    #[test]
    fn parec_rejects_per_app_source() {
        let src = AudioSource::Process {
            selector: ProcessSelector::NodeId {
                id: "42".to_string(),
            },
        };
        let err = spawn_parec(&src).unwrap_err();
        assert!(matches!(err, CaptureError::Unsupported(_)));
    }

    #[test]
    fn mixed_pw_record_rejects_a_nonsensical_system_source() {
        // A microphone or a nested Mixed can't be the "system" side of a mix.
        let err =
            spawn_mixed_pw_record(&AudioSource::Microphone { device: None }, &None).unwrap_err();
        assert!(matches!(err, CaptureError::Unsupported(_)));
        let nested = AudioSource::Mixed {
            system: Box::new(AudioSource::SystemWide),
            mic: None,
        };
        assert!(matches!(
            spawn_mixed_pw_record(&nested, &None).unwrap_err(),
            CaptureError::Unsupported(_)
        ));
        // A PipeWire Process node carrying a raw PID (not a node id) → rejected
        // by node_id_of inside spawn_pw_record, before any process is spawned.
        let bad_pid = AudioSource::Process {
            selector: ProcessSelector::Pid { pid: 9 },
        };
        assert!(matches!(
            spawn_mixed_pw_record(&bad_pid, &None).unwrap_err(),
            CaptureError::Unsupported(_)
        ));
    }

    #[test]
    fn mixed_parec_rejects_per_app_and_other_system_sources() {
        // PulseAudio has no per-app capture — a Process system source is out.
        let proc = AudioSource::Process {
            selector: ProcessSelector::NodeId {
                id: "1".to_string(),
            },
        };
        assert!(matches!(
            spawn_mixed_parec(&proc, &None).unwrap_err(),
            CaptureError::Unsupported(_)
        ));
        // And so is anything that isn't SystemWide (e.g. a Microphone-as-system).
        assert!(matches!(
            spawn_mixed_parec(&AudioSource::Microphone { device: None }, &None).unwrap_err(),
            CaptureError::Unsupported(_)
        ));
    }

    #[test]
    fn spawn_pw_record_routes_mixed_through_the_dedicated_path() {
        // Calling spawn_pw_record directly with a Mixed source is a programmer
        // error — it must go through spawn_mixed_pw_record. (Same for parec.)
        let m = AudioSource::Mixed {
            system: Box::new(AudioSource::SystemWide),
            mic: None,
        };
        assert!(matches!(
            spawn_pw_record(&m).unwrap_err(),
            CaptureError::Failed(_)
        ));
        assert!(matches!(
            spawn_parec(&m).unwrap_err(),
            CaptureError::Failed(_)
        ));
    }

    #[test]
    fn node_id_helper_rejects_pid() {
        let err = node_id_of(&ProcessSelector::Pid { pid: 1234 }).unwrap_err();
        assert!(matches!(err, CaptureError::Unsupported(_)));
        let ok = node_id_of(&ProcessSelector::NodeId {
            id: "77".to_string(),
        })
        .unwrap();
        assert_eq!(ok, "77");
    }

    #[test]
    fn parse_pw_nodes_picks_stream_nodes() {
        // Realistic-ish `pw-cli list-objects Node` excerpt.
        let text = r#"
	id 33, type PipeWire:Interface:Node/3
 		object.serial = "33"
 		node.name = "alsa_output.pci-0000_00_1f.3.analog-stereo"
 		media.class = "Audio/Sink"
	id 51, type PipeWire:Interface:Node/3
 		object.serial = "51"
 		application.name = "Firefox"
 		node.name = "Firefox"
 		media.class = "Stream/Output/Audio"
	id 52, type PipeWire:Interface:Node/3
 		object.serial = "52"
 		node.name = "speech-dispatcher"
 		media.class = "Stream/Input/Audio"
"#;
        let nodes = parse_pw_nodes(text);
        // Only the two Stream/* nodes; the Audio/Sink is excluded.
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].id, "51");
        assert_eq!(nodes[0].label, "Firefox"); // application.name wins
        assert_eq!(nodes[1].id, "52");
        assert_eq!(nodes[1].label, "speech-dispatcher"); // falls back to node.name
    }

    #[test]
    fn parse_pw_nodes_empty_input_is_empty() {
        assert!(parse_pw_nodes("").is_empty());
        assert!(parse_pw_nodes("no id blocks here\njust noise").is_empty());
    }

    #[test]
    fn parse_pactl_sources_skips_monitors_and_blanks() {
        let text = "0\talsa_output.pci-0000_00_1f.3.analog-stereo.monitor\tmodule\ts16le 2ch 48000Hz\tIDLE\n\
                    1\talsa_input.pci-0000_00_1f.3.analog-stereo\tmodule\ts16le 2ch 48000Hz\tRUNNING\n";
        let sources = parse_pactl_sources(text);
        assert_eq!(sources.len(), 1, "the .monitor row is skipped");
        assert_eq!(sources[0].name, "alsa_input.pci-0000_00_1f.3.analog-stereo");
        assert_eq!(sources[0].label, "analog-stereo");
    }

    #[test]
    fn parse_pactl_sources_handles_malformed_rows() {
        // Rows without a name column are skipped, not panicked on.
        let text = "garbage\n\t\nonly-one-col\n";
        assert!(parse_pactl_sources(text).is_empty());
    }
}
