import { resolve } from 'path';
import { defineConfig } from 'vite';

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

export default defineConfig({
  plugins: [isolation],
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
});
