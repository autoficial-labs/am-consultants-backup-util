// Builds the AM Backup user manual PDF.
//   node docs/manual/tools/build.mjs            → docs/AM-Backup-User-Manual.pdf
// Steps: expand figures (screenshots + numbered callouts), generate the contents, run an
// ASD-STE100 heuristic check, then print with branded header/footer, bookmarks and PDF tags.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const SRC = path.join(root, 'src');
const BUILD = path.join(root, 'build');
const OUT = path.join(root, '..', 'AM-Backup-User-Manual.pdf');
const shots = JSON.parse(fs.readFileSync(path.join(root, 'shots', 'shots.json'), 'utf8'));
fs.mkdirSync(BUILD, { recursive: true });

let html = fs.readFileSync(path.join(SRC, 'manual.html'), 'utf8');

// ---- Figures ----------------------------------------------------------------------------
// Every screenshot prints at the same scale (a full 1240 px window = full text width), so small
// clips stay small. Tall pictures are narrowed to fit the page; data-scale shrinks one further.
const CONTENT_MM = 178;
const FULL_PX = 1240;
let figNo = 0;
html = html.replace(/<figure ([^>]*data-shot="[^"]+"[^>]*)>([\s\S]*?)<\/figure>/g, (_, attrText, inner) => {
  const attr = Object.fromEntries([...attrText.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const name = attr['data-shot'];
  const caption = attr['data-caption'] ?? '';
  const cls = attr.class;
  const s = shots[name];
  if (!s) throw new Error(`No screenshot "${name}". Run capture.mjs first.`);
  figNo++;
  const maxHeightMm = cls === 'tall' ? 200 : 112;
  const scale = Number(attr['data-scale'] ?? 1);
  const naturalPct = Math.min(100, (s.width / FULL_PX) * 100);
  const heightAtNatural = (CONTENT_MM * naturalPct) / 100 * (s.height / s.width);
  const widthPct = Math.min(naturalPct, naturalPct * (maxHeightMm / heightAtNatural)) * scale;
  const legendCount = (inner.match(/<li>/g) ?? []).length;
  const marks = s.marks
    .filter((m) => m.n <= legendCount)
    .map((m) => {
      const left = Math.min(96, Math.max(2.2, ((m.x + Math.min(10, m.w * 0.12)) / s.width) * 100));
      const top = Math.min(96, Math.max(2.2, ((m.y + Math.min(10, m.h * 0.2)) / s.height) * 100));
      return `<span class="mark" style="left:${left.toFixed(2)}%;top:${top.toFixed(2)}%">${m.n}</span>`;
    })
    .join('');
  const id = `fig-${name}`;
  return `<figure id="${id}" class="${cls ?? ''}"><div class="frame" style="width:${widthPct.toFixed(1)}%"><img src="../${s.file}" alt="${caption}">${marks}</div><figcaption><b>Figure ${figNo}.</b> ${caption}</figcaption>${inner.trim()}</figure>`;
});
// A real space after chapter numbers, so PDF bookmarks read "1 Introduction".
html = html.replace(/<span class="num">(\d+)<\/span>/g, '<span class="num">$1</span> ');
// Keep the "Administrator" tag out of heading text (and so out of the PDF bookmarks).
html = html.replace(/<(h[123])([^>]*)>((?:(?!<\/?h[123][\s>])[\s\S])*?)\s*<span class="tag-admin">Administrator<\/span><\/\1>/g, '<$1$2>$3</$1><p class="admin-line"><span class="tag-admin">Administrator</span> Only the administrator can do this.</p>');

// ---- Contents ----------------------------------------------------------------------------
const toc = [];
const chapterRe = /<section class="chapter" id="([^"]+)">\s*<h1><span class="num">(\d+)<\/span>([\s\S]*?)<\/h1>([\s\S]*?)<\/section>/g;
for (const m of html.matchAll(chapterRe)) {
  const title = m[3].replace(/<span class="tag-admin">[^<]*<\/span>/, '').replace(/<[^>]+>/g, '').trim();
  toc.push(`<a class="l1" href="#${m[1]}"><span class="t"><span class="n">${m[2]}</span>${title}</span><span class="dots"></span><span class="go">Go</span></a>`);
  for (const h of m[4].matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)) {
    const t = h[2].replace(/<span class="tag-admin">[^<]*<\/span>/, '').replace(/<[^>]+>/g, '').trim();
    toc.push(`<a class="l2" href="#${h[1]}"><span class="t">${t}</span><span class="dots"></span><span class="go">Go</span></a>`);
  }
}
html = html.replace('<nav class="toc" id="toc"><!-- generated --></nav>', `<nav class="toc" id="toc">${toc.join('')}</nav>`);
// "Contents" link at the top of each chapter.
html = html.replace(/(<section class="chapter" id="[^"]+">\s*)<h1>/g, '$1<a class="back-to-contents" href="#contents">Contents ↑</a><h1>');

fs.writeFileSync(path.join(BUILD, 'manual.html'), html);
fs.copyFileSync(path.join(SRC, 'manual.css'), path.join(BUILD, 'manual.css'));

// ---- STE heuristic check (runs inside the rendered page) ----------------------------------
const STE_CHECK = String.raw`(() => {
  const BANNED = /\b(should|could|would|might|may|please|simply|just|easily|ensure|ensures|utili[sz]e\w*|via|in order to|prior to|launch\w*|display(s|ed)?|verify|verified|enable(s|d)?|allow(s|ed)?|appear(s|ed)?|choose|chooses|chosen|perform\w*|require(s|d)?|obtain\w*|provide(s|d)?|whether|etc|e\.g\.|i\.e\.|very|really|basically|quite|various|numerous|currently|unless otherwise|let's|lots)\b/i;
  const PASSIVE = /\b(is|are|was|were|be|been|being)\s+(\w+ed|shown|done|made|kept|sent|set|written|taken|given|known|seen|found|held|built|put|read|run|lost|left|grouped|locked)\b/i;
  const ING_OK = /^(nothing|something|anything|everything|during|thing|things|ring|string|setting|settings|warning|bring|king)$/i;
  const CONTRACTION = /\b\w+(n't|'re|'ll|'ve)\b/i;
  const blocks = [];
  const skip = '.cover, .backcover, .toc, .finder, table.key, .legend-skip';
  for (const el of document.querySelectorAll('p, li, td, dd, dt')) {
    if (el.closest(skip)) continue;
    if (el.matches('li') && el.querySelector('li')) continue;
    if (el.closest('ol.legend') && false) continue;
    const clone = el.cloneNode(true);
    // Screen names, status names, file names and examples are technical names in STE.
    clone.querySelectorAll('.ui, .file, .tag-admin, .tag-note, .tag-caution, b, i, a[href^="#"]').forEach((n) => n.replaceWith('Name'));
    const text = clone.textContent.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const procedural = !!el.closest('ol.steps');
    blocks.push({ text, procedural, kind: el.tagName.toLowerCase() });
  }
  let total = 0, ok = 0;
  const issues = { length: 0, banned: 0, passive: 0, ing: 0, contraction: 0 };
  const samples = [];
  for (const b of blocks) {
    const sentences = b.text.split(/(?<=[.!?])\s+(?=[A-Z0-9“"(])/).filter((s) => /[A-Za-z]/.test(s));
    for (const s of sentences) {
      total++;
      const words = s.match(/[A-Za-z0-9’'][A-Za-z0-9’'-]*/g) || [];
      const limit = b.procedural ? 20 : 25;
      const found = [];
      if (words.length > limit) found.push('length ' + words.length + '>' + limit);
      const ban = s.match(BANNED); if (ban) found.push('word "' + ban[0] + '"');
      const pas = s.match(PASSIVE); if (pas) found.push('passive "' + pas[0] + '"');
      const ing = words.filter((w) => /ing$/i.test(w) && w.length > 4 && !ING_OK.test(w)); if (ing.length) found.push('-ing "' + ing.join(', ') + '"');
      const con = s.match(CONTRACTION); if (con) found.push('contraction "' + con[0] + '"');
      for (const f of found) issues[f.split(' ')[0].replace('word', 'banned').replace('-ing', 'ing')]++;
      if (!found.length) ok++; else samples.push({ s, found });
    }
  }
  return { total, ok, score: Math.round((ok / Math.max(1, total)) * 1000) / 10, issues, samples };
})()`;

// ---- Header and footer ------------------------------------------------------------------------
const b = await launch();
try {
  const { send, evaluate, navigate, sleep, close } = b;
  await navigate(pathToFileURL(path.join(BUILD, 'manual.html')).href);
  // Wait for web fonts and images, but never longer than 15 s (offline builds fall back to Segoe UI).
  await evaluate(`Promise.race([
    document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.complete ? 1 : new Promise((r) => { i.onload = i.onerror = r; })))),
    new Promise((r) => setTimeout(r, 15000)),
  ]).then(() => true)`);
  await sleep(500);

  // Small copy of the AFLABS mark for the header (keeps the PDF light).
  // A data: source keeps the canvas untainted (file: images would block toDataURL).
  const markUrl = `data:image/png;base64,${fs.readFileSync(path.join(root, 'assets', 'aflabs-mark.png')).toString('base64')}`;
  const mark = await evaluate(`new Promise((res, rej) => { const img = new Image(); img.onerror = () => rej(new Error('mark failed to load')); img.onload = () => { try { const c = document.createElement('canvas'); c.width = c.height = 72; c.getContext('2d').drawImage(img, 0, 0, 72, 72); res(c.toDataURL('image/png')); } catch (e) { rej(e); } }; img.src = ${JSON.stringify(markUrl)}; })`);

  const ste = await evaluate(STE_CHECK);
  await evaluate(`document.querySelectorAll('[data-ste-score]').forEach((e) => e.textContent = ${JSON.stringify(`${ste.score}% of ${ste.total} sentences obey the checked STE rules`)}); true`);
  fs.writeFileSync(path.join(BUILD, 'ste-report.json'), JSON.stringify(ste, null, 2));

  const font = "font-family:'Segoe UI',system-ui,sans-serif;";
  const headerTemplate = `<div style="${font} width:100%; margin:0 16mm; padding-bottom:3mm; border-bottom:0.5px solid #e3e6ea; display:flex; align-items:center; justify-content:space-between; font-size:7.5pt; color:#3d434a; -webkit-print-color-adjust:exact;">
    <div style="display:flex; align-items:center; gap:6px;"><img src="${mark}" style="width:15px;height:15px;"><span style="font-weight:700; letter-spacing:0.09em; color:#050505;">AUTOFICIAL / LABS</span></div>
    <div style="display:flex; align-items:center; gap:7px;"><span>AM Backup · User manual</span><span style="display:inline-block; width:16px; height:4px; border-radius:2px; background:#C9FF52;"></span></div>
  </div>`;
  const footerTemplate = `<div style="${font} width:100%; margin:0 16mm; padding-top:2.5mm; border-top:0.5px solid #e3e6ea; display:flex; align-items:center; justify-content:space-between; font-size:7pt; color:#646b73; -webkit-print-color-adjust:exact;">
    <span><span style="font-weight:700; color:#050505; letter-spacing:0.06em;">AFLABS</span> · autoficial.ltd</span>
    <span>Version 1.0 · November 2026</span>
    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
  </div>`;

  const pdf = await send('Page.printToPDF', {
    paperWidth: 8.27,
    paperHeight: 11.69,
    marginTop: 0.78,
    marginBottom: 0.66,
    marginLeft: 0.63,
    marginRight: 0.63,
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate,
    footerTemplate,
    generateDocumentOutline: true,
    generateTaggedPDF: true,
    preferCSSPageSize: false,
  });
  fs.writeFileSync(OUT, Buffer.from(pdf.data, 'base64'));
  await close();
  console.log(`PDF: ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
  console.log(`STE check: ${ste.score}% of ${ste.total} sentences pass (issues: ${JSON.stringify(ste.issues)})`);
} catch (e) {
  await b.close();
  throw e;
}
