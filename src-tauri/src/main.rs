#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod commands;
mod persona;
mod state;
mod stt;
mod tts;

use state::AppState;

fn main() {
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
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::auth_status,
            commands::persona_info,
            commands::submit_task,
            commands::respond_approval,
            commands::new_session,
            commands::open_login_help,
            commands::open_path,
            commands::resolve_preview_path,
            commands::tts_speak,
            commands::stt_transcribe,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
