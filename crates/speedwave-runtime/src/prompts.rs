//! Prompt copy appended to Claude Code sessions via `--append-system-prompt`.

/// Skill-recall nudge for local-LLM sessions: small open models rarely act on
/// the skills list unprompted, so the contract is restated explicitly.
pub fn local_llm_skills_nudge() -> &'static str {
    "SKILL USAGE: Your context lists available skills, invokable with the Skill tool. \
     Before starting any non-trivial task, check that list for a matching skill and, \
     when one matches, invoke it before doing the work yourself. \
     When the user types /<skill-name>, always invoke exactly that skill first. \
     Prefer a matching skill over improvising the same workflow manually."
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn nudge_names_the_skill_tool_and_slash_invocation() {
        let nudge = local_llm_skills_nudge();
        assert!(nudge.contains("Skill tool"));
        assert!(nudge.contains("/<skill-name>"));
    }

    #[test]
    fn nudge_is_single_line_shell_safe_copy() {
        let nudge = local_llm_skills_nudge();
        assert!(
            !nudge.contains('\n'),
            "must stay a single argv token-safe line"
        );
        assert!(!nudge.contains('`') && !nudge.contains('"') && !nudge.contains('\''));
    }
}
