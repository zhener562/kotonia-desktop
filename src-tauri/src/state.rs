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

/// Handles for one running prompt. The flag wakes synchronous approval
/// waiters; the abort handle stops async model/tool work. Completion removes
/// the task from `RunningTasks`.
pub struct RunningTask {
    pub abort: AbortHandle,
    pub cancelled: Arc<std::sync::atomic::AtomicBool>,
}

pub type RunningTasks = Arc<StdMutex<HashMap<String, RunningTask>>>;

/// A connector card waiting for the user: `Some(values)` when they filled it,
/// `None` when they cancelled. The values include the secret, which goes
/// straight from here into the vault — never into an event or a log.
pub type ConnectorReply = Option<std::collections::BTreeMap<String, String>>;
pub type PendingConnectors =
    Arc<StdMutex<HashMap<String, std::sync::mpsc::Sender<ConnectorReply>>>>;

/// "Open this unfamiliar site?" waiting for `once` / `always` / `deny`.
pub type PendingSites = Arc<StdMutex<HashMap<String, std::sync::mpsc::Sender<String>>>>;

pub struct AppState {
    pub sessions: Arc<SessionRegistry>,
    pub pending_approvals: PendingApprovals,
    pub running_tasks: RunningTasks,
    /// Last authoritative server result for the paired device token.
    /// Transient network failures leave this unchanged so an offline user
    /// is not incorrectly shown as logged out.
    pub auth_invalid: std::sync::atomic::AtomicBool,
    /// Ditto avatar preparation is deferred until avatar speech is actually
    /// requested. The mutex prevents concurrent first-use calls from racing
    /// to register the same bundled avatar.
    pub avatar_ready: AsyncMutex<bool>,
    pub pending_connectors: PendingConnectors,
    pub pending_sites: PendingSites,
    /// The resident heartbeat loop while home mode is on (`None` = stopped).
    pub home_runner: StdMutex<Option<AbortHandle>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            pending_approvals: Arc::new(StdMutex::new(HashMap::new())),
            running_tasks: Arc::new(StdMutex::new(HashMap::new())),
            auth_invalid: std::sync::atomic::AtomicBool::new(false),
            avatar_ready: AsyncMutex::new(false),
            pending_connectors: Arc::new(StdMutex::new(HashMap::new())),
            pending_sites: Arc::new(StdMutex::new(HashMap::new())),
            home_runner: StdMutex::new(None),
        }
    }
}
