import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { project as P, timeline, getAnnos, getBoardFit, fitRect } from '../core/model.js';
import { drawAnnos } from '../core/annotate.js';

const ST = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
let ff = null;

async function ensureFF() {
  if (ff) return ff;
  const inst = new FFmpeg();
  await inst.load({
    coreURL: await toBlobURL(`${ST}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${ST}/ffmpeg-core.wasm`, 'application/wasm'),
  });
  ff = inst; return ff;
}

function evenN(n) { n = Math.round(n); return n % 2 ? n + 1 : n; }

// Builds ffmpeg's -af filter chain for master gain + fade in/out.
// afade's `st` is relative to what the filter actually sees: for the -ss
// trimmed case (negative offsetSec) the stream's own internal clock already
// starts at 0 there, matching output time 1:1, so a fade-in always starts at
// st=0 (the first sample that plays). Fade-out is anchored to the VIDEO
// timeline's own end (`videoTotal`, i.e. the actual exported duration), not
// the raw audio file's length — translated back into the filtered stream's
// own time by subtracting any +itsoffset shift (the -ss case needs none,
// since that stream's clock already matches output time). Anchoring to the
// file's own (possibly much longer, e.g. a full music track) duration meant
// the fade-out point could sit past anything that ever actually gets
// rendered, so it never fired.
function audioFilterChain(a, videoTotal) {
  const parts = [];
  const gain = a.gain ?? 1;
  if (Math.abs(gain - 1) > 1e-3) parts.push(`volume=${gain.toFixed(3)}`);
  const fps = P.fps || 24;
  const fadeInSec = (a.fadeInFrames || 0) / fps;
  const fadeOutSec = (a.fadeOutFrames || 0) / fps;
  // curve=hsin (half-sine) is ffmpeg's closest built-in match to the
  // smoothstep S-curve used everywhere else here (editor + viewer) — the
  // default curve=tri is a plain linear ramp, which has an abrupt slope
  // change right at the fade boundary.
  if (fadeInSec > 0) parts.push(`afade=t=in:st=0:d=${fadeInSec.toFixed(3)}:curve=hsin`);
  if (fadeOutSec > 0) {
    const stEnd = videoTotal - Math.max(0, a.offsetSec || 0);
    const st = Math.max(0, stEnd - fadeOutSec);
    parts.push(`afade=t=out:st=${st.toFixed(3)}:d=${fadeOutSec.toFixed(3)}:curve=hsin`);
  }
  return parts.join(',');
}

async function renderFrame(fi, W, H, burn) {
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  let bmp;
  try { bmp = await createImageBitmap(P.frames[fi].full); }
  catch { bmp = await createImageBitmap(await (await fetch(P.frames[fi].url)).blob()); }
  const r = fitRect(getBoardFit(P, fi), bmp.width, bmp.height, W, H);
  ctx.drawImage(bmp, r.dx, r.dy, r.dw, r.dh);
  bmp.close && bmp.close();
  if (burn) { const a = getAnnos(P, fi); if (a.length) drawAnnos(ctx, a, { x: r.dx, y: r.dy, w: r.dw, h: r.dh }); }
  return await new Promise((res) => cv.toBlob((b) => res(b), 'image/jpeg', 0.9));
}

export async function exportMp4({ burnAnnotations = false, maxW = 0, onProgress = () => {} } = {}) {
  const { boards, total } = timeline(P);
  if (!boards.length) throw new Error('Nothing to export.');
  let W = P.resW || 1920, H = P.resH || 1080;
  if (maxW && W > maxW) { H = Math.round(H * maxW / W); W = maxW; }
  W = evenN(W); H = evenN(H);
  const fps = P.fps || 24;

  onProgress('Loading encoder…', 0.02);
  const f = await ensureFF();

  onProgress('Rendering frames…', 0.05);
  let list = 'ffconcat version 1.0\n';
  for (let i = 0; i < boards.length; i++) {
    const bd = boards[i];
    const blob = await renderFrame(bd.fi, W, H, burnAnnotations);
    const name = `f${String(i).padStart(4, '0')}.jpg`;
    await f.writeFile(name, await fetchFile(blob));
    list += `file '${name}'\nduration ${bd.len.toFixed(4)}\n`;
    if (i === boards.length - 1) list += `file '${name}'\n`;
    onProgress('Rendering frames…', 0.05 + 0.5 * ((i + 1) / boards.length));
  }
  await f.writeFile('list.txt', list);

  const args = ['-f', 'concat', '-safe', '0', '-i', 'list.txt'];
  const a = P.audio;
  let hasAudio = false, audioName = '';
  if (a && a.blob) {
    audioName = 'audio_in' + (/\.\w+$/.exec(a.name)?.[0] || '.wav');
    await f.writeFile(audioName, await fetchFile(a.blob));
    const off = a.offsetSec || 0;
    const trimmedStart = off < 0 ? -off : 0; // -ss above cuts this much off the front
    if (off >= 0) args.push('-itsoffset', off.toFixed(3), '-i', audioName);
    else args.push('-ss', trimmedStart.toFixed(3), '-i', audioName);
    hasAudio = true;
  }
  args.push('-map', '0:v');
  if (hasAudio) {
    args.push('-map', '1:a', '-c:a', 'aac', '-b:a', '192k');
    const af = audioFilterChain(a, total);
    if (af) args.push('-af', af);
  }
  args.push('-r', String(fps), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-movflags', '+faststart', '-t', total.toFixed(3), 'out.mp4');

  f.on('progress', ({ progress }) => { if (progress >= 0 && progress <= 1) onProgress('Encoding…', 0.55 + 0.42 * progress); });
  onProgress('Encoding…', 0.56);
  await f.exec(args);

  const data = await f.readFile('out.mp4');
  onProgress('Finishing…', 0.99);
  for (let i = 0; i < boards.length; i++) { try { await f.deleteFile(`f${String(i).padStart(4, '0')}.jpg`); } catch {} }
  try { await f.deleteFile('list.txt'); } catch {}
  if (hasAudio) { try { await f.deleteFile(audioName); } catch {} }
  try { await f.deleteFile('out.mp4'); } catch {}

  const blob = new Blob([data.buffer], { type: 'video/mp4' });
  const url = URL.createObjectURL(blob);
  const el = document.createElement('a'); el.href = url; el.download = `${P.baseName}${maxW ? '_draft' : ''}.mp4`; el.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  onProgress('Done', 1);
  return { W, H, total };
}
