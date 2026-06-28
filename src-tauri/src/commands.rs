use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex as AsyncMutex;

use kotonia_cli::agent::agent::{Agent, AgentConfig};
use kotonia_cli::agent::approval::ApprovalMode;
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

/// Sandbox workspace under the user's home. Created on first use. T1 will
/// surface a directory picker so the operator can point the agent at a
/// real project tree.
fn default_workspace_root() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME is not set".to_string())?;
    let root = PathBuf::from(home).join(".kotonia").join("desktop").join("workspace");
    std::fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;
    Ok(root)
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
) -> Result<SubmitTaskResponse, String> {
    if kotonia_cli::config::load().is_none() {
        return Err(
            "not logged in. Run `kotonia-cli login` in a terminal, then restart the app."
                .to_string(),
        );
    }

    let session = get_or_create_session(&state, &session_id, model.as_deref()).await?;
    let task_id = uuid::Uuid::new_v4().to_string();

    let pending = state.pending_approvals.clone();
    let app_for_spawn = app.clone();
    let task_id_for_spawn = task_id.clone();

    tokio::spawn(async move {
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

    Ok(SubmitTaskResponse {
        task_id,
        session_id,
    })
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

#[tauri::command]
pub async fn open_login_help(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url("https://kotonia.ai/agent/pair", None::<&str>)
        .map_err(|e| e.to_string())
}

/// Open a filesystem path with the OS default application. Used by the
/// Ctrl/Cmd+click handler in the log pane: the agent's observation /
/// final-answer / bash-command text is scanned for path-shaped tokens,
/// rendered as clickable spans, and resolved through here on activation.
///
/// Rejects empty paths and paths the FS can't see. Anything else is handed
/// to the opener plugin (xdg-open / open / start) — symlinks resolve there.
#[tauri::command]
pub async fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("empty path".into());
    }
    let expanded = expand_tilde(trimmed);
    if !std::path::Path::new(&expanded).exists() {
        return Err(format!("path does not exist: {expanded}"));
    }
    app.opener()
        .open_path(expanded, None::<&str>)
        .map_err(|e| e.to_string())
}

fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return format!("{}/{}", home.to_string_lossy(), rest);
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
///     → resolved against the agent's workspace (`~/.kotonia/desktop/workspace`),
///       since that's the agent's `in_place` cwd.
///
/// Fails (returns a user-facing Japanese error) if the resulting path
/// doesn't exist, isn't a file, or isn't under the scope whitelist
/// configured in `tauri.conf.json:assetProtocol.scope`.
#[tauri::command]
pub async fn resolve_preview_path(path: String) -> Result<String, String> {
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
        let ws = default_workspace_root()?;
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
    //    in sync with `tauri.conf.json:assetProtocol.scope`.
    let allowed_roots: Vec<std::path::PathBuf> = {
        let mut v = Vec::new();
        if let Ok(ws) = default_workspace_root() {
            if let Ok(c) = std::fs::canonicalize(&ws) {
                v.push(c);
            } else {
                v.push(ws);
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
) -> Result<Arc<AsyncMutex<SessionState>>, String> {
    {
        let map = state.sessions.read().await;
        if let Some(s) = map.get(session_id) {
            return Ok(s.clone());
        }
    }

    let model = model_override.unwrap_or(DEFAULT_MODEL);
    let workspace_root = default_workspace_root()?;
    let workspace = AgentWorkspace::in_place(workspace_root);

    let provider = Provider::resolve(None, model)
        .map_err(|e| format!("provider `{model}`: {e}"))?;
    let mut agent_config = AgentConfig::new(ApprovalMode::Allowlist, /*in_place=*/ true);
    agent_config.kotonia_api_base = None;
    // Iris persona: prepended to the agent's tool-aware base prompt so
    // the model speaks in character while keeping all the bash / tool
    // semantics intact. See `persona::IRIS` for the prompt and the rest
    // of the character definition.
    agent_config.persona_prefix = Some(crate::persona::IRIS.system_prompt.to_string());
    let mut agent = DispatchAgent::ReAct(Agent::new(&workspace.root, provider, agent_config));

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
