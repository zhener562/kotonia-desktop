use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex as AsyncMutex;

use kotonia_cli::agent::agent::{Agent, AgentConfig};
use kotonia_cli::agent::approval::ApprovalMode;
use kotonia_cli::agent::claude_code::{claude_code_session_id, ClaudeCodeAgent};
use kotonia_cli::agent::dispatch::DispatchAgent;
use kotonia_cli::agent::history::{load_session_messages, HistoryStore};
use kotonia_cli::agent::provider::Provider;
use kotonia_cli::agent::worktree::AgentWorkspace;

use crate::bridge::{TauriApprovalHandler, TauriEventSink};
use crate::state::{AppState, SessionState};

/// Default model alias. Resolves through kotonia-cli's provider registry to
/// the hosted `/api/v1/chat/completions` endpoint, authenticating with the
/// device_token from `~/.kotonia/daemon.json`.
const DEFAULT_MODEL: &str = "kotonia-gemma4-26b";

/// Default engine. `react` drives kotonia-cli's own ReAct loop over a
/// hosted provider; `claude-code` swaps in the `claude` CLI as a
/// subprocess in headless stream-json mode (mirrors `kotonia-cli --engine
/// claude-code`).
const DEFAULT_ENGINE: &str = "react";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EngineChoice {
    ReAct,
    ClaudeCode,
}

/// Same precedence as `kotonia-cli main.rs`: `--engine claude-code` OR
/// `--model claude-code` selects the subprocess engine; otherwise ReAct.
fn resolve_engine(engine: Option<&str>, model: Option<&str>) -> Result<EngineChoice, String> {
    let engine = engine.unwrap_or(DEFAULT_ENGINE);
    if engine == "claude-code" || model == Some("claude-code") {
        return Ok(EngineChoice::ClaudeCode);
    }
    if engine == "react" {
        return Ok(EngineChoice::ReAct);
    }
    Err(format!(
        "unknown engine `{engine}` (expected `react` or `claude-code`)"
    ))
}

/// Default agent workspace under the user's home. Used when the frontend
/// has not yet picked a workspace via the directory dialog (i.e. first
/// launch). Created on first use.
fn default_workspace_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "home directory not found".to_string())?;
    let root = home.join(".kotonia").join("desktop").join("workspace");
    std::fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;
    Ok(root)
}

/// Resolve a frontend-supplied workspace path. Accepts absolute paths
/// and `~/...`; rejects empty input and any path that doesn't already
/// exist (we don't auto-create arbitrary dirs — the operator picked it
/// via the OS dialog, so it really should exist). On `None`, returns
/// the default sandbox.
fn resolve_workspace(workspace_path: Option<&str>) -> Result<PathBuf, String> {
    let raw = match workspace_path.map(|s| s.trim()) {
        Some(s) if !s.is_empty() => s,
        _ => return default_workspace_root(),
    };
    let expanded = expand_tilde(raw);
    let candidate = PathBuf::from(&expanded);
    if !candidate.is_absolute() {
        return Err(format!("workspace must be an absolute path: {expanded}"));
    }
    let canonical = std::fs::canonicalize(&candidate)
        .map_err(|e| format!("workspace not accessible: {expanded} ({e})"))?;
    if !canonical.is_dir() {
        return Err(format!("workspace is not a directory: {}", canonical.display()));
    }
    Ok(canonical)
}

#[derive(Serialize)]
pub struct AuthStatus {
    pub logged_in: bool,
    pub server: Option<String>,
    pub device_id_prefix: Option<String>,
}

/// Static persona descriptor surfaced to the frontend so the WebView
/// can render Iris's name + avatar without hardcoding strings on both
/// sides of the IPC boundary.
#[tauri::command]
pub fn persona_info() -> serde_json::Value {
    serde_json::json!({
        "key": crate::persona::IRIS.key,
        "display_name": crate::persona::IRIS.display_name,
        "tagline": crate::persona::IRIS.tagline,
        "avatar_url": crate::persona::IRIS.avatar_url,
    })
}

#[tauri::command]
pub async fn auth_status() -> AuthStatus {
    let cfg = kotonia_cli::config::load();
    AuthStatus {
        logged_in: cfg.is_some(),
        server: cfg.as_ref().map(|c| c.server.clone()),
        device_id_prefix: cfg
            .as_ref()
            .map(|c| c.device_id.chars().take(8).collect::<String>()),
    }
}

fn login_server() -> String {
    kotonia_cli::config::load()
        .map(|c| c.server)
        .unwrap_or_else(|| "https://kotonia.ai".to_string())
}

#[derive(Serialize)]
pub struct LoginSession {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: i64,
    pub interval: u32,
}

/// Start the same device-code pairing flow as `kotonia-cli login`, but
/// driven from the GUI instead of a terminal — the point being that a
/// user who only ever installed kotonia-desktop (never touched the CLI)
/// can still log in.
#[tauri::command]
pub async fn start_login() -> Result<LoginSession, String> {
    let server = login_server();
    let session = kotonia_cli::login::create_device_code(&server).await?;
    Ok(LoginSession {
        device_code: session.device_code,
        user_code: session.user_code,
        verification_uri: session.verification_uri,
        expires_in: session.expires_in,
        interval: session.interval,
    })
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LoginPollResult {
    Pending,
    Approved { device_id_prefix: String },
}

/// One poll tick, called on a timer by the frontend (mirrors
/// `kotonia_cli::login::run`'s blocking loop, just inverted so the caller
/// controls the cadence). On approval, persists the pairing and — so the
/// *currently running* process picks it up without a restart — sets the
/// same env vars `main()` sets once at startup from the on-disk config.
#[tauri::command]
pub async fn poll_login(device_code: String) -> Result<LoginPollResult, String> {
    let server = login_server();
    match kotonia_cli::login::poll_once(&server, &device_code).await? {
        kotonia_cli::login::PollOutcome::Pending => Ok(LoginPollResult::Pending),
        kotonia_cli::login::PollOutcome::Approved {
            device_id,
            device_token,
        } => {
            kotonia_cli::login::save_pairing(&server, device_id.clone(), device_token.clone())?;
            std::env::set_var("KOTONIA_API_KEY", &device_token);
            std::env::set_var("KOTONIA_API_BASE", &server);
            Ok(LoginPollResult::Approved {
                device_id_prefix: device_id.chars().take(8).collect(),
            })
        }
    }
}

#[tauri::command]
pub fn new_session() -> String {
    format!(
        "s_{}_{}",
        chrono::Utc::now().timestamp_millis(),
        &uuid::Uuid::new_v4().to_string()[..8]
    )
}

#[derive(Serialize)]
pub struct SubmitTaskResponse {
    pub task_id: String,
    pub session_id: String,
}

#[tauri::command]
pub async fn submit_task(
    app: AppHandle,
    state: State<'_, AppState>,
    prompt: String,
    session_id: String,
    model: Option<String>,
    engine: Option<String>,
    workspace_path: Option<String>,
) -> Result<SubmitTaskResponse, String> {
    let choice = resolve_engine(engine.as_deref(), model.as_deref())?;

    // The hosted ReAct path needs a paired device_token. Claude Code runs
    // entirely against the local `claude` binary, so the kotonia.ai login
    // gate doesn't apply.
    if matches!(choice, EngineChoice::ReAct) && kotonia_cli::config::load().is_none() {
        return Err(
            "not logged in. Use the login button in the header.".to_string(),
        );
    }

    let workspace_root = resolve_workspace(workspace_path.as_deref())?;
    let session = get_or_create_session(
        &state,
        &session_id,
        model.as_deref(),
        choice,
        workspace_root,
    )
    .await?;
    let task_id = uuid::Uuid::new_v4().to_string();

    let pending = state.pending_approvals.clone();
    let app_for_spawn = app.clone();
    let task_id_for_spawn = task_id.clone();

    let work = tokio::spawn(async move {
        let mut sink = TauriEventSink {
            app: app_for_spawn.clone(),
            task_id: task_id_for_spawn.clone(),
        };
        let mut approval = TauriApprovalHandler {
            app: app_for_spawn.clone(),
            task_id: task_id_for_spawn.clone(),
            pending,
        };

        let mut guard = session.lock().await;
        let result = guard.agent.run_turn(&prompt, &mut approval, &mut sink).await;

        if let Err(e) = result {
            let _ = app_for_spawn.emit(
                "agent_event",
                serde_json::json!({
                    "task_id": task_id_for_spawn,
                    "event": { "kind": "error", "message": e.to_string() },
                }),
            );
        }
    });

    // Register the abort handle for cancel_task; clean up on natural
    // completion via a sibling task that just awaits the join. If the
    // task is aborted, the await resolves to Err(JoinError) and we
    // still drop the map entry.
    let abort = work.abort_handle();
    state
        .running_tasks
        .lock()
        .unwrap()
        .insert(task_id.clone(), abort);
    let running_for_cleanup = state.running_tasks.clone();
    let task_id_for_cleanup = task_id.clone();
    tokio::spawn(async move {
        let _ = work.await;
        running_for_cleanup
            .lock()
            .unwrap()
            .remove(&task_id_for_cleanup);
    });

    Ok(SubmitTaskResponse {
        task_id,
        session_id,
    })
}

#[tauri::command]
pub async fn cancel_task(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<bool, String> {
    let removed = state.running_tasks.lock().unwrap().remove(&task_id);
    match removed {
        Some(handle) => {
            handle.abort();
            Ok(true)
        }
        // Not an error — the task likely already finished between the
        // user clicking and this command landing. Frontend treats `false`
        // as "no-op, UI already settled."
        None => Ok(false),
    }
}

#[tauri::command]
pub async fn respond_approval(
    state: State<'_, AppState>,
    approval_id: String,
    approved: bool,
) -> Result<(), String> {
    let mut pending = state.pending_approvals.lock().unwrap();
    if let Some(tx) = pending.remove(&approval_id) {
        let _ = tx.send(approved);
        Ok(())
    } else {
        Err(format!("no pending approval for id {approval_id}"))
    }
}

/// Transcribe a WAV recording (base64 encoded) via kotonia.ai's STT
/// endpoint and return the recognized text. Used by the dictation UX:
/// the WebView records mic → encodes WAV → calls this command → drops
/// the returned text into the prompt textarea for the user to review.
#[tauri::command]
pub async fn stt_transcribe(wav_base64: String) -> Result<crate::stt::TranscribeResult, String> {
    crate::stt::transcribe(wav_base64).await
}

/// Speak `text` with Iris's voice **plus** Ditto lip-sync video.
/// Same `stream_id` correlation as `tts_speak`; the frontend swaps
/// the static avatar image for the JPEG frame stream as `ditto_frame`
/// events arrive. Audio still flows through the `tts_chunk` event,
/// but with the explicit warning that the JS side should *buffer*
/// audio until the first `ditto_frame` lands so face + voice start
/// together (frame generation is slower than audio synthesis).
#[tauri::command]
pub async fn ditto_speak(app: AppHandle, text: String) -> Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("空文字は読めません".into());
    }
    let stream_id = uuid::Uuid::new_v4().to_string();
    let text_owned = trimmed.to_string();
    let stream_for_task = stream_id.clone();
    let app_for_task = app.clone();
    tokio::spawn(async move {
        crate::ditto::run_stream(
            app_for_task,
            stream_for_task,
            text_owned,
            &crate::persona::IRIS,
        )
        .await;
    });
    Ok(stream_id)
}

/// Speak text in Iris's voice. Returns the `stream_id` immediately so
/// the frontend can correlate the streamed `tts_chunk` / `tts_done` /
/// `tts_error` events to this call (and ignore any in-flight events
/// from a previous, now-cancelled stream).
#[tauri::command]
pub async fn tts_speak(app: AppHandle, text: String) -> Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("空文字は読めません".into());
    }
    let stream_id = uuid::Uuid::new_v4().to_string();
    let text_owned = trimmed.to_string();
    let stream_for_task = stream_id.clone();
    let app_for_task = app.clone();
    tokio::spawn(async move {
        crate::tts::run_stream(
            app_for_task,
            stream_for_task,
            text_owned,
            &crate::persona::IRIS.voice,
        )
        .await;
    });
    Ok(stream_id)
}

/// Open a URL in the system's default browser. Used by the login flow to
/// hand off the device-code approval step (`verification_uri` from
/// `start_login`) to a real, already-logged-in browser tab.
#[tauri::command]
pub async fn open_login_help(app: AppHandle, url: Option<String>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url.as_deref().unwrap_or("https://kotonia.ai/agent/pair"), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Open a filesystem path with the OS default application. Used by the
/// Ctrl/Cmd+click handler in the log pane: the agent's observation /
/// final-answer / bash-command text is scanned for path-shaped tokens,
/// rendered as clickable spans, and resolved through here on activation.
///
/// Relative paths (`./foo.png`, `foo.png`, `../bar`) are resolved against
/// the caller-supplied `workspace_path` — the agent's cwd for the active
/// session, NOT the desktop process's cwd, which is wherever Tauri was
/// launched from and unrelated to where the agent wrote files. Mirrors
/// the resolution policy of `resolve_preview_path` so Ctrl+click and the
/// ▶ preview button agree on what `./foo.png` means.
///
/// Rejects empty paths and paths the FS can't see. Anything else is handed
/// to the opener plugin (xdg-open / open / start) — symlinks resolve there.
#[tauri::command]
pub async fn open_path(
    app: AppHandle,
    path: String,
    workspace_path: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("empty path".into());
    }
    let expanded = expand_tilde(trimmed);
    let path_obj = std::path::Path::new(&expanded);
    let absolute = if path_obj.is_absolute() {
        path_obj.to_path_buf()
    } else {
        let ws = resolve_workspace(workspace_path.as_deref())?;
        ws.join(path_obj)
    };
    if !absolute.exists() {
        return Err(format!("path does not exist: {}", absolute.display()));
    }
    app.opener()
        .open_path(absolute.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| e.to_string())
}

fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

/// Resolve a path the way the iframe preview needs it: absolute,
/// canonical, existence-checked, and inside the asset-protocol scope.
///
/// Accepts:
///   - absolute `/foo/bar.html`
///   - tilde   `~/foo/bar.html`
///   - relative `./foo.html` / `../foo.html` / bare `foo.html`
///     → resolved against the caller-supplied `workspace_path` (the agent's
///       cwd for the active session), falling back to the default sandbox.
///
/// Fails (returns a user-facing Japanese error) if the resulting path
/// doesn't exist, isn't a file, or isn't under the scope whitelist
/// configured in `tauri.conf.json:assetProtocol.scope`.
#[tauri::command]
pub async fn resolve_preview_path(
    path: String,
    workspace_path: Option<String>,
) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("空のパスです".into());
    }

    // 1. Expand tilde and resolve relative paths against the workspace.
    let raw = expand_tilde(trimmed);
    let path_obj = std::path::Path::new(&raw);
    let absolute = if path_obj.is_absolute() {
        path_obj.to_path_buf()
    } else {
        let ws = resolve_workspace(workspace_path.as_deref())?;
        ws.join(path_obj)
    };

    // 2. Canonicalize (resolves `.`, `..`, symlinks). If the file is
    //    missing, this fails with a clear OS error.
    let canonical = std::fs::canonicalize(&absolute).map_err(|e| {
        format!(
            "ファイルが見つかりません: {} ({e})",
            absolute.display()
        )
    })?;

    // 3. Must be a regular file (no dir / device).
    let meta = std::fs::metadata(&canonical).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(format!(
            "ファイルじゃない (dir or special): {}",
            canonical.display()
        ));
    }

    // 4. Must be inside one of the asset-protocol scope roots. Keep this
    //    in sync with `tauri.conf.json:assetProtocol.scope` — both were
    //    widened from the fixed sandbox to `$HOME` + `/tmp` when the
    //    workspace picker landed so previews of arbitrary user-owned
    //    project trees still resolve.
    let allowed_roots: Vec<std::path::PathBuf> = {
        let mut v = Vec::new();
        if let Some(home_path) = dirs::home_dir() {
            if let Ok(c) = std::fs::canonicalize(&home_path) {
                v.push(c);
            } else {
                v.push(home_path);
            }
        }
        v.push(std::path::PathBuf::from("/tmp"));
        v
    };
    let in_scope = allowed_roots.iter().any(|root| canonical.starts_with(root));
    if !in_scope {
        let roots = allowed_roots
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(" / ");
        return Err(format!(
            "scope 外: {} (許可: {roots})",
            canonical.display()
        ));
    }

    Ok(canonical.to_string_lossy().to_string())
}

async fn get_or_create_session(
    state: &State<'_, AppState>,
    session_id: &str,
    model_override: Option<&str>,
    engine: EngineChoice,
    workspace_root: PathBuf,
) -> Result<Arc<AsyncMutex<SessionState>>, String> {
    {
        let map = state.sessions.read().await;
        if let Some(s) = map.get(session_id) {
            return Ok(s.clone());
        }
    }

    let workspace = AgentWorkspace::in_place(workspace_root);

    let mut agent = match engine {
        EngineChoice::ReAct => {
            let model = model_override.unwrap_or(DEFAULT_MODEL);
            let provider = Provider::resolve(None, model)
                .map_err(|e| format!("provider `{model}`: {e}"))?;
            let mut agent_config = AgentConfig::new(ApprovalMode::Allowlist, /*in_place=*/ true);
            // Default-equip the kotonia.ai /api/v1 capability. The agent's
            // bash subprocess inherits KOTONIA_API_KEY (set at desktop
            // startup from the paired device_token in main.rs), so the
            // curl examples appended by `kotonia_api_section_native` in
            // crates/kotonia-cli/src/agent/prompt.rs just work.
            agent_config.kotonia_api_base = kotonia_cli::config::load().map(|c| c.server);
            // Iris persona: prepended to the agent's tool-aware base prompt so
            // the model speaks in character while keeping all the bash / tool
            // semantics intact. See `persona::IRIS` for the prompt and the rest
            // of the character definition.
            agent_config.persona_prefix = Some(crate::persona::IRIS.system_prompt.to_string());
            DispatchAgent::ReAct(Agent::new(&workspace.root, provider, agent_config))
        }
        EngineChoice::ClaudeCode => {
            // Claude Code's `--session-id` flag requires a real UUID; the
            // host's `s_<millis>_<8hex>` ids don't qualify. Derive a stable
            // UUID v5 so subsequent `--resume` against the host id keeps
            // threading context. Persona is intentionally NOT prepended:
            // Claude Code owns its own system prompt + tool catalog, and
            // sneaking Iris's prompt in front would only confuse the
            // subprocess. The Iris voice / avatar still wrap the output on
            // the desktop side.
            let cc_session = claude_code_session_id(session_id);
            DispatchAgent::ClaudeCode(ClaudeCodeAgent::new(
                &workspace.root,
                cc_session,
                /*in_place=*/ true,
            ))
        }
    };

    match HistoryStore::open(session_id) {
        Ok(mut store) => {
            let prior = load_session_messages(session_id).unwrap_or_default();
            let resuming = !prior.is_empty();
            if !resuming {
                let _ = store.write_header(
                    agent.model_id(),
                    agent.backend_label(),
                    "allowlist",
                    &workspace.root,
                    true,
                );
            }
            agent = agent.with_history(store);
            if resuming {
                agent.seed_messages(prior);
            } else {
                agent.log_initial_system();
            }
        }
        Err(_) => {
            // History persistence is best-effort. Run without it.
        }
    }

    let session = Arc::new(AsyncMutex::new(SessionState { agent, workspace }));
    let mut map = state.sessions.write().await;
    if let Some(existing) = map.get(session_id) {
        return Ok(existing.clone());
    }
    map.insert(session_id.to_string(), session.clone());
    Ok(session)
}
