//! Ditto lip-sync streaming: agent text → audio + JPEG frame stream
//! that animates Eve's face in time with the spoken response.
//!
//! Endpoint: `/api/v1/avatars/{avatar_id}/speech` (bearer-authenticated
//! with the device token managed by kotonia-cli).
//!
//! Wire format (one stream of length-prefixed tagged chunks):
//!
//!   [u8 type][u32 BE length][payload bytes]   …repeat
//!
//! - type=0 → audio WAV chunk (same shape as `/api/v1/audio/speech`)
//! - type=1 → JPEG video frame at the negotiated fps (default 25)
//!
//! The audio chunks should be **buffered until the first frame
//! arrives** and then played from that moment, so that face animation
//! and audio start in lock-step. Frame generation is slower than
//! audio synthesis, so the audio side has to wait for the frames.
//! The buffering happens in the frontend (`main.js`) — the Rust
//! side just emits `tts_chunk` for audio and `ditto_frame` for
//! frames, with the same `stream_id` correlation tag.

use base64::Engine as _;
use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::persona::{Persona, VoiceConfig};
use crate::state::AppState;

#[derive(Serialize, Clone)]
struct TtsChunkPayload {
    stream_id: String,
    wav_base64: String,
}

#[derive(Serialize, Clone)]
struct DittoFramePayload {
    stream_id: String,
    jpeg_base64: String,
}

#[derive(Serialize, Clone)]
struct StreamDonePayload {
    stream_id: String,
}

#[derive(Serialize, Clone)]
struct StreamErrorPayload {
    stream_id: String,
    message: String,
}

/// True if `eve` (or whatever the persona's `avatar_id` is) is
/// already registered with the Ditto server. Called lazily on the first
/// avatar utterance instead of introducing network side effects at startup.
async fn is_avatar_registered(persona: &Persona) -> Result<bool, String> {
    is_avatar_id_registered(persona.avatar_id).await
}

async fn is_avatar_id_registered(avatar_id: &str) -> Result<bool, String> {
    let cfg = kotonia_cli::config::load().ok_or_else(|| "not logged in".to_string())?;
    let url = format!("{}/api/v1/avatars", cfg.server.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let res = client
        .get(&url)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", cfg.device_token),
        )
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;
    if !res.status().is_success() {
        let status = res.status();
        let detail = res.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {}", detail.trim()));
    }
    let json: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("parse avatars response: {e}"))?;
    // Response shape is `{ "avatars": [{"avatar_id": "...", ...}, ...] }`
    // (the python ditto server). Fallback to top-level array if the
    // shape differs.
    let list = json
        .get("avatars")
        .and_then(|v| v.as_array())
        .cloned()
        .or_else(|| json.as_array().cloned())
        .unwrap_or_default();
    Ok(list.iter().any(|entry| {
        entry
            .get("avatar_id")
            .and_then(|v| v.as_str())
            .map(|id| id == avatar_id)
            .unwrap_or(false)
    }))
}

pub async fn register_avatar_file(avatar_id: &str, image_path: &str) -> Result<(), String> {
    if is_avatar_id_registered(avatar_id).await? {
        return Ok(());
    }
    let bytes = std::fs::read(image_path).map_err(|e| format!("read avatar image: {e}"))?;
    if bytes.len() > 12 * 1024 * 1024 {
        return Err("avatar image must be 12 MB or smaller".to_string());
    }
    let extension = std::path::Path::new(image_path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("jpg")
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => "image/png",
        "webp" => "image/webp",
        _ => "image/jpeg",
    };
    register_avatar_bytes(avatar_id, bytes, format!("{avatar_id}.{extension}"), mime).await
}

/// One-shot registration: upload the persona's bundled image to
/// `/api/v1/avatars` so the Ditto server caches its facial
/// reference under `persona.avatar_id`. Idempotent on the server
/// side — re-registering an existing id is a no-op.
async fn register_avatar(persona: &'static Persona) -> Result<(), String> {
    register_avatar_bytes(
        persona.avatar_id,
        persona.avatar_png.to_vec(),
        format!("{}.png", persona.avatar_id),
        "image/png",
    )
    .await
}

async fn register_avatar_bytes(
    avatar_id: &str,
    bytes: Vec<u8>,
    file_name: String,
    mime: &str,
) -> Result<(), String> {
    let cfg = kotonia_cli::config::load().ok_or_else(|| "not logged in".to_string())?;

    let form = reqwest::multipart::Form::new()
        .text("avatar_id", avatar_id.to_string())
        .part(
            "file",
            reqwest::multipart::Part::bytes(bytes)
                .file_name(file_name)
                .mime_str(mime)
                .map_err(|e| e.to_string())?,
        );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("{}/api/v1/avatars", cfg.server.trim_end_matches('/'));
    let res = client
        .post(&url)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", cfg.device_token),
        )
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let detail = res.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {}", detail.trim()));
    }
    Ok(())
}

async fn ensure_avatar_ready(app: &AppHandle, persona: &'static Persona) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut ready = state.avatar_ready.lock().await;
    if *ready {
        return Ok(());
    }

    if !is_avatar_registered(persona).await? {
        eprintln!(
            "[ditto] lazily registering avatar `{}` on first use",
            persona.avatar_id
        );
        register_avatar(persona).await?;
    }
    *ready = true;
    Ok(())
}

/// Speak `text` with lip-sync video. Audio chunks are emitted as
/// `tts_chunk` (same shape the TTS-only path uses, so the frontend
/// can share the AudioContext scheduler) and JPEG frames as
/// `ditto_frame`. `stream_id` correlates everything.
pub async fn run_stream(
    app: AppHandle,
    stream_id: String,
    text: String,
    instruct: Option<String>,
    avatar_id: String,
    voice: &'static VoiceConfig,
) {
    if avatar_id == crate::persona::EVE.avatar_id {
        if let Err(message) = ensure_avatar_ready(&app, &crate::persona::EVE).await {
            let _ = app.emit(
                "tts_error",
                StreamErrorPayload {
                    stream_id,
                    message: format!("avatar preparation failed: {message}"),
                },
            );
            return;
        }
    }

    let cfg = match kotonia_cli::config::load() {
        Some(c) => c,
        None => {
            let _ = app.emit(
                "tts_error",
                StreamErrorPayload {
                    stream_id,
                    message: "not logged in".into(),
                },
            );
            return;
        }
    };

    // Per-turn `{{VOICE: ...}}` acting direction (Qwen3 only), merged
    // behind the persona's base register. The ditto→TTS proxy forwards
    // `instruct` only for the qwen3 backend. `None` → server default.
    let merged_instruct = voice.merged_instruct(instruct.as_deref());
    let body = serde_json::json!({
        "text": text,
        "avatar_id": avatar_id,
        "tts_backend": voice.engine,
        "language": voice.language,
        // python ditto server expects single-letter `lang` too (j/a/z).
        "lang": match voice.language { "ja" => "j", "en" => "a", "zh" => "z", other => other },
        "speed": voice.speed,
        "speaker": voice.speaker,
        "instruct": merged_instruct,
        "fps": 25,
        // Qwen3-TTS path inside Ditto: keep the same streaming-friendly
        // setting we use on the pure-TTS path (see persona.rs comment).
        "split_mixed_languages": voice.split_mixed_languages,
    });

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            let _ = app.emit(
                "tts_error",
                StreamErrorPayload {
                    stream_id,
                    message: format!("http client: {e}"),
                },
            );
            return;
        }
    };

    let url = format!(
        "{}/api/v1/avatars/{}/speech",
        cfg.server.trim_end_matches('/'),
        avatar_id
    );

    let res = match client
        .post(&url)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", cfg.device_token),
        )
        .json(&body)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            let status = r.status();
            let detail = r.text().await.unwrap_or_default();
            let _ = app.emit(
                "tts_error",
                StreamErrorPayload {
                    stream_id,
                    message: format!("HTTP {status}: {}", detail.trim()),
                },
            );
            return;
        }
        Err(e) => {
            let _ = app.emit(
                "tts_error",
                StreamErrorPayload {
                    stream_id,
                    message: format!("request: {e}"),
                },
            );
            return;
        }
    };

    let mut accumulated: Vec<u8> = Vec::new();
    let mut stream = res.bytes_stream();
    let base64_engine = base64::engine::general_purpose::STANDARD;

    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(bytes) => accumulated.extend_from_slice(&bytes),
            Err(e) => {
                let _ = app.emit(
                    "tts_error",
                    StreamErrorPayload {
                        stream_id,
                        message: format!("read: {e}"),
                    },
                );
                return;
            }
        }

        // Drain complete `[type][len][payload]` frames.
        loop {
            if accumulated.len() < 5 {
                break;
            }
            let chunk_type = accumulated[0];
            let payload_len = u32::from_be_bytes([
                accumulated[1],
                accumulated[2],
                accumulated[3],
                accumulated[4],
            ]) as usize;
            if accumulated.len() < 5 + payload_len {
                break;
            }
            let payload = accumulated[5..5 + payload_len].to_vec();
            accumulated.drain(..5 + payload_len);

            match chunk_type {
                0 => {
                    let _ = app.emit(
                        "tts_chunk",
                        TtsChunkPayload {
                            stream_id: stream_id.clone(),
                            wav_base64: base64_engine.encode(&payload),
                        },
                    );
                }
                1 => {
                    let _ = app.emit(
                        "ditto_frame",
                        DittoFramePayload {
                            stream_id: stream_id.clone(),
                            jpeg_base64: base64_engine.encode(&payload),
                        },
                    );
                }
                other => {
                    eprintln!("[ditto] unknown chunk type {other}, skipping");
                }
            }
        }
    }

    let _ = app.emit("tts_done", StreamDonePayload { stream_id });
}
