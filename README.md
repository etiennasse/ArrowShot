# ArrowShot

A Flameshot-style screenshot capture + annotation tool for **GNOME on Wayland**,
implemented as a GNOME Shell extension.

On GNOME/Wayland, normal apps can't grab the screen or draw a fullscreen overlay
(mutter implements neither `wlr-screencopy` nor `wlr-layer-shell`), which is why
Flameshot's interactive mode broke there. A shell extension runs *inside* the
compositor, so it legitimately can — ArrowShot does the whole capture-and-annotate
flow natively.

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

## Install

```sh
# symlink (or copy) into the GNOME extensions directory
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/arrowshot@etiennasse.com
glib-compile-schemas schemas/
gnome-extensions enable arrowshot@etiennasse.com
# then log out and back in (Wayland loads extensions at session start)
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
