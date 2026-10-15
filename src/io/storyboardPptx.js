// Storyboard sheet as a .pptx: same grid as the PNG export (storyboardSheet.js
// layout()), but every board is its own picture with a live, editable text
// box (number + caption) under it, one 16:9 slide per page. Pictures are the
// full source image with a crop (srcRect) to the project's frame, so the crop
// can be re-adjusted in Slides/PowerPoint. Used both as a
// plain download and as the upload that Drive converts into a native Google
// Slides deck (googleSheets.js createSlidesFromPptx) — conversion only needs
// the drive.file scope we already have, so no Slides API / new consent.
//
// Hand-rolled minimal OOXML (one master, one blank layout, one theme) with the
// existing jszip dep rather than a pptx library.
import JSZip from 'jszip';
import { project as P, getAnnos, getBoardFit, fitRect } from '../core/model.js';
import { drawAnnos } from '../core/annotate.js';
import { sheetSettings, sheetBoards, paginate, layout, cellPos, inkFor, imageCache, toBlob } from './storyboardSheet.js';

const W = 1920, H = 1080;             // layout space (px); the slide is 16:9
const EMU = 12192000 / W;             // 13.333in slide width / 1920px
const PT = 960 / W;                   // slide is 960pt wide
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument.presentationml';
const FONT = 'Arial';
const MAX_SRC = 2560;                 // long-side cap for embedded full images (file size)

const esc = (t) => String(t).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const e = (px) => Math.round(px * EMU);
const hex = (c) => c.replace('#', '').toUpperCase();
const rels = (list) => `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
const xfrm = (x, y, w, h) => `<a:xfrm><a:off x="${e(x)}" y="${e(y)}"/><a:ext cx="${e(w)}" cy="${e(h)}"/></a:xfrm>`;
const emptyTree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';

const fills = (n, inner) => Array(n).fill(inner).join('');
const THEME = `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Mushy Edit"><a:themeElements>
<a:clrScheme name="Mushy Edit"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F1F1F"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2>${['00BBF4', '00A878', 'D9B48F', 'E5007E', '666666', '999999'].map((c, i) => `<a:accent${i + 1}><a:srgbClr val="${c}"/></a:accent${i + 1}>`).join('')}<a:hlink><a:srgbClr val="00BBF4"/></a:hlink><a:folHlink><a:srgbClr val="999999"/></a:folHlink></a:clrScheme>
<a:fontScheme name="Mushy Edit"><a:majorFont><a:latin typeface="${FONT}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${FONT}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="Mushy Edit"><a:fillStyleLst>${fills(3, '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>')}</a:fillStyleLst><a:lnStyleLst>${fills(3, '<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>')}</a:lnStyleLst><a:effectStyleLst>${fills(3, '<a:effectStyle><a:effectLst/></a:effectStyle>')}</a:effectStyleLst><a:bgFillStyleLst>${fills(3, '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>')}</a:bgFillStyleLst></a:fmtScheme>
</a:themeElements></a:theme>`;
const MASTER = `${XML}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${emptyTree}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`;
const LAYOUT = `${XML}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${emptyTree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

function run(text, sz, color, bold) {
  return `<a:r><a:rPr lang="en-US" sz="${sz}"${bold ? ' b="1"' : ''} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${FONT}"/></a:rPr><a:t>${esc(text)}</a:t></a:r>`;
}
function endRun(sz, color) {
  return `<a:endParaRPr lang="en-US" sz="${sz}" dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${FONT}"/></a:endParaRPr>`;
}

// One caption text box: bold number paragraph (if on), then the caption's
// lines — or an empty, pre-styled paragraph so typing into it in Slides
// already has the right size/color.
function captionBox(id, b, x, y, w, h, L, s, colors) {
  const numSz = Math.round(L.fs * PT * 100), capSz = Math.round(L.fs * 0.92 * PT * 100);
  const paras = [];
  if (s.numbers) paras.push(`<a:p>${run(b.num, numSz, colors.ink, true)}</a:p>`);
  const lines = String(b.caption || '').split('\n');
  if (b.caption) lines.forEach((l) => paras.push(`<a:p>${l ? run(l, capSz, colors.sub, false) : ''}${endRun(capSz, colors.sub)}</a:p>`));
  else paras.push(`<a:p>${endRun(capSz, colors.sub)}</a:p>`);
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Caption ${b.num}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="${e(L.fs * 0.2)}" rIns="0" bIns="0" anchor="t"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paras.join('')}</p:txBody></p:sp>`;
}

export async function buildStoryboardPptx({ onProgress } = {}) {
  const s = sheetSettings();
  const boards = sheetBoards(P, s);
  if (!boards.length) throw new Error('No visible boards to export.');
  const pages = paginate(boards, s), getBmp = imageCache();
  const L = layout(W, H, s);
  const { ink, subHex } = inkFor(s.bg);
  const colors = { ink: hex(ink), sub: hex(subHex) };
  const capH = Math.max(L.cellH - L.ph, L.fs * 1.6);

  const zip = new JSZip();
  zip.file('[Content_Types].xml', ''); // reserve the first zip entry (filled in below) — some readers expect it first
  let media = 0;
  for (let pi = 0; pi < pages.length; pi++) {
    onProgress?.(`Building slide ${pi + 1} / ${pages.length}…`);
    const slideRels = [['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']];
    const shapes = [];
    let id = 2;
    for (let i = 0; i < pages[pi].length; i++) {
      const b = pages[pi][i];
      const { x, y } = cellPos(L, s, i);
      // The WHOLE board image is embedded and cropped on the slide (srcRect),
      // not pre-cropped — so in Slides/PowerPoint the crop can be re-adjusted
      // to reframe. Visible window = the board's fit mode (fitRect) over the
      // panel, same framing as preview/mp4/PNG.
      const bmp = await getBmp(b.fi);
      if (!bmp) continue;
      const k = Math.min(1, MAX_SRC / Math.max(bmp.width, bmp.height));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(bmp.width * k)); cv.height = Math.max(1, Math.round(bmp.height * k));
      const cx = cv.getContext('2d');
      cx.drawImage(bmp, 0, 0, cv.width, cv.height);
      const a = s.annos ? getAnnos(P, b.fi) : [];
      if (a.length) drawAnnos(cx, a, { x: 0, y: 0, w: cv.width, h: cv.height });
      const name = `image${++media}.jpg`;
      zip.file(`ppt/media/${name}`, await toBlob(cv, 'image/jpeg', 0.9));
      const rid = `rId${slideRels.length + 1}`;
      slideRels.push([rid, 'image', `../media/${name}`]);

      const r = fitRect(getBoardFit(P, b.fi), bmp.width, bmp.height, L.pw, L.ph);
      const ix = x + r.dx, iy = y + r.dy;
      const vx0 = Math.max(x, ix), vy0 = Math.max(y, iy);
      const vx1 = Math.min(x + L.pw, ix + r.dw), vy1 = Math.min(y + L.ph, iy + r.dh);
      const pct = (v, d) => Math.max(0, Math.round((v / d) * 100000)); // srcRect: 1/1000ths of a percent
      const crop = { l: pct(vx0 - ix, r.dw), t: pct(vy0 - iy, r.dh), r: pct(ix + r.dw - vx1, r.dw), b: pct(iy + r.dh - vy1, r.dh) };
      const src = Object.entries(crop).filter(([, v]) => v > 0).map(([kk, v]) => ` ${kk}="${v}"`).join('');
      const bars = vx1 - vx0 < L.pw - 0.5 || vy1 - vy0 < L.ph - 0.5; // contain/width/height leave bars
      const line = s.border ? `<a:ln w="9525"><a:solidFill><a:srgbClr val="${colors.ink}"/></a:solidFill></a:ln>` : '';
      // bars → a black panel behind (the letterbox, as in preview/mp4) carries the border
      if (bars) shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${id++}" name="Panel ${b.num}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(x, y, L.pw, L.ph)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="000000"/></a:solidFill>${line || '<a:ln><a:noFill/></a:ln>'}</p:spPr></p:sp>`);
      shapes.push(`<p:pic><p:nvPicPr><p:cNvPr id="${id++}" name="Board ${b.num}" descr="${esc(P.frames[b.fi].name)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/>${src ? `<a:srcRect${src}/>` : ''}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(vx0, vy0, vx1 - vx0, vy1 - vy0)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${bars ? '' : line}</p:spPr></p:pic>`);
      shapes.push(captionBox(id++, b, x, y + L.ph, L.pw, capH, L, s, colors));
    }
    zip.file(`ppt/slides/slide${pi + 1}.xml`, `${XML}<p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${hex(s.bg)}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
    zip.file(`ppt/slides/_rels/slide${pi + 1}.xml.rels`, rels(slideRels));
  }

  const n = pages.length;
  zip.file('[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/ppt/presentation.xml" ContentType="${CT}.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT}.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${Array.from({ length: n }, (_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="${CT}.slide+xml"/>`).join('')}</Types>`);
  zip.file('_rels/.rels', rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]));
  zip.file('ppt/presentation.xml', `${XML}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${Array.from({ length: n }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'theme', 'theme/theme1.xml'], ...Array.from({ length: n }, (_, i) => [`rId${i + 3}`, 'slide', `slides/slide${i + 1}.xml`])]));
  zip.file('ppt/slideMasters/slideMaster1.xml', MASTER);
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]));
  zip.file('ppt/slideLayouts/slideLayout1.xml', LAYOUT);
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]));
  zip.file('ppt/theme/theme1.xml', THEME);
  onProgress?.('Packaging…');
  const blob = await zip.generateAsync({ type: 'blob', mimeType: `${CT}.presentation` });
  return { blob, slides: n, boards: boards.length };
}
