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

struct CommonArgs {
    repo: PathBuf,
    branch: Option<String>,
}

fn parse_common(args: &[String]) -> CommonArgs {
    let mut repo = PathBuf::from(".");
    let mut branch = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--repo" => {
                if let Some(v) = args.get(i + 1) {
                    repo = PathBuf::from(v);
                }
                i += 2;
            }
            "--branch" => {
                if let Some(v) = args.get(i + 1) {
                    branch = Some(v.clone());
                }
                i += 2;
            }
            _ => i += 1,
        }
    }
    CommonArgs { repo, branch }
}

fn run_version(args: &CommonArgs) -> Result<(), String> {
    let v = compute_version(&args.repo, args.branch.as_deref()).map_err(|e| e.to_string())?;
    emit(false, &v.to_string());
    Ok(())
}

fn run_notes_range(args: &CommonArgs) -> Result<(), String> {
    let range = notes_range(&args.repo, args.branch.as_deref()).map_err(|e| e.to_string())?;
    emit(false, &format!("{}..{}", range.since, range.until));
    for commit in &range.skip_commits {
        emit(false, commit);
    }
    Ok(())
}

fn run_validate_promotion(common: &CommonArgs, rest: &[String]) -> Result<(), String> {
    let mut candidate: Option<String> = None;
    let mut new_minor: Option<u64> = None;
    let mut i = 0;
    while i < rest.len() {
        match rest[i].as_str() {
            "--candidate" => {
                candidate = rest.get(i + 1).cloned();
                i += 2;
            }
            "--new-minor" => {
                new_minor = rest.get(i + 1).and_then(|v| v.parse::<u64>().ok());
                i += 2;
            }
            _ => i += 1,
        }
    }
    let candidate = candidate.ok_or("--candidate <rev> is required")?;
    let new_minor = new_minor.ok_or("--new-minor <u64> is required")?;
    reject_if_ancestor_of_previous_line(&common.repo, &candidate, new_minor)
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
    let common = parse_common(rest);

    let result = match command.as_str() {
        "version" => run_version(&common),
        "notes-range" => run_notes_range(&common),
        "validate-promotion" => run_validate_promotion(&common, rest),
        other => Err(format!("unknown subcommand '{other}'")),
    };

    if let Err(e) = result {
        emit(true, &format!("error: {e}"));
        std::process::exit(1);
    }
}
