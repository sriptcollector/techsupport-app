// Tech Support's native side: the menu bar / tray button, the three windows (panel, overlay, report),
// screenshots, mouse and keyboard, the sign-in loopback, and the macOS permission checks.
// The AI never runs here; it decides on the server and the panel's code asks this side to act.
// Safety rules that must not depend on the AI's judgment live here too (see `guard_text`).
mod input;
mod perms;
mod screen;

use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, Rect, WebviewWindow,
};

#[derive(Default)]
struct TrayRect(Mutex<Option<Rect>>);

#[derive(Serialize)]
struct Env {
    os: &'static str,
    version: String,
    server: Option<String>,
    test_session: Option<String>,
    show_in_capture: bool,
    autopilot: Option<String>,
}

#[tauri::command]
fn env_info(app: AppHandle) -> Env {
    Env {
        os: if cfg!(target_os = "macos") { "mac" } else { "windows" },
        version: app.package_info().version.to_string(),
        // Only for our own CI consumer test (staging server + a staging test session).
        server: std::env::var("TECHSUPPORT_SERVER").ok(),
        test_session: std::env::var("TECHSUPPORT_TEST_SESSION").ok(),
        show_in_capture: std::env::var("TECHSUPPORT_SHOW_IN_CAPTURE").is_ok(),
        autopilot: std::env::var("TECHSUPPORT_AUTOPILOT").ok(),
    }
}

/// CI consumer test only: the scripted "person" writes what happened to a log the workflow reads.
#[tauri::command]
fn autopilot_log(line: String) {
    if let Ok(path) = std::env::var("TECHSUPPORT_AUTOPILOT_LOG") {
        use std::io::Write as _;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{line}");
        }
    }
}

fn session_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("session"))
}
#[tauri::command]
fn session_get(app: AppHandle) -> Option<String> {
    std::fs::read_to_string(session_file(&app)?).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}
#[tauri::command]
fn session_set(app: AppHandle, token: Option<String>) {
    if let Some(f) = session_file(&app) {
        match token {
            Some(t) => {
                let _ = std::fs::write(f, t);
            }
            None => {
                let _ = std::fs::remove_file(f);
            }
        }
    }
}

/// Google sign-in: listen on a random local port, open the browser, and wait for the server to send
/// the browser back to us with the session. Only a matching `state` is accepted.
#[tauri::command]
async fn google_signin(app: AppHandle, server: String) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let state: String = (0..24).map(|_| format!("{:x}", rand::random::<u8>() % 16)).collect();
    let url = format!("{server}/auth/google/start?port={port}&state={state}");
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())?;
    let done_page = format!("{server}/signed-in");
    tauri::async_runtime::spawn_blocking(move || {
        listener.set_nonblocking(false).ok();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(600);
        for stream in listener.incoming() {
            if std::time::Instant::now() > deadline {
                break;
            }
            let Ok(mut s) = stream else { continue };
            let mut line = String::new();
            let _ = BufReader::new(&s).read_line(&mut line);
            let path = line.split_whitespace().nth(1).unwrap_or("");
            let q = path.split_once('?').map(|x| x.1).unwrap_or("");
            let get = |k: &str| q.split('&').find_map(|kv| kv.split_once('=').filter(|(a, _)| *a == k).map(|(_, v)| urldecode(v)));
            if path.starts_with("/signed-in") && get("state").as_deref() == Some(state.as_str()) {
                if let Some(token) = get("token") {
                    let _ = write!(s, "HTTP/1.1 302 Found\r\nLocation: {done_page}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    if let Some(w) = app.get_webview_window("panel") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                    return Ok(token);
                }
            }
            let _ = write!(s, "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        }
        Err("timeout".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn urldecode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
                out.push(b'%');
            }
            b'+' => out.push(b' '),
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Puts the panel just under the menu bar icon (Mac) or just above the tray icon (Windows).
#[tauri::command]
fn place_panel(app: AppHandle, width: f64, height: f64) {
    let Some(w) = app.get_webview_window("panel") else { return };
    let _ = w.set_size(tauri::LogicalSize::new(width, height));
    let Ok(Some(mon)) = w.primary_monitor() else { return };
    let scale = mon.scale_factor();
    let msize = mon.size();
    let (pw, ph) = ((width * scale) as i32, (height * scale) as i32);
    let rect = app.state::<TrayRect>().0.lock().unwrap().clone();
    let margin = (8.0 * scale) as i32;
    let pos = if cfg!(target_os = "macos") {
        let x = rect.as_ref().map(|r| r.position.to_physical::<i32>(scale).x).unwrap_or(msize.width as i32 - pw - margin);
        PhysicalPosition::new((x - pw / 2 + (12.0 * scale) as i32).clamp(margin, msize.width as i32 - pw - margin), (30.0 * scale) as i32)
    } else {
        let x = rect.as_ref().map(|r| r.position.to_physical::<i32>(scale).x).unwrap_or(msize.width as i32 - pw - margin);
        PhysicalPosition::new((x - pw / 2).clamp(margin, msize.width as i32 - pw - margin), (msize.height as i32 - ph - (56.0 * scale) as i32).max(margin))
    };
    let _ = w.set_position(pos);
}

/// Covers the main screen with the see-through overlay. `interactive` = it takes clicks (bug mode).
#[tauri::command]
fn overlay_mode(app: AppHandle, visible: bool, interactive: bool) {
    let Some(w) = app.get_webview_window("overlay") else { return };
    if visible {
        if let Ok(Some(mon)) = w.primary_monitor() {
            let _ = w.set_position(*mon.position());
            let _ = w.set_size(*mon.size());
        }
        let _ = w.set_ignore_cursor_events(!interactive);
        let _ = w.show();
        if interactive {
            let _ = w.set_focus();
        }
    } else {
        let _ = w.set_ignore_cursor_events(true);
        let _ = w.hide();
    }
}

fn protect(w: &WebviewWindow) {
    // The helper's own windows never appear in the screenshots the AI sees.
    if std::env::var("TECHSUPPORT_SHOW_IN_CAPTURE").is_err() {
        let _ = w.set_content_protected(true);
    }
}

fn toggle_panel(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("panel") {
        if w.is_visible().unwrap_or(false) {
            let _ = app.emit_to("panel", "panel-toggle", false);
        } else {
            let _ = app.emit_to("panel", "panel-toggle", true);
        }
    }
}

#[cfg(windows)]
fn allow_mic(w: &WebviewWindow) {
    // WebView2 would otherwise show its own "allow microphone" pop-up; the person already chose a
    // help button that turns the mic on, which is the consent (and Windows shows its mic icon).
    use webview2_com::{Microsoft::Web::WebView2::Win32::*, PermissionRequestedEventHandler};
    let _ = w.with_webview(|wv| unsafe {
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let mut token = Default::default();
        let _ = core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                if let Some(a) = args {
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                    a.PermissionKind(&mut kind)?;
                    if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                        a.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                    }
                }
                Ok(())
            })),
            &mut token,
        );
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = app.emit_to("panel", "panel-toggle", true);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .manage(TrayRect::default())
        .invoke_handler(tauri::generate_handler![
            env_info,
            autopilot_log,
            session_get,
            session_set,
            google_signin,
            place_panel,
            overlay_mode,
            screen::capture,
            screen::windows_list,
            input::act,
            input::cursor,
            perms::perms_status,
            perms::perms_open,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            for label in ["panel", "overlay", "report"] {
                if let Some(w) = app.get_webview_window(label) {
                    protect(&w);
                    #[cfg(windows)]
                    allow_mic(&w);
                }
            }
            if let Some(o) = app.get_webview_window("overlay") {
                let _ = o.set_ignore_cursor_events(true);
            }

            let open = MenuItem::with_id(app, "open", "Open Tech Support", true, None::<&str>)?;
            let report = MenuItem::with_id(app, "report", "Report a bug", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &report, &quit])?;
            let icon = if cfg!(target_os = "macos") {
                tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png"))?
            } else {
                tauri::image::Image::from_bytes(include_bytes!("../icons/tray-color.png"))?
            };
            #[allow(unused_mut)]
            let mut tray = TrayIconBuilder::with_id("main")
                .icon(icon)
                .tooltip("Tech Support")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => {
                        let _ = app.emit_to("panel", "panel-toggle", true);
                    }
                    "report" => {
                        let _ = app.emit_to("report", "report-open", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } = event {
                        *tray.app_handle().state::<TrayRect>().0.lock().unwrap() = Some(rect);
                        toggle_panel(tray.app_handle());
                    }
                });
            #[cfg(target_os = "macos")]
            {
                tray = tray.icon_as_template(true).title("Tech Support");
            }
            tray.build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Tech Support");
}
