# ArrowShot

> Capture a screen region, annotate it — arrows, shapes, text, number stamps,
> blur/pixelate — then copy or save. Natively on **GNOME Wayland**, where
> Flameshot's interactive mode no longer works.

ArrowShot is a GNOME Shell extension that brings a Flameshot-style
capture-and-annotate workflow to modern GNOME.

[Kooha-2026-07-15-10-30-21.webm](https://github.com/user-attachments/assets/e8094613-45e9-48c9-9399-e4fc554a9f19)


**Why an extension?** On Wayland, ordinary apps can't grab the screen or paint a
fullscreen overlay — mutter implements neither `wlr-screencopy` nor
`wlr-layer-shell`, which is exactly why Flameshot's interactive mode broke on
GNOME/Wayland. A shell extension runs *inside* the compositor, so it's allowed to
do both; ArrowShot uses that to run the whole flow natively. (It works on Xorg
sessions too — it lives in the shell, not the display protocol.)

## Features

- **Capture**: freeze + dim the screen, drag out a region, then resize it via
  edge/corner handles (with matching resize cursors).
- **Tools**: select/move, arrow, line, rectangle, ellipse, pen, highlighter,
  text, auto-incrementing number stamps, blur, and pixelate (mosaic).
- **Editing**: select / move / delete any shape, undo & redo, a color palette,
  and adjustable thickness (buttons or scroll wheel). Blur and pixelate preview
  live while dragging.
- **Output**: `Ctrl+C` copies to the clipboard; `Enter` / ✓ saves to
  `~/Pictures/Screenshots` **and** copies.
- **Preferences**: shortcut, default color, default thickness, and save folder.

## Keys

| Key | Action |
|-----|--------|
| `Ctrl+Print` (default) | Start a capture |
| `V A L R E P H T N B M` | select, arrow, line, rect, ellipse, pen, highlight, text, number, blur, pixelate |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo / redo |
| `Ctrl+C` | copy + close |
| `Enter` | save + copy + close |
| `Delete` | delete selected shape |
| `Esc` | deselect, or cancel |

## Compatibility

ArrowShot is a GNOME Shell extension, so what matters is your **GNOME Shell
version**, not the specific distro or session type. It runs on both **Wayland and
Xorg** (it lives inside the shell) — development and testing are on Wayland.

| GNOME Shell | Example releases | Status |
|-------------|------------------|--------|
| 48 | Ubuntu 25.04 · Fedora 42 | ☑️ Declared — expected to work |
| 47 | Ubuntu 24.10 · Fedora 41 | ☑️ Declared — expected to work |
| 46 | Ubuntu 24.04 LTS · Fedora 40 | ✅ Tested |
| 45 | Ubuntu 23.10 | ⚠️ Declared — untested |
| 44 and older | Ubuntu ≤ 23.04 (incl. 22.04 LTS = GNOME 42) | ❌ Unsupported |

GNOME 44 and older predate the ESM extension API (introduced in GNOME 45), so
ArrowShot won't load there without a port to the legacy extension format.

## Install

**From a release (easiest):** download `arrowshot@etiennasse.com.shell-extension.zip`
from the [Releases](https://github.com/etiennasse/ArrowShot/releases) page, then:

```sh
gnome-extensions install --force arrowshot@etiennasse.com.shell-extension.zip
# log out and back in (Wayland loads extensions at session start), then:
gnome-extensions enable arrowshot@etiennasse.com
```

**From a clone:** run the installer (packs + installs, then enables or tells you to
re-login):

```sh
git clone https://github.com/etiennasse/ArrowShot.git
cd ArrowShot
./install.sh
```

Open preferences with `gnome-extensions prefs arrowshot@etiennasse.com`.

## Development

Wayland caches extension code, so iterate in a **nested** shell rather than
re-logging in each time. Because the outer compositor grabs global shortcuts,
give the nested session its own config and a distinct shortcut:

```sh
export TC=/tmp/arrowshot-nested
mkdir -p "$TC"
SCHEMA=~/.local/share/gnome-shell/extensions/arrowshot@etiennasse.com/schemas
XDG_CONFIG_HOME="$TC" dbus-run-session -- bash -c "
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.shell enabled-extensions \"['arrowshot@etiennasse.com']\"
  GSETTINGS_SCHEMA_DIR='$SCHEMA' gsettings set org.gnome.shell.extensions.arrowshot capture-shortcut \"['<Control><Alt>s']\""
XDG_CONFIG_HOME="$TC" dbus-run-session -- gnome-shell --nested --wayland
# inside the nested window, press Ctrl+Alt+S
```

Watch for errors: `journalctl --user -f -o cat /usr/bin/gnome-shell | grep -iE 'arrowshot|JS ERROR'`

## Layout

- `extension.js` — the capture session, tools, rendering, toolbar.
- `prefs.js` — libadwaita preferences.
- `schemas/` — GSettings schema (`glib-compile-schemas` after edits).
- `icons/` — toolbar SVGs.

## License

MIT — see `LICENSE`.
