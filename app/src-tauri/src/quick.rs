// Quick actions: a small, closed set of system commands that do a job instantly instead of clicking
// through menus (Orion: "it should be able to run system commands and do things instantly").
// The AI can only pick from this list; it can never run its own commands. Each one is safe and either
// read-only or easy to undo, and the helper still says what it changed.
use std::process::Command;

fn run(cmd: &str, args: &[&str]) -> Result<String, String> {
    let mut c = Command::new(cmd);
    c.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // no console window
    }
    let out = c.output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    if out.status.success() {
        Ok(text.chars().take(1500).collect())
    } else {
        Err(text.chars().take(400).collect())
    }
}

/// Starts something (an app, a page) without waiting for it: the started app must not hold our pipes,
/// or we'd wait until it closes.
fn launch(cmd: &str, args: &[&str]) -> Result<String, String> {
    use std::process::Stdio;
    let mut c = Command::new(cmd);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c.spawn().map(|_| "opened".to_string()).map_err(|e| e.to_string())
}

fn safe_name(s: &str) -> Result<&str, String> {
    if !s.is_empty() && s.len() < 80 && s.chars().all(|c| c.is_alphanumeric() || " ._-()".contains(c)) {
        Ok(s)
    } else {
        Err("not a name I can use".into())
    }
}

/// Settings pages by plain name, for each system.
fn settings_link(pane: &str) -> Option<&'static str> {
    if cfg!(target_os = "macos") {
        Some(match pane {
            "display" => "x-apple.systempreferences:com.apple.Displays-Settings.extension",
            "text_size" | "accessibility_display" => "x-apple.systempreferences:com.apple.Accessibility-Settings.extension?Display",
            "accessibility" => "x-apple.systempreferences:com.apple.Accessibility-Settings.extension",
            "wifi" => "x-apple.systempreferences:com.apple.wifi-settings-extension",
            "bluetooth" => "x-apple.systempreferences:com.apple.BluetoothSettings",
            "printers" => "x-apple.systempreferences:com.apple.Print-Scan-Settings.extension",
            "sound" => "x-apple.systempreferences:com.apple.Sound-Settings.extension",
            "updates" => "x-apple.systempreferences:com.apple.Software-Update-Settings.extension",
            "notifications" => "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
            "privacy" => "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension",
            _ => return None,
        })
    } else {
        Some(match pane {
            "display" => "ms-settings:display",
            "text_size" | "accessibility_display" => "ms-settings:easeofaccess-display",
            "accessibility" => "ms-settings:easeofaccess",
            "wifi" => "ms-settings:network-wifi",
            "bluetooth" => "ms-settings:bluetooth",
            "printers" => "ms-settings:printers",
            "sound" => "ms-settings:sound",
            "updates" => "ms-settings:windowsupdate",
            "notifications" => "ms-settings:notifications",
            "privacy" => "ms-settings:privacy",
            _ => return None,
        })
    }
}

fn open(target: &str) -> Result<String, String> {
    if cfg!(target_os = "macos") {
        launch("open", &[target])
    } else {
        // Not through cmd, so nothing in a web address is treated as a command.
        launch("rundll32", &["url.dll,FileProtocolHandler", target])
    }
}

#[tauri::command]
pub async fn quick(action: String, arg: Option<String>) -> Result<String, String> {
    let arg = arg.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        match action.as_str() {
            "open_settings" => open(settings_link(&arg).ok_or("unknown settings page")?),
            "open_url" => {
                if !(arg.starts_with("https://") || arg.starts_with("http://")) || arg.len() > 500 || arg.chars().any(|c| c.is_whitespace() || "\"'`<>".contains(c)) {
                    return Err("only plain web addresses".into());
                }
                open(&arg)
            }
            "open_app" => {
                let name = safe_name(&arg)?;
                if cfg!(target_os = "macos") {
                    launch("open", &["-a", name])
                } else {
                    launch("cmd", &["/c", "start", "", name])
                }
            }
            "list_printers" => {
                if cfg!(target_os = "macos") {
                    run("lpstat", &["-p"])
                } else {
                    run("powershell", &["-NoProfile", "-Command", "Get-Printer | Select-Object Name,PrinterStatus,WorkOffline | Format-Table -AutoSize | Out-String -Width 200"])
                }
            }
            "resume_printer" => {
                let name = safe_name(&arg)?;
                if cfg!(target_os = "macos") {
                    let q = name.replace(' ', "_");
                    run("cupsenable", &[&q]).or_else(|_| run("cupsenable", &[name]))?;
                    run("lpstat", &["-p", &q]).or_else(|_| Ok("resumed".into()))
                } else {
                    let ps = format!("$p = Get-CimInstance Win32_Printer -Filter \"Name='{}'\"; $p | Invoke-CimMethod -MethodName Resume | Out-Null; Set-Printer -Name '{}' -ErrorAction SilentlyContinue; (Get-Printer -Name '{}').PrinterStatus", name, name, name);
                    run("powershell", &["-NoProfile", "-Command", &ps])
                }
            }
            "wifi_status" => {
                if cfg!(target_os = "macos") {
                    run("networksetup", &["-getairportpower", "en0"])
                } else {
                    run("netsh", &["wlan", "show", "interfaces"])
                }
            }
            "wifi_on" => {
                if cfg!(target_os = "macos") {
                    run("networksetup", &["-setairportpower", "en0", "on"]).map(|_| "Wi-Fi turned on".into())
                } else {
                    run("netsh", &["interface", "set", "interface", "Wi-Fi", "enabled"]).map(|_| "Wi-Fi turned on".into())
                }
            }
            _ => crate::extra::extra(&action, &arg).unwrap_or_else(|| Err("unknown quick action".into())),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
