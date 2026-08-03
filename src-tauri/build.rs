use std::fs;
use std::path::Path;
use std::process::Command;

/// The window serves the same three files the web app is made of. They are
/// copied into `dist/` here, at build time, so the embedded assets can never
/// drift from the ones GitHub Pages serves — one source, two shells.
///
/// The one difference: the commit being built gets stamped into index.html,
/// which is what the in-app update check compares against origin/main. The
/// web copy has no stamp and never needs one — Pages always serves main.
fn main() {
    let dist = Path::new("dist");
    fs::create_dir_all(dist).expect("create dist/");

    for name in ["style.css", "app.js"] {
        fs::copy(format!("../{name}"), dist.join(name))
            .unwrap_or_else(|e| panic!("copy ../{name} into dist/: {e}"));
        println!("cargo:rerun-if-changed=../{name}");
    }

    let html = fs::read_to_string("../index.html").expect("read ../index.html");
    let stamped = match built_commit() {
        Some(sha) => html.replace(
            "</body>",
            &format!("<script>window.__LW_COMMIT=\"{sha}\";</script>\n</body>"),
        ),
        None => html,
    };
    fs::write(dist.join("index.html"), stamped).expect("write dist/index.html");
    println!("cargo:rerun-if-changed=../index.html");
    // HEAD only changes on branch switches; the branch's own ref file is
    // what moves on every commit. Watching both keeps the stamped commit
    // honest — without the second line a rebuild after `git pull` could
    // bake the previous sha and immediately report itself out of date.
    println!("cargo:rerun-if-changed=../.git/HEAD");
    if let Ok(head) = fs::read_to_string("../.git/HEAD") {
        if let Some(r) = head.trim().strip_prefix("ref: ") {
            println!("cargo:rerun-if-changed=../.git/{r}");
        }
    }

    tauri_build::build()
}

fn built_commit() -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir("..")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (sha.len() == 40).then_some(sha)
}
