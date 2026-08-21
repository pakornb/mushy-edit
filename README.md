# Mushy Edit

Storyboard breakdown → animatic playback → mp4 / review viewer, plus the
Google-Sheet time/task-estimation export. Vite + vanilla JS, deployed on Vercel.
ffmpeg.wasm mp4 export requires cross-origin isolation (COOP/COEP), which is why
this ships as a hosted app rather than a single HTML file — the headers are set
in `vercel.json` and in the Vite dev server.

## What's in this step (step 1 — deployable skeleton)

- Vite project with two entries: `index.html` (editor) and `view.html` (viewer).
- `vercel.json` with COOP/COEP headers so `SharedArrayBuffer` / ffmpeg.wasm work once hosted.
- Image + zip loading, filename shot-grouping (`MCDS_10_001` → shot `MCDS_10`) or diff-cut grouping.
- A proportional timeline (block width = shot length) with a 30s target marker, live preview, fps control.
- An isolation badge that tells you whether mp4 export will be available.

Coming next: work-file save/open, single-shot inspector, playback transport,
scratch audio with frame-accurate slip + in/out, mp4 export, the viewer player,
and the ported Google-Sheet export.

## Run locally

```bash
npm install
npm run dev        # http://localhost:5173  (editor)
                   # http://localhost:5173/view.html  (viewer)
```

`npm run build` outputs `dist/`; `npm run preview` serves the build with the
isolation headers so you can test mp4 export locally before deploying.

## Deploy: GitHub + Vercel (same flow as the GIF Maker)

### 1. Create the repo and push

From this folder:

```bash
git init
git add .
git commit -m "Mushy Edit step 1: scaffold + timeline + isolation headers"
```

Create an empty repo on GitHub (no README/gitignore — this folder has them),
then:

```bash
git branch -M main
git remote add origin https://github.com/<you>/mushy-edit.git
git push -u origin main
```

### 2. Import into Vercel

1. vercel.com → **Add New… → Project** → import the `mushy-edit` repo.
2. Framework preset: **Vite** (auto-detected). Build command `npm run build`,
   output dir `dist` — both default, leave them.
3. **Deploy.** First build takes ~1 min.

### 3. Verify isolation (this is the mp4-critical bit)

Open the deployed URL. The header badge should read **"isolated ✓ mp4 ready"**.
If it says "not isolated", the COOP/COEP headers aren't reaching the browser —
check that `vercel.json` is at the repo root and redeploy. You can confirm in
DevTools → Network → the document response should carry
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`.

### 4. The viewer

The read-only viewer is the same deployment at `/view.html`. Once step 4 lands,
you'll share either a viewer-JSON file or a link, and reviewers open it there —
no editing, no export.

## Project layout

```
index.html            editor entry
view.html             viewer entry
vercel.json           COOP/COEP headers (required for ffmpeg.wasm)
vite.config.js        two entries + dev-server isolation headers
src/
  core/    model.js (state, timing, fps math), frames.js (ingest)
  editor/  main.js (load, timeline, preview) — grows into the full editor
  viewer/  main.js (read-only player — step 4)
  io/      workfile / viewer-json / mp4 / audio — steps 2–4
  estimation/  Google-Sheet export (ported next)
  style.css
```
