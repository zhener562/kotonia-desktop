//! TTS streaming: canonical speech blocks → selected voice in the WebView.
//!
//! Why route through Rust:
//!   - The kotonia.ai `/api/v1/audio/speech` endpoint wants a Bearer
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
//!   1. `tts_speak(text, voice, stream_id)` POSTs the shared speech plan
//!      to the configured TTS endpoint.
//!   2. As `[len][wav]` frames arrive, we emit a `tts_chunk` Tauri
//!      event with the base64-encoded WAV bytes and the original
//!      `stream_id` (so the frontend can tell stale streams from the
//!      live one — newer `tts_speak` calls cancel older streams by
//!      comparing the id).
//!   3. On clean end we emit `tts_done`, on failure `tts_error`.
//!
//! Cancellation: commands.rs owns the task AbortHandle. Stopping playback
//! aborts this task and drops its in-flight HTTP response.

use base64::Engine as _;
use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::speech::{self, VoiceConfig};

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
    instruct: Option<String>,
    voice: VoiceConfig,
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
    let url = format!("{server}/api/v1/audio/speech");
    let body = speech::audio_body(&text, instruct.as_deref(), &voice);

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
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
