#!/usr/bin/env node
// Round-9 focused report (plans/PLAN.md): reads out/sizing-cells-r9/state.json (written by
// scripts/sizing-sweep-r9.mjs) plus the prior post-fix cell dirs it drew from, and writes
// out/sizing-report-r9.html. Deterministic: no dates, no randomness, no external assets.
//   node scripts/sizing-report-r9.mjs [--dir out/sizing-cells-r9] [--out out/sizing-report-r9.html]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = path.resolve(ROOT, arg('--dir', 'out/sizing-cells-r9'));
const OUT = path.resolve(ROOT, arg('--out', 'out/sizing-report-r9.html'));
const STEP_MIN = 0.04; // must match scripts/sizing-sweep-r9.mjs

const PRIOR_DIRS = ['out/sampled-k-ab-r3', 'out/sizing-cells', 'out/sizing-cells-r8'];
const INFLATED = new Set(['k10/s6', 'k10/s7', 'p400/s6']);

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a');
const sgn = (x) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + f2(x) : 'n/a');
const fint = (x) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : 'n/a');
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => (a.length < 2 ? NaN : Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)));

const T90 = [0, 6.314, 2.920, 2.353, 2.132, 2.015, 1.943, 1.895, 1.860, 1.833, 1.812, 1.796, 1.782, 1.771, 1.761, 1.753,
  1.746, 1.740, 1.734, 1.729, 1.725, 1.721, 1.717, 1.714, 1.711, 1.708, 1.706, 1.703, 1.701, 1.699, 1.697];
const tCrit = (df) => (df >= 30 ? 1.645 : T90[Math.max(1, Math.round(df))]);
function welchCI(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const ma = mean(a), mb = mean(b), sa = sd(a), sb = sd(b);
  const va = sa * sa / a.length, vb = sb * sb / b.length;
  const se = Math.sqrt(va + vb);
  if (se === 0) return { m: mb - ma, lo: mb - ma, hi: mb - ma, df: a.length + b.length - 2 };
  const df = (va + vb) ** 2 / ((va * va) / (a.length - 1) + (vb * vb) / (b.length - 1));
  const t = tCrit(df);
  return { m: mb - ma, lo: mb - ma - t * se, hi: mb - ma + t * se, df };
}
function ci90(a) {
  if (a.length < 2) return { m: mean(a), lo: NaN, hi: NaN, n: a.length };
  const m = mean(a), h = tCrit(a.length - 1) * sd(a) / Math.sqrt(a.length);
  return { m, lo: m - h, hi: m + h, n: a.length };
}

// ---- load cells ---------------------------------------------------------------------------------------
function loadCells(dir) {
  const f = path.join(dir, 'results.json');
  if (!existsSync(f)) return { cells: [], armFlags: {} };
  const j = read(f);
  return { cells: j.cells, armFlags: j.armFlags ?? {} };
}
const allDirs = [...PRIOR_DIRS.map((d) => path.join(ROOT, d)), DIR];
const cellsByDir = allDirs.map((d) => ({ dir: d, ...loadCells(d) }));
const armFlags = Object.assign({}, ...cellsByDir.map((d) => d.armFlags));
function flagVal(flags, name) { const i = flags?.indexOf(name); return i >= 0 ? Number(flags[i + 1]) : undefined; }
function pointOf(arm) {
  const f = armFlags[arm];
  if (!f) return null;
  return { pop: flagVal(f, '--population'), pool: flagVal(f, '--opponents-per-gen'), k: flagVal(f, '--sampled-opponents') };
}
const allCells = [];
for (const d of cellsByDir) for (const c of d.cells) if (c.heldoutMeanTop != null) allCells.push({ ...c, dirLabel: path.relative(ROOT, d.dir) });
function isInflated(c) { return INFLATED.has(`${c.arm}/${c.seed}`); }
function cellsFor(arm) { return allCells.filter((c) => c.arm === arm); }
function qualityFor(arm) { return cellsFor(arm).map((c) => c.heldoutMeanTop * 100); }
function costFor(arm) { return cellsFor(arm).filter((c) => !isInflated(c)); }

const state = existsSync(path.join(DIR, 'state.json')) ? read(path.join(DIR, 'state.json')) : null;
const log = existsSync(path.join(DIR, 'sweep.log')) ? readFileSync(path.join(DIR, 'sweep.log'), 'utf8') : '';

// ---- per-dimension 90% ranges at the found/current point, for the answer table -------------------------
function armNameFor(pop, pool, k) {
  return Object.keys(armFlags).find((a) => { const p = pointOf(a); return p && p.pop === pop && p.pool === pool && p.k === k; }) ?? `c${pop}o${pool}k${k}`;
}
// Local-optimum check: at the converged point, neither a small step up nor down should be a
// significant (90% CI wholly > 0) improvement -- that is what "converged" means under pattern search.
function dimRanges(point) {
  const dims = ['pop', 'pool', 'k'];
  const clamp = (pop, pool, k) => ({ pop: Math.max(1, Math.round(pop)), pool: Math.max(1, Math.round(pool)), k: Math.max(1, Math.min(Math.round(k), Math.round(pool))) });
  const out = {};
  const cur = clamp(point.pop, point.pool, point.k);
  const curArm = armNameFor(cur.pop, cur.pool, cur.k);
  for (const dim of dims) {
    const v = cur[dim];
    const hiVal = v * (1 + STEP_MIN), loVal = v * (1 - STEP_MIN);
    const at = (val) => clamp(dim === 'pop' ? val : cur.pop, dim === 'pool' ? val : cur.pool, dim === 'k' ? val : cur.k);
    const hi = at(hiVal), lo = at(loVal);
    let upper = null, lower = null;
    if (hi[dim] !== v) { const hiArm = armNameFor(hi.pop, hi.pool, hi.k); upper = welchCI(qualityFor(curArm), qualityFor(hiArm)); }
    if (lo[dim] !== v) { const loArm = armNameFor(lo.pop, lo.pool, lo.k); lower = welchCI(qualityFor(curArm), qualityFor(loArm)); }
    out[dim] = { v, upper, lower, curArm };
  }
  return out;
}

// ---- answer ---------------------------------------------------------------------------------------------
const found = state?.status === 'found';
const notFound = state?.status === 'not-found';
let recipeBlock;
if (found) {
  const P = state.point;
  const arm = armNameFor(P.pop, P.pool, P.k);
  const q = ci90(qualityFor(arm));
  const cCost = costFor(arm);
  const battles = cCost.length ? mean(cCost.map((c) => c.totalBattles)) : NaN;
  const secs = cCost.length ? mean(cCost.map((c) => c.totalSeconds)) : NaN;
  const ranges = dimRanges(P);
  recipeBlock = { P, arm, q, battles, secs, nCost: cCost.length, nAll: qualityFor(arm).length, ranges };
} else {
  recipeBlock = null;
}

// ---- search path -----------------------------------------------------------------------------------------
const pathSteps = (state?.path ?? []).map((s) => {
  const arm = armNameFor(s.to.pop, s.to.pool, s.to.k);
  const q = ci90(qualityFor(arm));
  const c = costFor(arm);
  return { ...s, arm, q, battles: c.length ? mean(c.map((x) => x.totalBattles)) : NaN, n: qualityFor(arm).length };
});

// ---- all cells table (quality vs cost) --------------------------------------------------------------------
const armsSeen = [...new Set(allCells.map((c) => c.arm))].sort();
const armRows = armsSeen.map((arm) => {
  const p = pointOf(arm);
  const q = ci90(qualityFor(arm));
  const c = costFor(arm);
  const nInflated = cellsFor(arm).length - c.length;
  return { arm, p, q, n: qualityFor(arm).length, battles: c.length ? mean(c.map((x) => x.totalBattles)) : NaN, secs: c.length ? mean(c.map((x) => x.totalSeconds)) : NaN, nInflated };
});

// ---- page ---------------------------------------------------------------------------------------------
const answerHtml = found
  ? `<p><b>Answer.</b> Recipe found at 90% certainty: <b>${recipeBlock.P.pop} candidates, ${recipeBlock.P.pool}-opponent pool, K=${recipeBlock.P.k}</b>.<br>
Held-out quality: ${f1(recipeBlock.q.m)}% (90% range ${f1(recipeBlock.q.lo)}..${f1(recipeBlock.q.hi)}, ${recipeBlock.q.n} seeds).<br>
Cost: ${fint(recipeBlock.battles)} battles, ${fint(recipeBlock.secs)} s per run (${recipeBlock.nCost} non-inflated cells of ${recipeBlock.nAll} total).</p>`
  : `<p><b>Answer: not found.</b> ${notFound ? esc(state.reason) : 'The search has not finished yet (state: ' + esc(state?.status ?? 'no run started') + ').'} No recipe is recommended.</p>`;

const dimRows = found ? ['pop', 'pool', 'k'].map((dim) => {
  const r = recipeBlock.ranges[dim];
  const label = { pop: 'Candidate population', pool: 'Opponent pool', k: 'K' }[dim];
  const fmt = (ci) => !ci ? 'n/a (at boundary)' : `${sgn(ci.lo)}..${sgn(ci.hi)} pt`;
  const stable = (!r.upper || r.upper.lo <= 0) && (!r.lower || r.lower.lo <= 0);
  return `<tr><td>${label}</td><td>${r.v}</td><td>${fmt(r.upper)}</td><td>${fmt(r.lower)}</td><td>${stable ? 'yes' : 'no'}</td></tr>`;
}).join('') : '';

const pathRows = pathSteps.map((s) => `<tr><td>${s.pass}</td><td>${s.dim}</td><td>${s.action}</td><td>${s.arm}</td><td>pop=${s.to.pop} pool=${s.to.pool} k=${s.to.k}</td><td>${f1(s.q.m)}% <span class="dim">(n=${s.n})</span></td><td>${fint(s.battles)}</td></tr>`).join('');

const inflatedRows = allCells.filter(isInflated).map((c) => `<tr><td>${c.arm}-${c.seed}</td><td>${fint(c.wallSeconds)} s wall</td><td>${fint(c.totalSeconds)} s run</td><td>${c.dirLabel}</td></tr>`).join('');

const armTable = armRows.map((r) => `<tr><td>${r.arm}</td><td>${r.p ? `${r.p.pop}/${r.p.pool}/${r.p.k}` : 'n/a'}</td><td>${f1(r.q.m)}% <span class="dim">(${f1(r.q.lo)}..${f1(r.q.hi)})</span></td><td>${r.n}</td><td>${fint(r.battles)}</td><td>${r.nInflated ? `<span class="dim">${r.nInflated} inflated excluded</span>` : ''}</td></tr>`).join('');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Round 9: joint sizing recipe at 90% certainty</title>
<style>
:root{--bg:#fff;--fg:#1c2530;--dim:#66707c;--line:#d9dee4;--card:#f5f7fa;--ok:#1f7a4d;--bad:#b23b3b}
@media (prefers-color-scheme:dark){:root{--bg:#14181d;--fg:#e4e8ec;--dim:#98a2ad;--line:#2d353e;--card:#1c2229;--ok:#5fc48f;--bad:#e08787}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:960px;margin:0 auto;padding:16px}
h1{font-size:1.5rem;margin:.4em 0}h2{font-size:1.2rem;margin:1.6em 0 .4em}
table{border-collapse:collapse;width:100%;margin:.6em 0;font-size:.86rem;display:block;overflow-x:auto}
th,td{border-bottom:1px solid var(--line);padding:5px 8px;text-align:left;white-space:nowrap}
.dim{color:var(--dim)}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin:12px 0}
pre{white-space:pre-wrap;font-size:.78rem;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;max-height:320px;overflow:auto}
</style></head><body><main>
<h1>Round 9: joint (population, pool, K) sizing recipe at 90% certainty</h1>
<div class="card">${answerHtml}</div>

<h2>1. Method</h2>
<p><b>Hooke-Jeeves pattern search</b> over the three sizes (deviation from a literal doubling/halving "knee" sweep, per direct
instruction: doubling/halving only ever re-tests points already known to be worse, such as 500-opponent pools or 400-candidate
populations, and can only land on round powers of two). From the current point, each dimension is probed at +30%/-30%
(holding the other two fixed); if either neighbor is a statistically significant (Welch 90% CI on held-out-quality gain wholly
above 0 pt) improvement, the point moves there and the same step size is tried again from the new point (exploit). If neither
neighbor improves, the step for that dimension is halved and retried from the same point. A dimension is converged once its
step falls below 4%; the search is done once all three dimensions are converged, at whatever integer point that lands on -- not
necessarily a round number. Moving any one dimension re-probes all three next pass, since the point changed. If a single
comparison needs more than 40 seeds per side without resolving, it is treated as "not a confirmed improvement" (the step shrinks)
rather than stopping the whole search; the search only reports not-found if it exhausts its pass budget without all three
dimensions converging. Cells flagged as sleep/pause-inflated (below) are excluded from cost figures but kept in quality figures
(wall time does not change what was measured). Quality measure, collection and every other evolve setting are unchanged from
rounds 3-8.</p>

${found ? `<h2>2. Local-optimum check at the recommended recipe</h2>
<p class="dim">At the converged point, a final +/-4% probe on each size should not be a significant improvement in either direction --
that is what "converged" means here.</p>
<table><thead><tr><th>size</th><th>value</th><th>gain from +4%, 90% range</th><th>gain from -4%, 90% range</th><th>locally stable</th></tr></thead><tbody>${dimRows}</tbody></table>` : ''}

<h2>${found ? 3 : 2}. Search path</h2>
<p>${pathSteps.length ? 'Settings the search moved to, in order (a dimension check that did not move the point is not listed as a step):' : 'No moves recorded yet.'}</p>
${pathSteps.length ? `<table><thead><tr><th>pass</th><th>dim</th><th>action</th><th>arm</th><th>new point</th><th>quality</th><th>battles</th></tr></thead><tbody>${pathRows}</tbody></table>` : ''}

<h2>${found ? 4 : 3}. All cells: quality vs. cost</h2>
<table><thead><tr><th>arm</th><th>pop/pool/K</th><th>quality (90% range)</th><th>seeds</th><th>battles/run</th><th>notes</th></tr></thead><tbody>${armTable}</tbody></table>

<h2>${found ? 5 : 4}. Inflated cells (excluded from cost)</h2>
${inflatedRows ? `<table><thead><tr><th>cell</th><th>wall time</th><th>run time</th><th>dir</th></tr></thead><tbody>${inflatedRows}</tbody></table>` : '<p>None found among the cells loaded.</p>'}

<h2>${found ? 6 : 5}. Raw sweep log</h2>
<pre>${esc(log || 'no sweep.log yet')}</pre>
</main></body></html>
`;
writeFileSync(OUT, html);
console.log(`wrote ${OUT}`);
