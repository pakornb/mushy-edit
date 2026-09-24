import { project as P, timeline, getAnnos, getBoardFit } from '../core/model.js';

function thumbURL(fi) { const t = P.frames[fi].thumb; return t.toDataURL ? t.toDataURL('image/jpeg', 0.8) : null; }
function blobToDataURL(blob) { return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); }); }

export async function buildViewerData() {
  const { boards, total } = timeline(P);
  const list = boards.map((bd) => ({
    thumb: thumbURL(bd.fi), dur: bd.len, name: P.frames[bd.fi].name,
    shot: bd.shotIndex, annos: getAnnos(P, bd.fi), fit: getBoardFit(P, bd.fi),
  }));
  let audio = null;
  if (P.audio && P.audio.blob) {
    audio = {
      name: P.audio.name, offsetSec: P.audio.offsetSec || 0,
      gain: P.audio.gain ?? 1, fadeInFrames: P.audio.fadeInFrames || 0, fadeOutFrames: P.audio.fadeOutFrames || 0,
      duration: P.audio.duration || 0,
      dataURL: await blobToDataURL(P.audio.blob),
    };
  }
  return {
    kind: 'animatic-view', version: 1, baseName: P.baseName,
    fps: P.fps, resW: P.resW, resH: P.resH, spotSeconds: P.spotSeconds,
    total, boards: list, audio,
  };
}

export async function exportViewer(onProgress = () => {}) {
  onProgress('Building viewer…');
  const data = await buildViewerData();
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `${P.baseName}_view.animatic.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}
