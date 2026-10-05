//! CLI wrapper over `speedwave_version`: prints plain values for workflows.
//! Subcommands: `version`, `notes-range`, `validate-promotion`.

use speedwave_version::{compute_version, notes_range, reject_if_ancestor_of_previous_line};
use std::path::PathBuf;

#[expect(
    clippy::print_stdout,
    clippy::print_stderr,
    reason = "this bin's single output sink: plain values for shell callers"
)]
fn emit(to_stderr: bool, line: &str) {
    if to_stderr {
        eprintln!("{line}");
    } else {
        println!("{line}");
    }
}

#[derive(Debug)]
struct ParsedArgs {
    repo: PathBuf,
    branch: Option<String>,
    candidate: Option<String>,
    new_minor: Option<u64>,
}

fn parse_args(args: &[String]) -> Result<ParsedArgs, String> {
    let mut repo = PathBuf::from(".");
    let mut branch = None;
    let mut candidate = None;
    let mut new_minor = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--repo" => {
                let v = args
                    .get(i + 1)
                    .ok_or_else(|| "--repo requires a value".to_string())?;
                repo = PathBuf::from(v);
                i += 2;
            }
            "--branch" => {
                let v = args
                    .get(i + 1)
                    .ok_or_else(|| "--branch requires a value".to_string())?;
                branch = Some(v.clone());
                i += 2;
            }
            "--candidate" => {
                let v = args
                    .get(i + 1)
                    .ok_or_else(|| "--candidate requires a value".to_string())?;
                candidate = Some(v.clone());
                i += 2;
            }
            "--new-minor" => {
                let v = args
                    .get(i + 1)
                    .ok_or_else(|| "--new-minor requires a value".to_string())?;
                new_minor = Some(
                    v.parse::<u64>()
                        .map_err(|_| format!("--new-minor value '{v}' is not a valid u64"))?,
                );
                i += 2;
            }
            other => return Err(format!("unknown argument '{other}'")),
        }
    }
    Ok(ParsedArgs {
        repo,
        branch,
        candidate,
        new_minor,
    })
}

fn run_version(args: &ParsedArgs) -> Result<(), String> {
    let v = compute_version(&args.repo, args.branch.as_deref()).map_err(|e| e.to_string())?;
    emit(false, &v);
    Ok(())
}

fn run_notes_range(args: &ParsedArgs) -> Result<(), String> {
    let range = notes_range(&args.repo, args.branch.as_deref()).map_err(|e| e.to_string())?;
    emit(false, &format!("{}..HEAD", range.since));
    for commit in &range.skip_commits {
        emit(false, commit);
    }
    Ok(())
}

fn run_validate_promotion(args: &ParsedArgs) -> Result<(), String> {
    let candidate = args
        .candidate
        .clone()
        .ok_or("--candidate <rev> is required")?;
    let new_minor = args.new_minor.ok_or("--new-minor <u64> is required")?;
    reject_if_ancestor_of_previous_line(&args.repo, &candidate, new_minor)
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    let all: Vec<String> = std::env::args().collect();
    let Some(command) = all.get(1).cloned() else {
        emit(
            true,
            "usage: speedwave-version <version|notes-range|validate-promotion> [--repo PATH] [--branch NAME]",
        );
        std::process::exit(2);
    };
    let rest = if all.len() > 2 { &all[2..] } else { &[] };

    let result = parse_args(rest).and_then(|args| match command.as_str() {
        "version" => run_version(&args),
        "notes-range" => run_notes_range(&args),
        "validate-promotion" => run_validate_promotion(&args),
        other => Err(format!("unknown subcommand '{other}'")),
    });

    if let Err(e) = result {
        emit(true, &format!("error: {e}"));
        std::process::exit(1);
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test code: panics on failure are acceptable assertions"
)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_known_flags() {
        let parsed = parse_args(&args(&[
            "--repo",
            "/tmp/repo",
            "--branch",
            "dev",
            "--candidate",
            "abc123",
            "--new-minor",
            "7",
        ]))
        .expect("parse");
        assert_eq!(parsed.repo, PathBuf::from("/tmp/repo"));
        assert_eq!(parsed.branch.as_deref(), Some("dev"));
        assert_eq!(parsed.candidate.as_deref(), Some("abc123"));
        assert_eq!(parsed.new_minor, Some(7));
    }

    #[test]
    fn defaults_when_no_args_given() {
        let parsed = parse_args(&args(&[])).expect("parse");
        assert_eq!(parsed.repo, PathBuf::from("."));
        assert_eq!(parsed.branch, None);
        assert_eq!(parsed.candidate, None);
        assert_eq!(parsed.new_minor, None);
    }

    #[test]
    fn unknown_argument_is_a_named_error() {
        let err = parse_args(&args(&["--unknown"])).unwrap_err();
        assert_eq!(err, "unknown argument '--unknown'");
    }

    #[test]
    fn flag_without_a_value_is_a_named_error() {
        let err = parse_args(&args(&["--repo"])).unwrap_err();
        assert_eq!(err, "--repo requires a value");
    }

    #[test]
    fn new_minor_without_a_value_is_a_named_error() {
        let err = parse_args(&args(&["--new-minor"])).unwrap_err();
        assert_eq!(err, "--new-minor requires a value");
    }

    #[test]
    fn new_minor_with_a_non_numeric_value_is_a_named_error() {
        let err = parse_args(&args(&["--new-minor", "not-a-number"])).unwrap_err();
        assert_eq!(err, "--new-minor value 'not-a-number' is not a valid u64");
    }
}
