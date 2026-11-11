// More quick actions: each one DOES the fix (changes the setting) instead of listing steps.
// A closed list with validated arguments; the helper can never run its own command.
// Windows runs the scripts in src/ps/ (arguments are checked here before they are put in);
// macOS uses the built-in command line tools.
use std::process::Command;

const MAC: bool = cfg!(target_os = "macos");

fn run(cmd: &str, args: &[&str]) -> Result<String, String> {
    let mut c = Command::new(cmd);
    c.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let out = c.output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    if out.status.success() {
        Ok(text.trim().chars().take(1500).collect())
    } else {
        Err(text.trim().chars().take(500).collect())
    }
}

/// Runs one of our own PowerShell scripts. The argument is checked first and goes in as plain text.
fn ps(script: &str, arg: &str) -> Result<String, String> {
    use base64::Engine;
    if !arg.chars().all(|c| c.is_alphanumeric() || " ._-()".contains(c)) || arg.len() > 80 {
        return Err("not an argument I can use".into());
    }
    let body = format!("$ErrorActionPreference='Stop'\n{}", script.replace("__ARG__", arg));
    let utf16: Vec<u8> = body.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let enc = base64::engine::general_purpose::STANDARD.encode(utf16);
    run("powershell", &["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &enc])
}

fn digits(arg: &str, lo: u32, hi: u32) -> Result<u32, String> {
    arg.trim().trim_end_matches('%').parse::<u32>().ok().filter(|n| *n >= lo && *n <= hi).ok_or_else(|| format!("needs a number from {lo} to {hi}"))
}

fn osa(script: &str) -> Result<String, String> {
    run("osascript", &["-e", script])
}

fn mac_wifi_device() -> String {
    let t = run("networksetup", &["-listallhardwareports"]).unwrap_or_default();
    let mut next = false;
    for l in t.lines() {
        if l.contains("Hardware Port: Wi-Fi") || l.contains("Hardware Port: AirPort") {
            next = true;
        } else if next && l.starts_with("Device:") {
            return l.trim_start_matches("Device:").trim().to_string();
        }
    }
    "en0".into()
}

fn home() -> String {
    std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default()
}

fn dir_size(p: &std::path::Path) -> u64 {
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            let m = e.metadata();
            match m {
                Ok(m) if m.is_dir() => n += dir_size(&e.path()),
                Ok(m) => n += m.len(),
                _ => {}
            }
        }
    }
    n
}

fn empty_dir(p: &std::path::Path) -> u64 {
    let before = dir_size(p);
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            let path = e.path();
            let _ = if path.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
        }
    }
    before.saturating_sub(dir_size(p))
}

/// Checks a pasted message the way a careful friend would. Rule based and local: nothing leaves the computer.
pub fn scam_check(text: &str) -> String {
    let t = text.to_lowercase();
    let mut why: Vec<&str> = vec![];
    let has = |words: &[&str]| words.iter().any(|w| t.contains(w));
    if has(&["gift card", "itunes card", "google play card", "bitcoin", "wire transfer", "zelle", "western union", "crypto"]) { why.push("asks for gift cards, crypto or a wire (real companies never do)"); }
    if has(&["remote access", "anydesk", "teamviewer", "quick assist", "ultraviewer", "install this to"]) { why.push("asks you to give someone remote access to your computer"); }
    if has(&["call this number", "call us immediately", "call now", "toll free", "toll-free", "do not hang up", "don't hang up"]) { why.push("pushes you to call a phone number now"); }
    if has(&["urgent", "immediately", "within 24 hours", "act now", "final notice", "suspended", "locked", "will be closed", "unauthorized", "unusual activity", "arrest", "warrant"]) { why.push("uses fear or a deadline to rush you"); }
    if has(&["verify your account", "confirm your password", "your password", "social security", "ssn", "card number", "one-time code", "verification code", "otp", "pin number"]) { why.push("asks for a password, code, card or social security number"); }
    if has(&["you have won", "you've won", "prize", "lottery", "inheritance", "refund is waiting", "unclaimed"]) { why.push("promises money or a prize you did not ask for"); }
    if has(&["virus detected", "your computer is infected", "your pc is infected", "security alert", "windows defender alert", "apple support"]) { why.push("says your computer is infected (a pop-up cannot know that)"); }
    for w in text.split_whitespace() {
        let w = w.trim_matches(|c: char| !c.is_alphanumeric() && !"/:.-_@%".contains(c)).to_lowercase();
        if w.starts_with("http://") || w.starts_with("https://") || w.starts_with("www.") {
            let host = w.trim_start_matches("https://").trim_start_matches("http://").split('/').next().unwrap_or("").to_string();
            if host.starts_with("xn--") || host.contains(".xn--") { why.push("has a web address with disguised letters"); }
            if host.chars().all(|c| c.is_ascii_digit() || c == '.') && host.contains('.') { why.push("links to a bare number address, not a company name"); }
            if ["bit.ly", "tinyurl.com", "t.co", "goo.gl", "is.gd", "cutt.ly", "rb.gy"].iter().any(|s| host == *s) { why.push("hides where its link goes (shortened link)"); }
            if host.matches('-').count() >= 2 || host.matches('.').count() >= 4 { why.push("has an odd, long web address"); }
        }
    }
    why.sort();
    why.dedup();
    let verdict = match why.len() {
        0 => "No scam signs found in the words. That does not prove it is safe: if you did not expect it, do not click or reply. Go to the company's own site by typing its name.",
        1 => "Be careful. One scam sign found.",
        _ => "This looks like a scam. Do not reply, click or call.",
    };
    if why.is_empty() { verdict.into() } else { format!("{verdict} Signs: {}.", why.join("; ")) }
}

pub fn extra(action: &str, arg: &str) -> Option<Result<String, String>> {
    Some(match action {
        "scam_check" => Ok(scam_check(arg)),
        "text_size" => {
            if MAC { return Some(Err("The Mac has no safe one-step way to do this. Use open_settings text_size and move the slider yourself with the computer tools.".into())); }
            digits(arg, 100, 225).and_then(|n| ps(include_str!("ps/text_size.ps1"), &n.to_string()))
        }
        "volume" => {
            let a = arg.trim().to_lowercase();
            if !(matches!(a.as_str(), "unmute" | "up" | "down" | "status") || digits(&a, 0, 100).is_ok()) { return Some(Err("volume needs unmute, up, down, status or a number from 0 to 100".into())); }
            if MAC {
                match a.as_str() {
                    "unmute" => osa("set volume output muted false").and_then(|_| osa("if (output volume of (get volume settings)) < 30 then set volume output volume 50")).and_then(|_| osa("get volume settings")).map(|s| format!("Unmuted. {s}")),
                    "up" => osa("set volume output muted false").and_then(|_| osa("set volume output volume (((output volume of (get volume settings)) + 20) as integer)")).and_then(|_| osa("get volume settings")),
                    "down" => osa("set volume output volume (((output volume of (get volume settings)) - 20) as integer)").and_then(|_| osa("get volume settings")),
                    "status" => osa("get volume settings"),
                    n => osa("set volume output muted false").and_then(|_| osa(&format!("set volume output volume {}", n.trim_end_matches('%')))).and_then(|_| osa("get volume settings")),
                }
            } else {
                ps(include_str!("ps/volume.ps1"), &a)
            }
        }
        "wifi_reconnect" => {
            if MAC {
                let dev = mac_wifi_device();
                let r = run("networksetup", &["-setairportpower", &dev, "off"])
                    .and_then(|_| { std::thread::sleep(std::time::Duration::from_secs(2)); run("networksetup", &["-setairportpower", &dev, "on"]) });
                if let Err(e) = r { return Some(Err(e)); }
                let mut ok = false;
                for _ in 0..15 {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    if run("ping", &["-c", "1", "-t", "2", "1.1.1.1"]).is_ok() { ok = true; break; }
                }
                let _ = run("dscacheutil", &["-flushcache"]);
                Ok(if ok { "Wi-Fi turned off and on again. The internet answers.".into() } else { "Wi-Fi turned off and on again, but the internet still does not answer. The router may need a restart.".into() })
            } else {
                ps(include_str!("ps/wifi_reconnect.ps1"), "")
            }
        }
        "network_check" => {
            if MAC {
                let dev = mac_wifi_device();
                let power = run("networksetup", &["-getairportpower", &dev]).unwrap_or_default();
                let gw = run("sh", &["-c", "route -n get default 2>/dev/null | awk '/gateway/{print $2}'"]).unwrap_or_default();
                let router = if gw.is_empty() { "none found (not connected)".to_string() } else if run("ping", &["-c", "1", "-t", "2", &gw]).is_ok() { format!("{gw} answers") } else { format!("{gw} does not answer") };
                let net = if run("ping", &["-c", "1", "-t", "2", "1.1.1.1"]).is_ok() { "reachable" } else { "not reachable" };
                let dns = if run("host", &["-W", "3", "www.apple.com"]).is_ok() { "work" } else { "do not work" };
                let _ = run("dscacheutil", &["-flushcache"]);
                Ok(format!("{power}\nRouter: {router}\nInternet (1.1.1.1): {net}\nNames (DNS): {dns}\nName cache cleared."))
            } else {
                ps(include_str!("ps/network_check.ps1"), "")
            }
        }
        "printer_fix" => {
            if MAC {
                let _ = run("cancel", &["-a"]);
                let list = run("lpstat", &["-p"]).unwrap_or_default();
                let mut names = vec![];
                for l in list.lines() {
                    if let Some(rest) = l.strip_prefix("printer ") { if let Some(n) = rest.split_whitespace().next() { let _ = run("cupsenable", &[n]); let _ = run("cupsaccept", &[n]); names.push(n.to_string()); } }
                }
                Ok(if names.is_empty() { "No printers found on this Mac.".into() } else { format!("Cleared stuck jobs and resumed: {}.", names.join(", ")) })
            } else {
                ps(include_str!("ps/printer_fix.ps1"), "")
            }
        }
        "printer_restart_spooler" => {
            if MAC { return Some(Err("Not needed on a Mac. Use printer_fix.".into())); }
            // The Windows "Do you want to allow" box appears; the person presses Yes (the helper never does).
            ps("$p = Start-Process powershell -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-Command','Restart-Service -Name Spooler -Force'\nif ($p.ExitCode -ne 0) { throw 'The spooler did not restart.' }\n'Print spooler restarted.'", "")
        }
        "default_printer" => {
            let name = arg.trim();
            if name.is_empty() { return Some(Err("needs the printer name".into())); }
            if MAC { run("lpoptions", &["-d", &name.replace(' ', "_")]).map(|_| format!("{name} is now the default printer.")) } else { ps(include_str!("ps/default_printer.ps1"), name) }
        }
        "appearance" => {
            let a = arg.trim().to_lowercase();
            if a != "dark" && a != "light" { return Some(Err("appearance needs dark or light".into())); }
            if MAC {
                osa(&format!("tell application \"System Events\" to tell appearance preferences to set dark mode to {}", a == "dark")).map(|_| format!("Switched to {a} mode."))
            } else {
                ps(include_str!("ps/appearance.ps1"), &a)
            }
        }
        "night_light" => Err("There is no safe one-step way to do this on this computer. Use open_settings display and flip the Night light or Night Shift switch with the computer tools.".into()),
        "clear_cache" => {
            let b = arg.trim().to_lowercase();
            if !matches!(b.as_str(), "chrome" | "edge" | "brave" | "firefox" | "safari") { return Some(Err("browser must be chrome, edge, brave, firefox or safari".into())); }
            if MAC {
                let h = home();
                let dirs: Vec<String> = match b.as_str() {
                    "chrome" => vec![format!("{h}/Library/Caches/Google/Chrome")],
                    "edge" => vec![format!("{h}/Library/Caches/Microsoft Edge")],
                    "brave" => vec![format!("{h}/Library/Caches/BraveSoftware")],
                    "safari" => vec![format!("{h}/Library/Caches/com.apple.Safari")],
                    _ => vec![format!("{h}/Library/Caches/Firefox")],
                };
                let mut freed = 0u64;
                for d in dirs { freed += empty_dir(std::path::Path::new(&d)); }
                Ok(format!("Cleared the {b} cache: about {} MB. Passwords, history and bookmarks were not touched.", freed / 1_048_576))
            } else if b == "safari" {
                Err("Safari is not on Windows.".into())
            } else {
                ps(include_str!("ps/clear_cache.ps1"), &b)
            }
        }
        "free_space" => {
            if MAC {
                let tmp = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".into());
                let before = run("df", &["-h", "/"]).unwrap_or_default();
                let _ = run("find", &[&tmp, "-type", "f", "-mtime", "+2", "-delete"]);
                let after = run("df", &["-h", "/"]).unwrap_or_default();
                Ok(format!("Removed temporary files older than 2 days. Disk before:\n{before}\nDisk now:\n{after}"))
            } else {
                ps(include_str!("ps/free_space.ps1"), "")
            }
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scam_words_are_caught() {
        assert!(scam_check("URGENT: your computer is infected. Call this number now. Pay with gift cards.").starts_with("This looks like a scam"));
        assert!(scam_check("Hi Grandma, dinner at 6?").starts_with("No scam signs"));
        assert!(scam_check("verify your account at https://bit.ly/x").contains("shortened link"));
    }
    #[test]
    fn arguments_are_checked() {
        assert!(digits("125", 100, 225).is_ok());
        assert!(digits("9999", 100, 225).is_err());
        assert!(ps("x", "a; rm -rf").is_err());
    }
    #[cfg(windows)]
    #[test]
    fn windows_scripts_run_through_the_encoded_path() {
        let v = extra("volume", "status").unwrap().unwrap();
        assert!(v.starts_with("Volume is"), "{v}");
        let n = extra("network_check", "").unwrap().unwrap();
        assert!(n.contains("Name cache cleared"), "{n}");
        assert!(extra("volume", "loud").unwrap().is_err());
        assert!(extra("clear_cache", "bogus").unwrap().is_err());
    }
}
