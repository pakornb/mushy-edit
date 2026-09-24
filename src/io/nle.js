// NLE handoff exports (Step 5 of the roadmap) — hand the cut to Resolve/Premiere
// as a project file that references the ORIGINAL full-res source images by
// filename, not by embedding them. The user relinks to their image folder on
// import, same as any offline-media conform; this app has no real filesystem
// path to give it anyway (images are in-memory blobs from a picker/zip).
//
// Targets FCPXML 1.9 — the broadest common denominator both Resolve and
// Premiere can import; a newer/older version may need bumping later if a
// specific NLE rejects something (this hasn't been validated against a real
// Resolve/Premiere import — only checked for well-formed XML and correct
// frame math).
import { project as P, timeline } from '../core/model.js';
import { download } from './base64.js';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// Per-board start/length in whole frames, derived by summing integer frame
// counts (never re-deriving from accumulated float seconds) so there's no
// rounding drift between the exported cut and the app's own timeline.
export function frameCounts(p) {
  const { boards } = timeline(p);
  let acc = 0;
  return boards.map((bd) => {
    const startFrame = acc;
    const frames = Math.max(1, Math.round(bd.len * p.fps));
    acc += frames;
    return { fi: bd.fi, startFrame, frames };
  });
}

export function buildFcpxml(p = P) {
  const fps = Math.max(1, Math.round(p.fps));
  const clips = frameCounts(p);
  const totalFrames = clips.reduce((s, c) => s + c.frames, 0) || 1;
  const fmtId = 'r1';
  const assets = clips.map((c, i) => ({ id: `a${i + 1}`, ...c, name: p.frames[c.fi].name }));

  const resourceXml = assets
    .map((a) => `    <asset id="${a.id}" name="${esc(a.name)}" src="${esc(a.name)}" hasVideo="1" format="${fmtId}" duration="0s"/>`)
    .join('\n');

  const spineXml = assets
    .map((a) => `        <asset-clip name="${esc(a.name)}" ref="${a.id}" offset="${a.startFrame}/${fps}s" duration="${a.frames}/${fps}s" start="0s" format="${fmtId}"/>`)
    .join('\n');

  const seqName = esc(p.baseName);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    <format id="${fmtId}" name="FFVideoFormat${p.resW}x${p.resH}p${fps}" frameDuration="1/${fps}s" width="${p.resW}" height="${p.resH}"/>
${resourceXml}
  </resources>
  <library>
    <event name="${seqName}">
      <project name="${seqName}">
        <sequence format="${fmtId}" duration="${totalFrames}/${fps}s" tcStart="0s" tcFormat="NDF">
          <spine>
${spineXml}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

export function exportFcpxml() {
  if (!P.frames.length) return;
  const xml = buildFcpxml(P);
  download(new Blob([xml], { type: 'application/xml' }), `${P.baseName}.fcpxml`);
}
