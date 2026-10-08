# Mushy Edit

A browser-based tool for timing storyboards, reviewing them as an animatic, and
exporting a shot and asset breakdown to Google Sheets. It does timing, review and
handoff; it is deliberately not a compositing editor, so there is no per-image
move, scale, rotate or crop. Framing is controlled with fit modes.

It is served inside the Hornet Tools Dashboard at `/mushy-edit/`. It also deploys
standalone to Vercel (`vercel.json`). The two are one codebase built for two targets; see
[Build targets](#build-targets).

## What it does

### Load a storyboard
Drop a zip, a set of images, an image sequence or a saved work file. Boards are
grouped into shots by filename (for example `MCDS_10_001` becomes shot `MCDS_10`) or by
detected cuts. A frame splitter (`/frame-splitter.html`, opened from the start screen's
**Split a storyboard sheet**) cuts a storyboard sheet into individual frames. Everything
the user does is keyed by filename, so reloading updated art with the same names keeps the
edit.

### Time it
- The timeline is one surface: tiles are boards with width proportional to time, shots
  appear as colored stripes, a draggable playhead scrubs frame by frame, and dragging on the
  ruler marquee-selects a range. Zoom with `+`/`-` or Ctrl/Cmd + wheel.
- **Retiming:** each board's duration in seconds is the source of truth, and a shot's
  length is the sum of its enabled boards. Drag a tile vertically to change its duration
  (neighbors flex), or horizontally to slide it ("mushy" offset). Multiple boards can be
  scaled together. Neighbors are weighted by distance from the edited selection through a
  *falloff* control (reach slider and a curve: smooth, linear, ease-in, ease-out);
  Shift doubles the reach.
- **Pins** (`p`) are hard walls: a pinned board never changes, and edits are capped at
  the available slack between pins.
- **Spot length** is soft: a target length (default 30 s) with a budget meter. **Auto**
  gives unpinned boards an equal share (it runs automatically on a fresh load) and
  **Rebalance** scales unpinned boards to hit the spot exactly.
- Hide or show a board (`h`), cut or merge shots (`c`, **Cut**), and re-enable hidden
  items from their timeline markers. Shots can be grouped by detected cuts or filename,
  with length shown in seconds or frames.
- Frame rate (`fps`), spot length and output resolution (presets including 1080p, 4K UHD,
  2048x1152, 720p, 1440p, 4:3, square, vertical and 2.35:1, or custom with a lock) are set
  in the header.
- Undo and redo cover edits (`Cmd/Ctrl+Z`, with Shift to redo).

### Fit and preview
The preview is a canvas drawn with the same fit logic as mp4 export and the viewer, so
all three match. Fit modes: cover (default, crops the long side), contain (bars), fit
width, fit height. A mode can be set globally and overridden per board.

### Audio
Load a scratch audio track with a waveform, frame-accurate slip (-1f, -0.1s, +0.1s, +1f),
in and out trimming, **set sync to playhead** and **use audio length**.

### Annotate
Draw vector annotations on a board. Strokes are stored relative to the image, so they stay
in place under any fit mode, and they appear in the preview, the mp4 and the viewer.

### Shots, tasks, notes and assets
The inspector shows a filmstrip of the selected shot and per-shot sections for Shot,
Tasks and Notes. The **Assets** window tracks assets by category (character, set, prop)
against shots. **Preview sheet** shows the breakdown as an HTML sheet.

### Save and open
**Save** writes `<name>_work.animatic.json`, a work file embedding the full-resolution boards,
audio and all state. **Open** restores it.

### Export
- **Export mp4 (final)** and **Export mp4 (draft, fast; max width 960)**, rendered in the
  browser with ffmpeg.wasm. Frames are fitted to the output resolution and the audio is
  muxed at its slip offset.
- **Export review viewer:** a viewer JSON (thumbnails, timing, annotations, audio) that
  opens in the read-only player at `/view.html`, which also loads `?src=<url>`.
- **Export to Google Sheet / Update Google Sheet:** see below (Hornet build). The
  standalone build instead has **Download breakdown JSON** and **Copy Apps Script**: paste
  the script into a Sheet's Extensions → Apps Script once, then import the JSON from the
  "Sequence Breakdown" menu it adds.

### Google Sheet breakdown
The export adds the shot and asset breakdown as a new tab in a Sheet the user picks (or
creates) in their Drive, with the Sheet link shown right away and pictures filled in
afterwards:

1. The text, layout, column widths and row heights are written in one batch.
2. Each row's thumbnail is uploaded to a "Mushy Edit thumbnails" Drive folder (shared by
   link once) and `=IMAGE()` formulas are written into the picture cells.
3. A centrally deployed Apps Script (`apps-script/embed/`, called through `scripts.run`
   with the user's token) swaps those formulas for in-cell images, and the temporary
   Drive files are then deleted. If embedding fails the links stay and a notice says so;
   if picture upload fails the Sheet stays text-only.

**Update Google Sheet** re-exports to the same tab (the spreadsheet and tab ids are saved in
the work file). It matches rows by Name, refreshes the picture and Length only (Shot, Notes
and task values are untouched), appends new shots, and flags shots no longer in the
storyboard in red as "[not in latest]" while keeping their last picture.

Scopes are `drive.file` and `spreadsheets`.

## Sign-in for Sheets

Google access goes through `public/google-connect.html`, which has to run without
cross-origin isolation (the editor's isolation headers would sever the sign-in popup).
Behind the dashboard it first calls `GET /api/auth/google/mushy-sheets-token` to reuse the
Hornet session silently: a 200 returns a token with no Google interaction, a 409 redirects
once through `/api/auth/google/mushy-sheets-connect` for a one-time consent whose refresh
token the dashboard stores, and a 401 redirects to `/login`. Anywhere else (standalone
Vercel, local) it falls back to a "Continue with Google" button. Only choosing a Sheet
with Google's Picker opens a window; "Use current Sheet" and "Create new" do not.

## Keyboard

`Space` play/pause, `Left/Right` board, `Alt+Left/Right` shot, `Cmd/Ctrl+Left/Right` start or
end, `Shift+Left/Right` extend selection, `Up/Down` retime selected (Shift = 2x reach),
`h` hide/show, `p` pin, `c` cut/merge, `+`/`-` zoom, `Cmd/Ctrl+Z` undo, `Esc` closes a
modal, leaves annotate mode or clears the selection. The mp4 button shows a badge reporting
whether the page is cross-origin isolated ("isolated, mp4 ready").

## Development

```bash
npm install
npm run dev       # http://localhost:5173 (editor), /view.html (viewer)
npm run build     # standalone build (Vercel), outputs dist/
npm run build:hornet  # Hornet build (dashboard), outputs dist/
npm run dev:hornet    # dev server with the Hornet build's look and export
npm run preview   # serves the build with the isolation headers
npm run deploy    # Hornet build, then wrangler deploy
```

- Vite with vanilla JavaScript; dependencies are `@ffmpeg/ffmpeg` 0.12.10, `@ffmpeg/util`
  0.12.1 and `jszip`. mp4 export uses the single-thread `@ffmpeg/core` 0.12.6 loaded from
  unpkg; the multithread core fails at run time with this wrapper version.
- `src/core/` holds the model (timing, shots, retiming, history) and frame ingest;
  `src/editor/` the editor UI; `src/io/` work files, audio, mp4, viewer and Google Sheets;
  `src/viewer/` the viewer.
- ffmpeg.wasm needs `SharedArrayBuffer`, so every page except `google-connect.html` is
  served with `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` (in `vercel.json`, `worker.js` and the
  dev server).
- For the dashboard deploy, `vite.config.js` sets `base` to `/mushy-edit/` for Hornet
  builds, so any code that opens another page must use a relative path.

### Build targets

`VITE_TARGET` picks the target at build time:

| | `VITE_TARGET=hornet` (dashboard) | unset (standalone, Vercel) |
|---|---|---|
| Look | Hornet brand kit | original palette, no logo |
| Sheet export | direct Google Sheets export | breakdown JSON + Apps Script (`src/io/appsScript.js`) |
| `base` | `/mushy-edit/` | `/` |

Everything else is shared. `main.js` branches on the `__HORNET__` constant; in
`index.html`/`view.html`, a line tagged `data-only="hornet"` or `data-only="standalone"` is
kept only in that build; and the standalone build sets `<html data-brand="classic">`, which
`src/style.css` uses to restore the original palette in its final block. A new rule that
hardcodes a brand color needs its classic value added there too.

## Deployment

`worker.js` (Worker `hornet-mushy-edit`) strips the `/mushy-edit` prefix, serves `dist/`, redirects
a bare `/mushy-edit` to add the trailing slash, and applies the isolation headers to everything
except `/google-connect.html` and `/google-connect`. It has no routes; it is reached only
through the dashboard's `MUSHY_EDIT` service binding.

- Push to `main` runs `.github/workflows/deploy-cloudflare.yml` (Hornet build). Both
  workflows run only in `hornet-animation/mushy-edit`, so the standalone copy doesn't try to
  deploy to Cloudflare.
- Push to `preview` runs `.github/workflows/preview.yml`, deploying
  `hornet-mushy-edit-preview`.
- Both need the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` Actions secrets.
- The Google OAuth client id, Picker API key, app id and Apps Script deployment id are
  non-secret constants in `src/io/googleSheets.js`. Serving from a new origin requires adding
  it to the OAuth client's authorized JavaScript origins and the API key's website
  restrictions.
