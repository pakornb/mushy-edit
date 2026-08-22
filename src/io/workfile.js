import { project as P, computeShots } from '../core/model.js';
import { blobToBase64, base64ToBlob, download } from './base64.js';
import { loadImage, makeThumb } from '../core/frames.js';

// Serialize the whole editable project (full-res boards + audio + all state).
export async function saveWorkFile(onProgress) {
  const frames = [];
  for (let i = 0; i < P.frames.length; i++) {
    const f = P.frames[i];
    const type = f.full?.type || 'image/png';
    frames.push({ index: f.index, name: f.name, type, data: await blobToBase64(f.full) });
    if (onProgress && i % 3 === 0) onProgress(i + 1, P.frames.length, 'saving');
  }
  let audio = null;
  if (P.audio && P.audio.blob) {
    audio = {
      name: P.audio.name,
      type: P.audio.blob.type || 'audio/mpeg',
      offsetSec: P.audio.offsetSec || 0,
      inSec: P.audio.inSec ?? null,
      outSec: P.audio.outSec ?? null,
      data: await blobToBase64(P.audio.blob),
    };
  }
  const doc = {
    app: 'animatic-work', version: 1,
    savedAt: new Date().toISOString(),
    baseName: P.baseName, resW: P.resW, resH: P.resH,
    fps: P.fps, threshold: P.threshold, groupMode: P.groupMode,
    hasNamePattern: P.hasNamePattern, lenUnit: P.lenUnit, spotSeconds: P.spotSeconds,
    falloffReach: P.falloffReach, falloffCurve: P.falloffCurve, lastRebalanceSpot: P.lastRebalanceSpot,
    shotTasks: P.shotTasks, assetTasks: P.assetTasks, assetCats: P.assetCats, assets: P.assets,
    frameKeys: P.frameKeys,
    diffs: P.diffs.map((d) => Math.round(d * 100) / 100),
    manualAdd: [...P.manualAdd], manualRemove: [...P.manualRemove],
    meta: [...P.meta.entries()],
    boardDur: [...P.boardDur.entries()],
    boardDisabled: [...P.boardDisabled],
    shotDisabled: [...P.shotDisabled],
    pinned: [...P.pinned], annos: [...P.annos.entries()],
    fitMode: P.fitMode, boardFit: [...P.boardFit.entries()],
    audio,
    frames,
  };
  const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' });
  download(blob, `${P.baseName}_work.animatic.json`);
}

// Restore a project from a work file, rebuilding thumbnails from the full-res data.
export async function openWorkFile(file, onProgress) {
  const doc = JSON.parse(await file.text());
  if (doc.app !== 'animatic-work') throw new Error('Not an Animatic work file.');

  // wipe current session
  P.frames.forEach((f) => f.url && f.url.startsWith('blob:') && URL.revokeObjectURL(f.url));
  if (P.audio?.url) URL.revokeObjectURL(P.audio.url);

  P.baseName = doc.baseName || 'sequence';
  P.resW = doc.resW || 1920; P.resH = doc.resH || 1080;
  P.fps = doc.fps || 24;
  P.threshold = doc.threshold ?? 14;
  P.groupMode = doc.groupMode || 'cuts';
  P.hasNamePattern = !!doc.hasNamePattern;
  P.lenUnit = doc.lenUnit || 'sec';
  P.spotSeconds = doc.spotSeconds || 30;
  P.falloffReach = doc.falloffReach || 3;
  P.falloffCurve = doc.falloffCurve || 'smooth';
  P.lastRebalanceSpot = doc.lastRebalanceSpot ?? P.spotSeconds;
  P.shotTasks = doc.shotTasks || doc.stages || ['previs', 'anim', 'light', 'comp'];
  P.assetTasks = doc.assetTasks || ['model', 'lookdev', 'rig'];
  P.assetCats = doc.assetCats || ['character', 'set', 'prop'];
  P.assets = doc.assets || [];
  P.frameKeys = doc.frameKeys || [];
  P.diffs = doc.diffs || [];
  P.manualAdd = new Set(doc.manualAdd || []);
  P.manualRemove = new Set(doc.manualRemove || []);
  P.meta = new Map(doc.meta || []);
  P.boardDur = new Map(doc.boardDur || []);
  P.boardDisabled = new Set(doc.boardDisabled || []);
  P.shotDisabled = new Set(doc.shotDisabled || []);
  P.pinned = new Set(doc.pinned || []);
  P.annos = new Map(doc.annos || []);
  P.fitMode = doc.fitMode || 'cover'; P.boardFit = new Map(doc.boardFit || []);
  P.source = 'workfile';

  P.audio = null;
  if (doc.audio) {
    const blob = base64ToBlob(doc.audio.data, doc.audio.type);
    P.audio = {
      name: doc.audio.name, blob, url: URL.createObjectURL(blob),
      offsetSec: doc.audio.offsetSec || 0,
      inSec: doc.audio.inSec ?? null, outSec: doc.audio.outSec ?? null,
    };
  }

  P.frames = [];
  const list = doc.frames || [];
  for (let i = 0; i < list.length; i++) {
    const fr = list[i];
    const blob = base64ToBlob(fr.data, fr.type || 'image/png');
    const url = URL.createObjectURL(blob);
    const img = await loadImage(url).catch(() => null);
    const thumb = img ? makeThumb(img) : document.createElement('canvas');
    P.frames.push({ index: fr.index ?? i, name: fr.name, url, thumb, full: blob, w: img?.naturalWidth || 0, h: img?.naturalHeight || 0 });
    if (onProgress && i % 3 === 0) onProgress(i + 1, list.length, 'opening');
  }

  computeShots(P);
  return P;
}
