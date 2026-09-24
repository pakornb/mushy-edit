# Changelog

Notable changes to Mushy Edit. Newest first. Started 2026-09-24 — earlier history
is in `git log`, and the three entries below this line backfill the sessions
immediately prior so the log isn't starting from a blank slate.

## 2026-09-24

### Fixed
- **Insert/reorder not updating the preview canvas.** Two root causes: `imgCache`
  (`main.js`) was keyed by array index, so after an insert or move it could hand
  back a stale `Image` for a position that now held different content; and
  `onTick()`'s repaint check (`r.frame !== previewFi`) assumed an index always
  means the same board, so re-selecting "index N" right after N's content
  changed looked like a no-op. Fixed by keying the cache on filename and
  resetting `previewFi` before any jump triggered by a structural edit.
- **Annotations disappearing when leaving annotate mode.** The interactive
  annotator only ever drew to its own temporary overlay canvas; nothing baked
  the strokes into the actual preview canvas, so exiting annotate mode (which
  destroys that overlay) revealed the *old* picture underneath. mp4 export and
  the viewer already drew annotations correctly — the live editor preview was
  the one place that didn't. Now `drawPreview()` draws annotations too, and
  `exitAnnotate()` forces a repaint.
- **Audio fade-out anchored to the wrong timeline.** It was measured against
  the raw audio file's own duration, which can run far longer than the video
  it's laid under (e.g. a full music track under a 30s spot) — the fade-out
  point could sit well past anything that ever actually plays, so it never
  fired. Now anchored to the video timeline's own total length, in the editor,
  the viewer, and mp4 export.
- **Audio fade-in anchored to the wrong timeline (the symmetric bug).**
  Measured from position within the raw file, so a clip trimmed to start
  playing *before* the video (a negative offset, via `-ss`) began playback
  already partway — or all the way — through the fade instead of a fresh one.
  Now anchored to whenever the audio first becomes audible in the video,
  never earlier than t=0. (mp4 export didn't need this fix — ffmpeg's own
  `-ss` trim already resets that stream's clock to 0 at the trim point.)
- **Audio offset drag not updating the fade indicator.** Dragging the clip
  updated `offsetSec` and the clip's on-screen position but never redrew the
  waveform canvas, so the fade-in/out indicators — baked into that canvas at
  fixed pixel positions — just rode along with the clip instead of staying
  anchored to the video timeline. The nudge buttons and sync-to-playhead
  already redrew correctly; only the drag path was missing it.
- Frame Splitter: cleaned up a duplicate click listener on Grid mode's
  "Detect page" button (pre-existing, unrelated to this session's work) that
  ran detection twice per click.

### Added
- Visual fade in/out indicator on the audio waveform clip — a shaded region
  plus the actual gain curve, positioned in video-timeline space (not just
  relative to the clip), so a long audio file's fade-out point visibly lands
  wherever the video actually ends, and a negative-offset clip's fade-in
  visibly starts wherever the video actually begins.
- Insert now defaults a new board's duration to the average of its two new
  neighbors, instead of a 1-frame sliver invisible at normal zoom.
- Timeline tiles tile their thumbnail image across a board's actual width
  instead of drawing it once at a fixed size and leaving the rest black.

### Changed
- Audio fade curve is now an eased S-curve (smoothstep — the same formula as
  the retiming falloff's "smooth" option) instead of a plain linear ramp, in
  the editor, the viewer, and mp4 export (`curve=hsin`).
- Audio gain + fade are now genuinely audible during the main editor's own
  playback (previously wired into mp4 export and the viewer only).

## 2026-09-23

### Added
- Insert board mid-timeline, for real this time — `insertFrame()` existed
  from an earlier pass but was never wired to any UI. Now: a "+ insert"
  toggle arms hover-revealed `+` gaps on each timeline tile's edges; clicking
  one opens a small popover to upload an image or generate a flat
  solid-color placeholder board (meant to be drawn on with the annotate
  tool).
- Move/reorder boards: Alt+drag a tile, or Cmd/Ctrl+Shift+Left/Right for the
  current board or selection. Undo previously couldn't cover insert or
  reorder at all — `captureState()`/`applyState()` only snapshotted
  per-filename maps, never frame order; both now round-trip frame order too.
- Audio master gain + fade in/out (first pass — see 2026-09-24 for the
  correctness fixes).
- EDL export, packaged as a zip with every board's full-res source image and
  the audio file (not a bare `.edl`) so it's self-contained and relinkable.
- Frame Splitter: reworked manual crop into Draw and Select/Move tools
  (multi-select, shift-click toggle, shift-drag clone), added undo/redo.

### Fixed
- Frame Splitter: Smart Add's drag-to-draw now always matches the box you
  actually drew, instead of re-detecting from just the release point (which
  could land far larger than intended).

## 2026-09-22

### Added
- Frame Splitter integration: split a storyboard sheet directly from the
  import screen (embedded modal, cropped boards handed back as real `File`
  objects — no zip round-trip needed for that path).
