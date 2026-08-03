#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;

/// The checkout this binary was built from, baked in at compile time — the
/// updater always pulls the repo it actually came from.
const REPO_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");

/// Links leave the webview through the system browser, nothing else.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("only web links open externally".into());
    }
    Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Hands off to livewire-update.sh in its own session, so the script
/// survives this process being replaced by the build it kicks off.
#[tauri::command]
fn run_update() -> Result<(), String> {
    Command::new("setsid")
        .arg("sh")
        .arg(format!("{REPO_DIR}/livewire-update.sh"))
        .current_dir(REPO_DIR)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![open_external, run_update])
        .run(tauri::generate_context!())
        .expect("livewire failed to start");
}
