// Round 9 R10: phone-sized PNGs of out/gpu-study.html and of docs/gpu-round9-explained.md, one per screenful.
//
//   node gpu/gpu/study/phone.mjs      (uses the playwright install named by PLAYWRIGHT_DIR or the sibling repo)
//
// Each page renders at 390 px wide, 2x device scale. It is cut into screenfuls of about 844 px (the iPhone 14 viewport),
// always between blocks (never through a line, a chart or a table row), numbered in reading order:
// out/gpu/study/phone/NN.png and out/gpu/study/phone/explained-NN.png. The explainer is first rendered from its Markdown to
// out/gpu/study/explained.html. Fails (exit 1) on: a PNG over 900 px tall (1800 px at 2x), a "…" in visible text, text past
// its box or past a chart's edge, HTML inside a chart, horizontal page scroll, a paragraph over 3 lines. Report: out/gpu/study/phone/check.txt
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PW_DIR = process.env.PLAYWRIGHT_DIR ?? '/home/jaxon/files/workout-visualizer/node_modules/playwright';
const { chromium } = createRequire(import.meta.url)(PW_DIR);
const DIR = 'out/gpu/study/phone', SCREEN = 844, MAX = 900, MIN = 420;
mkdirSync(DIR, { recursive: true });
for (const f of readdirSync(DIR)) if (/\.png$/.test(f)) unlinkSync(`${DIR}/${f}`);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Minimal Markdown for the explainer: #/## headings, paragraphs, - lists, ![alt](src) images, `code`, **bold**, [t](u). */
export function mdToHtml(md, base) {
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, a, u) => `<img alt="${a}" src="${base}${u}">`).replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  const out = [];
  let list = false, para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  for (const line of md.split('\n')) {
    const h = line.match(/^(#{1,3}) (.*)/), li = line.match(/^- (.*)/), img = line.match(/^!\[/);
    if (!li && list) { out.push('</ul>'); list = false; }
    if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); } else if (li) { flush(); if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(li[1])}</li>`); } else if (img) { flush(); out.push(`<figure>${inline(line)}</figure>`); } else if (!line.trim()) flush(); else para.push(line.trim());
  }
  flush();
  if (list) out.push('</ul>');
  return out.join('\n');
}

const md = readFileSync('docs/gpu-round9-explained.md', 'utf8');
const EXPL = resolve('out/gpu/study/explained.html');
writeFileSync(EXPL, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GPU Round9 explained</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Color+Emoji&display=swap">
<style>:root{--bg:#fff;--fg:#1d2330;--mut:#5b6577;--card:#f4f6f9;--link:#1f5fc4}@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#14171d;--fg:#e6e9ef;--mut:#9aa3b2;--card:#1c2028;--link:#8ab4ff}}
:root[data-theme="dark"]{--bg:#14171d;--fg:#e6e9ef;--mut:#9aa3b2;--card:#1c2028;--link:#8ab4ff}
*{box-sizing:border-box}body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif,'Noto Color Emoji';margin:0 auto;max-width:720px;padding:16px}a{color:var(--link)}
h1{font-size:1.4rem}h2{font-size:1.15rem;margin:1.6rem 0 .3rem}p{margin:.4rem 0}figure{margin:.5rem 0}img{width:100%;height:auto;display:block;border-radius:8px}
code{font-size:.85em;background:var(--card);padding:1px 4px;border-radius:3px}ul{padding-left:1.3rem}li{margin:.3rem 0}</style></head><body>
${mdToHtml(md, '../../../docs/'.replace(/^/, '')).replace(/src="\.\.\/\.\.\/\.\.\/docs\/docs\//g, 'src="../../../docs/')}</body></html>`);

const browser = await chromium.launch();
const lines = [];
let bad = 0;
for (const [file, prefix] of [[resolve('out/gpu-study.html'), ''], [EXPL, 'explained-']]) {
  const page = await browser.newPage({ viewport: { width: 390, height: SCREEN }, deviceScaleFactor: 2 });
  await page.goto(`file://${file}`);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  // the emoji font comes in unicode-range slices that load on first use: ask for each emoji on the page, then let them land
  await page.evaluate(() => Promise.all([...new Set(document.body.innerText.match(/\p{Extended_Pictographic}/gu) ?? [])].map((c) => document.fonts.load("16px 'Noto Color Emoji'", c))));
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  const r = await page.evaluate(({ SCREEN, MAX, MIN }) => {
    const out = { ellipsis: [], clipped: [], svgOver: [], tall: [], htmlInSvg: [...document.querySelectorAll('svg *')].filter((e) => e.namespaceURI !== 'http://www.w3.org/2000/svg').map((e) => e.outerHTML.slice(0, 60)), scroll: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    const vis = (e) => e.getClientRects().length > 0;
    for (const e of document.querySelectorAll('body *')) {
      if (!vis(e)) continue;
      for (const n of e.childNodes) if (n.nodeType === 3 && /…/.test(n.textContent)) out.ellipsis.push(n.textContent.trim().slice(0, 80));
      const cs = getComputedStyle(e);
      if (cs.overflow !== 'visible' && e.scrollWidth > e.clientWidth + 1) out.clipped.push(`${e.tagName.toLowerCase()}.${e.className}: ${e.textContent.trim().slice(0, 60)}`);
      const b = e.getBoundingClientRect();
      if (b.right > document.documentElement.clientWidth + 0.5 && e.tagName !== 'HTML' && e.tagName !== 'BODY') out.clipped.push(`${e.tagName.toLowerCase()} past the page edge: ${e.textContent.trim().slice(0, 60)}`);
    }
    for (const s of document.querySelectorAll('svg.fig')) {
      const vb = s.viewBox.baseVal;
      for (const t of s.querySelectorAll('text')) { const b = t.getBBox(); if (b.x + b.width > vb.width + 0.5 || b.x < -0.5) out.svgOver.push(`${t.textContent.slice(0, 60)} (${(b.x + b.width).toFixed(0)} > ${vb.width})`); }
    }
    for (const p of document.querySelectorAll('p, li, dd, dt, caption')) {
      if (!vis(p) || p.querySelector('table, svg, ol, ul, p, div, dl, img')) continue;
      const lh = parseFloat(getComputedStyle(p).lineHeight) || 24, h = p.getBoundingClientRect().height;
      if (h > lh * 3.3) out.tall.push(`${p.tagName.toLowerCase()} ${(h / lh).toFixed(1)} lines: ${p.textContent.trim().slice(0, 70)}`);
    }
    // cut points: a y no atomic block straddles
    const atoms = [...document.querySelectorAll('h1, h2, h3, p, li, dt, dd, svg, tr, caption, figure, pre, .mc, .sup')].filter(vis)
      .map((e) => { const b = e.getBoundingClientRect(); return [b.top + scrollY, b.bottom + scrollY]; });
    const H = document.documentElement.scrollHeight;
    const free = (y) => atoms.every(([a, b]) => !(a < y - 0.5 && y + 0.5 < b));
    const ends = [...new Set(atoms.map(([, b]) => Math.ceil(b + 2)))].filter((y) => y < H).sort((a, b) => a - b);
    const cuts = [];
    let y0 = 0;
    while (H - y0 > MAX) {
      const ok = ends.filter((y) => y > y0 + MIN && free(y));
      const c = ok.filter((y) => y <= y0 + SCREEN).at(-1) ?? ok.filter((y) => y <= y0 + MAX).at(-1);
      if (!c) { cuts.push([y0, y0 + MAX, 'no block boundary within 900 px']); y0 += MAX; continue; }
      cuts.push([y0, c]); y0 = c;
    }
    cuts.push([y0, H]);
    out.cuts = cuts;
    return out;
  }, { SCREEN, MAX, MIN });
  // a fullPage shot resizes the viewport mid-capture and Chrome then drops emoji glyphs from late font slices: grow the
  // viewport to the whole page first, let the slices land, rebuild the body, and clip from that one layout
  await page.setViewportSize({ width: 390, height: Math.ceil(r.cuts.at(-1)[1]) });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { document.body.innerHTML = document.body.innerHTML; return new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))); });
  await page.waitForTimeout(500);
  const shots = [];
  for (const [i, [a, b, err]] of r.cuts.entries()) {
    const f = `${DIR}/${prefix}${String(i + 1).padStart(2, '0')}.png`;
    await page.screenshot({ path: f, clip: { x: 0, y: a, width: 390, height: b - a } });
    shots.push(`${f} (${Math.round(b - a)} px${err ? `, ${err}` : ''})`);
    if (b - a > MAX || err) bad += 1;
  }
  await page.close();
  const n = r.htmlInSvg.length + r.ellipsis.length + r.clipped.length + r.svgOver.length + r.tall.length + (r.scroll ? 1 : 0);
  bad += n;
  lines.push(`== ${file}`, `${shots.length} PNGs at 390 px wide (2x): ${shots.join(', ')}`,
    `PNGs over ${MAX} px tall: ${shots.filter((s) => /\((\d+) px/.exec(s) && +/\((\d+) px/.exec(s)[1] > MAX).length}`,
    `ellipsis "…" in visible text: ${r.ellipsis.length}`, ...r.ellipsis.map((x) => `  ${x}`),
    `text cut off or past the edge: ${r.clipped.length}`, ...r.clipped.map((x) => `  ${x}`),
    `HTML inside a chart (renders outside it): ${r.htmlInSvg.length}`, ...r.htmlInSvg.map((x) => `  ${x}`),
    `SVG text past the chart edge: ${r.svgOver.length}`, ...r.svgOver.map((x) => `  ${x}`),
    `paragraphs over 3 lines: ${r.tall.length}`, ...r.tall.map((x) => `  ${x}`),
    `horizontal page scroll: ${r.scroll ? 'yes' : 'no'}`);
}
await browser.close();
writeFileSync(`${DIR}/check.txt`, lines.join('\n') + '\n');
console.log(lines.join('\n'));
process.exit(bad ? 1 : 0);
