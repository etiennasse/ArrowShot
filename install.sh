#!/usr/bin/env bash
# ArrowShot installer — builds the extension from this checkout and installs it
# into your user GNOME Shell extensions. Run: ./install.sh
set -euo pipefail

UUID="arrowshot@etiennasse.com"
cd "$(dirname "$(readlink -f "$0")")"

if ! command -v gnome-extensions >/dev/null 2>&1; then
    echo "error: 'gnome-extensions' not found — install GNOME Shell first." >&2
    exit 1
fi

echo "Packing ${UUID}…"
gnome-extensions pack --extra-source=icons --force -o . .
ZIP="${UUID}.shell-extension.zip"

echo "Installing…"
gnome-extensions install --force "$ZIP"
rm -f "$ZIP"

echo
echo "✓ Installed ${UUID}"
if gnome-extensions enable "$UUID" 2>/dev/null; then
    echo "✓ Enabled — press your shortcut (default Ctrl+Print) to capture."
else
    echo "→ Log out and back in (Wayland loads extensions at session start), then:"
    echo "    gnome-extensions enable ${UUID}"
fi
echo "  Preferences: gnome-extensions prefs ${UUID}"
