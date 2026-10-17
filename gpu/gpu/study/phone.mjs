// Round 8 R10/amendments: phone-width (390 px) PNG of every section of out/gpu-study.html -> out/gpu/study/phone/NN-<id>.png,
// plus a readability check of the rendered page: no "…" anywhere, no text wider than its box (nothing cut off), no SVG text
// past its chart's edge, no horizontal page scroll and no paragraph over 3 lines. Report: out/gpu/study/phone/check.txt
//
//   node gpu/gpu/study/phone.mjs            (uses the playwright install named by PLAYWRIGHT_DIR or the sibling repo)
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PW_DIR = process.env.PLAYWRIGHT_DIR ?? '/home/jaxon/files/workout-visualizer/node_modules/playwright';
const { chromium } = createRequire(import.meta.url)(PW_DIR);
const PAGE = resolve('out/gpu-study.html'), DIR = 'out/gpu/study/phone';
mkdirSync(DIR, { recursive: true });
for (const f of readdirSync(DIR)) if (/\.png$/.test(f)) unlinkSync(`${DIR}/${f}`);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await page.goto(`file://${PAGE}`);
await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = false; }));
const ids = await page.$$eval('section[id], div.rec[id]', (els) => els.map((e) => e.id));
const shots = [];
for (const [i, id] of ids.entries()) {
  const el = await page.$(`#${id}`);
  const f = `${DIR}/${String(i).padStart(2, '0')}-${id}.png`;
  await el.screenshot({ path: f });
  shots.push(f);
}
const report = await page.evaluate(() => {
  const out = { ellipsis: [], clipped: [], svgOver: [], tall: [], scroll: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  const vis = (e) => e.getClientRects().length > 0;
  for (const e of document.querySelectorAll('body *')) {
    if (!vis(e) || e.closest('details:not([open])')) continue;
    for (const n of e.childNodes) if (n.nodeType === 3 && /…/.test(n.textContent)) out.ellipsis.push(n.textContent.trim().slice(0, 80));
    const cs = getComputedStyle(e);
    if (cs.overflow !== 'visible' && e.scrollWidth > e.clientWidth + 1 && !e.classList.contains('tw')) out.clipped.push(`${e.tagName.toLowerCase()}.${e.className}: ${e.textContent.trim().slice(0, 60)}`);
  }
  for (const s of document.querySelectorAll('svg.fig')) {
    const vb = s.viewBox.baseVal;
    for (const t of s.querySelectorAll('text')) { const b = t.getBBox(); if (b.x + b.width > vb.width + 0.5 || b.x < -0.5) out.svgOver.push(`${t.textContent.slice(0, 60)} (${(b.x + b.width).toFixed(0)} > ${vb.width})`); }
  }
  // leaf text blocks only: a block that holds other blocks is a list item or card, judged by its parts
  for (const p of document.querySelectorAll('p, li, li > div, .next, .data, .mean, .rec li > div, dd, .defs span, .why, .says')) {
    if (!vis(p) || p.classList.contains('defs') || p.closest('details:not([open])') || p.querySelector('table, svg, ol, ul, p, div, dl')) continue;
    const lh = parseFloat(getComputedStyle(p).lineHeight) || 24, h = p.getBoundingClientRect().height;
    if (h > lh * 3.3) out.tall.push(`${p.tagName.toLowerCase()}.${p.className} ${(h / lh).toFixed(1)} lines: ${p.textContent.trim().slice(0, 70)}`);
  }
  return out;
});
await browser.close();
const lines = [
  `${shots.length} PNGs at 390 px: ${shots.join(' ')}`,
  `ellipsis "…" in visible text: ${report.ellipsis.length}`, ...report.ellipsis.map((x) => `  ${x}`),
  `text cut off by its box: ${report.clipped.length}`, ...report.clipped.map((x) => `  ${x}`),
  `SVG text past the chart edge: ${report.svgOver.length}`, ...report.svgOver.map((x) => `  ${x}`),
  `paragraphs over 3 lines: ${report.tall.length}`, ...report.tall.map((x) => `  ${x}`),
  `horizontal page scroll: ${report.scroll ? 'yes' : 'no'}`,
];
writeFileSync(`${DIR}/check.txt`, lines.join('\n') + '\n');
console.log(lines.join('\n'));
const bad = report.ellipsis.length + report.clipped.length + report.svgOver.length + report.tall.length + (report.scroll ? 1 : 0);
process.exit(bad ? 1 : 0);
