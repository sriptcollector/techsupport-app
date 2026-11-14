// Screenshots of the main screen, scaled down and JPEG-compressed before they leave the computer,
// plus the list of windows (for "Select the bug"). Coordinates handed to the web side are logical
// points (CSS pixels on the overlay); the image's own pixel size is reported separately.
use base64::Engine;
use image::{imageops::FilterType, DynamicImage, ImageFormat};
use serde::Serialize;
use std::io::Cursor;
use xcap::{Monitor, Window};

#[derive(Serialize)]
pub struct Shot {
    data: String,  // base64 JPEG
    w: u32,        // image width in pixels (what the AI sees)
    h: u32,
    sw: f64,       // screen width in logical points
    sh: f64,
    scale: f64,    // physical pixels per logical point
}

fn primary() -> Result<Monitor, String> {
    let all = Monitor::all().map_err(|e| e.to_string())?;
    all.iter().find(|m| m.is_primary().unwrap_or(false)).cloned().or_else(|| all.into_iter().next()).ok_or("no screen".into())
}

pub fn monitor_scale() -> f64 {
    primary().ok().and_then(|m| m.scale_factor().ok()).map(|s| s as f64).unwrap_or(1.0)
}

/// On a Mac we use Apple's own `screencapture` tool (it goes through ScreenCaptureKit), not the old
/// window-list API: newer macOS shows an extra "bypass the private window picker" box to apps using
/// the old API on every capture. JPEG, not PNG: on a Retina screen the PNG round trip took over a
/// second per step (Orion, 2026-11-13: "terrible slow and glitches" on his Mac). Windows uses the
/// normal capture.
fn grab(m: &Monitor) -> Result<DynamicImage, String> {
    #[cfg(target_os = "macos")]
    {
        let _ = m;
        // One file per picture: two pictures at once (the setup check and the helper) shared one name,
        // and one deleted the other's file ("I can't see your screen yet", Mac test 2026-11-14).
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("ts-shot-{}-{n}.jpg", std::process::id()));
        let st = std::process::Command::new("/usr/sbin/screencapture").args(["-x", "-m", "-t", "jpg"]).arg(&path).status().map_err(|e| e.to_string())?;
        if !st.success() {
            return Err("screen capture was refused".into());
        }
        let img = image::open(&path).map_err(|e| e.to_string());
        let _ = std::fs::remove_file(&path);
        return img;
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(DynamicImage::ImageRgba8(m.capture_image().map_err(|e| e.to_string())?))
    }
}

/// Mac: our windows step aside for the AI's picture by going fully see-through in the window server
/// (one frame), instead of the web page hiding itself and repainting (that blinked the helper off
/// for over a second each step). `false` puts them back.
#[cfg(target_os = "macos")]
pub fn mac_veil(app: &tauri::AppHandle, on: bool) {
    use tauri::Manager;
    let wins: Vec<_> = ["panel", "overlay", "report"].iter().filter_map(|l| app.get_webview_window(l)).collect();
    let (tx, rx) = std::sync::mpsc::channel();
    let _ = app.run_on_main_thread(move || {
        for w in wins {
            if let Ok(ptr) = w.ns_window() {
                let win: &objc2_app_kit::NSWindow = unsafe { &*(ptr as *const objc2_app_kit::NSWindow) };
                #[allow(unused_unsafe)]
                unsafe {
                    win.setAlphaValue(if on { 0.0 } else { 1.0 });
                }
            }
        }
        let _ = tx.send(());
    });
    let _ = rx.recv_timeout(std::time::Duration::from_millis(500));
    if on {
        // Let the window server show the change before the picture is taken.
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// `region` (logical x, y, w, h) crops to one window; `max` is the longest side in pixels.
#[tauri::command]
pub async fn capture(app: tauri::AppHandle, region: Option<(f64, f64, f64, f64)>, max: Option<u32>) -> Result<Shot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let m = primary()?;
        let scale = m.scale_factor().map_err(|e| e.to_string())? as f64;
        #[cfg(target_os = "macos")]
        mac_veil(&app, true);
        let got = grab(&m);
        #[cfg(target_os = "macos")]
        mac_veil(&app, false);
        let _ = &app;
        let mut img = got?;
        let (pw, ph) = (img.width() as f64, img.height() as f64);
        let (mut sw, mut sh) = (pw / scale, ph / scale);
        if let Some((x, y, w, h)) = region {
            let (cx, cy) = ((x * scale).max(0.0) as u32, (y * scale).max(0.0) as u32);
            let cw = ((w * scale) as u32).min(pw as u32 - cx.min(pw as u32 - 1));
            let ch = ((h * scale) as u32).min(ph as u32 - cy.min(ph as u32 - 1));
            img = img.crop_imm(cx, cy, cw.max(1), ch.max(1));
            sw = cw as f64 / scale;
            sh = ch as f64 / scale;
        }
        let max = max.unwrap_or(1280) as f64;
        let k = (max / img.width().max(img.height()) as f64).min(1.0);
        // `thumbnail` is a fast box filter: on a 5K Retina picture the triangle filter alone cost ~0.3 s.
        let (tw, th) = ((img.width() as f64 * k) as u32, (img.height() as f64 * k) as u32);
        let out = if k < 1.0 { if cfg!(target_os = "macos") { img.thumbnail(tw, th) } else { img.resize(tw, th, FilterType::Triangle) } } else { img };
        let rgb = DynamicImage::ImageRgb8(out.to_rgb8());
        let mut buf = Cursor::new(Vec::new());
        rgb.write_to(&mut buf, ImageFormat::Jpeg).map_err(|e| e.to_string())?;
        Ok(Shot { data: base64::engine::general_purpose::STANDARD.encode(buf.into_inner()), w: rgb.width(), h: rgb.height(), sw, sh, scale })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct Win {
    title: String,
    app: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// Visible, normal-sized windows from front to back, in logical points.
#[tauri::command]
pub fn windows_list() -> Vec<Win> {
    let scale = if cfg!(windows) { monitor_scale() } else { 1.0 };
    let me = std::process::id();
    Window::all()
        .unwrap_or_default()
        .into_iter()
        .filter(|w| !w.is_minimized().unwrap_or(true))
        .filter(|w| w.pid().map(|p| p != me).unwrap_or(true))
        .filter_map(|w| {
            let (x, y, ww, hh) = (w.x().ok()? as f64, w.y().ok()? as f64, w.width().ok()? as f64, w.height().ok()? as f64);
            if ww < 60.0 || hh < 40.0 {
                return None;
            }
            let app = w.app_name().unwrap_or_default();
            let title = w.title().unwrap_or_default();
            if app.is_empty() && title.is_empty() {
                return None;
            }
            // Never offer our own windows (the overlay covers the whole screen).
            if app == "Tech Support" || app == "tech-support" || title.starts_with("Tech Support") || title == "Report a bug" {
                return None;
            }
            Some(Win { title, app, x: x / scale, y: y / scale, w: ww / scale, h: hh / scale })
        })
        .collect()
}
