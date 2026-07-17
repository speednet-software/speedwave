//! Native Claude Code slash-command allowlist: which built-in commands the
//! popover shows (`show: true`) versus hides but still classifies (`show:
//! false`). Display filter only - hidden and unknown names still execute
//! when typed manually (CLI parity, see the chat-slash-commands design).

use crate::slash::SlashKind;

/// One native Claude Code command known to Speedwave.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeSlashCommand {
    /// Command name exactly as Claude Code accepts it, without the leading slash.
    pub name: &'static str,
    /// Short user-facing one-liner. Empty string allowed only when `show` is `false`.
    pub description: &'static str,
    /// Badge classification for the popover.
    pub badge: SlashKind,
    /// Whether the popover displays this entry (a display filter only).
    pub show: bool,
    /// Extra selectable levels (currently only `effort` carries these).
    pub levels: Option<&'static [&'static str]>,
}

/// The full native-command table. Visible entries (`show: true`) must all
/// appear in the live pinned-CC `system/init` output (guarded by a
/// discovery-side test once wired in a later task); this module only
/// enforces internal shape invariants.
pub const NATIVE_SLASH_COMMANDS: &[NativeSlashCommand] = &[
    NativeSlashCommand {
        name: "clear",
        description: "Clear the conversation",
        badge: SlashKind::Builtin,
        show: true,
        levels: None,
    },
    NativeSlashCommand {
        name: "compact",
        description: "Compact the conversation to save context",
        badge: SlashKind::Builtin,
        show: true,
        levels: None,
    },
    NativeSlashCommand {
        name: "context",
        description: "Show the current context window usage",
        badge: SlashKind::Builtin,
        show: true,
        levels: None,
    },
    NativeSlashCommand {
        name: "usage",
        description: "Show the current subscription usage",
        badge: SlashKind::Builtin,
        show: true,
        levels: None,
    },
    NativeSlashCommand {
        name: "model",
        description: "Show or switch the model for this session",
        badge: SlashKind::Builtin,
        show: true,
        levels: None,
    },
    NativeSlashCommand {
        name: "effort",
        description: "Show or set the reasoning effort level",
        badge: SlashKind::Builtin,
        show: true,
        levels: Some(&["low", "medium", "high", "xhigh", "max", "ultracode", "auto"]),
    },
    NativeSlashCommand {
        name: "config",
        description: "",
        badge: SlashKind::Builtin,
        show: false,
        levels: None,
    },
    NativeSlashCommand {
        name: "doctor",
        description: "",
        badge: SlashKind::Builtin,
        show: false,
        levels: None,
    },
    NativeSlashCommand {
        name: "mcp",
        description: "",
        badge: SlashKind::Builtin,
        show: false,
        levels: None,
    },
    NativeSlashCommand {
        name: "debug",
        description: "",
        badge: SlashKind::Builtin,
        show: false,
        levels: None,
    },
    NativeSlashCommand {
        name: "heapdump",
        description: "",
        badge: SlashKind::Builtin,
        show: false,
        levels: None,
    },
    NativeSlashCommand {
        name: "agents",
        description: "",
        badge: SlashKind::Builtin,
        show: false,
        levels: None,
    },
    NativeSlashCommand {
        name: "init",
        description: "",
        badge: SlashKind::Builtin,
        show: false,
        levels: None,
    },
    NativeSlashCommand {
        name: "insights",
        description: "",
        badge: SlashKind::Builtin,
        show: false,
        levels: None,
    },
    NativeSlashCommand {
        name: "extra-usage",
        description: "",
        badge: SlashKind::Builtin,
        show: false,
        levels: None,
    },
    NativeSlashCommand {
        name: "fast",
        description: "",
        badge: SlashKind::Builtin,
        show: false,
        levels: None,
    },
    NativeSlashCommand {
        name: "color",
        description: "",
        badge: SlashKind::Builtin,
        show: false,
        levels: None,
    },
    NativeSlashCommand {
        name: "batch",
        description: "",
        badge: SlashKind::Builtin,
        show: false,
        levels: None,
    },
    NativeSlashCommand {
        name: "review",
        description: "",
        badge: SlashKind::Builtin,
        show: false,
        levels: None,
    },
    NativeSlashCommand {
        name: "exit",
        description: "",
        badge: SlashKind::Builtin,
        show: false,
        levels: None,
    },
    NativeSlashCommand {
        name: "logout",
        description: "",
        badge: SlashKind::Builtin,
        show: false,
        levels: None,
    },
    NativeSlashCommand {
        name: "login",
        description: "",
        badge: SlashKind::Builtin,
        show: false,
        levels: None,
    },
    NativeSlashCommand {
        name: "resume",
        description: "",
        badge: SlashKind::Builtin,
        show: false,
        levels: None,
    },
    NativeSlashCommand {
        name: "memory",
        description: "",
        badge: SlashKind::Builtin,
        show: false,
        levels: None,
    },
    NativeSlashCommand {
        name: "help",
        description: "",
        badge: SlashKind::Builtin,
        show: false,
        levels: None,
    },
    NativeSlashCommand {
        name: "cost",
        description: "",
        badge: SlashKind::Builtin,
        show: false,
        levels: None,
    },
];

/// Looks up a native command by bare name (no leading slash). `None` when
/// `name` is not a known native (unknown names are handled elsewhere via
/// default-deny classification, not this lookup).
pub fn native_command(name: &str) -> Option<&'static NativeSlashCommand> {
    NATIVE_SLASH_COMMANDS.iter().find(|c| c.name == name)
}

#[cfg(test)]
#[expect(clippy::expect_used, reason = "test code asserts via expect")]
mod tests {
    use super::*;

    const VISIBLE_NAMES: &[&str] = &["clear", "compact", "context", "usage", "model", "effort"];

    const HIDDEN_NAMES: &[&str] = &[
        "config",
        "doctor",
        "mcp",
        "debug",
        "heapdump",
        "agents",
        "init",
        "insights",
        "extra-usage",
        "fast",
        "color",
        "batch",
        "review",
        "exit",
        "logout",
        "login",
        "resume",
        "memory",
        "help",
        "cost",
    ];

    #[test]
    fn native_command_finds_known_entries() {
        let clear = native_command("clear").expect("clear must be registered");
        assert_eq!(clear.name, "clear");
        assert!(clear.show);

        let doctor = native_command("doctor").expect("doctor must be registered");
        assert!(!doctor.show);
    }

    #[test]
    fn native_command_returns_none_for_unknown_name() {
        assert!(native_command("not-a-real-native-command").is_none());
        assert!(native_command("").is_none());
    }

    #[test]
    fn visible_set_is_exactly_the_expected_six() {
        let visible: Vec<&str> = NATIVE_SLASH_COMMANDS
            .iter()
            .filter(|c| c.show)
            .map(|c| c.name)
            .collect();
        let mut visible_sorted = visible.clone();
        visible_sorted.sort_unstable();
        let mut expected_sorted = VISIBLE_NAMES.to_vec();
        expected_sorted.sort_unstable();
        assert_eq!(visible_sorted, expected_sorted);
    }

    #[test]
    fn every_visible_entry_has_non_empty_description() {
        for name in VISIBLE_NAMES {
            let entry = native_command(name).unwrap_or_else(|| panic!("missing entry: {name}"));
            assert!(
                !entry.description.is_empty(),
                "visible entry '{name}' must have a non-empty description"
            );
        }
    }

    #[test]
    fn hidden_entries_are_all_present_with_show_false() {
        for name in HIDDEN_NAMES {
            let entry = native_command(name).unwrap_or_else(|| panic!("missing entry: {name}"));
            assert!(!entry.show, "hidden entry '{name}' must have show=false");
        }
    }

    #[test]
    fn only_effort_carries_levels_metadata() {
        for entry in NATIVE_SLASH_COMMANDS {
            if entry.name == "effort" {
                assert!(entry.levels.is_some(), "effort must carry levels metadata");
            } else {
                assert!(
                    entry.levels.is_none(),
                    "'{}' must not carry levels metadata",
                    entry.name
                );
            }
        }
    }

    #[test]
    fn effort_levels_match_expected_set() {
        let effort = native_command("effort").expect("effort must be registered");
        assert_eq!(
            effort.levels,
            Some(["low", "medium", "high", "xhigh", "max", "ultracode", "auto"].as_slice())
        );
    }

    #[test]
    fn no_duplicate_names_in_table() {
        let mut names: Vec<&str> = NATIVE_SLASH_COMMANDS.iter().map(|c| c.name).collect();
        let original_len = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(
            names.len(),
            original_len,
            "duplicate name in NATIVE_SLASH_COMMANDS"
        );
    }

    #[test]
    fn table_contains_no_unexpected_extra_entries() {
        let all_expected: Vec<&str> = VISIBLE_NAMES
            .iter()
            .chain(HIDDEN_NAMES.iter())
            .copied()
            .collect();
        for entry in NATIVE_SLASH_COMMANDS {
            assert!(
                all_expected.contains(&entry.name),
                "unexpected entry '{}' not in either VISIBLE_NAMES or HIDDEN_NAMES",
                entry.name
            );
        }
    }

    /// Pins the exact name set of `NATIVE_SLASH_COMMANDS`. This is a
    /// default-deny allowlist with no live guard against Claude Code shipping
    /// new built-ins: any addition or removal here must be a deliberate,
    /// reviewed change, not a silent drift — this test forces that review.
    #[test]
    fn native_slash_commands_name_set_is_pinned() {
        let mut actual: Vec<&str> = NATIVE_SLASH_COMMANDS.iter().map(|c| c.name).collect();
        actual.sort_unstable();
        let mut expected: Vec<&str> = VISIBLE_NAMES
            .iter()
            .chain(HIDDEN_NAMES.iter())
            .copied()
            .collect();
        expected.sort_unstable();
        assert_eq!(
            actual, expected,
            "NATIVE_SLASH_COMMANDS name set changed: if Claude Code added a new \
             built-in slash command, add it here deliberately (show=true only if \
             the popover should surface it); if this is a removal, update VISIBLE_NAMES/HIDDEN_NAMES too"
        );
    }
}
