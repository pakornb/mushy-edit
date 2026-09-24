// CMX3600 EDL export, zipped together with the source frame images and audio
// (if any) so the whole package is self-contained and relinkable — unlike the
// FCPXML/EDL text alone (which only reference bare filenames), this bundles
// the actual files right next to it.
import JSZip from 'jszip';
import { project as P, fmtTC } from '../core/model.js';
import { frameCounts } from './nle.js';
import { download } from './base64.js';

function pad3(n) { return String(n).padStart(3, '0'); }

// One still-image "clip" per board: source is 00:00:00:00 → its own duration
// (there's no real source tape/timecode for an in-memory image), record is
// its position in the overall cut. `* FROM CLIP NAME:` is the standard CMX3600
// way to carry the actual filename through since the 8-char reel field can't.
export function buildEdl(p = P) {
  const fps = Math.max(1, Math.round(p.fps));
  const clips = frameCounts(p);
  const lines = [`TITLE: ${p.baseName}`, 'FCM: NON-DROP FRAME', ''];
  let ev = 1;
  clips.forEach((c) => {
    const name = p.frames[c.fi].name;
    const srcOut = fmtTC(c.frames, fps);
    const recIn = fmtTC(c.startFrame, fps);
    const recOut = fmtTC(c.startFrame + c.frames, fps);
    lines.push(`${pad3(ev)}  AX       V     C        00:00:00:00 ${srcOut} ${recIn} ${recOut}`);
    lines.push(`* FROM CLIP NAME: ${name}`);
    lines.push('');
    ev++;
  });
  const a = p.audio;
  if (a) {
    const off = a.offsetSec || 0;
    const dur = a.duration || 0;
    const playStart = Math.max(0, off);
    const playEnd = Math.max(playStart, off + dur);
    const recIn = fmtTC(Math.round(playStart * fps), fps);
    const recOut = fmtTC(Math.round(playEnd * fps), fps);
    const srcIn = fmtTC(Math.round(Math.max(0, -off) * fps), fps);
    const srcOut = fmtTC(Math.round((Math.max(0, -off) + (playEnd - playStart)) * fps), fps);
    lines.push(`${pad3(ev)}  AX       A     C        ${srcIn} ${srcOut} ${recIn} ${recOut}`);
    lines.push(`* FROM CLIP NAME: ${a.name}`);
    lines.push('');
  }
  return lines.join('\n');
}

// Bundles the EDL text with every enabled board's full-res source image (kept
// under their original filenames, matching the EDL's "FROM CLIP NAME" comments
// so an editor can relink) and the audio file, if any.
export async function exportEdlZip(onProgress = () => {}) {
  if (!P.frames.length) return;
  onProgress('Building EDL…');
  const edl = buildEdl(P);
  const zip = new JSZip();
  zip.file(`${P.baseName}.edl`, edl);

  const clips = frameCounts(P);
  const folder = zip.folder('frames');
  for (let i = 0; i < clips.length; i++) {
    const f = P.frames[clips[i].fi];
    if (f.full) folder.file(f.name, f.full);
    onProgress(`Adding frames… ${i + 1}/${clips.length}`);
  }
  if (P.audio && P.audio.blob) zip.file(P.audio.name, P.audio.blob);

  onProgress('Zipping…');
  const blob = await zip.generateAsync({ type: 'blob' }, (meta) => onProgress(`Zipping… ${Math.round(meta.percent)}%`));
  download(blob, `${P.baseName}_edl.zip`);
}
