use tauri::{AppHandle, Emitter};
use tokio::task::block_in_place;

use kotonia_cli::agent::agent::{
    ApprovalHandler, ApprovalOutcome, ConnectionReply, Event, EventSink, SiteDecision,
};
use kotonia_cli::connectors::ConnectorCard;
use kotonia_cli::agent::wire::WireEvent;

use crate::state::{ConnectorReply, PendingApprovals, PendingConnectors, PendingSites};

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
    pub pending_connectors: PendingConnectors,
    pub pending_sites: PendingSites,
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

    fn request_connection(&mut self, card: &ConnectorCard) -> ConnectionReply {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = std::sync::mpsc::channel::<ConnectorReply>();
        self.pending_connectors
            .lock()
            .unwrap()
            .insert(request_id.clone(), tx);
        let sent = self
            .app
            .emit(
                "connector_request",
                serde_json::json!({
                    "request_id": request_id,
                    "task_id": self.task_id,
                    "card": card,
                }),
            )
            .is_ok();
        if !sent {
            self.pending_connectors.lock().unwrap().remove(&request_id);
            return ConnectionReply::Unavailable;
        }
        match block_in_place(|| rx.recv()) {
            Ok(Some(values)) => ConnectionReply::Provided(values),
            Ok(None) => ConnectionReply::Declined,
            Err(_) => ConnectionReply::Unavailable,
        }
    }

    fn ask_site(&mut self, host: &str, url: &str) -> SiteDecision {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        self.pending_sites
            .lock()
            .unwrap()
            .insert(request_id.clone(), tx);
        let sent = self
            .app
            .emit(
                "site_request",
                serde_json::json!({
                    "request_id": request_id,
                    "task_id": self.task_id,
                    "host": host,
                    "url": url,
                }),
            )
            .is_ok();
        if !sent {
            self.pending_sites.lock().unwrap().remove(&request_id);
            return SiteDecision::Deny;
        }
        match block_in_place(|| rx.recv()).as_deref() {
            Ok("once") => SiteDecision::Once,
            Ok("always") => SiteDecision::Always,
            _ => SiteDecision::Deny,
        }
    }
}
