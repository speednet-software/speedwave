use crate::chat::{StreamChunk, TaskState};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct WorkflowPhase {
    pub index: u32,
    pub title: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct WorkflowAgent {
    pub label: String,
    pub phase_index: u32,
    pub state: TaskState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_tool_summary: Option<String>,
    pub tool_calls: u32,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_preview: Option<String>,
}

#[derive(Debug, Default)]
pub(crate) struct WorkflowTracker {
    phases: Vec<WorkflowPhase>,
    agents: Vec<WorkflowAgent>,
    ended: Option<TaskState>,
}

impl WorkflowTracker {
    pub(crate) fn replace(&mut self, phases: Vec<WorkflowPhase>, agents: Vec<WorkflowAgent>) {
        self.phases = phases;
        self.agents = agents;
        if let Some(ended) = self.ended {
            close_running(&mut self.agents, ended);
        }
    }

    pub(crate) fn finish(&mut self, state: TaskState) -> bool {
        if state == TaskState::Running {
            return false;
        }
        self.ended = Some(state);
        close_running(&mut self.agents, state)
    }

    pub(crate) fn chunk(&self, tool_id: &str) -> StreamChunk {
        StreamChunk::WorkflowProgress {
            tool_id: tool_id.to_string(),
            phases: self.phases.clone(),
            agents: self.agents.clone(),
        }
    }
}

pub(crate) fn parse(line: &serde_json::Value) -> Option<(Vec<WorkflowPhase>, Vec<WorkflowAgent>)> {
    let elements = line["workflow_progress"].as_array()?;
    let phases = elements
        .iter()
        .filter(|e| e["type"] == "workflow_phase")
        .filter_map(parse_phase)
        .collect();
    let agents = elements
        .iter()
        .filter(|e| e["type"] == "workflow_agent")
        .filter_map(parse_agent)
        .collect();
    Some((phases, agents))
}

fn parse_phase(element: &serde_json::Value) -> Option<WorkflowPhase> {
    Some(WorkflowPhase {
        index: u32::try_from(element["index"].as_u64()?).ok()?,
        title: element["title"].as_str()?.to_string(),
    })
}

fn parse_agent(element: &serde_json::Value) -> Option<WorkflowAgent> {
    let text = |key: &str| element[key].as_str().map(str::to_string);
    Some(WorkflowAgent {
        label: text("label")?,
        phase_index: count(&element["phaseIndex"]),
        state: agent_state(element["state"].as_str().unwrap_or_default()),
        last_tool_name: text("lastToolName"),
        last_tool_summary: text("lastToolSummary"),
        tool_calls: count(&element["toolCalls"]),
        duration_ms: element["durationMs"].as_u64().unwrap_or_default(),
        result_preview: text("resultPreview"),
    })
}

fn count(value: &serde_json::Value) -> u32 {
    value
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or_default()
}

fn agent_state(raw: &str) -> TaskState {
    if raw == "done" {
        TaskState::Completed
    } else if raw.contains("fail") || raw.contains("error") {
        TaskState::Error
    } else if ["stop", "cancel", "kill"].iter().any(|s| raw.contains(s)) {
        TaskState::Stopped
    } else {
        TaskState::Running
    }
}

fn close_running(agents: &mut [WorkflowAgent], workflow: TaskState) -> bool {
    let closed = if workflow == TaskState::Completed {
        TaskState::Completed
    } else {
        TaskState::Stopped
    };
    let mut changed = false;
    for agent in agents.iter_mut().filter(|a| a.state == TaskState::Running) {
        agent.state = closed;
        changed = true;
    }
    changed
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test assertions may unwrap freely")]
mod tests {
    use super::*;
    use serde_json::json;

    fn agent(label: &str, state: TaskState) -> WorkflowAgent {
        WorkflowAgent {
            label: label.to_string(),
            phase_index: 1,
            state,
            last_tool_name: None,
            last_tool_summary: None,
            tool_calls: 0,
            duration_ms: 0,
            result_preview: None,
        }
    }

    #[test]
    fn a_line_without_the_array_has_no_snapshot() {
        assert_eq!(parse(&json!({"subtype": "task_progress"})), None);
        assert_eq!(
            parse(&json!({"workflow_progress": "nope"})),
            None,
            "a non-array value is not a snapshot"
        );
    }

    #[test]
    fn an_empty_array_is_an_empty_snapshot() {
        assert_eq!(
            parse(&json!({"workflow_progress": []})),
            Some((Vec::new(), Vec::new()))
        );
    }

    #[test]
    fn phases_and_agents_are_read_with_their_fields() {
        let line = json!({"workflow_progress": [
            {"type": "workflow_phase", "index": 1, "title": "Prepare"},
            {"type": "workflow_phase", "index": 2, "title": "Finish"},
            {
                "type": "workflow_agent", "label": "agent-a", "phaseIndex": 1,
                "state": "done", "lastToolName": "Bash", "lastToolSummary": "echo ok",
                "toolCalls": 3, "durationMs": 8157, "resultPreview": "agent done",
                "tokens": 11, "agentId": "ignored"
            },
            {"type": "something_else", "label": "x"}
        ]});
        let (phases, agents) = parse(&line).unwrap();
        assert_eq!(
            phases,
            [
                WorkflowPhase {
                    index: 1,
                    title: "Prepare".into()
                },
                WorkflowPhase {
                    index: 2,
                    title: "Finish".into()
                }
            ]
        );
        assert_eq!(
            agents,
            [WorkflowAgent {
                label: "agent-a".into(),
                phase_index: 1,
                state: TaskState::Completed,
                last_tool_name: Some("Bash".into()),
                last_tool_summary: Some("echo ok".into()),
                tool_calls: 3,
                duration_ms: 8157,
                result_preview: Some("agent done".into()),
            }]
        );
    }

    #[test]
    fn missing_numbers_and_options_default() {
        let line = json!({"workflow_progress": [
            {"type": "workflow_agent", "label": "a", "state": "start"}
        ]});
        let (_, agents) = parse(&line).unwrap();
        assert_eq!(
            agents,
            [WorkflowAgent {
                phase_index: 0,
                ..agent("a", TaskState::Running)
            }]
        );
    }

    #[test]
    fn malformed_elements_are_skipped() {
        let line = json!({"workflow_progress": [
            {"type": "workflow_phase", "index": "1", "title": "t"},
            {"type": "workflow_phase", "index": 4294967296u64, "title": "t"},
            {"type": "workflow_phase", "index": 1},
            {"type": "workflow_agent", "state": "done"},
            "text",
            {"type": "workflow_agent", "label": "kept", "state": "done"}
        ]});
        let (phases, agents) = parse(&line).unwrap();
        assert!(phases.is_empty());
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].label, "kept");
    }

    #[test]
    fn an_agent_state_maps_from_the_wire_value() {
        let cases = [
            ("progress", TaskState::Running),
            ("start", TaskState::Running),
            ("done", TaskState::Completed),
            ("error", TaskState::Error),
            ("failed", TaskState::Error),
            ("stopped", TaskState::Stopped),
            ("cancelled", TaskState::Stopped),
            ("killed", TaskState::Stopped),
            ("queued", TaskState::Running),
            ("", TaskState::Running),
        ];
        for (raw, expected) in cases {
            assert_eq!(agent_state(raw), expected, "state {raw:?}");
        }
    }

    #[test]
    fn a_completed_workflow_completes_the_agents_still_running() {
        let mut tracker = WorkflowTracker::default();
        tracker.replace(
            Vec::new(),
            vec![
                agent("a", TaskState::Running),
                agent("b", TaskState::Error),
                agent("c", TaskState::Completed),
            ],
        );
        assert!(tracker.finish(TaskState::Completed));
        let states: Vec<TaskState> = tracker.agents.iter().map(|a| a.state).collect();
        assert_eq!(
            states,
            [TaskState::Completed, TaskState::Error, TaskState::Completed]
        );
    }

    #[test]
    fn a_workflow_that_did_not_complete_stops_the_agents_still_running() {
        for final_state in [TaskState::Error, TaskState::Stopped] {
            let mut tracker = WorkflowTracker::default();
            tracker.replace(Vec::new(), vec![agent("a", TaskState::Running)]);
            assert!(tracker.finish(final_state));
            assert_eq!(tracker.agents[0].state, TaskState::Stopped);
        }
    }

    #[test]
    fn finishing_changes_nothing_when_no_agent_runs_or_the_state_is_not_final() {
        let mut tracker = WorkflowTracker::default();
        tracker.replace(Vec::new(), vec![agent("a", TaskState::Running)]);
        assert!(!tracker.finish(TaskState::Running));
        assert_eq!(tracker.agents[0].state, TaskState::Running);
        assert!(tracker.finish(TaskState::Completed));
        assert!(
            !tracker.finish(TaskState::Completed),
            "closing is idempotent"
        );
    }

    #[test]
    fn a_snapshot_after_the_end_is_closed_the_same_way() {
        let mut tracker = WorkflowTracker::default();
        assert!(!tracker.finish(TaskState::Error));
        tracker.replace(
            vec![WorkflowPhase {
                index: 1,
                title: "p".into(),
            }],
            vec![
                agent("a", TaskState::Running),
                agent("b", TaskState::Completed),
            ],
        );
        let states: Vec<TaskState> = tracker.agents.iter().map(|a| a.state).collect();
        assert_eq!(states, [TaskState::Stopped, TaskState::Completed]);
    }

    #[test]
    fn the_chunk_carries_the_whole_snapshot_under_the_tool() {
        let mut tracker = WorkflowTracker::default();
        tracker.replace(Vec::new(), vec![agent("a", TaskState::Running)]);
        match tracker.chunk("toolu_w") {
            StreamChunk::WorkflowProgress {
                tool_id,
                phases,
                agents,
            } => {
                assert_eq!(tool_id, "toolu_w");
                assert!(phases.is_empty());
                assert_eq!(agents, [agent("a", TaskState::Running)]);
            }
            other => panic!("expected WorkflowProgress, got {other:?}"),
        }
    }

    #[test]
    fn optional_fields_are_omitted_from_the_wire() {
        let v = serde_json::to_value(agent("a", TaskState::Running)).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["duration_ms", "label", "phase_index", "state", "tool_calls"]
        );
    }
}
