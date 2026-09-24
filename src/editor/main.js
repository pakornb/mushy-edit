import '../style.css';
import {
  project as P, computeShots, timeline, resolveAt, autoEstimate, rebalance,
  retimeBoard, retimeGroup, offsetBoard, offsetGroup, boardDur, setBoardDur, enabledFlat, falloffWeight,
  getAnnos, setAnnos, hasAnnos, getBoardFit, setBoardFit, fitRect,
  isShotStart, forceCut, mergeUp, fmtClock,
} from '../core/model.js';
import { createAnnotator, annotatorToolbar } from '../core/annotate.js';
import { loadFromFiles, loadFromZip, insertFrame, solidColorBlob, moveFrames } from '../core/frames.js';
import { saveWorkFile, openWorkFile } from '../io/workfile.js';
import { loadAudioFile, drawWaveform } from '../io/audio.js';
import { renderInspector } from './inspector.js';
import { Transport } from './transport.js';
import { mutate, undo, redo, clearHistory, canUndo, canRedo, beginGesture, commitGesture, cancelGesture } from '../core/history.js';
import { APPS_SCRIPT } from '../io/appsScript.js';
import { openAssetWindow, openPreview, exportBreakdownJSON, setRefresh, closeModal } from './assets.js';
import { exportMp4 } from '../io/mp4.js';
import { exportViewer } from '../io/viewer.js';
import { exportEdlZip } from '../io/edl.js';

const $ = (id) => document.getElementById(id);
let cur = 0, lastShot = -1, pps = null;
const BOARD_H = 60, RULER_H = 24, SEC_PER_PX = 0.012;
const transport = new Transport(P);
const slotEls = new Map();
let selected = new Set();
let selAnchor = null;
let resAspect = 16 / 9;
let lastCurX = null;
let annoMode = false, annoCtrl = null, lastAnnoFrame = -1;
let insertMode = false, insertPending = null;

function toggleAnnotate() {
  annoMode = !annoMode;
  $('annotateBtn').classList.toggle('on', annoMode);
  if (annoMode) { transport.pause(); enterAnnotate(); } else exitAnnotate();
}
function enterAnnotate() {
  exitAnnotate();
  const cvEl = $('previewCanvas'); if (!cvEl || !cvEl.width) return;
  if (!imgCache.get(cur)) { drawPreview(cur).then(() => { if (annoMode) enterAnnotate(); }); return; }
  annoCtrl = createAnnotator($('previewStage'), cvEl, getAnnos(P, cur), (strokes) => {
    mutate(() => setAnnos(P, cur, strokes));
    const el = slotEls.get(cur); if (el) el.classList.toggle('has-anno', strokes.length > 0);
    refreshUndoButtons();
  }, { getImageRect: (cw, ch) => { const im = imgCache.get(cur); if (!im) return { x: 0, y: 0, w: cw, h: ch }; const r = fitRect(getBoardFit(P, cur), im.naturalWidth, im.naturalHeight, cw, ch); return { x: r.dx, y: r.dy, w: r.dw, h: r.dh }; } });
  const bar = annotatorToolbar(annoCtrl); bar.id = 'annoBarInner';
  $('annoBar').innerHTML = ''; $('annoBar').appendChild(bar); $('annoBar').classList.remove('hidden');
}
function exitAnnotate() { if (annoCtrl) { annoCtrl.destroy(); annoCtrl = null; } $('annoBar').classList.add('hidden'); $('annoBar').innerHTML = ''; }
function refreshAnno() { if (annoMode) enterAnnotate(); }

function isolationBadge() {
  const el = $('iso'); const ok = self.crossOriginIsolated === true;
  el.textContent = ok ? 'isolated ✓' : 'not isolated';
  el.title = ok ? 'mp4 export will work' : 'mp4 export needs the hosted app';
  el.className = 'iso ' + (ok ? 'ok' : 'warn');
}

// ---------- loading ----------
async function loadImages(files) {
  const arr = [...files]; const zip = arr.find((f) => /\.zip$/i.test(f.name));
  try { overlay('Loading images…'); if (zip) await loadFromZip(zip); else await loadFromFiles(arr); afterLoad(true); }
  catch (e) { console.error(e); toast(e.message || 'Load failed'); } finally { overlay(false); }
}

// ---------- split a storyboard sheet (embeds Frame Splitter in a modal) ----------
let splitFrameReady = false;
let splitPendingFiles = null;

function openSplitModal(files) {
  splitFrameReady = false;
  splitPendingFiles = files;
  const iframe = $('splitFrame');
  iframe.src = '/frame-splitter.html?embedded=1';
  $('splitModalOverlay').classList.remove('hidden');
}
function closeSplitModal() {
  $('splitModalOverlay').classList.add('hidden');
  $('splitFrame').src = 'about:blank';
  splitFrameReady = false;
  splitPendingFiles = null;
}
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;
  if (!e.data || typeof e.data.type !== 'string') return;

  if (e.data.type === 'frameSplitterReady') {
    splitFrameReady = true;
    if (splitPendingFiles) {
      $('splitFrame').contentWindow.postMessage({ type: 'frameSplitterInit', files: splitPendingFiles }, location.origin);
      splitPendingFiles = null;
    }
  } else if (e.data.type === 'frameSplitterExport') {
    const items = (e.data.files || []).map((f) => new File([f.blob], f.name, { type: f.blob.type || 'image/png' }));
    closeSplitModal();
    if (items.length) loadImages(items);
    else toast('No frames came back from Frame Splitter');
  }
});

async function openWork(file) {
  try { overlay('Opening work file…'); await openWorkFile(file, (d, t) => overlay(`Opening… ${d}/${t}`)); afterLoad(false); }
  catch (e) { console.error(e); toast(e.message || 'Could not open work file'); } finally { overlay(false); }
}
function afterLoad(auto) {
  clearHistory(); pps = null; selected.clear(); imgCache.clear(); previewFi = -1;
  if (auto && P.boardDur.size === 0) autoEstimate(P); // seed a rough fit-to-spot at start
  onLoaded();
}
async function saveWork() {
  if (!P.frames.length) return;
  try { overlay('Saving work file…'); await saveWorkFile((d, t) => overlay(`Saving… ${d}/${t}`)); toast('Work file saved'); }
  catch (e) { console.error(e); toast('Save failed'); } finally { overlay(false); }
}

function onLoaded() {
  cur = Math.min(cur, P.frames.length - 1);
  $('loadView').classList.add('hidden');
  $('stage').classList.remove('hidden');
  $('baseName').textContent = P.baseName;
  $('fps').value = P.fps; $('spot').value = P.spotSeconds; $('lenUnit').value = P.lenUnit;
  $('resW').value = P.resW; $('resH').value = P.resH; resAspect = P.resW / P.resH;
  $('resPreset').value = '';
  $('fitMode').value = P.fitMode;
  $('falloff').value = P.falloffReach;
  $('falloffVal') && ($('falloffVal').textContent = P.falloffReach);
  $('falloffCurve').value = P.falloffCurve;
  drawCurvePreview();
  const gm = $('groupMode'); gm.value = P.groupMode;
  gm.options[1].disabled = !P.hasNamePattern;
  gm.options[1].textContent = P.hasNamePattern ? 'filename' : 'filename (none)';
  $('saveBtn').disabled = false;
  $('assetsBtn').disabled = false;
  $('exportBtn').disabled = false;
  transport.mountAudio(); syncAudioUI(); render(); layoutPreview();
}

const imgCache = new Map();
function getImg(fi) { return new Promise((res) => { if (imgCache.has(fi)) return res(imgCache.get(fi)); const im = new Image(); im.onload = () => { imgCache.set(fi, im); res(im); }; im.onerror = () => res(null); im.src = P.frames[fi].url; }); }
let previewFi = -1;
function layoutPreviewSize() {
  const cv = $('previewCanvas'); if (!cv) return; const box = $('previewWrap');
  const bw = box.clientWidth, bh = box.clientHeight; if (!bw || !bh) return;
  let w = bw, h = bw / resAspect; if (h > bh) { h = bh; w = bh * resAspect; }
  w = Math.round(w * 0.96); h = Math.round(h * 0.96);
  cv.width = w; cv.height = h; cv.style.width = w + 'px'; cv.style.height = h + 'px';
}
async function drawPreview(fi) {
  previewFi = fi; const cv = $('previewCanvas'); if (!cv) return; if (!cv.width) layoutPreviewSize();
  const im = await getImg(fi); if (previewFi !== fi) return;
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
  if (im) { const r = fitRect(getBoardFit(P, fi), im.naturalWidth, im.naturalHeight, cv.width, cv.height); ctx.drawImage(im, r.dx, r.dy, r.dw, r.dh); }
}
function layoutPreview() { layoutPreviewSize(); if (previewFi >= 0) drawPreview(previewFi); refreshAnno(); }

// ---------- render ----------
function render() {
  computeShots(P);
  buildTimeline();
  updateInspector();
  updateBudget();
  updatePlayhead(transport.sec);
  refreshUndoButtons();
}
function light() { drawRuler(); positionSlots(); updateBudget(); updatePlayhead(transport.sec); }
function toggleCut() { mutate(() => { if (isShotStart(P, cur)) mergeUp(P, cur); else forceCut(P, cur); }); render(); }
function updateInspector() {
  renderInspector($('inspector'), cur, {
    onChange: light, onStructural: render,
    onGoFrame: (i) => { selectSingle(i); },
    refreshPreview: () => { if (previewFi >= 0) drawPreview(previewFi); refreshAnno(); },
  });
}
function refreshUndoButtons() { $('undoBtn').disabled = !canUndo(); $('redoBtn').disabled = !canRedo(); }
function boardStartSec(fi) { const b = timeline(P).boards.find((x) => x.fi === fi); return b ? b.startSec : 0; }

function updateBudget() {
  const total = timeline(P).total, over = total - P.spotSeconds, b = $('budget');
  const sign = over > 0.05 ? `+${over.toFixed(2)}s over` : over < -0.05 ? `${Math.abs(over).toFixed(2)}s under` : 'on target';
  b.textContent = `${fmtClock(total)} / ${P.spotSeconds}s · ${sign}`;
  b.className = 'budget ' + (Math.abs(over) <= 0.05 ? 'ok' : over > 0 ? 'over' : 'under');
  $('scrub') && ($('scrub').max = String(Math.max(total, P.spotSeconds)));
}

// ---------- build timeline ----------
function fitPps() { const w = $('timeline').clientWidth - 4 || 800; const st = Math.max(timeline(P).total, P.spotSeconds) || 1; return w / st; }
function innerScaleTotal() { return Math.max(timeline(P).total, P.spotSeconds); }

function buildTimeline() {
  if (pps == null) pps = fitPps();
  const inner = $('tlInner');
  inner.querySelectorAll('.slot, .mk').forEach((n) => n.remove());
  slotEls.clear();
  const ph = $('playhead');
  const { boards, spans, markers } = timeline(P);
  inner.style.width = innerScaleTotal() * pps + 'px';

  const colorOf = new Map(), firstOf = new Map();
  spans.forEach((sp) => { colorOf.set(sp.shotIndex, sp.colorIdx); firstOf.set(sp.shotIndex, sp.name); });
  const seen = new Set(); const boardW = Math.round((BOARD_H * 16) / 9);

  boards.forEach((bd) => {
    const slot = document.createElement('div');
    slot.className = 'slot c' + (colorOf.get(bd.shotIndex) || 0) + (bd.pinned ? ' pinned' : '') + (selected.has(bd.fi) ? ' selected' : '');
    slot.style.left = bd.startSec * pps + 'px';
    slot.style.width = Math.max(2, bd.len * pps) + 'px';
    slot.dataset.fi = bd.fi;
    const stripe = document.createElement('div'); stripe.className = 'stripe';
    if (!seen.has(bd.shotIndex)) { seen.add(bd.shotIndex); const nm = document.createElement('span'); nm.textContent = firstOf.get(bd.shotIndex); stripe.appendChild(nm); }
    stripe.addEventListener('pointerdown', (e) => e.stopPropagation()); // stripe never retimes
    slot.appendChild(stripe);
    const c = document.createElement('canvas'); c.width = boardW; c.height = BOARD_H; c.className = 'bimg';
    c.getContext('2d').drawImage(P.frames[bd.fi].thumb, 0, 0, boardW, BOARD_H);
    slot.appendChild(c);
    if (bd.pinned) { const pb = document.createElement('span'); pb.className = 'pinbadge'; pb.textContent = '📌'; slot.appendChild(pb); }
    if (hasAnnos(P, bd.fi)) slot.classList.add('has-anno');
    const gapL = document.createElement('div'); gapL.className = 'insert-gap left'; gapL.textContent = '+';
    gapL.addEventListener('pointerdown', (e) => e.stopPropagation());
    gapL.addEventListener('click', (e) => { e.stopPropagation(); if (insertMode) openInsertPopover(bd.fi, e.clientX, e.clientY); });
    slot.appendChild(gapL);
    const gapR = document.createElement('div'); gapR.className = 'insert-gap right'; gapR.textContent = '+';
    gapR.addEventListener('pointerdown', (e) => e.stopPropagation());
    gapR.addEventListener('click', (e) => { e.stopPropagation(); if (insertMode) openInsertPopover(bd.fi + 1, e.clientX, e.clientY); });
    slot.appendChild(gapR);
    attachTile(slot, c, bd.fi);
    inner.insertBefore(slot, ph);
    slotEls.set(bd.fi, slot);
  });

  markers.forEach((mk) => {
    const d = document.createElement('div'); d.className = 'mk ' + mk.kind;
    d.style.left = mk.atSec * pps + 'px';
    d.title = `disabled ${mk.kind}: ${mk.label} — click to re-enable`;
    d.addEventListener('click', (e) => { e.stopPropagation(); mutate(() => { if (mk.kind === 'shot') P.shotDisabled.delete(mk.label); else P.boardDisabled.delete(mk.label); }); render(); });
    inner.insertBefore(d, ph);
  });
  drawRuler();
  layoutAudioClip();
}
function positionSlots() {
  const { boards } = timeline(P);
  $('tlInner').style.width = innerScaleTotal() * pps + 'px';
  boards.forEach((bd) => { const el = slotEls.get(bd.fi); if (el) { el.style.left = bd.startSec * pps + 'px'; el.style.width = Math.max(2, bd.len * pps) + 'px'; } });
}

function drawRuler() {
  const cv = $('tlRuler');
  const w = innerScaleTotal() * pps;
  cv.width = w; cv.height = RULER_H; cv.style.width = w + 'px';
  const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, w, RULER_H);
  const total = timeline(P).total, spotX = P.spotSeconds * pps, totalX = total * pps;
  // overflow shading beyond the spot
  if (total > P.spotSeconds) { ctx.fillStyle = 'rgba(255,80,80,.10)'; ctx.fillRect(spotX, 0, totalX - spotX, RULER_H); }
  // threshold dashed line
  ctx.strokeStyle = 'rgba(138,146,158,.4)'; ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(0, RULER_H * 0.55); ctx.lineTo(w, RULER_H * 0.55); ctx.stroke(); ctx.setLineDash([]);
  // per-board diff bars
  timeline(P).boards.forEach((bd) => {
    const d = P.diffs[bd.fi] || 0;
    const bh = Math.min(RULER_H - 4, (d / 60) * (RULER_H - 4));
    const x = bd.startSec * pps, bw = Math.max(1, bd.len * pps);
    ctx.fillStyle = d >= P.threshold ? 'rgba(255,138,61,.8)' : 'rgba(90,100,114,.7)';
    ctx.fillRect(x, RULER_H - 4 - bh, bw, bh);
  });
  // spot bar (bottom): green 0→spot, red spot→total
  ctx.fillStyle = 'rgba(108,192,112,.9)'; ctx.fillRect(0, RULER_H - 3, Math.min(spotX, totalX), 3);
  if (totalX > spotX) { ctx.fillStyle = 'rgba(255,90,90,.9)'; ctx.fillRect(spotX, RULER_H - 3, totalX - spotX, 3); }
  // start + spot-end ticks
  ctx.fillStyle = 'rgba(108,192,112,1)'; ctx.fillRect(0, 0, 2, RULER_H);
  ctx.fillStyle = 'rgba(255,138,61,.9)'; ctx.fillRect(spotX - 1, 0, 2, RULER_H);
}

// ---------- selection ----------
function selectSingle(fi) { selected = new Set([fi]); selAnchor = fi; cur = fi; transport.seek(boardStartSec(fi)); render(); }
function toggleSel(fi) { if (selected.has(fi)) selected.delete(fi); else selected.add(fi); selAnchor = fi; cur = fi; render(); }
function selectExtend(dir) {
  const flat = enabledFlat(P); let i = flat.indexOf(cur); if (i < 0) i = 0;
  if (selAnchor == null) selAnchor = cur;
  const ni = Math.max(0, Math.min(flat.length - 1, i + dir));
  cur = flat[ni];
  const a = flat.indexOf(selAnchor), b = ni, lo = Math.min(a, b), hi = Math.max(a, b);
  selected = new Set(); for (let j = lo; j <= hi; j++) selected.add(flat[j]);
  transport.seek(boardStartSec(cur)); render();
}
function toggleHide(fi) { mutate(() => { const n = P.frames[fi].name; if (P.boardDisabled.has(n)) P.boardDisabled.delete(n); else P.boardDisabled.add(n); }); render(); }
function togglePin(fi) { mutate(() => { const n = P.frames[fi].name; if (P.pinned.has(n)) P.pinned.delete(n); else P.pinned.add(n); }); render(); }

// ---------- move / reorder boards ----------
// `insertBeforeIndex` is a RAW p.frames array position (not a timeline/enabled-
// flat position) — moveFrames() itself resolves that against wherever the
// moving boards currently sit.
function commitMove(idxs, insertBeforeIndex) {
  beginGesture();
  moveFrames(P, idxs, insertBeforeIndex).then((r) => {
    if (!r) { cancelGesture(); return; }
    selected = new Set(r.newIndices);
    cur = r.newIndices[r.newIndices.length - 1] ?? cur;
    selAnchor = cur;
    computeShots(P);
    commitGesture(); refreshUndoButtons(); render();
    toast(`Moved ${idxs.length > 1 ? idxs.length + ' boards' : 'board'}`);
  });
}
// Keyboard reorder: move the current board (or the whole selection, treated as
// one block) one slot earlier/later among RAW array positions — i.e. it can
// swap past a hidden board too, not just enabled ones (dir: -1 left, +1 right).
function moveSelectionBy(dir) {
  const idxs = selected.size ? [...selected] : [cur];
  const sorted = idxs.slice().sort((a, b) => a - b);
  let insertBefore;
  if (dir < 0) { const first = sorted[0]; if (first <= 0) return; insertBefore = first - 1; }
  else { const last = sorted[sorted.length - 1]; if (last >= P.frames.length - 1) return; insertBefore = last + 2; }
  commitMove(idxs, insertBefore);
}

// ---------- insert a new board (upload or a blank/solid-color placeholder) ----------
function toggleInsertMode() {
  insertMode = !insertMode;
  $('insertModeBtn').classList.toggle('on', insertMode);
  $('tlInner').classList.toggle('insert-mode', insertMode);
  closeInsertPopover();
}
function closeInsertPopover() {
  const el = document.getElementById('insertPopover');
  if (el) el.remove();
  document.removeEventListener('pointerdown', onInsertPopoverOutside, true);
}
function onInsertPopoverOutside(e) {
  const el = document.getElementById('insertPopover');
  if (el && !el.contains(e.target)) closeInsertPopover();
}
function openInsertPopover(atIndex, clientX, clientY) {
  closeInsertPopover();
  insertPending = { atIndex };
  const pop = document.createElement('div');
  pop.className = 'insert-popover'; pop.id = 'insertPopover';
  pop.style.left = Math.round(clientX) + 'px';
  pop.style.top = Math.round(clientY) + 'px';
  const upload = document.createElement('button'); upload.className = 'btn ghost sm'; upload.textContent = 'Upload image…';
  upload.onclick = () => { closeInsertPopover(); $('insertFileInput').click(); };
  pop.appendChild(upload);
  const colorRow = document.createElement('div'); colorRow.className = 'ip-color-row';
  const colorInp = document.createElement('input'); colorInp.type = 'color'; colorInp.value = '#808080';
  const blankBtn = document.createElement('button'); blankBtn.className = 'btn ghost sm'; blankBtn.textContent = 'Blank frame';
  blankBtn.onclick = () => { const c = colorInp.value; closeInsertPopover(); performInsertBlank(atIndex, c); };
  colorRow.append(colorInp, blankBtn);
  pop.appendChild(colorRow);
  document.body.appendChild(pop);
  setTimeout(() => document.addEventListener('pointerdown', onInsertPopoverOutside, true), 0);
}
function remapForInsert(atIndex) {
  if (cur >= atIndex) cur++;
  if (selAnchor != null && selAnchor >= atIndex) selAnchor++;
  selected = new Set([...selected].map((i) => (i >= atIndex ? i + 1 : i)));
}
async function performInsertFile(atIndex, file) {
  beginGesture();
  const r = await insertFrame(P, atIndex, file);
  if (!r) { cancelGesture(); toast('Could not read that image'); return; }
  remapForInsert(atIndex);
  computeShots(P);
  commitGesture(); refreshUndoButtons(); render();
  toast('Board inserted');
}
async function performInsertBlank(atIndex, color) {
  const blob = await solidColorBlob(P.resW || 1920, P.resH || 1080, color);
  const file = new File([blob], `blank_${Date.now().toString(36)}.png`, { type: 'image/png' });
  await performInsertFile(atIndex, file);
}

// ---------- tile gestures (axis-locked retime/offset, or Alt+drag to reorder) ----------
function attachTile(slot, imgCanvas, fi) {
  let downX = 0, downY = 0, axis = null, snap = null, moved = false;
  let reordering = false, reorderMoved = false, reorderDropFi = null, reorderDropEl = null;

  function updateReorderDropIndicator(clientX) {
    const scRect = $('timeline').getBoundingClientRect();
    const xIn = clientX - scRect.left + $('timeline').scrollLeft;
    const boards = timeline(P).boards;
    let target = P.frames.length, leftPx = innerScaleTotal() * pps;
    for (const bd of boards) {
      const bx = bd.startSec * pps, bw = Math.max(2, bd.len * pps), mid = bx + bw / 2;
      if (xIn < mid) { target = bd.fi; leftPx = bx; break; }
      target = bd.fi + 1; leftPx = bx + bw;
    }
    reorderDropFi = target;
    if (!reorderDropEl) { reorderDropEl = document.createElement('div'); reorderDropEl.className = 'reorder-drop'; $('tlInner').appendChild(reorderDropEl); }
    reorderDropEl.style.left = leftPx + 'px';
  }
  function clearReorderIndicator() { if (reorderDropEl) { reorderDropEl.remove(); reorderDropEl = null; } }

  imgCanvas.addEventListener('pointerdown', (e) => {
    if (e.metaKey || e.ctrlKey) { e.stopPropagation(); toggleSel(fi); return; }
    if (e.altKey) {
      e.stopPropagation(); reordering = true; reorderMoved = false; reorderDropFi = null;
      imgCanvas.setPointerCapture(e.pointerId);
      if (!selected.has(fi)) selected = new Set([fi]);
      slot.classList.add('reordering');
      return;
    }
    downX = e.clientX; downY = e.clientY; axis = null; moved = false;
    imgCanvas.setPointerCapture(e.pointerId);
    // materialize all durations so the snapshot is complete/idempotent
    enabledFlat(P).forEach((f) => setBoardDur(P, f, boardDur(P, f)));
    snap = new Map(P.boardDur);
    if (!selected.has(fi)) selected = new Set([fi]);
  });
  imgCanvas.addEventListener('pointermove', (e) => {
    if (reordering) { reorderMoved = true; updateReorderDropIndicator(e.clientX); return; }
    if (e.buttons === 0 || !snap) return;
    const dx = e.clientX - downX, dy = downY - e.clientY;
    if (!axis) { if (Math.max(Math.abs(dx), Math.abs(dy)) > 4) { axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'; beginGesture(); slot.classList.add('dragging'); } else return; }
    moved = true;
    P.boardDur = new Map(snap); // restore, apply gesture idempotently
    const reach = P.falloffReach * (e.shiftKey ? 2 : 1);
    if (axis === 'y') {
      const startDur = snap.get(P.frames[fi].name) || boardDur(P, fi);
      const desired = Math.max(1 / (P.fps * 4), startDur + dy * SEC_PER_PX);
      if (selected.size > 1 && selected.has(fi)) retimeGroup(P, [...selected], desired / startDur, reach);
      else retimeBoard(P, fi, desired, reach);
    } else {
      if (selected.size > 1 && selected.has(fi)) offsetGroup(P, [...selected], dx * SEC_PER_PX, reach);
      else offsetBoard(P, fi, dx * SEC_PER_PX, reach);
    }
    computeShots(P); light();
  });
  imgCanvas.addEventListener('pointerup', (e) => {
    imgCanvas.releasePointerCapture?.(e.pointerId);
    if (reordering) {
      slot.classList.remove('reordering');
      clearReorderIndicator();
      reordering = false;
      if (reorderMoved && reorderDropFi != null) {
        const idxs = selected.has(fi) && selected.size > 1 ? [...selected] : [fi];
        commitMove(idxs, reorderDropFi);
      }
      reorderDropFi = null;
      return;
    }
    slot.classList.remove('dragging');
    if (axis && moved) { commitGesture(); refreshUndoButtons(); render(); }
    else { selectSingle(fi); }
    axis = null; snap = null;
  });
}

// ---------- playback ----------
function onTick(sec, playing) {
  updatePlayhead(sec);
  const r = resolveAt(P, sec);
  if (r) {
    if (P.frames[r.frame] && r.frame !== previewFi) drawPreview(r.frame);
    if (!playing) cur = r.frame;
    if (annoMode && !playing && r.frame !== lastAnnoFrame) { lastAnnoFrame = r.frame; refreshAnno(); }
    if (r.shotIndex !== lastShot) { lastShot = r.shotIndex; if (!playing) updateInspector(); }
    $('previewMeta').textContent = `${P.frames[r.frame].name} · shot ${r.shotIndex + 1}/${P.shots.length}`;
  }
  $('clock').textContent = `${fmtClock(sec)} / ${fmtClock(P.spotSeconds)}`;
  $('playBtn').textContent = playing ? '❚❚' : '▶';
}
function updatePlayhead(sec) {
  $('playhead').style.left = sec * pps + 'px';
  const r = resolveAt(P, sec);
  slotEls.forEach((el, fi) => el.classList.toggle('active', r && fi === r.frame));
  if (transport.playing) keepVisible(sec);
}
function keepVisible(sec) { const sc = $('timeline'), x = sec * pps; if (x < sc.scrollLeft + 40 || x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = x - sc.clientWidth * 0.3; }

// ---------- zoom ----------
function setZoom(mult, clientX) {
  const sc = $('timeline'); const rect = sc.getBoundingClientRect();
  let anchorSec, screenX;
  if (clientX != null) { screenX = clientX - rect.left; anchorSec = (sc.scrollLeft + screenX) / pps; }
  else { anchorSec = transport.sec; screenX = sc.clientWidth / 2; } // buttons → toward playhead
  pps = Math.max(2, Math.min(6000, pps * mult));
  buildTimeline(); updatePlayhead(transport.sec);
  sc.scrollLeft = anchorSec * pps - screenX;
}
function zoomFit() { pps = fitPps(); buildTimeline(); updatePlayhead(transport.sec); $('timeline').scrollLeft = 0; }

// ---------- audio ----------
async function loadAudio(file) { try { overlay('Decoding audio…'); P.audio = await loadAudioFile(file); transport.mountAudio(); syncAudioUI(); toast('Audio loaded'); } catch (e) { console.error(e); toast('Could not load audio'); } finally { overlay(false); } }
function syncAudioUI() {
  const has = !!P.audio;
  $('audioLane').classList.toggle('hidden', !has);
  $('audioName').textContent = has ? P.audio.name : '';
  if (!has) { layoutAudioClip(); return; }
  drawSlipReadout(); $('useAudioLen').disabled = !P.audio.duration; layoutAudioClip();
  const gain = P.audio.gain ?? 1;
  $('audioGain').value = gain; $('audioGainVal').textContent = Math.round(gain * 100) + '%';
  $('fadeInFrames').value = P.audio.fadeInFrames || 0;
  $('fadeOutFrames').value = P.audio.fadeOutFrames || 0;
}
function layoutAudioClip() {
  let clip = document.getElementById('audioClip');
  if (!P.audio) { if (clip) clip.remove(); return; }
  if (!clip) {
    clip = document.createElement('div'); clip.className = 'audio-clip'; clip.id = 'audioClip';
    const cv = document.createElement('canvas'); cv.className = 'aud-wave'; clip.appendChild(cv);
    const lbl = document.createElement('span'); lbl.className = 'aud-label'; clip.appendChild(lbl);
    $('tlInner').appendChild(clip); attachAudioClipDrag(clip);
  }
  const off = P.audio.offsetSec || 0, dur = P.audio.duration || 0, w = Math.max(24, Math.round(dur * pps));
  clip.style.left = off * pps + 'px'; clip.style.width = w + 'px';
  const cv = clip.querySelector('canvas'); cv.width = w; cv.height = 36; cv.style.width = w + 'px'; cv.style.height = '36px';
  drawWaveform(cv, P.audio, {});
  clip.querySelector('.aud-label').textContent = P.audio.name;
}
function attachAudioClipDrag(clip) {
  let dragging = false, x0 = 0, off0 = 0;
  clip.addEventListener('pointerdown', (e) => { if (!P.audio) return; dragging = true; x0 = e.clientX; off0 = P.audio.offsetSec || 0; clip.classList.add('dragging'); clip.setPointerCapture(e.pointerId); beginGesture(); e.stopPropagation(); });
  clip.addEventListener('pointermove', (e) => { if (!dragging) return; let off = off0 + (e.clientX - x0) / pps; off = Math.round(off * P.fps) / P.fps; P.audio.offsetSec = off; clip.style.left = off * pps + 'px'; drawSlipReadout(); });
  clip.addEventListener('pointerup', (e) => { if (!dragging) return; dragging = false; clip.classList.remove('dragging'); clip.releasePointerCapture?.(e.pointerId); commitGesture(); refreshUndoButtons(); transport.seek(transport.sec); });
}
function drawSlipReadout() { const a = P.audio; if (!a) return; const fr = Math.round((a.offsetSec || 0) * P.fps); $('slipVal').textContent = `offset ${fr >= 0 ? '+' : ''}${fr}f (${fmtClock(Math.abs(a.offsetSec || 0))})`; }
function nudgeSlip(df) { const a = P.audio; if (!a) return; mutate(() => { a.offsetSec = (a.offsetSec || 0) + df / P.fps; }); drawSlipReadout(); layoutAudioClip(); transport.seek(transport.sec); refreshUndoButtons(); }
function nudgeSlipSec(d) { const a = P.audio; if (!a) return; mutate(() => { a.offsetSec = (a.offsetSec || 0) + d; }); drawSlipReadout(); layoutAudioClip(); transport.seek(transport.sec); refreshUndoButtons(); }
function setSyncToPlayhead() { const a = P.audio; if (!a) return; mutate(() => { a.offsetSec = transport.sec; }); drawSlipReadout(); layoutAudioClip(); transport.seek(transport.sec); refreshUndoButtons(); toast('Audio start set to playhead'); }
function removeAudio() { if (!P.audio) return; if (P.audio.url && P.audio.url.startsWith('blob:')) { try { URL.revokeObjectURL(P.audio.url); } catch {} } P.audio = null; transport.mountAudio(); layoutAudioClip(); syncAudioUI(); toast('Audio removed'); }

// ---------- utils ----------
function overlay(msg) { const o = $('overlay'); if (msg === false) { o.classList.add('hidden'); return; } o.querySelector('span').textContent = msg; o.classList.remove('hidden'); }
let toastT; function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2000); }

function boardNav(dir) {
  const flat = enabledFlat(P); const i = flat.indexOf(cur);
  let ni = i < 0 ? 0 : Math.max(0, Math.min(flat.length - 1, i + dir));
  selectSingle(flat[ni]);
}
function shotNav(dir) {
  const si = P.shots.findIndex((s) => cur >= s.start && cur <= s.end); if (si < 0) return;
  let t;
  if (dir > 0) { const n = P.shots[si + 1]; t = n ? n.start : P.frames.length - 1; }
  else { const s = P.shots[si]; if (cur > s.start) t = s.start; else { const pv = P.shots[si - 1]; t = pv ? pv.start : 0; } }
  selectSingle(t);
}
function arrowRetime(dir, big) {
  const step = dir * (1 / P.fps), reach = P.falloffReach * (big ? 2 : 1);
  mutate(() => {
    if (selected.size > 1) { const anchor = [...selected][0]; const d0 = boardDur(P, anchor); retimeGroup(P, [...selected], (d0 + step) / d0, reach); }
    else retimeBoard(P, cur, boardDur(P, cur) + step, reach);
  });
  render();
}
function doUndo() { if (undo()) { render(); syncAudioUI(); onTick(transport.sec, false); toast('Undo'); } }
function doRedo() { if (redo()) { render(); syncAudioUI(); onTick(transport.sec, false); toast('Redo'); } }

function clearSelection() { selected.clear(); render(); }
let marqEl = null, marqX0 = 0;
function clearMarquee() { if (marqEl) { marqEl.remove(); marqEl = null; } }
function drawCurvePreview() {
  const cv = $('curvePrev'); if (!cv) return;
  const w = cv.width = cv.clientWidth || 120, h = cv.height = 34;
  const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(78,168,222,.9)'; ctx.lineWidth = 1.5; ctx.beginPath();
  for (let i = 0; i <= w; i++) { const t = (i / w); const y = h - 3 - falloffWeight(t, P.falloffCurve) * (h - 6); if (i === 0) ctx.moveTo(i, y); else ctx.lineTo(i, y); }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(90,100,114,.5)'; ctx.beginPath(); ctx.moveTo(0, h - 3); ctx.lineTo(w, h - 3); ctx.stroke();
}

// ---------- playhead + ruler interactions ----------
function wirePlayheadAndRuler() {
  const grab = $('phGrab');
  let dragging = false;
  const scrubTo = (clientX) => { const sc = $('timeline'); const x = clientX - sc.getBoundingClientRect().left + sc.scrollLeft; let sec = x / pps; sec = Math.round(sec * P.fps) / P.fps; transport.pause(); transport.seek(Math.max(0, sec)); };
  grab.addEventListener('pointerdown', (e) => { dragging = true; grab.setPointerCapture(e.pointerId); e.stopPropagation(); });
  grab.addEventListener('pointermove', (e) => { if (dragging) scrubTo(e.clientX); });
  grab.addEventListener('pointerup', (e) => { dragging = false; grab.releasePointerCapture?.(e.pointerId); });

  const ruler = $('tlRuler');
  ruler.addEventListener('pointerdown', (e) => {
    clearMarquee();
    const sc = $('timeline'); marqX0 = e.clientX - sc.getBoundingClientRect().left + sc.scrollLeft;
    marqEl = document.createElement('div'); marqEl.className = 'marquee'; marqEl.style.left = marqX0 + 'px'; marqEl.style.width = '0px';
    $('tlInner').appendChild(marqEl); ruler.setPointerCapture(e.pointerId);
  });
  ruler.addEventListener('pointermove', (e) => {
    if (!marqEl) return;
    const sc = $('timeline'); const x = e.clientX - sc.getBoundingClientRect().left + sc.scrollLeft;
    marqEl.style.left = Math.min(marqX0, x) + 'px'; marqEl.style.width = Math.abs(x - marqX0) + 'px';
  });
  const finishMarquee = (e) => {
    if (!marqEl) return;
    const sc = $('timeline'); const x = (e && e.clientX != null) ? e.clientX - sc.getBoundingClientRect().left + sc.scrollLeft : marqX0;
    const a = Math.min(marqX0, x) / pps, b = Math.max(marqX0, x) / pps;
    clearMarquee();
    if (Math.abs(b - a) < 0.02) { transport.pause(); transport.seek(Math.round(a * P.fps) / P.fps); return; }
    const sel = new Set(); timeline(P).boards.forEach((bd) => { if (bd.startSec + bd.len > a && bd.startSec < b) sel.add(bd.fi); });
    if (sel.size) { selected = sel; cur = [...sel][0]; render(); toast(`${sel.size} selected`); }
  };
  ruler.addEventListener('pointerup', finishMarquee);
  ruler.addEventListener('pointercancel', clearMarquee);
  ruler.addEventListener('lostpointercapture', () => { if (marqEl) clearMarquee(); });
  window.addEventListener('blur', clearMarquee);
}

// ---------- wire ----------
function wire() {
  isolationBadge();
  transport.onTick = onTick;
  wirePlayheadAndRuler();

  $('pickBtn').onclick = () => $('fileInput').click();
  $('pickZip').onclick = () => $('zipInput').click();
  $('openWorkBtn').onclick = () => $('workInput').click();
  $('openWorkBtn2').onclick = () => $('workInput').click();
  $('fileInput').onchange = (e) => e.target.files.length && loadImages(e.target.files);
  $('zipInput').onchange = (e) => e.target.files.length && loadImages(e.target.files);
  $('workInput').onchange = (e) => e.target.files.length && openWork(e.target.files[0]);
  $('saveBtn').onclick = saveWork;

  $('pickSplitBtn').onclick = () => $('splitFileInput').click();
  $('splitFileInput').onchange = (e) => { if (e.target.files.length) openSplitModal([...e.target.files]); e.target.value = ''; };
  $('splitModalClose').onclick = closeSplitModal;

  $('fps').onchange = (e) => { mutate(() => { P.fps = Math.max(1, +e.target.value || 24); }); render(); };
  $('spot').onchange = (e) => { mutate(() => { P.spotSeconds = Math.max(1, +e.target.value || 30); }); render(); };
  $('lenUnit').onchange = (e) => { P.lenUnit = e.target.value; render(); };
  $('resW').onchange = (e) => { P.resW = Math.max(1, +e.target.value || 1920); if ($('resLock').checked) { P.resH = Math.max(1, Math.round(P.resW / resAspect)); $('resH').value = P.resH; } else resAspect = P.resW / P.resH; layoutPreview(); };
  $('resH').onchange = (e) => { P.resH = Math.max(1, +e.target.value || 1080); if ($('resLock').checked) { P.resW = Math.max(1, Math.round(P.resH * resAspect)); $('resW').value = P.resW; } else resAspect = P.resW / P.resH; layoutPreview(); };
  $('resLock').onchange = (e) => { if (e.target.checked) resAspect = P.resW / P.resH; };
  $('resPreset').onchange = (e) => { const v = e.target.value; if (!v) return; const [w, h] = v.split('x').map(Number); P.resW = w; P.resH = h; resAspect = w / h; $('resW').value = w; $('resH').value = h; layoutPreview(); };
  $('groupMode').onchange = (e) => { mutate(() => { P.groupMode = e.target.value; }); selected.clear(); render(); };
  $('falloff').oninput = (e) => { P.falloffReach = +e.target.value; $('falloffVal').textContent = e.target.value; };
  $('falloffCurve').onchange = (e) => { P.falloffCurve = e.target.value; drawCurvePreview(); };
  $('clearSelBtn').onclick = clearSelection;
  setRefresh(render);
  const copyGs = async () => {
    try { await navigator.clipboard.writeText(APPS_SCRIPT); toast('Apps Script copied — paste into Sheets → Extensions → Apps Script'); }
    catch { const ta = document.createElement('textarea'); ta.value = APPS_SCRIPT; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('Apps Script copied'); }
  };
  $('assetsBtn').onclick = () => openAssetWindow();
  $('exportBtn').onclick = (e) => { e.stopPropagation(); $('exportMenu').classList.toggle('hidden'); };
  document.addEventListener('click', (e) => { if (!e.target.closest('#exportBtn, #exportMenu')) $('exportMenu').classList.add('hidden'); });
  $('mPreview').onclick = () => { $('exportMenu').classList.add('hidden'); openPreview(); };
  $('mJson').onclick = () => { $('exportMenu').classList.add('hidden'); exportBreakdownJSON(); toast('Breakdown JSON downloaded'); };
  $('mCopyGs').onclick = () => { $('exportMenu').classList.add('hidden'); copyGs(); };
  $('annotateBtn').onclick = toggleAnnotate;
  $('mMp4').onclick = () => { $('exportMenu').classList.add('hidden'); runMp4(0); };
  $('mMp4Draft').onclick = () => { $('exportMenu').classList.add('hidden'); runMp4(960); };
  $('mViewer').onclick = async () => {
    $('exportMenu').classList.add('hidden');
    try { overlay('Building viewer…'); await exportViewer(); toast('Viewer JSON exported — open in view.html'); }
    catch (e) { console.error(e); toast('Viewer export failed'); } finally { overlay(false); }
  };
  $('mEdl').onclick = async () => {
    $('exportMenu').classList.add('hidden');
    try { await exportEdlZip((msg) => overlay(msg)); toast('EDL package downloaded'); }
    catch (e) { console.error(e); toast(e.message || 'EDL export failed'); } finally { overlay(false); }
  };
  $('autoBtn').onclick = () => { mutate(() => { const r = autoEstimate(P); toast(`Estimated ${r.filled} boards → ${fmtClock(r.total)}`); }); render(); };
  $('rebalBtn').onclick = () => { mutate(() => { const r = rebalance(P); toast(`Rebalanced → ${fmtClock(r.total)}`); }); render(); };
  $('cutBtn').onclick = toggleCut;
  $('fitMode').onchange = (e) => { P.fitMode = e.target.value; if (previewFi >= 0) drawPreview(previewFi); refreshAnno(); toast('Fit: ' + e.target.value); };
  const runMp4 = async (maxW) => {
    const burn = P.annos.size ? confirm('Burn annotations into the mp4?\n\nOK = with annotations · Cancel = clean render') : false;
    try { overlay('Preparing mp4…'); await exportMp4({ burnAnnotations: burn, maxW, onProgress: (m, p) => overlay(`${m} ${p ? Math.round(p * 100) + '%' : ''}`) }); toast('mp4 exported'); }
    catch (e) { console.error(e); toast(e.message || 'mp4 export failed'); } finally { overlay(false); }
  };

  $('undoBtn').onclick = doUndo; $('redoBtn').onclick = doRedo;
  $('helpBtn').onclick = () => $('helpPop').classList.toggle('hidden');
  document.addEventListener('click', (e) => { if (!e.target.closest('#helpBtn, #helpPop')) $('helpPop').classList.add('hidden'); });
  $('zoomIn').onclick = () => setZoom(1.6); $('zoomOut').onclick = () => setZoom(1 / 1.6); $('zoomFit').onclick = zoomFit;

  $('playBtn').onclick = () => transport.toggle();
  $('toStart').onclick = () => transport.seek(0);
  $('toEnd').onclick = () => transport.seek(timeline(P).total);
  $('stepBack').onclick = () => boardNav(-1);
  $('stepFwd').onclick = () => boardNav(1);
  $('prevShot').onclick = () => shotNav(-1);
  $('nextShot').onclick = () => shotNav(1);

  $('timeline').addEventListener('pointermove', (e) => { lastCurX = e.clientX; });
  $('timeline').addEventListener('pointerleave', () => { lastCurX = null; });
  $('timeline').addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX); } }, { passive: false });

  $('loadAudioBtn').onclick = () => $('audioInput').click();
  $('loadAudioBtn0').onclick = () => $('audioInput').click();
  $('audioInput').onchange = (e) => e.target.files.length && loadAudio(e.target.files[0]);
  $('slipMinus1').onclick = () => nudgeSlip(-1); $('slipPlus1').onclick = () => nudgeSlip(1);
  $('slipMinusS').onclick = () => nudgeSlipSec(-0.1); $('slipPlusS').onclick = () => nudgeSlipSec(0.1);
  $('setSync').onclick = setSyncToPlayhead;
  $('removeAudio').onclick = removeAudio;
  $('useAudioLen').onclick = () => { if (P.audio?.duration) { mutate(() => { P.spotSeconds = Math.round(P.audio.duration * 100) / 100; }); $('spot').value = P.spotSeconds; render(); toast('Spot set to audio length'); } };
  $('audioGain').addEventListener('focus', beginGesture);
  $('audioGain').addEventListener('input', (e) => { if (!P.audio) return; P.audio.gain = +e.target.value; $('audioGainVal').textContent = Math.round(P.audio.gain * 100) + '%'; });
  $('audioGain').addEventListener('change', () => { commitGesture(); refreshUndoButtons(); });
  $('fadeInFrames').addEventListener('focus', beginGesture);
  $('fadeInFrames').addEventListener('input', (e) => { if (!P.audio) return; P.audio.fadeInFrames = Math.max(0, Math.round(+e.target.value || 0)); });
  $('fadeInFrames').addEventListener('change', () => { commitGesture(); refreshUndoButtons(); });
  $('fadeOutFrames').addEventListener('focus', beginGesture);
  $('fadeOutFrames').addEventListener('input', (e) => { if (!P.audio) return; P.audio.fadeOutFrames = Math.max(0, Math.round(+e.target.value || 0)); });
  $('fadeOutFrames').addEventListener('change', () => { commitGesture(); refreshUndoButtons(); });

  $('insertModeBtn').onclick = toggleInsertMode;
  $('insertFileInput').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (f && insertPending) { await performInsertFile(insertPending.atIndex, f); insertPending = null; }
  };

  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); const d = $('drop'); if (d) d.classList.add('hot'); }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'dragleave' && e.relatedTarget) return; const d = $('drop'); if (d) d.classList.remove('hot'); }));
  document.addEventListener('drop', (e) => { e.preventDefault(); const files = [...e.dataTransfer.files]; if (!files.length) return; const audio = files.find((f) => /\.(mp3|wav|m4a|aac|ogg)$/i.test(f.name)); const work = files.find((f) => /\.json$/i.test(f.name)); if (audio && P.frames.length) loadAudio(audio); else if (work && files.length === 1) openWork(work); else loadImages(files); });

  document.addEventListener('keydown', (e) => {
    const typing = /input|textarea|select/i.test(e.target.tagName);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
    if (typing || !P.frames.length) return;
    const k = e.key;
    if (k === ' ') { if (/button/i.test(e.target.tagName)) return; e.preventDefault(); transport.toggle(); return; }
    if (k === 'Escape') { if (document.getElementById('activeModal')) { closeModal(); } else if (annoMode) { toggleAnnotate(); } else if (insertMode) { toggleInsertMode(); } else clearSelection(); return; }
    if (k === 'h' || k === 'H') { e.preventDefault(); toggleHide(cur); return; }
    if (k === 'p' || k === 'P') { e.preventDefault(); togglePin(cur); return; }
    if (k === 'c' || k === 'C') { e.preventDefault(); toggleCut(); return; }
    if (k === '+' || k === '=') { e.preventDefault(); setZoom(1.6); return; }
    if (k === '-' || k === '_') { e.preventDefault(); setZoom(1 / 1.6); return; }
    if (k === 'ArrowRight' || k === 'ArrowLeft') {
      e.preventDefault(); const dir = k === 'ArrowRight' ? 1 : -1;
      if ((e.metaKey || e.ctrlKey) && e.shiftKey) moveSelectionBy(dir);
      else if (e.metaKey || e.ctrlKey) transport.seek(dir > 0 ? timeline(P).total : 0);
      else if (e.shiftKey) selectExtend(dir);
      else if (e.altKey) shotNav(dir);
      else boardNav(dir);
    } else if (k === 'ArrowUp' || k === 'ArrowDown') {
      e.preventDefault(); arrowRetime(k === 'ArrowUp' ? 1 : -1, e.shiftKey);
    }
  });

  window.addEventListener('resize', () => { if (P.frames.length) { buildTimeline(); updatePlayhead(transport.sec); layoutAudioClip(); layoutPreview(); } });
}

wire();
