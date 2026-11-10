// Mouse and keyboard. Everything here takes logical points (the overlay's CSS pixels).
// Hard blocks that don't depend on the AI's judgment (scope 6.6) are enforced in `guard_text`:
// it refuses to type card numbers, social security numbers or anything that looks like a password
// or one-time code. These rules are open source and can't be changed from the server.
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(tag = "do", rename_all = "snake_case")]
pub enum Action {
    Move { x: f64, y: f64 },
    Click { x: Option<f64>, y: Option<f64>, button: Option<String>, count: Option<u32>, modifiers: Option<String> },
    Down,
    Up,
    Drag { from: (f64, f64), to: (f64, f64) },
    Scroll { x: Option<f64>, y: Option<f64>, direction: String, amount: Option<i32> },
    Type { text: String },
    Key { combo: String, repeat: Option<u32> },
}

fn to_native(x: f64, y: f64) -> (i32, i32) {
    // macOS posts events in points; Windows (per-monitor DPI aware) in physical pixels.
    let s = if cfg!(windows) { crate::screen::monitor_scale() } else { 1.0 };
    ((x * s).round() as i32, (y * s).round() as i32)
}

fn luhn(d: &str) -> bool {
    let mut sum = 0;
    for (i, c) in d.chars().rev().enumerate() {
        let mut n = c.to_digit(10).unwrap_or(0);
        if i % 2 == 1 {
            n *= 2;
            if n > 9 {
                n -= 9;
            }
        }
        sum += n;
    }
    sum % 10 == 0
}

pub fn guard_text(t: &str) -> Result<(), String> {
    let digits: String = t.chars().filter(|c| c.is_ascii_digit()).collect();
    let only_number_like = t.chars().all(|c| c.is_ascii_digit() || c == ' ' || c == '-');
    if only_number_like && (13..=19).contains(&digits.len()) && luhn(&digits) {
        return Err("card_number".into());
    }
    let ssn = t.split(|c: char| !(c.is_ascii_digit() || c == '-')).any(|w| {
        let p: Vec<&str> = w.split('-').collect();
        p.len() == 3 && p[0].len() == 3 && p[1].len() == 2 && p[2].len() == 4 && p.iter().all(|x| x.chars().all(|c| c.is_ascii_digit()))
    });
    if ssn {
        return Err("ssn".into());
    }
    if only_number_like && (6..=8).contains(&digits.len()) && digits.len() == t.trim().len() {
        return Err("code".into()); // a bare PIN or one-time code: the person types those
    }
    Ok(())
}

fn key_of(name: &str) -> Option<Key> {
    let n = name.trim().to_lowercase();
    Some(match n.as_str() {
        "return" | "enter" => Key::Return,
        "tab" => Key::Tab,
        "escape" | "esc" => Key::Escape,
        "space" => Key::Space,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "up" | "arrowup" => Key::UpArrow,
        "down" | "arrowdown" => Key::DownArrow,
        "left" | "arrowleft" => Key::LeftArrow,
        "right" | "arrowright" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" | "page_up" => Key::PageUp,
        "pagedown" | "page_down" => Key::PageDown,
        "shift" => Key::Shift,
        "ctrl" | "control" => Key::Control,
        "alt" | "option" => Key::Alt,
        "super" | "cmd" | "command" | "meta" | "win" | "windows" => Key::Meta,
        "plus" => Key::Unicode('+'),
        "minus" => Key::Unicode('-'),
        "equal" | "equals" => Key::Unicode('='),
        "comma" => Key::Unicode(','),
        "period" => Key::Unicode('.'),
        "slash" => Key::Unicode('/'),
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f11" => Key::F11,
        "f12" => Key::F12,
        s if s.chars().count() == 1 => Key::Unicode(s.chars().next().unwrap()),
        _ => return None,
    })
}

fn with_mods<F: FnOnce(&mut Enigo) -> Result<(), String>>(e: &mut Enigo, mods: &Option<String>, f: F) -> Result<(), String> {
    let keys: Vec<Key> = mods.as_deref().unwrap_or("").split('+').filter(|s| !s.is_empty()).filter_map(key_of).collect();
    for k in &keys {
        e.key(*k, Direction::Press).map_err(|x| x.to_string())?;
    }
    let r = f(e);
    for k in keys.iter().rev() {
        let _ = e.key(*k, Direction::Release);
    }
    r
}

/// macOS only lets keyboard events be built on the main thread (doing it elsewhere crashes the app),
/// so on a Mac each step runs there; long typing goes one letter at a time so the screen keeps moving.
fn on_main<T: Send + 'static>(app: &tauri::AppHandle, f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    if cfg!(target_os = "macos") {
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(f());
        })
        .map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())
    } else {
        Ok(f())
    }
}

#[tauri::command]
pub async fn act(app: tauri::AppHandle, action: Action) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || match action {
        Action::Type { text } if text.chars().count() <= 120 => {
            guard_text(&text)?;
            for c in text.chars() {
                on_main(&app, move || run(Action::Type { text: c.to_string() }))??;
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Ok(())
        }
        other => on_main(&app, move || run(other))?,
    })
    .await
    .map_err(|e| e.to_string())?
}

fn run(action: Action) -> Result<(), String> {
    let mut e = Enigo::new(&Settings::default()).map_err(|x| x.to_string())?;
    let err = |x: enigo::InputError| x.to_string();
    match action {
        Action::Move { x, y } => {
            let (nx, ny) = to_native(x, y);
            e.move_mouse(nx, ny, Coordinate::Abs).map_err(err)
        }
        Action::Click { x, y, button, count, modifiers } => {
            if let (Some(x), Some(y)) = (x, y) {
                let (nx, ny) = to_native(x, y);
                e.move_mouse(nx, ny, Coordinate::Abs).map_err(err)?;
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
            let b = match button.as_deref() {
                Some("right") => Button::Right,
                Some("middle") => Button::Middle,
                _ => Button::Left,
            };
            with_mods(&mut e, &modifiers, |e| {
                for i in 0..count.unwrap_or(1).clamp(1, 3) {
                    if i > 0 {
                        std::thread::sleep(std::time::Duration::from_millis(60));
                    }
                    e.button(b, Direction::Click).map_err(|x| x.to_string())?;
                }
                Ok(())
            })
        }
        Action::Down => e.button(Button::Left, Direction::Press).map_err(err),
        Action::Up => e.button(Button::Left, Direction::Release).map_err(err),
        Action::Drag { from, to } => {
            let (fx, fy) = to_native(from.0, from.1);
            let (tx, ty) = to_native(to.0, to.1);
            e.move_mouse(fx, fy, Coordinate::Abs).map_err(err)?;
            e.button(Button::Left, Direction::Press).map_err(err)?;
            for i in 1..=12 {
                let k = i as f64 / 12.0;
                let _ = e.move_mouse(fx + ((tx - fx) as f64 * k) as i32, fy + ((ty - fy) as f64 * k) as i32, Coordinate::Abs);
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            e.button(Button::Left, Direction::Release).map_err(err)
        }
        Action::Scroll { x, y, direction, amount } => {
            if let (Some(x), Some(y)) = (x, y) {
                let (nx, ny) = to_native(x, y);
                e.move_mouse(nx, ny, Coordinate::Abs).map_err(err)?;
            }
            let n = amount.unwrap_or(3).clamp(1, 30);
            match direction.as_str() {
                "up" => e.scroll(-n, Axis::Vertical),
                "down" => e.scroll(n, Axis::Vertical),
                "left" => e.scroll(-n, Axis::Horizontal),
                _ => e.scroll(n, Axis::Horizontal),
            }
            .map_err(err)
        }
        Action::Type { text } => {
            guard_text(&text)?;
            // Short text arrives one letter at a time from `act` (about 20 a second, so the person can follow).
            e.text(&text).map_err(err)
        }
        Action::Key { combo, repeat } => {
            let parts: Vec<&str> = combo.split('+').collect();
            let (mods, last) = parts.split_at(parts.len().saturating_sub(1));
            let k = key_of(last.first().copied().unwrap_or("")).ok_or("unknown_key")?;
            let mods = Some(mods.join("+"));
            for _ in 0..repeat.unwrap_or(1).clamp(1, 50) {
                with_mods(&mut e, &mods, |e| e.key(k, Direction::Click).map_err(|x| x.to_string()))?;
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
            Ok(())
        }
    }
}

/// Where the real pointer is, in logical points (used to notice the person moving the mouse).
#[tauri::command]
pub async fn cursor(app: tauri::AppHandle) -> Option<(f64, f64)> {
    let (x, y) = on_main(&app, || Enigo::new(&Settings::default()).ok().and_then(|e| e.location().ok())).ok()??;
    let s = if cfg!(windows) { crate::screen::monitor_scale() } else { 1.0 };
    Some((x as f64 / s, y as f64 / s))
}

#[cfg(test)]
mod tests {
    use super::guard_text;
    #[test]
    fn blocks_cards_ssn_codes() {
        assert!(guard_text("4242 4242 4242 4242").is_err());
        assert!(guard_text("123-45-6789").is_err());
        assert!(guard_text("482913").is_err());
        assert!(guard_text("make text bigger").is_ok());
        assert!(guard_text("Display").is_ok());
        assert!(guard_text("2026").is_ok());
    }
}
