#!/bin/sh
# Build the livewire desktop app and put it in the launcher.
set -e
cd "$(dirname "$0")"

printf '\033[1;36m== Building livewire ==\033[0m\n\n'
cargo build --release --manifest-path src-tauri/Cargo.toml

mkdir -p "$HOME/.local/bin" \
         "$HOME/.local/share/applications" \
         "$HOME/.local/share/icons/hicolor/512x512/apps"

install -m755 src-tauri/target/release/livewire "$HOME/.local/bin/livewire"
install -m644 assets/livewire.png "$HOME/.local/share/icons/hicolor/512x512/apps/livewire.png"

cat > "$HOME/.local/share/applications/livewire.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=livewire
Comment=Live telemetry board for GitHub's public event stream
Exec=$HOME/.local/bin/livewire
Icon=livewire
Categories=Development;Network;
Terminal=false
StartupWMClass=livewire
EOF

update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
gtk-update-icon-cache -q "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

printf '\n\033[1;32mInstalled.\033[0m livewire is in your app launcher, or run: livewire\n'
