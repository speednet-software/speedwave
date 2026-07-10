//! Host-terminal mode restore after an interactive container session: an
//! abruptly killed Claude Code cannot pop the emulator modes it enabled.

use std::io::Write;

/// Disable battery for every emulator mode Claude Code may leave enabled.
/// Each entry is a spec-defined no-op when the mode is already off.
pub const TERMINAL_SANITIZE_SEQUENCE: &str = concat!(
    "\x1b[<99u",   // kitty keyboard: pop the whole stack (over-pop clears all flags)
    "\x1b[=0u",    // kitty keyboard: hard-clear enhancement flags
    "\x1b[>4;0m",  // xterm modifyOtherKeys off
    "\x1b[?2004l", // bracketed paste off
    "\x1b[?1004l", // focus reporting off
    "\x1b[?1000l", // mouse: X11 tracking off
    "\x1b[?1002l", // mouse: button-event tracking off
    "\x1b[?1003l", // mouse: any-motion tracking off
    "\x1b[?1006l", // mouse: SGR encoding off
    "\x1b[?2026l", // synchronized output end
    "\x1b[?1l",    // application cursor keys off
    "\x1b[?25h",   // show cursor
    "\x1b[0m",     // SGR reset
);

/// Best-effort: writes the battery to stdout when it is a VT terminal.
pub fn sanitize_host_terminal() {
    if stdout_is_vt_terminal() {
        write_sanitize(&mut std::io::stdout());
    }
}

fn write_sanitize(w: &mut impl Write) {
    if w.write_all(TERMINAL_SANITIZE_SEQUENCE.as_bytes())
        .and_then(|()| w.flush())
        .is_err()
    {
        log::debug!("terminal sanitize skipped: stdout not writable");
    }
}

#[cfg(unix)]
fn stdout_is_vt_terminal() -> bool {
    use std::io::IsTerminal;
    std::io::stdout().is_terminal()
}

#[cfg(windows)]
fn stdout_is_vt_terminal() -> bool {
    use std::io::IsTerminal;
    // VT-interpreting hosts advertise themselves (Windows Terminal, VS Code,
    // MSYS); legacy conhost sets none of these and would print raw escapes.
    std::io::stdout().is_terminal()
        && (std::env::var_os("WT_SESSION").is_some()
            || std::env::var_os("TERM_PROGRAM").is_some()
            || std::env::var_os("TERM").is_some())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// Writer capturing bytes and whether `flush` was called.
    struct CaptureWriter {
        bytes: Vec<u8>,
        flushed: bool,
    }

    impl Write for CaptureWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.bytes.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.flushed = true;
            Ok(())
        }
    }

    /// Writer failing every operation.
    struct FailingWriter;

    impl Write for FailingWriter {
        fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("closed"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Err(std::io::Error::other("closed"))
        }
    }

    #[test]
    fn sequence_disables_kitty_keyboard_protocol() {
        // Pop past an empty stack resets all flags (kitty spec); `=0u` hard-clears.
        assert!(TERMINAL_SANITIZE_SEQUENCE.contains("\x1b[<99u"));
        assert!(TERMINAL_SANITIZE_SEQUENCE.contains("\x1b[=0u"));
    }

    #[test]
    fn sequence_disables_modify_other_keys() {
        assert!(TERMINAL_SANITIZE_SEQUENCE.contains("\x1b[>4;0m"));
    }

    #[test]
    fn sequence_disables_bracketed_paste_and_focus_reporting() {
        assert!(TERMINAL_SANITIZE_SEQUENCE.contains("\x1b[?2004l"));
        assert!(TERMINAL_SANITIZE_SEQUENCE.contains("\x1b[?1004l"));
    }

    #[test]
    fn sequence_disables_all_mouse_tracking_modes() {
        for mode in ["1000", "1002", "1003", "1006"] {
            assert!(
                TERMINAL_SANITIZE_SEQUENCE.contains(&format!("\x1b[?{mode}l")),
                "missing mouse mode {mode}"
            );
        }
    }

    #[test]
    fn sequence_ends_synchronized_output_and_application_cursor_keys() {
        assert!(TERMINAL_SANITIZE_SEQUENCE.contains("\x1b[?2026l"));
        assert!(TERMINAL_SANITIZE_SEQUENCE.contains("\x1b[?1l"));
    }

    #[test]
    fn sequence_shows_cursor_and_resets_sgr() {
        assert!(TERMINAL_SANITIZE_SEQUENCE.contains("\x1b[?25h"));
        assert!(TERMINAL_SANITIZE_SEQUENCE.ends_with("\x1b[0m"));
    }

    #[test]
    fn sequence_omits_destructive_resets() {
        // RIS clears the screen; 1049l/DECSTBM can jump the cursor on a healthy
        // terminal — the battery must stay invisible on a clean exit.
        assert!(!TERMINAL_SANITIZE_SEQUENCE.contains("\x1bc"));
        assert!(!TERMINAL_SANITIZE_SEQUENCE.contains("1049"));
        assert!(!TERMINAL_SANITIZE_SEQUENCE.contains("\x1b[r"));
    }

    #[test]
    fn sequence_is_wellformed_csi_only() {
        let b = TERMINAL_SANITIZE_SEQUENCE.as_bytes();
        assert!(!b.is_empty());
        let mut i = 0;
        while i < b.len() {
            assert_eq!(b[i], 0x1b, "ESC expected at byte {i}");
            assert_eq!(b[i + 1], b'[', "CSI '[' expected at byte {}", i + 1);
            i += 2;
            while i < b.len() && (0x30..=0x3f).contains(&b[i]) {
                i += 1;
            }
            while i < b.len() && (0x20..=0x2f).contains(&b[i]) {
                i += 1;
            }
            assert!(
                i < b.len() && (0x40..=0x7e).contains(&b[i]),
                "CSI final byte expected at byte {i}"
            );
            i += 1;
        }
    }

    #[test]
    fn write_sanitize_writes_full_sequence_and_flushes() {
        let mut w = CaptureWriter {
            bytes: Vec::new(),
            flushed: false,
        };
        write_sanitize(&mut w);
        assert_eq!(w.bytes, TERMINAL_SANITIZE_SEQUENCE.as_bytes());
        assert!(w.flushed, "sanitize must flush before process exit");
    }

    #[test]
    fn write_sanitize_swallows_writer_errors() {
        write_sanitize(&mut FailingWriter);
    }
}
