import { easeInOut } from '../core/model.js';

// Load an audio file, decode it for a waveform, and expose peak data.

export async function loadAudioFile(file) {
  const blob = file;
  const url = URL.createObjectURL(blob);
  const arrayBuf = await blob.arrayBuffer();
  let duration = 0, peaks = null;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ac = new Ctx();
    const audioBuf = await ac.decodeAudioData(arrayBuf.slice(0));
    duration = audioBuf.duration;
    peaks = computePeaks(audioBuf, 1000);
    ac.close();
  } catch (e) {
    // decode can fail for some codecs; fall back to <audio> duration, no waveform
    duration = await probeDuration(url);
  }
  return { name: file.name, blob, url, duration, peaks, offsetSec: 0, inSec: null, outSec: null, gain: 1, fadeInFrames: 0, fadeOutFrames: 0 };
}

function computePeaks(audioBuf, buckets) {
  const ch = audioBuf.getChannelData(0);
  const size = Math.floor(ch.length / buckets) || 1;
  const out = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    let max = 0;
    const start = b * size;
    for (let i = 0; i < size && start + i < ch.length; i++) {
      const v = Math.abs(ch[start + i]);
      if (v > max) max = v;
    }
    out[b] = max;
  }
  return out;
}

function probeDuration(url) {
  return new Promise((res) => {
    const a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = () => res(a.duration || 0);
    a.onerror = () => res(0);
    a.src = url;
  });
}

// Draw the waveform into a canvas, with an optional marker (seconds within
// file) and fade-in/out indicators — the classic DAW look, an eased gain
// curve with the attenuated side shaded. Fade pixel ranges are computed by
// the caller (in canvas-local px, i.e. relative to the clip's own left edge)
// since they depend on the video timeline's own start/end, not just the
// audio file's — see the caller for why that distinction matters. Note
// fade-in isn't always anchored at x=0: a negative offset (clip trimmed to
// start before the video) shifts its true start (video t=0) into the clip.
export function drawWaveform(canvas, audio, { markerSec = null, fadeInStartPx = 0, fadeInEndPx = 0, fadeOutStartPx = null, fadeOutEndPx = null } = {}) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!audio || !audio.peaks || !audio.duration) {
    ctx.fillStyle = '#5b6472';
    ctx.font = '10px monospace';
    ctx.fillText(audio ? 'no waveform (codec)' : 'no audio', 6, h / 2);
    return;
  }
  const peaks = audio.peaks;
  ctx.fillStyle = '#3a4150';
  const mid = h / 2;
  for (let x = 0; x < w; x++) {
    const p = peaks[Math.floor((x / w) * peaks.length)] || 0;
    const bh = p * (h * 0.9);
    ctx.fillRect(x, mid - bh / 2, 1, bh);
  }
  drawFadeTriangle(ctx, w, h, 'in', Math.max(0, Math.min(w, fadeInStartPx)), Math.max(0, Math.min(w, fadeInEndPx)));
  if (fadeOutStartPx != null && fadeOutEndPx != null) {
    drawFadeTriangle(ctx, w, h, 'out', Math.max(0, Math.min(w, fadeOutStartPx)), Math.max(0, Math.min(w, fadeOutEndPx)));
  }
  if (markerSec != null) {
    const mx = (markerSec / audio.duration) * w;
    ctx.fillStyle = '#ff8a3d';
    ctx.fillRect(mx, 0, 2, h);
  }
}

// Traces the actual eased gain curve (matches easeInOut() in _audioVolume()/
// audioVolumeAt()) rather than a straight diagonal, so the indicator's shape
// is honest about the S-curve fade instead of implying a linear one.
function drawFadeTriangle(ctx, w, h, dir, x0, x1) {
  if (x1 - x0 < 1) return; // no fade, or fully clamped out of view
  const steps = Math.max(2, Math.round(x1 - x0));
  const gainAt = (t) => (dir === 'in' ? easeInOut(t) : easeInOut(1 - t));
  ctx.save();
  ctx.fillStyle = 'rgba(10,12,15,.55)';
  ctx.beginPath();
  ctx.moveTo(x0, 0);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    ctx.lineTo(x0 + (x1 - x0) * t, h * (1 - gainAt(t)));
  }
  ctx.lineTo(x1, 0);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.25;
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t, y = h * (1 - gainAt(t));
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}
