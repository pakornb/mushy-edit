import JSZip from 'jszip';
import { project, IMG_RE, naturalSort, shotKeyOf, deriveBaseName, computeShots } from './model.js';

const THUMB_W = 152, THUMB_H = 88;
const TINY_W = 48, TINY_H = 27;

export async function loadFromFiles(fileList, { preserve = false } = {}) {
  const files = [...fileList].filter((f) => IMG_RE.test(f.name)).sort((a, b) => naturalSort(a.name, b.name));
  if (!files.length) throw new Error('No image files found.');
  const items = files.map((f) => ({ name: f.name, blob: f }));
  return ingest(items, 'files', files[0].name, null, preserve);
}

export async function loadFromZip(file, { preserve = false } = {}) {
  const zip = await JSZip.loadAsync(file);
  const entries = [];
  zip.forEach((path, entry) => {
    const leaf = path.split('/').pop();
    if (!entry.dir && IMG_RE.test(path) && !leaf.startsWith('.')) entries.push(entry);
  });
  if (!entries.length) throw new Error('No images inside that zip.');
  entries.sort((a, b) => naturalSort(a.name, b.name));
  const items = [];
  for (const e of entries) items.push({ name: e.name.split('/').pop(), blob: await e.async('blob') });
  return ingest(items, 'zip', items[0].name, file.name, preserve);
}

// items: [{ name, blob }]
async function ingest(items, source, firstName, zipName, preserve, onProgress) {
  const p = project;
  p.frames.forEach((f) => f.url && f.url.startsWith('blob:') && URL.revokeObjectURL(f.url));
  p.frames = [];
  p.diffs = [];
  p.frameKeys = [];
  if (!preserve) {
    p.manualAdd.clear(); p.manualRemove.clear(); p.meta.clear();
  }
  p.source = source;
  if (!preserve) p.baseName = deriveBaseName(source, firstName, zipName);

  const tctx = makeTinyCtx();
  let maxW = 0, maxH = 0;

  for (let i = 0; i < items.length; i++) {
    const { name, blob } = items[i];
    const url = URL.createObjectURL(blob);
    const img = await loadImage(url).catch(() => null);
    if (!img) { URL.revokeObjectURL(url); continue; }
    if (img.naturalWidth > maxW) maxW = img.naturalWidth;
    if (img.naturalHeight > maxH) maxH = img.naturalHeight;

    const thumb = makeThumb(img);
    const luma = computeLuma(tctx, img);

    p.frames.push({ index: p.frames.length, name, url, thumb, full: blob, luma, w: img.naturalWidth, h: img.naturalHeight });
    if (onProgress && i % 4 === 0) onProgress(i + 1, items.length);
  }

  p.diffs = p.frames.map((f, i) => (i === 0 ? 0 : diffLuma(p.frames[i - 1].luma, f.luma)));

  p.frameKeys = p.frames.map((f) => shotKeyOf(f.name));
  if (!preserve || !p.resW) { p.resW = maxW || 1920; p.resH = maxH || 1080; }
  const named = p.frameKeys.filter(Boolean).length;
  const distinct = new Set(p.frameKeys.filter(Boolean)).size;
  p.hasNamePattern = named >= p.frames.length * 0.8 && distinct >= 1;
  if (!preserve) p.groupMode = p.hasNamePattern ? 'name' : 'cuts';
  else if (p.groupMode === 'name' && !p.hasNamePattern) p.groupMode = 'cuts';

  computeShots(p);
  return p;
}

// Insert a new board from a file at array position `atIndex` (0..frames.length).
// Renamed on filename collision with an existing board, since every other bit
// of state (durations, pins, annos, tasks...) is keyed by filename. Recomputes
// diffs for the new frame and its next neighbor so scene-cut detection stays
// accurate; does NOT call computeShots — caller re-runs that (and must remap
// any frame indices it's holding onto, e.g. current selection, since every
// index at or after atIndex shifts by one).
export async function insertFrame(p, atIndex, file) {
  let name = file.name;
  if (p.frames.some((f) => f.name === name)) {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    let n = 1;
    while (p.frames.some((f) => f.name === `${stem}_ins${n}${ext}`)) n++;
    name = `${stem}_ins${n}${ext}`;
  }
  const url = URL.createObjectURL(file);
  const img = await loadImage(url).catch(() => null);
  if (!img) { URL.revokeObjectURL(url); return null; }
  const thumb = makeThumb(img);
  const tctx = makeTinyCtx();
  const luma = computeLuma(tctx, img);
  const frame = { index: atIndex, name, url, thumb, full: file, luma, w: img.naturalWidth, h: img.naturalHeight };

  p.frames.splice(atIndex, 0, frame);
  p.frameKeys.splice(atIndex, 0, shotKeyOf(name));
  if (atIndex === 0) {
    p.diffs.splice(atIndex, 0, 0);
  } else {
    const prev = await ensureLuma(p.frames[atIndex - 1], tctx);
    p.diffs.splice(atIndex, 0, prev ? diffLuma(prev, luma) : 0);
  }
  if (atIndex + 1 < p.frames.length) {
    const next = await ensureLuma(p.frames[atIndex + 1], tctx);
    if (next) p.diffs[atIndex + 1] = diffLuma(luma, next);
  }
  return { name, atIndex };
}

// A flat-color placeholder board (e.g. so the user can annotate/draw on it by
// hand) at the project's spot resolution. Returns a Blob the same way a real
// upload would, so it can go through the exact same insertFrame() path.
export function solidColorBlob(w, h, color) {
  return new Promise((res) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, w, h);
    c.toBlob((b) => res(b), 'image/png');
  });
}

// Move one or more boards (by their CURRENT array positions) to sit just before
// `insertBeforeIndex` (an index into the array as it stands BEFORE removal),
// preserving their relative order. Recomputes frameKeys + diffs for the whole
// sequence afterward — reordering can change any number of neighbor pairs at
// once, so patching individual seams (as insertFrame does for its single new
// neighbor) isn't worth the bookkeeping; diff math itself is cheap.
export async function moveFrames(p, indices, insertBeforeIndex) {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const moving = sorted.map((i) => p.frames[i]);
  let adj = insertBeforeIndex;
  sorted.forEach((i) => { if (i < insertBeforeIndex) adj--; });
  for (let k = sorted.length - 1; k >= 0; k--) p.frames.splice(sorted[k], 1);
  adj = Math.max(0, Math.min(p.frames.length, adj));
  p.frames.splice(adj, 0, ...moving);

  p.frameKeys = p.frames.map((f) => shotKeyOf(f.name));
  const tctx = makeTinyCtx();
  const lumas = [];
  for (const f of p.frames) lumas.push(await ensureLuma(f, tctx));
  p.diffs = lumas.map((l, i) => (i === 0 || !l || !lumas[i - 1]) ? 0 : diffLuma(lumas[i - 1], l));
  return { newIndices: moving.map((f) => p.frames.indexOf(f)) };
}

export function loadImage(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = url;
  });
}

export function drawCover(ctx, img, w, h) {
  const r = Math.max(w / img.width, h / img.height);
  const dw = img.width * r, dh = img.height * r;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

// downsampled per-pixel luma, used for frame-to-frame diff (scene-cut detection)
export function computeLuma(tctx, img) {
  tctx.clearRect(0, 0, TINY_W, TINY_H);
  drawCover(tctx, img, TINY_W, TINY_H);
  const px = tctx.getImageData(0, 0, TINY_W, TINY_H).data;
  const luma = new Uint8ClampedArray(TINY_W * TINY_H);
  for (let s = 0, q = 0; s < px.length; s += 4, q++) luma[q] = (px[s] * 0.299 + px[s + 1] * 0.587 + px[s + 2] * 0.114) | 0;
  return luma;
}
export function diffLuma(a, b) {
  let sum = 0;
  for (let k = 0; k < a.length; k++) sum += Math.abs(a[k] - b[k]);
  return sum / a.length / 2.55;
}
export function makeTinyCtx() {
  const c = document.createElement('canvas'); c.width = TINY_W; c.height = TINY_H;
  return c.getContext('2d', { willReadFrequently: true });
}
export function makeThumb(img) {
  const thumb = document.createElement('canvas'); thumb.width = THUMB_W; thumb.height = THUMB_H;
  drawCover(thumb.getContext('2d'), img, THUMB_W, THUMB_H);
  return thumb;
}

// A frame's luma is only ever computed at ingest/replace time — a board opened
// from a work file has none (only its blob). Compute + cache it on demand so
// diff-recompute call sites (insert, replace) don't have to special-case this.
// Returns null (rather than throwing) if the frame's blob fails to decode.
export async function ensureLuma(frame, tctx) {
  if (frame.luma) return frame.luma;
  const url = URL.createObjectURL(frame.full);
  const img = await loadImage(url).catch(() => null);
  URL.revokeObjectURL(url);
  if (!img) return null;
  frame.luma = computeLuma(tctx, img);
  return frame.luma;
}
