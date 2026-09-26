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
const r8File = 'out/sizing-cells-r8/results.json';
const load = (f) => (existsSync(path.join(ROOT, f)) ? read(f).cells.filter((c) => c.heldoutMeanTop != null) : []);
const r7 = load(sizeFile); // round 7 cells: existing
const nw = load(r8File); // round 8 cells: new

// Setting of each arm: candidates P, opponent pool O, K.
const CFG = {
  o50: [200, 50, 50], o500: [200, 500, 50], p50: [50, 50, 50], p100: [100, 50, 50], p400: [400, 50, 50],
  o100: [200, 100, 50], o200: [200, 200, 50], k10: [200, 50, 10], k25: [200, 50, 25],
  c40: [40, 500, 50], c320: [320, 500, 50], k10eq: [56, 300, 10],
};
const cell = (c, prefix, source) => ({ arm: c.arm, seed: c.seed, q: c.heldoutMeanTop * 100, battles: c.totalBattles, secs: c.totalSeconds, prefix, source, wall: c.wallSeconds });
const cells = [
  ...r3.filter((c) => c.heldoutMeanTop != null).map((c) => cell(c, false, 'existing')),
  ...r7.map((c) => cell(c, false, 'existing')),
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
  { id: 'O', name: 'Opponent pool size', unit: 'opponents', held: '200 candidates, K=50', arms: ['o50', 'o500'], extra: ['o100', 'o200'], value: (a) => CFG[a][1],
    prefixNote: 'Steps use only o50 and o500 (21 seeds each, paired); o100 and o200 (5 seeds) are shown but not stepped, since their small cost gaps make per-doubling ranges meaningless.' },
  { id: 'K', name: 'K (opponents per candidate per generation)', unit: 'K', held: '200 candidates, 50-opponent pool', arms: ['k10', 'k25', 'o50'], value: (a) => CFG[a][2] },
];

function analyse(ax) {
  const pts = ax.arms.map((a) => point(false, a)).filter(Boolean).sort((x, y) => x.battles - y.battles);
  const shown = ax.extra ? [...pts, ...ax.extra.map((a) => point(false, a)).filter(Boolean)].sort((x, y) => x.battles - y.battles) : pts;
  const steps = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dbl = Math.log2(b.battles / a.battles);
    const d = paired(a.arm, b.arm, false);
    const dq = d ?? { m: b.q.m - a.q.m, lo: NaN, hi: NaN, n: 0 };
    steps.push({ a, b, dbl, gain: dq.m, gpd: dq.m / dbl, gpdHi: d ? d.hi / dbl : NaN, gpdLo: d ? d.lo / dbl : NaN, paired: !!d, n: dq.n });
  }
  // Classify each step by its 95% range of gain per doubling against the threshold: below, above, or straddle (unknown).
  for (const st of steps) st.cls = !st.paired ? 'straddle' : st.gpdHi < THRESHOLD ? 'below' : st.gpdLo >= THRESHOLD ? 'above' : 'straddle';
  // Seeds needed to move the range off the threshold: half-width scales with 1/sqrt(n), and must shrink below the distance
  // from the point estimate to the threshold.
  for (const st of steps) {
    if (!st.paired) { st.needN = NaN; continue; }
    const h = (st.gpdHi - st.gpdLo) / 2, dist = Math.abs(THRESHOLD - st.gpd);
    st.halfW = h; st.needN = dist > 0 ? Math.ceil(st.n * (h / dist) ** 2) : Infinity;
  }
  const seedsText = (st) => !Number.isFinite(st.needN) ? 'no practical number of seeds (the estimate sits on the threshold)' : st.needN > 200 ? `over 200 seeds per setting (about ${st.needN}; not practical here)` : `about ${st.needN} paired seeds per setting if the estimate holds (${st.n} now)`;
  // Call: last step whose range is not wholly below the threshold (L) and last step wholly above it (U).
  let L = -1, U = -1;
  for (let i = 0; i < steps.length; i++) { if (steps[i].cls !== 'below') L = i; if (steps[i].cls === 'above') U = i; }
  // Point-estimate knee (used for the recommendation only): smallest setting after which every step's mean gain is under the threshold.
  let pe = steps.findIndex((_, i) => steps.slice(i).every((x) => x.gpd < THRESHOLD));
  const pickPt = pts.length < 2 ? null : pe < 0 ? pts[pts.length - 1] : pts[pe];
  let status, kneePt = null, text, range, need;
  const largest = pts[pts.length - 1], smallest = pts[0];
  const g = (st) => `${sgn(st.gpd)} pt per doubling (95% range ${sgn(st.gpdLo)}..${sgn(st.gpdHi)})`;
  const val = (pt) => `${ax.value(pt.arm)} ${ax.unit}`;
  const uns = steps.filter((x) => x.cls === 'straddle');
  if (pts.length < 2) { status = 'none'; text = 'Not enough settings measured yet.'; }
  else if (L < 0) {
    status = 'at-floor';
    text = `Every measured step's whole 95% range is under ${THRESHOLD} pt per doubling, starting at the smallest setting (${val(smallest)}), so the knee is at or below it.`;
    range = `at or below ${val(smallest)}`; need = `run a setting below ${val(smallest)}`;
  } else if (L === U && U === steps.length - 1) {
    status = 'not-located';
    text = `Knee not located: the last step (${val(steps[U].a)} to ${val(largest)}) gained ${g(steps[U])}, wholly at or above ${THRESHOLD}, so the knee lies above ${val(largest)}.`;
    range = `above ${val(largest)}`; need = `run a setting above ${val(largest)}`;
  } else if (L === U) {
    status = 'located'; kneePt = steps[U].b;
    text = `Knee at ${val(kneePt)}: the step into it gained ${g(steps[U])}, wholly at or above ${THRESHOLD}, and every step past it has its whole 95% range under ${THRESHOLD}.`;
    range = val(kneePt);
  } else {
    status = 'not-located';
    const lo = pts[U + 1], hi = pts[L + 1];
    text = `Knee not located: ${uns.map((st) => `the step ${ax.value(st.a.arm)} to ${ax.value(st.b.arm)} gained ${g(st)}`).join('; ')}. ${uns.length > 1 ? 'Those ranges contain' : 'That range contains'} ${THRESHOLD}, so the data does not say whether the gain is above or below the threshold. ${U >= 0 ? `The step into ${val(lo)} is wholly above it. ` : ''}The knee lies between ${ax.value(lo.arm)} and ${val(hi)}.`;
    range = `between ${ax.value(lo.arm)} and ${val(hi)}`;
    const worst = uns.reduce((m, x) => (x.needN > m.needN ? x : m), uns[0]);
    need = `${seedsText(worst)} for the step ${ax.value(worst.a.arm)} to ${ax.value(worst.b.arm)}; the larger setting costs about ${f1(worst.b.secs / 60)} min per seed`;
  }
  return { ax, pts, shown, steps, status, kneePt, pickPt, text, range, need, prePts: (ax.prefixArms ?? []).map((a) => point(true, a)).filter(Boolean) };
}
const results = AXES.map(analyse);

// ---- charts -----------------------------------------------------------------------------------------------
function chart(res) {
  const W = 620, H = 300, L = 56, R = 16, T = 16, B = 44;
  const all = [...res.shown, ...res.prePts];
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
  s += line(res.shown, 'ln post') + dots(res.shown, 'post', false);
  s += line(res.prePts, 'ln prefix') + dots(res.prePts, 'prefix', true);
  return s + '</svg>';
}

// ---- tables -----------------------------------------------------------------------------------------------
const tag = (m) => `<span class="tag ${m}">${m}</span>`;
function table(res) {
  const rows = [...res.shown, ...res.prePts].map((p) => `<tr><td>${res.ax.value(p.arm)}${p.prefix ? ' <span class="pf">pre-fix</span>' : ''}</td><td>${f1(p.q.m)}% <span class="dim">(${f1(p.q.lo)}..${f1(p.q.hi)})</span></td><td>${fint(p.battles)}</td><td>${fint(p.secs)} s</td><td>${p.n}</td><td>${p.nExisting} existing / ${p.nNew} new</td></tr>`).join('');
  const st = res.steps.map((s) => `<tr><td>${res.ax.value(s.a.arm)} &rarr; ${res.ax.value(s.b.arm)}</td><td>${sgn(s.gain)} pt${s.paired ? ` <span class="dim">(paired, ${s.n} seeds)</span>` : ' <span class="dim">(unpaired)</span>'}</td><td>${f2(s.dbl)}</td><td>${sgn(s.gpd)}${s.paired ? ` <span class="dim">(${sgn(s.gpdLo)}..${sgn(s.gpdHi)})</span>` : ''}</td></tr>`).join('');
  return `<table><thead><tr><th>${esc(res.ax.unit)}</th><th>quality, mean (95% range)</th><th>battles / run</th><th>wall / run</th><th>seeds</th><th>cells</th></tr></thead><tbody>${rows}</tbody></table>
<table><thead><tr><th>step</th><th>quality change</th><th>doublings of battles</th><th>pt per doubling (95% range)</th></tr></thead><tbody>${st}</tbody></table>`;
}

// ---- recommendation ---------------------------------------------------------------------------------------
const base = point(false, 'o50');
const picks = results.map((r) => r.pickPt ?? null);
const recVals = picks.map((p, i) => (p ? results[i].ax.value(p.arm) : null));
let recText;
{
  const [pp, po, pk] = picks;
  if (picks.some((p) => !p)) recText = { vals: 'not enough data yet', q: 'n/a', cost: 'n/a', label: 'inferred', sure: '' };
  else {
    // The combination is measured only if some arm ran exactly (P, O, K); otherwise it is composed from one-knob results.
    const ranArm = Object.keys(CFG).find((a) => !['c40', 'c320', 'k10eq'].includes(a) && CFG[a][0] === recVals[0] && CFG[a][1] === recVals[1] && CFG[a][2] === recVals[2] && point(false, a));
    const vals = `${recVals[0]} candidates, ${recVals[1]}-opponent pool, K=${recVals[2]}`;
    if (ranArm) {
      const p = point(false, ranArm);
      const dvb = ranArm === 'o50' ? null : paired('o50', ranArm, false);
      recText = {
        vals, label: 'measured',
        q: `${f1(p.q.m)}% (95% range ${f1(p.q.lo)}..${f1(p.q.hi)}, ${p.n} seeds)`,
        cost: `${fint(p.battles)} battles, ${fint(p.secs)} s per run`,
        sure: `This exact combination is the ${ranArm} arm, run on ${p.n} seeds (${p.nExisting} existing, ${p.nNew} new). Its quality is known to about +-${f1((p.q.hi - p.q.lo) / 2)} pt. ${dvb ? `Against the 200-candidate baseline (o50) the paired difference is ${sgn(dvb.m)} pt (95% range ${sgn(dvb.lo)}..${sgn(dvb.hi)}, ${dvb.n} seeds)${dvb.lo <= 0 && dvb.hi >= 0 ? ', which includes zero: the data does not show it beats the baseline' : ''}.` : ''}`,
      };
    } else {
      const dq = [pp, po, pk].reduce((s, p) => s + (p.q.m - base.q.m), 0);
      const ratio = [pp, po, pk].reduce((s, p) => s * (p.battles / base.battles), 1);
      const rsec = [pp, po, pk].reduce((s, p) => s * (p.secs / base.secs), 1);
      recText = {
        vals, label: 'inferred',
        q: `about ${f1(base.q.m + dq)}% (sum of the measured one-knob changes from the baseline; not run as a combination)`,
        cost: `about ${fint(base.battles * ratio)} battles, ${fint(base.secs * rsec)} s per run (baseline times the one-knob cost ratios; not run)`,
        sure: 'Not run as a combination: assumes the one-knob quality effects add and the costs multiply. Neither assumption is tested, so the quality figure has no error range.',
      };
    }
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
const nwCells = cells.filter((c) => c.source === 'new');
const spent = nwCells.reduce((t, c) => t + (c.wall ?? 0), 0);

const newCount = nwCells.length;
const inflated = cells.filter((c) => c.source !== undefined && !c.prefix && c.wall != null && c.secs != null && c.wall > 1.5 * c.secs + 600);
const allocRows = ['k10', 'p50', 'k25', 'p100', 'o50', 'p400', 'o100', 'o200', 'o500'].map((a) => { const c = cells.filter((x) => x.arm === a && !x.prefix); const n = c.filter((x) => x.source === 'new'); return `<tr><td>${a} <span class="dim">(${CFG[a].join(' / ')})</span></td><td>${c.length - n.length}</td><td>${n.length}</td><td>${fint(n.reduce((t, x) => t + (x.wall ?? 0), 0))} s</td></tr>`; }).join('');
const verdictWord = { located: 'located', likely: 'likely (not certain)', 'not-located': 'not located', 'at-floor': 'at or below the smallest setting tried', none: 'no data' };
const answerRows = results.map((r, i) => `<tr><td>${esc(r.ax.name)}</td><td><b>${r.status === 'located' ? r.ax.value(r.kneePt.arm) : 'not located'}</b></td><td>${picks[i] ? `${f1(picks[i].q.m)}% <span class="dim">(${f1(picks[i].q.lo)}..${f1(picks[i].q.hi)})</span>` : 'n/a'}</td><td>${picks[i] ? `${fint(picks[i].battles)} battles, ${fint(picks[i].secs)} s` : 'n/a'}</td><td>${esc(verdictWord[r.status])}${r.range ? `; lies ${esc(r.range)}` : ''} ${tag('measured')}</td></tr>`).join('');

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
<p><b>Answer.</b> Recommended (each knob at its point-estimate knee): <b>${esc(recText.vals)}</b> ${tag(recText.label)}.<br>
Held-out quality: ${esc(recText.q)}.<br>Cost: ${esc(recText.cost)}.</p>
<table><thead><tr><th>knob</th><th>knee</th><th>quality at recommended value</th><th>cost at recommended value</th><th>how sure</th></tr></thead><tbody>${answerRows}</tbody></table>
<p><b>How sure.</b> ${esc(recText.sure)}</p>
<p class="dim">Knee = the smallest setting past which each doubling of battles buys less than ${THRESHOLD} point of held-out quality. Quality = mean raw win rate of a run's top 5 finalists against 60 held-out opponents; error ranges are 95% (Student t) over seeds. The other two knobs sit at the baseline (200 candidates, 50-opponent pool, K=50) while one moves. Noise per run is about 2-3 pt, so a 1 pt change needs many seeds to see. A knee is called only when the 95% range of the gain per doubling lies wholly on one side of the threshold; otherwise it is reported as not located, with the seeds that would settle it.</p>
</div>
${results.map((r, i) => `<h2>${i + 1}. ${esc(r.ax.name)} <span class="dim">(held: ${esc(r.ax.held)})</span></h2>
<p>${esc(r.text)} ${tag('measured')}${r.need ? `<br><b>To pin it:</b> ${esc(r.need)}.` : ''}</p>${r.steps.some((x) => x.cls === 'straddle') ? '' : ''}
${chart(r)}
<p class="dim">Filled blue = post-fix cells. ${(r.ax.prefixNote ? esc(r.ax.prefixNote) : '') + (r.prePts.length ? ' Dashed orange, hollow markers = pre-fix.' : '')} Bars are 95% ranges over seeds.</p>
${table(r)}`).join('\n')}
<h2>4. Recommended combination</h2>
<p>${esc(recText.vals)} ${tag(recText.label)}. ${recText.label === 'inferred' ? 'This exact combination was not run. Quality is the baseline plus each knob\'s measured one-knob change (assumes the effects add up); battles and time are the baseline times each knob\'s measured cost ratio (assumes the costs multiply). Both assumptions are untested.' : 'This exact combination is the baseline setup, which was run.'}</p>
<h2>5. Pre-fix vs post-fix (same setting, seeds s1-s5)</h2>
<p>Runs made before the determinism fix (round 2) depended on thread order. Pre-fix cells appear only in the dashed series above and are never mixed into a post-fix point. ${tag('measured')}</p>
<table><thead><tr><th>setting</th><th>pre-fix quality</th><th>post-fix quality</th><th>post minus pre (95% range, paired)</th><th>battles pre / post</th><th>wall pre / post</th></tr></thead><tbody>
${pf.map((p) => `<tr><td>${p.arm === 'o50' ? '200 cand, 50 pool' : '200 cand, 500 pool'}</td><td>${f1(p.preQ)}%</td><td>${f1(p.postQ)}%</td><td>${sgn(p.dq.m)} (${sgn(p.dq.lo)}..${sgn(p.dq.hi)})</td><td>${fint(p.preB)} / ${fint(p.postB)}</td><td>${fint(p.preS)} / ${fint(p.postS)} s</td></tr>`).join('')}
</tbody></table>
<h2>6. How new seeds were allocated, and time flags</h2>
<p>Round 7 left the candidate-population and K steps with 95% ranges that straddled the threshold, while the pool axis is already covered by 21 seeds each of o50 and o500 and the o100/o200 points sit between them. So round 8 spent all its time on the five arms of the candidate and K axes (k10, k25, p50, p100, p400), one seed at a time in rounds (cheap arms first) so arms stay balanced, starting from the first seed round 7 had not run. The pool arms and the o50 baseline (21 seeds) got none. The run stops when the next cell would pass the budget. ${tag('measured')}</p>
<table><thead><tr><th>arm (candidates / pool / K)</th><th>existing cells</th><th>new cells</th><th>new wall time</th></tr></thead><tbody>${allocRows}</tbody></table>
<p>Cells whose wall time is far above their run time (sleep or pause; wall &gt; 1.5 x run time + 10 min): ${inflated.length ? inflated.map((c) => `${c.arm}-${c.seed} (${fint(c.wall)} s wall vs ${fint(c.secs)} s run, ${c.source})`).join(', ') : 'none'}. Known from round 7: p50-s1 and k10-s1 wall times are off because of a resume; k10-s6 logged about 19,669 s because the machine slept.</p>
<h2>7. Data used</h2>
<p>Existing cells folded in: 42 post-fix cells in <code>out/sampled-k-ab-r3/</code> (o50 and o500, s1-s21) and the 25 pre-fix <code>--sampled-opponents</code> cells in <code>out/sampled-k-ab/</code> (o50, o500, c40, c320, k10eq, s1-s5). Round-7 cells (5-6 seeds per new arm) in <code>out/sizing-cells/</code> count as existing. Round-8 (new) cells: ${newCount} in <code>out/sizing-cells-r8/</code>, summed wall time ${fint(spent)} s (${f2(spent / 3600)} h) of the 18 h (64,800 s) budget (from <code>out/sizing-cells-r8/sweep.log</code>; wall time is run plus held-out scoring time and includes any sleep). The k10eq cells (K=10, 56 candidates, 300-opponent pool) change all three knobs at once, so they are not on any curve; pre-fix mean ${f1(point(true, 'k10eq')?.q.m)}% at ${fint(point(true, 'k10eq')?.battles ?? NaN)} battles.</p>
<p class="dim">Setup for every cell: meta mode, no evolutions, 8 generations, elites 8, Sequential Halving R=3, final ratio 1, seeds shared across arms (same seed name = same start), collection <code>meta-collection-1500.csv</code>. Wall time is the evolve run only, on 8 threads, on one laptop; small pools also get cache hits, so battles and time both grow with pool size.</p>
</main></body></html>
`;
writeFileSync(OUT, html);
console.log(`wrote ${OUT}`);
