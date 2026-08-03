#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};

/// The checkout this binary was built from, baked in at compile time — the
/// updater always pulls the repo it actually came from.
const REPO_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");

/// Waits on the child from a side thread so it gets reaped — a dropped
/// `Child` is never waited on, and every un-waited child is a zombie until
/// this process exits.
fn reap(child: Child) {
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
}

/// Links leave the webview through the system browser, nothing else.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("only web links open externally".into());
    }
    Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(reap)
        .map_err(|e| e.to_string())
}

/// Borrows the gh CLI's OAuth token, so the app can poll at the
/// authenticated rate without carrying a login flow of its own. The token
/// stays in memory on the JS side — gh remains its only keeper on disk.
#[tauri::command]
fn gh_token() -> Result<String, String> {
    let out = Command::new("gh")
        .args(["auth", "token"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("gh isn't logged in".into());
    }
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if token.is_empty() {
        return Err("gh returned no token".into());
    }
    Ok(token)
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
        .map(reap)
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![open_external, run_update, gh_token])
        .run(tauri::generate_context!())
        .expect("livewire failed to start");
}
