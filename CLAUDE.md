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
- **Two build targets, one codebase — `VITE_TARGET`** (see README "Build targets"):
  unset = **standalone/Vercel** (original look, legacy breakdown-JSON + Apps Script export,
  `base:'/'`); `hornet` = **dashboard/Cloudflare** (brand kit, direct Sheets export,
  `base:'/mushy-edit/'`) — `npm run build:hornet` / `dev:hornet`, used by both Cloudflare
  workflows and `npm run deploy`. Mechanism: `__HORNET__` define in `main.js`
  (`wireGoogleSheets()` vs `wireLegacySheets()`); `data-only="hornet|standalone"` lines in
  the HTML, filtered by the `brandHtml` plugin in `vite.config.js`; `<html data-brand=classic>`
  + the final block of `style.css` for the old palette. **Keep both targets building** — check
  `npm run build` AND `npm run build:hornet` before committing. The same `main` is pushed to
  both `origin` (pakornb) and `hornet` (hornet-animation); don't fork the code per repo.
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
  the primary/active role instead of introducing an off-palette color. Two places
  this mattered functionally: `.slot.c0`/`.c1`'s alternating shot-stripe colors
  use Sky and **Sand Dune** (not Jade — Jade is `--good`, the pinned color, and
  made pinned boards hard to spot), and the **current board** (`.slot.active`)
  is outlined in white, declared after `.slot.selected`, since a `--cut`
  outline looked identical to "selected".
- **Digits are tabular** (`font-variant-numeric:tabular-nums` on `body`; PP Neue
  Montreal has `tnum`) so the clock and counters don't jitter during playback.
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
- **`vite.config.js`'s `base`** is `/mushy-edit/` for `VITE_TARGET=hornet vite build`
  (the dev server and the standalone build stay at `/`) — Vite bakes that prefix into every built HTML's
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
- **Standalone build:** the legacy path below ("Removed (2026-09-28)") is restored for the
  standalone/Vercel target only — `exportBreakdownJSON` (assets.js), `src/io/appsScript.js`,
  "Download breakdown JSON" + "Copy Apps Script". Everything below this bullet is the Hornet build.
- **Google Sheets export ("Export to Google Sheet…" / "Update Google Sheet") — Hornet build.**
  No per-user Apps Script setup. `src/io/googleSheets.js` + `public/google-connect.html`. The user
  signs in, picks any Sheet in their Drive with Google's Picker (or creates one), and the breakdown
  is added as a new tab. The text/layout `batchUpdate` (headers, values, column widths, row heights
  — all known locally, nothing Drive-dependent) runs first and the function returns as soon as it
  lands, so the result modal and its Sheet link show up immediately, with empty picture cells.
  Pictures then happen in two further stages, both **entirely in the background** (`images`/
  `embedding` promises on the result — `main.js`'s `runSheets` awaits them after showing the link,
  only to toast success/failure):
  1. **Fast links:** upload each row's thumbnail to a "Mushy Edit thumbnails" folder in the user's
     Drive (parallel, `UPLOAD_CONCURRENCY`), then a second small `batchUpdate` drops `=IMAGE(url, 4,
     h, w)` formulas into the picture cells. The folder is shared "anyone with the link" **once**
     (`ensureFolderShared` — checks first, so repeat exports don't re-grant it) rather than every
     file individually; files created in a link-shared folder inherit its read access, so this is
     half the Drive API calls per-file sharing cost. An "Update" only touches a matched row's
     picture cell once its replacement is ready — never blanks it in between.
  2. **Embed (background):** `embedPictures()` calls the Apps Script in `apps-script/embed/` via
     `scripts.run` with the user's token. It swaps each `=IMAGE()` for an in-cell image
     (`newCellImage().setSourceUrl()`), reads back which cells took, and the app deletes those Drive
     files — so no public links remain. Failure never rejects: links just stay, and a toast says so.
  - **If picture upload itself fails** (stage 1), the Sheet still stands, text-only — `images`
    resolves `{error}` instead of throwing, and `embedding` short-circuits to a no-op result rather
    than trying to embed nothing.
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
  - **No window at all in the common case (2026-09-28).** "Where should the breakdown go?" (Use
    current Sheet / Choose a Sheet / Create new) is an **inline modal** in the editor itself
    (`assets.js`'s `chooseSheetDestination`), not part of the helper window — because getting a
    token is now usually just a background fetch (below), only "Choose a Google Sheet…" (Picker)
    still needs a window at all; "Use current"/"Create new" never open one. `googleSheets.js`'s
    `ensureToken()` is the entry point every caller should use to get a token — it returns the
    cached one if still valid, then tries the silent fetch below, and only falls through to
    `openConnect({mode:'signin'})` (a window) for the genuinely unavoidable cases. `openConnect()`
    itself now takes only `mode: 'signin' | 'pick'` — `'signin'` hands back just a token (no Picker
    UI), `'pick'` gets a token the same way then goes straight into Picker with no intermediate
    button. **Popup-gesture timing matters even for the one window that remains:** `chooseSheetDestination`
    takes callbacks rather than returning a Promise specifically so its "Choose a Google Sheet…"
    button can call `openConnect()` (`window.open`) synchronously inside its own click — going
    through even one microtask of `await` first (e.g. resolving a Promise from the modal, then
    calling `openConnect` in the continuation) risks the browser no longer treating the eventual
    `window.open()` as tied to a real user gesture and blocking it. This bit the original design
    more than once; see the git history around 2026-09-25 through 2026-09-28 if it needs debugging.
  - **Why the Picker window still needs to exist at all:** the editor's `Cross-Origin-Opener-Policy:
    same-origin` (ffmpeg.wasm needs it) severs the link to any cross-origin popup, so Google's
    sign-in popup could never return its token — it opened, you approved, it closed, nothing
    happened, in every browser. COEP `require-corp` also blocks the Picker iframe outright, with no
    workaround — this is the one piece that can't move inline regardless of the SSO work below.
    `google-connect.html` is served WITHOUT COOP/COEP (exempted in `vite.config.js`, `vercel.json`,
    and `worker.js` — **both the `.html` and extension-less spellings**, see the Cloudflare gotcha
    note near the top of this file) and reports back over `BroadcastChannel("mushy-google")`, which
    same-origin windows share regardless of COOP.
  - **Sign-in itself, when behind tools-dashboard:** `google-connect.html` shows no UI at all by
    default — on load it tries `GET /api/auth/google/mushy-sheets-token` (tools-dashboard's
    `auth.js`, `credentials:'include'`) to reuse the Hornet dashboard session silently. `200` →
    token in hand, straight to Picker (`mode:'pick'`) or straight back to the opener
    (`mode:'signin'`) — no Google interaction at all. `409` → no Google refresh token stored for
    this user yet → this window redirects itself to
    `/api/auth/google/mushy-sheets-connect?next=<its own URL, params intact>`, which shows Google's
    consent screen **once, ever**, stores the refresh token server-side, and redirects back here to
    retry (now succeeding). `401` → not signed into Hornet at all → redirects to `/login`. Any other
    response (typically a 404, since the route simply doesn't exist there) → falls back to the
    original per-tab "Continue with Google" button — this is what keeps the standalone Vercel
    deploy and local dev working, since neither is behind tools-dashboard's session/cookie. A
    `pagehide` listener treats an unexpected window close as "cancelled," so these *intentional*
    same-window redirects set a `navigating` flag first (`redirectTo()`) — forgetting that turns
    every real consent flow into a spurious "Cancelled." error. A failed/denied consent comes back
    as `?sheetsError=1` (mirrors Slide Media Extractor's own `slidesError` convention) — checked
    before ever retrying the silent path again, or a denied grant would redirect straight back into
    another doomed consent attempt forever.
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
8. **Rework resolution presets** (`index.html` header: `resPreset` select, `resW`/`resH` number
   inputs, `resLock` aspect-lock checkbox) — noted for later, NOT started.
   - Add a **% scale** option — scale the current `resW`×`resH` by a percentage rather than only
     jumping to a fixed preset. Needs deciding: scale relative to the *current* resolution, or to
     the source images' native resolution (`resW`/`resH` default to the largest source image, per
     `frames.js` `ingest()` — "scale to 50% of source" and "scale to 50% of current" aren't always
     the same value once the user has already changed it).
   - Add a **flip XY** option — swap `resW`/`resH` in one action (e.g. 1920×1080 ↔ 1080×1920) for
     switching landscape/portrait without retyping both fields. Straightforward once scoped: swap
     the two values, keep `resLock`'s aspect ratio in sync (it's derived from `resW/resH` — see
     `resAspect` in `main.js`), and call `layoutPreview()` same as the existing `resW`/`resH`/
     `resPreset` change handlers already do.

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
