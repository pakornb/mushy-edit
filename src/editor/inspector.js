import {
  project as P, shotMeta, setShotMeta, shotLenSec, setShotLen, lenToUnit, unitToSec,
  isBoardDisabled, isShotDisabled, shotId, boardDur, setBoardDur, isPinned, enabledBoards,
  addShotTask, removeShotTask, isShotStart, boundaryState, forceCut, mergeUp, resetBoundary,
  setBoardFit,
} from '../core/model.js';
import { mutate, beginGesture, commitGesture } from '../core/history.js';

export function renderInspector(container, frameIndex, cb) {
  const { onChange, onStructural, onGoFrame, refreshPreview } = cb;
  container.innerHTML = '';
  if (!P.shots.length) return;
  const si = P.shots.findIndex((s) => frameIndex >= s.start && frameIndex <= s.end);
  const sh = P.shots[si];
  if (!sh) return;
  const m = shotMeta(P, sh);
  const shotOff = isShotDisabled(P, sh);
  const enb = enabledBoards(P, sh);
  const shotPinned = enb.length > 0 && enb.every((fi) => isPinned(P, fi));
  const origName = sh.name || P.frames[sh.start].name;

  // ---- header: title + read-only length + shot pin/disable ----
  const head = el('div', 'insp-head');
  const titleWrap = el('div', 'insp-title-wrap');
  const label = m.tag || origName;
  titleWrap.innerHTML =
    `<div class="insp-title">${escapeHtml(label)}${shotOff ? ' <span class="cut-tag">CUT</span>' : ''}${shotPinned ? ' <span class="pin-tag">PIN</span>' : ''}</div>` +
    `<div class="insp-sub">shot ${si + 1}/${P.shots.length} · ${sh.count} boards · ${shotLenSec(P, sh).toFixed(2)}s</div>`;
  const shotBtns = el('div', 'insp-shotbtns');
  shotBtns.append(
    iconbtn(shotOff ? '⊘' : '👁', shotOff ? 'enable shot' : 'disable shot', shotOff ? 'danger' : '', () => {
      mutate(() => { if (shotOff) P.shotDisabled.delete(shotId(P, sh)); else P.shotDisabled.add(shotId(P, sh)); }); onStructural();
    }),
    iconbtn('📌', shotPinned ? 'unpin shot' : 'pin shot', shotPinned ? 'on' : '', () => {
      mutate(() => { if (shotPinned) enb.forEach((fi) => P.pinned.delete(P.frames[fi].name)); else enb.forEach((fi) => P.pinned.add(P.frames[fi].name)); }); onStructural();
    }),
  );
  head.append(titleWrap, shotBtns);
  container.appendChild(head);

  // ---- filmstrip (bigger thumbs, no per-cell buttons) ----
  const boards = el('div', 'insp-boards');
  for (let f = sh.start; f <= sh.end; f++) {
    const off = isBoardDisabled(P, f);
    const pin = isPinned(P, f);
    const cell = el('div', 'board-cell' + (off ? ' off' : '') + (pin ? ' pinned' : '') + (f === frameIndex ? ' sel' : ''));
    const c = document.createElement('canvas');
    c.width = 200; c.height = 112; c.className = 'board';
    c.getContext('2d').drawImage(P.frames[f].thumb, 0, 0, 200, 112);
    c.title = P.frames[f].name;
    c.addEventListener('click', () => onGoFrame(f));
    cell.appendChild(c);
    if (pin) { const b = el('span', 'cell-badge pin'); b.textContent = '📌'; cell.appendChild(b); }
    if (off) { const b = el('span', 'cell-badge off'); b.textContent = 'hidden'; cell.appendChild(b); }
    boards.appendChild(cell);
  }
  container.appendChild(boards);

  // ---- selected-board action row (acts on frameIndex) ----
  const off = isBoardDisabled(P, frameIndex);
  const pin = isPinned(P, frameIndex);
  const isStart = isShotStart(P, frameIndex);
  const act = el('div', 'board-actions');
  const cap = el('span', 'ba-cap'); cap.textContent = 'this board';
  act.appendChild(cap);

  act.appendChild(iconbtn(off ? '⊘' : '👁', off ? 'show board (h)' : 'hide board (h)', off ? 'danger' : '', () => {
    mutate(() => { if (off) P.boardDisabled.delete(P.frames[frameIndex].name); else P.boardDisabled.add(P.frames[frameIndex].name); }); onStructural();
  }));
  act.appendChild(iconbtn('📌', pin ? 'unpin board (p)' : 'pin board (p)', pin ? 'on' : '', () => {
    mutate(() => { if (pin) P.pinned.delete(P.frames[frameIndex].name); else P.pinned.add(P.frames[frameIndex].name); }); onStructural();
  }));
  act.appendChild(iconbtn('✂', isStart ? 'merge into previous shot (c)' : 'cut — new shot here (c)', (boundaryState(P, frameIndex) !== 'auto' ? 'on ' : '') + 'big', () => {
    mutate(() => { if (isStart) mergeUp(P, frameIndex); else forceCut(P, frameIndex); }); onStructural();
  }, frameIndex === 0));
  if (boundaryState(P, frameIndex) !== 'auto') act.appendChild(iconbtn('↺', 'reset this cut to auto', '', () => { mutate(() => resetBoundary(P, frameIndex)); onStructural(); }));

  if (!off) {
    const d = document.createElement('input');
    d.type = 'number'; d.min = '0'; d.step = P.lenUnit === 'frames' ? '1' : '0.05'; d.className = 'ba-dur';
    d.value = lenToUnit(P, boardDur(P, frameIndex)); d.title = 'duration of this board';
    d.addEventListener('focus', beginGesture);
    d.addEventListener('input', () => { const v = parseFloat(d.value); if (!isNaN(v) && v > 0) setBoardDur(P, frameIndex, unitToSec(P, v)); onChange(); });
    d.addEventListener('blur', commitGesture);
    const u = el('span', 'ba-unit'); u.textContent = P.lenUnit === 'frames' ? 'f' : 's';
    act.append(d, u);
  }
  container.appendChild(act);

  // ---- Shot section ----
  const shotSec = section('Shot');

  const nameRow = el('div', 'name-row');
  const nameIn = document.createElement('input');
  nameIn.value = m.tag || ''; nameIn.placeholder = origName; nameIn.title = 'rename (blank = original)';
  nameIn.addEventListener('focus', beginGesture);
  nameIn.addEventListener('input', () => { setShotMeta(P, sh, 'tag', nameIn.value); onChange(); });
  nameIn.addEventListener('blur', commitGesture);
  const revert = iconbtn('↺', 'revert to original name', '', () => { mutate(() => setShotMeta(P, sh, 'tag', '')); onStructural(); });
  nameRow.append(nameIn, revert);
  shotSec.append(field('Name', nameRow, `original: ${origName}`));

  // length: read-only, click to edit
  const lenField = field('Length (total)', editableNumber(
    () => lenToUnit(P, shotLenSec(P, sh)),
    (v) => setShotLen(P, sh, unitToSec(P, v)),
    P.lenUnit === 'frames' ? 'frames' : 'sec', onChange, shotOff));
  shotSec.append(lenField);

  const fitSel = document.createElement('select');
  [['default', 'default (global)'], ['cover', 'cover (crop)'], ['contain', 'contain (bars)'], ['width', 'fit width'], ['height', 'fit height']].forEach(([v, lbl]) => { const o = document.createElement('option'); o.value = v; o.textContent = lbl; fitSel.appendChild(o); });
  fitSel.value = P.boardFit.get(P.frames[frameIndex].name) || 'default';
  fitSel.onchange = () => { mutate(() => setBoardFit(P, frameIndex, fitSel.value)); refreshPreview && refreshPreview(); };
  shotSec.append(field('Fit (this board)', fitSel));
  container.appendChild(shotSec);

  // ---- Tasks section (clearly separated) ----
  const taskSec = section('Tasks');
  const addBtn = el('button', 'sec-add'); addBtn.textContent = '+ task'; addBtn.title = 'add a global shot task';
  addBtn.onclick = () => { const name = prompt('New shot task (e.g. layout, fx):'); if (name) { mutate(() => addShotTask(P, name)); onStructural(); } };
  taskSec.querySelector('.sec-head').appendChild(addBtn);
  const stageWrap = el('div', 'insp-stages');
  P.shotTasks.forEach((s) => {
    const cell = el('div', 'stage-cell');
    const lab = el('label', ''); lab.textContent = s; lab.title = 'double-click to remove this task';
    lab.addEventListener('dblclick', () => { if (confirm(`Remove shot task "${s}" everywhere?`)) { mutate(() => removeShotTask(P, s)); onStructural(); } });
    const inp = document.createElement('input'); inp.type = 'number'; inp.min = '0';
    const tv = m.taskVals || m.stageVals || {};
    inp.value = (tv && tv[s] != null) ? tv[s] : '';
    inp.addEventListener('focus', beginGesture);
    inp.addEventListener('input', () => { const mm = shotMeta(P, sh); const sv = { ...(mm.taskVals || mm.stageVals || {}) }; sv[s] = inp.value === '' ? null : +inp.value; setShotMeta(P, sh, 'taskVals', sv); onChange(); });
    inp.addEventListener('blur', commitGesture);
    cell.append(lab, inp);
    stageWrap.appendChild(cell);
  });
  taskSec.append(stageWrap);
  container.appendChild(taskSec);

  // ---- Notes ----
  const noteSec = section('Notes');
  const note = document.createElement('textarea');
  note.value = m.note || ''; note.placeholder = 'notes…'; note.rows = 3;
  note.addEventListener('focus', beginGesture);
  note.addEventListener('input', () => { setShotMeta(P, sh, 'note', note.value); onChange(); });
  note.addEventListener('blur', commitGesture);
  noteSec.append(note);
  container.appendChild(noteSec);
}

// ---- helpers ----
function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function iconbtn(glyph, title, extra, fn, disabled) { const b = el('button', 'iconbtn ' + (extra || '')); b.textContent = glyph; b.title = title; b.onclick = fn; b.disabled = !!disabled; return b; }
function section(title) {
  const s = el('div', 'insp-section');
  const h = el('div', 'sec-head'); const t = el('span', 'sec-title'); t.textContent = title; h.appendChild(t);
  s.appendChild(h);
  return s;
}
function field(label, node, hint) {
  const w = el('div', 'field');
  const l = el('div', 'field-label'); l.textContent = label; w.appendChild(l);
  w.appendChild(node);
  if (hint) { const h = el('div', 'field-hint'); h.textContent = hint; w.appendChild(h); }
  return w;
}
// read-only value that becomes an input on click
function editableNumber(getVal, setVal, unitLabel, onChange, disabled) {
  const wrap = el('div', 'editnum');
  const span = el('span', 'editnum-val'); span.textContent = getVal() + ' ' + unitLabel;
  if (!disabled) { span.title = 'click to edit'; span.onclick = () => swap(); } else span.classList.add('disabled');
  wrap.appendChild(span);
  function swap() {
    const inp = document.createElement('input'); inp.type = 'number'; inp.min = '0'; inp.step = unitLabel === 'frames' ? '1' : '0.1';
    inp.value = getVal(); inp.className = 'editnum-input';
    wrap.replaceChild(inp, wrap.firstChild); inp.focus(); inp.select();
    beginGesture();
    const done = () => { const v = parseFloat(inp.value); if (!isNaN(v) && v > 0) { setVal(v); onChange(); } commitGesture(); const s = el('span', 'editnum-val'); s.textContent = getVal() + ' ' + unitLabel; s.title = 'click to edit'; s.onclick = swap; wrap.replaceChild(s, inp); };
    inp.addEventListener('blur', done);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
  }
  return wrap;
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
