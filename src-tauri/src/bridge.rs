use tauri::{AppHandle, Emitter};
use tokio::task::block_in_place;

use kotonia_cli::agent::agent::{
    ApprovalHandler, ApprovalOutcome, ConnectionReply, Event, EventSink, SiteDecision,
};
use kotonia_cli::agent::wire::WireEvent;
use kotonia_cli::connectors::ConnectorCard;

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
    pub session_id: String,
    pub voice: crate::speech::VoiceConfig,
    pub streamed_text: String,
}

impl EventSink for TauriEventSink {
    fn emit(&mut self, event: Event) {
        let mut saved = None;
        match &event {
            Event::IterationStart { .. } => self.streamed_text.clear(),
            Event::Text { text } => {
                if !self.streamed_text.is_empty() {
                    self.streamed_text.push_str("\n\n");
                }
                self.streamed_text.push_str(text);
            }
            Event::Final { answer } => {
                let text = if answer.trim().is_empty() {
                    &self.streamed_text
                } else {
                    answer
                };
                match crate::history::append_response(&self.session_id, text, &self.voice) {
                    Ok(message) => saved = Some(message),
                    Err(error) => {
                        // A persistence error must be visible, but must not
                        // discard the result of an already executed task.
                        let _ = self.app.emit(
                            "history_error",
                            serde_json::json!({"session_id": self.session_id, "message": error}),
                        );
                    }
                }
            }
            _ => {}
        }
        let mut wire = serde_json::to_value(WireEvent::from_event(event)).unwrap();
        if wire["kind"] == "final" {
            wire["voice"] = serde_json::to_value(&self.voice).unwrap();
            if let Some(message) = saved {
                wire["message"] = serde_json::to_value(message).unwrap();
            } else {
                let text = wire["answer"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or(&self.streamed_text);
                wire["response"] = serde_json::to_value(crate::response::normalize(text)).unwrap();
            }
        }
        let payload = serde_json::json!({
            "task_id": self.task_id,
            "event": wire,
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
    pub cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

// AbortHandle alone cannot interrupt block_in_place + recv. Wake approval
// waiters too, so taking over the browser releases the session lock promptly.
fn wait_for_reply<T>(
    rx: std::sync::mpsc::Receiver<T>,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Option<T> {
    block_in_place(|| loop {
        if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            return None;
        }
        match rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(reply) => return Some(reply),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => return None,
        }
    })
}

impl ApprovalHandler for TauriApprovalHandler {
    fn ask(&mut self, command: &str, reason: &str) -> ApprovalOutcome {
        if self.cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            return ApprovalOutcome::Deny;
        }
        let approval_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = std::sync::mpsc::channel::<bool>();

        // Register the waiter BEFORE emitting — otherwise the JS side
        // could race in with the response and drop it on the floor.
        self.pending.lock().unwrap().insert(approval_id.clone(), tx);

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
        let approved = wait_for_reply(rx, &self.cancelled).unwrap_or(false);
        self.pending.lock().unwrap().remove(&approval_id);
        if approved {
            ApprovalOutcome::Approve
        } else {
            ApprovalOutcome::Deny
        }
    }

    fn request_connection(&mut self, card: &ConnectorCard) -> ConnectionReply {
        if self.cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            return ConnectionReply::Declined;
        }
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
        let reply = wait_for_reply(rx, &self.cancelled);
        self.pending_connectors.lock().unwrap().remove(&request_id);
        match reply {
            Some(Some(values)) => ConnectionReply::Provided(values),
            Some(None) => ConnectionReply::Declined,
            None => ConnectionReply::Unavailable,
        }
    }

    fn ask_site(&mut self, host: &str, url: &str) -> SiteDecision {
        if self.cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            return SiteDecision::Deny;
        }
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
        let reply = wait_for_reply(rx, &self.cancelled);
        self.pending_sites.lock().unwrap().remove(&request_id);
        match reply.as_deref() {
            Some("once") => SiteDecision::Once,
            Some("always") => SiteDecision::Always,
            _ => SiteDecision::Deny,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancellation_releases_an_approval_without_a_reply() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let (_tx, rx) = std::sync::mpsc::channel::<bool>();
        let cancelled = Arc::new(AtomicBool::new(false));
        let waiting = cancelled.clone();
        let task = tokio::spawn(async move { wait_for_reply(rx, &waiting) });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        cancelled.store(true, Ordering::SeqCst);
        let reply = tokio::time::timeout(std::time::Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reply, None);
    }
}
