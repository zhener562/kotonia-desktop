use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use tokio::sync::{Mutex as AsyncMutex, RwLock};
use tokio::task::AbortHandle;

use kotonia_cli::agent::dispatch::DispatchAgent;
use kotonia_cli::agent::worktree::AgentWorkspace;

/// Per-session state. Mirrors the daemon's model: keep the Agent alive
/// across `submit_task` calls so multi-turn conversations thread through
/// the same worktree and history.
pub struct SessionState {
    pub agent: DispatchAgent,
    // Held so worktree-mode (T1) can call `workspace.cleanup()` on session
    // close. In_place mode doesn't strictly need it, but the field stays so
    // the two modes don't diverge in shape.
    #[allow(dead_code)]
    pub workspace: AgentWorkspace,
}

/// Map of `session_id → SessionState`. Wrapped in `AsyncMutex` per session
/// so the LLM call inside `run_turn` can yield while holding the lock.
pub type SessionRegistry = RwLock<HashMap<String, Arc<AsyncMutex<SessionState>>>>;

/// Pending approval map. The sync `ApprovalHandler::ask` registers a
/// `std::sync::mpsc::Sender<bool>` here; the async `respond_approval`
/// command takes the sender back out and resolves it.
pub type PendingApprovals = Arc<StdMutex<HashMap<String, std::sync::mpsc::Sender<bool>>>>;

/// Map of `task_id → AbortHandle` for the currently-running tokio task
/// of each submitted prompt. `cancel_task` looks up by id and aborts;
/// the cleanup task (spawned alongside the work) removes entries on
/// natural completion. AbortHandle (not JoinHandle) so multiple owners
/// can hold it without the `!Clone` headache.
pub type RunningTasks = Arc<StdMutex<HashMap<String, AbortHandle>>>;

pub struct AppState {
    pub sessions: Arc<SessionRegistry>,
    pub pending_approvals: PendingApprovals,
    pub running_tasks: RunningTasks,
    /// Set when the server has told us our paired device_token is no
    /// longer valid (e.g. the startup avatar registration got a 403).
    /// `auth_status` folds this into `logged_in` so the UI can tell
    /// "file on disk exists" apart from "server still honors it" —
    /// without polling the server on a timer for it (see commands.rs).
    pub auth_invalid: std::sync::atomic::AtomicBool,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            pending_approvals: Arc::new(StdMutex::new(HashMap::new())),
            running_tasks: Arc::new(StdMutex::new(HashMap::new())),
            auth_invalid: std::sync::atomic::AtomicBool::new(false),
        }
    }
}
