use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

use log::{Log, Metadata, Record};

const CLI_LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;

type Sink = Box<dyn Write + Send>;

static LOGGER: OnceLock<CliLogger> = OnceLock::new();

struct CliLogger {
    filter: env_logger::Logger,
    sinks: Mutex<Sinks>,
    terminal_handed_over: AtomicBool,
}

struct Sinks {
    terminal: Sink,
    file: Option<Sink>,
}

pub(crate) struct TerminalHandover<'a> {
    logger: &'a CliLogger,
}

pub(crate) fn init() {
    let logger = global();
    if log::set_logger(logger).is_ok() {
        log::set_max_level(logger.filter.filter());
    }
}

pub(crate) fn attach_file(path: &Path) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    speedwave_runtime::log_file::truncate_if_oversized(path, CLI_LOG_MAX_BYTES);
    if let Some(file) = speedwave_runtime::log_file::open_log_file(path) {
        global().set_file(Box::new(file));
    }
}

pub(crate) fn hand_over_terminal() -> TerminalHandover<'static> {
    global().hand_over_terminal()
}

#[cfg(not(debug_assertions))]
pub(crate) fn terminal_handed_over() -> bool {
    global().terminal_handed_over.load(Ordering::SeqCst)
}

fn global() -> &'static CliLogger {
    LOGGER.get_or_init(|| {
        let filter = filter_from(env_logger::Env::default().default_filter_or("info"));
        CliLogger::new(filter, Box::new(std::io::stderr()))
    })
}

fn filter_from(env: env_logger::Env<'_>) -> env_logger::Logger {
    env_logger::Builder::from_env(env).build()
}

impl CliLogger {
    fn new(filter: env_logger::Logger, terminal: Sink) -> Self {
        Self {
            filter,
            sinks: Mutex::new(Sinks {
                terminal,
                file: None,
            }),
            terminal_handed_over: AtomicBool::new(false),
        }
    }

    fn set_file(&self, file: Sink) {
        lock(&self.sinks).file = Some(file);
    }

    fn hand_over_terminal(&self) -> TerminalHandover<'_> {
        let _sinks = lock(&self.sinks);
        self.terminal_handed_over.store(true, Ordering::SeqCst);
        TerminalHandover { logger: self }
    }

    fn take_terminal_back(&self) {
        let _sinks = lock(&self.sinks);
        self.terminal_handed_over.store(false, Ordering::SeqCst);
    }
}

impl Drop for TerminalHandover<'_> {
    fn drop(&mut self) {
        self.logger.take_terminal_back();
    }
}

impl Log for CliLogger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        self.filter.enabled(metadata)
    }

    fn log(&self, record: &Record<'_>) {
        if !self.filter.matches(record) {
            return;
        }
        let line = format_line(record);
        let mut sinks = lock(&self.sinks);
        let mute_terminal =
            self.terminal_handed_over.load(Ordering::SeqCst) && sinks.file.is_some();
        if !mute_terminal {
            let _ = sinks.terminal.write_all(line.as_bytes());
        }
        if let Some(file) = sinks.file.as_mut() {
            let _ = file.write_all(line.as_bytes());
        }
    }

    fn flush(&self) {}
}

fn format_line(record: &Record<'_>) -> String {
    let sanitized = speedwave_runtime::log_sanitizer::sanitize(&record.args().to_string());
    let ts = speedwave_runtime::log_ts::log_timestamp();
    format!(
        "{ts} [{level}][{target}] {sanitized}\n",
        level = record.level(),
        target = record.target(),
    )
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test fixtures assert on setup that must not silently fail"
)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[derive(Clone, Default)]
    struct SharedBuf(Arc<Mutex<Vec<u8>>>);

    impl SharedBuf {
        fn text(&self) -> String {
            String::from_utf8(lock(&self.0).clone()).unwrap()
        }
    }

    impl Write for SharedBuf {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            lock(&self.0).extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn filter(spec: &str) -> env_logger::Logger {
        env_logger::Builder::new().parse_filters(spec).build()
    }

    fn emit(logger: &CliLogger, level: log::Level, message: &str) {
        logger.log(
            &Record::builder()
                .args(format_args!("{message}"))
                .level(level)
                .target("speedwave_cli::test")
                .build(),
        );
    }

    struct Fixture {
        logger: CliLogger,
        terminal: SharedBuf,
        file_path: std::path::PathBuf,
        _dir: tempfile::TempDir,
    }

    impl Fixture {
        fn with_file(spec: &str) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let file_path = dir.path().join("cli.log");
            let terminal = SharedBuf::default();
            let logger = CliLogger::new(filter(spec), Box::new(terminal.clone()));
            let file = speedwave_runtime::log_file::open_log_file(&file_path).unwrap();
            logger.set_file(Box::new(file));
            Self {
                logger,
                terminal,
                file_path,
                _dir: dir,
            }
        }

        fn file_text(&self) -> String {
            std::fs::read_to_string(&self.file_path).unwrap()
        }
    }

    #[test]
    fn a_line_goes_to_both_sinks_until_the_terminal_is_handed_over_and_again_after_it_returns() {
        let fx = Fixture::with_file("info");

        emit(&fx.logger, log::Level::Info, "before handover");
        {
            let _handover = fx.logger.hand_over_terminal();
            emit(&fx.logger, log::Level::Info, "during handover");
        }
        emit(&fx.logger, log::Level::Info, "after handover");

        let terminal = fx.terminal.text();
        assert!(terminal.contains("before handover"), "{terminal}");
        assert!(!terminal.contains("during handover"), "{terminal}");
        assert!(terminal.contains("after handover"), "{terminal}");
        let file = fx.file_text();
        assert!(file.contains("before handover"), "{file}");
        assert!(file.contains("during handover"), "{file}");
        assert!(file.contains("after handover"), "{file}");
    }

    #[test]
    fn the_terminal_is_given_back_when_the_handover_ends_by_an_early_return() {
        fn exec_that_fails(logger: &CliLogger) -> Result<(), ()> {
            let _handover = logger.hand_over_terminal();
            emit(logger, log::Level::Info, "inside");
            Err(())
        }
        let fx = Fixture::with_file("info");

        assert!(exec_that_fails(&fx.logger).is_err());
        emit(&fx.logger, log::Level::Info, "outside");

        let terminal = fx.terminal.text();
        assert!(!terminal.contains("inside"), "{terminal}");
        assert!(terminal.contains("outside"), "{terminal}");
    }

    #[test]
    fn a_line_has_the_timestamp_level_target_and_sanitized_message_layout() {
        let fx = Fixture::with_file("info");

        emit(
            &fx.logger,
            log::Level::Warn,
            "call with Bearer sk-ant-api03-secret123",
        );

        let file = fx.file_text();
        let line = file.lines().next().unwrap();
        let (ts, rest) = line.split_once(' ').unwrap();
        assert!(chrono::DateTime::parse_from_rfc3339(ts).is_ok(), "{line}");
        assert_eq!(
            rest,
            "[WARN][speedwave_cli::test] call with Bearer ***REDACTED***"
        );
        assert_eq!(fx.terminal.text(), file);
    }

    #[test]
    fn the_filter_applies_to_both_sinks() {
        let fx = Fixture::with_file("info");

        emit(&fx.logger, log::Level::Debug, "too verbose");
        emit(&fx.logger, log::Level::Info, "kept");

        assert!(!fx.terminal.text().contains("too verbose"));
        assert!(!fx.file_text().contains("too verbose"));
        assert!(fx.terminal.text().contains("kept"));
        assert!(fx.file_text().contains("kept"));
    }

    #[test]
    fn without_a_file_sink_the_handover_is_recorded_but_the_terminal_keeps_logging() {
        let terminal = SharedBuf::default();
        let logger = CliLogger::new(filter("info"), Box::new(terminal.clone()));

        let handover = logger.hand_over_terminal();
        emit(&logger, log::Level::Info, "no file attached");

        assert!(logger.terminal_handed_over.load(Ordering::SeqCst));
        assert!(terminal.text().contains("no file attached"));
        drop(handover);
        assert!(!logger.terminal_handed_over.load(Ordering::SeqCst));
    }

    #[test]
    fn an_unset_variable_falls_back_to_the_info_filter() {
        let terminal = SharedBuf::default();
        let logger = CliLogger::new(
            filter_from(
                env_logger::Env::new().filter_or("SPEEDWAVE_TEST_CLI_LOGGER_UNSET", "info"),
            ),
            Box::new(terminal.clone()),
        );

        emit(&logger, log::Level::Debug, "too verbose");
        emit(&logger, log::Level::Info, "kept");

        assert!(!terminal.text().contains("too verbose"));
        assert!(terminal.text().contains("kept"));
    }

    #[test]
    fn the_handed_over_flag_follows_the_guard() {
        let fx = Fixture::with_file("info");
        let handed_over = || fx.logger.terminal_handed_over.load(Ordering::SeqCst);

        assert!(!handed_over());
        let handover = fx.logger.hand_over_terminal();
        assert!(handed_over());
        drop(handover);
        assert!(!handed_over());
    }
}
