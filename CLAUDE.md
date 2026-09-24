# Mushy Edit — project guide for Claude Code

A browser-based **storyboard timing + review + handoff** tool for Hello Hornet.
Ingest a storyboard image sequence, group it into shots, **time it out with fluid
"broad-strokes" retiming**, review it (playback / mp4 / shareable viewer), annotate
it, track shots+assets for a Google-Sheet breakdown, and (soon) hand off to an NLE.

**It is deliberately NOT a mini-NLE.** It does timing, review, and handoff — the
things Resolve/Premiere are clumsy at. Do not add per-image compositing (freeform
move/scale/rotate/crop). Framing is handled by *fit modes*, not a transform tool.
When in doubt, keep the tool on the timing/review/handoff side of that line.

## Stack & commands
- Vite + **vanilla JS** (no framework), deployed on **Vercel**.
- `npm install` then `npm run dev` (local) / `npm run build` (prod, outputs `dist/`).
- Two entry points: `index.html` (editor) and `view.html` (read-only viewer). See `vite.config.js`.
- **COOP/COEP headers** are set in `vercel.json` and the dev server (required so
  `crossOriginIsolated` is true for ffmpeg.wasm).
- Deps are intentionally minimal: `@ffmpeg/ffmpeg@0.12.10`, `@ffmpeg/util@0.12.1`,
  `jszip`. **Do not bump the ffmpeg versions** (see mp4 note below).

## Sandbox build caveat (matters for you)
The original author edits in an environment where `/mnt/user-data/outputs` can't be
symlinked, so builds were tested by copying `src/`, `index.html`, `view.html` into a
scratch dir with `node_modules` and running `npm run build`. In a normal clone you can
just `npm install && npm run build` in place. Always run a build before committing.

## File map
- `src/core/model.js` — **the heart.** Central `project` state + all pure logic:
  shot detection (`computeShots`), the timing model, retiming engine, fit, tasks, assets,
  annotations, undo snapshot (`captureState`/`applyState`).
- `src/core/frames.js` — ingest zip/images → per-frame `{name, url(full objectURL), full(blob), thumb(canvas), diff}`;
  captures max source resolution into `resW/resH`. Groups by filename pattern or diff cuts.
- `src/core/history.js` — undo/redo over light state snapshots (never image blobs).
  `mutate(fn)` for one-shot edits; `beginGesture()/commitGesture()` to collapse a drag into one undo.
- `src/core/annotate.js` — **vector annotation engine** (shared by preview + assets).
  Strokes stored **normalized to the IMAGE** (not the frame). `drawAnnos(ctx, strokes, rect)`
  where `rect={x,y,w,h}` is the image draw-rect. `createAnnotator(host, imageEl, strokes, onCommit, {getImageRect})`.
- `src/editor/main.js` — editor bootstrap: the zoomable board-strip **timeline**, drag
  gestures, playhead/ruler, preview **canvas** rendering, audio clip, zoom, keyboard, export menu wiring.
- `src/editor/inspector.js` — the right-hand property panel (filmstrip + selected-board
  actions + Shot/Tasks/Notes sections).
- `src/editor/transport.js` — rAF playback clock, audio sync with frame-accurate slip.
- `src/editor/assets.js` — asset tracker window, HTML **sheet preview**, breakdown JSON
  export, montage builder. `buildBreakdownData()` is async (composites asset thumbs).
- `src/io/workfile.js` — the **work file** (`<base>_work.animatic.json`): embeds full-res
  boards + audio + ALL state; reopenable source of truth. `base64.js` helpers.
- `src/io/audio.js` — decode audio → waveform peaks; keeps the original `blob` (used by mp4 + viewer).
- `src/io/mp4.js` — **ffmpeg.wasm** mp4 export (see note). Draft (`maxW:960`) vs final.
- `src/io/viewer.js` — builds/export the viewer JSON (thumbnails + timing + annos + audio).
- `src/viewer/main.js` + `view.html` — the read-only review player (loads a viewer JSON;
  `?src=<url>` also works).
- `src/io/appsScript.js` — **generated** string of the Google Apps Script; see note.

## The timing model (read before touching retiming)
- **Source of truth = per-board duration in seconds, keyed by filename** (`project.boardDur`
  Map). Shot length = sum of its enabled boards' durations (derived). Everything is keyed by
  **filename** so re-ingesting upgraded art with the same names preserves the whole edit.
- `timeline(project)` → `{ boards[{fi,startSec,len,shotIndex,pinned}], spans, markers, total }`.
- **Retiming gestures** (all in `model.js`, all bounded by pins, all via `redistribute`):
  - `retimeBoard(fi,newDur,reach)` — vertical drag: change one board's duration; neighbors flex.
  - `retimeGroup(fiList,factor,reach)` — scale a multi-selection together.
  - `offsetBoard(fi,d,reach)` / `offsetGroup(fiList,d,reach)` — horizontal "mushy" slide.
  - `redistribute(...)` weights neighbors by **distance from the selection EDGE** (span
    `[spanLo,spanHi]`), shaped by an **easing curve** (`falloffWeight`, curves: smooth/linear/easeIn/easeOut).
- **Pins** (`project.pinned`, filenames) are **hard walls**: pinned boards never change
  duration or position; between two pins the change is capped to available slack (no drift/ripple).
- **Spot length is soft** (can drift over/under; budget meter shows it). `rebalance()` scales
  unpinned boards to hit the spot exactly. `autoEstimate()` gives unpinned boards an equal share
  (runs automatically on fresh image load).
- `falloffReach` is a **global** setting (slider); **Shift always = 2× reach** (never selection).

## Interaction rules (keep consistent)
- **Shift = 2× falloff, universally** (vertical/horizontal drag and ↑/↓ arrows). Never selection.
- Timeline is one surface: tiles = boards (width ∝ time), shot shown as a colored stripe on
  tiles, grabbable blue playhead scrubs frame-by-frame, marquee on the ruler selects a range.
- Drag a tile: **axis-locked at drag start** — vertical = retime, horizontal = mushy-offset.
- Keys: `←/→` board, `Alt+←/→` shot, `Cmd/Ctrl+←/→` start/end, `Shift+←/→` extend selection,
  `↑/↓` retime selected (`Shift` = 2× reach), `Space` play, `h` hide, `p` pin, `c` cut/merge,
  `+/−` zoom (toward playhead; Ctrl/Cmd+wheel zooms toward cursor), `Cmd/Ctrl+Z` undo (`+Shift` redo),
  `Esc` closes modal / exits annotate / clears selection.
- Manual cuts use `manualAdd`/`manualRemove` (filenames) consumed by `computeShots`.

## Fit / preview
- The preview is a **canvas** rendered with `fitRect(mode, iw, ih, W, H)` → `{dx,dy,dw,dh}`,
  so **preview == mp4 == viewer** exactly (the dashed canvas border is the true render frame).
- Fit modes: **cover (default, crops long side)**, contain (bars), width, height.
  Global `project.fitMode` + per-board override `project.boardFit`.
- **Annotations are image-relative:** when passing to `drawAnnos`/`getImageRect`, remember the
  annotator's rect uses keys `{x,y,w,h}` while `fitRect` returns `{dx,dy,dw,dh}` — **map them**
  (`{x:r.dx,y:r.dy,w:r.dw,h:r.dh}`). A past bug (blank strokes) was passing the raw `fitRect` object.
- **The main editor's `drawPreview()` (`main.js`) now also draws annotations**, not just the
  image — it didn't before, which meant strokes only ever appeared on the interactive annotator's
  own overlay canvas (destroyed the moment you left annotate mode) and never during ordinary
  viewing/playback, even though mp4 export and the viewer both already drew them correctly. See
  the gotcha below on why leaving annotate mode needs a forced redraw, not just relying on this.

## mp4 export (do not "optimize" back into breakage)
- Uses **single-threaded** `@ffmpeg/core@0.12.6` loaded from unpkg via `toBlobURL`.
- **Multithread (`core-mt`) throws "function signature mismatch" at exec time** with this
  wrapper version — a load-time try/catch can't catch it. Stay single-thread. Speed comes from
  **draft mode** (`maxW:960`), not threads. If revisiting mt, make it an opt-in "beta" path that
  cannot break the default, and verify against a genuinely matched core version.
- Frames are pre-letterboxed to exact even `resW×resH` via `fitRect`; audio muxed at the slip
  offset (`-itsoffset` for +, `-ss` for −), capped with `-t total`.

## Google Sheet export
- Editor builds breakdown JSON (`assets.js`), the `.gs` (`sequence_breakdown_to_sheets.gs` in the
  repo root of the *outputs*, kept in sync) builds a **Shots** sheet + an **Assets** sheet (own tab,
  Reference thumbnails at 320px). `src/io/appsScript.js` is a **generated** JSON-encoded copy of the
  `.gs` for the in-app "Copy Apps Script" button — **regenerate it whenever the `.gs` changes**:
  `node -e 'const fs=require("fs");fs.writeFileSync("src/io/appsScript.js","export const APPS_SCRIPT = "+JSON.stringify(fs.readFileSync("../sequence_breakdown_to_sheets.gs","utf8"))+";\n")'`
  (adjust the `.gs` path to wherever it lives in the repo).

## Roadmap / next tasks
1. **Batch B — insert board + update-images-preserve-timing:**
   - "Insert board from disk": upload an image, choose insert before/after the current board (or
     at the playhead); weave it into `frames`/`diffs`/`frameKeys`, give it a default duration,
     reflow. Everything else keyed by filename stays put. **DONE (and actually wired up now —**
     a previous pass built `insertFrame()` but never called it from anywhere; the UI below was
     only ever documented, not shipped, until this pass connected the two). `insertFrame()` in
     `frames.js` does the splice/rename-on-collision/neighbor-diff-recompute/default-duration
     work. UI: a global **"+ insert" toggle** above the timeline (`insertModeBtn`, gated so a
     stray click during normal drag/click doesn't accidentally insert) arms hover-revealed `+`
     gaps on the LEFT/RIGHT edge of each timeline tile (`.slot .insert-gap`, CSS-only show/hide
     via `#tlInner.insert-mode .slot:hover`, grows on its own hover) — click one to open a small
     popover: **"Upload image…"** (file picker) or **"Blank frame"** (a color picker → a flat
     solid-color placeholder at spot resolution, meant to be drawn on with the existing annotate
     tool). Deliberately a popover, not a menu — see item 4 below on why menus were rejected here.
     Frame Splitter is NOT wired into mid-timeline insert (only the very first import screen) —
     deliberately out of scope for now; re-open the sheet in Frame Splitter and use insert instead.
     Default duration for the new board is the **average of its two new neighbors'** durations
     (falls back to whichever one exists at an edge) — a flat 1-frame default was technically
     correct but invisible at the timeline's normal zoom, forcing a zoom-in just to see/grab it.
     Timeline tiles also now **tile the thumbnail image** across a board's actual width
     (`buildTimeline()` in `main.js`) instead of drawing it once at a fixed ~107px and leaving
     the rest of a long board's block black.
   - "Update images (preserve timing)": re-ingest a folder/zip, **match by filename**, swap pixels
     while keeping all timing/pins/disables/annotations/tags. New filenames = new boards to place.
     Renamed files break the key (note it; a relink UI is a possible follow-on). **DONE** — this is
     the "Replace…" option in the header's `Images ▾` menu (`imageOps.js replaceFrames()`); the
     "new filenames = new boards" half is still open (currently unmatched files are just reported,
     not auto-inserted — could wire into `insertFrame()` later).
2. **Move / reorder boards. DONE.** Two entry points, both operating on RAW `p.frames` array
   position (not enabled-flat timeline position, so a move can land a board next to a hidden one):
   - **Alt+drag** a tile (`attachTile()` in `main.js`) — a third gesture alongside the existing
     axis-locked retime(↕)/offset(↔), picked at pointerdown by `e.altKey` rather than by axis, so
     it can't be triggered by accident mid-retime. Shows a drop-position indicator line computed
     from the same `bd.startSec*pps` math `buildTimeline()` uses to lay out tiles (not DOM
     `getBoundingClientRect()` reads), snapping to whichever board-gap the pointer is nearer.
   - **Cmd/Ctrl+Shift+←/→** moves the current board (or the whole selection, treated as one
     contiguous block regardless of whether the selection itself is contiguous) one slot in that
     direction.
   - Both call `moveFrames()` in `frames.js` — extracts the moving boards, closes the gap, splices
     them in at the (index-adjusted) target, then rebuilds `frameKeys` and **recomputes the whole
     `diffs` array** from cached `luma` (cheap; not worth patching individual seams the way
     `insertFrame()` does for its one new neighbor, since a reorder can touch any number of them
     at once). Undoable: `captureState()`/`applyState()` now also snapshot/restore frame order (by
     filename — see the Conventions note below on why this was previously missing entirely, for
     insert too).
3. **Audio: master gain + fade in/out. DONE** (went through several correctness passes — see
   "Things that have bitten us" below before touching this again). `p.audio.gain` (0–2 linear
   multiplier) and `fadeInFrames`/`fadeOutFrames` (length typed in **frames**, converted via
   `p.fps` — not seconds, so it stays in sync if fps changes). Applied in **all three** places,
   matching the preview/mp4/viewer parity goal above — the editor's own playback is no longer
   the one place none of this was audible:
   - **Editor** (`transport.js` `Transport._audioVolume()`) — recomputed into `audioEl.volume`
     every rAF tick during playback, on every `seek()`/`_syncAudio()`, and live while dragging the
     gain/fade-frame inputs (`main.js`'s `refreshLiveVolume()`).
   - **Viewer** (`viewer.js` export + `src/viewer/main.js` `audioVolumeAt()`) — its rAF loop
     already ticks every playback frame, so it recomputes `audioEl.volume` live each tick too.
   - **mp4 export** (`mp4.js` `audioFilterChain()`) — bakes an `-af` chain: `volume=` (only if
     ≠1) + `afade=t=in:st=0:...:curve=hsin` + `afade=t=out:st=<...>:...:curve=hsin`.
   - **Both fade ends are anchored to the VIDEO TIMELINE, never to the raw audio file.** Fade-out
     ends at the video's own total duration (`this.total()` / `V.total` / the `videoTotal` param
     threaded into `audioFilterChain()`) — anchoring to the file's own (possibly much longer,
     e.g. a full music track) length meant the fade-out point could sit past anything that ever
     actually renders. Fade-in starts at `max(0, offsetSec)` — i.e. whenever the audio first
     becomes audible in the video, never earlier than t=0 — anchoring to raw file position
     (`sec - offsetSec` with no floor) meant a clip trimmed to start playing *before* the video
     (negative `offsetSec`, via `-ss`) began playback already partway through the fade instead of
     a fresh one. `mp4.js` didn't need the fade-in fix: ffmpeg's own `-ss` trim already resets
     that stream's internal clock to 0 at the trim point, so `afade`'s `st=0` was already correct
     there — only the hand-rolled JS versions (editor + viewer) had the bug.
   - **Curve: eased (smoothstep S-curve), not linear** — `easeInOut()` in `model.js`, the same
     formula as `falloffWeight`'s `'smooth'` case, reused for consistency rather than introducing
     a second curve implementation. ffmpeg's closest built-in match is `curve=hsin` (half-sine);
     exact numeric equivalence with the JS smoothstep isn't the point, both are S-curves with zero
     slope at the boundaries and read the same to the ear/eye.
   - **Visual fade indicator** on the audio waveform clip (`audio.js` `drawFadeTriangle()`,
     wired from `main.js` `layoutAudioClip()`) — a shaded region + the actual eased gain curve
     (not a straight diagonal), positioned in **video-timeline space**, not clip-local space:
     fade-out's pixel position is computed from `timeline(P).total`, and fade-in's start pixel is
     `max(0, -offsetSec) * pps` (nonzero — i.e. shifted right, *into* the clip — only when
     `offsetSec` is negative), so both indicators land exactly where the audible fade actually is,
     including the case where a long audio file's fade-out point is well before its own visual
     right edge. Must be redrawn (`layoutAudioClip()`, not just repositioning the clip `<div>`)
     on every offset change, including mid-drag — see the gotcha below.
   - UI lives in the audio lane (`index.html`): a gain slider + two frame-count number inputs.
4. **EDL export. DONE** (as a **zip package**, not a bare `.edl` file — deliberately, so it's
   self-contained/relinkable without hunting down the original images separately). `src/io/edl.js`
   `buildEdl()` writes CMX3600 text (one `V` event per enabled board — still images have no real
   source timecode, so source is always `00:00:00:00` → its own duration; `* FROM CLIP NAME:`
   carries the real filename since the 8-char reel field can't; one `A` event for the audio clip
   if present, reusing `offsetSec`/`duration` for its record range). `exportEdlZip()` bundles that
   `.edl` with every enabled board's full-res source image (under its original filename, so the
   EDL's clip-name comments and the zip contents line up) and the audio file, via JSZip (already a
   dependency). Reuses `nle.js`'s `frameCounts()` (now exported) for the same drift-free whole-frame
   math the FCPXML export already relies on. **Not validated against a real NLE import**, same
   caveat as FCPXML below — only checked for well-formed output and correct frame math.
5. **Step 5 — NLE handoff (EDL + FCPXML):** export the cut so an editor can rebuild the animatic
   in Resolve/Premiere. FCPXML should reference the **full-res source images** at each board's
   duration; EDL is the simpler timing list. Neither embeds images (they reference by name/path) —
   contrast with item 4 above, which is a *separate*, self-contained zip export, not this one.
   - **FCPXML: DONE** — `src/io/nle.js` `buildFcpxml()`/`exportFcpxml()`, wired into
     Export ▾ → "Export FCPXML (NLE handoff)…". Targets FCPXML 1.9 (broadest common
     Resolve/Premiere support). References images by **bare filename only** (no path) — the
     editor relinks to the original image folder on import, since the app never has a real
     filesystem path (images are in-memory blobs). Frame math: per-board start/length are
     summed as whole frames (`Math.round(len*fps)`, accumulated as integers) so there's no
     rounding drift between the export and the app's own timeline — checked in isolation
     against a mock project (disabled-board exclusion, rounding, XML escaping all correct),
     but **not yet validated against a real Resolve/Premiere import** — if either app rejects
     something on first real test, that's the place to look.
   - **EDL (this exact format, bare file, no zip): not started** — item 4 above covers the
     zip-packaged version that was actually asked for; a bare `.edl` export (no bundled images)
     would be a small addition to `edl.js` if ever needed on its own.
6. Ongoing **feel-tuning** constants: `SEC_PER_PX` drag sensitivity (~0.012), default falloff
   reach/curve, horizontal-offset mushiness. These are "play with real boards and adjust", not spec.
7. **UI clarity pass on the Boards/Shots property panels** (inspector.js) — noted for later, NOT
   started. Reduce clutter and make state easier to read at a glance: the board action row (hide/
   pin/cut/reset, currently four separate icon buttons), the Shot section header (disable/pin
   icons), the Tasks grid. Discuss the approach before touching this — don't assume grouping
   controls into a menu is the right fix; that was tried once and reverted (lost the icon
   affordance without being asked to make that trade).

## Things that have bitten us (avoid regressions)
- **`imgCache` (`main.js`) must be keyed by filename, never by array index.** It caches the
  loaded `Image` used to paint the preview canvas. Insert and reorder both change which frame
  sits at a given array position — an index-keyed cache would confidently hand back the *old*
  image for that index after either operation, i.e. the preview would keep showing stale content
  even though the model was already correct. This was the actual root cause of "insert/move don't
  update the canvas," and it was subtle because the timeline DOM (rebuilt fresh every render) and
  the model state both looked right; only the cached `Image` object was stale.
- **`onTick()`'s repaint guard (`if (r.frame !== previewFi) drawPreview(...)`) assumes an index
  always refers to the same board.** Insert/reorder break that assumption the same way as above:
  selecting "index N" right after something changed what's *at* index N looks like a no-op to this
  check. `selectSingle()`/`selectSet()` (`main.js`) reset `previewFi = -1` first specifically to
  defeat this guard — any new code path that jumps the played/selected frame after a structural
  edit needs the same reset, or the canvas silently keeps showing whatever was there before.
- **The interactive annotator draws only to its own overlay `<canvas>`** (`createAnnotator()` in
  `annotate.js`), destroyed the moment annotate mode exits. `exitAnnotate()` (`main.js`) must force
  a `drawPreview()` afterward (also resetting `previewFi = -1` per above) or the strokes just
  committed appear to vanish — the underlying canvas last painted *before* they existed, and
  nothing tells it to repaint until something unrelated (e.g. scrubbing away and back) happens to.
- **Dragging the audio clip (`attachAudioClipDrag()` in `main.js`) must call `layoutAudioClip()`
  on every `pointermove`, not just update `P.audio.offsetSec` and the clip `<div>`'s `left` style.**
  The fade-in/out indicators are baked into the waveform canvas at fixed pixel positions computed
  from the offset *at the time it was last drawn* — if only the div moves, the canvas (and its
  indicators) just rides along with it, silently drifting out of sync with where the fade actually
  is. The other ways to change `offsetSec` (nudge buttons, sync-to-playhead) already called
  `layoutAudioClip()`; only the drag path was missing it.
- **Both audio fade ends must be anchored to the VIDEO TIMELINE (start/end), never to the raw
  audio file.** Two separate bugs came from this, one per end — see the Audio item above for the
  fix; the general lesson is that any time-based calc here should ask "where does this line up in
  the *video*" before reaching for `offsetSec`/`a.duration`/`audioEl.duration` directly.

## Conventions
- Vanilla JS, terse but readable; no new frameworks/deps without good reason.
- New persistent state must be added in **four** places: `project` init, `captureState`/`applyState`
  (undo), and `workfile.js` save+open. Keep undo snapshots free of heavy blobs.
- Everything user-visible keyed by **filename** so re-ingest preserves it.
- Run `npm run build` and fix all errors before committing.
