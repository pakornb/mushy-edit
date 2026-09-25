// Google Sheets export: sign in, pick (or create) a Sheet in the user's own
// Drive, upload each row's thumbnail to Drive, then write the whole
// breakdown tab in one Sheets API batchUpdate. No Apps Script anywhere.
//
// Images: the Sheets API can't upload image bytes into a sheet — the only
// way to show a picture is an =IMAGE(url) formula whose URL Google's servers
// can fetch without logging in. So each thumbnail is uploaded to a "Mushy
// Edit thumbnails" folder in the user's Drive and shared "anyone with the
// link" (random, unlisted URLs). Uploads run in parallel, which is what keeps
// this fast; the old Apps Script path had to insertImage() one row at a time.
//
// Sign-in happens in a separate helper window (public/google-connect.html)
// because the editor's Cross-Origin-Opener-Policy header (needed by
// ffmpeg.wasm) cuts the link to Google's sign-in popup. openConnect() must be
// called synchronously inside a click handler so window.open isn't blocked.
//
// Scope is drive.file only: access to Sheets the user picks/creates here and
// files this app uploads — nothing else in their Drive.

const CLIENT_ID = '902841680403-3ua13oavs9ic6m4i1e6si7hl2b0q3qup.apps.googleusercontent.com';
// Browser key, restricted in GCP to the Picker API and to this app's origins.
// Public by design; the restrictions are what protect it.
const PICKER_API_KEY = 'AIzaSyByi5yGULbZ3e61C_CLjuXEhckkCYhKoLA';
const APP_ID = '902841680403'; // GCP project number; Picker uses it to grant drive.file access
const CHANNEL = 'mushy-google';
const THUMB_FOLDER = 'Mushy Edit thumbnails';
const UPLOAD_CONCURRENCY = 6;

export const MONTAGE_W = 300; // px width of a shot's Storyboard picture in the sheet
export const REF_W = 320;     // px width of an asset's Reference picture
const PAD = 8;

const imageUrl = (fileId) => `https://lh3.googleusercontent.com/d/${fileId}`;
const fileIdFromFormula = (f) => { const m = /googleusercontent\.com\/d\/([\w-]+)/.exec(String(f || '')); return m ? m[1] : null; };

// ---------- auth ----------
let token = null, tokenExp = 0;
export function hasToken() { return !!token && Date.now() < tokenExp - 60000; }

/**
 * Opens the helper window and resolves with what the user chose:
 * { spreadsheetId, spreadsheetName } for an existing Sheet, { create: true }
 * for a new one, or just a token when mode is 'signin'. Rejects with
 * message 'Cancelled.' if the window is closed without choosing.
 */
export function openConnect({ mode = 'choose', current = null } = {}) {
  const rid = Math.random().toString(36).slice(2);
  const q = new URLSearchParams({ rid, mode, client: CLIENT_ID, key: PICKER_API_KEY, app: APP_ID });
  if (current && current.id) { q.set('cur', current.id); if (current.name) q.set('curName', current.name); }
  const w = window.open(`/google-connect.html?${q}`, 'mushyGoogleConnect', 'width=480,height=560');
  if (!w) return Promise.reject(new Error('Popup blocked — allow popups for this site and try again.'));
  return new Promise((resolve, reject) => {
    const bc = new BroadcastChannel(CHANNEL);
    const finish = (fn, v) => { clearTimeout(timer); bc.close(); fn(v); };
    const timer = setTimeout(() => finish(reject, new Error('Timed out waiting for Google.')), 10 * 60 * 1000);
    bc.onmessage = (e) => {
      const m = e.data || {};
      if (m.rid !== rid) return;
      if (m.type === 'cancel') return finish(reject, new Error('Cancelled.'));
      if (m.type === 'result') {
        token = m.token;
        tokenExp = Date.now() + (m.expiresIn || 3600) * 1000;
        finish(resolve, m);
      }
    };
  });
}

async function api(url, { method = 'GET', json, body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: json ? JSON.stringify(json) : body,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) token = null;
    throw new Error((data && data.error && data.error.message) || `Google API error (HTTP ${res.status})`);
  }
  return data;
}

// ---------- Drive thumbnails ----------
async function thumbFolder() {
  const q = encodeURIComponent(`name='${THUMB_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const found = await api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&pageSize=1`);
  if (found.files && found.files.length) return found.files[0].id;
  const made = await api('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST', json: { name: THUMB_FOLDER, mimeType: 'application/vnd.google-apps.folder' },
  });
  return made.id;
}

async function uploadThumb(dataUrl, name, folderId) {
  const blob = await (await fetch(dataUrl)).blob();
  const boundary = 'mushy' + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name, parents: [folderId] });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
    `--${boundary}\r\nContent-Type: ${blob.type || 'image/jpeg'}\r\n\r\n`, blob, `\r\n--${boundary}--`,
  ]);
  const file = await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST', body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
  });
  await api(`https://www.googleapis.com/drive/v3/files/${file.id}/permissions?fields=id`, {
    method: 'POST', json: { role: 'reader', type: 'anyone' },
  });
  return file.id;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// jobs: [{ dataUrl, name } | null] -> [fileId | null], in parallel
async function uploadThumbs(jobs, onStatus) {
  const real = jobs.filter(Boolean).length;
  if (!real) return jobs.map(() => null);
  const folder = await thumbFolder();
  let done = 0;
  return pool(jobs, UPLOAD_CONCURRENCY, async (j) => {
    if (!j) return null;
    const id = await uploadThumb(j.dataUrl, j.name, folder);
    onStatus && onStatus(`Uploading thumbnails… ${++done}/${real}`);
    return id;
  });
}

async function trashFiles(ids) {
  await pool(ids, UPLOAD_CONCURRENCY, (id) =>
    api(`https://www.googleapis.com/drive/v3/files/${id}`, { method: 'DELETE' }).catch(() => null));
}

// ---------- Sheets cell helpers ----------
const rgb = (hex) => ({ red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 });
const HEADER_FMT = { backgroundColor: rgb('#22262f'), textFormat: { bold: true, foregroundColor: rgb('#e6e8ec') }, verticalAlignment: 'MIDDLE' };
const image = (fileId, w, h) => ({ formula: `=IMAGE("${imageUrl(fileId)}", 4, ${h}, ${w})` });
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

function cell(v, fmt = {}) {
  const f = { verticalAlignment: 'MIDDLE', ...fmt };
  if (v && typeof v === 'object' && v.formula) return { userEnteredValue: { formulaValue: v.formula }, userEnteredFormat: f };
  if (v === '' || v == null) return { userEnteredFormat: f };
  if (typeof v === 'number') return { userEnteredValue: { numberValue: v }, userEnteredFormat: f };
  return { userEnteredValue: { stringValue: String(v) }, userEnteredFormat: f };
}
const setCell = (sheetId, r, c, data, fields = 'userEnteredValue,userEnteredFormat') =>
  ({ updateCells: { start: { sheetId, rowIndex: r, columnIndex: c }, rows: [{ values: [data] }], fields } });
const colWidth = (sheetId, c, px) =>
  ({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: c, endIndex: c + 1 }, properties: { pixelSize: px }, fields: 'pixelSize' } });
const rowHeight = (sheetId, r, px) =>
  ({ updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: r, endIndex: r + 1 }, properties: { pixelSize: px }, fields: 'pixelSize' } });

const newSheetId = () => Math.floor(Math.random() * 2e9) + 1;
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.toLocaleString('en-US', { month: 'short' })}-${d.getDate()} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}
const scaledH = (w, tw, th) => Math.max(1, Math.round(w * (th || 88) / (tw || 152)));
const shotStages = (data) => (data.shotTasks && data.shotTasks.length ? data.shotTasks : ['previs', 'anim', 'light', 'comp']);

function orderedAssets(data) {
  const assets = data.assets || [];
  const cats = data.assetCats && data.assetCats.length ? data.assetCats : [...new Set(assets.map((a) => a.cat).filter(Boolean))];
  const out = [];
  cats.forEach((cat) => assets.filter((a) => a.cat === cat).forEach((a, i) => out.push({ a, catLabel: i === 0 ? cap(cat) : '' })));
  return out;
}

// ---------- build a new breakdown tab ----------
/**
 * data: buildBreakdownData(true) output (per-row thumbnails as data URLs).
 * spreadsheetId: target Sheet, or null to create one titled createTitle.
 * Returns { spreadsheetId, sheetId, url, shots, assets }.
 */
export async function buildBreakdownSheet({ spreadsheetId, createTitle, data, baseName, onStatus }) {
  let defaultSheetId = null;
  if (!spreadsheetId) {
    onStatus && onStatus('Creating Google Sheet…');
    const made = await api('https://sheets.googleapis.com/v4/spreadsheets?fields=spreadsheetId,sheets.properties.sheetId', {
      method: 'POST', json: { properties: { title: createTitle } },
    });
    spreadsheetId = made.spreadsheetId;
    defaultSheetId = made.sheets && made.sheets[0] ? made.sheets[0].properties.sheetId : null;
  }

  const shots = data.shots || [];
  const assets = orderedAssets(data);
  const safe = (baseName || 'breakdown').replace(/[^\w.-]+/g, '_');
  const ids = await uploadThumbs([
    ...shots.map((s) => (s.thumbnail ? { dataUrl: s.thumbnail, name: `${safe}_shot${s.id}.jpg` } : null)),
    ...assets.map(({ a }, i) => (a.thumbnail ? { dataUrl: a.thumbnail, name: `${safe}_asset${i + 1}.jpg` } : null)),
  ], onStatus);
  const shotIds = ids.slice(0, shots.length), assetIds = ids.slice(shots.length);

  onStatus && onStatus('Writing sheet…');
  const requests = [];
  const when = stamp();

  // Shots tab
  const sheetId = newSheetId();
  const stages = shotStages(data);
  const headers = ['Shot', 'Storyboard', 'Name', `Length (${data.lenUnit === 'frames' ? 'f' : 's'})`, ...stages.map(cap), 'Notes'];
  const firstStage = 4, notesCol = firstStage + stages.length;
  const center = { horizontalAlignment: 'CENTER' }, wrap = { wrapStrategy: 'WRAP' };
  const rows = shots.map((s, i) => {
    const h = scaledH(MONTAGE_W, s.thumbW, s.thumbH);
    const tv = s.taskVals || {};
    return {
      h,
      values: [
        cell(s.id), cell(shotIds[i] ? image(shotIds[i], MONTAGE_W, h) : ''), cell(s.tag || s.name || '', wrap),
        cell(s.length ?? '', center), ...stages.map((t) => cell(tv[t] ?? '', center)), cell(s.note || '', wrap),
      ],
    };
  });
  requests.push({ addSheet: { properties: { sheetId, title: `Breakdown ${when}`, index: 0,
    gridProperties: { rowCount: Math.max(2, rows.length + 1), columnCount: headers.length, frozenRowCount: 1 } } } });
  requests.push({ updateCells: { start: { sheetId, rowIndex: 0, columnIndex: 0 }, fields: 'userEnteredValue,userEnteredFormat',
    rows: [{ values: headers.map((t) => cell(t, HEADER_FMT)) }, ...rows.map((r) => ({ values: r.values }))] } });
  [[1, MONTAGE_W + PAD], [2, 160], [3, 72], ...stages.map((_, k) => [firstStage + k, 64]), [notesCol, 300]]
    .forEach(([c, px]) => requests.push(colWidth(sheetId, c, px)));
  rows.forEach((r, i) => requests.push(rowHeight(sheetId, i + 1, r.h + PAD)));

  // Assets tab
  if (assets.length) {
    const aId = newSheetId();
    const tasks = data.assetTasks && data.assetTasks.length ? data.assetTasks : ['model', 'lookdev', 'rig'];
    const aHeaders = ['Category', 'Reference', 'Asset', ...tasks.map(cap)];
    const aRows = assets.map(({ a, catLabel }, i) => {
      const h = scaledH(REF_W, a.thumbW, a.thumbH);
      const tv = a.tasks || {};
      return { h, has: !!assetIds[i], values: [cell(catLabel), cell(assetIds[i] ? image(assetIds[i], REF_W, h) : ''), cell(a.name || ''), ...tasks.map((t) => cell(tv[t] ?? '', center))] };
    });
    requests.push({ addSheet: { properties: { sheetId: aId, title: `Assets ${when}`, index: 1,
      gridProperties: { rowCount: Math.max(2, aRows.length + 1), columnCount: aHeaders.length, frozenRowCount: 1 } } } });
    requests.push({ updateCells: { start: { sheetId: aId, rowIndex: 0, columnIndex: 0 }, fields: 'userEnteredValue,userEnteredFormat',
      rows: [{ values: aHeaders.map((t) => cell(t, HEADER_FMT)) }, ...aRows.map((r) => ({ values: r.values }))] } });
    [[0, 110], [1, REF_W + PAD], [2, 170], ...tasks.map((_, k) => [3 + k, 72])].forEach(([c, px]) => requests.push(colWidth(aId, c, px)));
    aRows.forEach((r, i) => { if (r.has) requests.push(rowHeight(aId, i + 1, r.h + PAD)); });
  }

  // A freshly created spreadsheet comes with an empty "Sheet1" — drop it.
  if (defaultSheetId != null) requests.push({ deleteSheet: { sheetId: defaultSheetId } });

  await api(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, { method: 'POST', json: { requests } });
  return {
    spreadsheetId, sheetId, shots: shots.length, assets: assets.length,
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetId}`,
  };
}

// ---------- update an existing breakdown tab in place ----------
/**
 * Same rules as the original Apps Script "Update active sheet": rows are
 * matched by the Name column; matched rows only get a fresh picture and
 * Length (Shot/Notes/stage values the user typed are never touched); new
 * shots are appended; rows whose shot vanished are flagged red with a
 * "[not in latest]" note prefix and keep their last picture. Replaced
 * thumbnails are deleted from Drive afterwards.
 */
export async function updateBreakdownSheet({ spreadsheetId, sheetId, data, baseName, onStatus }) {
  onStatus && onStatus('Reading sheet…');
  const meta = await api(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`);
  const props = (meta.sheets || []).map((s) => s.properties).find((p) => p.sheetId === sheetId);
  if (!props) throw new Error('The breakdown tab this project exported to no longer exists — use "Export to Google Sheet…" instead.');
  const range = encodeURIComponent(`'${props.title.replace(/'/g, "''")}'`);
  const got = await api(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=FORMULA`);
  const grid = got.values || [];
  const headers = (grid[0] || []).map(String);
  const storyC = headers.indexOf('Storyboard'), nameC = headers.indexOf('Name');
  const shotC = headers.indexOf('Shot'), notesC = headers.indexOf('Notes');
  const lenC = headers.findIndex((h) => h.startsWith('Length'));
  if (storyC < 0 || nameC < 0) throw new Error('That tab doesn’t look like a breakdown (no Storyboard / Name columns).');

  const nameToRow = new Map();
  for (let r = 1; r < grid.length; r++) {
    const nm = String((grid[r] || [])[nameC] ?? '');
    if (nm && !nameToRow.has(nm)) nameToRow.set(nm, r);
  }

  const shots = data.shots || [];
  const plan = shots.map((s) => {
    const key = String(s.tag || s.name || '');
    return { s, key, row: key && nameToRow.has(key) ? nameToRow.get(key) : null };
  });
  const safe = (baseName || 'breakdown').replace(/[^\w.-]+/g, '_');
  const ids = await uploadThumbs(plan.map(({ s }) => (s.thumbnail ? { dataUrl: s.thumbnail, name: `${safe}_shot${s.id}.jpg` } : null)), onStatus);

  onStatus && onStatus('Updating sheet…');
  const requests = [];
  const replaced = [];
  const seen = new Set();
  let appendAt = Math.max(grid.length, 1), updated = 0, added = 0, removed = 0;
  const newCount = plan.filter((p) => p.row == null).length;
  const need = appendAt + newCount - props.gridProperties.rowCount;
  if (need > 0) requests.push({ appendDimension: { sheetId, dimension: 'ROWS', length: need } });

  plan.forEach(({ s, key, row }, i) => {
    const h = scaledH(MONTAGE_W, s.thumbW, s.thumbH);
    const pic = ids[i] ? cell(image(ids[i], MONTAGE_W, h)) : null;
    if (row != null) {
      seen.add(key);
      const old = fileIdFromFormula((grid[row] || [])[storyC]);
      if (pic) { requests.push(setCell(sheetId, row, storyC, pic)); if (old) replaced.push(old); }
      if (lenC >= 0 && s.length != null) requests.push(setCell(sheetId, row, lenC, cell(s.length, { horizontalAlignment: 'CENTER' })));
      requests.push(rowHeight(sheetId, row, h + PAD));
      updated++;
    } else {
      const r = appendAt++;
      if (shotC >= 0) requests.push(setCell(sheetId, r, shotC, cell(s.id)));
      if (pic) requests.push(setCell(sheetId, r, storyC, pic));
      requests.push(setCell(sheetId, r, nameC, cell(key, { wrapStrategy: 'WRAP' })));
      if (lenC >= 0 && s.length != null) requests.push(setCell(sheetId, r, lenC, cell(s.length, { horizontalAlignment: 'CENTER' })));
      if (notesC >= 0) requests.push(setCell(sheetId, r, notesC, cell(s.note || '', { wrapStrategy: 'WRAP' })));
      requests.push(rowHeight(sheetId, r, h + PAD));
      if (key) seen.add(key);
      added++;
    }
  });

  nameToRow.forEach((r, nm) => {
    if (seen.has(nm)) return;
    requests.push({ repeatCell: {
      range: { sheetId, startRowIndex: r, endRowIndex: r + 1, startColumnIndex: 0, endColumnIndex: Math.max(headers.length, 1) },
      cell: { userEnteredFormat: { backgroundColor: rgb('#fde8e8') } }, fields: 'userEnteredFormat.backgroundColor' } });
    if (notesC >= 0) {
      const curNote = String((grid[r] || [])[notesC] ?? '');
      if (!curNote.includes('[not in latest]')) {
        requests.push(setCell(sheetId, r, notesC, { userEnteredValue: { stringValue: `[not in latest] ${curNote}`.trim() } }, 'userEnteredValue'));
      }
    }
    removed++;
  });

  if (requests.length) {
    await api(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, { method: 'POST', json: { requests } });
  }
  if (replaced.length) await trashFiles(replaced);
  return {
    spreadsheetId, sheetId, updated, added, removed,
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetId}`,
  };
}
