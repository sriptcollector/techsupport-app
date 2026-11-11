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
/// the old API on every capture. Windows uses the normal capture.
fn grab(m: &Monitor) -> Result<DynamicImage, String> {
    #[cfg(target_os = "macos")]
    {
        let _ = m;
        let path = std::env::temp_dir().join(format!("ts-shot-{}.png", std::process::id()));
        let st = std::process::Command::new("/usr/sbin/screencapture").args(["-x", "-m", "-t", "png"]).arg(&path).status().map_err(|e| e.to_string())?;
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

/// `region` (logical x, y, w, h) crops to one window; `max` is the longest side in pixels.
#[tauri::command]
pub async fn capture(region: Option<(f64, f64, f64, f64)>, max: Option<u32>) -> Result<Shot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let m = primary()?;
        let scale = m.scale_factor().map_err(|e| e.to_string())? as f64;
        let mut img = grab(&m)?;
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
        let out = if k < 1.0 { img.resize((img.width() as f64 * k) as u32, (img.height() as f64 * k) as u32, FilterType::Triangle) } else { img };
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
            if ww < 120.0 || hh < 80.0 {
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
