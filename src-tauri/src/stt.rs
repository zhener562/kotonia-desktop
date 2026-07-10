//! STT: WebView mic capture → WAV → kotonia.ai `/api/voice/transcribe`
//! → text dropped into the prompt textarea for the user to review.
//!
//! Why this is a one-shot (not streaming) call:
//!   - Backend `/api/voice/transcribe` returns the full transcript in one
//!     JSON body — there's no chunk streaming protocol for STT (unlike
//!     TTS), so a single round-trip is all the server offers.
//!   - For the "dictation into prompt input" UX we want the full text
//!     anyway before mutating the textarea; partial transcripts would
//!     just be visual noise.
//!
//! Engine selection: Qwen3-ASR 1.7B is the better path for the user's
//! setup (sharper on long / technical recordings — see memory
//! `asr_tts_eval_short_clip_blindspot`). We hardcode `stt_model =
//! "qwen3_asr"` for Eve because every utterance will be code / shell /
//! repo names embedded in JA prose, which is exactly where
//! whisper-small struggles.

use base64::Engine as _;
use reqwest::multipart;
use serde::Serialize;

#[derive(Serialize)]
pub struct TranscribeResult {
    pub text: String,
    pub elapsed_ms: u64,
}

pub async fn transcribe(wav_base64: String) -> Result<TranscribeResult, String> {
    let cfg = kotonia_cli::config::load()
        .ok_or_else(|| "not logged in (run `kotonia-cli login`)".to_string())?;

    let wav_bytes = base64::engine::general_purpose::STANDARD
        .decode(wav_base64.as_bytes())
        .map_err(|e| format!("base64 decode: {e}"))?;
    if wav_bytes.is_empty() {
        return Err("empty audio".into());
    }

    let server = cfg.server.trim_end_matches('/').to_string();
    let url = format!("{server}/api/voice/transcribe");

    let form = multipart::Form::new()
        .text("language", "ja")
        .text("stt_model", "qwen3_asr")
        // Whisper-only fallback if Qwen3-ASR is unavailable upstream;
        // unused when stt_model=qwen3_asr but kept in case the server
        // routes to whisper.
        .text("model_size", "small")
        .part(
            "file",
            multipart::Part::bytes(wav_bytes)
                .file_name("audio.wav")
                .mime_str("audio/wav")
                .map_err(|e| e.to_string())?,
        );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let t0 = std::time::Instant::now();
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

    let json: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("parse: {e}"))?;
    let text = json
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    Ok(TranscribeResult {
        text,
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}
