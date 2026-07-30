use serde::Serialize;
#[cfg(any(target_os = "macos", test))]
use std::path::Path;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub install_blocker: Option<String>,
}

#[cfg(any(target_os = "macos", test))]
fn macos_install_blocker_for_path(executable: &Path) -> Option<String> {
    let path = executable.to_string_lossy();
    if path.starts_with("/Volumes/") || path.contains("/AppTranslocation/") {
        Some(
            "Kotonia Desktop を終了し、Finder でアプリを「アプリケーション」フォルダへ移動してから、もう一度起動してください。"
                .to_string(),
        )
    } else {
        None
    }
}

fn update_install_blocker() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let executable = std::env::current_exe().ok()?;
        macos_install_blocker_for_path(&executable)
    }

    #[cfg(not(target_os = "macos"))]
    {
        None
    }
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
        install_blocker: update_install_blocker(),
    }))
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    if let Some(blocker) = update_install_blocker() {
        return Err(blocker);
    }

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
        .map_err(|e| {
            eprintln!("[updater] installation failed: {e}");
            e.to_string()
        })?;

    eprintln!("[updater] update installed; restarting");
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::macos_install_blocker_for_path;
    use std::path::Path;

    #[test]
    fn blocks_apps_launched_from_mounted_images() {
        assert!(macos_install_blocker_for_path(Path::new(
            "/Volumes/Kotonia/kotonia-desktop.app/Contents/MacOS/kotonia-desktop"
        ))
        .is_some());
    }

    #[test]
    fn blocks_gatekeeper_app_translocation() {
        assert!(
            macos_install_blocker_for_path(Path::new(
                "/private/var/folders/x/AppTranslocation/y/d/kotonia-desktop.app/Contents/MacOS/kotonia-desktop"
            ))
            .is_some()
        );
    }

    #[test]
    fn permits_apps_installed_in_applications() {
        assert!(macos_install_blocker_for_path(Path::new(
            "/Applications/kotonia-desktop.app/Contents/MacOS/kotonia-desktop"
        ))
        .is_none());
    }
}
