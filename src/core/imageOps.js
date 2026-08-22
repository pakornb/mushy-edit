// Image pixel management: downscale (shrink a frame's stored resolution in
// place, to cut work-file size) and replace (swap in new files by filename,
// keeping all timing/pins/annotations/tasks — they're keyed by filename, not
// by pixel content). Both mutate `frame.full`/`frame.url` directly and are
// NOT undo-able: the undo system deliberately never snapshots heavy blobs.
import { loadImage, computeLuma, diffLuma, makeTinyCtx, makeThumb } from './frames.js';

const AR_TOL = 0.03;
function nearRatio(ar, target) { return Math.abs(ar - target) / target < AR_TOL; }

// Friendly presets for one frame's own native size: exact families for square
// and 16:9/9:16, percentage-of-native for anything else.
export function presetsFor(w, h) {
  if (!w || !h) return [];
  const ar = w / h;
  const full = { label: 'Full', w, h };
  if (nearRatio(ar, 1)) {
    return [full, { label: '2K', w: 2048, h: 2048 }, { label: '1K', w: 1024, h: 1024 }, { label: '500px', w: 500, h: 500 }]
      .filter((p) => p.label === 'Full' || p.w < w);
  }
  if (nearRatio(ar, 16 / 9) || nearRatio(ar, 9 / 16)) {
    const portrait = h > w;
    const set = portrait
      ? [{ label: '2K', w: 1152, h: 2048 }, { label: 'HD 1080', w: 1080, h: 1920 }, { label: 'HD 720', w: 720, h: 1280 }, { label: 'HD 540', w: 540, h: 960 }]
      : [{ label: '2K', w: 2048, h: 1152 }, { label: 'HD 1080', w: 1920, h: 1080 }, { label: 'HD 720', w: 1280, h: 720 }, { label: 'HD 540', w: 960, h: 540 }];
    return [full, ...set.filter((p) => p.w < w)];
  }
  return [full,
    { label: '50%', w: Math.round(w * 0.5), h: Math.round(h * 0.5) },
    { label: '25%', w: Math.round(w * 0.25), h: Math.round(h * 0.25) },
    { label: '12.5%', w: Math.round(w * 0.125), h: Math.round(h * 0.125) }];
}

// Presets for a SCOPE of frames. If they all share one native size, the exact
// family above applies; otherwise each frame scales relative to its OWN
// current size, so mixed-resolution selections still make sense.
export function presetsForScope(frames) {
  if (!frames.length) return { mode: 'none', options: [] };
  const [f0] = frames;
  const uniform = frames.every((f) => f.w === f0.w && f.h === f0.h);
  if (uniform) return { mode: 'exact', options: presetsFor(f0.w, f0.h) };
  return {
    mode: 'percent',
    options: [
      { label: 'Full (100%)', pct: 1 }, { label: '50%', pct: 0.5 },
      { label: '25%', pct: 0.25 }, { label: '12.5%', pct: 0.125 },
    ],
  };
}

// Shrink one frame's stored image to targetW×targetH. Never upscales. Returns
// true if it actually changed anything.
export async function downscaleFrame(frame, targetW, targetH) {
  if (!frame.full) return false;
  const url = URL.createObjectURL(frame.full);
  const img = await loadImage(url).catch(() => null);
  URL.revokeObjectURL(url);
  if (!img) return false;
  const w = Math.max(1, Math.round(targetW)), h = Math.max(1, Math.round(targetH));
  if (w >= img.naturalWidth && h >= img.naturalHeight) return false;
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(img, 0, 0, w, h);
  const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
  if (!blob) return false;
  if (frame.url && frame.url.startsWith('blob:')) URL.revokeObjectURL(frame.url);
  frame.full = blob; frame.url = URL.createObjectURL(blob); frame.w = w; frame.h = h;
  return true;
}

// Match each picked file to a frame in `frames` by filename and swap in its
// pixels (new full/url/thumb/luma), keeping the frame's identity (name/key)
// so everything keyed to it stays put. Returns which frames matched and which
// picked filenames had no corresponding frame in scope.
export async function replaceFrames(frames, files) {
  const byName = new Map(frames.map((f) => [f.name, f]));
  const matched = [], unmatched = [];
  const tctx = makeTinyCtx();
  for (const file of files) {
    const target = byName.get(file.name);
    if (!target) { unmatched.push(file.name); continue; }
    const url = URL.createObjectURL(file);
    const img = await loadImage(url).catch(() => null);
    if (!img) { URL.revokeObjectURL(url); unmatched.push(file.name); continue; }
    if (target.url && target.url.startsWith('blob:')) URL.revokeObjectURL(target.url);
    target.full = file; target.url = url; target.thumb = makeThumb(img);
    target.w = img.naturalWidth; target.h = img.naturalHeight;
    target.luma = computeLuma(tctx, img);
    matched.push(target);
  }
  return { matched, unmatched };
}

// Recompute scene-cut diffs for frames whose pixels changed and their
// immediate neighbors (a changed frame alters its relationship to both
// sides). Neighbors opened from an older work file may lack `.luma` — that's
// computed on demand from their current blob.
export async function refreshDiffsAround(p, touchedFis) {
  const tctx = makeTinyCtx();
  const need = new Set();
  touchedFis.forEach((fi) => { need.add(fi); if (fi > 0) need.add(fi - 1); if (fi < p.frames.length - 1) need.add(fi + 1); });
  for (const fi of need) {
    const f = p.frames[fi];
    if (f.luma) continue;
    const url = URL.createObjectURL(f.full);
    const img = await loadImage(url).catch(() => null);
    URL.revokeObjectURL(url);
    if (img) f.luma = computeLuma(tctx, img);
  }
  need.forEach((fi) => { if (fi > 0) p.diffs[fi] = diffLuma(p.frames[fi - 1].luma, p.frames[fi].luma); });
}
