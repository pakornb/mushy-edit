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
     reflow. Everything else keyed by filename stays put.
   - "Update images (preserve timing)": re-ingest a folder/zip, **match by filename**, swap pixels
     while keeping all timing/pins/disables/annotations/tags. New filenames = new boards to place.
     Renamed files break the key (note it; a relink UI is a possible follow-on).
2. **Step 5 — NLE handoff (EDL + FCPXML):** export the cut so an editor can rebuild the animatic
   in Resolve/Premiere. FCPXML should reference the **full-res source images** at each board's
   duration; EDL is the simpler timing list. Neither embeds images (they reference by name/path).
3. Ongoing **feel-tuning** constants: `SEC_PER_PX` drag sensitivity (~0.012), default falloff
   reach/curve, horizontal-offset mushiness. These are "play with real boards and adjust", not spec.

## Conventions
- Vanilla JS, terse but readable; no new frameworks/deps without good reason.
- New persistent state must be added in **four** places: `project` init, `captureState`/`applyState`
  (undo), and `workfile.js` save+open. Keep undo snapshots free of heavy blobs.
- Everything user-visible keyed by **filename** so re-ingest preserves it.
- Run `npm run build` and fix all errors before committing.
