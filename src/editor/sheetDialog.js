// "Export storyboard sheet…" dialog: grid/background/caption settings, a live
// preview of the current page, and per-board caption fields (saved as
// project.boardCaption, keyed by filename). Rendering is src/io/storyboardSheet.js.
import { project as P } from '../core/model.js';
import { beginGesture, commitGesture } from '../core/history.js';
import { modal } from './assets.js';
import { sheetSettings, sheetBoards, paginate, renderPage, imageCache, exportStoryboardSheet, PAGE_SIZES } from '../io/storyboardSheet.js';
import { buildStoryboardPptx } from '../io/storyboardPptx.js';
import { download } from '../io/base64.js';

// onSlides (Hornet build only): called with no args when "Export to Google
// Slides" is clicked, after the settings are saved; main.js does sign-in/upload.
export function openSheetDialog({ toast, onSlides }) {
  const getBmp = imageCache();
  let page = 0, pageSize = '1920x1080', drawSeq = 0;

  modal('Export storyboard sheet', (body) => {
    body.classList.add('sb-sheet');
    const s0 = sheetSettings();
    body.innerHTML = `
      <div class="sb-controls">
        <label>rows <input type="number" id="sbRows" min="1" max="12" value="${s0.rows}"></label>
        <label>columns <input type="number" id="sbCols" min="1" max="12" value="${s0.cols}"></label>
        <label>background <input type="color" id="sbBg" value="${s0.bg}"></label>
        <label>caption lines <input type="number" id="sbLines" min="0" max="6" value="${s0.captionLines}"></label>
        <label title="PNG export only — slides are always 16:9">PNG size <select id="sbSize">${Object.keys(PAGE_SIZES).map((k) => `<option value="${k}">${k.replace('x', '×')}</option>`).join('')}</select></label>
        <label><input type="checkbox" id="sbBorder" ${s0.border ? 'checked' : ''}> panel border</label>
        <label><input type="checkbox" id="sbNumbers" ${s0.numbers ? 'checked' : ''}> numbers</label>
        <label><input type="checkbox" id="sbAnnos" ${s0.annos ? 'checked' : ''}> annotations</label>
        <label title="boards with no caption of their own show their shot's note on the shot's first board"><input type="checkbox" id="sbShotNotes" ${s0.shotNotes ? 'checked' : ''}> use shot notes</label>
      </div>
      <div class="sb-preview"><canvas id="sbCanvas"></canvas></div>
      <div class="sb-pager"><button class="tbtn sm" id="sbPrev">‹</button><span id="sbPageLbl"></span><button class="tbtn sm" id="sbNext">›</button></div>
      <div class="sb-caps-head">Captions <span class="sub">(per board, saved with the project)</span></div>
      <div class="sb-caps" id="sbCaps"></div>
      <div class="sb-actions">
        <button class="btn ghost" id="sbPptx" title="each board as its own picture with an editable text box — PowerPoint, Keynote, or File › Import slides in Google Slides">Download .pptx</button>
        ${onSlides ? '<button class="btn ghost" id="sbSlides" title="creates a new Google Slides deck in your Drive: each board its own picture, with an editable text box under it">Export to Google Slides</button>' : ''}
        <button class="btn" id="sbExport">Export PNG</button>
      </div>`;
    const $ = (id) => body.querySelector('#' + id);
    const num = (id, lo, hi, d) => Math.min(hi, Math.max(lo, Math.round(+$(id).value) || d));

    const read = () => {
      P.sheetLayout = {
        rows: num('sbRows', 1, 12, 3), cols: num('sbCols', 1, 12, 4), bg: $('sbBg').value,
        captionLines: num('sbLines', 0, 6, 2), border: $('sbBorder').checked, numbers: $('sbNumbers').checked,
        annos: $('sbAnnos').checked, shotNotes: $('sbShotNotes').checked,
      };
      pageSize = $('sbSize').value;
    };

    const draw = async () => {
      const seq = ++drawSeq;
      const s = sheetSettings(), pages = paginate(sheetBoards(P, s), s);
      page = Math.min(page, Math.max(0, pages.length - 1));
      $('sbPageLbl').textContent = `page ${page + 1} / ${Math.max(1, pages.length)}`;
      $('sbPrev').disabled = page <= 0; $('sbNext').disabled = page >= pages.length - 1;
      $('sbExport').textContent = pages.length > 1 ? `Export ${pages.length} PNGs (zip)` : 'Export PNG';
      const W = 960, H = 540; // preview at half of 1080p; same layout math as the export
      const cv = await renderPage(pages[page] || [], W, H, s, getBmp);
      if (seq !== drawSeq) return;
      const out = $('sbCanvas'); if (!out) return;
      out.width = W; out.height = H; out.getContext('2d').drawImage(cv, 0, 0);
    };
    let t; const redraw = () => { clearTimeout(t); t = setTimeout(draw, 120); };

    const buildCaps = () => {
      const s = sheetSettings(), list = $('sbCaps'); list.innerHTML = '';
      sheetBoards(P, s).forEach((b) => {
        const f = P.frames[b.fi];
        const row = document.createElement('div'); row.className = 'sb-cap';
        const th = document.createElement('canvas'); th.width = 64; th.height = 36;
        if (f.thumb?.width) th.getContext('2d').drawImage(f.thumb, 0, 0, 64, 36);
        const n = document.createElement('b'); n.textContent = b.num;
        const ta = document.createElement('textarea'); ta.rows = 1;
        ta.value = P.boardCaption.get(f.name) || '';
        ta.placeholder = b.caption && !ta.value ? b.caption : 'caption…';
        ta.title = f.name;
        ta.addEventListener('focus', () => { beginGesture(); page = Math.floor((b.num - 1) / (s.rows * s.cols)); redraw(); });
        ta.addEventListener('input', () => { const v = ta.value.trim() ? ta.value : ''; if (v) P.boardCaption.set(f.name, v); else P.boardCaption.delete(f.name); redraw(); });
        ta.addEventListener('blur', commitGesture);
        row.append(th, n, ta); list.appendChild(row);
      });
    };

    body.querySelectorAll('.sb-controls input, .sb-controls select').forEach((inp) => inp.addEventListener('input', () => {
      read(); redraw(); if (inp.id === 'sbShotNotes') buildCaps();
    }));
    $('sbPrev').onclick = () => { page--; draw(); };
    $('sbNext').onclick = () => { page++; draw(); };
    // progress shows on the button itself — the app's busy overlay sits under modals
    const busy = async (btn, label, fn) => {
      read();
      const all = body.querySelectorAll('.sb-actions .btn'); all.forEach((b) => { b.disabled = true; });
      const was = btn.textContent; btn.textContent = label;
      try { await fn((m) => { btn.textContent = m; }); }
      catch (e) { console.error(e); toast(e.message || 'Storyboard export failed'); }
      finally { all.forEach((b) => { b.disabled = false; }); btn.textContent = was; draw(); }
    };
    $('sbExport').onclick = () => busy($('sbExport'), 'Rendering…', async (progress) => {
      const n = await exportStoryboardSheet({ pageSize, onProgress: progress });
      toast(n > 1 ? `${n} storyboard pages exported (zip)` : 'Storyboard sheet exported');
    });
    $('sbPptx').onclick = () => busy($('sbPptx'), 'Building…', async (progress) => {
      const r = await buildStoryboardPptx({ onProgress: progress });
      download(r.blob, `${P.baseName}_storyboard.pptx`);
      toast(`${r.slides} slide${r.slides > 1 ? 's' : ''} exported (.pptx)`);
    });
    if (onSlides) $('sbSlides').onclick = () => { read(); onSlides(); };

    buildCaps();
    document.fonts?.ready.then(draw) || draw();
  }, true);
}
