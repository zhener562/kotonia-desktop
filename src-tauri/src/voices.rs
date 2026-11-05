//! Authenticated access to the existing voice catalog/design APIs. Credentials
//! remain on the Rust side, like the existing streaming speech commands.
use base64::Engine as _;
use serde_json::{json, Value};

fn engine_name(engine: &str) -> Result<&str, String> {
    match engine {
        "irodori" | "voxcpm" => Ok(engine),
        _ => Err("参照音声はVoxCPM2またはIrodoriを選んでください".into()),
    }
}

async fn request(
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<reqwest::Response, String> {
    let cfg = kotonia_cli::config::load().ok_or("ログインしてください")?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client
        .request(
            method,
            format!("{}{path}", cfg.server.trim_end_matches('/')),
        )
        .bearer_auth(&cfg.device_token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(format!(
            "HTTP {status}: {}",
            response.text().await.unwrap_or_default()
        ));
    }
    Ok(response)
}

#[tauri::command]
pub async fn list_ref_voices(engine: String) -> Result<Value, String> {
    let engine = engine_name(&engine)?;
    request(
        reqwest::Method::GET,
        &format!("/api/v1/audio/voices?engine={engine}"),
        None,
    )
    .await?
    .json()
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn voice_sample(engine: String, ref_id: String) -> Result<String, String> {
    let engine = engine_name(&engine)?;
    if ref_id.is_empty()
        || ref_id.len() > 64
        || !ref_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err("参照音声IDが不正です".into());
    }
    let bytes = request(
        reqwest::Method::GET,
        &format!("/api/voice/{engine}/voices/{ref_id}/sample"),
        None,
    )
    .await?
    .bytes()
    .await
    .map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub async fn make_voice_candidates(
    engine: String,
    description: String,
    language: String,
) -> Result<Value, String> {
    let engine = engine_name(&engine)?;
    if description.trim().is_empty() {
        return Err("声の特徴を入力してください".into());
    }
    let body = if engine == "irodori" {
        json!({"caption": description})
    } else {
        json!({"design": description, "language": language})
    };
    request(
        reqwest::Method::POST,
        &format!("/api/voice/{engine}/voices/candidates"),
        Some(body),
    )
    .await?
    .json()
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn choose_voice_candidate(
    engine: String,
    label: String,
    audio_b64: String,
    token: String,
) -> Result<Value, String> {
    let engine = engine_name(&engine)?;
    request(
        reqwest::Method::POST,
        &format!("/api/voice/{engine}/voices"),
        Some(json!({"label": label, "candidate": {"audio_b64": audio_b64, "token": token}})),
    )
    .await?
    .json()
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn voicevox_speakers() -> Result<Value, String> {
    request(reqwest::Method::GET, "/api/voice/voicevox/speakers", None)
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}
