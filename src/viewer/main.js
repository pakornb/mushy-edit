import '../style.css';
import { drawAnnos } from '../core/annotate.js';

const $ = (id) => document.getElementById(id);
let V = null;          // viewer data
let imgs = [];         // preloaded Image per board
let starts = [];       // cumulative start seconds
let audioEl = null;
let playing = false, t = 0, raf = 0, lastTs = 0;
let showAnno = true;

function fmt(sec) { const cs = Math.max(0, Math.round(sec * 100)); const c = cs % 100, w = Math.floor(cs / 100); const m = Math.floor(w / 60), s = w % 60; return `${m}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`; }

async function load(data) {
  V = data;
  starts = []; let acc = 0;
  V.boards.forEach((b) => { starts.push(acc); acc += b.dur; });
  V.total = V.total || acc;
  imgs = await Promise.all(V.boards.map((b) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = b.thumb; })));
  if (V.audio) { audioEl = new Audio(); audioEl.src = V.audio.dataURL; }
  $('loadView').classList.add('hidden'); $('player').classList.remove('hidden');
  $('vBase').textContent = V.baseName || 'animatic';
  const sc = $('scrub'); sc.max = String(V.total);
  t = 0; drawAt(0); updateClock();
}

function boardAt(sec) { let i = 0; for (let k = 0; k < starts.length; k++) { if (starts[k] <= sec + 1e-6) i = k; else break; } return i; }

// Master gain + linear fade in/out (lengths given in frames, converted via the
// project's fps) — mirrors what mp4 export bakes in with ffmpeg's afade, so the
// viewer is an honest preview of the exported file, not just the visuals.
function audioVolumeAt(sec) {
  if (!V.audio) return 0;
  const at = sec - (V.audio.offsetSec || 0);
  if (at < 0) return 0;
  const gain = Math.max(0, Math.min(1, V.audio.gain ?? 1));
  const fps = V.fps || 24;
  const fadeInSec = (V.audio.fadeInFrames || 0) / fps;
  const fadeOutSec = (V.audio.fadeOutFrames || 0) / fps;
  const dur = (audioEl && isFinite(audioEl.duration)) ? audioEl.duration : null;
  let mult = 1;
  if (fadeInSec > 0 && at < fadeInSec) mult = Math.min(mult, Math.max(0, at / fadeInSec));
  if (dur != null && fadeOutSec > 0 && at > dur - fadeOutSec) mult = Math.min(mult, Math.max(0, (dur - at) / fadeOutSec));
  return gain * mult;
}

function fitRect(mode, iw, ih, W, H) {
  if (!iw || !ih) return { dx: 0, dy: 0, dw: W, dh: H };
  let s;
  if (mode === 'contain') s = Math.min(W / iw, H / ih);
  else if (mode === 'width') s = W / iw;
  else if (mode === 'height') s = H / ih;
  else s = Math.max(W / iw, H / ih);
  const dw = iw * s, dh = ih * s;
  return { dx: (W - dw) / 2, dy: (H - dh) / 2, dw, dh };
}

function drawAt(sec) {
  const cv = $('screen'); const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  const i = boardAt(sec); const b = V.boards[i]; const im = imgs[i];
  if (im) {
    const r = fitRect(b.fit || 'cover', im.width, im.height, W, H);
    ctx.drawImage(im, r.dx, r.dy, r.dw, r.dh);
    if (showAnno && b.annos && b.annos.length) { ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip(); drawAnnos(ctx, b.annos, { x: r.dx, y: r.dy, w: r.dw, h: r.dh }); ctx.restore(); }
  }
  $('vMeta').textContent = `${b.name} · shot ${b.shot + 1}`;
}

function updateClock() { $('vClock').textContent = `${fmt(t)} / ${fmt(V.total)}`; $('scrub').value = String(t); $('playBtn').textContent = playing ? '❚❚' : '▶'; }

function frame(ts) {
  if (!playing) return;
  if (!lastTs) lastTs = ts;
  t += (ts - lastTs) / 1000; lastTs = ts;
  if (t >= V.total) { t = V.total; pause(); }
  if (audioEl) audioEl.volume = audioVolumeAt(t);
  drawAt(t); updateClock();
  if (playing) raf = requestAnimationFrame(frame);
}
function play() {
  if (!V || playing) return; playing = true; lastTs = 0;
  if (audioEl) { const at = t - (V.audio.offsetSec || 0); if (at >= 0) { audioEl.currentTime = Math.min(Math.max(0, at), audioEl.duration || at); audioEl.volume = audioVolumeAt(t); audioEl.play().catch(() => {}); } }
  raf = requestAnimationFrame(frame); updateClock();
}
function pause() { playing = false; cancelAnimationFrame(raf); if (audioEl) audioEl.pause(); updateClock(); }
function seek(sec) { t = Math.max(0, Math.min(V.total, sec)); if (audioEl && playing) { const at = t - (V.audio.offsetSec || 0); if (at >= 0) audioEl.currentTime = at; } drawAt(t); updateClock(); }

function fitCanvas() {
  if (!V) return; const cv = $('screen'); const box = cv.parentElement;
  const ar = (V.resW || 16) / (V.resH || 9); let w = box.clientWidth, h = w / ar; if (h > box.clientHeight) { h = box.clientHeight; w = h * ar; }
  cv.width = Math.round(w); cv.height = Math.round(h); drawAt(t);
}

function wire() {
  $('pickBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = (e) => { const f = e.target.files[0]; if (f) readFile(f); };
  ['dragover', 'dragenter'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); $('drop') && $('drop').classList.add('hot'); }));
  document.addEventListener('drop', (e) => { e.preventDefault(); $('drop') && $('drop').classList.remove('hot'); const f = [...e.dataTransfer.files][0]; if (f) readFile(f); });
  $('playBtn').onclick = () => (playing ? pause() : play());
  $('scrub').oninput = (e) => { pause(); seek(+e.target.value); };
  $('annoToggle').onchange = (e) => { showAnno = e.target.checked; drawAt(t); };
  document.addEventListener('keydown', (e) => { if (e.key === ' ') { e.preventDefault(); playing ? pause() : play(); } });
  window.addEventListener('resize', fitCanvas);
}
function readFile(f) { const r = new FileReader(); r.onload = () => { try { const d = JSON.parse(r.result); if (d.kind !== 'animatic-view') throw 0; load(d).then(fitCanvas); } catch { $('msg').textContent = 'That is not a viewer JSON.'; } }; r.readAsText(f); }

wire();
const params = new URLSearchParams(location.search);
if (params.get('src')) { fetch(params.get('src')).then((r) => r.json()).then((d) => load(d).then(fitCanvas)).catch(() => { $('msg').textContent = 'Could not load that viewer link.'; }); }
