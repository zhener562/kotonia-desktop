#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod commands;
mod ditto;
mod history;
mod persona;
mod response;
mod speech;
mod state;
mod stt;
mod tts;
mod updater;
mod voices;

use state::AppState;

fn main() {
    // Requests to kotonia.ai say they come from the desktop app, not the CLI
    // (`x-kotonia-client: desktop/<kotonia-cli version> (<os>)`).
    kotonia_cli::client_info::set_client_name("desktop");

    // Propagate the paired device_token into KOTONIA_API_KEY so the ReAct
    // agent's bash subprocess inherits it. The backend's `require_api_token`
    // (backend/src/handlers/auth.rs) accepts a device_token as a Bearer
    // credential for `/api/v1/*`, so the curl examples in the agent's
    // system prompt (`Authorization: Bearer $KOTONIA_API_KEY`) authenticate
    // against the same paired account without a second key issuance.
    if let Some(cfg) = kotonia_cli::config::load() {
        if std::env::var_os("KOTONIA_API_KEY").is_none() {
            std::env::set_var("KOTONIA_API_KEY", &cfg.device_token);
        }
        if std::env::var_os("KOTONIA_API_BASE").is_none() {
            std::env::set_var("KOTONIA_API_BASE", &cfg.server);
        }
    }

    // ── Linux IME (preedit) — KNOWN UPSTREAM ISSUE ─────────────────────
    // WebKitGTK ≤ 2.52.x + ibus + Wayland: Japanese / CJK preedit text
    // is invisible while typing (only the committed text shows). Tested
    // on Ubuntu 24.04 + GNOME/Wayland + ibus-mozc with every env combo
    // we could find — none restored inline preedit. Tracked upstream;
    // newer WebKitGTK 2.54+ on a recent distro release may behave
    // differently.
    //
    // We deliberately do NOT set any env workaround by default — the
    // ones we tried either had no effect or broke input entirely on
    // this setup, and they have side effects (X11 backend loses HiDPI
    // fractional scaling, sandbox-off relaxes the WebProcess, XIM
    // bridge crashed mozc). The README documents the env vars users
    // can try at launch:
    //
    //   GDK_BACKEND=x11 WEBKIT_FORCE_SANDBOX=0 cargo tauri dev
    //
    // and the trade-offs. The target install base is macOS WKWebView
    // and Windows WebView2 where this bug doesn't exist.

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::auth_status,
            commands::start_login,
            commands::poll_login,
            commands::persona_info,
            commands::submit_task,
            commands::cancel_task,
            commands::close_browser,
            commands::respond_approval,
            commands::respond_connector,
            commands::respond_site,
            commands::home_status,
            commands::home_set_heartbeat,
            commands::home_start_runner,
            commands::home_stop_runner,
            commands::project_status,
            commands::project_save,
            commands::project_set_mail,
            commands::new_session,
            commands::list_sessions,
            commands::open_session,
            commands::export_session,
            commands::prepare_speech,
            commands::validate_voice,
            commands::save_session_preferences,
            commands::cancel_speech,
            voices::list_ref_voices,
            voices::voice_sample,
            voices::make_voice_candidates,
            voices::choose_voice_candidate,
            voices::voicevox_speakers,
            commands::open_login_help,
            commands::shell_info,
            commands::open_path,
            commands::resolve_preview_path,
            commands::tts_speak,
            commands::ditto_speak,
            commands::stt_transcribe,
            updater::check_for_update,
            updater::install_update,
        ])
        .setup(|app| {
            point_at_bundled_busybox(app);
            #[cfg(target_os = "linux")]
            allow_webkit_media_permissions(app);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Hook the WebKitGTK `permission-request` signal on the main window
/// and `.allow()` every request. Without this, `getUserMedia` (mic /
/// camera) is silently denied on Linux and the WebView throws
/// `NotAllowedError` to the page — there's no system "allow this app
/// to use the microphone?" dialog, the request just dies. Real
/// browsers handle this by popping a UI; for an in-app static-HTML
/// shell like kotonia-desktop a blanket allow is the right default
/// (every request originates from our own bundled frontend, no
/// third-party origin can sneak in unwanted requests).
#[cfg(target_os = "linux")]
fn allow_webkit_media_permissions(app: &tauri::App) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("kotonia-desktop: main window not found for permission setup");
        return;
    };
    let _ = window.with_webview(|wv| {
        use webkit2gtk::{PermissionRequestExt, WebViewExt};
        wv.inner().connect_permission_request(|_view, request| {
            request.allow();
            true
        });
    });
}

/// Windows without Git for Windows has no bash; the installer ships
/// busybox.exe as a resource so commands work right after install. Tell
/// kotonia-cli where it is (it looks next to its own exe otherwise, which for
/// the desktop is not where Tauri puts resources).
fn point_at_bundled_busybox(app: &tauri::App) {
    use tauri::Manager;
    if std::env::var_os("KOTONIA_BUSYBOX").is_some() {
        return;
    }
    if let Ok(dir) = app.path().resource_dir() {
        let bb = dir.join("busybox.exe");
        if bb.is_file() {
            std::env::set_var("KOTONIA_BUSYBOX", bb);
        }
    }
}
