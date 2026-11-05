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
use crate::speech::VoiceConfig;
use crate::state::{AppState, RunningTask, SessionState};
use crate::{history, speech};
use kotonia_cli::home::workspace::HomeDir;

/// Default model alias. Resolves through kotonia-cli's provider registry to
/// the hosted `/api/v1/chat/completions` endpoint, authenticating with the
/// device_token from `~/.kotonia/daemon.json`.
const DEFAULT_MODEL: &str = "kotonia-llm-basic";

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
    let canonical = fs_canonicalize(&candidate)
        .map_err(|e| format!("workspace not accessible: {expanded} ({e})"))?;
    if !canonical.is_dir() {
        return Err(format!(
            "workspace is not a directory: {}",
            canonical.display()
        ));
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
/// can render Eve's name + avatar without hardcoding strings on both
/// sides of the IPC boundary.
#[tauri::command]
pub fn persona_info() -> serde_json::Value {
    serde_json::json!({
        "key": crate::persona::EVE.key,
        "display_name": crate::persona::EVE.display_name,
        "tagline": crate::persona::EVE.tagline,
        "avatar_url": crate::persona::EVE.avatar_url,
        // The profile editor pre-fills the default and offers Eve as a preset.
        "default_system_prompt": crate::persona::DEFAULT_SYSTEM_PROMPT,
        "eve_persona": crate::persona::EVE_PERSONA,
        "default_voice": VoiceConfig::default(),
    })
}

#[derive(Debug, PartialEq, Eq)]
enum DeviceAuthValidation {
    Valid,
    Invalid,
    Unavailable,
}

fn classify_device_auth_status(status: reqwest::StatusCode) -> DeviceAuthValidation {
    if status.is_success() {
        DeviceAuthValidation::Valid
    } else if matches!(
        status,
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
    ) {
        DeviceAuthValidation::Invalid
    } else {
        DeviceAuthValidation::Unavailable
    }
}

async fn validate_device_auth(
    cfg: &kotonia_cli::config::DaemonStoredConfig,
) -> DeviceAuthValidation {
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    else {
        return DeviceAuthValidation::Unavailable;
    };
    let url = format!(
        "{}/api/agent-runtime/auth-status/{}",
        cfg.server.trim_end_matches('/'),
        cfg.device_id
    );
    match client.get(url).bearer_auth(&cfg.device_token).send().await {
        Ok(response) => classify_device_auth_status(response.status()),
        Err(error) => {
            eprintln!("[auth] validation unavailable: {error}");
            DeviceAuthValidation::Unavailable
        }
    }
}

/// Validate the stored device token against the dedicated, non-rotating
/// server endpoint. A definitive 401/403 updates the login UI immediately;
/// transient network/server failures preserve the last known state so
/// starting Desktop offline does not look like a logout.
#[tauri::command]
pub async fn auth_status(state: State<'_, AppState>) -> Result<AuthStatus, String> {
    let Some(cfg) = kotonia_cli::config::load() else {
        state
            .auth_invalid
            .store(false, std::sync::atomic::Ordering::Relaxed);
        return Ok(AuthStatus {
            logged_in: false,
            server: None,
            device_id_prefix: None,
        });
    };

    match validate_device_auth(&cfg).await {
        DeviceAuthValidation::Valid => state
            .auth_invalid
            .store(false, std::sync::atomic::Ordering::Relaxed),
        DeviceAuthValidation::Invalid => state
            .auth_invalid
            .store(true, std::sync::atomic::Ordering::Relaxed),
        DeviceAuthValidation::Unavailable => {}
    }
    let invalid = state
        .auth_invalid
        .load(std::sync::atomic::Ordering::Relaxed);
    Ok(AuthStatus {
        logged_in: !invalid,
        server: Some(cfg.server),
        device_id_prefix: Some(cfg.device_id.chars().take(8).collect()),
    })
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
pub async fn poll_login(
    state: State<'_, AppState>,
    device_code: String,
) -> Result<LoginPollResult, String> {
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
            state
                .auth_invalid
                .store(false, std::sync::atomic::Ordering::Relaxed);
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

#[tauri::command]
pub async fn list_sessions() -> Result<Vec<history::SessionSummary>, String> {
    tokio::task::spawn_blocking(history::list)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_session(session_id: String) -> Result<history::Session, String> {
    tokio::task::spawn_blocking(move || history::load(&session_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn export_session(session_id: String, output_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let session = history::load(&session_id)?;
        std::fs::write(output_path, history::markdown(&session)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn validate_voice(voice: VoiceConfig) -> Result<VoiceConfig, String> {
    voice.validate()?;
    Ok(voice)
}

#[tauri::command]
pub fn save_session_preferences(
    session_id: String,
    profile: history::Profile,
    voice: VoiceConfig,
) -> Result<(), String> {
    history::save_preferences(&session_id, profile, voice)
}

#[derive(Serialize)]
pub struct PreparedSpeech {
    plan: speech::SpeechPlan,
    chunks: Vec<String>,
}

#[tauri::command]
pub fn prepare_speech(text: String, voice: VoiceConfig) -> Result<PreparedSpeech, String> {
    let plan = speech::plan(&text, &voice)?;
    let chunks = speech::split_text(&plan.text);
    Ok(PreparedSpeech { plan, chunks })
}

#[tauri::command]
pub fn cancel_speech(state: State<'_, AppState>, stream_id: Option<String>) -> Result<(), String> {
    state
        .speech_tasks
        .lock()
        .map_err(|e| e.to_string())?
        .cancel(stream_id);
    Ok(())
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
    system_prompt: Option<String>,
    persona: Option<String>,
    home: Option<bool>,
    desktop_profile: Option<history::Profile>,
    voice: Option<VoiceConfig>,
    task_id: Option<String>,
) -> Result<SubmitTaskResponse, String> {
    history::validate_id(&session_id)?;
    let voice = voice.unwrap_or_default();
    voice.validate()?;
    if let Some(task_id) = &task_id {
        uuid::Uuid::parse_str(task_id).map_err(|_| "タスクIDが不正です")?;
    }
    let choice = resolve_engine(engine.as_deref(), model.as_deref())?;

    // The hosted ReAct path needs a paired device_token. Claude Code runs
    // entirely against the local `claude` binary, so the kotonia.ai login
    // gate doesn't apply.
    let auth_invalid = state
        .auth_invalid
        .load(std::sync::atomic::Ordering::Relaxed);
    if matches!(choice, EngineChoice::ReAct)
        && (kotonia_cli::config::load().is_none() || auth_invalid)
    {
        return Err("not logged in. Use the login button in the header.".to_string());
    }

    let workspace_root = resolve_workspace(workspace_path.as_deref())?;
    let context = history::SessionContext {
        workspace: workspace_root.display().to_string(),
        engine: if choice == EngineChoice::ClaudeCode {
            "claude-code"
        } else {
            "react"
        }
        .into(),
        model: model.clone().unwrap_or_else(|| {
            if choice == EngineChoice::ClaudeCode {
                "claude-code"
            } else {
                DEFAULT_MODEL
            }
            .into()
        }),
        profile: desktop_profile,
        voice: voice.clone(),
        home: home.unwrap_or(false),
    };
    let session = get_or_create_session(
        &state,
        &session_id,
        model.as_deref(),
        choice,
        workspace_root,
        session_prompt(system_prompt.as_deref(), persona.as_deref()),
        home.unwrap_or(false),
    )
    .await?;
    history::begin_turn(&session_id, context, &prompt)?;
    let task_id = task_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    // start/end per task, like one kotonia-cli run (labels only, never the
    // prompt). Before this the desktop sent none: the CLI sends them from its
    // main(), which the desktop does not go through.
    let run = kotonia_cli::telemetry::Run::begin(
        match choice {
            EngineChoice::ReAct => "react",
            EngineChoice::ClaudeCode => "claude-code",
        },
        model.as_deref().unwrap_or(DEFAULT_MODEL),
        "desktop",
    );

    let pending = state.pending_approvals.clone();
    let pending_connectors = state.pending_connectors.clone();
    let pending_sites = state.pending_sites.clone();
    let app_for_spawn = app.clone();
    let task_id_for_spawn = task_id.clone();
    let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let cancelled_for_spawn = cancelled.clone();
    let history_session_id = session_id.clone();

    let work = tokio::spawn(async move {
        let mut sink = TauriEventSink {
            app: app_for_spawn.clone(),
            task_id: task_id_for_spawn.clone(),
            session_id: history_session_id,
            voice,
            streamed_text: String::new(),
        };
        let mut approval = TauriApprovalHandler {
            app: app_for_spawn.clone(),
            task_id: task_id_for_spawn.clone(),
            pending,
            pending_connectors,
            pending_sites,
            cancelled: cancelled_for_spawn,
        };

        let mut guard = session.lock().await;
        let result = guard
            .agent
            .run_turn(&prompt, &mut approval, &mut sink)
            .await;
        drop(guard);

        if let Some(run) = &run {
            if let Err(e) = &result {
                run.fail(kotonia_cli::telemetry::failure_kind(e));
            }
            run.finish(result.is_ok()).await;
        }

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
        .insert(task_id.clone(), RunningTask { abort, cancelled });
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

/// The ReAct session prompt: the user's system prompt (or the plain default),
/// the user's optional persona, then the app's fixed conventions. The
/// conventions always come last so a rewritten prompt cannot drop them.
fn session_prompt(system_prompt: Option<&str>, persona: Option<&str>) -> String {
    let system = system_prompt
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(crate::persona::DEFAULT_SYSTEM_PROMPT);
    let persona = persona.map(str::trim).filter(|value| !value.is_empty());
    [Some(system), persona, Some(crate::persona::APP_CONTRACT)]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod profile_tests {
    use super::session_prompt;
    use crate::persona::{APP_CONTRACT, DEFAULT_SYSTEM_PROMPT};

    #[test]
    fn empty_profile_uses_the_plain_default() {
        let prompt = session_prompt(Some("  "), None);
        assert!(prompt.starts_with(DEFAULT_SYSTEM_PROMPT));
        assert!(prompt.ends_with(APP_CONTRACT));
    }

    #[test]
    fn a_rewritten_prompt_keeps_the_app_conventions() {
        let prompt = session_prompt(Some("  my rules  "), Some("persona"));
        assert_eq!(prompt, format!("my rules\n\npersona\n\n{APP_CONTRACT}"));
        assert!(!prompt.contains(DEFAULT_SYSTEM_PROMPT));
        assert!(prompt.contains("Speech blocks are BOTH displayed and read aloud"));
    }
}

#[tauri::command]
pub async fn close_browser(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let session = state.sessions.read().await.get(&session_id).cloned();
    if let Some(session) = session {
        let mut guard = session.lock().await;
        if let DispatchAgent::ReAct(agent) = &mut guard.agent {
            agent.close_browser().await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn cancel_task(state: State<'_, AppState>, task_id: String) -> Result<bool, String> {
    let removed = state.running_tasks.lock().unwrap().remove(&task_id);
    match removed {
        Some(handle) => {
            handle
                .cancelled
                .store(true, std::sync::atomic::Ordering::SeqCst);
            handle.abort.abort();
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

/// Start a cancellable utterance. The frontend chooses its stream ID before
/// invoking so even the first chunk/error can be correlated without a race.
async fn launch_speech(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
    instruct: Option<String>,
    voice: Option<VoiceConfig>,
    stream_id: String,
    avatar: Option<(String, Option<String>)>,
) -> Result<String, String> {
    uuid::Uuid::parse_str(&stream_id).map_err(|_| "音声ストリームIDが不正です")?;
    let voice = voice.unwrap_or_default();
    let prepared = speech::plan(&text, &voice)?;
    if prepared.text.chars().count() > 4000 {
        return Err("音声は4000文字以内の区間に分割してください".into());
    }
    let tasks = state.speech_tasks.clone();
    let mut registry = tasks.lock().map_err(|e| e.to_string())?;
    if registry.was_cancelled(&stream_id) {
        return Err("音声を停止しました".into());
    }
    let stream_for_task = stream_id.clone();
    let work = tokio::spawn(async move {
        if let Some((avatar_id, avatar_path)) = avatar {
            if let Some(path) = avatar_path.filter(|s| !s.trim().is_empty()) {
                if let Err(error) = crate::ditto::register_avatar_file(&avatar_id, &path).await {
                    let _ = app.emit(
                        "tts_error",
                        serde_json::json!({"stream_id": stream_for_task, "message": error}),
                    );
                    return;
                }
            }
            crate::ditto::run_stream(
                app,
                stream_for_task,
                prepared.text,
                instruct,
                avatar_id,
                voice,
            )
            .await;
        } else {
            crate::tts::run_stream(app, stream_for_task, prepared.text, instruct, voice).await;
        }
    });
    registry
        .running
        .insert(stream_id.clone(), work.abort_handle());
    drop(registry);
    let cleanup_id = stream_id.clone();
    tokio::spawn(async move {
        let _ = work.await;
        if let Ok(mut tasks) = tasks.lock() {
            tasks.running.remove(&cleanup_id);
        }
    });
    Ok(stream_id)
}

#[tauri::command]
pub async fn ditto_speak(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
    instruct: Option<String>,
    avatar_id: Option<String>,
    avatar_path: Option<String>,
    voice: Option<VoiceConfig>,
    stream_id: String,
) -> Result<String, String> {
    let avatar_id = avatar_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| crate::persona::EVE.avatar_id.to_string());
    launch_speech(
        app,
        state,
        text,
        instruct,
        voice,
        stream_id,
        Some((avatar_id, avatar_path)),
    )
    .await
}

/// Speak with the resolved runtime voice. Returns the `stream_id` so
/// the frontend can correlate the streamed `tts_chunk` / `tts_done` /
/// `tts_error` events to this call (and ignore any in-flight events
/// from a previous, now-cancelled stream).
#[tauri::command]
pub async fn tts_speak(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
    instruct: Option<String>,
    voice: Option<VoiceConfig>,
    stream_id: String,
) -> Result<String, String> {
    launch_speech(app, state, text, instruct, voice, stream_id, None).await
}

/// Open a URL in the system's default browser. Used by the login flow to
/// hand off the device-code approval step (`verification_uri` from
/// `start_login`) to a real, already-logged-in browser tab.
#[derive(Serialize)]
pub struct ShellInfo {
    pub os: &'static str,
    /// `bash`, `busybox` (no Git for Windows; the bundled fallback) or None.
    pub shell: Option<&'static str>,
}

#[tauri::command]
pub async fn shell_info() -> ShellInfo {
    ShellInfo {
        os: std::env::consts::OS,
        shell: kotonia_cli::execution::host::shell_kind(),
    }
}

#[tauri::command]
pub async fn open_login_help(app: AppHandle, url: Option<String>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(
            url.as_deref().unwrap_or("https://kotonia.ai/agent/pair"),
            None::<&str>,
        )
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
    let expanded = translate_unix_drive_path(&expanded);
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
    // Windows users type `~\foo` as naturally as `~/foo`.
    #[cfg(windows)]
    if let Some(rest) = path.strip_prefix("~\\") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

/// `std::fs::canonicalize` on Windows returns `\\?\C:\...` verbatim paths,
/// which break path display and the `$HOME/**` asset-protocol scope glob.
/// `dunce::canonicalize` strips the prefix whenever the path is
/// representable without it. Unix keeps the std call — identical behavior.
#[cfg(windows)]
use dunce::canonicalize as fs_canonicalize;
#[cfg(not(windows))]
use std::fs::canonicalize as fs_canonicalize;

/// Git Bash prints win32 paths as `/c/Users/...` and WSL as
/// `/mnt/c/Users/...`, so agent observations contain unix-style tokens the
/// Windows FS can't see. Map the drive-letter forms back (`C:\Users\...`)
/// so Ctrl+click and the HTML preview still resolve. Anything that doesn't
/// look like a drive path passes through untouched; on mac/linux this is
/// the identity.
#[cfg(windows)]
fn translate_unix_drive_path(path: &str) -> String {
    let rest = path
        .strip_prefix("/mnt/")
        .or_else(|| path.strip_prefix('/'));
    if let Some(rest) = rest {
        let (drive, tail) = rest.split_once('/').unwrap_or((rest, ""));
        if drive.len() == 1 && drive.as_bytes()[0].is_ascii_alphabetic() {
            return format!(
                "{}:\\{}",
                drive.to_ascii_uppercase(),
                tail.replace('/', "\\")
            );
        }
    }
    path.to_string()
}

#[cfg(not(windows))]
fn translate_unix_drive_path(path: &str) -> String {
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
    let raw = translate_unix_drive_path(&raw);
    let path_obj = std::path::Path::new(&raw);
    let absolute = if path_obj.is_absolute() {
        path_obj.to_path_buf()
    } else {
        let ws = resolve_workspace(workspace_path.as_deref())?;
        ws.join(path_obj)
    };

    // 2. Canonicalize (resolves `.`, `..`, symlinks). If the file is
    //    missing, this fails with a clear OS error.
    let canonical = fs_canonicalize(&absolute)
        .map_err(|e| format!("ファイルが見つかりません: {} ({e})", absolute.display()))?;

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
    //    widened from the fixed sandbox to `$HOME` + temp dirs when the
    //    workspace picker landed so previews of arbitrary user-owned
    //    project trees still resolve. The Tauri scope also sets
    //    `requireLiteralLeadingDot = false`; otherwise `$HOME/**` rejects
    //    files under hidden dirs like `~/.kotonia/...` with a protocol 403.
    let allowed_roots: Vec<std::path::PathBuf> = {
        let mut v = Vec::new();
        if let Some(home_path) = dirs::home_dir() {
            if let Ok(c) = fs_canonicalize(&home_path) {
                v.push(c);
            } else {
                v.push(home_path);
            }
        }
        let temp_path = std::env::temp_dir();
        if let Ok(c) = fs_canonicalize(&temp_path) {
            v.push(c);
        } else {
            v.push(temp_path);
        }
        let slash_tmp = std::path::PathBuf::from("/tmp");
        if let Ok(c) = fs_canonicalize(&slash_tmp) {
            v.push(c);
        } else {
            v.push(slash_tmp);
        }
        v
    };
    let in_scope = allowed_roots.iter().any(|root| canonical.starts_with(root));
    if !in_scope {
        let roots = allowed_roots
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(" / ");
        return Err(format!("scope 外: {} (許可: {roots})", canonical.display()));
    }

    Ok(canonical.to_string_lossy().to_string())
}

async fn get_or_create_session(
    state: &State<'_, AppState>,
    session_id: &str,
    model_override: Option<&str>,
    engine: EngineChoice,
    workspace_root: PathBuf,
    profile_prompt: String,
    home: bool,
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
            let provider =
                Provider::resolve(None, model).map_err(|e| format!("provider `{model}`: {e}"))?;
            let mut agent_config =
                AgentConfig::new(ApprovalMode::Allowlist, /*in_place=*/ true);
            // Default-equip the kotonia.ai /api/v1 capability. The agent's
            // bash subprocess inherits KOTONIA_API_KEY (set at desktop
            // startup from the paired device_token in main.rs), so the
            // curl examples appended by `kotonia_api_section_native` in
            // crates/kotonia-cli/src/agent/prompt.rs just work.
            agent_config.kotonia_api_base = kotonia_cli::config::load().map(|c| c.server);
            // User prompt + persona + app conventions (`session_prompt`),
            // prepended to the agent's tool-aware base prompt so the bash /
            // tool semantics stay intact.
            agent_config.persona_prefix = Some(profile_prompt);
            if home {
                // Home mode = kotonia-cli's `--home`: the memory files and the
                // connectors section first (who you are, what you remember),
                // then the profile. Connector cards and the site prompt come
                // through TauriApprovalHandler.
                let dir = HomeDir::resolve()?;
                dir.ensure_initialized()?;
                let prefix = kotonia_cli::home::conversation_prefix(&dir);
                agent_config.persona_prefix = agent_config
                    .persona_prefix
                    .map(|p| format!("{prefix}\n\n{p}"));
                agent_config.connectors = true;
            }
            DispatchAgent::ReAct(Agent::new(&workspace.root, provider, agent_config))
        }
        EngineChoice::ClaudeCode => {
            // Claude Code's `--session-id` flag requires a real UUID; the
            // host's `s_<millis>_<8hex>` ids don't qualify. Derive a stable
            // UUID v5 so subsequent `--resume` against the host id keeps
            // threading context. Persona is intentionally NOT prepended:
            // Claude Code owns its own system prompt + tool catalog, and
            // sneaking Eve's prompt in front would only confuse the
            // subprocess. The Eve voice / avatar still wrap the output on
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

#[cfg(test)]
mod tests {
    use super::{classify_device_auth_status, DeviceAuthValidation};
    use reqwest::StatusCode;

    #[test]
    fn device_auth_status_distinguishes_rejection_from_outage() {
        assert_eq!(
            classify_device_auth_status(StatusCode::OK),
            DeviceAuthValidation::Valid
        );
        assert_eq!(
            classify_device_auth_status(StatusCode::UNAUTHORIZED),
            DeviceAuthValidation::Invalid
        );
        assert_eq!(
            classify_device_auth_status(StatusCode::FORBIDDEN),
            DeviceAuthValidation::Invalid
        );
        assert_eq!(
            classify_device_auth_status(StatusCode::INTERNAL_SERVER_ERROR),
            DeviceAuthValidation::Unavailable
        );
    }
}

// ── home mode (resident agent) ─────────────────────────────────────────

#[tauri::command]
pub async fn respond_connector(
    state: State<'_, AppState>,
    request_id: String,
    values: Option<std::collections::BTreeMap<String, String>>,
) -> Result<(), String> {
    let tx = state.pending_connectors.lock().unwrap().remove(&request_id);
    match tx {
        Some(tx) => {
            let _ = tx.send(values);
            Ok(())
        }
        None => Err(format!("no pending connector request {request_id}")),
    }
}

#[tauri::command]
pub async fn respond_site(
    state: State<'_, AppState>,
    request_id: String,
    decision: String,
) -> Result<(), String> {
    let tx = state.pending_sites.lock().unwrap().remove(&request_id);
    match tx {
        Some(tx) => {
            let _ = tx.send(decision);
            Ok(())
        }
        None => Err(format!("no pending site request {request_id}")),
    }
}

// ── this folder's memory (kotonia-cli `project`) ─────────────────────

#[derive(Serialize)]
pub struct MailAccount {
    pub id: String,
    pub email: String,
}

#[derive(Serialize)]
pub struct ProjectStatus {
    /// The folder the memory belongs to (a repo's main root, not a worktree).
    pub root: String,
    pub dir: String,
    pub memory: String,
    /// The home USER.md, shared by every folder.
    pub user: String,
    pub mail_allowed: Vec<String>,
    pub mail_accounts: Vec<MailAccount>,
}

fn project_for(
    workspace_path: Option<&str>,
) -> Result<kotonia_cli::project::ProjectMemory, String> {
    let root = resolve_workspace(workspace_path)?;
    kotonia_cli::project::ProjectMemory::resolve(&root)
}

#[tauri::command]
pub async fn project_status(workspace_path: Option<String>) -> Result<ProjectStatus, String> {
    let memory = project_for(workspace_path.as_deref())?;
    let user = HomeDir::resolve()?.read("USER.md").unwrap_or_default();
    let mail_accounts = kotonia_cli::connectors::Registry::load()
        .unwrap_or_default()
        .connectors
        .values()
        .filter_map(|c| match &c.kind {
            kotonia_cli::connectors::ConnectorKind::Imap { email, .. } => Some(MailAccount {
                id: c.id.clone(),
                email: email.clone(),
            }),
            _ => None,
        })
        .collect();
    Ok(ProjectStatus {
        root: memory.root().display().to_string(),
        dir: memory.dir().display().to_string(),
        memory: memory.read("MEMORY.md").unwrap_or_default(),
        user,
        mail_allowed: memory.mail_grants(),
        mail_accounts,
    })
}

/// Save what the user typed. People edit their own memory freely (no
/// length cap — the cap in the `memory` tool is for the agent). Files that
/// did not change are left alone.
#[tauri::command]
pub async fn project_save(
    workspace_path: Option<String>,
    memory: String,
    user: String,
) -> Result<(), String> {
    let project = project_for(workspace_path.as_deref())?;
    let write = |path: PathBuf, body: &str| -> Result<(), String> {
        let current = std::fs::read_to_string(&path).unwrap_or_default();
        if current.trim_end() == body.trim_end() {
            return Ok(());
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        let text = if body.trim().is_empty() {
            String::new()
        } else {
            format!("{}\n", body.trim_end())
        };
        std::fs::write(&path, text).map_err(|e| format!("write {}: {e}", path.display()))
    };
    write(project.dir().join("MEMORY.md"), &memory)?;
    project.note_root();
    write(HomeDir::resolve()?.path("USER.md"), &user)?;
    Ok(())
}

#[tauri::command]
pub async fn project_set_mail(
    workspace_path: Option<String>,
    connector: String,
    allow: bool,
) -> Result<Vec<String>, String> {
    let project = project_for(workspace_path.as_deref())?;
    project.set_mail_grant(&connector, allow)?;
    Ok(project.mail_grants())
}

#[derive(Serialize)]
pub struct HomeStatus {
    pub dir: String,
    /// Minutes, or `None` when the heartbeat is off.
    pub heartbeat_every_min: Option<i64>,
    pub next_due: Option<String>,
    pub active_hours: String,
    pub runner_running: bool,
    pub connectors: Vec<String>,
    pub web_sites: Vec<String>,
    pub feed: Vec<kotonia_cli::home::feed::FeedItem>,
}

#[tauri::command]
pub async fn home_status(state: State<'_, AppState>) -> Result<HomeStatus, String> {
    use kotonia_cli::home::schedule::{JobKind, Schedule};
    let dir = HomeDir::resolve()?;
    dir.ensure_initialized()?;
    let schedule = Schedule::load(dir.root())?;
    let hb = schedule.heartbeat();
    let hours = schedule.active_hours();
    let offset = kotonia_cli::home::schedule::local_offset_now();
    let runner_running = state
        .home_runner
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|h| !h.is_finished());
    Ok(HomeStatus {
        dir: dir.root().display().to_string(),
        heartbeat_every_min: hb.and_then(|j| match j.kind {
            JobKind::Heartbeat { every_secs } => Some(every_secs / 60),
            _ => None,
        }),
        next_due: hb.map(|j| {
            j.next_due
                .with_timezone(&offset)
                .format("%m-%d %H:%M")
                .to_string()
        }),
        active_hours: format!(
            "{}-{}",
            hours.start.format("%H:%M"),
            hours.end.format("%H:%M")
        ),
        runner_running,
        connectors: kotonia_cli::connectors::Registry::load()
            .unwrap_or_default()
            .prompt_lines(),
        web_sites: kotonia_cli::web_allow::WebAllow::load()
            .unwrap_or_default()
            .sites
            .keys()
            .cloned()
            .collect(),
        feed: kotonia_cli::home::feed::recent(&dir, 50),
    })
}

/// `minutes` = 0 turns the heartbeat off.
#[tauri::command]
pub async fn home_set_heartbeat(minutes: i64) -> Result<(), String> {
    use kotonia_cli::home::schedule::Schedule;
    let dir = HomeDir::resolve()?;
    dir.ensure_initialized()?;
    let mut s = Schedule::load(dir.root())?;
    if minutes <= 0 {
        s.clear_heartbeat();
    } else {
        s.set_heartbeat(minutes * 60, chrono::Utc::now());
    }
    s.save(dir.root())
}

/// Start the heartbeat loop inside this app. Feed items reach the window
/// as `home_feed` events; the paired phone notifier (if any) still gets
/// pushes. Fails if another runner (e.g. `kotonia-cli home run`) holds the
/// home lock — only one may fire, or every tick would arrive twice.
#[tauri::command]
pub async fn home_start_runner(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    use kotonia_cli::home::{feed::Delivery, runner};
    {
        let guard = state.home_runner.lock().unwrap();
        if guard.as_ref().is_some_and(|h| !h.is_finished()) {
            return Ok(());
        }
    }
    let dir = HomeDir::resolve()?;
    dir.ensure_initialized()?;
    // Probe the lock first so the caller hears about a CLI runner now,
    // not as a silent task failure later. The probe lock is released
    // before the loop takes it for real.
    drop(runner::RunnerLock::acquire(&dir)?);
    let notifier = kotonia_cli::notifier::load_notifier_config()
        .map(|c| kotonia_cli::notifier::build_notifier(&c, reqwest::Client::new()));
    let app_for_feed = app.clone();
    let delivery = Delivery::new(dir.clone(), notifier, false).with_observer(Arc::new(
        move |item: &kotonia_cli::home::feed::FeedItem| {
            let _ = app_for_feed.emit("home_feed", item);
        },
    ));
    let cfg = runner::RunnerConfig {
        model: DEFAULT_MODEL.to_string(),
        provider: None,
        poll_secs: 60,
        max_iterations: 15,
        heartbeat_timeout: std::time::Duration::from_secs(600),
        dry_run: false,
    };
    let app_for_exit = app.clone();
    let handle = tokio::spawn(async move {
        if let Err(e) = runner::run_forever_with(dir, cfg, delivery).await {
            let _ = app_for_exit.emit("home_runner_stopped", e);
        }
    });
    *state.home_runner.lock().unwrap() = Some(handle.abort_handle());
    Ok(())
}

#[tauri::command]
pub async fn home_stop_runner(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(h) = state.home_runner.lock().unwrap().take() {
        h.abort();
    }
    Ok(())
}
