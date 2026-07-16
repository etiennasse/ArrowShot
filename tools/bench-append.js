
// ==== ARROWSHOT BENCH HARNESS ====
// Appended to a COPY of extension.js by tools/run-bench.sh — never part of the
// packed extension. Activated by the ARROWSHOT_BENCH env var containing a JSON
// scenario list; drives CaptureSession internals with stub events to measure
// the repaint path without needing real input devices.

function _benchWait(ms) {
    return new Promise(res => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        res();
        return GLib.SOURCE_REMOVE;
    }));
}

async function _benchOne(ext, sc) {
    const session = new CaptureSession(() => {}, ext.path, null);
    // _start() is async: wait for grab (success) or teardown (failure).
    for (let i = 0; i < 100 && !session._grab && !session._teardownDone; i++)
        await _benchWait(50);
    if (session._teardownDone) {
        log(`BENCH_ERROR session failed to start for ${sc.label}`);
        return;
    }

    const W = global.stage.width, H = global.stage.height;
    const r = {
        x: 0, y: 0,
        w: sc.w > 0 ? sc.w : W,
        h: sc.h > 0 ? sc.h : H,
    };
    session._region = r;
    session._phase = 1; // EDIT
    session._layoutChrome();
    if (session._layoutAnnot)
        session._layoutAnnot();       // pre-split layout path
    if (session._updateAnnotClips)
        session._updateAnnotClips();  // split-layer clip path

    for (let i = 0; i < (sc.elements || 0); i++) {
        session._commit({
            tool: ['rect', 'ellipse', 'line', 'arrow'][i % 4],
            x0: 40 + i * 37, y0: 60 + (i % 3) * 90,
            x1: 40 + i * 37 + 120, y1: 60 + (i % 3) * 90 + 140,
            color: [0.9, 0.13, 0.13, 1], width: 4,
        });
    }

    if (sc.hash) {
        // Deterministic annotation set -> PNG, for pixel-identity comparison.
        session._commit({tool: 'pen', color: [0.26, 0.55, 0.96, 1], width: 6,
            points: Array.from({length: 200}, (_, i) => [100 + i * 3, 300 + 120 * Math.sin(i / 12)])});
        session._commit({tool: 'highlight', color: [1.0, 0.85, 0.10, 1], width: 8,
            points: Array.from({length: 100}, (_, i) => [150 + i * 4, 500])});
        session._commit({tool: 'number', x: 700, y: 200, n: 7, color: [0.3, 0.76, 0.35, 1], width: 6});
        session._commit({tool: 'arrow', x0: 200, y0: 700, x1: 600, y1: 450, color: [0.9, 0.13, 0.13, 1], width: 5});
        session._selected = null;
        if (session._annot)
            session._annot.queue_repaint();
        session._chrome.hide();
        await session._waitForRedraw();
        await _benchWait(100);
        const stream = Gio.MemoryOutputStream.new_resizable();
        await session._shooter.screenshot_area(r.x, r.y, Math.min(r.w, 1200), Math.min(r.h, 900), stream);
        stream.close(null);
        const bytes = stream.steal_as_bytes();
        const path = GLib.getenv('ARROWSHOT_BENCH_OUT') + `/${sc.label}.png`;
        GLib.file_set_contents(path, bytes.toArray());
        log(`BENCH_HASH ${sc.label} ${path}`);
        session._teardown();
        return;
    }

    if (sc.smoke) {
        const evAt = (x, y) => ({get_coords: () => [x, y]});
        const drag = async (x0, y0, x1, y1, tool) => {
            session._tool = tool;
            session._onPress(evAt(x0, y0));
            for (let i = 1; i <= 10; i++)
                session._onMotion(evAt(x0 + (x1 - x0) * i / 10, y0 + (y1 - y0) * i / 10));
            await _benchWait(50);
            session._onRelease(evAt(x1, y1));
            await _benchWait(50);
        };
        await drag(200, 200, 500, 400, 'pen');
        await drag(300, 300, 600, 500, 'rect');
        session._undo(); await _benchWait(30);
        session._undo(); await _benchWait(30);
        session._redoAction(); await _benchWait(30);
        session._tool = 'number';
        session._placeNumber(400, 250); await _benchWait(30);
        session._tool = 'select';
        session._onPress(evAt(400, 250));
        log(`SMOKE selected=${!!session._selected} move=${!!session._move} liveEl=${!!session._liveEl}`);
        for (let i = 1; i <= 10; i++)
            session._onMotion(evAt(400 + i * 15, 250 + i * 8));
        await _benchWait(50);
        session._onRelease(evAt(550, 330));
        await _benchWait(30);
        session._deleteSelected(); await _benchWait(30);
        session._startText(350, 350);
        session._activeEntry.set_text('smoke test');
        await _benchWait(150); // let the entry get allocated, as in real typing
        session._commitText(); await _benchWait(30);
        await drag(250, 450, 450, 560, 'blur');
        log(`SMOKE elements=${session._elements.length} redo=${session._redo.length}`);
        await session._confirm(false); // copies to clipboard + tears down
        await _benchWait(200);
        log(`SMOKE_OK teardown=${session._teardownDone}`);
        return;
    }

    // Instrument the annotation paint callback(s).
    let paintUs = 0, paintCount = 0, paintPx = 0, syncPaints = 0;
    let inMotion = false;
    const perLayer = {};
    const wrapPaint = name => {
        if (!session[name])
            return;
        const orig = session[name].bind(session);
        perLayer[name] = 0;
        session[name] = area => {
            const t0 = GLib.get_monotonic_time();
            orig(area);
            paintUs += GLib.get_monotonic_time() - t0;
            paintCount++;
            perLayer[name]++;
            if (inMotion)
                syncPaints++;
            const a = typeof area.get_surface_size === 'function' ? area : null;
            if (a) {
                const [sw, sh] = a.get_surface_size();
                paintPx += sw * sh;
            }
        };
    };
    wrapPaint('_paintAnnot');      // current HEAD single-layer path
    wrapPaint('_paintAnnotBase');  // optimized split-layer path (if present)
    wrapPaint('_paintAnnotLive');
    const origMotion = session._onMotion.bind(session);
    session._onMotion = e => {
        inMotion = true;
        const ret = origMotion(e);
        inMotion = false;
        return ret;
    };

    let stagePaints = 0;
    const spId = global.stage.connect('after-paint', () => stagePaints++);

    session._tool = sc.tool || 'pen';
    const ev = (x, y) => ({get_coords: () => [x, y]});
    const N = (sc.seconds || 5) * 250;

    let benchT0;
    if (sc.mode === 'static') {
        // No motion at all; drive stage frames by damaging a tiny chrome actor.
        // If _paintAnnot fires per frame here, something re-allocates the
        // DrawingArea every frame and caching a committed layer cannot work.
        benchT0 = GLib.get_monotonic_time();
        let i = 0;
        await new Promise(res => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4, () => {
            i++;
            session._border.queue_redraw();
            if (i >= N) { res(); return GLib.SOURCE_REMOVE; }
            return GLib.SOURCE_CONTINUE;
        }));
    } else if (sc.mode === 'resize') {
        // Drag the right edge back and forth (region resize path).
        session._onPress(ev(r.x + r.w, r.y + r.h / 2));
        benchT0 = GLib.get_monotonic_time();
        let i = 0;
        await new Promise(res => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4, () => {
            i++;
            const t = i / N;
            const x = r.x + r.w * (0.55 + 0.45 * Math.abs(Math.sin(t * 8 * Math.PI)));
            session._onMotion(ev(x, r.y + r.h / 2));
            if (i >= N) { res(); return GLib.SOURCE_REMOVE; }
            return GLib.SOURCE_CONTINUE;
        }));
    } else if (sc.mode === 'move') {
        // Drag the first committed element around (select tool).
        session._onPress(ev(100, 130)); // inside element 0's bbox, > tol from region edges
        if (!session._move)
            log(`BENCH_ERROR move grab missed for ${sc.label}`);
        benchT0 = GLib.get_monotonic_time();
        let i = 0;
        await new Promise(res => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4, () => {
            i++;
            const t = i / N;
            const x = 100 + (0.4 + 0.35 * Math.sin(t * 16 * Math.PI)) * r.w;
            const y = 130 + t * (r.h * 0.6);
            session._onMotion(ev(x, y));
            if (i >= N) { res(); return GLib.SOURCE_REMOVE; }
            return GLib.SOURCE_CONTINUE;
        }));
    } else {
        // Continuous pen sweep across the whole region (press away from the
        // region edges: within HANDLE_TOL of an edge it becomes a resize).
        session._onPress(ev(r.x + 40, r.y + 40));
        if (!session._current)
            log(`BENCH_ERROR pen stroke did not start for ${sc.label}`);
        benchT0 = GLib.get_monotonic_time();
        let i = 0;
        await new Promise(res => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4, () => {
            i++;
            const t = i / N;
            const x = r.x + (0.5 + 0.45 * Math.sin(t * 20 * Math.PI)) * r.w;
            const y = r.y + Math.max(40, t * r.h);
            session._onMotion(ev(x, y));
            if (i >= N) { res(); return GLib.SOURCE_REMOVE; }
            return GLib.SOURCE_CONTINUE;
        }));
    }
    const wallMs = (GLib.get_monotonic_time() - benchT0) / 1000;
    session._onRelease(ev(r.x + r.w / 2, r.y + r.h - 1));
    global.stage.disconnect(spId);

    // Idle window: any repaint now is a leaked continuous invalidation.
    const idleBefore = paintCount;
    await _benchWait(2000);
    const idlePaints = paintCount - idleBefore;

    log(`BENCH ${JSON.stringify({
        label: sc.label,
        region: [r.w, r.h],
        elements: sc.elements || 0,
        mode: sc.mode || 'pen',
        wallMs: Math.round(wallMs),
        motions: N,
        repaints: paintCount,
        paintMsAvg: paintCount ? +(paintUs / 1000 / paintCount).toFixed(2) : 0,
        paintMsTotal: Math.round(paintUs / 1000),
        avgPaintPx: paintCount ? Math.round(paintPx / paintCount) : 0,
        stageFps: +(stagePaints / (wallMs / 1000)).toFixed(1),
        repaintsPerSec: +(paintCount / (wallMs / 1000)).toFixed(1),
        syncPaints,
        idlePaints,
        perLayer,
    })}`);

    session._teardown();
    await _benchWait(300);
}

async function _runBench(ext) {
    await _benchWait(2500); // let the shell settle
    const scenarios = JSON.parse(GLib.getenv('ARROWSHOT_BENCH'));
    for (const sc of scenarios) {
        try {
            await _benchOne(ext, sc);
        } catch (e) {
            logError(e, `BENCH_ERROR in ${sc.label}`);
        }
    }
    log('BENCH_DONE');
}

const _origEnable = ArrowShotExtension.prototype.enable;
ArrowShotExtension.prototype.enable = function () {
    _origEnable.call(this);
    if (GLib.getenv('ARROWSHOT_BENCH'))
        _runBench(this).catch(e => { logError(e); log('BENCH_DONE'); });
};
