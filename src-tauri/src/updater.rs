use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;

    Ok(update.map(|update| UpdateInfo {
        version: update.version,
        current_version: update.current_version,
    }))
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let Some(update) = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
    else {
        return Ok(());
    };

    let mut downloaded = 0usize;
    update
        .download_and_install(
            |chunk_length, content_length| {
                downloaded += chunk_length;
                eprintln!(
                    "[updater] downloaded {downloaded} of {} bytes",
                    content_length
                        .map(|length| length.to_string())
                        .unwrap_or_else(|| "unknown".to_string())
                );
            },
            || eprintln!("[updater] download finished; installing"),
        )
        .await
        .map_err(|e| e.to_string())?;

    eprintln!("[updater] update installed; restarting");
    app.restart();
}
