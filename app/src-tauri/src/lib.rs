// Tech Support's native side: the menu bar / tray button, the three windows (panel, overlay, report),
// screenshots, mouse and keyboard, the sign-in loopback, and the macOS permission checks.
// The AI never runs here; it decides on the server and the panel's code asks this side to act.
// Safety rules that must not depend on the AI's judgment live here too (see `guard_text`).
mod input;
mod perms;
mod extra;
mod quick;
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

/// CI consumer test only: a recorded voice stands in for the microphone (the test machines have none).
#[tauri::command]
fn test_audio() -> Option<String> {
    use base64::Engine;
    let path = std::env::var("TECHSUPPORT_TEST_AUDIO").ok()?;
    std::fs::read(path).ok().map(|b| base64::engine::general_purpose::STANDARD.encode(b))
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
                    panel_front(app.clone(), true);
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

/// While the helper works, Tech Support must never hold the keyboard: otherwise what it types lands in
/// its own window (Orion's report, 2026-11-11). The panel stops taking focus and, on a Mac, our app
/// steps back so the app the person was using is in front again.
#[tauri::command]
fn walk_focus(app: AppHandle, walking: bool) {
    if let Some(w) = app.get_webview_window("panel") {
        let _ = w.set_focusable(!walking);
    }
    if walking {
        #[cfg(target_os = "macos")]
        {
            let _ = app.hide();
            if let Some(w) = app.get_webview_window("panel") {
                let _ = w.show();
            }
            if let Some(o) = app.get_webview_window("overlay") {
                let _ = o.show();
            }
        }
    }
}

/// Brings the panel to the front. On a Mac the app is a menu bar app (Accessory) and `walk_focus` may
/// have hidden the whole app, so showing the window alone left it invisible and the menu bar icon
/// "did nothing" (Mac test, 2026-11-12). Unhide and activate the app first, then order the panel front.
#[tauri::command]
fn panel_front(app: AppHandle, focus: bool) {
    let Some(w) = app.get_webview_window("panel") else { return };
    #[cfg(target_os = "macos")]
    {
        let _ = app.show();
    }
    let _ = w.unminimize();
    let _ = w.set_always_on_top(true);
    // Follow the person to whatever desktop (Space) or full-screen app they are in.
    let _ = w.set_visible_on_all_workspaces(true);
    let _ = w.show();
    eprintln!("[panel] front focus={focus} visible_after={:?}", w.is_visible());
    if focus {
        let _ = w.set_focus();
    }
    #[cfg(target_os = "macos")]
    mac_front(&app, &w, focus);
}

#[cfg(target_os = "macos")]
fn mac_front(app: &AppHandle, w: &WebviewWindow, focus: bool) {
    let w = w.clone();
    let _ = app.run_on_main_thread(move || {
        use objc2::MainThreadMarker;
        use objc2_app_kit::{NSApplication, NSWindow};
        let Some(mtm) = MainThreadMarker::new() else { return };
        let ns = NSApplication::sharedApplication(mtm);
        #[allow(deprecated, unused_unsafe)]
        unsafe {
            ns.unhide(None);
            if focus {
                ns.activateIgnoringOtherApps(true);
            }
        }
        if let Ok(ptr) = w.ns_window() {
            let win: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
            #[allow(unused_unsafe)]
            unsafe {
                win.setLevel(25); // NSStatusWindowLevel: above normal and floating windows, like a menu bar panel
                win.orderFrontRegardless();
                if focus {
                    win.makeKeyAndOrderFront(None);
                }
            }
        }
    });
}

/// Screen recording only takes effect after a relaunch: quit and reopen ourselves (the setup step resumes).
#[tauri::command]
fn relaunch(app: AppHandle) {
    app.restart();
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

/// Bug mode: moves the panel to the screen edge farthest from the window the person picked.
#[tauri::command]
fn panel_away(app: AppHandle, x: f64, w: f64) {
    let Some(p) = app.get_webview_window("panel") else { return };
    let Ok(Some(mon)) = p.primary_monitor() else { return };
    let scale = mon.scale_factor();
    let (mw, mh) = (mon.size().width as f64 / scale, mon.size().height as f64 / scale);
    let Ok(sz) = p.outer_size() else { return };
    let (pw, ph) = (sz.width as f64 / scale, sz.height as f64 / scale);
    let left_room = x;
    let right_room = mw - (x + w);
    let px = if right_room >= left_room { mw - pw - 12.0 } else { 12.0 };
    let _ = p.set_position(tauri::LogicalPosition::new(px.max(0.0), ((mh - ph) / 2.0).max(8.0)));
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

fn protect(_w: &WebviewWindow) {
    // Our windows stay visible to the person's own screenshots and screen sharing (a grandkid helping
    // over Zoom must see them). They're hidden only for the instant the AI takes its picture (api.ts).
}

fn toggle_panel(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("panel") {
        let visible = w.is_visible().unwrap_or(false);
        let focused = w.is_focused().unwrap_or(false);
        eprintln!("[panel] toggle visible={visible} focused={focused}");
        // Behind another app the panel still counts as visible (Mac test v0.1.27: 6 clicks said
        // visible=true and nothing came forward). Only close it when it is really in front.
        if visible && focused {
            let _ = app.emit_to("panel", "panel-toggle", false);
        } else {
            // Show it natively first: the webview may be asleep while the app is hidden (Mac test 2026-11-12),
            // so the page only picks the view and size afterwards.
            panel_front(app.clone(), true);
            let _ = app.emit_to("panel", "panel-toggle", true);
        }
    }
}

/// The keyboard shortcut and the menu bar icon do the same thing.
#[tauri::command]
fn panel_toggle(app: AppHandle) {
    toggle_panel(&app);
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .manage(TrayRect::default())
        .invoke_handler(tauri::generate_handler![
            env_info,
            autopilot_log,
            test_audio,
            session_get,
            session_set,
            google_signin,
            place_panel,
            overlay_mode,
            panel_away,
            relaunch,
            walk_focus,
            screen::capture,
            screen::windows_list,
            input::act,
            input::cursor,
            quick::quick,
            perms::perms_status,
            perms::perms_open,
            panel_front,
            panel_toggle,
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
