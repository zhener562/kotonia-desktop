use tauri::{AppHandle, Emitter};
use tokio::task::block_in_place;

use kotonia_cli::agent::agent::{ApprovalHandler, ApprovalOutcome, Event, EventSink};
use kotonia_cli::agent::wire::WireEvent;

use crate::state::PendingApprovals;

/// `EventSink` implementation that forwards every agent event to the
/// frontend via a Tauri event named `"agent_event"`. Payload shape matches
/// the daemon's `DeviceMsg::AgentEvent`:
///
/// ```json
/// { "task_id": "...", "event": { "kind": "bash", "command": "ls" } }
/// ```
pub struct TauriEventSink {
    pub app: AppHandle,
    pub task_id: String,
}

impl EventSink for TauriEventSink {
    fn emit(&mut self, event: Event) {
        let payload = serde_json::json!({
            "task_id": self.task_id,
            "event": WireEvent::from_event(event),
        });
        let _ = self.app.emit("agent_event", payload);
    }
}

/// `ApprovalHandler` implementation that emits a request to the frontend
/// and blocks until `respond_approval` lands the result via the shared
/// `PendingApprovals` map.
pub struct TauriApprovalHandler {
    pub app: AppHandle,
    pub task_id: String,
    pub pending: PendingApprovals,
}

impl ApprovalHandler for TauriApprovalHandler {
    fn ask(&mut self, command: &str, reason: &str) -> ApprovalOutcome {
        let approval_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = std::sync::mpsc::channel::<bool>();

        // Register the waiter BEFORE emitting — otherwise the JS side
        // could race in with the response and drop it on the floor.
        self.pending
            .lock()
            .unwrap()
            .insert(approval_id.clone(), tx);

        let emit_ok = self
            .app
            .emit(
                "approval_request",
                serde_json::json!({
                    "approval_id": approval_id,
                    "task_id": self.task_id,
                    "command": command,
                    "reason": reason,
                }),
            )
            .is_ok();

        if !emit_ok {
            self.pending.lock().unwrap().remove(&approval_id);
            return ApprovalOutcome::Deny;
        }

        // Block this worker thread (block_in_place lets other tokio tasks
        // keep running on other workers) until the frontend resolves it.
        let approved = block_in_place(|| rx.recv().unwrap_or(false));
        if approved {
            ApprovalOutcome::Approve
        } else {
            ApprovalOutcome::Deny
        }
    }
}
