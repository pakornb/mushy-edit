// Shared vector-annotation engine. Strokes are stored in normalized (0..1)
// coordinates relative to the image's content box, so they scale to any render
// size (preview, asset thumb, mp4 frame, viewer).

export const ANNO_COLORS = ['#ff3b3b', '#ffcc00', '#4ea8de', '#6cc070', '#ffffff', '#111111'];

// text annotation font choices — system faces only, no bundled webfonts
export const ANNO_FONTS = [
  { label: 'Sans', css: 'Helvetica, Arial, sans-serif' },
  { label: 'Serif', css: 'Georgia, "Times New Roman", serif' },
  { label: 'Mono', css: '"SF Mono", "Courier New", monospace' },
  { label: 'Marker', css: '"Marker Felt", "Comic Sans MS", cursive' },
];

// content rect of an <img>/<canvas> honoring object-fit: contain
export function contentRect(el) {
  const bw = el.clientWidth, bh = el.clientHeight;
  const iw = el.naturalWidth || el.width || bw, ih = el.naturalHeight || el.height || bh;
  if (!iw || !ih) return { x: 0, y: 0, w: bw, h: bh };
  const s = Math.min(bw / iw, bh / ih);
  const w = iw * s, h = ih * s;
  return { x: (bw - w) / 2, y: (bh - h) / 2, w, h };
}

// strokes are normalized (0..1) relative to the IMAGE. `rect` is where the image
// is drawn (in ctx px): {x,y,w,h} — may extend beyond the canvas (cover crop).
export function drawAnnos(ctx, strokes, rect) {
  if (!strokes || !strokes.length) return;
  const R = rect || { x: 0, y: 0, w: ctx.canvas.width, h: ctx.canvas.height };
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const lw = Math.max(2, Math.round(R.w / 300));
  const P = (p) => ({ x: R.x + p.x * R.w, y: R.y + p.y * R.h });
  strokes.forEach((s) => {
    ctx.strokeStyle = s.color || '#ff3b3b'; ctx.fillStyle = s.color || '#ff3b3b';
    ctx.lineWidth = lw;
    if (s.type === 'free' && s.pts.length > 1) {
      ctx.beginPath(); const a = P(s.pts[0]); ctx.moveTo(a.x, a.y);
      for (let i = 1; i < s.pts.length; i++) { const b = P(s.pts[i]); ctx.lineTo(b.x, b.y); }
      ctx.stroke();
    } else if (s.type === 'box') {
      const a = P(s.pts[0]), b = P(s.pts[1]); ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    } else if (s.type === 'ellipse') {
      const a = P(s.pts[0]), b = P(s.pts[1]); ctx.beginPath();
      ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2); ctx.stroke();
    } else if (s.type === 'arrow') {
      const a = P(s.pts[0]), b = P(s.pts[1]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const ang = Math.atan2(b.y - a.y, b.x - a.x), hl = lw * 4;
      ctx.beginPath(); ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - hl * Math.cos(ang - 0.4), b.y - hl * Math.sin(ang - 0.4));
      ctx.lineTo(b.x - hl * Math.cos(ang + 0.4), b.y - hl * Math.sin(ang + 0.4));
      ctx.closePath(); ctx.fill();
    } else if (s.type === 'text') {
      // font size tracks the bbox height directly, so resizing the box IS scaling the font
      const a = P(s.pts[0]), b = P(s.pts[1]);
      const fs = Math.max(10, Math.round(Math.abs(b.y - a.y)));
      ctx.font = `600 ${fs}px ${s.font || ANNO_FONTS[0].css}`;
      ctx.textBaseline = 'top';
      ctx.fillText(s.text || '', Math.min(a.x, b.x), Math.min(a.y, b.y));
    }
  });
  ctx.restore();
}

// Attach an interactive annotator over `imageEl` inside `host` (position:relative).
// strokes: initial array (mutated copy returned via onCommit). Returns controller.
export function createAnnotator(host, imageEl, strokes, onCommit, opts = {}) {
  let cur = (strokes || []).slice();
  let tool = 'free', color = ANNO_COLORS[0], font = ANNO_FONTS[0].css;
  const getImageRect = opts.getImageRect || null;
  const canvas = document.createElement('canvas');
  canvas.className = 'anno-canvas';
  host.appendChild(canvas);
  let rect = { x: 0, y: 0, w: 1, h: 1 }; // image draw-rect in canvas px

  function place() {
    const w = imageEl.offsetWidth || imageEl.clientWidth || 1;
    const h = imageEl.offsetHeight || imageEl.clientHeight || 1;
    canvas.style.left = imageEl.offsetLeft + 'px';
    canvas.style.top = imageEl.offsetTop + 'px';
    canvas.width = Math.max(1, Math.round(w)); canvas.height = Math.max(1, Math.round(h));
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    rect = getImageRect ? getImageRect(canvas.width, canvas.height) : { x: 0, y: 0, w: canvas.width, h: canvas.height };
    redraw();
  }
  function redraw() { const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); drawAnnos(ctx, cur, rect); drawSelection(); }
  // pointer(px) → image-normalized (0..1 across the image)
  const norm = (e) => { const b = canvas.getBoundingClientRect(); const px = (e.clientX - b.left) * (canvas.width / b.width); const py = (e.clientY - b.top) * (canvas.height / b.height); return { x: (px - rect.x) / rect.w, y: (py - rect.y) / rect.h }; };

  let drawing = null, selIdx = -1, mode = null, hIdx = -1, startPts = null, startPt = null;

  function bbox(s) {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    s.pts.forEach((p) => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); });
    return { x0, y0, x1, y1 };
  }
  function near(a, b, d = 0.02) { return Math.hypot(a.x - b.x, a.y - b.y) < d; }
  function hitStroke(p) {
    for (let i = cur.length - 1; i >= 0; i--) {
      const s = cur[i], bb = bbox(s);
      if (p.x >= bb.x0 - 0.015 && p.x <= bb.x1 + 0.015 && p.y >= bb.y0 - 0.015 && p.y <= bb.y1 + 0.015) return i;
    }
    return -1;
  }
  function handleAt(s, p) {
    if (s.type === 'free') return -1;
    if (near(p, s.pts[0])) return 0;
    if (near(p, s.pts[1])) return 1;
    return -1;
  }
  // proportional resize (aspect-locked, anchored at the opposite corner) unless
  // free-scaling — applies to bbox-shaped elements only (box/ellipse/text);
  // arrow is a single directional segment, always free.
  function resizeHandle(s, hIdx, startPts, p, free) {
    if (!free && (s.type === 'box' || s.type === 'ellipse' || s.type === 'text')) {
      const anchor = startPts[1 - hIdx], orig = startPts[hIdx];
      const w0 = orig.x - anchor.x, h0 = orig.y - anchor.y;
      if (Math.abs(w0) > 1e-6 && Math.abs(h0) > 1e-6) {
        const sx = (p.x - anchor.x) / w0, sy = (p.y - anchor.y) / h0;
        const k = Math.abs(sx) > Math.abs(sy) ? sx : sy;
        return { x: anchor.x + w0 * k, y: anchor.y + h0 * k };
      }
    }
    return p;
  }

  let onCommitCb = onCommit;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = norm(e);
    if (tool === 'select') {
      startPt = p;
      if (selIdx >= 0) { const h = handleAt(cur[selIdx], p); if (h >= 0) { mode = 'handle'; hIdx = h; startPts = cur[selIdx].pts.map((q) => ({ ...q })); return; } }
      const i = hitStroke(p);
      selIdx = i;
      if (i >= 0) { mode = 'move'; startPts = cur[i].pts.map((q) => ({ ...q })); }
      else mode = null;
      redraw();
      return;
    }
    if (tool === 'text') {
      const t = prompt('Label text:');
      if (t) {
        const fs0 = Math.max(10, Math.round(rect.h / 22));
        const mctx = canvas.getContext('2d'); mctx.font = `600 ${fs0}px ${font}`;
        const mw = Math.max(20, mctx.measureText(t).width);
        cur.push({ type: 'text', color, font, pts: [p, { x: p.x + mw / rect.w, y: p.y + fs0 / rect.h }], text: t });
        commit();
      }
      return;
    }
    drawing = { type: tool, color, pts: [p, p] };
    if (tool === 'free') drawing.pts = [p];
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = norm(e);
    if (tool === 'select' && mode && selIdx >= 0) {
      const s = cur[selIdx];
      if (mode === 'move') { const dx = p.x - startPt.x, dy = p.y - startPt.y; s.pts = startPts.map((q) => ({ x: q.x + dx, y: q.y + dy })); }
      else if (mode === 'handle') { s.pts = startPts.map((q) => ({ ...q })); s.pts[hIdx] = resizeHandle(s, hIdx, startPts, p, e.shiftKey); }
      redraw(); return;
    }
    if (!drawing) return;
    if (drawing.type === 'free') drawing.pts.push(p); else drawing.pts[1] = p;
    const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); drawAnnos(ctx, cur.concat([drawing]), rect);
  });
  canvas.addEventListener('pointerup', () => {
    if (tool === 'select') { if (mode) { mode = null; startPts = null; commit(); } return; }
    if (!drawing) return;
    const d = drawing; drawing = null;
    const a = d.pts[0], b = d.pts[d.pts.length - 1];
    if (d.type !== 'free' && Math.hypot(b.x - a.x, b.y - a.y) < 0.01) return;
    cur.push(d); selIdx = cur.length - 1; commit();
  });

  function deleteSelected() { if (selIdx >= 0) { cur.splice(selIdx, 1); selIdx = -1; commit(); } }
  function keyHandler(e) {
    if (tool !== 'select' || selIdx < 0) return;
    if (/input|textarea|select/i.test(e.target.tagName)) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
  }
  window.addEventListener('keydown', keyHandler);

  function drawSelection() {
    if (tool !== 'select' || selIdx < 0 || !cur[selIdx]) return;
    const ctx = canvas.getContext('2d'), s = cur[selIdx], bb = bbox(s);
    const X = (x) => rect.x + x * rect.w, Y = (y) => rect.y + y * rect.h;
    ctx.save();
    ctx.strokeStyle = '#4ea8de'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
    ctx.strokeRect(X(bb.x0) - 3, Y(bb.y0) - 3, (bb.x1 - bb.x0) * rect.w + 6, (bb.y1 - bb.y0) * rect.h + 6);
    ctx.setLineDash([]);
    if (s.type !== 'free') { [s.pts[0], s.pts[1]].forEach((q) => { ctx.fillStyle = '#4ea8de'; ctx.fillRect(X(q.x) - 4, Y(q.y) - 4, 8, 8); }); }
    ctx.restore();
  }

  function commit() { redraw(); onCommitCb && onCommitCb(cur.slice()); }
  const ctrl = {
    canvas,
    setTool: (t) => { tool = t; if (t !== 'select') selIdx = -1; redraw(); }, setColor: (c) => { color = c; if (selIdx >= 0 && tool === 'select') { cur[selIdx].color = c; commit(); } },
    setFont: (f) => { font = f; if (selIdx >= 0 && tool === 'select' && cur[selIdx].type === 'text') { cur[selIdx].font = f; commit(); } },
    undo: () => { cur.pop(); selIdx = -1; commit(); },
    clear: () => { cur = []; selIdx = -1; commit(); },
    deleteSelected,
    getStrokes: () => cur.slice(),
    reflow: place,
    destroy: () => { window.removeEventListener('keydown', keyHandler); canvas.remove(); },
  };
  place();
  return ctrl;
}

// classic move-tool cursor (Photoshop-style solid arrow) — an inline SVG rather
// than an emoji glyph, since emoji rendering is inconsistent across platforms.
const MOVE_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="display:block"><path d="M1 1l5.2 13.6 1.8-4.9 4.9-1.8L1 1z"/></svg>';

// A reusable toolbar element for an annotator controller.
export function annotatorToolbar(ctrl) {
  const bar = document.createElement('div'); bar.className = 'anno-bar';
  // 'select' (move/resize) is listed first so it's the most prominent/reachable
  // tool, but 'free' (pen) stays the tool that's actually active on entry.
  const tools = [['select', MOVE_ICON], ['free', '✎'], ['arrow', '↗'], ['box', '▢'], ['ellipse', '◯'], ['text', 'T']];
  const btnOf = {};
  let curBtn = null;
  tools.forEach(([t, label]) => {
    const b = document.createElement('button'); b.className = 'anno-tool';
    if (label.startsWith('<svg')) b.innerHTML = label; else b.textContent = label;
    b.title = t === 'select' ? 'move / resize (drag = proportional, Shift+drag = free)' : t === 'free' ? 'pen' : t;
    btnOf[t] = b;
    b.onclick = () => { ctrl.setTool(t); if (curBtn) curBtn.classList.remove('on'); b.classList.add('on'); curBtn = b; };
    bar.appendChild(b);
  });
  curBtn = btnOf.free; curBtn.classList.add('on'); ctrl.setTool('free');
  const sep = document.createElement('span'); sep.className = 'anno-sep'; bar.appendChild(sep);
  ANNO_COLORS.forEach((c, i) => { const s = document.createElement('button'); s.className = 'anno-color' + (i === 0 ? ' on' : ''); s.style.background = c; s.onclick = () => { ctrl.setColor(c); bar.querySelectorAll('.anno-color').forEach((x) => x.classList.remove('on')); s.classList.add('on'); }; bar.appendChild(s); });
  const sep1b = document.createElement('span'); sep1b.className = 'anno-sep'; bar.appendChild(sep1b);
  const fontSel = document.createElement('select'); fontSel.className = 'anno-font'; fontSel.title = 'text font';
  ANNO_FONTS.forEach((f) => { const o = document.createElement('option'); o.value = f.css; o.textContent = f.label; o.style.fontFamily = f.css; fontSel.appendChild(o); });
  fontSel.onchange = () => ctrl.setFont(fontSel.value);
  bar.appendChild(fontSel);
  const sep2 = document.createElement('span'); sep2.className = 'anno-sep'; bar.appendChild(sep2);
  const del = document.createElement('button'); del.className = 'anno-tool'; del.textContent = '⌫'; del.title = 'delete selected (Del)'; del.onclick = () => ctrl.deleteSelected(); bar.appendChild(del);
  const undo = document.createElement('button'); undo.className = 'anno-tool'; undo.textContent = '⤺'; undo.title = 'remove last'; undo.onclick = () => ctrl.undo(); bar.appendChild(undo);
  const clr = document.createElement('button'); clr.className = 'anno-tool'; clr.textContent = 'clear'; clr.onclick = () => ctrl.clear(); bar.appendChild(clr);
  return bar;
}
