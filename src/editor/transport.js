import { timeline, easeInOut } from '../core/model.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Transport {
  constructor(P) {
    this.P = P;
    this.sec = 0;
    this.playing = false;
    this.holdFirst = false;
    this.raf = 0;
    this.onTick = () => {};
    this.audioEl = new Audio();
    this.audioEl.preload = 'auto';
  }

  total() { return timeline(this.P).total; }
  frameDur() { return 1 / this.P.fps; }

  // Master gain + eased (S-curve) fade in/out (lengths in frames, via fps) — mirrors
  // the viewer's audioVolumeAt() and what mp4 export bakes in with ffmpeg's
  // afade, so the editor's own playback is an honest preview too instead of
  // the only place none of this was ever audible.
  //
  // Fade-out is anchored to the VIDEO timeline's own end (this.total()), not
  // the raw audio file's length — an audio file is very often much longer
  // than the spot it's laid under (a full music track under a 30s spot), and
  // anchoring to the file's own duration meant the fade-out point could sit
  // way past anything that ever actually plays, so it never audibly fired.
  //
  // Fade-in is symmetric: anchored to whenever the audio first becomes
  // audible IN THE VIDEO, never earlier than t=0 — NOT to position within the
  // raw file. A negative offsetSec (the clip trimmed via -ss to start playing
  // before the video begins) would otherwise measure fade-in progress from
  // the file's own t=0, which is BEFORE the video starts, so playback would
  // begin already partway (or all the way) through the fade instead of a
  // fresh one — e.g. offsetSec=-1 with a 2s fade-in started audible at 50%
  // volume on the very first frame instead of ramping from silence.
  _audioVolume() {
    const a = this.P.audio;
    if (!a) return 1;
    const at = this.sec - (a.offsetSec || 0); // position within the audio file
    if (at < 0) return 0;
    const gain = Math.max(0, Math.min(1, a.gain ?? 1));
    const fps = this.P.fps || 24;
    const fadeInSec = (a.fadeInFrames || 0) / fps;
    const fadeOutSec = (a.fadeOutFrames || 0) / fps;
    const videoEnd = this.total();
    const fadeInAt = this.sec - Math.max(0, a.offsetSec || 0);
    let mult = 1;
    if (fadeInSec > 0 && fadeInAt < fadeInSec) mult = Math.min(mult, easeInOut(Math.max(0, fadeInAt) / fadeInSec));
    if (fadeOutSec > 0 && this.sec > videoEnd - fadeOutSec) mult = Math.min(mult, easeInOut((videoEnd - this.sec) / fadeOutSec));
    return gain * mult;
  }

  mountAudio() {
    const a = this.P.audio;
    this.audioEl.pause();
    if (a && a.url) { this.audioEl.src = a.url; this.audioEl.load(); }
    else this.audioEl.removeAttribute('src');
  }

  play() {
    if (this.playing) return;
    if (this.sec >= this.total() - 1e-4) this.sec = 0;
    this.playing = true;
    this._t0 = performance.now();
    this._base = this.sec;
    this._syncAudio(true);
    this._loop();
  }
  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.audioEl.pause();
    this.onTick(this.sec, false);
  }
  toggle() { this.playing ? this.pause() : this.play(); }

  seek(sec) {
    this.sec = clamp(sec, 0, this.total());
    if (this.playing) { this._t0 = performance.now(); this._base = this.sec; this._syncAudio(true); }
    else this._syncAudio(false);
    this.onTick(this.sec, this.playing);
  }
  // step by whole frames
  stepFrames(n) { this.pause(); this.seek(this.sec + n * this.frameDur()); }

  _loop() {
    this.raf = requestAnimationFrame(() => {
      if (!this.playing) return;
      const t = this._base + (performance.now() - this._t0) / 1000;
      if (t >= this.total()) { this.sec = this.total(); this.pause(); return; }
      this.sec = t;
      if (this.audioEl.src) this.audioEl.volume = this._audioVolume();
      this.onTick(this.sec, true);
      this._loop();
    });
  }

  _syncAudio(force) {
    const a = this.P.audio;
    if (!a || !this.audioEl.src) return;
    const inSec = a.inSec ?? 0;
    const outSec = a.outSec ?? (this.audioEl.duration || a.duration || Infinity);
    // global time -> position within the audio file
    const at = this.sec - (a.offsetSec || 0) + inSec;
    if (at >= inSec && at <= outSec) {
      if (force || Math.abs(this.audioEl.currentTime - at) > 0.06) {
        try { this.audioEl.currentTime = Math.max(0, at); } catch (e) {}
      }
      this.audioEl.volume = this._audioVolume();
      if (this.playing) this.audioEl.play().catch(() => {});
    } else {
      this.audioEl.pause();
    }
  }
}
