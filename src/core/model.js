// Central project state + pure helpers shared by editor and viewer.

export const project = {
  frames: [],          // { index, name, url, thumb(canvas), full(Blob|null) }
  frameKeys: [],       // per-frame filename shot key (or null)
  diffs: [],           // frame-to-frame visual change 0..100
  hasNamePattern: false,
  groupMode: 'cuts',   // 'cuts' | 'name'
  threshold: 14,
  fps: 24,
  lenUnit: 'sec',      // 'sec' | 'frames'
  spotSeconds: 30,
  manualAdd: new Set(),   // filenames of forced shot starts
  manualRemove: new Set(),// filenames of removed boundaries
  meta: new Map(),        // startFilename -> { tag, note, len(seconds) }
  boardWeights: new Map(),// (legacy, unused) filename -> weight
  boardDur: new Map(),    // filename -> on-screen seconds (source of truth for timing)
  boardDisabled: new Set(),// filenames of disabled boards
  shotDisabled: new Set(),// shot ids (name key or start filename) that are cut
  pinned: new Set(),      // filenames whose duration is locked (walls for retime)
  annos: new Map(),       // filename -> array of annotation strokes (vector)
  fitMode: 'cover',       // global default: 'cover' | 'contain' | 'width' | 'height'
  boardFit: new Map(),    // filename -> fit override
  falloffReach: 3,        // base falloff reach in boards (global; Shift doubles it)
  falloffCurve: 'smooth', // 'linear' | 'easeIn' | 'easeOut' | 'smooth'
  lastRebalanceSpot: null,// spotSeconds value as of the last rebalance/load; drives rebalance's pin-override mode
  shotTasks: ['previs', 'anim', 'light', 'comp'], // global shot task columns
  assetTasks: ['model', 'lookdev', 'rig'],        // global asset task columns
  assetCats: ['character', 'set', 'prop'],        // asset categories
  assets: [],             // [{ id, name, cat, tasks:{}, thumb:dataURL|null, thumbFrom:filename|null }]
  baseName: 'sequence',   // derived from first file / zip name
  resW: 1920, resH: 1080, // spot resolution (largest source image by default)
  source: null,           // 'files' | 'zip' | 'workfile'
  audio: null,            // { name, blob, url, offsetSec, inSec, outSec, gain, fadeInFrames, fadeOutFrames } | null
  shots: [],              // computed: { start, end, count, name }
  cuts: new Set(),        // computed shot-start indices
};

export const IMG_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;

export function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// MCDS_10_001.png -> "MCDS_10"  (drop extension + trailing frame counter)
export function shotKeyOf(name) {
  const base = name.replace(/\.[^.]+$/, '');
  const nums = base.match(/\d+/g);
  if (!nums || nums.length < 2) return null;
  const last = nums[nums.length - 1];
  const idx = base.lastIndexOf(last);
  return base.slice(0, idx).replace(/[_\-.\s]+$/, '') || null;
}

// A friendly base name for exports: zip stem, or first image stem without the counter.
export function deriveBaseName(source, firstName, zipName) {
  if (source === 'zip' && zipName) return zipName.replace(/\.zip$/i, '') || 'sequence';
  if (!firstName) return 'sequence';
  const stem = firstName.replace(/\.[^.]+$/, '');
  const key = shotKeyOf(firstName);
  if (key) {
    // strip the shot number too so MCDS_10_001 -> MCDS
    const m = key.match(/^(.*?)[_\-.\s]*\d+$/);
    return (m && m[1]) || key;
  }
  return stem.replace(/[_\-.\s]*\d+$/, '') || stem || 'sequence';
}

export function pad2(n) { return String(n).padStart(2, '0'); }

export function fmtTC(frame, fps) {
  const f = ((frame % fps) + fps) % fps;
  const t = Math.floor(frame / fps);
  const s = t % 60, m = Math.floor(t / 60) % 60, h = Math.floor(t / 3600);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}:${pad2(f)}`;
}

export function fmtClock(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  const c = cs % 100, whole = Math.floor(cs / 100);
  const m = Math.floor(whole / 60), r = whole % 60;
  return `${m}:${pad2(r)}.${pad2(c)}`;
}

// ---- shot computation (filename grouping OR diff cuts, plus manual overrides) ----
function nameBoundaries(p) {
  const b = new Set([0]);
  for (let i = 1; i < p.frames.length; i++) if (p.frameKeys[i] !== p.frameKeys[i - 1]) b.add(i);
  return b;
}

export function computeShots(p = project) {
  const idx = new Map();
  p.frames.forEach((f, i) => idx.set(f.name, i));
  let starts;
  if (p.groupMode === 'name' && p.hasNamePattern) {
    starts = nameBoundaries(p);
  } else {
    starts = new Set([0]);
    for (let i = 1; i < p.diffs.length; i++) if (p.diffs[i] >= p.threshold) starts.add(i);
  }
  for (const fn of p.manualAdd) { const i = idx.get(fn); if (i > 0) starts.add(i); }
  for (const fn of p.manualRemove) { const i = idx.get(fn); if (i > 0) starts.delete(i); }
  starts.add(0);

  const ordered = [...starts].sort((a, b) => a - b);
  const shots = [];
  for (let i = 0; i < ordered.length; i++) {
    const start = ordered[i];
    const end = i + 1 < ordered.length ? ordered[i + 1] - 1 : p.frames.length - 1;
    shots.push({ start, end, count: end - start + 1, name: p.frameKeys[start] || '' });
  }
  p.cuts = starts;
  p.shots = shots;
  return shots;
}

export function shotId(p, sh) { return sh.name || p.frames[sh.start].name; }

// ---- manual shot boundaries (force a cut / merge into previous / reset to auto) ----
export function isShotStart(p, fi) { return p.shots.some((s) => s.start === fi); }
export function boundaryState(p, fi) {
  const n = p.frames[fi].name;
  if (p.manualAdd.has(n)) return 'forced';
  if (p.manualRemove.has(n)) return 'removed';
  return 'auto';
}
export function forceCut(p, fi) { if (fi <= 0) return; const n = p.frames[fi].name; p.manualRemove.delete(n); p.manualAdd.add(n); computeShots(p); }
export function mergeUp(p, fi) { if (fi <= 0) return; const n = p.frames[fi].name; p.manualAdd.delete(n); p.manualRemove.add(n); computeShots(p); }
export function resetBoundary(p, fi) { const n = p.frames[fi].name; p.manualAdd.delete(n); p.manualRemove.delete(n); computeShots(p); }

export function isShotDisabled(p, sh) { return p.shotDisabled.has(shotId(p, sh)); }
export function isBoardDisabled(p, fi) { return p.boardDisabled.has(p.frames[fi].name); }
export function isPinned(p, fi) { return p.pinned.has(p.frames[fi].name); }
export function getAnnos(p, fi) { return p.annos.get(p.frames[fi].name) || []; }
export function setAnnos(p, fi, strokes) { const n = p.frames[fi].name; if (strokes && strokes.length) p.annos.set(n, strokes); else p.annos.delete(n); }
export function hasAnnos(p, fi) { const a = p.annos.get(p.frames[fi].name); return !!(a && a.length); }
export function getBoardFit(p, fi) { return p.boardFit.get(p.frames[fi].name) || p.fitMode; }
export function setBoardFit(p, fi, mode) { const n = p.frames[fi].name; if (!mode || mode === 'default') p.boardFit.delete(n); else p.boardFit.set(n, mode); }
// draw params to place a source (iw×ih) into a W×H frame under a fit mode.
// cover/width/height may overflow the frame (cropped); contain letterboxes.
export function fitRect(mode, iw, ih, W, H) {
  if (!iw || !ih) return { dx: 0, dy: 0, dw: W, dh: H };
  let s;
  if (mode === 'contain') s = Math.min(W / iw, H / ih);
  else if (mode === 'width') s = W / iw;
  else if (mode === 'height') s = H / ih;
  else s = Math.max(W / iw, H / ih); // cover (default)
  const dw = iw * s, dh = ih * s;
  return { dx: (W - dw) / 2, dy: (H - dh) / 2, dw, dh };
}

export const MIN_DUR = () => 1 / 240; // absolute floor; practical min is ~1 frame

// per-board on-screen duration (source of truth). default = 1 frame.
export function boardDur(p, fi) {
  const d = p.boardDur.get(p.frames[fi].name);
  return d == null || d <= 0 ? 1 / p.fps : d;
}
export function setBoardDur(p, fi, sec) {
  p.boardDur.set(p.frames[fi].name, Math.max(1 / (p.fps * 4), sec));
}

export function enabledBoards(p, sh) {
  if (isShotDisabled(p, sh)) return [];
  const out = [];
  for (let f = sh.start; f <= sh.end; f++) if (!isBoardDisabled(p, f)) out.push(f);
  return out;
}
// flat ordered list of every enabled board index across all enabled shots
export function enabledFlat(p) {
  const out = [];
  p.shots.forEach((sh) => { if (!isShotDisabled(p, sh)) for (let f = sh.start; f <= sh.end; f++) if (!isBoardDisabled(p, f)) out.push(f); });
  return out;
}

export function lenToUnit(p, sec) {
  return p.lenUnit === 'frames' ? Math.round(sec * p.fps) : Math.round(sec * 100) / 100;
}
export function unitToSec(p, v) {
  return p.lenUnit === 'frames' ? v / p.fps : v;
}

// shot length = sum of its enabled boards' durations (derived)
export function shotLenSec(p, sh) {
  return enabledBoards(p, sh).reduce((s, fi) => s + boardDur(p, fi), 0);
}
// meta stays for tag/note/stageVals; len is no longer used for timing
export function shotMeta(p, sh) {
  return p.meta.get(p.frames[sh.start].name) || { tag: '', note: '', len: null };
}
export function setShotMeta(p, sh, key, val) {
  const fn = p.frames[sh.start].name;
  const m = p.meta.get(fn) || { tag: '', note: '', len: null };
  m[key] = val;
  p.meta.set(fn, m);
}

// scale a shot's enabled boards proportionally to a new total length
export function setShotLen(p, sh, sec) {
  const boards = enabledBoards(p, sh);
  if (!boards.length) return;
  const cur = shotLenSec(p, sh) || 1;
  const factor = Math.max(0.01, sec) / cur;
  boards.forEach((fi) => setBoardDur(p, fi, boardDur(p, fi) * factor));
}

export function totalSec(p) { return enabledFlat(p).reduce((s, fi) => s + boardDur(p, fi), 0); }

// Auto-estimate: give every UNPINNED enabled board an equal share of the
// remaining budget (spot − pinned time) so the total hits the spot exactly.
export function autoEstimate(p = project) {
  const flat = enabledFlat(p);
  if (!flat.length) return { filled: 0, total: 0, over: -p.spotSeconds };
  const pinnedTime = flat.filter((fi) => isPinned(p, fi)).reduce((s, fi) => s + boardDur(p, fi), 0);
  const free = flat.filter((fi) => !isPinned(p, fi));
  if (!free.length) return { filled: 0, total: totalSec(p), over: totalSec(p) - p.spotSeconds };
  const per = Math.max(1 / p.fps, (p.spotSeconds - pinnedTime) / free.length);
  free.forEach((fi) => setBoardDur(p, fi, per));
  const total = totalSec(p);
  return { filled: free.length, total, over: total - p.spotSeconds };
}

// Rebalance has two modes, chosen automatically:
// - target UNCHANGED since the last rebalance/load: pins stay hard-locked (today's
//   behavior) — only unpinned boards absorb the difference to hit the spot exactly.
// - target CHANGED (spotSeconds edited since last rebalance): scale the WHOLE edit,
//   pins included, by one uniform factor so every board's relative share of the
//   total is preserved while the edit stretches/shrinks to the new length.
export function rebalance(p = project) {
  const targetChanged = p.lastRebalanceSpot == null || Math.abs(p.lastRebalanceSpot - p.spotSeconds) > 1e-6;
  if (targetChanged) {
    const flat = enabledFlat(p);
    const cur = totalSec(p) || 1;
    const factor = Math.max(0, p.spotSeconds) / cur;
    flat.forEach((fi) => setBoardDur(p, fi, boardDur(p, fi) * factor));
  } else {
    const flat = enabledFlat(p);
    const pinnedTime = flat.filter((fi) => isPinned(p, fi)).reduce((s, fi) => s + boardDur(p, fi), 0);
    const free = flat.filter((fi) => !isPinned(p, fi));
    const freeTotal = free.reduce((s, fi) => s + boardDur(p, fi), 0) || 1;
    const target = Math.max(0, p.spotSeconds - pinnedTime);
    const factor = target / freeTotal;
    free.forEach((fi) => setBoardDur(p, fi, boardDur(p, fi) * factor));
  }
  p.lastRebalanceSpot = p.spotSeconds;
  return { total: totalSec(p), over: totalSec(p) - p.spotSeconds, mode: targetChanged ? 'whole' : 'pinned' };
}

// Mark the current spot as "settled" so the next rebalance defaults to the
// pin-respecting mode (call after load / auto-estimate, before any user edits).
export function markRebalanceSettled(p = project) { p.lastRebalanceSpot = p.spotSeconds; }

// pin-bounded region [lo,hi] (flat indices) around a set of positions
function regionAround(p, flat, positions) {
  let lo = Math.min(...positions), hi = Math.max(...positions);
  while (lo - 1 >= 0 && !isPinned(p, flat[lo - 1])) lo--;
  while (hi + 1 < flat.length && !isPinned(p, flat[hi + 1])) hi++;
  const leftPin = lo > 0 && isPinned(p, flat[lo - 1]);
  const rightPin = hi < flat.length - 1 && isPinned(p, flat[hi + 1]);
  return { lo, hi, leftPin, rightPin };
}

// Smoothstep ease-in/ease-out: 0 at t=0, 1 at t=1, zero slope at both ends —
// the same S-curve as falloffWeight's 'smooth' case below, reused here for
// audio fade in/out so the gain ramp doesn't have the abrupt slope change a
// plain linear ramp has right at the fade boundary (audible as a faint click
// / "starts moving too fast" feel, especially on fade-in).
export function easeInOut(t) {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
}

// normalized falloff weight for distance ratio t in [0,∞), by curve
export function falloffWeight(t, curve = 'smooth') {
  if (t >= 1) return 0;
  const x = 1 - t; // 1 at center → 0 at reach
  switch (curve) {
    case 'linear': return x;
    case 'easeIn': return x * x;            // tight: concentrates near the drag
    case 'easeOut': return 1 - t * t;        // wide: spreads far before dropping
    case 'smooth': default: return x * x * (3 - 2 * x); // smoothstep S-curve
  }
}

// Remove `amount` (if >0) or add `-amount` (if <0) across `targets`, weighted by
// distance from the span [spanLo,spanHi] (0 inside the span, growing outside) with
// the active easing curve. Returns unabsorbed leftover.
function redistribute(p, targets, amount, spanLo, spanHi, flat, reach, curve = p.falloffCurve) {
  let remaining = amount;
  const minD = 1 / p.fps;
  const distOf = (pos) => (pos < spanLo ? spanLo - pos : pos > spanHi ? pos - spanHi : 0);
  for (let pass = 0; pass < 6 && Math.abs(remaining) > 1e-6; pass++) {
    const pool = targets.filter((b) => (remaining > 0 ? boardDur(p, b) > minD + 1e-9 : true));
    if (!pool.length) break;
    const weights = pool.map((b) => Math.max(0.0001, falloffWeight(distOf(flat.indexOf(b)) / (reach + 1), curve)));
    const wSum = weights.reduce((a, b) => a + b, 0) || 1;
    let done = 0;
    pool.forEach((b, i) => {
      const share = remaining * (weights[i] / wSum);
      const cur = boardDur(p, b);
      let next = cur - share;
      if (next < minD) next = minD;
      done += cur - next;
      setBoardDur(p, b, next);
    });
    remaining -= done;
  }
  return remaining;
}

function slackOf(p, boards) { const minD = 1 / p.fps; return boards.reduce((s, b) => s + Math.max(0, boardDur(p, b) - minD), 0); }

// Vertical retime: set board `fi` to newDur; neighbors flex with falloff, bounded
// by pins. Between two pins the change is capped to the region's slack (no drift).
export function retimeBoard(p, fi, newDur, reach = p.falloffReach) {
  const flat = enabledFlat(p);
  const pos = flat.indexOf(fi);
  if (pos < 0) return 0;
  newDur = Math.max(1 / (p.fps * 4), newDur);
  let delta = newDur - boardDur(p, fi);
  if (Math.abs(delta) < 1e-6) return 0;
  const { lo, hi, leftPin, rightPin } = regionAround(p, flat, [pos]);
  const others = [];
  for (let i = lo; i <= hi; i++) if (i !== pos) others.push(flat[i]);
  if (!others.length) { setBoardDur(p, fi, newDur); return delta; }
  if (delta > 0 && leftPin && rightPin) {           // fully pin-bounded → cap, no ripple
    const slack = slackOf(p, others);
    if (delta > slack) { delta = slack; newDur = boardDur(p, fi) + delta; }
  }
  setBoardDur(p, fi, newDur);
  redistribute(p, others, delta, pos, pos, flat, reach);
  return delta;
}

// Scale a whole selection's durations by `factor`; neighbors absorb the net change
// with falloff from the selection edges. Pinned boards are never modified, and when
// the region is pin-bounded the growth is capped to available slack (no drift), so
// pinned boards keep their position.
export function retimeGroup(p, fiList, factor, reach = p.falloffReach) {
  const flat = enabledFlat(p);
  const positions = fiList.map((fi) => flat.indexOf(fi)).filter((i) => i >= 0);
  if (!positions.length) return;
  const { lo, hi, leftPin, rightPin } = regionAround(p, flat, positions);
  const sel = new Set(fiList);
  const others = [];
  for (let i = lo; i <= hi; i++) if (!sel.has(flat[i]) && !isPinned(p, flat[i])) others.push(flat[i]);
  const minD = 1 / (p.fps * 4);
  const olds = fiList.map((fi) => boardDur(p, fi));
  const targets = olds.map((d) => Math.max(minD, d * factor));
  let net = targets.reduce((s, t, i) => s + (t - olds[i]), 0);
  if (net > 0 && (leftPin || rightPin)) {         // pin-bounded → cap, no drift
    const slack = slackOf(p, others);
    if (net > slack) { const scale = slack / net; fiList.forEach((fi, i) => setBoardDur(p, fi, olds[i] + (targets[i] - olds[i]) * scale)); net = slack; }
    else fiList.forEach((fi, i) => setBoardDur(p, fi, targets[i]));
  } else fiList.forEach((fi, i) => setBoardDur(p, fi, targets[i]));
  const minP = Math.min(...positions), maxP = Math.max(...positions);
  if (others.length) redistribute(p, others, net, minP, maxP, flat, reach);
  return net;
}

// Horizontal mushy-offset: slide board `fi` later (d>0) or earlier (d<0) by
// borrowing time ahead and donating behind, with falloff, bounded by pins.
// Board's own duration is unchanged; total stays constant.
export function offsetBoard(p, fi, d, reach = p.falloffReach) {
  const flat = enabledFlat(p);
  const pos = flat.indexOf(fi);
  if (pos < 0 || Math.abs(d) < 1e-6) return 0;
  const { lo, hi } = regionAround(p, flat, [pos]);
  const before = [], after = [];
  for (let i = lo; i <= hi; i++) { if (i < pos) before.push(flat[i]); else if (i > pos) after.push(flat[i]); }
  if (d > 0) { const s = slackOf(p, after); if (d > s) d = s; if (!before.length) d = 0; }
  else { const s = slackOf(p, before); if (-d > s) d = -s; if (!after.length) d = 0; }
  if (Math.abs(d) < 1e-6) return 0;
  // move right by d: compress `after` by d, expand `before` by d
  redistribute(p, after, d, pos, pos, flat, reach);
  redistribute(p, before, -d, pos, pos, flat, reach);
  return d;
}

// Slide a whole selection as a block horizontally: borrow from ahead of the
// block, donate behind, with falloff, bounded by pins. Selection durations hold.
export function offsetGroup(p, fiList, d, reach = p.falloffReach) {
  const flat = enabledFlat(p);
  const positions = fiList.map((fi) => flat.indexOf(fi)).filter((i) => i >= 0);
  if (!positions.length || Math.abs(d) < 1e-6) return 0;
  const minP = Math.min(...positions), maxP = Math.max(...positions);
  const { lo, hi } = regionAround(p, flat, positions);
  const sel = new Set(fiList);
  const before = [], after = [];
  for (let i = lo; i <= hi; i++) { if (sel.has(flat[i]) || isPinned(p, flat[i])) continue; if (i < minP) before.push(flat[i]); else if (i > maxP) after.push(flat[i]); }
  if (d > 0) { const s = slackOf(p, after); if (d > s) d = s; if (!before.length) d = 0; }
  else { const s = slackOf(p, before); if (-d > s) d = -s; if (!after.length) d = 0; }
  if (Math.abs(d) < 1e-6) return 0;
  redistribute(p, after, d, minP, maxP, flat, reach);
  redistribute(p, before, -d, minP, maxP, flat, reach);
  return d;
}

// Full timeline: per-board placements, shot spans, collapse markers.
export function timeline(p = project) {
  const boards = [];
  const spans = [];
  const markers = [];
  let t = 0, colorIdx = 0;
  p.shots.forEach((sh, si) => {
    if (isShotDisabled(p, sh)) { markers.push({ atSec: t, kind: 'shot', label: shotId(p, sh) }); return; }
    const enabled = enabledBoards(p, sh);
    if (!enabled.length) { markers.push({ atSec: t, kind: 'shot', label: shotId(p, sh) }); return; }
    const spanStart = t;
    for (let fi = sh.start; fi <= sh.end; fi++) {
      if (isBoardDisabled(p, fi)) { markers.push({ atSec: t, kind: 'board', label: p.frames[fi].name }); continue; }
      const len = boardDur(p, fi);
      boards.push({ fi, startSec: t, len, shotIndex: si, pinned: isPinned(p, fi) });
      t += len;
    }
    spans.push({ shotIndex: si, name: sh.name || `S${si + 1}`, startSec: spanStart, len: t - spanStart, colorIdx: colorIdx % 2 });
    colorIdx++;
  });
  return { boards, spans, markers, total: t };
}

export function resolveAt(p, sec) {
  const { boards, total } = timeline(p);
  if (!boards.length) return null;
  let b = boards[0];
  for (let i = 0; i < boards.length; i++) { if (boards[i].startSec <= sec + 1e-6) b = boards[i]; else break; }
  return { frame: b.fi, shotIndex: b.shotIndex, startSec: b.startSec, len: b.len, total };
}

// ---- tasks (two global lists: shot + asset) ----
function addTask(list, name) { const t = String(name || '').trim().toLowerCase(); if (t && !list.includes(t)) list.push(t); return t; }
export function addShotTask(p, name) { return addTask(p.shotTasks, name); }
export function removeShotTask(p, name) { p.shotTasks = p.shotTasks.filter((t) => t !== name); }
export function addAssetTask(p, name) { return addTask(p.assetTasks, name); }
export function removeAssetTask(p, name) { p.assetTasks = p.assetTasks.filter((t) => t !== name); p.assets.forEach((a) => { if (a.tasks) delete a.tasks[name]; }); }

// ---- assets ----
let assetSeq = 1;
export function addAssetCat(p, name) { const c = String(name || '').trim(); if (c && !p.assetCats.includes(c)) p.assetCats.push(c); return c; }
export function removeAssetCat(p, name) { p.assetCats = p.assetCats.filter((c) => c !== name); p.assets = p.assets.filter((a) => a.cat !== name); }
export function addAsset(p, cat, name = 'new asset') {
  const id = 'a' + (assetSeq++) + '_' + Date.now().toString(36);
  p.assets.push({ id, name, cat, tasks: {}, thumb: null, thumbFrom: null });
  return id;
}
export function removeAsset(p, id) { p.assets = p.assets.filter((a) => a.id !== id); }
export function getAsset(p, id) { return p.assets.find((a) => a.id === id); }
export function setAssetField(p, id, key, val) { const a = getAsset(p, id); if (a) a[key] = val; }
export function setAssetTaskVal(p, id, task, val) { const a = getAsset(p, id); if (a) { a.tasks = a.tasks || {}; if (val === '' || val == null) delete a.tasks[task]; else a.tasks[task] = val; } }
export function assetsByCat(p, cat) { return p.assets.filter((a) => a.cat === cat); }


// Reorders p.frames/frameKeys/diffs to match a saved filename order (used by
// undo/redo for insert/move — never re-derives images, only rearranges the
// frame objects that are already in memory; a filename that no longer exists
// — the OTHER side of the same undo step deleted it — is simply skipped, and
// any current frame missing from `order` is left in place at the end so a
// mismatched snapshot fails soft instead of dropping boards).
function applyFrameOrder(p, order) {
  if (!order) return;
  const byName = new Map(p.frames.map((f) => [f.name, f]));
  const reordered = order.map((n) => byName.get(n)).filter(Boolean);
  const placed = new Set(reordered.map((f) => f.name));
  p.frames.forEach((f) => { if (!placed.has(f.name)) reordered.push(f); });
  p.frames = reordered;
  p.frameKeys = p.frames.map((f) => shotKeyOf(f.name));
  // Recompute diffs synchronously from whatever luma is already cached (true
  // for any project loaded from images/zip — luma is computed at ingest).
  // applyState() must stay synchronous for undo/redo, so a frame with no
  // cached luma (only possible for a work-file-loaded project that's never
  // had insert/replace touch it) falls back to 0 rather than blocking on a
  // decode — 'cuts' grouping for that pair is stale until the next detect.
  p.diffs = p.frames.map((f, i) => (i === 0 || !f.luma || !p.frames[i - 1].luma) ? 0 : diffLumaSync(p.frames[i - 1].luma, f.luma));
}
function diffLumaSync(a, b) {
  let sum = 0;
  for (let k = 0; k < a.length; k++) sum += Math.abs(a[k] - b[k]);
  return sum / a.length / 2.55;
}

export function captureState(p = project) {
  return JSON.stringify({
    groupMode: p.groupMode, threshold: p.threshold, fps: p.fps,
    lenUnit: p.lenUnit, spotSeconds: p.spotSeconds,
    shotTasks: p.shotTasks, assetTasks: p.assetTasks, assetCats: p.assetCats,
    assets: p.assets.map((a) => ({ ...a, thumb: null })), // thumbs restored by id on apply
    frameOrder: p.frames.map((f) => f.name),
    manualAdd: [...p.manualAdd], manualRemove: [...p.manualRemove],
    meta: [...p.meta.entries()],
    boardDur: [...p.boardDur.entries()],
    boardDisabled: [...p.boardDisabled], shotDisabled: [...p.shotDisabled],
    pinned: [...p.pinned], annos: [...p.annos.entries()],
    fitMode: p.fitMode, boardFit: [...p.boardFit.entries()],
    audio: p.audio ? {
      offsetSec: p.audio.offsetSec, inSec: p.audio.inSec, outSec: p.audio.outSec,
      gain: p.audio.gain, fadeInFrames: p.audio.fadeInFrames, fadeOutFrames: p.audio.fadeOutFrames,
    } : null,
    lastRebalanceSpot: p.lastRebalanceSpot,
  });
}
export function applyState(p, snap) {
  const s = JSON.parse(snap);
  p.groupMode = s.groupMode; p.threshold = s.threshold; p.fps = s.fps;
  p.lenUnit = s.lenUnit; p.spotSeconds = s.spotSeconds;
  p.shotTasks = s.shotTasks || p.shotTasks; p.assetTasks = s.assetTasks || p.assetTasks; p.assetCats = s.assetCats || p.assetCats;
  if (s.assets) { const thumbs = new Map(p.assets.map((a) => [a.id, a.thumb])); p.assets = s.assets.map((a) => ({ ...a, thumb: a.thumb || thumbs.get(a.id) || null })); }
  applyFrameOrder(p, s.frameOrder);
  p.manualAdd = new Set(s.manualAdd); p.manualRemove = new Set(s.manualRemove);
  p.meta = new Map(s.meta);
  p.boardDur = new Map(s.boardDur || []);
  p.boardDisabled = new Set(s.boardDisabled || []);
  p.shotDisabled = new Set(s.shotDisabled || []);
  p.pinned = new Set(s.pinned || []);
  p.annos = new Map(s.annos || []);
  p.fitMode = s.fitMode || p.fitMode; p.boardFit = new Map(s.boardFit || []);
  if (p.audio && s.audio) {
    p.audio.offsetSec = s.audio.offsetSec; p.audio.inSec = s.audio.inSec; p.audio.outSec = s.audio.outSec;
    p.audio.gain = s.audio.gain; p.audio.fadeInFrames = s.audio.fadeInFrames; p.audio.fadeOutFrames = s.audio.fadeOutFrames;
  }
  p.lastRebalanceSpot = s.lastRebalanceSpot ?? p.spotSeconds;
  computeShots(p);
}
