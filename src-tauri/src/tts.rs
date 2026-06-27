//! TTS streaming: agent text → Iris's voice in the WebView.
//!
//! Why route through Rust:
//!   - The kotonia.ai `/api/voice/*` endpoints want a Bearer
//!     `device_token` (after the auth.rs change that added device_token
//!     to `validate_session`), which we keep server-side in Rust so
//!     the WebView never holds the credential.
//!   - The response is a length-prefixed stream of WAV frames
//!     (`[u32 big-endian length][WAV bytes]` repeated), and parsing
//!     that as a binary protocol is cleaner in Rust than in JS.
//!   - CORS: the WebView origin (`tauri://localhost`) is not on the
//!     kotonia.ai allowlist; the Rust client has no such limit.
//!
//! Flow:
//!   1. `tts_speak(text, stream_id)` POSTs to the configured TTS
//!      endpoint with Iris's voice config.
//!   2. As `[len][wav]` frames arrive, we emit a `tts_chunk` Tauri
//!      event with the base64-encoded WAV bytes and the original
//!      `stream_id` (so the frontend can tell stale streams from the
//!      live one — newer `tts_speak` calls cancel older streams by
//!      comparing the id).
//!   3. On clean end we emit `tts_done`, on failure `tts_error`.
//!
//! Cancellation: the frontend just rejects events whose `stream_id`
//! doesn't match the current target. We don't try to abort the
//! reqwest in-flight — the upstream response is small enough
//! (~50KB / sentence) that letting it drain is fine.

use base64::Engine as _;
use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::persona::VoiceConfig;

#[derive(Serialize, Clone)]
struct TtsChunkPayload {
    stream_id: String,
    wav_base64: String,
}

#[derive(Serialize, Clone)]
struct TtsDonePayload {
    stream_id: String,
}

#[derive(Serialize, Clone)]
struct TtsErrorPayload {
    stream_id: String,
    message: String,
}

pub async fn run_stream(
    app: AppHandle,
    stream_id: String,
    text: String,
    voice: &'static VoiceConfig,
) {
    let cfg = match kotonia_cli::config::load() {
        Some(c) => c,
        None => {
            let _ = app.emit(
                "tts_error",
                TtsErrorPayload {
                    stream_id,
                    message: "not logged in (run `kotonia-cli login`)".into(),
                },
            );
            return;
        }
    };

    let server = cfg.server.trim_end_matches('/').to_string();
    let url = match voice.engine {
        "qwen3" => format!("{server}/api/voice/qwen3/tts/stream"),
        "irodori" => format!("{server}/api/voice/irodori/tts/stream"),
        "voicevox" => format!("{server}/api/voice/voicevox/tts/stream"),
        other => {
            let _ = app.emit(
                "tts_error",
                TtsErrorPayload {
                    stream_id,
                    message: format!("unsupported TTS engine: {other}"),
                },
            );
            return;
        }
    };

    let body = match voice.engine {
        "qwen3" => serde_json::json!({
            "text": text,
            "language": voice.language,
            "speaker": voice.speaker,
            "speed": voice.speed,
            // Critical for first-byte latency: the python tts_server
            // defaults this to true, which bundles JA+EN mixed input
            // into a single chunk emitted only after full generation.
            // See VoiceConfig::split_mixed_languages for the trade-off.
            "split_mixed_languages": voice.split_mixed_languages,
        }),
        "voicevox" => {
            // VoiceVox uses numeric speaker ids; the persona constant
            // stores them as a string for uniformity, so parse here.
            let speaker_id: i64 = voice.speaker.parse().unwrap_or(1);
            serde_json::json!({
                "text": text,
                "speaker": speaker_id,
                "speed": voice.speed,
            })
        }
        "irodori" => serde_json::json!({
            "text": text,
            "speed": voice.speed,
            "num_steps": 20,
        }),
        _ => unreachable!(),
    };

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            let _ = app.emit(
                "tts_error",
                TtsErrorPayload {
                    stream_id,
                    message: format!("http client: {e}"),
                },
            );
            return;
        }
    };

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
                TtsErrorPayload {
                    stream_id,
                    message: format!("HTTP {status}: {}", detail.trim()),
                },
            );
            return;
        }
        Err(e) => {
            let _ = app.emit(
                "tts_error",
                TtsErrorPayload {
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
                    TtsErrorPayload {
                        stream_id,
                        message: format!("read: {e}"),
                    },
                );
                return;
            }
        }

        // Drain every complete `[len][wav]` frame that fits in the
        // accumulated buffer. Partial frames stay buffered for the
        // next chunk read.
        loop {
            if accumulated.len() < 4 {
                break;
            }
            let frame_len = u32::from_be_bytes([
                accumulated[0],
                accumulated[1],
                accumulated[2],
                accumulated[3],
            ]) as usize;
            if accumulated.len() < 4 + frame_len {
                break;
            }
            let wav = accumulated[4..4 + frame_len].to_vec();
            accumulated.drain(..4 + frame_len);

            let _ = app.emit(
                "tts_chunk",
                TtsChunkPayload {
                    stream_id: stream_id.clone(),
                    wav_base64: base64_engine.encode(&wav),
                },
            );
        }
    }

    let _ = app.emit("tts_done", TtsDonePayload { stream_id });
}
