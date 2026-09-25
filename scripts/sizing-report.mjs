#!/usr/bin/env node
// Focused sizing report (plans/PLAN.md round 7): where does held-out quality stop paying for cost, for candidate
// population, opponent pool size and K? Reads saved cell results only; writes out/sizing-report.html.
//   node scripts/sizing-report.mjs [--out out/sizing-report.html] [--threshold 1]
// Deterministic: no dates, no randomness, no external assets.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(ROOT, arg('--out', 'out/sizing-report.html'));
const THRESHOLD = Number(arg('--threshold', '1')); // points of quality per doubling of battles
const read = (p) => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8'));

// ---- data -------------------------------------------------------------------------------------------------
const r3 = read('out/sampled-k-ab-r3/results.json').cells; // post-fix o50/o500, s1-s21
const r2 = read('out/sampled-k-ab/results.json').cells; // pre-fix: o50,o500 s1-s5, c40, c320, k10eq (+ base, unused)
const sizeFile = 'out/sizing-cells/results.json';
const nw = existsSync(path.join(ROOT, sizeFile)) ? read(sizeFile).cells.filter((c) => c.heldoutMeanTop != null) : [];

// Setting of each arm: candidates P, opponent pool O, K.
const CFG = {
  o50: [200, 50, 50], o500: [200, 500, 50], p50: [50, 50, 50], p100: [100, 50, 50], p400: [400, 50, 50],
  o100: [200, 100, 50], o200: [200, 200, 50], k10: [200, 50, 10], k25: [200, 50, 25],
  c40: [40, 500, 50], c320: [320, 500, 50], k10eq: [56, 300, 10],
};
const cell = (c, prefix, source) => ({ arm: c.arm, seed: c.seed, q: c.heldoutMeanTop * 100, battles: c.totalBattles, secs: c.totalSeconds, prefix, source });
const cells = [
  ...r3.filter((c) => c.heldoutMeanTop != null).map((c) => cell(c, false, 'existing')),
  ...nw.map((c) => cell(c, false, 'new')),
  ...r2.filter((c) => ['o50', 'o500', 'c40', 'c320', 'k10eq'].includes(c.arm)).map((c) => cell({ ...c }, true, 'existing')),
];
const pre = (arm, seed) => cells.find((c) => c.arm === arm && c.seed === seed && c.prefix);
const key = (prefix, arm) => cells.filter((c) => c.arm === arm && c.prefix === prefix);

// ---- statistics -------------------------------------------------------------------------------------------
const T95 = [NaN, NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086];
const t95 = (n) => (n < 2 ? NaN : n - 1 < T95.length ? T95[n - 1] : 1.96 + 2.4 / (n - 1));
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => (a.length < 2 ? NaN : Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)));
const ci = (a) => { const m = mean(a), h = t95(a.length) * sd(a) / Math.sqrt(a.length); return { m, lo: m - h, hi: m + h, n: a.length }; };
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a');
const sgn = (x) => (x >= 0 ? '+' : '') + f2(x);
const fint = (x) => Math.round(x).toLocaleString('en-US');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function point(prefix, arm) {
  const c = key(prefix, arm);
  if (!c.length) return null;
  const q = ci(c.map((x) => x.q));
  return {
    arm, prefix, cfg: CFG[arm], n: c.length, q, seeds: c.map((x) => x.seed),
    battles: mean(c.map((x) => x.battles)), secs: mean(c.map((x) => x.secs)),
    nExisting: c.filter((x) => x.source === 'existing').length, nNew: c.filter((x) => x.source === 'new').length,
  };
}
/** Paired difference (b - a) on seeds both finished, same fix state. */
function paired(a, b, prefix) {
  const A = key(prefix, a), B = key(prefix, b);
  const d = [];
  for (const x of A) { const y = B.find((z) => z.seed === x.seed); if (y) d.push(y.q - x.q); }
  return d.length >= 2 ? ci(d) : null;
}

// ---- axes -------------------------------------------------------------------------------------------------
// Each axis: ordered arms (post-fix, other two knobs at baseline), label of the moving value.
const AXES = [
  { id: 'P', name: 'Candidate population', unit: 'candidates', held: '50-opponent pool, K=50', arms: ['p50', 'p100', 'o50', 'p400'], value: (a) => CFG[a][0],
    prefixArms: ['c40', 'o500', 'c320'], prefixNote: 'Pre-fix series at a 500-opponent pool (K=50): 40 and 320 candidates are pre-fix, 200 is post-fix (o500).' },
  { id: 'O', name: 'Opponent pool size', unit: 'opponents', held: '200 candidates, K=50', arms: ['o50', 'o100', 'o200', 'o500'], value: (a) => CFG[a][1] },
  { id: 'K', name: 'K (opponents per candidate per generation)', unit: 'K', held: '200 candidates, 50-opponent pool', arms: ['k10', 'k25', 'o50'], value: (a) => CFG[a][2] },
];

function analyse(ax) {
  const pts = ax.arms.map((a) => point(false, a)).filter(Boolean).sort((x, y) => x.battles - y.battles);
  const steps = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dbl = Math.log2(b.battles / a.battles);
    const d = paired(a.arm, b.arm, false);
    const dq = d ?? { m: b.q.m - a.q.m, lo: NaN, hi: NaN, n: 0 };
    steps.push({ a, b, dbl, gain: dq.m, gpd: dq.m / dbl, gpdHi: d ? d.hi / dbl : NaN, gpdLo: d ? d.lo / dbl : NaN, paired: !!d, n: dq.n });
  }
  // Knee: smallest setting whose next step, and every later step, gains under the threshold per doubling (point estimates).
  let kneeIdx = -1;
  for (let i = 0; i < steps.length; i++) if (steps.slice(i).every((s) => s.gpd < THRESHOLD)) { kneeIdx = i; break; }
  let status, kneePt = null, text, range, need;
  const largest = pts[pts.length - 1], smallest = pts[0];
  if (pts.length < 2) { status = 'none'; text = 'Not enough settings measured yet.'; }
  else if (kneeIdx < 0) {
    status = 'not-located'; kneePt = null;
    text = `Knee not located: the step to the largest measured setting (${ax.value(largest.arm)} ${ax.unit}) still gained ${f2(steps[steps.length - 1].gpd)} pt per doubling, at or above ${THRESHOLD}.`;
    range = `at or above ${ax.value(largest.arm)} ${ax.unit}`; need = `run a setting above ${ax.value(largest.arm)} ${ax.unit} on the same seeds`;
  } else {
    kneePt = steps[kneeIdx].a;
    const later = steps.slice(kneeIdx);
    const sure = later.every((s) => s.paired && Number.isFinite(s.gpdHi) && s.gpdHi < THRESHOLD);
    if (kneeIdx === 0) {
      status = 'at-floor';
      text = `Every measured step gains under ${THRESHOLD} pt per doubling, starting from the smallest setting (${ax.value(smallest.arm)} ${ax.unit}), so the knee is at or below it.`;
      range = `at or below ${ax.value(smallest.arm)} ${ax.unit}`; need = `run a setting below ${ax.value(smallest.arm)} ${ax.unit}`;
    } else if (sure) {
      status = 'located';
      text = `Knee at ${ax.value(kneePt.arm)} ${ax.unit}: past it every step gains under ${THRESHOLD} pt per doubling, and the 95% upper bound of each is also under ${THRESHOLD}.`;
      range = `${ax.value(kneePt.arm)} ${ax.unit}`;
    } else {
      status = 'likely';
      text = `Knee at about ${ax.value(kneePt.arm)} ${ax.unit} by the point estimates, but the 95% upper bound of at least one later step is above ${THRESHOLD} pt per doubling, so the data cannot rule out a higher knee.`;
      const above = later.find((s) => !(s.paired && s.gpdHi < THRESHOLD));
      range = `between ${ax.value(kneePt.arm)} and ${ax.value(above.b.arm)} ${ax.unit}`;
      need = `more seeds on ${ax.value(above.a.arm)} and ${ax.value(above.b.arm)} ${ax.unit} (each seed adds about ${f1(above.b.secs / 60)} min for the larger one)`;
    }
  }
  return { ax, pts, steps, status, kneePt, text, range, need, prePts: (ax.prefixArms ?? []).map((a) => point(true, a)).filter(Boolean) };
}
const results = AXES.map(analyse);

// ---- charts -----------------------------------------------------------------------------------------------
function chart(res) {
  const W = 620, H = 300, L = 56, R = 16, T = 16, B = 44;
  const all = [...res.pts, ...res.prePts];
  if (!all.length) return '';
  const xs = all.map((p) => Math.log2(p.battles));
  const x0 = Math.floor(Math.min(...xs) - 0.3), x1 = Math.ceil(Math.max(...xs) + 0.3);
  const ys = all.flatMap((p) => [p.q.lo, p.q.hi]).filter(Number.isFinite);
  const y0 = Math.floor(Math.min(...ys, ...all.map((p) => p.q.m)) - 1), y1 = Math.ceil(Math.max(...ys, ...all.map((p) => p.q.m)) + 1);
  const px = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R), py = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Held-out quality against battles per run, ${esc(res.ax.name)}">`;
  for (let y = y0; y <= y1; y += Math.max(1, Math.ceil((y1 - y0) / 6))) s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${py(y).toFixed(1)}" y2="${py(y).toFixed(1)}"/><text class="tick" x="${L - 6}" y="${(py(y) + 4).toFixed(1)}" text-anchor="end">${y}%</text>`;
  for (let x = x0; x <= x1; x++) s += `<text class="tick" x="${px(x).toFixed(1)}" y="${H - B + 16}" text-anchor="middle">${fint(2 ** x)}</text>`;
  s += `<text class="axis" x="${((L + W - R) / 2).toFixed(0)}" y="${H - 6}" text-anchor="middle">battles per run (log scale)</text>`;
  s += `<text class="axis" transform="translate(12 ${((T + H - B) / 2).toFixed(0)}) rotate(-90)" text-anchor="middle">held-out quality</text>`;
  const line = (pts, cls) => pts.length > 1 ? `<polyline class="${cls}" fill="none" points="${pts.map((p) => `${px(Math.log2(p.battles)).toFixed(1)},${py(p.q.m).toFixed(1)}`).join(' ')}"/>` : '';
  const dots = (pts, cls, open) => pts.map((p) => {
    const cx = px(Math.log2(p.battles)).toFixed(1);
    const bar = Number.isFinite(p.q.lo) ? `<line class="err ${cls}" x1="${cx}" x2="${cx}" y1="${py(p.q.lo).toFixed(1)}" y2="${py(p.q.hi).toFixed(1)}"/>` : '';
    return `${bar}<circle class="dot ${cls}${open ? ' open' : ''}" cx="${cx}" cy="${py(p.q.m).toFixed(1)}" r="5"/><text class="lab" x="${cx}" y="${(py(p.q.m) - 10).toFixed(1)}" text-anchor="middle">${res.ax.value(p.arm)}${open ? ' (pre-fix)' : ''}</text>`;
  }).join('');
  s += line(res.pts, 'ln post') + dots(res.pts, 'post', false);
  s += line(res.prePts, 'ln prefix') + dots(res.prePts, 'prefix', true);
  return s + '</svg>';
}

// ---- tables -----------------------------------------------------------------------------------------------
const tag = (m) => `<span class="tag ${m}">${m}</span>`;
function table(res) {
  const rows = [...res.pts, ...res.prePts].map((p) => `<tr><td>${res.ax.value(p.arm)}${p.prefix ? ' <span class="pf">pre-fix</span>' : ''}</td><td>${f1(p.q.m)}% <span class="dim">(${f1(p.q.lo)}..${f1(p.q.hi)})</span></td><td>${fint(p.battles)}</td><td>${fint(p.secs)} s</td><td>${p.n}</td><td>${p.nExisting} existing / ${p.nNew} new</td></tr>`).join('');
  const st = res.steps.map((s) => `<tr><td>${res.ax.value(s.a.arm)} &rarr; ${res.ax.value(s.b.arm)}</td><td>${sgn(s.gain)} pt${s.paired ? ` <span class="dim">(paired, ${s.n} seeds)</span>` : ' <span class="dim">(unpaired)</span>'}</td><td>${f2(s.dbl)}</td><td>${sgn(s.gpd)}${s.paired ? ` <span class="dim">(${sgn(s.gpdLo)}..${sgn(s.gpdHi)})</span>` : ''}</td></tr>`).join('');
  return `<table><thead><tr><th>${esc(res.ax.unit)}</th><th>quality, mean (95% range)</th><th>battles / run</th><th>wall / run</th><th>seeds</th><th>cells</th></tr></thead><tbody>${rows}</tbody></table>
<table><thead><tr><th>step</th><th>quality change</th><th>doublings of battles</th><th>pt per doubling (95% range)</th></tr></thead><tbody>${st}</tbody></table>`;
}

// ---- recommendation ---------------------------------------------------------------------------------------
const base = point(false, 'o50');
const pick = (res) => res.kneePt ?? (res.status === 'not-located' ? res.pts[res.pts.length - 1] : res.status === 'at-floor' ? res.pts[0] : null);
const picks = results.map(pick);
const recVals = picks.map((p, i) => (p ? results[i].ax.value(p.arm) : null));
const isBaseCombo = picks.every((p) => p && (p.arm === 'o50' || false));
let recText;
{
  const [pp, po, pk] = picks;
  if (picks.some((p) => !p)) recText = { vals: 'not enough data yet', q: 'n/a', cost: 'n/a', label: 'inferred' };
  else {
    const dq = [pp, po, pk].reduce((s, p) => s + (p.q.m - base.q.m), 0);
    const ratio = [pp, po, pk].reduce((s, p) => s * (p.battles / base.battles), 1);
    const rsec = [pp, po, pk].reduce((s, p) => s * (p.secs / base.secs), 1);
    const ran = isBaseCombo;
    recText = {
      vals: `${recVals[0]} candidates, ${recVals[1]}-opponent pool, K=${recVals[2]}`,
      q: ran ? `${f1(base.q.m)}% (${f1(base.q.lo)}..${f1(base.q.hi)})` : `about ${f1(base.q.m + dq)}% (sum of the measured one-knob changes from the baseline; not run as a combination)`,
      cost: ran ? `${fint(base.battles)} battles, ${fint(base.secs)} s per run` : `about ${fint(base.battles * ratio)} battles, ${fint(base.secs * rsec)} s per run (baseline times the one-knob cost ratios; not run)`,
      label: ran ? 'measured' : 'inferred',
    };
  }
}

// ---- pre-fix vs post-fix ----------------------------------------------------------------------------------
const pf = ['o50', 'o500'].map((arm) => {
  const seeds = ['s1', 's2', 's3', 's4', 's5'];
  const a = seeds.map((s) => pre(arm, s)).filter(Boolean), b = seeds.map((s) => cells.find((c) => c.arm === arm && c.seed === s && !c.prefix)).filter(Boolean);
  const d = a.map((x, i) => b[i].q - x.q);
  return { arm, n: a.length, preQ: mean(a.map((x) => x.q)), postQ: mean(b.map((x) => x.q)), dq: ci(d), preB: mean(a.map((x) => x.battles)), postB: mean(b.map((x) => x.battles)), preS: mean(a.map((x) => x.secs)), postS: mean(b.map((x) => x.secs)) };
});

// ---- page -------------------------------------------------------------------------------------------------
const spent = nw.reduce((t, c) => t + (c.totalSeconds ?? 0), 0);
const newCount = nw.length;
const verdictWord = { located: 'located', likely: 'likely (not certain)', 'not-located': 'not located', 'at-floor': 'at or below the smallest setting tried', none: 'no data' };
const answerRows = results.map((r, i) => `<tr><td>${esc(r.ax.name)}</td><td><b>${r.kneePt ? r.ax.value(r.kneePt.arm) : (r.status === 'not-located' ? '&ge; ' + r.ax.value(r.pts[r.pts.length - 1].arm) : '?')}</b></td><td>${picks[i] ? `${f1(picks[i].q.m)}% <span class="dim">(${f1(picks[i].q.lo)}..${f1(picks[i].q.hi)})</span>` : 'n/a'}</td><td>${picks[i] ? `${fint(picks[i].battles)} battles, ${fint(picks[i].secs)} s` : 'n/a'}</td><td>${esc(verdictWord[r.status])}${r.range ? `; lies ${esc(r.range)}` : ''} ${tag('measured')}</td></tr>`).join('');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sizing report: population, pool, K</title>
<style>
:root{--bg:#fff;--fg:#1c2530;--dim:#66707c;--line:#d9dee4;--post:#1d5fa8;--pre:#b26a00;--card:#f5f7fa;--ok:#1f7a4d;--inf:#8a4bbf}
@media (prefers-color-scheme:dark){:root{--bg:#14181d;--fg:#e4e8ec;--dim:#98a2ad;--line:#2d353e;--post:#6aa8ee;--pre:#e0a04a;--card:#1c2229;--ok:#5fc48f;--inf:#c197e6}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:920px;margin:0 auto;padding:16px}
h1{font-size:1.5rem;margin:.4em 0}h2{font-size:1.2rem;margin:1.6em 0 .4em}h3{font-size:1rem;margin:1.2em 0 .3em}
table{border-collapse:collapse;width:100%;margin:.6em 0;font-size:.88rem;display:block;overflow-x:auto}
th,td{border-bottom:1px solid var(--line);padding:5px 8px;text-align:left;white-space:nowrap}
.dim,.pf{color:var(--dim)}.pf{color:var(--pre);font-size:.8em}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin:12px 0}
.tag{font-size:.7rem;border:1px solid currentColor;border-radius:4px;padding:0 4px;text-transform:uppercase}.tag.measured{color:var(--ok)}.tag.inferred{color:var(--inf)}
svg{width:100%;height:auto;max-width:620px}.grid{stroke:var(--line)}.tick,.axis,.lab{fill:var(--dim);font-size:11px}
.ln{stroke-width:2}.ln.post{stroke:var(--post)}.ln.prefix{stroke:var(--pre);stroke-dasharray:4 3}
.dot.post{fill:var(--post)}.dot.prefix{stroke:var(--pre);fill:var(--bg);stroke-width:2}.err.post{stroke:var(--post)}.err.prefix{stroke:var(--pre)}
</style></head><body><main>
<h1>Sizing report: candidate population, opponent pool, K</h1>
<div class="card">
<p><b>Answer.</b> Recommended: <b>${esc(recText.vals)}</b> ${tag(recText.label)}.<br>
Held-out quality: ${esc(recText.q)}.<br>Cost: ${esc(recText.cost)}.</p>
<table><thead><tr><th>knob</th><th>knee</th><th>quality at knee</th><th>cost at knee</th><th>how sure</th></tr></thead><tbody>${answerRows}</tbody></table>
<p class="dim">Knee = the smallest setting past which each doubling of battles buys less than ${THRESHOLD} point of held-out quality. Quality = mean raw win rate of a run's top 5 finalists against 60 held-out opponents; error ranges are 95% (Student t) over seeds. The other two knobs sit at the baseline (200 candidates, 50-opponent pool, K=50) while one moves. Noise per run is about 2.9 pt, so a 1 pt change needs many seeds to see; where the range straddles the threshold, the report says the data cannot separate the settings.</p>
</div>
${results.map((r, i) => `<h2>${i + 1}. ${esc(r.ax.name)} <span class="dim">(held: ${esc(r.ax.held)})</span></h2>
<p>${esc(r.text)} ${tag('measured')}${r.need ? `<br><b>To pin it:</b> ${esc(r.need)}.` : ''}</p>
${chart(r)}
<p class="dim">Filled blue = post-fix cells. ${r.ax.prefixNote ? esc(r.ax.prefixNote) + ' Dashed orange, hollow markers = pre-fix.' : ''} Bars are 95% ranges over seeds.</p>
${table(r)}`).join('\n')}
<h2>4. Recommended combination</h2>
<p>${esc(recText.vals)} ${tag(recText.label)}. ${recText.label === 'inferred' ? 'This exact combination was not run. Quality is the baseline plus each knob\'s measured one-knob change (assumes the effects add up); battles and time are the baseline times each knob\'s measured cost ratio (assumes the costs multiply). Both assumptions are untested.' : 'This exact combination is the baseline setup, which was run.'}</p>
<h2>5. Pre-fix vs post-fix (same setting, seeds s1-s5)</h2>
<p>Runs made before the determinism fix (round 2) depended on thread order. Pre-fix cells appear only in the dashed series above and are never mixed into a post-fix point. ${tag('measured')}</p>
<table><thead><tr><th>setting</th><th>pre-fix quality</th><th>post-fix quality</th><th>post minus pre (95% range, paired)</th><th>battles pre / post</th><th>wall pre / post</th></tr></thead><tbody>
${pf.map((p) => `<tr><td>${p.arm === 'o50' ? '200 cand, 50 pool' : '200 cand, 500 pool'}</td><td>${f1(p.preQ)}%</td><td>${f1(p.postQ)}%</td><td>${sgn(p.dq.m)} (${sgn(p.dq.lo)}..${sgn(p.dq.hi)})</td><td>${fint(p.preB)} / ${fint(p.postB)}</td><td>${fint(p.preS)} / ${fint(p.postS)} s</td></tr>`).join('')}
</tbody></table>
<h2>6. Data used</h2>
<p>Existing cells folded in: 42 post-fix cells in <code>out/sampled-k-ab-r3/</code> (o50 and o500, s1-s21) and the 25 pre-fix <code>--sampled-opponents</code> cells in <code>out/sampled-k-ab/</code> (o50, o500, c40, c320, k10eq, s1-s5). New cells: ${newCount}, summed run time ${fint(spent)} s (${f2(spent / 3600)} h) of the 12 h budget (from <code>out/sizing-cells/sweep.log</code>; the budget counts run plus held-out scoring time). The k10eq cells (K=10, 56 candidates, 300-opponent pool) change all three knobs at once, so they are not on any curve; pre-fix mean ${f1(point(true, 'k10eq')?.q.m)}% at ${fint(point(true, 'k10eq')?.battles ?? NaN)} battles.</p>
<p class="dim">Setup for every cell: meta mode, no evolutions, 8 generations, elites 8, Sequential Halving R=3, final ratio 1, seeds shared across arms (same seed name = same start), collection <code>meta-collection-1500.csv</code>. Wall time is the evolve run only, on 8 threads, on one laptop; small pools also get cache hits, so battles and time both grow with pool size.</p>
</main></body></html>
`;
writeFileSync(OUT, html);
console.log(`wrote ${OUT}`);
