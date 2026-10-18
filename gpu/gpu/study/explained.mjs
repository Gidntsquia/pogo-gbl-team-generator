// Round 9 R11: the five pictures of docs/gpu-round9-explained.md, drawn as SVG and rendered to PNG (2x) under docs/.
//
//   node gpu/gpu/study/explained.mjs     (no GPU; playwright from PLAYWRIGHT_DIR or the sibling repo)
//
// Inputs: round-8 numbers written below with their source (out/gpu/study/round8-*.json runs, quoted in docs/gpu-viability.md),
// out/gpu/study/prof/tail-timeline.json, out/gpu/study/prof/ncu/summary.json and the round-9 A/B runs (runs.mjs).
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { runStats } from './runs.mjs';

const PW_DIR = process.env.PLAYWRIGHT_DIR ?? '/home/jaxon/files/workout-visualizer/node_modules/playwright';
const { chromium } = createRequire(import.meta.url)(PW_DIR);
const rd = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const W = 360;
const C = { fg: '#1d2330', mut: '#5b6577', bg: '#f4f6f9', line: '#c9d0db', a: '#2f6fdb', b: '#e0832a', g: '#9aa3b2', ok: '#157347' };
const t = (x, y, s, o = {}) => `<text x="${x}" y="${y}" font-size="${o.size ?? 12}" fill="${o.fill ?? C.fg}" text-anchor="${o.anchor ?? 'start'}"${o.bold ? ' font-weight="700"' : ''}>${s}</text>`;
const rect = (x, y, w, h, fill, rx = 2) => `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0.5, w).toFixed(1)}" height="${h.toFixed(1)}" rx="${rx}" fill="${fill}"/>`;
const svg = (h, inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" width="${W}" height="${h}" font-family="system-ui,sans-serif"><rect width="${W}" height="${h}" fill="${C.bg}"/>${inner}</svg>`;

/** Horizontal bars: rows of {label, v, fill, text}. */
function bars(title, rows, max, y0 = 26) {
  const x0 = 120, x1 = W - 50;
  let g = t(10, 18, title, { bold: true });
  rows.forEach((r, i) => {
    const y = y0 + i * 24;
    g += t(10, y + 13, r.label, { size: 11.5 }) + rect(x0, y + 2, ((x1 - x0) * r.v) / max, 15, r.fill) + t(x0 + ((x1 - x0) * r.v) / max + 4, y + 14, r.text, { size: 11.5 });
  });
  return { g, y: y0 + rows.length * 24 };
}

const pics = {};

// 1. island halving: round 7 runs (r7.* keys of round8-numbers.json, islands on/off, two runs each)
{
  const { g, y } = bars('Warm s/gen, round 7 (two runs each)', [
    { label: 'teams together', v: 12.2, fill: C.a, text: '12.20 / 12.05' },
    { label: 'island halving', v: 17.64, fill: C.b, text: '17.64 / 17.51' },
  ], 24);
  let h = g, yy = y + 14;
  h += t(10, yy, 'One launch runs an island\'s halving rounds in turn.', { size: 11.5 });
  yy += 10;
  // sketch: three rounds of four parallel battles; each round waits for its longest battle
  const rounds = [[5, 8, 4, 6], [3, 4, 9, 5], [6, 3, 4, 4]];
  let x = 10;
  rounds.forEach((r, i) => {
    const mx = Math.max(...r);
    r.forEach((l, k) => { h += rect(x, yy + k * 13, l * 10, 10, l === mx ? C.b : C.g); });
    h += t(x, yy + 66, `halving ${i + 1}`, { size: 11, fill: C.mut });
    x += mx * 10 + 12;
    h += `<line x1="${x - 6}" x2="${x - 6}" y1="${yy - 2}" y2="${yy + 52}" stroke="${C.fg}" stroke-dasharray="3 2"/>`;
  });
  yy += 84;
  h += t(10, yy, 'Orange = longest battle. Grey bars finish early,', { size: 11, fill: C.mut });
  h += t(10, yy + 15, 'then their threads wait at the dashed line.', { size: 11, fill: C.mut });
  yy += 15;
  pics['gpu-r9-island'] = svg(yy + 12, h);
}

// 2. battle state: where it lives, and the Nsight numbers
{
  const n = rd('out/gpu/study/prof/ncu/summary.json')?.['5k'] ?? {};
  let h = t(10, 18, 'Where each battle\'s state lives', { bold: true });
  h += rect(10, 30, 160, 92, '#ffffff', 6) + t(18, 46, 'SM (on-chip)', { bold: true, size: 11.5 });
  h += t(18, 64, 'registers: fast, few', { size: 11.5 }) + t(18, 82, 'shared memory: fast,', { size: 11.5 }) + t(18, 97, 'small (100 KB per SM)', { size: 11.5 }) + t(18, 114, 'L1 cache', { size: 11.5 });
  h += rect(190, 30, 160, 92, '#ffffff', 6) + t(198, 46, 'GPU main memory', { bold: true, size: 11.5 });
  h += t(198, 64, 'local memory: 39,088', { size: 11.5 }) + t(198, 82, 'bytes per battle, via', { size: 11.5 }) + t(198, 97, 'L1 and L2', { size: 11.5 });
  h += `<path d="M190 76 L172 76" stroke="${C.b}" stroke-width="3" marker-end="url(#ar)"/><defs><marker id="ar" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L6 3L0 6z" fill="${C.b}"/></marker></defs>`;
  const ls = n.top5_stalls?.find((x) => x.reason === 'long_scoreboard')?.share_pct;
  h += t(10, 144, '5k launch, Nsight Compute:', { size: 11.5, bold: true });
  h += t(10, 161, `${n.local_share_of_l1_bytes_pct ?? '?'}% of L1 traffic is local memory`, { size: 11.5 });
  h += t(10, 177, `${ls ?? '?'}% of warp cycles wait on memory loads`, { size: 11.5 });
  h += t(10, 193, `${n.issue_slot_use_pct ?? '?'}% of cycles start an instruction`, { size: 11.5 });
  h += t(10, 213, 'Compact state, round 8: 0.5 s/gen faster.', { size: 11.5, fill: C.ok });
  pics['gpu-r9-memory'] = svg(224, h);
}

// 3. scheduling ideas, round 8: delta.* keys of out/gpu/study/detail/round8-numbers.json (s/gen vs the nearest default runs)
{
  const { g, y } = bars('Round 8 scheduling ideas: s/gen added vs default', [
    { label: 'CPU share auto', v: 2.0, fill: C.b, text: '+2.0 s' },
    { label: 'two streams', v: 4.4, fill: C.b, text: '+4.4 s' },
    { label: 'less lookahead', v: 4.4, fill: C.b, text: '+4.4 s' },
    { label: 'lockstep 128', v: 5.2, fill: C.b, text: '+5.2 s' },
    { label: 'lockstep 32', v: 7.3, fill: C.b, text: '+7.3 s' },
    { label: 'queue kernel', v: 7.3, fill: C.b, text: '+7.3 s' },
  ], 9);
  let h = g;
  h += t(10, y + 14, 'None of them makes a battle shorter.', { size: 11.5 });
  pics['gpu-r9-scheduling'] = svg(y + 24, h);
}

// 4. the tail: busy SMs over the 10k launch, filler off
{
  const L = rd('out/gpu/study/prof/tail-timeline.json')?.launches?.['10k']?.off;
  let h = t(10, 18, 'Busy SMs during one 10k-battle launch', { bold: true });
  if (L) {
    const x0 = 10, x1 = W - 10, top = 46, hh = 90, bw = (x1 - x0) / L.busy_sms.length;
    L.busy_sms.forEach((b, k) => { h += rect(x0 + k * bw, top + hh - (b / L.sms) * hh, bw + 0.3, (b / L.sms) * hh, C.a, 0); });
    const half = x0 + (x1 - x0) * (1 - L.tail_share_pct / 100);
    h += `<line x1="${half}" x2="${half}" y1="${top - 12}" y2="${top + hh}" stroke="${C.b}" stroke-width="2"/>`;
    h += t(Math.min(half, W - 10), top - 16, 'half the battles done', { size: 11, fill: C.b, anchor: half > W - 130 ? 'end' : 'middle' });
    h += t(10, top + hh + 16, `0 s`, { size: 11, fill: C.mut }) + t(x1, top + hh + 16, `${L.main_span_s.toFixed(1)} s`, { size: 11, fill: C.mut, anchor: 'end' });
    h += t(10, top + hh + 34, `The tail (right of the line) is ${L.tail_share_pct}% of the launch.`, { size: 11.5 });
    h += t(10, top + hh + 50, `SMs are busy ${L.sm_active_share_pct}% of the launch (a replay).`, { size: 11.5 });
    h += t(10, top + hh + 66, 'Source: round-9 replay, 19:44 ET (tail-timeline.json).', { size: 11, fill: C.mut });
    pics['gpu-r9-tail'] = svg(top + hh + 76, h);
  }
}

// 5. warm s/gen and its noise: round-9 A/B runs as dots, mean and spread
{
  const V = [['default', C.g, 'default'], ['tail', C.a, 'tail filler'], ['certain', C.b, 'certain feed']];
  const runs = V.map(([v]) => [1, 2, 3, 4, 5].map((i) => `out/evolve-gpu8-r9-ab-${v}-${i}`).filter((d) => existsSync(`${d}.log`)).map(runStats).filter((r) => r.exit === 0 && r.warmPerGen != null));
  const all = runs.flat().map((r) => r.warmPerGen);
  let h = t(10, 18, 'Warm s/gen, round 9 A/B: one dot per run', { bold: true });
  if (all.length) {
    const lo = Math.floor(Math.min(...all) * 2) / 2 - 0.5, hi = Math.ceil(Math.max(...all) * 2) / 2 + 0.5;
    const x0 = 84, x1 = W - 14, X = (v) => x0 + ((v - lo) / (hi - lo)) * (x1 - x0);
    V.forEach(([v, col, label], i) => {
      const y = 40 + i * 30, w = runs[i].map((r) => r.warmPerGen);
      h += t(10, y + 4, label, { size: 11.5 });
      if (!w.length) return;
      const mn = Math.min(...w), mx = Math.max(...w), m = w.reduce((a, b) => a + b, 0) / w.length;
      h += rect(X(mn), y - 6, X(mx) - X(mn), 12, col, 3).replace('/>', ' opacity="0.3"/>');
      w.forEach((x) => { h += `<circle cx="${X(x).toFixed(1)}" cy="${y}" r="4" fill="${col}"/>`; });
      h += `<line x1="${X(m)}" x2="${X(m)}" y1="${y - 9}" y2="${y + 9}" stroke="${C.fg}" stroke-width="2"/>`;
    });
    const yA = 40 + V.length * 30;
    for (let v = Math.ceil(lo); v <= hi; v += 1) h += t(X(v), yA, `${v} s`, { size: 10.5, fill: C.mut, anchor: 'middle' });
    h += t(10, yA + 20, 'Shaded = spread (slowest - fastest run). Black = mean.', { size: 11.5 });
    h += t(10, yA + 36, 'A change counts only if it moves the mean by more', { size: 11.5 });
    h += t(10, yA + 52, 'than both spreads.', { size: 11.5 });
    pics['gpu-r9-noise'] = svg(yA + 62, h);
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: W, height: 400 } });
for (const [name, s] of Object.entries(pics)) {
  writeFileSync(`out/gpu/study/${name}.svg`, s);
  await page.setContent(`<html><body style="margin:0">${s}</body></html>`);
  const over = await page.evaluate(() => [...document.querySelectorAll('text')].filter((e) => { const b = e.getBBox(); return b.x < 0 || b.x + b.width > 360; }).map((e) => e.textContent));
  if (over.length) { console.error(`${name}: text past the edge: ${over.join(' | ')}`); process.exitCode = 1; }
  await page.locator('svg').screenshot({ path: `docs/${name}.png` });
  console.log(`docs/${name}.png`);
}
await browser.close();
