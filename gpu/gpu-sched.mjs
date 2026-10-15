// Round 6 scheduler page (plans/PLAN.md round 6, R12): out/gpu-sched.html.   node gpu/gpu-sched.mjs
// Inputs (all optional except v2.json): out/gpu/sched/<config>.json (from `uv run python -m gpu.sched_bench bench`),
// out/gpu/sched/iterations.json (the iteration log: which config, kept/dropped and why, 5-gen run dir), out/gpu/sched/predictor.json
// (`sched_bench fit`), out/gpu/sched/det.txt (cmp.mjs on two same-seed 2-gen runs), verify logs named in iterations.json, and the
// 5-gen run dirs (gpu-profile.json + evolve-gen<g>.json + the run log <dir>.log).
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';

const SCHED = 'out/gpu/sched';
const V2 = 'out/evolve-recipe-ab-gpu2-halving'; // round-4 v2 5-gen reference (gens 0-4), CPU share auto
const TARGET = 1500, CPU_BPS = 41.7, X10 = CPU_BPS * 10, BEST_R5 = 1280;
const rd = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const txt = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const sum = (a, f = (x) => x) => a.reduce((s, x) => s + f(x), 0);
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n0 = (x) => (x == null || Number.isNaN(x) ? 'n/a' : Math.round(x).toLocaleString('en-US'));
const n1 = (x) => (x == null || Number.isNaN(x) ? 'n/a' : x.toFixed(1));
const n2 = (x) => (x == null || Number.isNaN(x) ? 'n/a' : x.toFixed(2));
const n3 = (x) => (x == null || Number.isNaN(x) ? 'n/a' : x.toFixed(3));
const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const tag = (ok, y = 'PASS', no = 'FAIL') => (ok == null ? '<span class="na">n/a</span>' : `<span class="${ok ? 'pass' : 'fail'}">${ok ? y : no}</span>`);
const table = (head, rows) => `<div class="tw"><table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table></div>`;
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ---------------------------------------------------------------- data
const benches = {};
for (const f of existsSync(SCHED) ? readdirSync(SCHED) : []) {
  if (!f.endsWith('.json') || ['predictor.json', 'iterations.json'].includes(f)) continue;
  const b = rd(`${SCHED}/${f}`);
  if (b?.slices) benches[b.name] = b;
}
const iters = rd(`${SCHED}/iterations.json`) ?? { rows: [] };
const pred = rd(`${SCHED}/predictor.json`);
const det = txt(`${SCHED}/det.txt`);
const sl = (b, size) => b?.slices.find((s) => s.size === size);
const flags = (cfg) => {
  if (!cfg || cfg.kernel === 'v2') return cfg?.streams > 1 ? `POGO_GPU_STREAMS=${cfg.streams}` : '(none: v2)';
  const f = ['POGO_GPU_KERNEL=slice'];
  if (cfg.T != null) f.push(`POGO_GPU_SLICE_TURNS=${cfg.T}`);
  if (cfg.K != null) f.push(`POGO_GPU_SERIES=${cfg.K}`);
  if (cfg.mode) f.push(`POGO_GPU_SLICE_MODE=${cfg.mode}`);
  if (cfg.W != null) f.push(`POGO_GPU_HANDOFF=${cfg.W}`);
  if (cfg.spread === false) f.push('POGO_GPU_SPREAD=off');
  if (cfg.bin) f.push('POGO_GPU_BIN=on');
  if (cfg.streams > 1) f.push(`POGO_GPU_STREAMS=${cfg.streams}`);
  if (cfg.ahead) f.push('POGO_GPU_AHEAD=on');
  return f.join(' ');
};

/** 5-gen run stats from gpu-profile.json (step wall, battles) and the log (CPU battles per step). */
function run5(dir) {
  const prof = rd(`${dir}/gpu-profile.json`);
  if (!prof?.steps?.length) return null;
  const S = prof.steps.filter((s) => s.gen < 5);
  const N = sum(S, (s) => s.n), W = sum(S, (s) => s.wall);
  const log = txt(`${dir}.log`) ?? '';
  const cpu = [...log.matchAll(/gpu step -- .*?, (\d+) on CPU in/g)].map((m) => +m[1]);
  const gens = new Set(S.map((s) => s.gen)).size;
  return { N, W, bps: N / W, steps: S.length, gens, cpuMax: cpu.length ? Math.max(...cpu) : null, cpuSteps: cpu.length, done: existsSync(`${dir}/evolve-DONE`) || gens >= 5 };
}
function cmpV2(dir) {
  const out = [];
  for (let g = 0; g < 5; g++) {
    const a = rd(`${V2}/evolve-gen${g}.json`), b = rd(`${dir}/evolve-gen${g}.json`);
    if (!a || !b) break;
    const top = (c) => c.population.map((p, i) => ({ p, f: c.fitness[i] })).sort((x, y) => y.f - x.f).slice(0, 12);
    const ta = top(a), tb = top(b), sa = new Set(ta.map((x) => x.p.join('|')));
    out.push({ g, shared: tb.filter((x) => sa.has(x.p.join('|'))).length, d: sum(tb, (x) => x.f) / 12 - sum(ta, (x) => x.f) / 12 });
  }
  return out;
}
const vlog = (f) => { const t = f && txt(f); if (!t) return null; const ok = /PASS/.test(t) && !/FAIL/.test(t); return { ok, lines: t.split('\n').filter((l) => /winner agreement|flagged|PASS|FAIL/.test(l)).slice(-4).join('\n') }; };

// ---------------------------------------------------------------- iteration table
const v2b = benches.v2;
const rows = iters.rows.map((r) => {
  const b = benches[r.name];
  const s5 = sl(b, 5000), s36 = sl(b, 36000);
  const v3 = vlog(r.verify3), v1 = vlog(r.verify1);
  const r5 = r.run ? run5(r.run) : null;
  const idle = (s) => (s ? `${n3(s.idle_median)}<br><small>${n3(s.idle_min)}–${n3(s.idle_max)} (${s.reps})</small>` : 'n/a');
  const span = (s) => (s ? `${n2(s.span_median_s)} s<br><small>${n2(s.span_min_s)}–${n2(s.span_max_s)}</small>${s.span_ratio_median != null ? `<br><small>×${n2(s.span_ratio_median)} of paired v2 (${n2(s.span_ratio_min)}–${n2(s.span_ratio_max)})</small>` : ''}` : 'n/a');
  const vb = (s, size) => (s ? `${n0(s.bps_median)}<br><small>v2 ${n0(sl(v2b, size)?.bps_median)}</small>` : 'n/a');
  const same = s5 && s36 ? s5.same_results && s36.same_results : null;
  const ver = r.name === 'v2' ? 'reference' : `${tag(same, 'rows = v2', 'rows differ')}<br>${v3 ? tag(v3.ok, 'verify_3v3') : '<span class="na">3v3: same kernel build</span>'} ${v1 ? tag(v1.ok, 'verify_1v1') : ''}`;
  const run = r5 ? `${n0(r5.bps)} b/s<br><small>${n1(r5.W)} s step wall, ${r5.gens} gens${r5.done ? '' : ' (running)'}</small>` : r.run ? '<span class="na">pending</span>' : '—';
  return { r, s5, s36, r5, cells: [r.iter, esc(r.label ?? r.name), `<small><code>${esc(flags(b?.cfg))}</code></small>`, idle(s5), idle(s36), vb(s5, 5000), vb(s36, 36000), span(s5), span(s36), ver, run, `${r.kept ? '<span class="pass">kept</span>' : '<span class="na">dropped</span>'}<br><small>${esc(r.why ?? '')}</small>`] };
});

// ---------------------------------------------------------------- timeline charts (SVG)
const COLORS = ['var(--c0)', 'var(--c1)', 'var(--c2)', 'var(--c3)'];
function chart(b, size, xmax) {
  const s = sl(b, size);
  if (!s) return '';
  const Wd = 520, H = 150, L = 34, B = 18;
  const X = (t) => L + (t / xmax) * (Wd - L - 6), Y = (v) => H - B - v * (H - B - 6);
  const order = s.launches.map((l, i) => [l.span_s, i]).sort((a, c) => a[0] - c[0]);
  const mid = s.launches[order[order.length >> 1][1]];
  let g = '';
  // spread: every repeat's total busy line, thin
  for (const l of s.launches) {
    const st = Object.values(l.timeline);
    const tot = st[0].map((_, k) => sum(st, (a) => a[k]));
    const pts = tot.map((v, k) => `${X(((k + 0.5) / tot.length) * l.span_s).toFixed(1)},${Y(Math.min(v, 1)).toFixed(1)}`).join(' ');
    g += `<polyline points="${pts}" fill="none" stroke="var(--mut)" stroke-width="0.8" opacity="0.6"/>`;
    g += `<line x1="${X(l.span_s)}" x2="${X(l.span_s)}" y1="${Y(0)}" y2="${Y(0) + 5}" stroke="var(--mut)"/>`;
  }
  // median repeat: stacked per-stream busy areas
  const st = Object.entries(mid.timeline);
  const nb = st[0][1].length;
  let base = new Array(nb).fill(0);
  st.forEach(([sid, a], j) => {
    const top = a.map((v, k) => base[k] + v);
    const xs = a.map((_, k) => X(((k + 0.5) / nb) * mid.span_s));
    const up = xs.map((x, k) => `${x.toFixed(1)},${Y(Math.min(top[k], 1)).toFixed(1)}`).join(' ');
    const dn = xs.map((x, k) => `${x.toFixed(1)},${Y(Math.min(base[k], 1)).toFixed(1)}`).reverse().join(' ');
    g += `<polygon points="${up} ${dn}" fill="${COLORS[j % 4]}" opacity="0.75"><title>stream ${sid}</title></polygon>`;
    base = top;
  });
  const ticks = [];
  const step = xmax > 20 ? 5 : xmax > 8 ? 2 : 1;
  for (let t = 0; t <= xmax; t += step) ticks.push(`<line x1="${X(t)}" x2="${X(t)}" y1="${Y(0)}" y2="${Y(1)}" stroke="var(--line)"/><text x="${X(t)}" y="${H - 4}" text-anchor="middle">${t}s</text>`);
  const yt = [0, 0.5, 1].map((v) => `<text x="${L - 4}" y="${Y(v) + 4}" text-anchor="end">${v * 100}%</text>`).join('');
  return `<svg viewBox="0 0 ${Wd} ${H}" class="tl" role="img" aria-label="${esc(b.name)} ${size}">${ticks.join('')}${yt}<line x1="${L}" x2="${Wd - 6}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--mut)"/>${g}</svg>`;
}
const shown = ['v2', ...iters.rows.filter((r) => r.kept && r.name !== 'v2').map((r) => r.name), ...iters.rows.filter((r) => r.chart && !r.kept).map((r) => r.name)].filter((n, i, a) => benches[n] && a.indexOf(n) === i);
const xmax = (size) => Math.max(...shown.map((n) => sl(benches[n], size)?.span_max_s ?? 0));
const charts = shown.map((n) => {
  const b = benches[n], s5 = sl(b, 5000), s36 = sl(b, 36000);
  const st = Object.keys(s36?.launches[0]?.timeline ?? {}).length;
  return `<div class="tlrow"><h3>${esc(iters.rows.find((r) => r.name === n)?.label ?? n)} <small><code>${esc(flags(b.cfg))}</code></small></h3>
<div class="tlpair"><figure>${chart(b, 5000, xmax(5000))}<figcaption>5k slice: idle ${n3(s5?.idle_median)} (${n3(s5?.idle_min)}–${n3(s5?.idle_max)}), span ${n2(s5?.span_median_s)} s</figcaption></figure>
<figure>${chart(b, 36000, xmax(36000))}<figcaption>36k slice: idle ${n3(s36?.idle_median)} (${n3(s36?.idle_min)}–${n3(s36?.idle_max)}), span ${n2(s36?.span_median_s)} s${st > 1 ? `; ${st} streams stacked (colours)` : ''}</figcaption></figure></div></div>`;
}).join('\n');

// ---------------------------------------------------------------- ahead log (R4)
const aheadB = Object.values(benches).filter((b) => b.cfg?.ahead);
const aheadRows = [];
for (const b of aheadB) for (const s of b.slices) {
  const L = s.launches;
  const lg = L.flatMap((l) => l.ahead_log ?? []);
  aheadRows.push([esc(b.name), s.size.toLocaleString(), n0(sum(L, (l) => l.ahead_offered ?? 0) / L.length), n0(sum(L, (l) => l.ahead_taken ?? 0) / L.length), n0(sum(L, (l) => l.ahead_late ?? 0)), n0(sum(L, (l) => l.ahead_discarded ?? 0)),
    lg.length ? `${n0(median(lg.map((x) => (x.pred_end - x.start) / 1e6)))} / ${n0(median(lg.map((x) => (x.end - x.start) / 1e6)))}` : 'n/a', L.every((l) => l.same_results) ? tag(true, 'rows = v2') : tag(false, 'rows = v2')]);
}
const aheadSample = (() => {
  const size = aheadB.some((x) => sl(x, 36000)?.launches[0]?.ahead_log?.length) ? 36000 : 5000;
  const b = aheadB.find((x) => sl(x, size)?.launches[0]?.ahead_log?.length);
  if (!b) return '';
  const all = sl(b, size).launches[0].ahead_log;
  const lg = [...all].sort((x, y) => x.start - y.start).slice(0, 8);
  const t0 = Math.min(...all.map((x) => x.start));
  const ms = (t) => n0((t - t0) / 1e6);
  return table(['Battle (next launch)', 'Taken at (ms)', 'Predicted finish (ms)', 'Actual finish (ms)', 'Deadline (ms)', 'Result used by launch 2'], lg.map((x) => [x.battle, ms(x.start), ms(x.pred_end), ms(x.end), ms(x.deadline), 'yes (not re-run)']));
})();
const runAhead = iters.rows.filter((r) => r.run && txt(`${r.run}/gpu-ahead.jsonl`)).map((r) => {
  const L = txt(`${r.run}/gpu-ahead.jsonl`).trim().split('\n').map((l) => JSON.parse(l));
  return [esc(r.run), n0(L.length), n0(sum(L, (x) => x.taken)), n0(sum(L, (x) => x.late)), n0(sum(L, (x) => x.discarded))];
});

// ---------------------------------------------------------------- best, verdict, conclusion
const withRun = rows.filter((x) => x.r5 && x.r.name !== 'v2' && x.r5.gens >= 5);
const base = rows.find((x) => x.r.name === 'v2' && x.r5);
const best = withRun.sort((a, c) => c.r5.bps - a.r5.bps)[0];
const ov = best ? cmpV2(best.r.run) : [];
const ovBase = base ? cmpV2(base.r.run) : [];
const conc = iters.conclusion ?? 'pending: the iteration loop has not finished.';

const css = `:root{--bg:#fff;--fg:#1d2330;--mut:#5b6577;--line:#d9dee7;--card:#f5f7fa;--ok:#157347;--bad:#b42318;--c0:#2f6fdb;--c1:#e0832a;--c2:#3aa676;--c3:#a259c4}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#14171d;--fg:#e6e9ef;--mut:#9aa3b2;--line:#2c3340;--card:#1c2028;--ok:#4cc38a;--bad:#ff7b72;--c0:#6ea0ff;--c1:#f2a65a;--c2:#5ccf98;--c3:#c792ea}}
:root[data-theme="dark"]{--bg:#14171d;--fg:#e6e9ef;--mut:#9aa3b2;--line:#2c3340;--card:#1c2028;--ok:#4cc38a;--bad:#ff7b72;--c0:#6ea0ff;--c1:#f2a65a;--c2:#5ccf98;--c3:#c792ea}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1150px;padding:16px}
h1{font-size:1.5rem}h2{margin-top:2rem;border-bottom:1px solid var(--line);padding-bottom:4px}h3{font-size:1rem;margin:1.2rem 0 .3rem}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;margin:.6rem 0;font-size:14px}th,td{border:1px solid var(--line);padding:5px 7px;text-align:left;vertical-align:top}th{background:var(--card)}
.pass{color:var(--ok);font-weight:700}.fail{color:var(--bad);font-weight:700}.na{color:var(--mut)}small,.mut{color:var(--mut)}pre{background:var(--card);padding:8px;overflow-x:auto;white-space:pre-wrap}
.box{background:var(--card);border-left:4px solid var(--c0);padding:10px 14px;margin:1rem 0}
.tlpair{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:760px){.tlpair{grid-template-columns:1fr}}
figure{margin:0}figcaption{font-size:13px;color:var(--mut)}svg.tl{width:100%;height:auto;background:var(--card);border-radius:4px}svg.tl text{font-size:10px;fill:var(--mut)}`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GPU Scheduler Round 6</title><style>${css}</style></head><body>
<h1>GPU round 6: time-sliced work queue and load balancing</h1>
<p class="mut">Built by <code>node gpu/gpu-sched.mjs</code> from <code>${SCHED}/*.json</code> and the 5-gen run logs. See also <a href="gpu-gap.html">why v2 missed 1,500 b/s</a> and <a href="recipe-ab-gpu.html">the CPU-vs-GPU A/B page</a>.
Idle share of a launch = 1 − (thread-busy time ÷ (resident threads × launch span)), from per-battle <code>%globaltimer</code> stamps; resident threads = ${n0(v2b?.slices[0]?.threads)} (68 SMs × 8 warps × 32 lanes at 254–255 registers). A warp-mode segment counts all 32 lanes as busy.</p>

<div class="box"><b>Conclusion.</b> ${conc}</div>

<h2 id="verdict">Verdict</h2>
${best ? table(['Config', '5-gen b/s', 'vs 1,500 b/s', `vs ×10 CPU (${n0(X10)} b/s)`, 'vs v2 at share 0', `vs round-5 best (${n0(BEST_R5)})`, 'CPU battles per step'], [[esc(best.r.label ?? best.r.name), `<b>${n0(best.r5.bps)}</b>`, tag(best.r5.bps >= TARGET), tag(best.r5.bps >= X10), base ? `×${n2(best.r5.bps / base.r5.bps)} (${n0(base.r5.bps)})` : 'n/a', `×${n2(best.r5.bps / BEST_R5)}`, best.r5.cpuMax == null ? 'n/a' : `max ${best.r5.cpuMax} over ${best.r5.cpuSteps} steps`]]) : '<p class="na">pending: no kept configuration has a finished 5-gen run.</p>'}
<p>Verdict on the 1,500 b/s bar: ${tag(best ? best.r5.bps >= TARGET : false)}${best && best.r5.bps < TARGET ? ' (stays FAIL until a run meets it)' : ''}. No 100-gen run this round.</p>

<h2 id="iter">Iterations</h2>
<p class="mut">≥ 5 timed launches per slice; median with min–max beneath. Kept = median idle share lower on both slices, or lower on one and not higher on the other (vs the kept config before it). “rows = v2”: every launch's result rows equal v2's row for row. Stop rule: two consecutive iterations each improving the 5-gen b/s (or idle share, when no 5-gen run was warranted) by under 5%.</p>
${table(['#', 'Config', 'Flags', 'Idle 5k', 'Idle 36k', 'Kernel b/s 5k', 'Kernel b/s 36k', 'Span 5k', 'Span 36k', 'Verify', '5-gen run', 'Kept / why'], rows.map((x) => x.cells))}
${iters.stop ? `<p><b>Stop rule:</b> ${esc(iters.stop)}</p>` : ''}

<h2 id="tl">Per-launch thread occupancy</h2>
<p class="mut">Y = share of the ${n0(v2b?.slices[0]?.threads)} resident threads busy in a battle; X = seconds from the launch's first battle start (same scale for every config of a slice). Filled area: the median-span repeat (one colour per CUDA stream when streams &gt; 1, stacked, so overlapping launches show as two colours at the same time). Grey lines: every repeat's total, ticks under the axis: each repeat's end, so the spread across repeats is visible. White space above the fill is idle.</p>
${charts || '<p class="na">pending</p>'}

<h2 id="pred">Length predictor (R3)</h2>
${pred ? `<p>Ridge regression on log(battle time) over ${pred.n_features} cheap features read from the packed mon arrays (bulk, fast-move damage rate, time-to-KO each way, charged-move count and cheapest energy, buff moves, form changers, shields, bait), fitted on the 5k slice. The target is each battle's time with a warp to itself in a full launch (no divergence).</p>
${table(['Measure', 'Value'], [['Pearson r, 36k slice (all)', n3(pred.pearson_36000)], ['Pearson r, 36k rows not in the 5k fit', n3(pred.pearson_36000_heldout)], ['Pearson r on log time, 36k', n3(pred.pearson_log_36000)], ['Spearman ρ, 36k', n3(pred.spearman_36000)], ['Pearson r vs thread-mode time (v2), 36k', n3(pred.pearson_thread_time_36000)], ['Pearson r, 5k fit set', n3(pred.pearson_train_5000)], ['Warp-solo time median / max (s)', `${n2(pred.solo_p50_s)} / ${n2(pred.solo_max_s)}`]])}
${iters.predictorNote ? `<p>${iters.predictorNote}</p>` : ''}` : '<p class="na">pending</p>'}

<h2 id="ahead">Move-ahead log (R4)</h2>
<p class="mut">Ahead work is the next launch's battles, whose inputs are fully known when it is offered. A thread takes one only when the queue of the current launch is empty and the battle's predicted finish is before the predicted end of the current launch's longest battle. Every taken result is kept and used by the next launch (never re-run); “late” = actual finish after that deadline.</p>
${aheadRows.length ? table(['Config', 'Slice', 'Offered / launch', 'Taken / launch', 'Late (all reps)', 'Discarded', 'Median predicted / actual (ms)', 'Rows'], aheadRows) : '<p class="na">pending</p>'}
${aheadSample ? `<h3>First taken battles of one ${aheadB.some((x) => sl(x, 36000)?.launches[0]?.ahead_log?.length) ? '36k' : '5k'} launch of ${esc(aheadB[0]?.name ?? '')} (ms from the first take)</h3>${aheadSample}` : ''}
${runAhead.length ? `<h3>Ahead log of the 5-gen runs</h3>${table(['Run', 'Steps', 'Taken', 'Late', 'Discarded'], runAhead)}` : ''}

<h2 id="det">Determinism and agreement with v2 (R6)</h2>
<pre>${esc(det ?? 'pending')}</pre>
${best && ov.length ? `<h3>Best config vs round-4 v2 (gens 0–${ov.length - 1}; reported, not gated)</h3>${table(['Gen', 'Top-12 shared with v2', 'Mean top-12 fitness delta'], ov.map((g) => [g.g, `${g.shared} / 12`, (g.d >= 0 ? '+' : '') + g.d.toFixed(4)]))}` : ''}
${base && ovBase.length ? `<h3>v2 at CPU share 0 vs round-4 v2 (same kernel; differs only by the CPU share)</h3>${table(['Gen', 'Top-12 shared', 'Mean top-12 fitness delta'], ovBase.map((g) => [g.g, `${g.shared} / 12`, (g.d >= 0 ? '+' : '') + g.d.toFixed(4)]))}` : ''}
${iters.notes ? `<h2 id="notes">Notes</h2>${iters.notes}` : ''}
</body></html>`;
writeFileSync('out/gpu-sched.html', html);
console.log(`out/gpu-sched.html written: ${rows.length} iteration rows, ${shown.length} timeline configs, best ${best ? `${best.r.name} ${n0(best.r5.bps)} b/s` : 'pending'}`);
