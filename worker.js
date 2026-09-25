// Cloudflare Worker: strips the /mushy-edit prefix tools-dashboard proxies
// under (see tools-dashboard's worker.js `routes` + this Worker's own
// `services` binding there) and serves the Vite build from `dist/` via the
// ASSETS binding — same pattern as hornet-slide-media-extractor's worker.js.
//
// No `routes` in wrangler.jsonc on purpose: tools-dashboard owns the whole
// tools.hellohornet.com zone and reaches this Worker only through its
// MUSHY_EDIT service binding. A route declared here would take precedence
// over that (Cloudflare picks the more specific zone route), bypassing
// tools-dashboard's central Google-SSO gate entirely.
const BASE = '/mushy-edit'

// ffmpeg.wasm needs SharedArrayBuffer, which needs these two headers (see
// CLAUDE.md's "The 'cross-origin isolation' problem" note and
// vite.config.js, which does the same thing for local dev). Every response
// through this Worker gets them EXCEPT google-connect.html, whose whole job
// is to run without cross-origin isolation so Google's sign-in popup and
// Picker iframe still work — see src/io/googleSheets.js.
function withIsolation(response) {
  const headers = new Headers(response.headers)
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url)
    if (!incoming.pathname.startsWith(BASE)) return new Response('Not found', { status: 404 })

    // The app's own JS opens google-connect.html/frame-splitter.html with a
    // *relative* URL (see src/io/googleSheets.js, src/editor/main.js) so it
    // works both here (under /mushy-edit/) and in local dev (at site root).
    // That only resolves correctly if the page itself was loaded with the
    // trailing slash, so force it before anything else runs.
    if (incoming.pathname === BASE) {
      const to = new URL(request.url)
      to.pathname = `${BASE}/`
      return Response.redirect(to.toString(), 302)
    }

    const assetUrl = new URL(request.url)
    assetUrl.pathname = incoming.pathname.slice(BASE.length) || '/'
    let response = await env.ASSETS.fetch(new Request(assetUrl, request))

    const location = response.headers.get('location')
    if (location && location.startsWith('/')) {
      const headers = new Headers(response.headers)
      headers.set('location', `${BASE}${location}`)
      response = new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    }

    if (assetUrl.pathname === '/google-connect.html') return response
    return withIsolation(response)
  },
}
