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
  page (Google sign-in); see Google Sheet export. **Cloudflare Worker gotcha:**
  `wrangler.jsonc`'s `html_handling: "auto-trailing-slash"` actually renders
  `google-connect.html`'s content at the extension-less `/google-connect`, not the
  `.html` path — the isolation-header exemption in `worker.js` has to match both
  spellings, or the rendered page silently gets the headers anyway (broke sign-in
  on 2026-09-28: "Sign-in was closed or blocked (popup_closed)").
- Deps are intentionally minimal: `@ffmpeg/ffmpeg@0.12.10`, `@ffmpeg/util@0.12.1`,
  `jszip`. **Do not bump the ffmpeg versions** (see mp4 note below).

## Branding (2026-09-28)
Pulled from `hornet-animation/ui-toolkit` (`guidelines.md` is the full reference —
read it before touching colors/type/logo here). All of `src/style.css`'s `:root`
tokens, plus `google-connect.html`'s own separate inline copy, now resolve to the
brand's 8-color palette and PP Neue Montreal (fonts/logo copied into
`public/brand/`, same layout as tools-dashboard's own `public/brand/`).
- **`--mono` is no longer a monospace stack** — it's set to the same PP Neue
  Montreal value as `--sans`. Kept the variable *name* rather than rename every
  `font-family:var(--mono)` call site (there are ~70) — the brand guide is one
  typeface, no exception carved out for tabular/numeric UI (the timecode clock,
  frame counters). If that turns out to hurt legibility for fast-changing digits,
  revisit as a deliberate, separate decision — don't silently reintroduce a
  monospace stack under the same variable name.
- **`--cut` and `--head` share one value (Bright Sky `#00BBF4`)**, not the two
  unrelated hues (orange/blue) this file used before. The brand palette only has
  3 accents + Sand Dune; the guide's own suggested functional mapping (info/
  primary → Sky, success → Jade, warning → Sand Dune, danger → Fuchsia) covers
  exactly 4 roles, so the old 5th "primary CTA / cut-marker" hue got folded into
  the primary/active role instead of introducing an off-palette color. The one
  place this mattered functionally — `.slot.c0`/`.c1`'s two alternating shot-
  stripe colors, previously the old head-blue/cut-orange — now use Sky and Jade
  directly so the two bands stay visually distinct.
- **`--danger` is new**, Hot Fuchsia, used only by `.btn.ghost.sm.danger` — the
  one genuinely destructive-action button. Everything else that used to share
  `--cut`'s orange (the "off"/disabled state, cut-tags, the primary button, the
  play button) stays on the primary accent, per the guide's rule that the danger
  color must never be reused elsewhere or it stops reading as a reliable signal.
- **Text opacity follows the guide's tiers exactly**: `--text` white 100%,
  `--muted` white 86% (captions/metadata), `--faint` white 72%. There is
  deliberately no third, dimmer tier — the guide calls out 60% as already
  reading like flat gray on black even though it's technically white+alpha.
  Panel surfaces (`--panel`/`--panel2`) are near-black, not a separate off-
  palette gray, for the same reason.
- **Logo**: `public/brand/logos/hornet-logo-white.svg` (logomark only — the kit
  ships no horizontal wordmark lockup) in the header next to "Mushy Edit", both
  in `index.html` and `view.html`, plus `google-connect.html`'s own header.
  Favicon is `public/logo.png` (same file tools-dashboard uses for its own).
- **Not rebranded**: `public/frame-splitter.html`. It's a separate, much larger,
  self-contained tool with its own established multi-scheme design system (dark/
  amber/cyan) — its own comment says it deliberately matches "the house style of
  your other browser tools," not this repo's brand pass. Revisit as its own task
  if it should follow the Hornet brand kit too.

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
- `src/editor/assets.js` — asset tracker window, HTML **sheet preview**, Google Sheet
  export, montage builder. `buildBreakdownData()` is async (composites asset thumbs).
- `src/io/workfile.js` — the **work file** (`<base>_work.animatic.json`): embeds full-res
  boards + audio + ALL state; reopenable source of truth. `base64.js` helpers.
- `src/io/audio.js` — decode audio → waveform peaks; keeps the original `blob` (used by mp4 + viewer).
- `src/io/mp4.js` — **ffmpeg.wasm** mp4 export (see note). Draft (`maxW:960`) vs final.
- `src/io/viewer.js` — builds/export the viewer JSON (thumbnails + timing + annos + audio).
- `src/viewer/main.js` + `view.html` — the read-only review player (loads a viewer JSON;
  `?src=<url>` also works).
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
- **Google Sheets export ("Export to Google Sheet…" / "Update Google Sheet") — the only path.**
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
    `google-connect.html` is served WITHOUT COOP/COEP (exempted in `vite.config.js`, `vercel.json`,
    and `worker.js` — **both the `.html` and extension-less spellings**, see the Cloudflare gotcha
    note near the top of this file) and reports back over `BroadcastChannel("mushy-google")`, which
    same-origin windows share regardless of COOP. `openConnect()` must run synchronously inside the
    click (it calls `window.open`) — await anything first and the popup is blocked.
  - **Sign-in itself, when behind tools-dashboard (2026-09-28):** `google-connect.html` no longer
    shows its own "Continue with Google" button first — on load it tries
    `GET /api/auth/google/mushy-sheets-token` (tools-dashboard's `auth.js`, `credentials:'include'`)
    to reuse the Hornet dashboard session silently. `200` → token in hand, straight to Picker/create
    (or, for `mode:'signin'`, straight back to the opener) — no Google interaction at all. `409` →
    no Google refresh token stored for this user yet → this window redirects itself to
    `/api/auth/google/mushy-sheets-connect?next=<its own URL, params intact>`, which shows Google's
    consent screen **once, ever**, stores the refresh token server-side, and redirects back here to
    retry (now succeeding). `401` → not signed into Hornet at all → redirects to `/login`. Any other
    response (typically a 404, since the route simply doesn't exist there) → falls back to the
    original per-tab Google popup below — this is what keeps the standalone Vercel deploy and local
    dev working, since neither is behind tools-dashboard's session/cookie. A `pagehide` listener
    treats an unexpected window close as "cancelled," so these *intentional* same-window redirects
    set a `navigating` flag first (`redirectTo()`) — forgetting that turns every real consent flow
    into a spurious "Cancelled." error. A failed/denied consent comes back as `?sheetsError=1`
    (mirrors Slide Media Extractor's own `slidesError` convention) — checked before ever retrying
    the silent path again, or a denied grant would redirect straight back into another doomed
    consent attempt forever.
  - **Server side (tools-dashboard):** `worker/routes/auth.js`'s `INCREMENTAL_SCOPES.'mushy-sheets'`
    (`toolId: 'mushy-edit'`, scope `drive.file` + `spreadsheets`) — the exact same mechanism Slide
    Media Extractor's own incremental Slides scope already used, generalized to share one
    implementation instead of two copies. Gated on the `mushy-edit` tool grant, same as the page
    itself. The refresh token is stored per-user, one per user total (`google_refresh_token:<email>`
    in tools-dashboard's `MATRIX` KV) — covers the union of every scope that user has ever granted
    across *any* tool using this mechanism (`include_granted_scopes:true`), so granting Slides then
    Mushy Sheets (or vice versa) never overwrites with a narrower grant. Never sent to the browser;
    only ever exchanged for a short-lived access token server-side.
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
- **Removed (2026-09-28):** the legacy Apps Script path (Download breakdown JSON → paste `.gs` →
  Sheet menu import, including the composite-strip JSON variant) and the "Copy Apps Script" button
  — both were stand-ins for direct Sheets export before it existed. `src/io/appsScript.js`,
  `exportBreakdownJSON`/`exportBreakdownCompositeJSON`/`buildBreakdownDataComposite`/`buildStrip`
  in `assets.js`, and the three corresponding Export-menu buttons are gone. `buildBreakdownData()`
  (the non-composite one) stays — the direct export still uses it.

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
