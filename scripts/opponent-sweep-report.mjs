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


/** ---- Why quality does not rise: everything below is read from saved checkpoints/results.json, no battles. ---- */
const ck = (arm, seed, g) => JSON.parse(readFileSync(path.join(DIR, `${arm}-${seed}`, `evolve-gen${g}.json`), 'utf8'));
const sig = (t) => t.join('|');
const speciesOf = (keys) => new Set(keys.map((k) => k.split('#')[0]));
const corr = (x, y) => { const mx = mean(x), my = mean(y); let c = 0, p = 0, q = 0; for (let i = 0; i < x.length; i++) { c += (x[i] - mx) * (y[i] - my); p += (x[i] - mx) ** 2; q += (y[i] - my) ** 2; } return c / Math.sqrt(p * q); };
const W = {};
const last = G - 1;
for (const arm of [SMALL, LARGE]) {
  const w = { poolSp0: [], poolSp7: [], popSp0: [], popSp7: [], kept: [], sd0: [], sd7: [], rx: [], ry: [], sizeSeen: 0 };
  for (const c of S[arm].cs) {
    const g0 = ck(arm, c.seed, 0), gN = ck(arm, c.seed, last);
    w.poolSp0.push(new Set(g0.opponentPool.flatMap((o) => o.members.map((m) => m.speciesId))).size);
    w.poolSp7.push(new Set(gN.opponentPool.flatMap((o) => o.members.map((m) => m.speciesId))).size);
    w.popSp0.push(speciesOf(g0.population.flat()).size);
    w.popSp7.push(speciesOf(gN.population.flat()).size);
    const s0 = new Set(g0.population.map(sig));
    w.kept.push(gN.population.filter((t) => s0.has(sig(t))).length);
    w.sd0.push(sd(Object.values(g0.winRateBySignature)));
    w.sd7.push(sd(Object.values(gN.winRateBySignature)));
    w.metaPool = g0.config.opponentMetaPool;
    for (let g = 0; g < last; g++) {
      const A = ck(arm, c.seed, g).winRateBySignature, B = ck(arm, c.seed, g + 1).winRateBySignature;
      for (const k in A) if (k in B) { w.rx.push(A[k]); w.ry.push(B[k]); }
    }
  }
  w.retest = corr(w.rx, w.ry);
  w.byRank = [0, 1, 2, 3, 4].map((k) => mean(S[arm].cs.map((c) => c.heldout[k])));
  w.rankGap = S[arm].cs.map((c) => c.heldout[0] - c.heldout[4]);
  w.teamSd = sd(S[arm].cs.flatMap((c) => c.heldout));
  w.seedSd = sd(S[arm].cs.map((c) => c.heldoutMeanTop));
  W[arm] = w;
}
const sameGen0 = seeds.filter((s) => JSON.stringify(ck(SMALL, s, 0).population) === JSON.stringify(ck(LARGE, s, 0).population)).length;
const poolInside = seeds.filter((s) => { const big = new Set(ck(LARGE, s, 0).opponentPool.map((o) => o.id)); return ck(SMALL, s, 0).opponentPool.every((o) => big.has(o.id)); }).length;
const top5 = (c) => new Set(c.finalists.slice(0, 5));
const overlap = rows.reduce((t, r) => t + [...top5(r.c)].filter((x) => top5(r.i).has(x)).length, 0);
const nHeld = data.heldoutCount, nTop = data.top;
const binHeld = Math.sqrt(0.25 / nHeld), binK = Math.sqrt(0.25 / 50);
const p1 = (x) => (x * 100).toFixed(1), p2 = (x) => (x * 100).toFixed(2);
const gapStat = (arm) => { const g = W[arm].rankGap; return `${pt(mean(g), 1)} (SE ${p1(sd(g) / Math.sqrt(n))})`; };

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opponent Sweep</title>
<style>body{font:15px/1.55 system-ui,Helvetica,Arial,sans-serif;max-width:820px;margin:24px auto;padding:0 16px;color:#222;background:#fff}h1{font-size:22px}h2{font-size:17px;margin-top:28px}table{border-collapse:collapse;margin:12px 0;font-size:13px}th,td{border:1px solid #ddd;padding:4px 10px;text-align:right}th:first-child,td:first-child{text-align:left}.answer{background:#f3f4f6;border-left:4px solid #1d4ed8;padding:10px 14px}.small{color:#555;font-size:13px}</style></head><body>
<h1>Does adding opponents raise team quality, and what does it cost?</h1>
<p class="small">Setup: every candidate fights K=50 sampled opponents per generation, 200 candidates, 8 generations, Sequential Halving R=3. Compared: an opponent pool of 50 vs 500. ${n} seeds, both arms on the same seeds. Quality is the mean held-out win rate of each run's top 5 teams.</p>
<h2>Bottom line</h2>
<div class="answer"><b>NO.</b> 500 opponents did not find better teams than 50. Quality at 500 minus quality at 50: mean ${pt(v.mean)} points, 95% range ${pt(v.lower)} to ${pt(v.upper)}, n=${n} seeds. The whole range sits inside the ±${SWEEP_BAND * 100}-point band we treat as no meaningful difference, so the stop rule fired on NO at ${n} seeds. Why: see “Why quality does not rise” below. Cost: 500 opponents used ${battleRatio.toFixed(2)}x the battles and ${wallRatio.toFixed(2)}x the wall time of 50.</div>
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
<h2>Why quality does not rise with 500 opponents</h2>
<div class="answer"><b>Short answer.</b> Extra opponents only help if they tell the search something the first 50 did not, and here they do not: 50 opponents already cover most of the field, each candidate is scored on the same number of opponents (50) either way, and the held-out test is noisy enough that a gain under about ${(t95(n - 1) * sd(rows.map((r) => r.i.heldoutMeanTop - r.c.heldoutMeanTop)) / Math.sqrt(n) * 100).toFixed(0)} points would not show. The data cannot tell us whether 8 generations of search beat the starting population at all; that would take a run listed at the end.</div>
<p class="small">Each claim is marked <b>Measured</b> (recomputed from the saved checkpoints of the ${n} seeds per arm, no new battles) or <b>Inferred</b> (a reading that fits the numbers, not tested).</p>
<p><b>1. The two arms start from the same place. Measured.</b> Generation 0 has the identical 200-team population in both arms on ${sameGen0} of ${n} seeds, and the 50 opponents of the small arm are inside the 500-opponent pool on ${poolInside} of ${n} seeds. The arms differ only in the extra 450 opponents.</p>
<p><b>2. 50 opponents already span most of the field. Measured.</b> The opponent pool draws from the top ${W[SMALL].metaPool} ranked species. At generation 0, 50 opponents contain ${mean(W[SMALL].poolSp0).toFixed(0)} of those species (${mean(W[LARGE].poolSp0).toFixed(0)} with 500). By the last generation the 50-opponent pool narrows to ${mean(W[SMALL].poolSp7).toFixed(0)} species and the 500 pool stays at ${mean(W[LARGE].poolSp7).toFixed(0)}. <b>Inferred:</b> the extra opponents are mostly the same species in other move sets and team arrangements, so they add repeats more than new kinds of threat.</p>
<p><b>3. Each candidate's score is as noisy in both arms. Measured + inferred.</b> Both arms score a candidate against 50 opponents. Measured spread of candidate win rates in the last generation: ${p1(mean(W[SMALL].sd7))} points (50 opponents), ${p1(mean(W[LARGE].sd7))} (500). Pure chance on 50 fights alone would be ${p1(binK)} points, so most of the spread between candidates could be luck of the draw (<b>inferred</b>: a rough binomial figure that ignores the fact the 50 are not independent). Measured: a team that survives to the next generation keeps its win rate with correlation ${W[SMALL].retest.toFixed(2)} (50 opponents) and ${W[LARGE].retest.toFixed(2)} (500). This includes the opponent pool changing between generations. The 500 arm is the less repeatable one, because every candidate draws a different random 50 of 500 each generation, and it still ends up equal on held-out.</p>
<p><b>4. The in-run ranking barely predicts held-out quality. Measured.</b> Mean held-out win rate of each run's top 5 finalists, in the order the run ranked them: 50 opponents ${W[SMALL].byRank.map((x) => p1(x)).join(', ')}%; 500 opponents ${W[LARGE].byRank.map((x) => p1(x)).join(', ')}%. Rank 1 minus rank 5: ${gapStat(SMALL)} points at 50, ${gapStat(LARGE)} at 500 (mean over seeds, points). Neither is clearly above zero and the middle ranks are not in order, so the search's fine ordering among its best teams carries little information.</p>
<p><b>5. The search moves the population only a little in 8 generations. Measured.</b> The population holds ${mean(W[SMALL].popSp0).toFixed(0)} species at generation 0 and ${mean(W[SMALL].popSp7).toFixed(0)} at the end (50 opponents); ${mean(W[LARGE].popSp0).toFixed(0)} and ${mean(W[LARGE].popSp7).toFixed(0)} at 500. ${mean(W[SMALL].kept).toFixed(0)} (50) and ${mean(W[LARGE].kept).toFixed(0)} (500) of the 200 starting teams are still in the final population. Each generation replaces about a third of the teams. <b>Inferred:</b> with that little convergence, the final teams are close to a lightly filtered random sample, and a different opponent pool has little room to steer them.</p>
<p><b>6. The two arms pick different teams and score the same. Measured.</b> The top-5 teams of the two arms on the same seed share ${overlap} of ${n * 5} teams, yet their held-out means are ${pct(a.m)} and ${pct(b.m)}. Both arms land on equally good but different teams, which fits a flat top: many teams are about equally good on this opponent set.</p>
<p><b>7. The measurement is noisy. Measured + inferred.</b> A single finalist's held-out win rate varies by ${p1(W[SMALL].teamSd)} points across all seeds and finalists (50) and ${p1(W[LARGE].teamSd)} (500); a 60-opponent test alone would give about ${p1(binHeld)} points from chance (<b>inferred</b>, same rough binomial). The mean of a run's top ${nTop} varies by ${p1(W[SMALL].seedSd)} and ${p1(W[LARGE].seedSd)} points across seeds. That is why ${n} seeds are needed and why differences under the ±${SWEEP_BAND * 100}-point band are not resolved.</p>
<p><b>What the data cannot decide.</b> (a) Whether the search improves on its own generation-0 population at all, and whether 50 opponents is enough because the search adds little or because 50 is a good sample. Deciding it needs held-out scoring of each seed's generation-0 top 5 against the same ${nHeld} held-out opponents (about ${nTop * n * 2 * nHeld} battles per arm-pair, no evolve run). (b) Whether more than 8 generations would let 500 opponents pay off. Deciding it needs longer runs at both sizes. Neither was run, since this round is limited to existing data.</p>
</body></html>
`;
writeFileSync(OUT, html);
console.log(`wrote ${OUT}`);
