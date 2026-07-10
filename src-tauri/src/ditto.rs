//! Ditto lip-sync streaming: agent text → audio + JPEG frame stream
//! that animates Eve's face in time with the spoken response.
//!
//! Endpoint: `/api/voice/ditto/tts/stream/avatar` (cookie- or
//! device_token-authed; the device_token path was enabled in the
//! auth.rs change from the persona-foundation commit `e0c7edc`).
//!
//! Wire format (one stream of length-prefixed tagged chunks):
//!
//!   [u8 type][u32 BE length][payload bytes]   …repeat
//!
//! - type=0 → audio WAV chunk (same shape as `/qwen3/tts/stream`)
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
use tauri::{AppHandle, Emitter};

use crate::persona::Persona;

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
/// already registered with the Ditto server. Used by the startup
/// hook so we only POST `/ditto/prepare` once per device per persona.
pub async fn is_avatar_registered(persona: &Persona) -> bool {
    let Some(cfg) = kotonia_cli::config::load() else {
        return false;
    };
    let url = format!(
        "{}/api/voice/ditto/avatars",
        cfg.server.trim_end_matches('/')
    );
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    else {
        return false;
    };
    let Ok(res) = client
        .get(&url)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", cfg.device_token),
        )
        .send()
        .await
    else {
        return false;
    };
    if !res.status().is_success() {
        return false;
    }
    let Ok(json): Result<serde_json::Value, _> = res.json().await else {
        return false;
    };
    // Response shape is `{ "avatars": [{"avatar_id": "...", ...}, ...] }`
    // (the python ditto server). Fallback to top-level array if the
    // shape differs.
    let list = json
        .get("avatars")
        .and_then(|v| v.as_array())
        .cloned()
        .or_else(|| json.as_array().cloned())
        .unwrap_or_default();
    list.iter().any(|entry| {
        entry
            .get("avatar_id")
            .and_then(|v| v.as_str())
            .map(|id| id == persona.avatar_id)
            .unwrap_or(false)
    })
}

/// One-shot registration: upload the persona's bundled image to
/// `/api/voice/ditto/prepare` so the Ditto server caches its facial
/// reference under `persona.avatar_id`. Idempotent on the server
/// side — re-registering an existing id is a no-op.
pub async fn register_avatar(persona: &'static Persona) -> Result<(), String> {
    let cfg = kotonia_cli::config::load()
        .ok_or_else(|| "not logged in".to_string())?;

    let form = reqwest::multipart::Form::new()
        .text("avatar_id", persona.avatar_id)
        .part(
            "file",
            reqwest::multipart::Part::bytes(persona.avatar_png.to_vec())
                .file_name(format!("{}.png", persona.avatar_id))
                .mime_str("image/png")
                .map_err(|e| e.to_string())?,
        );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!(
        "{}/api/voice/ditto/prepare",
        cfg.server.trim_end_matches('/')
    );
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

/// Speak `text` with lip-sync video. Audio chunks are emitted as
/// `tts_chunk` (same shape the TTS-only path uses, so the frontend
/// can share the AudioContext scheduler) and JPEG frames as
/// `ditto_frame`. `stream_id` correlates everything.
pub async fn run_stream(app: AppHandle, stream_id: String, text: String, persona: &'static Persona) {
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

    let voice = &persona.voice;
    let body = serde_json::json!({
        "text": text,
        "avatar_id": persona.avatar_id,
        "tts_backend": voice.engine,
        "language": voice.language,
        // python ditto server expects single-letter `lang` too (j/a/z).
        "lang": match voice.language { "ja" => "j", "en" => "a", "zh" => "z", other => other },
        "speed": voice.speed,
        "speaker": voice.speaker,
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
        "{}/api/voice/ditto/tts/stream/avatar",
        cfg.server.trim_end_matches('/')
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
