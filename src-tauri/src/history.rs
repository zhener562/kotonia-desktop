//! Desktop conversation records supplement the CLI's tool/resume transcript.
//! A message contains its response blocks AND the voice snapshot used to read
//! them; there is no independent spoken-answer log.
use crate::response::{self, Response};
use crate::speech::VoiceConfig;
use kotonia_cli::agent::history::{
    load_session_metadata_in, load_session_transcript_in, HistoryStore,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static WRITES: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Profile {
    pub name: String,
    pub tagline: String,
    pub system_prompt: String,
    pub persona: String,
    pub avatar_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SessionContext {
    pub workspace: String,
    pub engine: String,
    pub model: String,
    pub profile: Option<Profile>,
    pub voice: VoiceConfig,
    pub home: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Message {
    pub id: String,
    pub role: String,
    pub content: String,
    pub response: Option<Response>,
    pub voice: Option<VoiceConfig>,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Session {
    pub version: u8,
    pub id: String,
    pub updated_at: String,
    pub context: SessionContext,
    pub messages: Vec<Message>,
}

#[derive(Serialize)]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub updated_at: String,
    pub character: String,
    pub workspace: String,
    pub engine: String,
    pub legacy: bool,
}

pub fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 100
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("セッションIDが不正です".into());
    }
    Ok(())
}

fn directory() -> Result<PathBuf, String> {
    let dir = dirs::home_dir()
        .ok_or("home directory not found")?
        .join(".kotonia/desktop/sessions");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    Ok(dir.join(format!("{id}.json")))
}

fn read_in(dir: &Path, id: &str) -> Result<Option<Session>, String> {
    let file = path(dir, id)?;
    match std::fs::read(&file) {
        Ok(bytes) => {
            let session: Session =
                serde_json::from_slice(&bytes).map_err(|e| format!("履歴を読み込めません: {e}"))?;
            if session.version != 1 || session.id != id {
                return Err("未対応の履歴形式です".into());
            }
            Ok(Some(session))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn write_in(dir: &Path, session: &Session) -> Result<(), String> {
    let dest = path(dir, &session.id)?;
    let temporary = dir.join(format!(".{}.{}.tmp", session.id, uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(session).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        std::fs::rename(&temporary, dest).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn legacy(id: &str) -> Result<Session, String> {
    legacy_in(&HistoryStore::default_dir().map_err(|e| e.to_string())?, id)
}

fn legacy_in(cli_dir: &Path, id: &str) -> Result<Session, String> {
    validate_id(id)?;
    let meta = load_session_metadata_in(cli_dir, id).map_err(|e| e.to_string())?;
    let file = cli_dir.join(format!("{id}.jsonl"));
    let modified = std::fs::metadata(&file)
        .and_then(|m| m.modified())
        .map_err(|e| e.to_string())?;
    let when = chrono::DateTime::<chrono::Utc>::from(modified).to_rfc3339();
    // Legacy metadata's public helper exposes workspace only. The header also
    // records the engine/backend and model, which are required for safe resume.
    let mut engine = "react".to_string();
    let mut model = "kotonia-llm-basic".to_string();
    use std::io::BufRead;
    for line in
        std::io::BufReader::new(std::fs::File::open(file).map_err(|e| e.to_string())?).lines()
    {
        let Ok(line) = line else {
            continue;
        };
        let Ok(header) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if header["kind"] != "session" {
            continue;
        }
        model = header["model"]
            .as_str()
            .unwrap_or("kotonia-llm-basic")
            .to_string();
        if header["backend"].as_str().unwrap_or("").contains("claude") || model.contains("claude") {
            engine = "claude-code".into();
        }
        break;
    }
    let messages = load_session_transcript_in(cli_dir, id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .enumerate()
        .map(|(i, m)| Message {
            id: format!("legacy-{i}"),
            response: (m.role == "assistant").then(|| response::normalize(&m.content)),
            role: m.role,
            content: m.content,
            voice: None,
            created_at: when.clone(),
        })
        .collect();
    Ok(Session {
        version: 1,
        id: id.into(),
        updated_at: when,
        context: SessionContext {
            workspace: meta.workspace.display().to_string(),
            engine,
            model,
            profile: None,
            voice: VoiceConfig::default(),
            home: false,
        },
        messages,
    })
}

pub fn load(id: &str) -> Result<Session, String> {
    let _guard = WRITES.lock().map_err(|e| e.to_string())?;
    read_in(&directory()?, id)?
        .map(Ok)
        .unwrap_or_else(|| legacy(id))
}

pub fn list() -> Result<Vec<SessionSummary>, String> {
    let mut ids = BTreeSet::new();
    for entry in std::fs::read_dir(directory()?).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        if p.extension().is_some_and(|e| e == "json") {
            if let Some(id) = p.file_stem().and_then(|s| s.to_str()) {
                ids.insert(id.to_string());
            }
        }
    }
    for session in kotonia_cli::agent::history::list_sessions().map_err(|e| e.to_string())? {
        ids.insert(session.id);
    }
    let mut summaries = Vec::new();
    for id in ids {
        // A damaged individual log must not make the entire history unusable.
        match load(&id) {
            Ok(session) => {
                let compact = |s: &str| {
                    s.split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                        .chars()
                        .take(100)
                        .collect::<String>()
                };
                let title = session
                    .messages
                    .iter()
                    .find(|m| m.role == "user")
                    .map(|m| compact(&m.content))
                    .unwrap_or_else(|| "新しい会話".into());
                let preview = session
                    .messages
                    .last()
                    .map(|m| {
                        compact(
                            &m.response
                                .as_ref()
                                .map(|r| {
                                    r.blocks
                                        .iter()
                                        .map(|b| b.text())
                                        .collect::<Vec<_>>()
                                        .join(" ")
                                })
                                .unwrap_or_else(|| m.content.clone()),
                        )
                    })
                    .unwrap_or_default();
                summaries.push(SessionSummary {
                    id,
                    title,
                    preview,
                    updated_at: session.updated_at,
                    character: session
                        .context
                        .profile
                        .as_ref()
                        .map(|p| p.name.clone())
                        .unwrap_or_else(|| "以前の会話".into()),
                    workspace: session.context.workspace,
                    engine: session.context.engine,
                    legacy: session.context.profile.is_none(),
                });
            }
            Err(e) => eprintln!("[history] {id}: {e}"),
        }
    }
    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
    Ok(summaries)
}

pub fn begin_turn(id: &str, context: SessionContext, prompt: &str) -> Result<String, String> {
    let _guard = WRITES.lock().map_err(|e| e.to_string())?;
    let dir = directory()?;
    let mut session = match read_in(&dir, id)? {
        Some(session) => session,
        None => {
            let cli_file = HistoryStore::default_dir()
                .map_err(|e| e.to_string())?
                .join(format!("{id}.jsonl"));
            if cli_file.exists() {
                legacy(id)?
            } else {
                Session {
                    version: 1,
                    id: id.into(),
                    updated_at: String::new(),
                    context: context.clone(),
                    messages: Vec::new(),
                }
            }
        }
    };
    session.context = context;
    let message_id = uuid::Uuid::new_v4().to_string();
    session.updated_at = chrono::Utc::now().to_rfc3339();
    session.messages.push(Message {
        id: message_id.clone(),
        role: "user".into(),
        content: prompt.into(),
        response: None,
        voice: None,
        created_at: session.updated_at.clone(),
    });
    write_in(&dir, &session)?;
    Ok(message_id)
}

pub fn append_response(id: &str, text: &str, voice: &VoiceConfig) -> Result<Message, String> {
    let _guard = WRITES.lock().map_err(|e| e.to_string())?;
    let dir = directory()?;
    let mut session = read_in(&dir, id)?.ok_or("会話が見つかりません")?;
    session.updated_at = chrono::Utc::now().to_rfc3339();
    let message = Message {
        id: uuid::Uuid::new_v4().to_string(),
        role: "assistant".into(),
        content: text.into(),
        response: Some(response::normalize(text)),
        voice: Some(voice.clone()),
        created_at: session.updated_at.clone(),
    };
    session.messages.push(message.clone());
    write_in(&dir, &session)?;
    Ok(message)
}

pub fn save_preferences(id: &str, profile: Profile, voice: VoiceConfig) -> Result<(), String> {
    voice.validate()?;
    let _guard = WRITES.lock().map_err(|e| e.to_string())?;
    let dir = directory()?;
    let mut session = read_in(&dir, id)?.map(Ok).unwrap_or_else(|| legacy(id))?;
    session.context.profile = Some(profile);
    session.context.voice = voice;
    // The individual messages retain their original immutable voice snapshots.
    write_in(&dir, &session)
}

pub fn markdown(session: &Session) -> String {
    let mut output = format!(
        "# Kotonia Desktop\n\n{} · {}\n\n",
        session.updated_at, session.context.workspace
    );
    for message in &session.messages {
        output.push_str(if message.role == "user" {
            "## あなた\n\n"
        } else {
            "## アシスタント\n\n"
        });
        if let Some(response) = &message.response {
            for block in &response.blocks {
                output.push_str(block.text());
                output.push_str("\n\n");
            }
        } else {
            output.push_str(&message.content);
            output.push_str("\n\n");
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_traversal_before_accessing_files() {
        for id in ["", "../secrets", "a/b", "a\\b", ".", "a.jsonl"] {
            assert!(validate_id(id).is_err());
        }
        assert!(validate_id("s_123_abc-def").is_ok());
    }
    #[test]
    fn atomic_history_roundtrip_preserves_workspace_profile_and_voice() {
        let dir = std::env::temp_dir().join(format!("kotonia-history-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let voice = VoiceConfig {
            engine: "irodori".into(),
            irodori_ref_id: "my_voice".into(),
            ..Default::default()
        };
        let session = Session {
            version: 1,
            id: "test-session".into(),
            updated_at: "2026-11-05T00:00:00Z".into(),
            context: SessionContext {
                workspace: "/tmp/作業".into(),
                engine: "claude-code".into(),
                model: "claude-code".into(),
                profile: Some(Profile {
                    name: "テスト".into(),
                    ..Default::default()
                }),
                voice: voice.clone(),
                home: true,
            },
            messages: vec![Message {
                id: "message-1".into(),
                role: "assistant".into(),
                content: "原文".into(),
                response: Some(response::normalize("台詞\n```\ncode\n```")),
                voice: Some(voice),
                created_at: "now".into(),
            }],
        };
        write_in(&dir, &session).unwrap();
        write_in(&dir, &session).unwrap();
        let loaded = read_in(&dir, "test-session").unwrap().unwrap();
        assert_eq!(loaded.context.workspace, "/tmp/作業");
        assert_eq!(loaded.context.engine, "claude-code");
        assert_eq!(loaded.context.profile.unwrap().name, "テスト");
        assert_eq!(
            loaded.messages[0].voice.as_ref().unwrap().irodori_ref_id,
            "my_voice"
        );
        assert_eq!(loaded.messages[0].response, session.messages[0].response);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn legacy_cli_logs_restore_engine_workspace_and_visible_speech_without_tool_noise() {
        use kotonia_cli::agent::provider::ChatRole;
        let dir = std::env::temp_dir().join(format!("kotonia-legacy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let mut log = HistoryStore::open_in(&dir, "legacy-session").unwrap();
        log.write_header(
            "claude-code",
            "claude-code",
            "allowlist",
            Path::new("/tmp/old-workspace"),
            true,
        )
        .unwrap();
        log.append_message(&ChatRole::User, "前の相談").unwrap();
        log.append_message(&ChatRole::User, "[exit 0] tool output")
            .unwrap();
        log.append_message(
            &ChatRole::Assistant,
            "{{VOICE: calm}}{{SPEAK: 完了しました。}}詳細の本文",
        )
        .unwrap();
        drop(log);
        let session = legacy_in(&dir, "legacy-session").unwrap();
        assert_eq!(session.context.engine, "claude-code");
        assert_eq!(session.context.workspace, "/tmp/old-workspace");
        assert!(session.context.profile.is_none());
        assert_eq!(session.messages.len(), 2);
        let blocks = &session.messages[1].response.as_ref().unwrap().blocks;
        assert_eq!(blocks[0].text(), "完了しました。");
        assert_eq!(blocks[1].text(), "詳細の本文");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn export_uses_full_response_blocks_and_keeps_technical_details() {
        let session = Session {
            version: 1,
            id: "test".into(),
            updated_at: "now".into(),
            context: SessionContext {
                workspace: "/tmp".into(),
                engine: "react".into(),
                model: "default".into(),
                profile: None,
                voice: VoiceConfig::default(),
                home: false,
            },
            messages: vec![Message {
                id: "m".into(),
                role: "assistant".into(),
                content: "raw transport".into(),
                response: Some(response::normalize("{{SPEAK: 完了}}本文\n/tmp/file")),
                voice: None,
                created_at: "now".into(),
            }],
        };
        let md = markdown(&session);
        assert!(md.contains("完了"));
        assert!(md.contains("本文\n/tmp/file"));
        assert!(!md.contains("SPEAK"));
    }
}
