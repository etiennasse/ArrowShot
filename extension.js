// ArrowShot — Flameshot-style region capture + annotation for GNOME Wayland.
//
// Runs inside gnome-shell, the only context on GNOME Wayland allowed to both
// grab the screen and paint a fullscreen overlay (mutter exposes neither
// wlr-screencopy nor wlr-layer-shell to normal apps). Standalone by design:
// depends only on stable APIs (St, Clutter, Shell.Screenshot/BlurEffect,
// St.Clipboard) so it survives GNOME version bumps.
//
// Flow: shortcut -> freeze + dim -> drag a region -> a toolbar appears ->
// pick a tool + color + width, draw shapes -> Ctrl+C copies, Enter/✓ saves
// (+ copies), Ctrl+Z / Ctrl+Shift+Z undo/redo, Esc cancels.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import cairo from 'cairo';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Shell.Screenshot.prototype.{screenshot_stage_to_content,screenshot_area} are
// promisified by js/ui/screenshot.js at shell startup, so awaiting them is safe.

const DIM_ALPHA = 0.45;
const BLUR_RADIUS = 42;
const HIGHLIGHT_ALPHA = 0.38;
const MIN_WIDTH = 2;
const MAX_WIDTH = 40;
const HANDLE_TOL = 12; // px tolerance for grabbing a selection edge/corner

// State phases.
const SELECT = 0; // rubber-band the region
const EDIT = 1;   // toolbar visible, drawing shapes

const TOOLS = [
    {id: 'select',    glyph: '✥', key: Clutter.KEY_v, tip: 'Select / move (V)'},
    {id: 'arrow',     glyph: '↗', key: Clutter.KEY_a, tip: 'Arrow (A)'},
    {id: 'line',      glyph: '╱', key: Clutter.KEY_l, tip: 'Line (L)'},
    {id: 'rect',      glyph: '▭', key: Clutter.KEY_r, tip: 'Rectangle (R)'},
    {id: 'ellipse',   glyph: '◯', key: Clutter.KEY_e, tip: 'Ellipse (E)'},
    {id: 'pen',       glyph: '✎', key: Clutter.KEY_p, tip: 'Pen (P)'},
    {id: 'highlight', glyph: '▬', key: Clutter.KEY_h, tip: 'Highlighter (H)'},
    {id: 'text',      glyph: 'T', key: Clutter.KEY_t, tip: 'Text (T)'},
    {id: 'number',    glyph: '①', key: Clutter.KEY_n, tip: 'Number stamp (N)'},
    {id: 'blur',      glyph: '▓', key: Clutter.KEY_b, tip: 'Blur (B)'},
    {id: 'pixelate',  glyph: '▦', key: Clutter.KEY_m, tip: 'Pixelate (M)'},
];

const PALETTE = [
    ['red',    [0.90, 0.13, 0.13, 1]],
    ['orange', [0.98, 0.55, 0.09, 1]],
    ['yellow', [1.00, 0.85, 0.10, 1]],
    ['green',  [0.30, 0.76, 0.35, 1]],
    ['blue',   [0.26, 0.55, 0.96, 1]],
    ['white',  [1, 1, 1, 1]],
    ['black',  [0.10, 0.10, 0.10, 1]],
];

const cssRGBA = c =>
    `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3]})`;

const colorByName = name => {
    const hit = PALETTE.find(([n]) => n === name);
    return hit ? hit[1] : PALETTE[0][1];
};

const isRedact = t => t === 'blur' || t === 'pixelate';

// Mosaic/pixelate effect: snaps texture coords to a block grid and re-samples,
// giving Flameshot-style blocky redaction. Modeled on GNOME's RecolorEffect.
const PixelateEffect = GObject.registerClass(
class PixelateEffect extends Shell.GLSLEffect {
    _init(params) {
        super._init(params);
        this._loc = this.get_uniform_location('blockuv');
        this.set_uniform_float(this._loc, 2, [0.02, 0.02]);
    }

    vfunc_build_pipeline() {
        const decl = 'uniform vec2 blockuv;\n';
        const src = `
            vec2 uv = cogl_tex_coord0_in.st;                          \n
            vec2 quv = (floor(uv / blockuv) + 0.5) * blockuv;         \n
            cogl_color_out = texture2D(cogl_sampler0, quv);           \n`;
        this.add_glsl_snippet(Shell.SnippetHook.FRAGMENT, decl, src, false);
    }

    setBlockUV(bx, by) {
        if (this._loc)
            this.set_uniform_float(this._loc, 2, [bx, by]);
        this.queue_repaint();
    }
});

class CaptureSession {
    constructor(onDone, extPath, settings) {
        this._onDone = onDone;
        this._extPath = extPath;
        this._shooter = new Shell.Screenshot();
        this._phase = SELECT;
        this._tool = 'arrow';
        this._color = colorByName(settings ? settings.get_string('default-color') : 'red');
        this._width = settings
            ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, settings.get_int('default-width')))
            : 4;
        this._saveDir = settings ? settings.get_string('save-directory') : '';
        this._stampCounter = 1;
        this._dragging = false;
        this._region = null;   // {x, y, w, h}
        this._elements = [];   // committed shapes; text/blur carry an `actor`
        this._redo = [];       // undone shapes (re-doable)
        this._current = null;  // in-progress vector shape
        this._resize = null;   // active selection-resize drag
        this._selected = null; // element selected with the select tool
        this._move = null;     // active element-move drag
        this._activeEntry = null;
        this._toolButtons = new Map();
        this._swatches = new Map();
        this._tooltip = null;
        this._grab = null;
        this._ids = [];
        this._teardownDone = false;

        this._start().catch(e => {
            logError(e, 'ArrowShot: failed to start capture');
            this._teardown();
        });
    }

    _setCursor(name) {
        try {
            const c = Meta.Cursor[name];
            if (c !== undefined)
                global.display.set_cursor(c);
        } catch (e) {
            // cursor is cosmetic
        }
    }

    async _start() {
        const [content] = await this._shooter.screenshot_stage_to_content();
        this._content = content;

        const w = global.stage.width;
        const h = global.stage.height;
        this._stageW = w;
        this._stageH = h;

        // Frozen backdrop.
        this._bg = new St.Widget({content, x: 0, y: 0, width: w, height: h});
        Main.layoutManager.uiGroup.add_child(this._bg);

        // Blur patches live between the backdrop and the vector layer.
        this._blurGroup = new St.Widget({x: 0, y: 0, width: w, height: h});
        Main.layoutManager.uiGroup.add_child(this._blurGroup);

        // Container that owns the grab.
        this._ui = new St.Widget({x: 0, y: 0, width: w, height: h});
        Main.layoutManager.uiGroup.add_child(this._ui);

        // Dim + selection chrome.
        this._chrome = new St.DrawingArea({x: 0, y: 0, width: w, height: h});
        this._ui.add_child(this._chrome);
        this._ids.push([this._chrome, this._chrome.connect('repaint', a => this._paintChrome(a))]);

        // Vector annotation layer.
        this._annot = new St.DrawingArea({x: 0, y: 0, width: w, height: h});
        this._ui.add_child(this._annot);
        this._ids.push([this._annot, this._annot.connect('repaint', a => this._paintAnnot(a))]);

        // Transparent reactive canvas that catches drawing input.
        this._canvas = new St.Widget({reactive: true, can_focus: true, x: 0, y: 0, width: w, height: h});
        this._ui.add_child(this._canvas);
        this._ids.push([this._canvas, this._canvas.connect('button-press-event', (a, e) => this._onPress(e))]);
        this._ids.push([this._canvas, this._canvas.connect('motion-event', (a, e) => this._onMotion(e))]);
        this._ids.push([this._canvas, this._canvas.connect('button-release-event', (a, e) => this._onRelease(e))]);
        this._ids.push([this._canvas, this._canvas.connect('scroll-event', (a, e) => this._onScroll(e))]);
        this._ids.push([this._canvas, this._canvas.connect('key-press-event', (a, e) => this._onKey(e))]);

        // Modal grab — bail cleanly if it fails.
        const grab = Main.pushModal(this._ui, {actionMode: Shell.ActionMode.SYSTEM_MODAL});
        if (grab.get_seat_state() !== Clutter.GrabState.ALL) {
            Main.popModal(grab);
            throw new Error('ArrowShot: could not grab input');
        }
        this._grab = grab;
        this._canvas.grab_key_focus();

        this._setCursor('CROSSHAIR');
        this._chrome.queue_repaint();
    }

    // ---- input ----------------------------------------------------------

    _onPress(event) {
        const [x, y] = event.get_coords();
        if (this._activeEntry)
            this._commitText();

        this._dx0 = x;
        this._dy0 = y;

        if (this._phase === SELECT) {
            this._dragging = true;
            this._region = {x, y, w: 0, h: 0};
            return Clutter.EVENT_STOP;
        }

        // EDIT phase: grabbing an edge/corner resizes the selection.
        const edges = this._edgeHit(x, y);
        if (edges) {
            this._dragging = true;
            const r = this._region;
            this._resize = {edges, l: r.x, r: r.x + r.w, t: r.y, b: r.y + r.h};
            return Clutter.EVENT_STOP;
        }

        // Select tool: pick and move an existing element.
        if (this._tool === 'select') {
            const el = this._hitTest(x, y);
            this._selected = el;
            this._move = el ? {el, ox: x, oy: y, snap: this._snapshot(el)} : null;
            this._dragging = !!el;
            this._annot.queue_repaint();
            return Clutter.EVENT_STOP;
        }

        this._dragging = true;
        if (this._tool === 'text') {
            this._dragging = false;
            this._startText(x, y);
        } else if (this._tool === 'number') {
            this._dragging = false;
            this._placeNumber(x, y);
        } else if (this._tool === 'pen' || this._tool === 'highlight') {
            this._current = {tool: this._tool, points: [[x, y]], color: this._color, width: this._width};
        } else if (isRedact(this._tool)) {
            // Create the redact patch up-front so it previews live while dragging.
            const actor = this._makeRedactActor(this._tool, x, y, 0, 0);
            this._current = {tool: this._tool, x0: x, y0: y, x1: x, y1: y, actor, x, y, w: 0, h: 0};
        } else {
            this._current = {tool: this._tool, x0: x, y0: y, x1: x, y1: y, color: this._color, width: this._width};
        }
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        const [x, y] = event.get_coords();
        if (!this._dragging) {
            this._updateHoverCursor(x, y);
            return Clutter.EVENT_STOP;
        }
        if (this._phase === SELECT) {
            this._region = {
                x: Math.min(this._dx0, x), y: Math.min(this._dy0, y),
                w: Math.abs(x - this._dx0), h: Math.abs(y - this._dy0),
            };
            this._chrome.queue_repaint();
        } else if (this._move) {
            const dx = x - this._move.ox, dy = y - this._move.oy;
            this._applyTranslate(this._move.el, this._move.snap, dx, dy);
            this._annot.queue_repaint();
        } else if (this._resize) {
            const z = this._resize;
            let l = z.l, r = z.r, t = z.t, b = z.b;
            if (z.edges.has('l')) l = x;
            if (z.edges.has('r')) r = x;
            if (z.edges.has('t')) t = y;
            if (z.edges.has('b')) b = y;
            this._region = {x: Math.min(l, r), y: Math.min(t, b), w: Math.abs(r - l), h: Math.abs(t - b)};
            this._chrome.queue_repaint();
            if (this._toolbar)
                this._positionToolbar();
        } else if (this._current) {
            if (this._current.points) {
                this._current.points.push([x, y]);
            } else {
                this._current.x1 = x;
                this._current.y1 = y;
                if (isRedact(this._current.tool))
                    this._updateBlurClip(this._current);
            }
            this._annot.queue_repaint();
        }
        return Clutter.EVENT_STOP;
    }

    _onRelease(event) {
        if (!this._dragging)
            return Clutter.EVENT_STOP;
        this._dragging = false;
        const [x, y] = event.get_coords();

        if (this._phase === SELECT) {
            if (this._region && this._region.w > 4 && this._region.h > 4) {
                this._phase = EDIT;
                this._setCursor('DEFAULT');
                this._buildToolbar();
            } else {
                this._region = null;
            }
            this._chrome.queue_repaint();
            return Clutter.EVENT_STOP;
        }

        if (this._resize) {
            this._resize = null;
            this._chrome.queue_repaint();
            return Clutter.EVENT_STOP;
        }

        if (this._move) {
            this._move = null;
            return Clutter.EVENT_STOP;
        }

        if (!this._current)
            return Clutter.EVENT_STOP;

        if (!this._current.points) {
            this._current.x1 = x;
            this._current.y1 = y;
        }

        if (isRedact(this._current.tool)) {
            this._updateBlurClip(this._current);
            if (this._current.w < 4 || this._current.h < 4) {
                if (this._current.actor)
                    this._current.actor.destroy();
            } else {
                this._commit(this._current);
            }
        } else if (this._isDrawn(this._current)) {
            this._commit(this._current);
        }

        this._current = null;
        this._annot.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    _edgeHit(px, py) {
        const r = this._region;
        if (!r || r.w <= 0 || r.h <= 0)
            return null;
        const T = HANDLE_TOL;
        const withinX = px >= r.x - T && px <= r.x + r.w + T;
        const withinY = py >= r.y - T && py <= r.y + r.h + T;
        const edges = new Set();
        if (withinY && Math.abs(px - r.x) <= T) edges.add('l');
        if (withinY && Math.abs(px - (r.x + r.w)) <= T) edges.add('r');
        if (withinX && Math.abs(py - r.y) <= T) edges.add('t');
        if (withinX && Math.abs(py - (r.y + r.h)) <= T) edges.add('b');
        return edges.size ? edges : null;
    }

    // ---- select / move / delete ----------------------------------------

    _updateHoverCursor(x, y) {
        if (this._phase !== EDIT || this._activeEntry)
            return;
        const e = this._edgeHit(x, y);
        if (e)
            this._setCursor(this._cursorForEdges(e));
        else if (this._tool === 'select')
            this._setCursor(this._hitTest(x, y) ? 'MOVE_OR_RESIZE_WINDOW' : 'DEFAULT');
        else
            this._setCursor(this._tool === 'text' ? 'IBEAM' : 'CROSSHAIR');
    }

    _cursorForEdges(e) {
        const l = e.has('l'), r = e.has('r'), t = e.has('t'), b = e.has('b');
        if (t && l) return 'NW_RESIZE';
        if (t && r) return 'NE_RESIZE';
        if (b && l) return 'SW_RESIZE';
        if (b && r) return 'SE_RESIZE';
        if (t) return 'NORTH_RESIZE';
        if (b) return 'SOUTH_RESIZE';
        if (l) return 'WEST_RESIZE';
        if (r) return 'EAST_RESIZE';
        return 'DEFAULT';
    }

    _hitTest(x, y) {
        for (let i = this._elements.length - 1; i >= 0; i--) {
            if (this._hit(this._elements[i], x, y))
                return this._elements[i];
        }
        return null;
    }

    _hit(el, x, y) {
        const tol = Math.max(8, (el.width || 4));
        switch (el.tool) {
        case 'text': {
            const bb = this._bbox(el);
            return x >= bb.x - 4 && x <= bb.x + bb.w + 4 && y >= bb.y - 4 && y <= bb.y + bb.h + 4;
        }
        case 'number': {
            const rad = 9 + el.width + 4;
            return Math.hypot(x - el.x, y - el.y) <= rad;
        }
        case 'blur':
        case 'pixelate':
        case 'rect': {
            const bb = this._bbox(el);
            return x >= bb.x - tol && x <= bb.x + bb.w + tol && y >= bb.y - tol && y <= bb.y + bb.h + tol;
        }
        case 'ellipse': {
            const cx = (el.x0 + el.x1) / 2, cy = (el.y0 + el.y1) / 2;
            const rx = Math.abs(el.x1 - el.x0) / 2 + tol, ry = Math.abs(el.y1 - el.y0) / 2 + tol;
            if (rx < 1 || ry < 1) return false;
            const nx = (x - cx) / rx, ny = (y - cy) / ry;
            return nx * nx + ny * ny <= 1;
        }
        case 'pen':
        case 'highlight': {
            const pts = el.points;
            for (let i = 1; i < pts.length; i++) {
                if (this._distToSeg(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= tol)
                    return true;
            }
            return false;
        }
        case 'line':
        case 'arrow':
            return this._distToSeg(x, y, el.x0, el.y0, el.x1, el.y1) <= tol;
        }
        return false;
    }

    _distToSeg(px, py, x0, y0, x1, y1) {
        const dx = x1 - x0, dy = y1 - y0;
        const len2 = dx * dx + dy * dy;
        let t = len2 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const cx = x0 + t * dx, cy = y0 + t * dy;
        return Math.hypot(px - cx, py - cy);
    }

    _bbox(el) {
        switch (el.tool) {
        case 'text': {
            const [, tw] = el.actor.clutter_text.get_preferred_width(-1);
            return {x: el.actor.x, y: el.actor.y, w: Math.max(tw, 8), h: el.actor.height};
        }
        case 'blur':
        case 'pixelate':
            return {x: el.x, y: el.y, w: el.w, h: el.h};
        case 'number': {
            const rad = 9 + el.width;
            return {x: el.x - rad, y: el.y - rad, w: rad * 2, h: rad * 2};
        }
        case 'pen':
        case 'highlight': {
            let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
            for (const [px, py] of el.points) {
                minx = Math.min(minx, px); miny = Math.min(miny, py);
                maxx = Math.max(maxx, px); maxy = Math.max(maxy, py);
            }
            return {x: minx, y: miny, w: maxx - minx, h: maxy - miny};
        }
        default: {
            const x = Math.min(el.x0, el.x1), y = Math.min(el.y0, el.y1);
            return {x, y, w: Math.abs(el.x1 - el.x0), h: Math.abs(el.y1 - el.y0)};
        }
        }
    }

    _snapshot(el) {
        if (el.points)
            return {points: el.points.map(p => [p[0], p[1]])};
        if (el.tool === 'text')
            return {x: el.actor.x, y: el.actor.y};
        if (isRedact(el.tool) || el.tool === 'number')
            return {x: el.x, y: el.y, w: el.w, h: el.h};
        return {x0: el.x0, y0: el.y0, x1: el.x1, y1: el.y1};
    }

    _applyTranslate(el, snap, dx, dy) {
        if (el.points) {
            el.points = snap.points.map(p => [p[0] + dx, p[1] + dy]);
        } else if (el.tool === 'text') {
            el.actor.set_position(Math.round(snap.x + dx), Math.round(snap.y + dy));
        } else if (isRedact(el.tool)) {
            el.x = snap.x + dx; el.y = snap.y + dy;
            if (el.actor)
                el.actor.set_clip(el.x, el.y, el.w, el.h);
        } else if (el.tool === 'number') {
            el.x = snap.x + dx; el.y = snap.y + dy;
        } else {
            el.x0 = snap.x0 + dx; el.y0 = snap.y0 + dy;
            el.x1 = snap.x1 + dx; el.y1 = snap.y1 + dy;
        }
    }

    _deleteSelected() {
        const el = this._selected;
        this._selected = null;
        if (!el)
            return;
        const idx = this._elements.indexOf(el);
        if (idx >= 0)
            this._elements.splice(idx, 1);
        if (el.actor)
            el.actor.destroy();
        this._redo = [];
        this._annot.queue_repaint();
    }

    _onScroll(event) {
        if (this._phase !== EDIT)
            return Clutter.EVENT_STOP;
        const dir = event.get_scroll_direction();
        if (dir === Clutter.ScrollDirection.UP)
            this._setWidth(this._width + 2);
        else if (dir === Clutter.ScrollDirection.DOWN)
            this._setWidth(this._width - 2);
        return Clutter.EVENT_STOP;
    }

    _isDrawn(el) {
        if (el.points)
            return el.points.length > 1;
        return Math.abs(el.x1 - el.x0) > 2 || Math.abs(el.y1 - el.y0) > 2;
    }

    // Commit a new element and clear the redo stack (standard undo semantics).
    _commit(el) {
        this._elements.push(el);
        this._redo = [];
        this._selected = null;
    }

    _onKey(event) {
        const sym = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;

        if (sym === Clutter.KEY_Escape) {
            if (this._selected) {
                this._selected = null;
                this._annot.queue_repaint();
                return Clutter.EVENT_STOP;
            }
            this._teardown();
            return Clutter.EVENT_STOP;
        }
        if ((sym === Clutter.KEY_Delete || sym === Clutter.KEY_BackSpace) && this._selected) {
            this._deleteSelected();
            return Clutter.EVENT_STOP;
        }
        if (ctrl && shift && (sym === Clutter.KEY_z || sym === Clutter.KEY_Z)) {
            this._redoAction();
            return Clutter.EVENT_STOP;
        }
        if (ctrl && (sym === Clutter.KEY_y || sym === Clutter.KEY_Y)) {
            this._redoAction();
            return Clutter.EVENT_STOP;
        }
        if (ctrl && (sym === Clutter.KEY_z || sym === Clutter.KEY_Z)) {
            this._undo();
            return Clutter.EVENT_STOP;
        }
        if (ctrl && (sym === Clutter.KEY_c || sym === Clutter.KEY_C)) {
            if (this._region)
                this._confirm(false).catch(e => { logError(e, 'ArrowShot: copy failed'); this._teardown(); });
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
            if (this._region)
                this._confirm(true).catch(e => { logError(e, 'ArrowShot: capture failed'); this._teardown(); });
            return Clutter.EVENT_STOP;
        }
        if (this._phase === EDIT) {
            for (const t of TOOLS) {
                if (sym === t.key) {
                    this._selectTool(t.id);
                    return Clutter.EVENT_STOP;
                }
            }
        }
        return Clutter.EVENT_STOP;
    }

    _undo() {
        const el = this._elements.pop();
        if (!el)
            return;
        if (el.actor)
            el.actor.hide();
        this._redo.push(el);
        this._selected = null;
        this._annot.queue_repaint();
    }

    _redoAction() {
        const el = this._redo.pop();
        if (!el)
            return;
        if (el.actor)
            el.actor.show();
        this._elements.push(el);
        this._selected = null;
        this._annot.queue_repaint();
    }

    // ---- text tool ------------------------------------------------------

    _startText(x, y) {
        const fontSize = Math.max(14, this._width * 4);
        const entry = new St.Entry({
            style: `background-color: transparent; border: none; padding: 0; ` +
                   `color: ${cssRGBA(this._color)}; font-size: ${fontSize}px; font-weight: bold;`,
            x, y,
            width: Math.max(120, Math.min(500, (this._region.x + this._region.w) - x)),
        });
        this._ui.add_child(entry);
        this._ui.set_child_above_sibling(entry, this._annot);
        this._activeEntry = entry;
        entry.grab_key_focus();

        entry.clutter_text.connect('activate', () => this._commitText());
        entry.connect('key-press-event', (a, e) => {
            if (e.get_key_symbol() === Clutter.KEY_Escape) {
                this._commitText();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _commitText() {
        const entry = this._activeEntry;
        this._activeEntry = null;
        if (!entry) {
            if (this._canvas)
                this._canvas.grab_key_focus();
            return;
        }
        const text = entry.get_text();
        if (text && text.trim()) {
            // Replace the editable entry with a plain label at the text's exact
            // current on-screen position, so losing focus/cursor doesn't shift it.
            const [tx, ty] = entry.clutter_text.get_transformed_position();
            const fontSize = Math.max(14, this._width * 4);
            const label = new St.Label({
                text,
                style: `color: ${cssRGBA(this._color)}; font-size: ${fontSize}px; ` +
                       `font-weight: bold; padding: 0;`,
                x: Math.round(tx), y: Math.round(ty),
            });
            this._ui.add_child(label);
            this._ui.set_child_above_sibling(label, this._annot);
            this._commit({tool: 'text', color: this._color, actor: label});
        }
        entry.destroy();
        if (this._canvas)
            this._canvas.grab_key_focus();
    }

    // ---- number-stamp tool ---------------------------------------------

    _placeNumber(x, y) {
        this._commit({tool: 'number', x, y, n: this._stampCounter++, color: this._color, width: this._width});
        this._annot.queue_repaint();
        if (this._canvas)
            this._canvas.grab_key_focus();
    }

    // ---- blur tool ------------------------------------------------------

    // A full-stage actor showing the frozen content, clipped to the region and
    // blurred/pixelated — so it redacts exactly what's under the clip. Returns
    // null if the effect isn't available on this build.
    _makeRedactActor(type, x, y, w, h) {
        try {
            const patch = new St.Widget({
                x: 0, y: 0, width: this._stageW, height: this._stageH,
                content: this._content,
            });
            patch.set_clip(x, y, Math.max(1, w), Math.max(1, h));
            if (type === 'pixelate') {
                const eff = new PixelateEffect();
                patch.add_effect(eff);
                const block = 5 + this._width; // bigger thickness => bigger blocks
                eff.setBlockUV(block / this._stageW, block / this._stageH);
            } else {
                patch.add_effect(new Shell.BlurEffect({
                    radius: BLUR_RADIUS, brightness: 1.0, mode: Shell.BlurMode.ACTOR,
                }));
            }
            this._blurGroup.add_child(patch);
            return patch;
        } catch (e) {
            logError(e, 'ArrowShot: redact effect unavailable on this build');
            return null;
        }
    }

    _updateBlurClip(el) {
        el.x = Math.min(el.x0, el.x1);
        el.y = Math.min(el.y0, el.y1);
        el.w = Math.abs(el.x1 - el.x0);
        el.h = Math.abs(el.y1 - el.y0);
        if (el.actor)
            el.actor.set_clip(el.x, el.y, Math.max(1, el.w), Math.max(1, el.h));
    }

    // ---- rendering ------------------------------------------------------

    _paintChrome(area) {
        const cr = area.get_context();
        cr.setSourceRGBA(0, 0, 0, DIM_ALPHA);
        cr.paint();
        const r = this._region;
        if (r && r.w > 0 && r.h > 0) {
            cr.setOperator(cairo.Operator.CLEAR);
            cr.rectangle(r.x, r.y, r.w, r.h);
            cr.fill();
            cr.setOperator(cairo.Operator.OVER);
            cr.setSourceRGBA(1, 1, 1, 0.9);
            cr.setLineWidth(1);
            cr.rectangle(r.x + 0.5, r.y + 0.5, Math.max(0, r.w - 1), Math.max(0, r.h - 1));
            cr.stroke();
            if (this._phase === SELECT)
                this._paintSizeLabel(cr, r);
            else
                this._paintHandles(cr, r);
        }
        cr.$dispose();
    }

    _paintHandles(cr, r) {
        const hs = 4;
        const xs = [r.x, r.x + r.w / 2, r.x + r.w];
        const ys = [r.y, r.y + r.h / 2, r.y + r.h];
        cr.setSourceRGBA(1, 1, 1, 0.95);
        for (const hx of xs) {
            for (const hy of ys) {
                if (hx === r.x + r.w / 2 && hy === r.y + r.h / 2)
                    continue; // no center handle
                cr.rectangle(hx - hs, hy - hs, hs * 2, hs * 2);
                cr.fill();
            }
        }
    }

    _paintSizeLabel(cr, r) {
        const label = `${Math.round(r.w)} × ${Math.round(r.h)}`;
        cr.setFontSize(13);
        let tw = label.length * 8;
        let th = 13;
        try {
            const ext = cr.textExtents(label);
            if (ext && ext.width) {
                tw = ext.width;
                th = ext.height;
            }
        } catch (e) {}
        const padX = 6, padY = 4;
        let bx = r.x;
        let by = r.y - th - padY * 2 - 2;
        if (by < 2)
            by = r.y + 2;
        cr.setSourceRGBA(0, 0, 0, 0.65);
        cr.rectangle(bx, by, tw + padX * 2, th + padY * 2);
        cr.fill();
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.moveTo(bx + padX, by + th + padY - 1);
        cr.showText(label);
    }

    _paintAnnot(area) {
        const cr = area.get_context();
        for (const el of this._elements) {
            if (el.tool === 'text' || isRedact(el.tool))
                continue;
            this._renderShape(cr, el);
        }
        if (this._current)
            this._renderShape(cr, this._current);
        if (this._selected) {
            const bb = this._bbox(this._selected);
            if (bb && isFinite(bb.w) && isFinite(bb.h)) {
                cr.setSourceRGBA(0.32, 0.62, 1.0, 0.95);
                cr.setLineWidth(1.5);
                cr.setDash([5, 3], 0);
                cr.rectangle(bb.x - 4, bb.y - 4, bb.w + 8, bb.h + 8);
                cr.stroke();
                cr.setDash([], 0);
            }
        }
        cr.$dispose();
    }

    _renderShape(cr, el) {
        const hl = el.tool === 'highlight';
        const col = el.color || PALETTE[0][1];
        const width = el.width || 4;
        cr.setLineWidth(hl ? width * 3.5 : width);
        cr.setLineCap(cairo.LineCap.ROUND);
        cr.setLineJoin(cairo.LineJoin.ROUND);
        cr.setSourceRGBA(col[0], col[1], col[2], hl ? HIGHLIGHT_ALPHA : (col[3] ?? 1));

        switch (el.tool) {
        case 'pen':
        case 'highlight': {
            const pts = el.points;
            if (pts.length < 2)
                break;
            cr.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++)
                cr.lineTo(pts[i][0], pts[i][1]);
            cr.stroke();
            break;
        }
        case 'line':
            cr.moveTo(el.x0, el.y0);
            cr.lineTo(el.x1, el.y1);
            cr.stroke();
            break;
        case 'arrow': {
            cr.moveTo(el.x0, el.y0);
            cr.lineTo(el.x1, el.y1);
            cr.stroke();
            const angle = Math.atan2(el.y1 - el.y0, el.x1 - el.x0);
            const len = width * 4 + 6;
            const spread = Math.PI / 7;
            cr.moveTo(el.x1, el.y1);
            cr.lineTo(el.x1 - len * Math.cos(angle - spread), el.y1 - len * Math.sin(angle - spread));
            cr.moveTo(el.x1, el.y1);
            cr.lineTo(el.x1 - len * Math.cos(angle + spread), el.y1 - len * Math.sin(angle + spread));
            cr.stroke();
            break;
        }
        case 'rect': {
            const x = Math.min(el.x0, el.x1), y = Math.min(el.y0, el.y1);
            cr.rectangle(x, y, Math.abs(el.x1 - el.x0), Math.abs(el.y1 - el.y0));
            cr.stroke();
            break;
        }
        case 'ellipse': {
            const cx = (el.x0 + el.x1) / 2, cy = (el.y0 + el.y1) / 2;
            const rx = Math.abs(el.x1 - el.x0) / 2, ry = Math.abs(el.y1 - el.y0) / 2;
            if (rx < 1 || ry < 1)
                break;
            cr.save();
            cr.translate(cx, cy);
            cr.scale(rx, ry);
            cr.arc(0, 0, 1, 0, 2 * Math.PI);
            cr.restore();
            cr.stroke();
            break;
        }
        case 'number': {
            const rad = 9 + width;
            cr.setSourceRGBA(col[0], col[1], col[2], 1);
            cr.arc(el.x, el.y, rad, 0, 2 * Math.PI);
            cr.fill();
            const label = String(el.n);
            cr.setSourceRGBA(1, 1, 1, 1);
            cr.selectFontFace('Sans', cairo.FontSlant.NORMAL, cairo.FontWeight.BOLD);
            cr.setFontSize(rad * 1.2);
            let tw = label.length * rad * 0.6, th = rad;
            try {
                const ext = cr.textExtents(label);
                if (ext && ext.width) {
                    tw = ext.width;
                    th = ext.height;
                }
            } catch (e) {}
            cr.moveTo(el.x - tw / 2, el.y + th / 2);
            cr.showText(label);
            break;
        }
        }
    }

    // ---- toolbar --------------------------------------------------------

    _gicon(name) {
        try {
            const f = Gio.File.new_for_path(`${this._extPath}/icons/${name}.svg`);
            if (f.query_exists(null))
                return new Gio.FileIcon({file: f});
        } catch (e) {}
        return null;
    }

    // Text-label button (used for −/+ thickness).
    _mkButton(parent, label, onClick, tip) {
        const b = new St.Button({
            label,
            style: 'font-size: 15px; font-weight: bold; color: #eee; ' +
                   'min-width: 30px; min-height: 30px; border-radius: 6px;',
            reactive: true, can_focus: false,
        });
        b.connect('clicked', () => onClick());
        if (tip)
            this._attachTooltip(b, tip);
        parent.add_child(b);
        return b;
    }

    // Icon button, falling back to a glyph label if the SVG is missing.
    _mkIconButton(parent, iconName, glyph, tip, onClick) {
        const b = new St.Button({
            style: 'min-width: 32px; min-height: 32px; border-radius: 6px;',
            reactive: true, can_focus: false,
        });
        const gicon = this._gicon(iconName);
        if (gicon)
            b.set_child(new St.Icon({gicon, icon_size: 16, style: 'color: #ffffff;'}));
        else
            b.set_label(glyph);
        b.connect('clicked', () => onClick());
        if (tip)
            this._attachTooltip(b, tip);
        parent.add_child(b);
        return b;
    }

    _attachTooltip(actor, text) {
        const id = actor.connect('notify::hover', () => {
            if (actor.hover)
                this._showTooltip(actor, text);
            else
                this._hideTooltip();
        });
        this._ids.push([actor, id]);
    }

    _showTooltip(actor, text) {
        this._hideTooltip();
        const tip = new St.Label({
            text,
            style: 'background-color: rgba(0,0,0,0.9); color: #fff; padding: 3px 7px; ' +
                   'border-radius: 5px; font-size: 12px;',
        });
        Main.layoutManager.uiGroup.add_child(tip);
        const [ax, ay] = actor.get_transformed_position();
        tip.set_position(Math.round(ax), Math.round(ay + actor.height + 4));
        this._tooltip = tip;
    }

    _hideTooltip() {
        if (this._tooltip) {
            this._tooltip.destroy();
            this._tooltip = null;
        }
    }

    _sep(parent) {
        parent.add_child(new St.Widget({
            width: 1,
            style: 'background-color: rgba(255,255,255,0.2); margin: 3px 4px;',
        }));
    }

    _buildToolbar() {
        const bar = new St.BoxLayout({
            vertical: true,
            style: 'background-color: rgba(30,30,30,0.94); border-radius: 10px; ' +
                   'padding: 6px; spacing: 6px;',
            reactive: true,
        });
        const row1 = new St.BoxLayout({style: 'spacing: 4px;'});
        const row2 = new St.BoxLayout({style: 'spacing: 4px;'});
        bar.add_child(row1);
        bar.add_child(row2);

        // Row 1: tools + actions.
        for (const t of TOOLS)
            this._toolButtons.set(t.id, this._mkIconButton(row1, t.id, t.glyph, t.tip, () => this._selectTool(t.id)));
        this._sep(row1);
        this._mkIconButton(row1, 'undo', '↺', 'Undo (Ctrl+Z)', () => this._undo());
        this._mkIconButton(row1, 'redo', '↻', 'Redo (Ctrl+Shift+Z)', () => this._redoAction());
        this._mkIconButton(row1, 'copy', '⧉', 'Copy to clipboard (Ctrl+C)', () =>
            this._confirm(false).catch(e => { logError(e, 'ArrowShot: copy failed'); this._teardown(); }));
        this._mkIconButton(row1, 'save', '✓', 'Save + copy (Enter)', () =>
            this._confirm(true).catch(e => { logError(e, 'ArrowShot: capture failed'); this._teardown(); }));
        this._mkIconButton(row1, 'cancel', '✗', 'Cancel (Esc)', () => this._teardown());

        // Row 2: color swatches + thickness.
        for (const [name, col] of PALETTE) {
            const sw = new St.Button({
                style: `background-color: ${cssRGBA(col)}; min-width: 22px; min-height: 22px; ` +
                       `border-radius: 4px; border: 2px solid rgba(255,255,255,0.35);`,
                reactive: true, can_focus: false,
            });
            sw.connect('clicked', () => this._setColor(col));
            row2.add_child(sw);
            this._swatches.set(name, {btn: sw, col});
        }
        this._sep(row2);
        this._mkButton(row2, '−', () => this._setWidth(this._width - 2));
        this._widthLabel = new St.Label({
            text: `${this._width}px`,
            style: 'color: #eee; min-width: 34px; text-align: center;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row2.add_child(this._widthLabel);
        this._mkButton(row2, '+', () => this._setWidth(this._width + 2));

        this._toolbar = bar;
        this._ui.add_child(bar);
        this._highlightTool();
        this._highlightSwatch();
        this._positionToolbar();
    }

    _positionToolbar() {
        const r = this._region;
        const [, natW] = this._toolbar.get_preferred_width(-1);
        const [, natH] = this._toolbar.get_preferred_height(-1);
        let tx = r.x;
        let ty = r.y + r.h + 8;
        if (ty + natH > this._stageH)
            ty = Math.max(4, r.y - natH - 8);
        tx = Math.max(4, Math.min(tx, this._stageW - natW - 4));
        this._toolbar.set_position(Math.round(tx), Math.round(ty));
    }

    _selectTool(id) {
        if (this._activeEntry)
            this._commitText();
        this._tool = id;
        if (id !== 'select') {
            this._selected = null;
            this._annot.queue_repaint();
        }
        this._highlightTool();
        this._setCursor(id === 'text' ? 'IBEAM' : (id === 'select' ? 'DEFAULT' : 'CROSSHAIR'));
        if (this._canvas)
            this._canvas.grab_key_focus();
    }

    _highlightTool() {
        for (const [id, b] of this._toolButtons) {
            const active = id === this._tool;
            b.set_style('min-width: 32px; min-height: 32px; border-radius: 6px; ' +
                'font-size: 15px; font-weight: bold; color: #fff; ' +
                (active ? 'background-color: rgba(80,140,255,0.9);' : 'background-color: transparent;'));
        }
    }

    _setColor(col) {
        this._color = col;
        this._highlightSwatch();
        if (this._canvas)
            this._canvas.grab_key_focus();
    }

    _highlightSwatch() {
        for (const {btn, col} of this._swatches.values()) {
            const active = col === this._color;
            btn.set_style(`background-color: ${cssRGBA(col)}; min-width: 22px; min-height: 22px; ` +
                `border-radius: 4px; border: 2px solid ${active ? '#ffffff' : 'rgba(255,255,255,0.35)'};`);
        }
    }

    _setWidth(w) {
        this._width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w));
        if (this._widthLabel)
            this._widthLabel.set_text(`${this._width}px`);
    }

    // ---- confirm / output ----------------------------------------------

    _waitForRedraw() {
        return new Promise(resolve => {
            let stageId = 0;
            const finish = () => {
                if (stageId) {
                    try {
                        global.stage.disconnect(stageId);
                    } catch (e) {}
                    stageId = 0;
                }
                resolve();
            };
            try {
                stageId = global.stage.connect('after-paint', () => finish());
                global.stage.queue_redraw();
            } catch (e) {}
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                finish();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    async _confirm(save = true) {
        if (this._activeEntry)
            this._commitText();
        const r = this._region;

        // Keep only backdrop + blur + vector + text; drop dim, selection,
        // toolbar, and the selection indicator so none bake into the image.
        this._selected = null;
        this._annot.queue_repaint();
        this._chrome.hide();
        if (this._toolbar)
            this._toolbar.hide();
        this._setCursor('DEFAULT');
        await this._waitForRedraw();

        const stream = Gio.MemoryOutputStream.new_resizable();
        await this._shooter.screenshot_area(r.x, r.y, r.w, r.h, stream);
        stream.close(null);
        const bytes = stream.steal_as_bytes();

        St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);
        const file = save ? this._saveToDisk(bytes) : null;

        this._teardown();
        Main.notify('ArrowShot',
            file ? `Saved “${file.get_basename()}” and copied to clipboard`
                 : 'Copied to clipboard');
    }

    _saveToDisk(bytes) {
        try {
            let dir;
            if (this._saveDir && this._saveDir.trim()) {
                dir = Gio.File.new_for_path(this._saveDir);
            } else {
                const pics = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ||
                    GLib.get_home_dir();
                dir = Gio.File.new_for_path(GLib.build_filenamev([pics, 'Screenshots']));
            }
            try {
                dir.make_directory_with_parents(null);
            } catch (e) {}
            const stamp = GLib.DateTime.new_now_local().format('%Y-%m-%d %H-%M-%S');
            const base = `Screenshot from ${stamp}`;
            let file = dir.get_child(`${base}.png`);
            let n = 1;
            while (file.query_exists(null))
                file = dir.get_child(`${base}-${n++}.png`);
            const out = file.create(Gio.FileCreateFlags.NONE, null);
            out.write_bytes(bytes, null);
            out.close(null);
            return file;
        } catch (e) {
            logError(e, 'ArrowShot: save to disk failed');
            return null;
        }
    }

    // ---- teardown -------------------------------------------------------

    _teardown() {
        if (this._teardownDone)
            return;
        this._teardownDone = true;

        for (const [obj, id] of this._ids) {
            try {
                obj.disconnect(id);
            } catch (e) {}
        }
        this._ids = [];
        this._setCursor('DEFAULT');
        this._hideTooltip();

        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        // Destroying these parents also destroys all child + blur + text actors.
        for (const name of ['_toolbar', '_canvas', '_annot', '_chrome', '_ui', '_blurGroup', '_bg']) {
            if (this[name]) {
                this[name].destroy();
                this[name] = null;
            }
        }
        if (this._onDone) {
            const cb = this._onDone;
            this._onDone = null;
            cb();
        }
    }

    destroy() {
        this._teardown();
    }
}

export default class ArrowShotExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._session = null;
        Main.wm.addKeybinding(
            'capture-shortcut',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._start());
    }

    disable() {
        Main.wm.removeKeybinding('capture-shortcut');
        if (this._session) {
            this._session.destroy();
            this._session = null;
        }
        this._settings = null;
    }

    _start() {
        if (this._session)
            return;
        this._session = new CaptureSession(() => {
            this._session = null;
        }, this.path, this._settings);
    }
}
