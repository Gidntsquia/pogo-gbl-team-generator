#!/usr/bin/env node
// Round-10 focused report (plans/PLAN.md round 10, requirement 8): reads out/sizing-cells-r10/state.json
// (written by scripts/sizing-sweep-r10.mjs) plus every prior cell dir and the held-out store, and writes
// out/sizing-report-r10.html. Deterministic: no dates, no randomness, no external assets -- two runs over
// the same on-disk state are byte-identical.
//   node scripts/sizing-report-r10.mjs [--out out/sizing-report-r10.html] [--n 300]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  FULL_GENERATIONS, TOP, armName, features, fitCost, kneeEstimate, kneeTests, ols, BOUNDS, trustBounds, loadAllCells,
} from './sizing-lib-r10.mjs';
import { loadStore, qualityAt } from './heldout-store-r10.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(ROOT, arg('--out', 'out/sizing-report-r10.html'));
const N = Number(arg('--n', '300'));
const STATE_FILE = path.join(ROOT, 'out', 'sizing-cells-r10', 'state.json');
const CORRELATIONS = { o500: -0.06, k10: -0.07, p50: 0.28, k25: 0.20, p100: 0.11, p400: -0.11, c260o50k50: 0.07 };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(2) : 'n/a');
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a');
const f4 = (x) => (Number.isFinite(x) ? x.toFixed(4) : 'n/a');
const fint = (x) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : 'n/a');
const sizeStr = (s) => `pop=${s.pop}, pool=${s.pool}, K=${s.k}`;

function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }
function sd(a) { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }

async function main() {
  const { cellFlags } = await import('./compare-search.mjs');
  const cells = loadAllCells(cellFlags);
  const store = loadStore();
  const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : null;

  function withQuality(c, n) {
    const q = qualityAt(store, c.finalists.slice(0, TOP), n);
    return { ...c, qualityN: q ? q.meanTop : null };
  }
  const scored = cells.map((c) => withQuality(c, N));
  const full = scored.filter((c) => !c.cheap && c.qualityN != null && !c.inflated);
  const cheapLabeled = scored.filter((c) => c.cheap);

  // Fit the model on full-cost, non-inflated cells.
  let fit = null, recipe = null, tests = null, passAll = false, cost = null, fitError = null;
  if (full.length > features({ pop: 1, pool: 1, k: 1 }).length) {
    try {
      fit = ols(full.map((c) => features(c.sizes)), full.map((c) => c.qualityN));
      recipe = kneeEstimate(fit, trustBounds(full, BOUNDS)).sizes;
      tests = kneeTests(fit, recipe);
      passAll = Object.values(tests).every((t) => t.pass);
      cost = fitCost(full);
    } catch (e) {
      fitError = e.message; // e.g. not enough size variation yet to identify every term
    }
  }

  // o50 per-cell sd before (old 60-opponent numbers, if present) and after (this round's N).
  const o50Cells = cells.filter((c) => c.arm === 'o50');
  const o50Old = o50Cells.map((c) => c.old60).filter((v) => v != null);
  const o50New = o50Cells.map((c) => qualityAt(store, c.finalists.slice(0, TOP), N)?.meanTop).filter((v) => v != null);

  const found = passAll && state?.status === 'found' && state.confirm?.inside;

  const lines = [];
  lines.push('<!doctype html><html><head><meta charset="utf-8"><title>Sizing report -- round 10</title>');
  lines.push('<style>body{font-family:monospace;max-width:980px;margin:2em auto;padding:0 1em;color:#111}');
  lines.push('table{border-collapse:collapse;width:100%;margin:1em 0}td,th{border:1px solid #ccc;padding:4px 8px;text-align:right}');
  lines.push('th{text-align:left}.lbl{font-size:.8em;color:#666}.flag{color:#a30}.pass{color:#070}.answer{font-size:1.3em;font-weight:bold}</style></head><body>');
  lines.push('<h1>Sizing report -- round 10</h1>');

  // ---- plain answer first ---------------------------------------------------------------------------
  lines.push('<p class="answer">');
  if (found) {
    lines.push(`Found: ${esc(sizeStr(recipe))} <span class="lbl">(inferred, from the fitted model)</span>.`);
  } else if (state?.status === 'not-found') {
    lines.push(`Not found -- ${esc(state.reason ?? 'the fit shows no knee within the sizes evolve accepts.')}`);
  } else {
    lines.push('Not found yet -- the batch has not converged (state: ' + esc(state?.status ?? 'no state.json written') + (fitError ? `; fit error: ${esc(fitError)}` : '') + ').');
  }
  lines.push('</p>');

  if (found) {
    const battles = cost.battles(recipe);
    const seconds = cost.seconds(recipe);
    lines.push('<h2>Recipe</h2><table><tr><th>size</th><th>value</th><th>label</th></tr>');
    lines.push(`<tr><td>population</td><td>${recipe.pop}</td><td class="lbl">inferred</td></tr>`);
    lines.push(`<tr><td>opponents-per-gen (pool)</td><td>${recipe.pool}</td><td class="lbl">inferred</td></tr>`);
    lines.push(`<tr><td>sampled-opponents (K)</td><td>${recipe.k}</td><td class="lbl">inferred</td></tr>`);
    const predQ = features(recipe).reduce((s, x, i) => s + x * fit.beta[i], 0);
    lines.push(`<tr><td>predicted quality</td><td>${pct(predQ)}%</td><td class="lbl">inferred, from the fit</td></tr>`);
    lines.push(`<tr><td>confirmed quality (${state.confirm.n} fresh full-cost seeds)</td><td>${pct(state.confirm.confirmMean)}%</td><td class="lbl">measured</td></tr>`);
    lines.push(`<tr><td>predicted cost (battles)</td><td>${fint(battles)}</td><td class="lbl">inferred, from the cost model</td></tr>`);
    lines.push(`<tr><td>predicted cost (wall s)</td><td>${fint(seconds)}</td><td class="lbl">inferred, from the cost model</td></tr>`);
    lines.push('</table>');
  }

  // ---- per-size 90% ranges ---------------------------------------------------------------------------
  if (tests) {
    lines.push('<h2>Per-size 90% knee tests</h2><table><tr><th>size</th><th>doubling gain (90%)</th><th>halving gain (90%)</th><th>pass?</th></tr>');
    for (const key of ['pop', 'pool', 'k']) {
      const t = tests[key];
      const up = t.upExempt ? `exempt: ${esc(t.upExempt)}` : `[${f2(t.up.lo)}, ${f2(t.up.hi)}]`;
      const down = t.downExempt ? `exempt: ${esc(t.downExempt)}` : `[${f2(t.down.lo)}, ${f2(t.down.hi)}]`;
      lines.push(`<tr><td>${key}</td><td>${up}</td><td>${down}</td><td class="${t.pass ? 'pass' : 'flag'}">${t.pass ? 'pass' : 'fail'}</td></tr>`);
    }
    lines.push('</table>');
    lines.push(`<p class="lbl">Ranges are 90% two-sided from one model fit to ${full.length} full-cost, non-inflated cells (see Model below). Exemptions per plans/PLAN.md requirement 2: evolve's minimum population, or pool &le; K for the pool's lower test. When K &ge; pool, K's upper test doubles the pool with K (doubling K alone changes nothing).</p>`);
  }

  // ---- model ------------------------------------------------------------------------------------------
  lines.push('<h2>Model</h2>');
  lines.push('<p>quality = intercept + &sum; (b_i &middot; log2 size_i + c_i &middot; log2 size_i&sup2;) + &sum;<sub>i&lt;j</sub> d_ij &middot; log2 size_i &middot; log2 size_j, over population, pool and K (K capped at the pool; log sizes centered on 200/50/50), fit by ordinary least squares on full-cost, non-inflated cells only. A negative c_i gives that size a knee: the fitted gain per doubling shrinks as the size grows. The d_ij terms let one size's gain depend on the other two (e.g. a bigger population is worth more when fitness comes from more opponents).</p>');
  if (fit) {
    lines.push(`<p>Residual sd: ${f4(fit.residSd)} (n=${fit.n}, df=${fit.df}).</p>`);
    lines.push('<p class="lbl">Assumptions: independent, homoscedastic, normally distributed residuals across cells; the quadratic-in-log form with pairwise interactions is the whole model (no three-way or higher terms) -- the report does not claim more than this form can express.</p>');
  } else {
    lines.push('<p>Not enough full-cost, non-inflated cells to fit yet.</p>');
  }

  // ---- held-out set / noise -----------------------------------------------------------------------------
  lines.push('<h2>Held-out set size and per-cell noise</h2>');
  lines.push(`<p>New held-out set size: <b>${N}</b> opponents (old set: 60; the new set's first 60 opponents are byte-identical to the old set, verified separately). o50 per-cell sd: old60=${f4(sd(o50Old))} (n=${o50Old.length} cells), new${N}=${f4(sd(o50New))} (n=${o50New.length} cells).</p>`);

  // ---- seed pairing --------------------------------------------------------------------------------------
  lines.push('<h2>Seed pairing</h2>');
  lines.push('<p>Not built. Measured seed-shared correlations against o50 were near zero or weakly positive (paired-difference sd equal to unpaired sd to 2 decimals), so pairing would not reduce noise here: ');
  lines.push(Object.entries(CORRELATIONS).map(([k, v]) => `${esc(k)} r=${v}`).join(', '));
  lines.push('.</p>');

  // ---- search path / all cells ---------------------------------------------------------------------------
  lines.push('<h2>Search path and quality vs. cost (all cells)</h2>');
  lines.push('<table><tr><th>cell</th><th>pop</th><th>pool</th><th>K</th><th>gens</th><th>quality@' + N + '</th><th>battles</th><th>wall s</th><th>flags</th></tr>');
  for (const c of scored) {
    const flags = [];
    if (c.inflated) flags.push(`inflated: ${c.inflated}`);
    if (c.cheap) flags.push(`cheap (g${c.generations})`);
    if (c.sharedCacheBattles) flags.push(`shared cache: ${fint(c.sharedCacheBattles)} of ${fint(c.totalBattlesStandalone)} battles reused (wall s is lower than standalone)`);
    lines.push(`<tr><td>${esc(c.key)}</td><td>${c.sizes.pop}</td><td>${c.sizes.pool}</td><td>${c.sizes.k}</td><td>${c.generations}</td><td>${pct(c.qualityN)}%</td><td>${fint(c.totalBattles)}</td><td>${fint(c.wallSeconds)}</td><td class="flag">${esc(flags.join('; '))}</td></tr>`);
  }
  lines.push('</table>');
  lines.push(`<p class="lbl">Cheap cells (${cheapLabeled.length}) are shown but excluded from the fit and from cost figures above; the recipe and its ranges rest only on full-cost, non-inflated cells (${full.length} of them).</p>`);

  lines.push('</body></html>');
  writeFileSync(OUT, lines.join('\n') + '\n');
  console.log(`wrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
