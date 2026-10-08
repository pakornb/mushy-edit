import { resolve } from 'path';
import { defineConfig, loadEnv } from 'vite';

// COOP/COEP make SharedArrayBuffer available, which ffmpeg.wasm needs.
// These headers apply to the Vite dev server; Vercel gets them via vercel.json.
// google-connect.html is exempt: COOP cuts the link to Google's sign-in popup
// and COEP blocks Google's file-picker iframe, so that helper window runs
// without isolation and reports back to the editor over a BroadcastChannel.
const setIsolation = (req, res, next) => {
  if (!(req.url || '').startsWith('/google-connect.html')) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  }
  next();
};
const isolation = {
  name: 'cross-origin-isolation',
  configureServer(server) { server.middlewares.use(setIsolation); },
  configurePreviewServer(server) { server.middlewares.use(setIsolation); },
};

// Two build targets from one codebase (VITE_TARGET, read from the env or a
// .env file):
//   - 'hornet': the Cloudflare/tools-dashboard deploy — Hornet brand kit,
//     direct Google Sheets export (googleSheets.js), served under /mushy-edit/.
//   - anything else (default): the standalone Vercel deploy — the original
//     look, the legacy breakdown-JSON + Apps Script export, served at /.
// Main.js branches on the __HORNET__ constant; the HTML is filtered by the
// plugin below, which drops any line tagged data-only="<the other target>"
// and stamps <html data-brand> so style.css can scope the classic palette.
const brandHtml = (hornet) => ({
  name: 'brand-html',
  transformIndexHtml(html) {
    const other = hornet ? 'standalone' : 'hornet';
    return html
      .split('\n').filter((l) => !l.includes(`data-only="${other}"`)).join('\n')
      .replace(/ data-only="(hornet|standalone)"/g, '')
      .replace('<html lang="en">', `<html lang="en" data-brand="${hornet ? 'hornet' : 'classic'}">`);
  },
});

export default defineConfig(({ command, mode }) => {
  const hornet = loadEnv(mode, process.cwd(), '').VITE_TARGET === 'hornet';
  return {
    plugins: [isolation, brandHtml(hornet)],
    define: { __HORNET__: JSON.stringify(hornet) },
    // On the Hornet target this app is served under tools.hellohornet.com/mushy-edit/
    // (see worker.js, which strips that prefix before forwarding to the
    // ASSETS binding) — so the built HTML's asset URLs need the prefix baked
    // in, or the browser requests them from site root and misses the dashboard's
    // proxy route entirely. The dev server has no such prefix, so it stays at '/'.
    // The standalone (Vercel) build is served at site root.
    base: hornet && command === 'build' ? '/mushy-edit/' : '/',
    // ffmpeg.wasm ships as an ESM worker; don't pre-bundle it
    optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] },
    build: {
      target: 'es2020',
      rollupOptions: {
        input: {
          editor: resolve(__dirname, 'index.html'),
          viewer: resolve(__dirname, 'view.html'),
        },
      },
    },
  };
});
