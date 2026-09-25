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
- Vite + **vanilla JS** (no framework). Two deploy targets, both live: **Vercel**
  (`vercel.json`, standalone, own domain) and a **Cloudflare Worker** behind the
  `hornet-animation/tools-dashboard` gateway at `tools.hellohornet.com/mushy-edit/`
  (`wrangler.jsonc` + `worker.js`) — see "Cloudflare / tools-dashboard deploy" below.
- `npm install` then `npm run dev` (local) / `npm run build` (prod, outputs `dist/`).
- Two entry points: `index.html` (editor) and `view.html` (read-only viewer). See `vite.config.js`.
- **COOP/COEP headers** are set in `vercel.json` and `worker.js` (Cloudflare) and the dev
  server (required so `crossOriginIsolated` is true for ffmpeg.wasm) — on every page
  EXCEPT `google-connect.html`. They break any cross-origin popup's link back to the
  page (Google sign-in); see Google Sheet export.
- Deps are intentionally minimal: `@ffmpeg/ffmpeg@0.12.10`, `@ffmpeg/util@0.12.1`,
  `jszip`. **Do not bump the ffmpeg versions** (see mp4 note below).

## Cloudflare / tools-dashboard deploy
This app is also served from inside Hornet's internal tools dashboard
(`hornet-animation/tools-dashboard`), which owns `tools.hellohornet.com` and
proxies `/mushy-edit/*` to this repo's own Cloudflare Worker (service binding
`MUSHY_EDIT` → Worker `hornet-mushy-edit`) after its own Google-SSO gate. That
gateway is what turns this into the "sign in with a Hornet account, no local
setup" tool the Google Sheets export was built for.
- **`vite.config.js`'s `base`** is `/mushy-edit/` for `vite build` (the dev
  server stays at `/`) — Vite bakes that prefix into every built HTML's
  asset URLs, or the browser would request `/assets/...` from site root and
  miss the dashboard's proxy route entirely.
- **`worker.js`** strips the `/mushy-edit` prefix and forwards to the
  `ASSETS` binding (same pattern as `hornet-slide-media-extractor`'s
  worker.js), redirects a bare `/mushy-edit` to add the trailing slash, and
  re-applies the COOP/COEP isolation headers to everything except
  `google-connect.html`.
- **Any code that opens a page by its own absolute URL breaks under this
  prefix** — `window.open`/`iframe.src`/etc. must use a *relative* path
  (resolved against wherever the current page is mounted), never a
  site-root `/foo.html`. `openConnect()` in `googleSheets.js` and
  `openSplitModal()` in `main.js` are the two existing examples; a new one
  needs the same treatment, or it'll open `tools.hellohornet.com/foo.html`
  instead of `tools.hellohornet.com/mushy-edit/foo.html`.
- **Deploying:** push to `main` runs `.github/workflows/deploy-cloudflare.yml`
  (needs `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` repo secrets, set via
  `wrangler secret put` or the GitHub UI — not yet set as of this writing).
  A `preview` branch deploys to `hornet-mushy-edit-preview` the same way
  `hornet-slide-media-extractor` does.
- **Wiring on the tools-dashboard side** (that repo, not this one):
  `worker/lib/db.js`'s `SEED_TOOLS`/`SEED_ROLE_DEFAULTS`, `worker.js`'s
  `routes` array, and `wrangler.jsonc`'s `services` (top-level + `env.preview`)
  all need a `mushy-edit` entry — see that repo's own `docs/branding.md`
  before picking an icon/color, its adjacency rule is easy to violate by
  accident.

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
- `src/io/googleSheets.js` — Google Sheets export: sign-in handoff, Drive thumbnail uploads, one-batch
  Sheet writes, background embed; `public/google-connect.html` is its sign-in/Picker helper window;
  `apps-script/embed/` is the centrally deployed embed script. See note below.

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
- **Composite-strip export (experimental, "Download breakdown JSON (fast, experimental)")**: the
  normal export embeds one thumbnail per shot/asset, and the `.gs` does one `insertImage()` per
  row — the dominant cost of building a sheet, since each is its own network round trip and there's
  no batch image-insert call in the Sheets API. The composite path (`buildBreakdownDataComposite`
  in `assets.js`, `imageMode:"composite"` in the JSON) instead stacks every row's picture into one
  tall canvas per column client-side (mirrors `shotMontage`'s per-shot compositing, just one level
  up) and ships that plus a `rowH[]` per-row height array. The `.gs`'s `buildShotListComposite` /
  `buildAssetSheetComposite` then do exactly **one** `insertImage()` per column, using `rowH`
  directly for `setRowHeight` so there's a single source of truth for the aspect math. Scoped to
  **"Build new sheet" only** — `updateFromJsonText` throws for composite JSON, since patching one
  changed row would mean re-inserting the whole strip; the per-row path stays the default and is
  what "Update active sheet" always uses. `STRIP_MONTAGE_W`/`STRIP_REF_W`/`STRIP_PAD` in `assets.js`
  must match `MONTAGE_W`/`PAD` in the `.gs` (kept as plain numeric literals in both, not shared —
  check both when changing thumbnail sizing).
- **Google Sheets export ("Export to Google Sheet…" / "Update Google Sheet") — the main path.**
  No per-user Apps Script setup. `src/io/googleSheets.js` + `public/google-connect.html`. The user
  signs in, picks any Sheet in their Drive with Google's Picker (or creates one), and the breakdown
  is added as a new tab. Two stages:
  1. **Fast links:** upload each row's thumbnail to a "Mushy Edit thumbnails" folder in the user's
     Drive (parallel, `UPLOAD_CONCURRENCY`), share each "anyone with the link", then write the whole
     tab in **one** `spreadsheets.batchUpdate` with `=IMAGE(url, 4, h, w)` formulas. The result
     modal shows here — the Sheet is already complete.
  2. **Embed (background):** `embedPictures()` calls the Apps Script in `apps-script/embed/` via
     `scripts.run` with the user's token. It swaps each `=IMAGE()` for an in-cell image
     (`newCellImage().setSourceUrl()`), reads back which cells took, and the app deletes those Drive
     files — so no public links remain. Failure never rejects: links just stay, and a toast says so.
  - **Why stage 1 exists:** the Sheets REST API cannot upload image bytes into a sheet — `=IMAGE()`
    with a URL Google can fetch without login is the only API route to a picture. Stage 2 needs
    Apps Script because only `SpreadsheetApp` can create cell images.
  - **The embed script is deployed once, centrally**, not per user: project "Mushy Edit - Embed
    Images" owned by eperello@hellohornet.com, GCP project switched to Ray AI (required —
    `scripts.run` only works when the script and the OAuth client share a GCP project), deployed as
    an **API executable**, access "Anyone with Google account". Its deployment ID is
    `EMBED_SCRIPT_ID` in `googleSheets.js`. **After editing the script:** paste the new code in,
    then Deploy → Manage deployments → edit the existing deployment → New version (keeps the ID; a
    brand-new deployment changes it). The repo copy is the source of truth.
  - **Scopes:** `drive.file` + `spreadsheets` (the script's manifest declares `spreadsheets`, and
    the caller's token must carry every scope the script uses). `spreadsheets` is sensitive: fine
    for Hornet accounts; outside accounts see "unverified app" until the consent screen is verified.
    If a user unticks it at consent, stage 2 fails and links stay.
  - **Why sign-in happens in a helper window:** the editor's `Cross-Origin-Opener-Policy:
    same-origin` (ffmpeg.wasm needs it) severs the link to any cross-origin popup, so Google's
    sign-in popup could never return its token — it opened, you approved, it closed, nothing
    happened, in every browser. COEP `require-corp` also blocks the Picker iframe.
    `google-connect.html` is served WITHOUT COOP/COEP (exempted in `vite.config.js` and
    `vercel.json`) and reports back over `BroadcastChannel("mushy-google")`, which same-origin
    windows share regardless of COOP. `openConnect()` must run synchronously inside the click
    (it calls `window.open`) — await anything first and the popup is blocked.
  - **Update** follows the original Apps Script "Update active sheet" rules: match by Name; matched
    rows get a fresh picture + Length only (Shot/Notes/stage values untouched); new shots appended;
    vanished shots flagged red with "[not in latest]" and **keep their last picture** (per-row
    picture restores this — the composite-strip experiment couldn't). New pictures go through the
    same two stages; replaced pictures that were still links have their Drive files deleted
    (embedded ones have no Drive file). Targets `project.sheetsTabId` (numeric sheet id, survives tab
    renames) in `project.sheetsSpreadsheetId`; both saved in the work file but deliberately NOT in
    undo snapshots (`captureState`) — they record where an export went, not an edit.
  - **Config (hardcoded in `googleSheets.js`, all non-secret):** `CLIENT_ID` = the shared
    `hornet-tools` OAuth client in GCP project "Ray AI" (`ray-ai-489221`); `PICKER_API_KEY` =
    browser key restricted to the Picker API + allowed origins; `APP_ID` = GCP project number
    (Picker needs it to grant `drive.file` on the picked Sheet). **Deploying to a new origin** (e.g.
    tools.hellohornet.com): add it to the OAuth client's Authorized JavaScript origins AND the API
    key's website restrictions, or sign-in/Picker fail there. Drive, Sheets, and Picker APIs are
    enabled on that project.
  - **`=IMAGE()` URL form:** `https://lh3.googleusercontent.com/d/<fileId>` (`imageUrl()`). Google
    has broken other Drive direct-link forms before (`uc?export=view`); if thumbnails ever go
    blank, that's the first thing to check.
- **Legacy Apps Script path** (Download breakdown JSON → paste `.gs` → Sheet menu import) still
  exists for now, including the composite-strip JSON. The Apps Script Execution API ("direct")
  experiment was removed — it needed per-Sheet script setup and hit the COOP popup problem above.

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
