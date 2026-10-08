// NLE handoff exports — hand the cut to an editing app as a project/sequence
// it opens natively, with no plug-ins:
//   - FCPXML 1.9 (Resolve, Final Cut): images + audio by bare filename; the
//     user relinks to their own folder on import (verified in Resolve).
//   - FCP7 XML / xmeml (Premiere Pro: File > Import): same idea, same relink.
//   - After Effects: a .jsx script (File > Scripts > Run Script File…) zipped
//     with the images + audio. It builds the comp itself and finds the media
//     next to itself, so there's nothing to relink. Native .aep/.prproj aren't
//     an option: .aep is an undocumented binary and .prproj an undocumented,
//     version-specific format Adobe changes between releases.
// This app has no real filesystem path to give any of them (images are
// in-memory blobs from a picker/zip), hence bare filenames everywhere.
//
// Audio placement matches mp4.js exactly (see audioPlacement): a positive
// offsetSec delays the audio, a negative one trims its head, and it's capped
// at the end of the video. Gain/fades are not carried over yet — set them in
// the NLE.
import JSZip from 'jszip';
import { project as P, timeline, getBoardFit } from '../core/model.js';
import { download } from './base64.js';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// Per-board start/length in whole frames, derived by summing integer frame
// counts (never re-deriving from accumulated float seconds) so there's no
// rounding drift between the exported cut and the app's own timeline.
// Every export calls this first: nothing to hand off if every board is hidden.
function requireBoards(p) {
  if (!frameCounts(p).length) throw new Error('No visible boards to export');
}

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

// Where the audio clip lands, in whole frames: rec = position on the sequence,
// src = position inside the audio file, len = how much of it plays. null when
// there's no audio or none of it falls inside the video.
export function audioPlacement(p, totalFrames) {
  const a = p.audio; if (!a || !a.duration) return null;
  const fps = Math.max(1, Math.round(p.fps));
  const off = Math.round((a.offsetSec || 0) * fps);
  const fileFrames = Math.max(1, Math.ceil(a.duration * fps));
  const rec = Math.max(0, off), src = Math.max(0, -off);
  const len = Math.min(fileFrames - src, totalFrames - rec);
  return len > 0 ? { name: a.name, rec, src, len, fileFrames } : null;
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

  // Audio rides as a connected clip (lane -1) on whichever board is on screen
  // when it starts; a connected clip's offset is in its parent's local time,
  // which for these clips (start=0) is just "frames since the parent began".
  const aud = audioPlacement(p, totalFrames);
  const host = aud && assets.find((a) => aud.rec < a.startFrame + a.frames);
  const audioClip = (a) => (aud && a === host)
    ? `\n          <asset-clip name="${esc(aud.name)}" ref="aud1" lane="-1" offset="${aud.rec - a.startFrame}/${fps}s" duration="${aud.len}/${fps}s" start="${aud.src}/${fps}s"/>\n        `
    : '';
  const spineXml = assets
    .map((a) => {
      const inner = audioClip(a);
      const open = `        <asset-clip name="${esc(a.name)}" ref="${a.id}" offset="${a.startFrame}/${fps}s" duration="${a.frames}/${fps}s" start="0s" format="${fmtId}"`;
      return inner ? `${open}>${inner}</asset-clip>` : `${open}/>`;
    })
    .join('\n');
  const audioAsset = aud
    ? `\n    <asset id="aud1" name="${esc(aud.name)}" src="${esc(aud.name)}" hasAudio="1" audioSources="1" audioChannels="2" start="0s" duration="${aud.fileFrames}/${fps}s"/>`
    : '';

  const seqName = esc(p.baseName);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    <format id="${fmtId}" name="FFVideoFormat${p.resW}x${p.resH}p${fps}" frameDuration="1/${fps}s" width="${p.resW}" height="${p.resH}"/>
${resourceXml}${audioAsset}
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
  requireBoards(P);
  const xml = buildFcpxml(P);
  download(new Blob([xml], { type: 'application/xml' }), `${P.baseName}.fcpxml`);
}

// ---------- Premiere Pro: FCP7 XML (xmeml v4) ----------
// Premiere imports this natively (File > Import). Media comes in offline;
// Link Media → pick the first board and Premiere relinks the rest from the
// same folder.
export function buildPremiereXml(p = P) {
  const fps = Math.max(1, Math.round(p.fps));
  const clips = frameCounts(p);
  const totalFrames = clips.reduce((s, c) => s + c.frames, 0) || 1;
  const rate = `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>`;
  const videoItems = clips.map((c, i) => {
    const name = esc(p.frames[c.fi].name);
    return `            <clipitem id="clipitem-${i + 1}">
              <name>${name}</name><enabled>TRUE</enabled><duration>${c.frames}</duration>${rate}
              <start>${c.startFrame}</start><end>${c.startFrame + c.frames}</end><in>0</in><out>${c.frames}</out>
              <file id="file-${i + 1}"><name>${name}</name><pathurl>${name}</pathurl>${rate}<duration>${c.frames}</duration>
                <media><video><samplecharacteristics><width>${p.resW}</width><height>${p.resH}</height></samplecharacteristics></video></media>
              </file>
            </clipitem>`;
  }).join('\n');
  const aud = audioPlacement(p, totalFrames);
  const audioTrack = aud ? `
        <audio>
          <format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>
          <track>
            <clipitem id="clipitem-a1">
              <name>${esc(aud.name)}</name><enabled>TRUE</enabled><duration>${aud.fileFrames}</duration>${rate}
              <start>${aud.rec}</start><end>${aud.rec + aud.len}</end><in>${aud.src}</in><out>${aud.src + aud.len}</out>
              <file id="file-a1"><name>${esc(aud.name)}</name><pathurl>${esc(aud.name)}</pathurl>${rate}<duration>${aud.fileFrames}</duration>
                <media><audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio></media>
              </file>
              <sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>
            </clipitem>
          </track>
        </audio>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1">
    <name>${esc(p.baseName)}</name>
    <duration>${totalFrames}</duration>${rate}
    <timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>
    <media>
      <video>
        <format><samplecharacteristics>${rate}<width>${p.resW}</width><height>${p.resH}</height><pixelaspectratio>square</pixelaspectratio><anamorphic>FALSE</anamorphic><fielddominance>none</fielddominance></samplecharacteristics></format>
        <track>
${videoItems}
        </track>
      </video>${audioTrack}
    </media>
  </sequence>
</xmeml>
`;
}

export function exportPremiereXml() {
  requireBoards(P);
  download(new Blob([buildPremiereXml(P)], { type: 'application/xml' }), `${P.baseName}_premiere.xml`);
}

// ---------- After Effects: ExtendScript + media, zipped ----------
// ExtendScript is ES3: no let/const/arrows/template literals inside AE_SCRIPT.
// The cut goes in as a JSON literal (valid ES3 object syntax), with non-ASCII
// escaped so the .jsx's own encoding can't mangle filenames.
const AE_SCRIPT = `
(function () {
  var D = __DATA__;
  var here = File($.fileName).parent;
  function fileIn(folder, name) { var f = new File(folder.fsName + '/' + name); return f.exists ? f : null; }
  var folder = here;
  if (!fileIn(folder, D.boards[0].file)) {
    folder = Folder.selectDialog('Mushy Edit: choose the folder with the images for "' + D.name + '"');
    if (!folder) return;
  }
  app.beginUndoGroup('Mushy Edit: ' + D.name);
  var comp = app.project.items.addComp(D.name, D.width, D.height, 1, D.totalFrames / D.fps, D.fps);
  var bin = app.project.items.addFolder(D.name + ' media');
  var cache = {}, missing = [];
  function footage(name) {
    if (cache[name]) return cache[name];
    var f = fileIn(folder, name); if (!f) { missing.push(name); return null; }
    var item = app.project.importFile(new ImportOptions(f)); item.parentFolder = bin;
    return (cache[name] = item);
  }
  for (var i = 0; i < D.boards.length; i++) {
    var b = D.boards[i], item = footage(b.file); if (!item) continue;
    var layer = comp.layers.add(item);
    layer.startTime = b.start / D.fps;
    layer.inPoint = b.start / D.fps;
    layer.outPoint = (b.start + b.frames) / D.fps;
    var sx = D.width / item.width, sy = D.height / item.height;
    var s = b.fit === 'contain' ? Math.min(sx, sy) : b.fit === 'width' ? sx : b.fit === 'height' ? sy : Math.max(sx, sy);
    layer.property('Scale').setValue([s * 100, s * 100]);
  }
  if (D.audio) {
    var a = footage(D.audio.file);
    if (a) {
      var al = comp.layers.add(a);
      al.startTime = (D.audio.rec - D.audio.src) / D.fps;
      al.inPoint = D.audio.rec / D.fps;
      al.outPoint = (D.audio.rec + D.audio.len) / D.fps;
      al.moveToEnd();
    }
  }
  app.endUndoGroup();
  comp.openInViewer();
  if (missing.length) alert('Mushy Edit: ' + missing.length + ' file(s) not found in ' + folder.fsName + ':\\n' + missing.join('\\n'));
})();
`;

export function buildAeScript(p = P) {
  const fps = Math.max(1, Math.round(p.fps));
  const clips = frameCounts(p);
  const totalFrames = clips.reduce((s, c) => s + c.frames, 0) || 1;
  const aud = audioPlacement(p, totalFrames);
  const data = {
    name: p.baseName, width: p.resW, height: p.resH, fps, totalFrames,
    boards: clips.map((c) => ({ file: p.frames[c.fi].name, start: c.startFrame, frames: c.frames, fit: getBoardFit(p, c.fi) })),
    audio: aud && { file: aud.name, rec: aud.rec, src: aud.src, len: aud.len },
  };
  const json = JSON.stringify(data).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  return `// Mushy Edit -> After Effects: "${p.baseName.replace(/[^\x20-\x7e]/g, '?')}". In After Effects choose
// File > Scripts > Run Script File... and pick this file. It builds a comp from
// the images and audio in this same folder (or asks where they are).
` + AE_SCRIPT.replace('__DATA__', () => json);
}

export async function exportAeZip(onProgress = () => {}) {
  requireBoards(P);
  onProgress('Building After Effects script…');
  const zip = new JSZip();
  zip.file(`${P.baseName}_AfterEffects.jsx`, buildAeScript(P));
  const clips = frameCounts(P);
  for (let i = 0; i < clips.length; i++) {
    const f = P.frames[clips[i].fi];
    if (f.full) zip.file(f.name, f.full);
    onProgress(`Adding boards… ${i + 1}/${clips.length}`);
  }
  if (P.audio && P.audio.blob) zip.file(P.audio.name, P.audio.blob);
  onProgress('Zipping…');
  const blob = await zip.generateAsync({ type: 'blob' }, (m) => onProgress(`Zipping… ${Math.round(m.percent)}%`));
  download(blob, `${P.baseName}_AfterEffects.zip`);
}
