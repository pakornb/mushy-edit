// Storyboard sheet export: lays the timeline's visible boards out as one or
// more one-page grids (panel + number + caption underneath, flat background)
// — the same style Frame Splitter (public/frame-splitter.html) splits apart,
// so an exported page can round-trip back through it. Pages are 16:9 PNGs
// sized for a Google Slides slide.
import JSZip from 'jszip';
import { project as P, enabledFlat, getAnnos, getBoardFit, fitRect, shotMeta } from '../core/model.js';
import { drawAnnos } from '../core/annotate.js';
import { download } from './base64.js';

export const SHEET_DEFAULTS = { rows: 3, cols: 4, bg: '#ffffff', captionLines: 2, border: true, numbers: false, annos: true, shotNotes: true };
export const PAGE_SIZES = { '1920x1080': [1920, 1080], '3840x2160': [3840, 2160] };

export function sheetSettings(p = P) { return { ...SHEET_DEFAULTS, ...(p.sheetLayout || {}) }; }

// Caption for one board: its own caption, else (optionally) its shot's note on
// the shot's first visible board — shot notes are the only notes the model had
// before per-board captions existed, so they're a sensible default.
export function captionFor(p, fi, s, firstOfShot) {
  const own = p.boardCaption.get(p.frames[fi].name);
  if (own) return own;
  if (s.shotNotes && firstOfShot.has(fi)) return firstOfShot.get(fi) || '';
  return '';
}

// Visible boards in timeline order, numbered 1..n, with captions resolved.
export function sheetBoards(p = P, s = sheetSettings(p)) {
  const flat = enabledFlat(p);
  const firstOfShot = new Map();
  p.shots.forEach((sh) => { const fi = flat.find((f) => f >= sh.start && f <= sh.end); if (fi != null) firstOfShot.set(fi, shotMeta(p, sh).note || ''); });
  return flat.map((fi, i) => ({ fi, num: i + 1, caption: captionFor(p, fi, s, firstOfShot) }));
}

export function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return 1;
  const n = parseInt(m[1], 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

// Grid geometry for a W×H page: panels keep the spot aspect (resW:resH), sized
// so cols×rows cells (panel + caption band) fit inside the margins.
export function layout(W, H, s, aspect = P.resW / P.resH) {
  const margin = Math.round(W * 0.035), gapX = Math.round(W * 0.018), gapY = Math.round(W * 0.012);
  const availW = W - margin * 2 - gapX * (s.cols - 1);
  const availH = H - margin * 2 - gapY * (s.rows - 1);
  // caption band = number line + caption lines, scaled with the panel (font capped so a
  // 1-up page doesn't get billboard-sized captions)
  const capFor = (pw) => { const fs = Math.min(W * 0.02, Math.max(10, pw * 0.06)); return { fs, h: fs * ((s.numbers ? 1.5 : 0.35) + 1.25 * s.captionLines) + fs * 0.3 }; };
  const fits = (pw) => (pw / aspect + capFor(pw).h) * s.rows <= availH;
  let pw = availW / s.cols;
  if (!fits(pw)) { let lo = 1, hi = pw; for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (fits(m)) lo = m; else hi = m; } pw = lo; }
  let ph = pw / aspect;
  pw = Math.floor(pw); ph = Math.floor(ph);
  const cap = capFor(pw);
  const cellH = ph + cap.h;
  const gridW = pw * s.cols + gapX * (s.cols - 1), gridH = cellH * s.rows + gapY * (s.rows - 1);
  return { pw, ph, fs: cap.fs, cellH, gapX, gapY, x0: Math.round((W - gridW) / 2), y0: Math.round((H - gridH) / 2) };
}

function wrapLines(ctx, text, maxW, maxLines) {
  const out = [];
  for (const para of String(text).split(/\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const t = line ? line + ' ' + word : word;
      if (ctx.measureText(t).width <= maxW || !line) line = t; else { out.push(line); line = word; }
    }
    out.push(line);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  if (out.length > maxLines) {
    out.length = maxLines;
    let last = out[maxLines - 1];
    while (last && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1);
    out[maxLines - 1] = last + '…';
  }
  return out.map((l) => { while (l.length > 1 && ctx.measureText(l).width > maxW) l = l.slice(0, -1); return l; });
}

// Decoded board images, cached per export/dialog session (keyed by filename).
export function imageCache() {
  const m = new Map();
  return async (fi) => {
    const f = P.frames[fi];
    if (!m.has(f.name)) {
      m.set(f.name, (async () => {
        try { return await createImageBitmap(f.full); }
        catch { try { return await createImageBitmap(await (await fetch(f.url)).blob()); } catch { return null; } }
      })());
    }
    return m.get(f.name);
  };
}

// Text colors that read on the chosen background.
export function inkFor(bg) {
  const dark = luminance(bg) < 0.5;
  return { ink: dark ? '#ffffff' : '#111111', sub: dark ? 'rgba(255,255,255,.8)' : 'rgba(0,0,0,.72)', subHex: dark ? '#e6e6e6' : '#444444' };
}

// Top-left of grid cell i (row-major) under layout L.
export function cellPos(L, s, i) {
  const col = i % s.cols, row = Math.floor(i / s.cols);
  return { x: L.x0 + col * (L.pw + L.gapX), y: L.y0 + row * (L.cellH + L.gapY) };
}

// One board into a w×h panel at (x,y): black behind (matches preview/mp4
// letterbox), image framed by the board's fit mode and clipped to the panel.
export async function drawPanel(ctx, fi, x, y, w, h, s, getBmp) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = '#000'; ctx.fillRect(x, y, w, h);
  const bmp = await getBmp(fi);
  if (bmp) {
    const r = fitRect(getBoardFit(P, fi), bmp.width, bmp.height, w, h);
    ctx.drawImage(bmp, x + r.dx, y + r.dy, r.dw, r.dh);
    const a = s.annos ? getAnnos(P, fi) : [];
    if (a.length) drawAnnos(ctx, a, { x: x + r.dx, y: y + r.dy, w: r.dw, h: r.dh });
  }
  ctx.restore();
}

// Draws one page (boards[] slice) into a new W×H canvas.
export async function renderPage(boards, W, H, s, getBmp) {
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = s.bg; ctx.fillRect(0, 0, W, H);
  const L = layout(W, H, s);
  const { ink, sub } = inkFor(s.bg);
  const font = getComputedStyle(document.body).fontFamily || 'sans-serif';
  for (let i = 0; i < boards.length; i++) {
    const b = boards[i];
    const { x, y } = cellPos(L, s, i);
    await drawPanel(ctx, b.fi, x, y, L.pw, L.ph, s, getBmp);
    if (s.border) {
      ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1, Math.round(W / 1200));
      ctx.strokeRect(x + ctx.lineWidth / 2, y + ctx.lineWidth / 2, L.pw - ctx.lineWidth, L.ph - ctx.lineWidth);
    }
    // caption band: board number, then wrapped caption text
    ctx.textBaseline = 'top'; ctx.fillStyle = ink;
    ctx.font = `600 ${L.fs}px ${font}`;
    let ty = y + L.ph + L.fs * 0.35;
    if (s.numbers) { ctx.fillText(String(b.num), x, ty); ty += L.fs * 1.4; }
    if (s.captionLines > 0 && b.caption) {
      ctx.font = `400 ${L.fs * 0.92}px ${font}`; ctx.fillStyle = sub;
      wrapLines(ctx, b.caption, L.pw, s.captionLines).forEach((l) => { ctx.fillText(l, x, ty); ty += L.fs * 1.25; });
    }
  }
  return cv;
}

export function paginate(boards, s) {
  const per = Math.max(1, s.rows * s.cols), pages = [];
  for (let i = 0; i < boards.length; i += per) pages.push(boards.slice(i, i + per));
  return pages;
}

export const toBlob = (cv, type = 'image/png', q) => new Promise((res) => cv.toBlob(res, type, q));

// Renders every page and downloads one PNG, or a zip of PNGs for multi-page.
export async function exportStoryboardSheet({ pageSize = '1920x1080', onProgress } = {}) {
  const s = sheetSettings();
  const [W, H] = PAGE_SIZES[pageSize] || PAGE_SIZES['1920x1080'];
  const boards = sheetBoards(P, s);
  if (!boards.length) throw new Error('No visible boards to export.');
  await document.fonts?.ready;
  const pages = paginate(boards, s), getBmp = imageCache();
  const base = `${P.baseName}_storyboard`;
  if (pages.length === 1) { download(await toBlob(await renderPage(pages[0], W, H, s, getBmp)), `${base}.png`); return 1; }
  const zip = new JSZip();
  for (let i = 0; i < pages.length; i++) {
    onProgress?.(`Rendering page ${i + 1} / ${pages.length}…`);
    zip.file(`${base}_p${String(i + 1).padStart(2, '0')}.png`, await toBlob(await renderPage(pages[i], W, H, s, getBmp)));
  }
  onProgress?.('Zipping…');
  download(await zip.generateAsync({ type: 'blob' }), `${base}.zip`);
  return pages.length;
}
