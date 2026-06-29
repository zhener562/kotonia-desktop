#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod commands;
mod ditto;
mod persona;
mod state;
mod stt;
mod tts;

use state::AppState;

fn main() {
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
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::auth_status,
            commands::persona_info,
            commands::submit_task,
            commands::cancel_task,
            commands::respond_approval,
            commands::new_session,
            commands::open_login_help,
            commands::open_path,
            commands::resolve_preview_path,
            commands::tts_speak,
            commands::ditto_speak,
            commands::stt_transcribe,
        ])
        .setup(|app| {
            #[cfg(target_os = "linux")]
            allow_webkit_media_permissions(app);
            // One-shot Iris avatar registration with the Ditto server,
            // backgrounded so it doesn't block app startup. Idempotent
            // on the server (re-POST of an existing id is a no-op), so
            // the worst case is a wasted request if the user hits a
            // first-launch flow twice. Failures are logged but do not
            // abort the app — the TTS-only path still works without a
            // registered avatar.
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let persona = &persona::IRIS;
                if ditto::is_avatar_registered(persona).await {
                    eprintln!("[ditto] avatar `{}` already registered", persona.avatar_id);
                    return;
                }
                eprintln!("[ditto] registering avatar `{}`...", persona.avatar_id);
                match ditto::register_avatar(persona).await {
                    Ok(()) => eprintln!("[ditto] avatar registered"),
                    Err(e) => {
                        eprintln!("[ditto] avatar registration failed: {e}");
                        use tauri::Emitter;
                        let _ = app_handle.emit(
                            "ditto_register_error",
                            serde_json::json!({ "message": e }),
                        );
                    }
                }
            });
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
