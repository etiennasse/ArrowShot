#!/usr/bin/env bash
# ArrowShot performance benchmark — runs the extension from this checkout in an
# isolated headless gnome-shell and drives synthetic drag gestures against the
# CaptureSession internals (see bench-append.js, appended to a copy of
# extension.js; nothing here touches your session or installed extension).
#
# Usage: tools/run-bench.sh <label> <scenarios-json> [monitor WxH]
#
# Example:
#   tools/run-bench.sh pen '[{"label":"pen-full","w":-1,"h":-1,"elements":0,"seconds":5}]'
#
# Scenario fields: label; w/h (region, -1 = full stage); elements (committed
# shapes); seconds; mode = pen (default) | move | resize | static;
# hash:true renders a deterministic scene to <out>/<label>.png for
# pixel-identity comparison; smoke:true runs a functional pass.
#
# Results land on stdout as BENCH {json} lines; full log in the output dir.
# Headless mutter is not vsync-paced: stageFps is throughput, not display fps —
# compare runs against each other, not against a 60 fps target.
set -u
TOOLS_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
REPO="$(dirname "$TOOLS_DIR")"
LABEL="${1:?usage: run-bench.sh <label> <scenarios-json> [WxH]}"
SCEN="${2:?scenarios json}"
MONITOR="${3:-3072x1728}"
OUTBASE="${ARROWSHOT_BENCH_DIR:-/tmp/arrowshot-bench}"

# Fresh isolated XDG env each run (mktemp -d => mode 700, valid for
# XDG_RUNTIME_DIR). Must be a short path: the wayland socket path has to fit
# in sun_path (108 bytes), so this cannot live under a deep directory.
BENCH_HOME="$(mktemp -d /tmp/asb-XXXXXX)"
EXTDIR="$BENCH_HOME/data/gnome-shell/extensions/arrowshot@etiennasse.com"
OUT="$OUTBASE/out-$LABEL"
mkdir -p "$OUT" "$BENCH_HOME/data" "$BENCH_HOME/config" "$BENCH_HOME/cache"
RUNTIME="$(mktemp -d "$BENCH_HOME/runtime-XXXXXX")"

# Install a copy of the working tree + the bench harness
mkdir -p "$EXTDIR"
cp -r "$REPO"/extension.js "$REPO"/prefs.js "$REPO"/metadata.json "$REPO"/schemas "$REPO"/icons "$EXTDIR/"
cat "$TOOLS_DIR/bench-append.js" >> "$EXTDIR/extension.js"

export XDG_DATA_HOME="$BENCH_HOME/data"
export XDG_CONFIG_HOME="$BENCH_HOME/config"
export XDG_CACHE_HOME="$BENCH_HOME/cache"
export XDG_RUNTIME_DIR="$RUNTIME"
export ARROWSHOT_BENCH="$SCEN"
export ARROWSHOT_BENCH_OUT="$OUT"
unset DISPLAY WAYLAND_DISPLAY

LOG="$OUT/shell.log"
timeout 300 dbus-run-session -- bash -c '
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.shell enabled-extensions "['"'"'arrowshot@etiennasse.com'"'"']"
  exec gnome-shell --headless --virtual-monitor '"$MONITOR"' 2>&1
' > "$LOG" 2>&1 &
SHELL_PID=$!

# Wait for BENCH_DONE, then stop the shell
for _ in $(seq 1 290); do
  grep -q 'BENCH_DONE' "$LOG" 2>/dev/null && break
  kill -0 $SHELL_PID 2>/dev/null || break
  sleep 1
done
kill $SHELL_PID 2>/dev/null
wait $SHELL_PID 2>/dev/null

echo "=== BENCH RESULTS ($LABEL) — log: $LOG ==="
grep -E 'BENCH |BENCH_HASH|BENCH_ERROR|BENCH_DONE|SMOKE' "$LOG" | sed 's/^.*BENCH/BENCH/'
echo "=== errors (if any) ==="
grep -iE 'JS ERROR|Failed to load extension|CRITICAL' "$LOG" | grep -viE 'BENCH|gst-plugin' | head -20
