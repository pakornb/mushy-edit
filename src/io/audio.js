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

// Draw the waveform into a canvas, with an optional marker (seconds within file).
export function drawWaveform(canvas, audio, { fps, markerSec = null } = {}) {
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
  if (markerSec != null) {
    const mx = (markerSec / audio.duration) * w;
    ctx.fillStyle = '#ff8a3d';
    ctx.fillRect(mx, 0, 2, h);
  }
}
