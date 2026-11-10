// The one permission step (scope S6). On a Mac, three things must be on: microphone, screen
// recording and Accessibility (to click and type). Apple doesn't let apps flip these, so we check
// them, open the exact Settings page, and the panel points the person at the switch.
// On Windows nothing needs turning on for normal windows.
use serde::Serialize;

#[derive(Serialize)]
pub struct Perms {
    screen: bool,
    control: bool,
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        pub fn AXIsProcessTrusted() -> bool;
        pub fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
        pub static kAXTrustedCheckOptionPrompt: *const c_void;
    }
    /// Adds Tech Support to the Accessibility list (macOS shows its own "open Settings" prompt).
    pub fn ask_control() {
        use core_foundation::{base::TCFType, boolean::CFBoolean, dictionary::CFDictionary, string::CFString};
        unsafe {
            let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt as _);
            let dict = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
            AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef() as *const c_void);
        }
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        pub fn CGPreflightScreenCaptureAccess() -> bool;
        pub fn CGRequestScreenCaptureAccess() -> bool;
    }
    #[allow(dead_code)]
    pub type Unused = *const c_void;
}

#[tauri::command]
pub fn perms_status() -> Perms {
    #[cfg(target_os = "macos")]
    unsafe {
        return Perms { screen: mac::CGPreflightScreenCaptureAccess(), control: mac::AXIsProcessTrusted() };
    }
    #[cfg(not(target_os = "macos"))]
    Perms { screen: true, control: true }
}

/// Asks macOS to add Tech Support to the list and opens the right Settings page.
#[tauri::command]
pub fn perms_open(which: String) {
    #[cfg(target_os = "macos")]
    {
        let pane = match which.as_str() {
            "screen" => {
                unsafe {
                    mac::CGRequestScreenCaptureAccess();
                }
                "Privacy_ScreenCapture"
            }
            "mic" => "Privacy_Microphone",
            _ => {
                mac::ask_control();
                "Privacy_Accessibility"
            }
        };
        let _ = std::process::Command::new("open").arg(format!("x-apple.systempreferences:com.apple.preference.security?{pane}")).spawn();
    }
    #[cfg(not(target_os = "macos"))]
    {
        if which == "mic" {
            let _ = std::process::Command::new("cmd").args(["/c", "start", "", "ms-settings:privacy-microphone"]).spawn();
        }
    }
}
