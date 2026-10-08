//! CLI wrapper over `speedwave_version`: prints plain values for workflows.
//! Subcommands: `version`, `notes-range`, `validate-promotion`, `stable-tag`.

use clap::{Args, Parser, Subcommand};
use speedwave_version::{
    compute_version, notes_range, reject_if_ancestor_of_previous_line, stable_tag_for_line,
};
use std::path::PathBuf;

fn main() {
    let cli = Cli::parse();

    let result = match cli.command {
        Command::Version(args) => run_version(&args),
        Command::NotesRange(args) => run_notes_range(&args),
        Command::ValidatePromotion(args) => run_validate_promotion(&args),
        Command::StableTag(args) => run_stable_tag(&args),
    };

    if let Err(e) = result {
        emit(true, &format!("error: {e}"));
        std::process::exit(1);
    }
}

#[derive(Debug, Parser)]
#[command(name = "speedwave-version")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Version(RepoBranchArgs),
    NotesRange(RepoBranchArgs),
    ValidatePromotion(ValidatePromotionArgs),
    StableTag(StableTagArgs),
}

#[derive(Debug, Args)]
struct RepoBranchArgs {
    #[arg(long, default_value = ".")]
    repo: PathBuf,
    #[arg(long)]
    branch: Option<String>,
}

#[derive(Debug, Args)]
struct ValidatePromotionArgs {
    #[arg(long, default_value = ".")]
    repo: PathBuf,
    #[arg(long)]
    candidate: String,
    #[arg(long)]
    new_minor: u64,
}

#[derive(Debug, Args)]
struct StableTagArgs {
    #[arg(long, default_value = ".")]
    repo: PathBuf,
    #[arg(long)]
    minor: u64,
}

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

fn run_version(args: &RepoBranchArgs) -> Result<(), String> {
    let v = compute_version(&args.repo, args.branch.as_deref()).map_err(|e| e.to_string())?;
    emit(false, &v);
    Ok(())
}

fn run_notes_range(args: &RepoBranchArgs) -> Result<(), String> {
    let range = notes_range(&args.repo, args.branch.as_deref()).map_err(|e| e.to_string())?;
    emit(false, &format!("{}..HEAD", range.since));
    for commit in &range.skip_commits {
        emit(false, commit);
    }
    Ok(())
}

fn run_validate_promotion(args: &ValidatePromotionArgs) -> Result<(), String> {
    reject_if_ancestor_of_previous_line(&args.repo, &args.candidate, args.new_minor)
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn run_stable_tag(args: &StableTagArgs) -> Result<(), String> {
    let tag = stable_tag_for_line(&args.repo, args.minor).map_err(|e| e.to_string())?;
    emit(false, &tag);
    Ok(())
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    reason = "test code: panics on failure are acceptable assertions"
)]
mod tests {
    use super::*;

    #[test]
    fn version_subcommand_parses_with_defaults() {
        let cli = Cli::try_parse_from(["speedwave-version", "version"]).expect("parse");
        match cli.command {
            Command::Version(args) => {
                assert_eq!(args.repo, PathBuf::from("."));
                assert_eq!(args.branch, None);
            }
            other => panic!("expected Version, got {other:?}"),
        }
    }

    #[test]
    fn version_subcommand_parses_repo_and_branch() {
        let cli = Cli::try_parse_from([
            "speedwave-version",
            "version",
            "--repo",
            "/tmp/repo",
            "--branch",
            "dev",
        ])
        .expect("parse");
        match cli.command {
            Command::Version(args) => {
                assert_eq!(args.repo, PathBuf::from("/tmp/repo"));
                assert_eq!(args.branch.as_deref(), Some("dev"));
            }
            other => panic!("expected Version, got {other:?}"),
        }
    }

    #[test]
    fn notes_range_subcommand_parses_with_defaults() {
        let cli = Cli::try_parse_from(["speedwave-version", "notes-range"]).expect("parse");
        match cli.command {
            Command::NotesRange(args) => {
                assert_eq!(args.repo, PathBuf::from("."));
                assert_eq!(args.branch, None);
            }
            other => panic!("expected NotesRange, got {other:?}"),
        }
    }

    #[test]
    fn validate_promotion_subcommand_parses_its_required_flags() {
        let cli = Cli::try_parse_from([
            "speedwave-version",
            "validate-promotion",
            "--candidate",
            "abc123",
            "--new-minor",
            "7",
        ])
        .expect("parse");
        match cli.command {
            Command::ValidatePromotion(args) => {
                assert_eq!(args.repo, PathBuf::from("."));
                assert_eq!(args.candidate, "abc123");
                assert_eq!(args.new_minor, 7);
            }
            other => panic!("expected ValidatePromotion, got {other:?}"),
        }
    }

    #[test]
    fn stable_tag_subcommand_parses_its_required_flags() {
        let cli = Cli::try_parse_from(["speedwave-version", "stable-tag", "--minor", "21"])
            .expect("parse");
        match cli.command {
            Command::StableTag(args) => {
                assert_eq!(args.repo, PathBuf::from("."));
                assert_eq!(args.minor, 21);
            }
            other => panic!("expected StableTag, got {other:?}"),
        }
    }

    #[test]
    fn stable_tag_without_minor_is_rejected() {
        assert!(Cli::try_parse_from(["speedwave-version", "stable-tag"]).is_err());
    }

    #[test]
    fn validate_promotion_without_candidate_is_rejected() {
        assert!(Cli::try_parse_from([
            "speedwave-version",
            "validate-promotion",
            "--new-minor",
            "7",
        ])
        .is_err());
    }

    #[test]
    fn unknown_subcommand_is_rejected() {
        assert!(Cli::try_parse_from(["speedwave-version", "bogus"]).is_err());
    }

    #[test]
    fn unknown_argument_is_rejected() {
        assert!(Cli::try_parse_from(["speedwave-version", "version", "--unknown"]).is_err());
    }

    #[test]
    fn flag_without_a_value_is_rejected() {
        assert!(Cli::try_parse_from(["speedwave-version", "version", "--repo"]).is_err());
    }

    #[test]
    fn new_minor_with_a_non_numeric_value_is_rejected() {
        assert!(Cli::try_parse_from([
            "speedwave-version",
            "validate-promotion",
            "--candidate",
            "abc123",
            "--new-minor",
            "not-a-number",
        ])
        .is_err());
    }
}
