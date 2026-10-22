// Drawing over the editor and REPL while lecturing.
//
// With ink switched on, an Apple Pencil (or other stylus) or a mouse draws on
// a transparent layer over the panes, while fingers keep typing, tapping and
// scrolling as usual.  The ink is not saved in the files, but each stroke is
// attached to what it was drawn on (the code of one file, or the REPL output)
// and moves when that scrolls or the text size changes.

const FADE_AFTER = 2500;   // ms a stroke stays when "fade" is on
const FADE_TIME = 700;     // ms the fade takes
const ERASE_RADIUS = 14;

// Scrolling areas ink can be attached to.
const AREAS = {
  editor: () => document.querySelector('#editor .cm-scroller'),
  output: () => document.querySelector('#output'),
};

export function setupInk({ panes, canvas, bar, button, settings, save, currentFile }) {
  const ctx = canvas.getContext('2d');
  let on = false;
  let tool = 'pen';                       // 'pen' | 'erase'
  // A stroke: {color, area, file, font, points: [x, y, w, ...], done}.  Points
  // are in the area's content coordinates at text size `font`; strokes not
  // attached to an area ('screen') are in pane coordinates.
  let strokes = [];
  let active = null;                      // {id, stroke}
  let lastInkUp = 0;
  let dirty = false;

  settings.inkColor = settings.inkColor || '#e5322d';
  settings.inkFade = !!settings.inkFade;

  // ------------------------------------------------------------ drawing

  function resize() {
    const r = panes.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    canvas.style.width = r.width + 'px';
    canvas.style.height = r.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }

  function redraw() {
    dirty = false;
    const now = performance.now();
    const r = panes.getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);
    let fading = false;
    strokes = strokes.filter((s) => {
      let alpha = 1;
      if (settings.inkFade && s.done) {
        const age = now - s.done - FADE_AFTER;
        if (age > FADE_TIME) return false;
        if (age > 0) alpha = 1 - age / FADE_TIME;
        fading = true;
      }
      const view = place(s);
      if (view) drawStroke(s, alpha, view);
      return true;
    });
    if (fading || active) requestRedraw();
  }

  // Where a stroke is on screen now: {dx, dy, f, clip}, or null if hidden.
  function place(s) {
    if (s.area === 'screen') return { dx: 0, dy: 0, f: 1, clip: null };
    if (s.area === 'editor' && s.file !== currentFile()) return null;
    const el = AREAS[s.area]();
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const pr = panes.getBoundingClientRect();
    const left = r.left - pr.left;
    const top = r.top - pr.top;
    const f = (settings.font || 20) / s.font;
    return { dx: left - el.scrollLeft, dy: top - el.scrollTop, f, clip: [left, top, r.width, r.height] };
  }

  function drawStroke(s, alpha, { dx, dy, f, clip }) {
    const raw = s.points;
    const p = [];
    for (let i = 0; i < raw.length; i += 3) p.push(dx + raw[i] * f, dy + raw[i + 1] * f, raw[i + 2]);
    ctx.save();
    if (clip) {
      ctx.beginPath();
      ctx.rect(...clip);
      ctx.clip();
    }
    drawPoints(s, p, alpha);
    ctx.restore();
  }

  function drawPoints(s, p, alpha) {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (p.length === 3) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], p[2] / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    for (let i = 3; i < p.length; i += 3) {
      ctx.beginPath();
      ctx.lineWidth = (p[i - 1] + p[i + 2]) / 2;
      ctx.moveTo(p[i - 3], p[i - 2]);
      ctx.lineTo(p[i], p[i + 1]);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function requestRedraw() {
    if (dirty) return;
    dirty = true;
    requestAnimationFrame(redraw);
  }

  // ------------------------------------------------------------ input

  const base = () => Math.max(3, Math.round((settings.font || 20) / 6));

  // Pencil reports pressure; a mouse reports 0.5 while pressed.
  const width = (e) => base() * (0.5 + (e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5));

  // Pane coordinates of an event, for erasing.
  function point(e) {
    const r = panes.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top, width(e)];
  }

  // Which area a point is over, so a new stroke can be attached to it.
  function areaAt(x, y) {
    for (const [name, get] of Object.entries(AREAS)) {
      const el = get();
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return name;
    }
    return 'screen';
  }

  // A stroke's own coordinates for an event.
  function strokePoint(s, e) {
    if (s.area === 'screen') return point(e);
    const el = AREAS[s.area]();
    const r = el.getBoundingClientRect();
    return [e.clientX - r.left + el.scrollLeft, e.clientY - r.top + el.scrollTop, width(e)];
  }

  function inside(e) {
    const r = panes.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  function wantsInk(e) {
    if (!on || !(e.pointerType === 'pen' || e.pointerType === 'mouse')) return false;
    if (e.pointerType === 'mouse' && e.button !== 0) return false;
    if (e.target.closest && e.target.closest('#ink-bar, #toolbar, .sheet')) return false;
    return inside(e);
  }

  function erase(x, y) {
    const before = strokes.length;
    strokes = strokes.filter((s) => {
      const v = place(s);
      if (!v) return true;
      for (let i = 0; i < s.points.length; i += 3) {
        const sx = v.dx + s.points[i] * v.f;
        const sy = v.dy + s.points[i + 1] * v.f;
        if (Math.hypot(sx - x, sy - y) < ERASE_RADIUS + s.points[i + 2]) return false;
      }
      return true;
    });
    if (strokes.length !== before) requestRedraw();
  }

  function swallow(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  document.addEventListener('pointerdown', (e) => {
    if (!wantsInk(e)) return;
    swallow(e);
    try { panes.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const p = point(e);
    if (tool === 'erase') {
      active = { id: e.pointerId, stroke: null };
      erase(p[0], p[1]);
      return;
    }
    const area = areaAt(e.clientX, e.clientY);
    const stroke = { color: settings.inkColor, area, file: currentFile(), font: settings.font || 20, points: [], done: 0 };
    stroke.points = strokePoint(stroke, e);
    strokes.push(stroke);
    active = { id: e.pointerId, stroke };
    requestRedraw();
  }, true);

  document.addEventListener('pointermove', (e) => {
    if (!active || e.pointerId !== active.id) return;
    swallow(e);
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) {
      if (active.stroke) {
        active.stroke.points.push(...strokePoint(active.stroke, ev));
      } else {
        const p = point(ev);
        erase(p[0], p[1]);
      }
    }
    requestRedraw();
  }, true);

  function end(e) {
    if (!active || e.pointerId !== active.id) return;
    swallow(e);
    if (active.stroke) active.stroke.done = performance.now();
    active = null;
    lastInkUp = Date.now();
    requestRedraw();
  }
  document.addEventListener('pointerup', end, true);
  document.addEventListener('pointercancel', end, true);

  // A pen stroke must not also click, focus or select what is under it.
  for (const type of ['click', 'mousedown', 'dblclick', 'contextmenu']) {
    document.addEventListener(type, (e) => {
      if (active || Date.now() - lastInkUp < 400) {
        if (!(e.target.closest && e.target.closest('#ink-bar, #toolbar, .sheet'))) swallow(e);
      }
    }, true);
  }

  // On iPad the Pencil also sends touch events, which would scroll the page or
  // start Scribble handwriting; stop those while drawing.
  const stylus = (e) => Array.from(e.changedTouches || []).some((t) => t.touchType === 'stylus');
  for (const type of ['touchstart', 'touchmove']) {
    document.addEventListener(type, (e) => {
      if (!on || !stylus(e)) return;
      const t = e.changedTouches[0];
      if (e.target.closest && e.target.closest('#ink-bar, #toolbar, .sheet')) return;
      if (type === 'touchstart' && !inside(t)) return;
      e.preventDefault();
    }, { capture: true, passive: false });
  }

  // ------------------------------------------------------------ controls

  function setOn(v) {
    on = v;
    button.setAttribute('aria-pressed', String(on));
    bar.hidden = !on;
    canvas.hidden = false;
    if (on) resize();
  }

  function updateBar() {
    for (const b of bar.querySelectorAll('[data-color]')) {
      b.setAttribute('aria-pressed', String(tool === 'pen' && b.dataset.color === settings.inkColor));
    }
    bar.querySelector('[data-tool="erase"]').setAttribute('aria-pressed', String(tool === 'erase'));
    bar.querySelector('[data-action="fade"]').setAttribute('aria-pressed', String(settings.inkFade));
  }

  button.addEventListener('click', () => setOn(!on));
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.color) {
      settings.inkColor = b.dataset.color;
      tool = 'pen';
    } else if (b.dataset.tool === 'erase') {
      tool = tool === 'erase' ? 'pen' : 'erase';
    } else if (b.dataset.action === 'fade') {
      settings.inkFade = !settings.inkFade;
      for (const s of strokes) if (s.done) s.done = performance.now();
    } else if (b.dataset.action === 'clear') {
      strokes = [];
    }
    updateBar();
    save();
    requestRedraw();
  });

  new ResizeObserver(resize).observe(panes);
  // Scroll events do not bubble, so listen in the capture phase.
  document.addEventListener('scroll', requestRedraw, true);
  updateBar();
  setOn(false);

  return {
    clear() { strokes = []; requestRedraw(); },
    // Called when the text an area shows changes completely (e.g. switching files).
    refresh: requestRedraw,
    clearArea(area) { strokes = strokes.filter((s) => s.area !== area); requestRedraw(); },
    get on() { return on; },
    toggle() { setOn(!on); },
    strokeCount: () => strokes.length,
  };
}
