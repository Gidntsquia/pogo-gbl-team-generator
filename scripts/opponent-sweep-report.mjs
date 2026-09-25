#!/usr/bin/env node
// Focused report: does raising the opponent pool from 50 to 500 (K=50, 200 candidates) raise candidate
// quality, and what does it cost? Pure function of out/sampled-k-ab-r3 (results.json + per-generation
// checkpoints). Writes out/opponent-sweep-report.html; same bytes every run, no external assets.
//   node scripts/opponent-sweep-report.mjs [--dir out/sampled-k-ab-r3] [--out out/opponent-sweep-report.html]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mean, t95, sd, pairedRows, verdictAt, SWEEP_BAND, SMALL, LARGE } from './sampled-k-r3-stats.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = path.resolve(ROOT, arg('--dir', 'out/sampled-k-ab-r3'));
const OUT = path.resolve(ROOT, arg('--out', 'out/opponent-sweep-report.html'));

const data = JSON.parse(readFileSync(path.join(DIR, 'results.json'), 'utf8'));
const seeds = data.seeds;
const cellsOf = (a) => seeds.map((s) => data.cells.find((c) => c.arm === a && c.seed === s));
const rows = pairedRows(data.cells, seeds, SMALL, LARGE);
const n = rows.length;
const v = verdictAt(rows, n);
const pct = (x, d = 2) => `${(x * 100).toFixed(d)}%`;
const pt = (x, d = 2) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}`;
const int = (x) => Math.round(x).toLocaleString('en-US');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Per-arm stats: mean and 95% range of quality, mean battles/wall per run. */
function armStats(a) {
  const cs = rows.map((r) => (a === SMALL ? r.c : r.i));
  const q = cs.map((c) => c.heldoutMeanTop);
  const m = mean(q), h = t95(n - 1) * sd(q) / Math.sqrt(n);
  return { m, lo: m - h, hi: m + h, gen: mean(cs.map((c) => c.genBattles)), total: mean(cs.map((c) => c.totalBattles)), wall: mean(cs.map((c) => c.wallSeconds)), cs };
}
const S = { [SMALL]: armStats(SMALL), [LARGE]: armStats(LARGE) };

/** Per-generation means over seeds: battles simulated, cache hits. */
function perGen(a) {
  const G = S[a].cs[0].generations;
  const sim = Array(G).fill(0), hit = Array(G).fill(0);
  for (const c of S[a].cs) {
    for (let g = 0; g < G; g++) {
      const j = JSON.parse(readFileSync(path.join(DIR, `${a}-${c.seed}`, `evolve-gen${g}.json`), 'utf8'));
      const f = (x) => (x && typeof x === 'object' ? (x.cachedCount !== undefined && x.battleCount !== undefined ? x : Object.values(x).map(f).find(Boolean)) : null);
      const o = f(j);
      sim[g] += o.battleCount / n; hit[g] += o.cachedCount / n;
    }
  }
  return { sim, hit };
}
const PG = { [SMALL]: perGen(SMALL), [LARGE]: perGen(LARGE) };

const F = 'font-family="system-ui,Helvetica,Arial,sans-serif"';
const tx = (x, y, s, o = '') => `<text x="${x}" y="${y}" ${F} ${o.includes('font-size') ? '' : 'font-size="12" '}${o.includes('fill') ? '' : 'fill="#222" '}${o}>${esc(s)}</text>`;

/** Quality at 50 vs 500 opponents: mean with 95% range across seeds. Nothing else on the chart. */
function chart() {
  const W = 620, H = 320, L = 70, R = 590, T = 56, B = 250;
  const pts = [[SMALL, '50 opponents'], [LARGE, '500 opponents']].map(([a, l]) => ({ ...S[a], l }));
  const lo = Math.floor((Math.min(...pts.map((p) => p.lo)) * 100 - 1) / 2) * 2, hi = Math.ceil((Math.max(...pts.map((p) => p.hi)) * 100 + 1) / 2) * 2;
  const y = (q) => B - ((q * 100 - lo) / (hi - lo)) * (B - T);
  const o = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px" role="img" aria-label="Held-out quality at 50 and 500 opponents"><rect width="${W}" height="${H}" fill="#fff"/>`,
    tx(L, 24, 'Held-out quality of the top 5 teams (mean, 95% range over seeds)', 'font-weight="600" font-size="14"')];
  for (let g = lo; g <= hi; g += 2) o.push(`<line x1="${L}" y1="${y(g / 100).toFixed(1)}" x2="${R}" y2="${y(g / 100).toFixed(1)}" stroke="#e5e7eb"/>`, tx(L - 8, (y(g / 100) + 4).toFixed(1), `${g}%`, 'text-anchor="end" font-size="11" fill="#666"'));
  pts.forEach((p, k) => {
    const x = L + ((k + 0.5) / 2) * (R - L), c = '#1d4ed8';
    o.push(`<line x1="${x}" y1="${y(p.lo).toFixed(1)}" x2="${x}" y2="${y(p.hi).toFixed(1)}" stroke="${c}" stroke-width="3"/>`,
      `<line x1="${x - 8}" y1="${y(p.lo).toFixed(1)}" x2="${x + 8}" y2="${y(p.lo).toFixed(1)}" stroke="${c}" stroke-width="3"/>`,
      `<line x1="${x - 8}" y1="${y(p.hi).toFixed(1)}" x2="${x + 8}" y2="${y(p.hi).toFixed(1)}" stroke="${c}" stroke-width="3"/>`,
      `<circle cx="${x}" cy="${y(p.m).toFixed(1)}" r="6" fill="${c}"/>`,
      tx(x + 14, (y(p.m) + 4).toFixed(1), pct(p.m), 'font-weight="700"'),
      tx(x, B + 22, p.l, 'text-anchor="middle" font-size="13" font-weight="600"'),
      tx(x, B + 40, `range ${pct(p.lo)} to ${pct(p.hi)}`, 'text-anchor="middle" font-size="11" fill="#666"'));
  });
  o.push('</svg>');
  return o.join('');
}

const table = (head, body) => `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

const a = S[SMALL], b = S[LARGE];
const G = a.cs[0].generations;
const req = (arm, g) => PG[arm].sim[g] + PG[arm].hit[g];
const sum = (arr, from = 0) => arr.slice(from).reduce((s, x) => s + x, 0);
const hitShare = (arm) => sum(PG[arm].hit, 1) / (sum(PG[arm].hit, 1) + sum(PG[arm].sim, 1));
const genRows = Array.from({ length: G }, (_, g) => [String(g), int(PG[SMALL].sim[g]), int(PG[SMALL].hit[g]), int(PG[LARGE].sim[g]), int(PG[LARGE].hit[g])]);
const battleRatio = b.total / a.total, wallRatio = b.wall / a.wall, genRatio = b.gen / a.gen;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opponent Sweep</title>
<style>body{font:15px/1.55 system-ui,Helvetica,Arial,sans-serif;max-width:820px;margin:24px auto;padding:0 16px;color:#222;background:#fff}h1{font-size:22px}h2{font-size:17px;margin-top:28px}table{border-collapse:collapse;margin:12px 0;font-size:13px}th,td{border:1px solid #ddd;padding:4px 10px;text-align:right}th:first-child,td:first-child{text-align:left}.answer{background:#f3f4f6;border-left:4px solid #1d4ed8;padding:10px 14px}.small{color:#555;font-size:13px}</style></head><body>
<h1>Does adding opponents raise team quality, and what does it cost?</h1>
<p class="small">Setup: every candidate fights K=50 sampled opponents per generation, 200 candidates, 8 generations, Sequential Halving R=3. Compared: an opponent pool of 50 vs 500. ${n} seeds, both arms on the same seeds. Quality is the mean held-out win rate of each run's top 5 teams.</p>
<h2>Bottom line</h2>
<div class="answer"><b>NO.</b> 500 opponents did not find better teams than 50. Quality at 500 minus quality at 50: mean ${pt(v.mean)} points, 95% range ${pt(v.lower)} to ${pt(v.upper)}, n=${n} seeds. The whole range sits inside the ±${SWEEP_BAND * 100}-point band we treat as no meaningful difference, so the stop rule fired on NO at ${n} seeds. Cost: 500 opponents used ${battleRatio.toFixed(2)}x the battles and ${wallRatio.toFixed(2)}x the wall time of 50.</div>
<h2>Quality</h2>
${chart()}
${table(['Opponents', 'Quality (mean)', '95% range over seeds'], [['50', pct(a.m), `${pct(a.lo)} to ${pct(a.hi)}`], ['500', pct(b.m), `${pct(b.lo)} to ${pct(b.hi)}`]])}
<p class="small">The difference is paired by seed (same seed, both arms), so its range (${pt(v.lower)} to ${pt(v.upper)}) is what the verdict uses, not the overlap of the two ranges above.</p>
<h2>Cost</h2>
${table(['Per run, mean of ' + n + ' seeds', '50 opponents', '500 opponents', '500 ÷ 50'], [
  ['Battles in the 8 generations', int(a.gen), int(b.gen), `${genRatio.toFixed(2)}x`],
  ['Battles including the final scoring', int(a.total), int(b.total), `${battleRatio.toFixed(2)}x`],
  ['Wall time (s)', int(a.wall), int(b.wall), `${wallRatio.toFixed(2)}x`]])}
<p>Battles per generation (mean over ${n} seeds). "Simulated" is battles the engine really ran; "from cache" is pairings answered by an earlier identical battle. Simulated + from cache is how many pairings that generation asked for.</p>
${table(['Generation', '50: simulated', '50: from cache', '500: simulated', '500: from cache'], genRows)}
<h2>Why 500 opponents cost more</h2>
<p><b>Measured.</b> Both arms ask for about the same number of battles: generation 0 is identical (${int(PG[SMALL].sim[0])} in both), and from generation 1 on the pairings requested are ${int(req(SMALL, 1))} vs ${int(req(LARGE, 1))} in generation 1 and ${int(req(SMALL, G - 1))} vs ${int(req(LARGE, G - 1))} in the last generation. Fixing K does fix the number of pairings per generation: each candidate fights 50 opponents whatever the pool size. What differs is how many of those pairings were already fought. From generation 1 on, ${(hitShare(SMALL) * 100).toFixed(0)}% of the 50-opponent arm's pairings came from the cache; for the 500-opponent arm it was ${(hitShare(LARGE) * 100).toFixed(0)}%. The extra battles are the ones the 50-opponent arm never had to run.</p>
<p><b>Inferred from the code (not separately measured).</b> The cache is keyed on the exact team, lead and opponent (both seats). With a pool of 50 and K=50, every candidate fights the whole pool every generation, so a team that survives into the next generation (elites, unchanged offspring) meets opponents it already fought and costs nothing. With a pool of 500, each candidate gets a random 50 of the 500 each generation (<code>src/evolve/sampled.js</code>), so a surviving team mostly meets new opponents and has to be simulated again. The cost is therefore not "cost grows with the pool" in a direct sense; it is that a bigger pool makes the cache far less useful. I did not run an instrumented rerun to confirm this split, so treat the mechanism as the reading that fits both the code and the numbers above.</p>
<p><b>Claims elsewhere that this contradicts.</b> The <code>--sampled-opponents</code> text in <code>node scripts/evolve.mjs --help</code> and the RUNBOOK say the cost does not grow with the pool sizes. The measurement above says it does, by ${battleRatio.toFixed(2)}x in battles and ${wallRatio.toFixed(2)}x in wall time, once the cache is counted. Neither was edited in this round.</p>
</body></html>
`;
writeFileSync(OUT, html);
console.log(`wrote ${OUT}`);
