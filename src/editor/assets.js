import {
  project as P, shotMeta, shotLenSec, lenToUnit, isShotDisabled, enabledBoards,
  addAssetTask, removeAssetTask, addAssetCat, removeAssetCat, addAsset, removeAsset,
  getAsset, setAssetField, setAssetTaskVal, assetsByCat,
} from '../core/model.js';
import { mutate } from '../core/history.js';
import { createAnnotator, annotatorToolbar, drawAnnos } from '../core/annotate.js';
import { apiBuild, apiSyncSheetState, apiUpdateComposite } from '../io/sheetsApi.js';

let refresh = () => {};
export function setRefresh(fn) { refresh = fn; }

// ---------- montage + breakdown data ----------
function shotMontage(sh, cols = 3, cell = 200) {
  const boards = enabledBoards(P, sh);
  if (!boards.length) return null;
  const t0 = P.frames[boards[0]].thumb;
  const cw = cell, ch = Math.round(cell * t0.height / t0.width);
  const n = boards.length, c = Math.min(cols, n), r = Math.ceil(n / c);
  const cv = document.createElement('canvas'); cv.width = c * cw; cv.height = r * ch;
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
  boards.forEach((fi, i) => { const rr = Math.floor(i / c), cc = i % c; ctx.drawImage(P.frames[fi].thumb, cc * cw, rr * ch, cw, ch); });
  return { url: cv.toDataURL('image/jpeg', 0.72), w: cv.width, h: cv.height };
}

function loadImg(src) { return new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; }); }

// best available source image for an asset (picked board = full-res original;
// custom upload = stored full-res; else the small thumb). Returns {img, revoke}.
async function assetSourceImg(a) {
  if (a.thumbFrom && a.thumbFrom !== 'upload') {
    const f = P.frames.find((fr) => fr.name === a.thumbFrom);
    if (f && f.full) { const url = URL.createObjectURL(f.full); const img = await loadImg(url); return { img, revoke: () => URL.revokeObjectURL(url) }; }
  }
  if (a.src) return { img: await loadImg(a.src), revoke: () => {} };
  if (a.thumb) return { img: await loadImg(a.thumb), revoke: () => {} };
  return { img: null, revoke: () => {} };
}

// composited reference for export/preview/sheet: 320px wide from best source + annotations
async function assetExportThumb(a, W = 320) {
  const { img, revoke } = await assetSourceImg(a);
  if (!img) { revoke(); return { url: a.thumb || null, w: a.thumbW || 240, h: a.thumbH || 135 }; }
  const h = Math.round(W * img.naturalHeight / img.naturalWidth);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = h;
  const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0, W, h);
  if (a.annos && a.annos.length) drawAnnos(ctx, a.annos, { x: 0, y: 0, w: W, h });
  revoke();
  return { url: cv.toDataURL('image/jpeg', 0.82), w: W, h };
}

export async function buildBreakdownData(withThumbs = true) {
  const shots = P.shots.map((sh, si) => {
    const m = shotMeta(P, sh);
    const mont = withThumbs ? shotMontage(sh) : null;
    return {
      id: si + 1, name: sh.name || '', tag: m.tag || '',
      length: lenToUnit(P, shotLenSec(P, sh)), note: m.note || '',
      taskVals: m.taskVals || m.stageVals || {}, disabled: isShotDisabled(P, sh),
      thumbnail: mont ? mont.url : null, thumbW: mont ? mont.w : 152, thumbH: mont ? mont.h : 88,
    };
  });
  const assets = [];
  for (const a of P.assets) {
    let th = { url: null, w: 320, h: 180 };
    if (withThumbs && a.thumb) th = await assetExportThumb(a, 320);
    assets.push({ name: a.name, cat: a.cat, tasks: a.tasks || {}, thumbnail: th.url, thumbW: th.w, thumbH: th.h });
  }
  return { kind: 'breakdown', lenUnit: P.lenUnit, fps: P.fps, shotTasks: P.shotTasks, assetTasks: P.assetTasks, assetCats: P.assetCats, shots, assets };
}

export async function exportBreakdownJSON() {
  const data = await buildBreakdownData(true);
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `${P.baseName}_breakdown.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- composite-strip export (experimental) ----------
// Instead of one thumbnail per row (N insertImage() calls in Apps Script, the
// slow part of building a sheet), stack every row's picture into a single tall
// image per column and ship that + each row's slice height. Apps Script then
// does ONE insertImage() per column instead of one per row. These constants
// must match MONTAGE_W / PAD in src/io/appsScript.js (regenerate that file after
// editing the shot/asset sheet builders — see CLAUDE.md).
const STRIP_MONTAGE_W = 300;
const STRIP_REF_W = 320;
const STRIP_PAD = 8;

// entries: [{url,w,h} | null] one per row, in final row order. Returns
// {url, w, h, rowH} where rowH[i] is that row's slice height (sans PAD) —
// Apps Script sets row heights straight from this, so there's one source of
// truth for the row-height math instead of recomputing it on both sides.
async function buildStrip(entries, colWidth) {
  const rowH = entries.map((e) => (e && e.url) ? Math.max(1, Math.round(colWidth * e.h / e.w)) : Math.round(colWidth * 88 / 152));
  const totalH = rowH.reduce((sum, h) => sum + h + STRIP_PAD, 0);
  if (!entries.length || !totalH) return { url: null, w: colWidth, h: 0, rowH: [] };
  const cv = document.createElement('canvas'); cv.width = colWidth; cv.height = totalH;
  const ctx = cv.getContext('2d');
  // JPEG has no alpha channel — unpainted canvas pixels (the PAD gaps between
  // rows, and any row with no thumbnail) get flattened to solid BLACK on
  // export otherwise. Fill white first to match the sheet's own background.
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height);
  let y = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e && e.url) { const img = await loadImg(e.url); if (img) ctx.drawImage(img, 0, y, colWidth, rowH[i]); }
    y += rowH[i] + STRIP_PAD;
  }
  return { url: cv.toDataURL('image/jpeg', 0.78), w: colWidth, h: totalH, rowH };
}

export async function buildBreakdownDataComposite() {
  const shotEntries = [];
  const shots = P.shots.map((sh, si) => {
    const m = shotMeta(P, sh);
    shotEntries.push(shotMontage(sh));
    return {
      id: si + 1, name: sh.name || '', tag: m.tag || '',
      length: lenToUnit(P, shotLenSec(P, sh)), note: m.note || '',
      taskVals: m.taskVals || m.stageVals || {}, disabled: isShotDisabled(P, sh),
    };
  });
  const shotStrip = await buildStrip(shotEntries, STRIP_MONTAGE_W);

  const assetEntries = [];
  const assets = [];
  for (const cat of P.assetCats) {
    const items = assetsByCat(P, cat);
    for (let i = 0; i < items.length; i++) {
      const a = items[i];
      assetEntries.push(a.thumb ? await assetExportThumb(a, STRIP_REF_W) : null);
      assets.push({ name: a.name, cat: a.cat, catLabel: i === 0 ? cap(cat) : '', tasks: a.tasks || {} });
    }
  }
  const assetStrip = await buildStrip(assetEntries, STRIP_REF_W);

  return {
    kind: 'breakdown', imageMode: 'composite',
    lenUnit: P.lenUnit, fps: P.fps, shotTasks: P.shotTasks, assetTasks: P.assetTasks, assetCats: P.assetCats,
    shots, assets, shotStrip, assetStrip,
  };
}

export async function exportBreakdownCompositeJSON() {
  const data = await buildBreakdownDataComposite();
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `${P.baseName}_breakdown_composite.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- direct-to-Sheets export (experimental, no file step) ----------
// Signed-in-user version of the composite export: calls the Apps Script
// Execution API (sheetsApi.js) instead of downloading + picking a JSON file.
export async function sendBuildDirect() {
  const data = await buildBreakdownDataComposite();
  return apiBuild(data);
}

/**
 * "Update active sheet (direct)": mirrors updateActiveSheet()'s own matching
 * (by tag||name), computed here instead of in Apps Script since the client
 * needs the final row order BEFORE it can build a single composite image
 * covering every row. Existing rows keep their current relative order
 * (matched ones get a fresh thumbnail + length, unmatched ones are flagged
 * removed with no picture — see the note in appsScript.js on why a removed
 * row's old picture can't be preserved once images are merged into one
 * strip); anything in the live project not already on the sheet is appended
 * as new, in project order — same shape updateActiveSheet() produces.
 */
export async function sendUpdateDirect() {
  const sync = await apiSyncSheetState();
  const existingNames = (sync && sync.names) || [];
  if (!existingNames.length) throw new Error('No existing breakdown rows found — use "Build new sheet (direct)" first.');

  const liveByKey = new Map();
  P.shots.forEach((sh) => {
    const m = shotMeta(P, sh);
    const key = (m.tag || sh.name || '').toString();
    if (key) liveByKey.set(key, sh);
  });

  const used = new Set();
  const finalRows = [];
  const entries = [];
  existingNames.forEach((nm) => {
    const sh = liveByKey.get(nm);
    if (sh) {
      used.add(nm);
      const m = shotMeta(P, sh);
      finalRows.push({ name: sh.name || '', tag: m.tag || '', length: lenToUnit(P, shotLenSec(P, sh)), isNew: false, removed: false });
      entries.push(shotMontage(sh));
    } else {
      finalRows.push({ name: nm, removed: true });
      entries.push(null);
    }
  });
  P.shots.forEach((sh, si) => {
    const m = shotMeta(P, sh);
    const key = (m.tag || sh.name || '').toString();
    if (key && used.has(key)) return;
    finalRows.push({ id: si + 1, name: sh.name || '', tag: m.tag || '', length: lenToUnit(P, shotLenSec(P, sh)), note: m.note || '', isNew: true, removed: false });
    entries.push(shotMontage(sh));
  });

  const strip = await buildStrip(entries, STRIP_MONTAGE_W);
  return apiUpdateComposite({ finalRows, strip });
}

// ---------- modal shell ----------
export function modal(title, bodyBuilder, wide, onClose) {
  closeModal(false);
  const root = document.getElementById('modalRoot');
  const back = document.createElement('div'); back.className = 'modal-back'; back.id = 'activeModal';
  back._onClose = onClose || null;
  const box = document.createElement('div'); box.className = 'modal' + (wide ? ' wide' : '');
  const head = document.createElement('div'); head.className = 'modal-head';
  head.innerHTML = `<b>${title}</b>`;
  const x = document.createElement('button'); x.className = 'tbtn sm'; x.textContent = '✕'; x.onclick = () => closeModal(true);
  head.appendChild(x);
  const body = document.createElement('div'); body.className = 'modal-body';
  box.append(head, body); back.appendChild(box); root.appendChild(back);
  back.addEventListener('pointerdown', (e) => { if (e.target === back) closeModal(true); });
  bodyBuilder(body);
  return body;
}
export function closeModal(runHook = true) { const m = document.getElementById('activeModal'); if (!m) return; const h = m._onClose; m.remove(); if (runHook && h) h(); }

// ---------- asset window ----------
export function openAssetWindow() {
  modal('Asset tracker', renderAssets, true);
}
function renderAssets(body) {
  body.innerHTML = '';

  // asset task columns editor
  const tbar = el('div', 'task-editor');
  tbar.appendChild(tag('asset tasks:', 'lbl'));
  P.assetTasks.forEach((t) => {
    const chip = el('span', 'chip'); chip.textContent = t;
    const rm = el('button', 'chip-x'); rm.textContent = '×'; rm.title = 'remove task';
    rm.onclick = () => { if (confirm(`Remove asset task "${t}"?`)) { mutate(() => removeAssetTask(P, t)); renderAssets(body); } };
    chip.appendChild(rm); tbar.appendChild(chip);
  });
  const addT = el('button', 'btn ghost sm'); addT.textContent = '+ task';
  addT.onclick = () => { const n = prompt('New asset task (e.g. groom, fx):'); if (n) { mutate(() => addAssetTask(P, n)); renderAssets(body); } };
  tbar.appendChild(addT);
  body.appendChild(tbar);

  // categories
  P.assetCats.forEach((cat) => {
    const sec = el('div', 'asset-cat');
    const ch = el('div', 'asset-cat-head');
    ch.innerHTML = `<span class="cat-name">${escapeHtml(cat)}</span>`;
    const addA = el('button', 'btn ghost sm'); addA.textContent = '+ asset';
    addA.onclick = () => { mutate(() => addAsset(P, cat)); renderAssets(body); };
    const rmC = el('button', 'mini'); rmC.textContent = 'remove category'; rmC.onclick = () => { if (confirm(`Remove category "${cat}" and its assets?`)) { mutate(() => removeAssetCat(P, cat)); renderAssets(body); } };
    ch.append(addA, rmC); sec.appendChild(ch);

    const items = assetsByCat(P, cat);
    if (!items.length) { const e = el('div', 'asset-empty'); e.textContent = 'no assets yet'; sec.appendChild(e); }
    items.forEach((a) => sec.appendChild(assetRow(a, body)));
    body.appendChild(sec);
  });

  const addCat = el('button', 'btn ghost sm'); addCat.textContent = '+ category';
  addCat.onclick = () => { const n = prompt('New category (e.g. vehicle, fx):'); if (n) { mutate(() => addAssetCat(P, n)); renderAssets(body); } };
  body.appendChild(addCat);
}

function assetRow(a, body) {
  const row = el('div', 'asset-row');
  // thumb
  const thumb = el('div', 'asset-thumb');
  if (a.thumb) { const im = document.createElement('img'); im.src = a.thumb; thumb.appendChild(im); if (a.annos && a.annos.length) { const ov = document.createElement('canvas'); ov.className = 'asset-anno-ov'; thumb.appendChild(ov); const set = () => { const r = thumb.getBoundingClientRect(); ov.width = r.width; ov.height = r.height; drawAnnos(ov.getContext("2d"), a.annos, { x: 0, y: 0, w: ov.width, h: ov.height }); }; requestAnimationFrame(set); } }
  else thumb.textContent = '—';
  const thumbBtns = el('div', 'asset-thumb-btns');
  const pick = el('button', 'mini'); pick.textContent = 'board'; pick.title = 'pick a board as reference'; pick.onclick = () => pickBoard(a.id, body);
  const up = el('button', 'mini'); up.textContent = 'upload'; up.onclick = () => uploadThumb(a.id, body);
  const ann = el('button', 'mini'); ann.textContent = '✎'; ann.title = 'annotate reference'; ann.disabled = !a.thumb; ann.onclick = () => openAssetAnnotate(a.id, body);
  thumbBtns.append(pick, up, ann);
  const thumbWrap = el('div', 'asset-thumb-wrap'); thumbWrap.append(thumb, thumbBtns);
  row.appendChild(thumbWrap);

  // name
  const nm = document.createElement('input'); nm.className = 'asset-name'; nm.value = a.name;
  nm.oninput = () => setAssetField(P, a.id, 'name', nm.value);
  nm.onchange = () => mutate(() => setAssetField(P, a.id, 'name', nm.value));
  row.appendChild(nm);

  // task values
  const tvs = el('div', 'asset-tasks');
  P.assetTasks.forEach((t) => {
    const wrap = el('label', 'asset-task');
    const lb = el('span', ''); lb.textContent = t;
    const inp = document.createElement('input'); inp.type = 'number'; inp.min = '0';
    inp.value = (a.tasks && a.tasks[t] != null) ? a.tasks[t] : '';
    inp.oninput = () => setAssetTaskVal(P, a.id, t, inp.value === '' ? '' : +inp.value);
    inp.onchange = () => mutate(() => setAssetTaskVal(P, a.id, t, inp.value === '' ? '' : +inp.value));
    wrap.append(lb, inp); tvs.appendChild(wrap);
  });
  row.appendChild(tvs);

  const del = el('button', 'mini'); del.textContent = '🗑'; del.title = 'delete asset';
  del.onclick = () => { mutate(() => removeAsset(P, a.id)); renderAssets(body); };
  row.appendChild(del);
  return row;
}

function pickBoard(id, body) {
  modal('Pick a reference board', (mb) => {
    const grid = el('div', 'board-picker');
    P.frames.forEach((f, fi) => {
      const c = document.createElement('canvas'); c.width = 152; c.height = 88; c.className = 'pick';
      c.getContext('2d').drawImage(f.thumb, 0, 0, 152, 88); c.title = f.name;
      c.onclick = () => {
        const cv = document.createElement('canvas'); cv.width = 240; cv.height = Math.round(240 * f.thumb.height / f.thumb.width);
        cv.getContext('2d').drawImage(f.thumb, 0, 0, cv.width, cv.height);
        mutate(() => { setAssetField(P, id, 'thumb', cv.toDataURL('image/jpeg', 0.75)); setAssetField(P, id, 'thumbFrom', f.name); setAssetField(P, id, 'src', null); setAssetField(P, id, 'thumbW', cv.width); setAssetField(P, id, 'thumbH', cv.height); setAssetField(P, id, 'annos', []); });
        openAssetWindow();
      };
      grid.appendChild(c);
    });
    mb.appendChild(grid);
  }, true, () => openAssetWindow());
}

async function openAssetAnnotate(id, body) {
  const a = getAsset(P, id); if (!a || !a.thumb) return;
  const { img, revoke } = await assetSourceImg(a);
  modal('Annotate reference — ' + (a.name || '') + '  (Esc / ✕ to return)', (mb) => {
    const host = el('div', 'anno-host'); host.style.position = 'relative';
    const im = document.createElement('img'); im.className = 'anno-img'; im.src = img ? img.src : a.thumb;
    host.appendChild(im); mb.appendChild(host);
    const barSlot = el('div', 'anno-bar-wrap'); mb.appendChild(barSlot);
    im.onload = () => { const ctrl = createAnnotator(host, im, a.annos || [], (strokes) => { mutate(() => setAssetField(P, id, 'annos', strokes)); }); barSlot.appendChild(annotatorToolbar(ctrl)); };
  }, true, () => { revoke(); openAssetWindow(); });
}
function uploadThumb(id, body) {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = () => {
    const file = inp.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = () => { const img = new Image(); img.onload = () => {
      const cv = document.createElement('canvas'); cv.width = 240; cv.height = Math.round(240 * img.height / img.width); cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      const capW = Math.min(1600, img.width); const fc = document.createElement('canvas'); fc.width = capW; fc.height = Math.round(capW * img.height / img.width); fc.getContext('2d').drawImage(img, 0, 0, fc.width, fc.height);
      mutate(() => { setAssetField(P, id, 'thumb', cv.toDataURL('image/jpeg', 0.75)); setAssetField(P, id, 'src', fc.toDataURL('image/jpeg', 0.85)); setAssetField(P, id, 'thumbFrom', 'upload'); setAssetField(P, id, 'thumbW', cv.width); setAssetField(P, id, 'thumbH', cv.height); setAssetField(P, id, 'annos', []); });
      renderAssets(document.querySelector('#activeModal .modal-body')); }; img.src = r.result; };
    r.readAsDataURL(file);
  };
  inp.click();
}

// ---------- sheet preview ----------
export function openPreview() {
  modal('Sheet preview', async (body) => {
    body.innerHTML = '<div class="asset-empty">Building preview…</div>';
    const d = await buildBreakdownData(true);
    body.innerHTML = '';
    const wrapS = el('div', 'sheet-block');
    wrapS.appendChild(tag('Shots', 'sheet-title'));
    wrapS.appendChild(shotTable(d));
    body.appendChild(wrapS);
    if (d.assets.length) {
      const wrapA = el('div', 'sheet-block');
      wrapA.appendChild(tag('Assets', 'sheet-title'));
      wrapA.appendChild(assetTable(d));
      body.appendChild(wrapA);
    } else {
      const e = el('div', 'asset-empty'); e.textContent = 'No assets — add some in the Asset tracker to see the Assets tab.'; body.appendChild(e);
    }
  }, true);
}
function shotTable(d) {
  const t = document.createElement('table'); t.className = 'sheet';
  const heads = ['Shot', 'Storyboard', 'Name', `Length (${d.lenUnit === 'frames' ? 'f' : 's'})`, ...d.shotTasks.map(cap), 'Notes'];
  t.appendChild(tr(heads.map((h) => th(h))));
  d.shots.forEach((s) => {
    const cells = [];
    cells.push(td(s.disabled ? `${s.id} ⊘` : s.id));
    const img = document.createElement('td'); if (s.thumbnail) { const im = document.createElement('img'); im.src = s.thumbnail; im.className = 'sheet-thumb'; img.appendChild(im); } cells.push(img);
    cells.push(td(s.tag || s.name));
    cells.push(td(s.length));
    d.shotTasks.forEach((tk) => cells.push(td(s.taskVals[tk] != null ? s.taskVals[tk] : '')));
    cells.push(td(s.note));
    const row = tr(cells); if (s.disabled) row.className = 'dis'; t.appendChild(row);
  });
  return t;
}
function assetTable(d) {
  const t = document.createElement('table'); t.className = 'sheet';
  t.appendChild(tr(['Category', 'Reference', 'Asset', ...d.assetTasks.map(cap)].map((h) => th(h))));
  d.assetCats.forEach((cat) => {
    d.assets.filter((a) => a.cat === cat).forEach((a, i) => {
      const ref = document.createElement('td'); if (a.thumbnail) { const im = document.createElement('img'); im.src = a.thumbnail; im.className = 'sheet-thumb'; ref.appendChild(im); }
      const cells = [td(i === 0 ? cap(cat) : ''), ref, td(a.name)];
      d.assetTasks.forEach((tk) => cells.push(td(a.tasks[tk] != null ? a.tasks[tk] : '')));
      t.appendChild(tr(cells));
    });
  });
  return t;
}

// ---------- tiny dom helpers ----------
function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function tag(text, cls) { const e = el('span', cls); e.textContent = text; return e; }
function tr(cells) { const r = document.createElement('tr'); cells.forEach((c) => r.appendChild(c)); return r; }
function th(t) { const e = document.createElement('th'); e.textContent = t; return e; }
function td(t) { const e = document.createElement('td'); e.textContent = t; return e; }
function cap(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
