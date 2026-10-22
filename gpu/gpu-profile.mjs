// `--gpu` speed profile page (plans/PLAN.md round 4): out/gpu-profile.html.
//   node gpu/gpu-profile.mjs        rebuilds the page from the files below (missing inputs show as "pending")
// Inputs (all under out/, none written here except the page):
//   evolve-recipe-ab-gpu-halving.log + its out dir   GPU-v1 run (coarse attribution from the step log + checkpoint timings)
//   evolve-recipe-ab-gpu2-halving/gpu-profile.json   GPU-v2 run (timed buckets, src/evolve/gpuProfile.js)
//   evolve-gpu2-prof0 / -p1a / -p1b / -p1d           5-gen runs: before any fix / each fix added in turn (FIVE_GEN below);
//   -p1s (share 0.05) and -p1c (first auto fit) are the share calibration runs
//   gpu/share-fit.json                               `node gpu/fit-share.mjs ...` (the auto CPU share model)
//   gpu/*.json                                       kernel measurements from `uv run python -m gpu.profile_kernel ...`
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const V1_DIR = 'out/evolve-recipe-ab-gpu-halving', V1_LOG = 'out/evolve-recipe-ab-gpu-halving.log';
const V2_DIR = 'out/evolve-recipe-ab-gpu2-halving';
const K = (f) => path.join('out/gpu', f);
/** 5-gen runs of the baseline command (mega curated pool), each adding one fix to the previous row. */
const FIVE_GEN = [
  { key: 'prof0', dir: 'out/evolve-gpu2-prof0', label: 'before: v1 kernel, flagged rows re-run after the GPU, share 0.004' },
  { key: 'p1a', dir: 'out/evolve-gpu2-p1a', label: '+ F2 flagged rows re-run per launch, concurrently (v1 kernel, share 0.004)' },
  { key: 'p1b', dir: 'out/evolve-gpu2-p1b', label: '+ F1 packed lookahead pool 2048 (v2 kernel, share 0.004)' },
  { key: 'p1d', dir: 'out/evolve-gpu2-p1d', label: '+ F3 CPU share from measured rates: auto, 95 CPU battles a step (v2 defaults)' },
  { key: 'p1s', dir: 'out/evolve-gpu2-p1s', label: 'calibration: v2 kernel, share 0.05 (CPU rate fit)' },
  { key: 'p1c', dir: 'out/evolve-gpu2-p1c', label: 'calibration: first auto fit, CPU share sized to the lower-quartile GPU step (117 a step)' },
];
const V1_RUNNING_FALLBACK_S = 3324; // plans/PLAN.md Facts: 55m 24s running

/**
 * Predicted savings, written down before each fix was measured on a 5-gen run (R6). Seconds on the full 100-gen run,
 * from the v1 run's own numbers. `measure` names how the 5-gen saving is taken (FIVE_GEN keys: before -> after).
 */
const FIXES = [
  { id: 'F1', req: 'R10', name: 'Packed 12-byte lookahead states, pool 768 -> 2048, queue popped by head pointer', applied: true,
    predictS: 925, basis: 'v1 log: 549 s of step wall is the serial flagged tail after the GPU returns (all in steps with flagged rows) -> 0 if nothing overflows; slices: v2 kernel 12-16% faster on 5,000 / 36,000 -> 14% of 2,689 s GPU path = 376 s',
    slice: ['v1 (pool 768)', 'packed pool 2048 (v2)'], measure: ['p1a', 'p1b'] },
  { id: 'F2', req: 'R8', name: 'Flagged rows re-run on the CPU per launch while later launches run (not after the step)', applied: true,
    predictS: 0, basis: 'steps are at most one launch (36,000 limit; largest step 18,000), so there is no later launch to overlap: the re-run still waits for the only launch. Kept because it costs nothing and covers gen-0 sized steps',
    slice: null, measure: ['prof0', 'p1a'] },
  { id: 'F3', req: 'R8', name: 'CPU share from measured rates (default 0.004 -> measured balanced share)', applied: true,
    predictS: 60, basis: 'v1 fit: GPU path = 5.0 s + 0.72 ms x battles; CPU 41.7 b/s at 8 threads -> balanced share ~0.05-0.08; moving 5.6% of 1.64M battles off the GPU saves 0.72 ms each = 66 s, minus CPU-side waits',
    slice: null, measure: ['p1b', 'p1d'] },
  { id: 'F4', req: 'R8', name: 'Merge a halving round\'s sub-5,000 batches into one launch', applied: false,
    predictS: 625, basis: 'v1 log: 197 steps < 5,000 battles took 1,688 s at 396 b/s; at the >= 5,000 rate (629 b/s) they would take 1,063 s. Not applied: round k+1\'s pairings are chosen from round k\'s fitness, and the three steps of a generation are those rounds, so no two steps can share a launch without changing the search',
    slice: null, measure: null },
  { id: 'F5', req: 'R9', name: 'Sort or bucket battles by predicted length', applied: false,
    predictS: 105, basis: 'upper bound from an oracle (each battle\'s true inner-sim count, unknowable before the battle): sorted descending, the slices run x1.035 (5,000) and x1.043 (36,000) -> ~4% of 2,689 s GPU path. Grouping by team (the cheap predictor available) runs x0.75 / x0.85, slower. Not applied: no cheap predictor, and even the oracle gain is ~4%',
    slice: null, layout: ['sorted by inner sims, desc (oracle)', 'grouped by teams'], measure: null },
  { id: 'F6', req: 'R11', name: 'Kernel layout change: one warp per battle (no divergence inside a warp)', applied: false,
    predictS: -150, basis: 'prototype (LANES 32: a battle\'s 32 lanes run it in lockstep, the bound for removing warp divergence without parallelising the inner sims): x1.22 at 5,000 but x0.86 at 36,000, where most battles run. Below the plan\'s x1.5 bar, so not applied; a real lookahead-over-lanes rewrite is not justified by this',
    slice: null, layout: ['warp per battle (LANES 32)'], measure: null },
];

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const f1 = (x) => (x == null || Number.isNaN(x) ? 'n/a' : x.toFixed(1));
const f0 = (x) => (x == null || Number.isNaN(x) ? 'n/a' : Math.round(x).toLocaleString('en-US'));
const pc = (x) => (x == null || Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const hms = (s) => (s == null ? 'n/a' : `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m ${String(Math.round(s % 60)).padStart(2, '0')}s`);
const mark = (ok) => (ok == null ? '<span class="na">pending</span>' : ok ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>');
const table = (head, rows) => `<div class="tw"><table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table></div>`;

/** Running time of an evolve out dir from its checkpoints (sum of per-generation elapsed + final pass), seconds. */
function running(dir) {
  if (!existsSync(dir)) return null;
  const gens = readdirSync(dir).filter((f) => /^evolve-gen\d+\.json$/.test(f)).map((f) => Number(f.match(/\d+/)[0])).sort((a, b) => a - b);
  const t = gens.map((g) => readJson(path.join(dir, `evolve-gen${g}.json`))?.timing).filter(Boolean);
  const res = readJson(path.join(dir, 'evolve-result.json'));
  const fin = existsSync(path.join(dir, 'evolve-DONE')) ? res?.eliteTiming?.elapsedMs ?? 0 : 0;
  return { gens: t.length, genS: t.map((x) => x.elapsedMs / 1000), genBattles: t.map((x) => x.battleCount ?? 0), battles: sum(t.map((x) => x.battleCount ?? 0)), finalS: fin / 1000, runningS: (sum(t.map((x) => x.elapsedMs)) + fin) / 1000, done: existsSync(path.join(dir, 'evolve-DONE')) };
}

/** Step lines of an evolve --gpu log. */
function logSteps(file) {
  if (!existsSync(file)) return [];
  return [...readFileSync(file, 'utf8').matchAll(/gpu step -- (?:(\d+) memo hits, )?(\d+) battles on GPU in ([\d.]+)s, (\d+) on CPU in ([\d.]+)s(?: \((\d+) GPU rows flagged)?(?:, share ([\d.]+))?.*wall ([\d.]+)s/g)]
    .map((m) => ({ memo: m[1] == null ? null : +m[1], g: +m[2], gs: +m[3], c: +m[4], cs: +m[5], fl: +(m[6] ?? 0), n: +m[2] + +m[4], wall: +m[8] }));
}

/** Totals of a gpu-profile.json: buckets summed over generations, phases, wall, unattributed. */
function profileTotals(p) {
  if (!p) return null;
  const G = p.generations;
  const names = [...new Set(G.flatMap((g) => Object.keys(g.buckets)))];
  const buckets = Object.fromEntries(names.map((b) => [b, sum(G.map((g) => g.buckets[b] ?? 0))]));
  const phases = p.phases ?? {};
  const genWall = sum(G.map((g) => g.wall));
  const wall = genWall + sum(Object.values(phases));
  const unattributed = sum(G.map((g) => g.unattributed));
  const worstGen = G.reduce((w, g) => (Math.abs(g.unattributed) / g.wall > (w ? Math.abs(w.unattributed) / w.wall : -1) ? g : w), null);
  const L = p.steps.flatMap((s) => (s.launches ?? []).map((l) => ({ ...l, gen: s.gen })));
  return { G, buckets, phases, genWall, wall, unattributed, worstGen, steps: p.steps, launches: L,
    battles: sum(G.map((g) => g.battles)), gpuBattles: sum(G.map((g) => g.gpuBattles)), cpuBattles: sum(G.map((g) => g.cpuBattles)), flagged: sum(G.map((g) => g.flaggedRows)),
    cpuIdle: sum(p.steps.map((s) => s.cpuIdleS ?? 0)), share: p.meta?.cpuShare, formatOld: G.some((g) => 'between' in g.buckets || 'stepOther' in g.buckets) };
}

const BUCKET_LABEL = {
  plan: 'memo lookup + pairing plan (evaluate.js step 1)', pack: 'packing (describe + pack, node)', transport: 'transport (pipe, numpy, host<->device copies)',
  kernel: 'GPU kernel, body (until half its battles finished)', tail: 'GPU kernel, tail (under 50% of battles still running)',
  waitCpu: 'GPU done, waiting for the CPU share', flagged: 'flagged rows re-run on CPU (after the GPU and CPU share)', map: 'result mapping / spec split',
  accumulate: 'fitness accumulation (evaluate.js step 3)', ga: 'GA step (selection, mutation, opponent pool)', checkpoint: 'checkpoint write', report: 'generation report / analytics',
  stepOther: 'executor rest (old format: a remainder)', between: 'between steps (old format: a remainder)',
};

function attributionTable(t) {
  if (!t) return '<p class="na">pending: no gpu-profile.json yet</p>';
  const rows = Object.entries(t.buckets).map(([b, s]) => [esc(BUCKET_LABEL[b] ?? b), f1(s), pc(s / t.wall)]);
  for (const [ph, s] of Object.entries(t.phases)) rows.push([esc(`outside generations: ${ph}`), f1(s), pc(s / t.wall)]);
  const share = Math.abs(t.unattributed) / t.wall;
  rows.push([`<b>unattributed</b> (wall minus every timed bucket)`, f1(t.unattributed), `${pc(share)} ${mark(share <= 0.05)} <span class="small">rule: within 5% of wall</span>`]);
  rows.push(['<b>wall</b> (generations + phases)', `<b>${f1(t.wall)}</b>`, '100%']);
  const worst = t.worstGen ? `Worst single generation: gen ${t.worstGen.gen}, unattributed ${f1(t.worstGen.unattributed)} s of ${f1(t.worstGen.wall)} s (${pc(Math.abs(t.worstGen.unattributed) / t.worstGen.wall)}). ` : '';
  const old = t.formatOld ? '<p class="warn">Old profile format: <code>stepOther</code> and <code>between</code> were remainders, so unattributed is 0 by construction here; kept only as the pre-fix reference. The v2 format times every bucket.</p>' : '';
  return `${old}${table(['bucket', 'seconds', '% of wall'], rows)}<p class="small">${worst}${f0(t.battles)} battles (${f0(t.gpuBattles)} GPU, ${f0(t.cpuBattles)} CPU incl. ${f0(t.flagged)} flagged re-runs), CPU share ${t.share}.</p>`;
}

// ---------------------------------------------------------------- inputs
const v1Steps = logSteps(V1_LOG);
const v1Run = running(V1_DIR);
const v1RunningS = v1Run?.runningS ?? V1_RUNNING_FALLBACK_S;
const v2Prof = profileTotals(readJson(path.join(V2_DIR, 'gpu-profile.json')));
const v2Run = running(V2_DIR);
const v2Steps = logSteps(`${V2_DIR}.log`);
const five = FIVE_GEN.map((r) => ({ ...r, prof: profileTotals(readJson(path.join(r.dir, 'gpu-profile.json'))), run: running(r.dir), steps: logSteps(`${r.dir}.log`) }));
const fiveBy = Object.fromEntries(five.map((r) => [r.key, r]));
const res = readJson(K('prof-resources.json'))?.variants ?? [];
const sweep = readJson(K('prof0-sweep.json'))?.sweep ?? [];
const launchesV1 = readJson(K('prof0-launches.json'))?.launches ?? [];
const divergence = readJson(K('prof0-divergence.json'))?.divergence ?? null;
const layout = readJson(K('prof0-layout.json'))?.layout ?? [];
const variants = readJson(K('prof0-variants.json'))?.variants ?? null;
const slices = readJson(K('fix-slices.json'))?.slices ?? [];
const flagV1 = readJson(K('flagset-v1run.json'))?.flagset ?? null;
const flagP0 = readJson(K('flagset-prof0.json'))?.flagset ?? null;
const share = readJson(K('share-fit.json'));

// ---------------------------------------------------------------- v1 attribution (coarse: differences of logged totals)
const v1 = (() => {
  const gpuPath = sum(v1Steps.map((s) => s.gs)), stepWall = sum(v1Steps.map((s) => s.wall));
  const afterGpu = stepWall - gpuPath;
  const genSum = v1Run ? sum(v1Run.genS) : null;
  const outside = genSum != null ? genSum - stepWall : null;
  const fin = v1Run?.finalS ?? null;
  const small = v1Steps.filter((s) => s.n < 5000), big = v1Steps.filter((s) => s.n >= 5000);
  const rate = (ss) => sum(ss.map((s) => s.n)) / sum(ss.map((s) => s.wall));
  const smallS = sum(small.map((s) => s.wall)), smallLost = smallS - sum(small.map((s) => s.n)) / rate(big);
  const flaggedTail = sum(v1Steps.filter((s) => s.fl > 0).map((s) => s.wall - s.gs));
  return { gpuPath, stepWall, afterGpu, outside, fin, genSum, small, big, smallS, smallLost, smallRate: rate(small), bigRate: rate(big), flaggedTail,
    flagged: sum(v1Steps.map((s) => s.fl)), battles: sum(v1Steps.map((s) => s.n)), gpuBattles: sum(v1Steps.map((s) => s.g)) };
})();
const v1Table = table(['bucket (v1 log)', 'seconds', '% of running time'], [
  ['GPU path: pack + transport + kernel (the v1 log does not split these)', f1(v1.gpuPath), pc(v1.gpuPath / v1RunningS)],
  ['after the GPU returned: serial re-run of flagged rows + waiting for the CPU share', f1(v1.afterGpu), pc(v1.afterGpu / v1RunningS)],
  ['outside battle steps: GA, memo lookups, halving bookkeeping, checkpoint, report', f1(v1.outside), pc(v1.outside / v1RunningS)],
  ['final pass', f1(v1.fin), pc(v1.fin / v1RunningS)],
  ['<b>unattributed</b>: running time minus the rows above (setup, rounding of whole-second gen times)', f1(v1RunningS - v1.genSum - v1.fin), `${pc(Math.abs(v1RunningS - v1.genSum - v1.fin) / v1RunningS)} ${mark(Math.abs(v1RunningS - v1.genSum - v1.fin) / v1RunningS <= 0.05)}`],
  ['<b>running time</b>', `<b>${f1(v1RunningS)}</b>`, '100%'],
]);

// ---------------------------------------------------------------- R2 tail
const p1c = fiveBy.p1d?.prof; // the v2-default 5-gen run
const tailRows = (L, src) => L.map((l, i) => [src, i, f0(l.n), f1(l.spanMs / 1000), f1(l.tailMs / 1000), pc(l.spanMs ? l.tailMs / l.spanMs : null), f1(l.maxBattleMs / 1000), l.longest?.turns ?? 'n/a', l.longest?.innerSims ?? 'n/a', l.flagged ?? 0]);
const v1LaunchRows = launchesV1.map((l) => ['v1 kernel replay (5-gen pre-fix launches)', l.launch, f0(l.n), f1(l.span_s), f1(l.tail_s), pc(l.tail_share), f1(l.battle_max_s), l.longest?.turns, l.longest?.innerSims, l.flagged]);
const corr = (xs, ys) => { const n = xs.length; if (n < 3) return null; const mx = sum(xs) / n, my = sum(ys) / n; const c = sum(xs.map((x, i) => (x - mx) * (ys[i] - my))); return c / Math.sqrt(sum(xs.map((x) => (x - mx) ** 2)) * sum(ys.map((y) => (y - my) ** 2))); };
const tailSummary = (L, span, n, longest, tail) => (L.length ? `${L.length} launches: span vs batch size r = ${f1x(corr(L.map(n), L.map(span)))}, span vs longest battle r = ${f1x(corr(L.map(longest), L.map(span)))}; tail share median ${pc(median(L.map(tail)))}.` : 'pending');
const f1x = (x) => (x == null ? 'n/a' : x.toFixed(2));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

// ---------------------------------------------------------------- R6 per-fix
function fiveGenSaving(fx) {
  if (!fx.measure) return null;
  const [a, b] = fx.measure.map((k) => fiveBy[k]);
  if (!a?.run?.gens || !b?.run?.gens || a.run.gens < 5 || b.run.gens < 5) return null;
  // trajectories diverge after gen 0 (float vs CPU results), so the 5-gen saving is per battle, scaled to the `before` run.
  // Gens 1-4 only: gen 0 carries one-time cold starts (the pre-fix run's gen 0 includes a ~55 s CUDA compile in its
  // transport bucket), the same exclusion gpu/fit-share.mjs makes; gen 0 is shown on its own.
  const g14 = (r, xs) => sum(xs.slice(1, 5));
  const sA = g14(a, a.run.genS), sB = g14(b, b.run.genS), nA = g14(a, a.run.genBattles), nB = g14(b, b.run.genBattles);
  const perA = sA / nA, perB = sB / nB;
  const gen0 = a.run.genS[0] - b.run.genS[0];
  return { s: (perA - perB) * nA, frac: (perA - perB) / perA, gen0, aS: sA, bS: sB };
}
function sliceSaving(fx) {
  if (!fx.slice) return null;
  const at = (size, v) => slices.find((r) => r.size === size && r.variant === v);
  return [5000, 36000].map((size) => { const a = at(size, fx.slice[0]), b = at(size, fx.slice[1]); return a && b ? { size, a: a.span_s, b: b.span_s, s: a.span_s - b.span_s, frac: (a.span_s - b.span_s) / a.span_s } : null; });
}
const fixRows = FIXES.map((fx) => {
  const sl = sliceSaving(fx), fg = fiveGenSaving(fx);
  const predFrac = fx.predictS == null ? null : fx.predictS / v1RunningS;
  let ok = null, why = '';
  if (fx.applied && fg && predFrac != null) {
    const tol = Math.max(0.2 * Math.abs(predFrac), 0.01); // a near-zero prediction is judged within 1 point of wall
    ok = Math.abs(fg.frac - predFrac) <= tol;
    why = ok ? 'within 20%' : `mispredicted: predicted ${pc(predFrac)} of wall, measured ${pc(fg.frac)}`;
  }
  return [fx.id, fx.req, esc(fx.name), fx.applied ? 'yes' : 'no', fx.predictS == null ? 'n/a' : `${f0(fx.predictS)} s (${pc(predFrac)})`, `<span class="small">${esc(fx.basis)}</span>`,
    sl ? sl.map((x) => (x ? `${x.size.toLocaleString('en-US')}: ${f1(x.a)} -> ${f1(x.b)} s (${pc(x.frac)})` : 'pending')).join('<br>')
      : fx.layout ? layout.filter((r) => fx.layout.includes(r.variant)).map((r) => `${r.size.toLocaleString('en-US')} ${esc(r.variant)}: x${r.speedup.toFixed(2)} (prototype)`).join('<br>')
      : '<span class="small">n/a: kernel-only slices do not run the scheduler</span>',
    fg ? `gens 1-4: ${f1(fg.aS)} -> ${f1(fg.bS)} s, ${f1(fg.s)} s (${pc(fg.frac)}); gen 0 alone ${f1(fg.gen0)} s` : fx.applied ? '<span class="na">pending</span>' : 'n/a',
    fx.applied ? `${mark(ok)} ${esc(why)}` : 'not applied'];
});

// ---------------------------------------------------------------- R7 slice vs full run
function sliceVsFull() {
  const rows = [];
  // within 10% of the size; when the run has none, the 5 nearest in size (labelled with their range)
  const near = (steps, size) => { const w = steps.filter((s) => Math.abs(s.n - size) <= 0.1 * size); return w.length ? w : [...steps].sort((x, y) => Math.abs(x.n - size) - Math.abs(y.n - size)).slice(0, 5); };
  const label = (L, size, what) => (L.every((s) => Math.abs(s.n - size) <= 0.1 * size) ? `within 10% of the size` : `none within 10%: the ${L.length} ${what} nearest in size, ${f0(Math.min(...L.map((s) => s.n)))}-${f0(Math.max(...L.map((s) => s.n)))} battles`);
  for (const size of [5000, 36000]) {
    const sw = sweep.find((r) => r.size === size && r.block === 32 && r.maxrregcount == null);
    const fullV1 = near(v1Steps, size);
    const fullBps = fullV1.length ? median(fullV1.map((s) => s.g / s.gs)) : null;
    const d = sw && fullBps ? Math.abs(sw.bps - fullBps) / fullBps : null;
    rows.push([`v1 kernel, ${size.toLocaleString('en-US')}`, sw ? f0(sw.bps) : 'pending', fullV1.length ? `${f0(fullBps)} (median of ${fullV1.length} v1 steps ${label(fullV1, size, 'steps')}; GPU path incl. transport)` : 'no v1 step within 10% of this size', d == null ? 'n/a' : `${pc(d)} ${d > 0.25 ? '<span class="fail">FLAG &gt;25%</span>' : '<span class="pass">ok</span>'}`]);
    const s2 = slices.find((r) => r.size === size && r.variant === 'packed pool 2048 (v2)');
    const L2 = near((v2Prof?.launches ?? []).filter((l) => l.spanMs > 0), size);
    const full2 = L2.length ? median(L2.map((l) => l.n / (l.spanMs / 1000))) : null;
    const d2 = s2 && full2 ? Math.abs(s2.bps - full2) / full2 : null;
    rows.push([`v2 kernel, ${size.toLocaleString('en-US')}`, s2 ? f0(s2.bps) : 'pending', L2.length ? `${f0(full2)} (median kernel-span b/s of ${L2.length} v2 full-run launches ${label(L2, size, 'launches')})` : v2Prof ? 'no v2 launch within 10% of this size' : 'pending', d2 == null ? 'n/a' : `${pc(d2)} ${d2 > 0.25 ? '<span class="fail">FLAG &gt;25%</span>' : '<span class="pass">ok</span>'}`]);
  }
  return table(['kernel, batch size', 'slice b/s', 'full run b/s at that size', 'difference'], rows);
}

// ---------------------------------------------------------------- R3 occupancy
const resRows = res.map((r) => [r.pool ?? 'wide 28 B (v1)', r.maxq, r.maxrregcount ?? 'none', r.num_regs, f0(r.local_bytes), r.spill_store_bytes ?? 'n/a', r.max_block,
  Object.entries(r.occupancy ?? {}).map(([b, o]) => `${b}: ${o.warps_per_sm} warps/SM (${pc(o.theoretical)})`).join('<br>')]);
const sweepRows = sweep.map((r) => [f0(r.size), r.block, r.maxrregcount ?? 'none', f1(r.span_s), f0(r.bps), pc(r.achieved_occupancy), pc(r.tail_share)]);
const layoutRows = layout.map((r) => [f0(r.size), esc(r.variant.replace('(v1)', '(current layout, v2 kernel)')), f1(r.span_s), f0(r.bps), pc(r.tail_share), `x${(r.speedup ?? 0).toFixed(2)}`, r.same_results ? 'identical' : '<span class="fail">differ</span>']);

// ---------------------------------------------------------------- R4/R5 numbers
const pre = fiveBy.prof0?.prof;
const r45 = table(['item', 'seconds', 'source'], [
  ['idle CPU workers while the GPU ran, share 0.004 (5-gen, before)', f1(pre?.cpuIdle), 'evolve-gpu2-prof0 gpu-profile.json, sum of per-step cpuIdleS'],
  ['idle CPU workers while the GPU ran, measured share (5-gen, after)', f1(p1c?.cpuIdle), `evolve-gpu2-p1d, share ${p1c?.share ?? 'pending'}`],
  [`time in the ${v1.small.length} steps under 5,000 battles (v1 run)`, f1(v1.smallS), `${f0(v1.smallRate)} b/s vs ${f0(v1.bigRate)} b/s in the ${v1.big.length} larger steps`],
  ['... of which lost to their size (at the larger steps\' rate they would take less)', f1(v1.smallLost), 'not recoverable by merging: see F4'],
  ['serial flagged re-run tail (v1 run, step wall minus GPU path in steps with flagged rows)', f1(v1.flaggedTail), `${f0(v1.flagged)} flagged rows`],
  ['serial flagged re-run tail (v2 run)', f1(v2Prof?.buckets.flagged), v2Prof ? `${f0(v2Prof.flagged)} flagged rows` : 'pending'],
  ['GA step, v2 run (sum over generations)', f1(v2Prof?.buckets.ga), 'gpu-profile.json'],
  ['packing (describe + pack), v2 run', f1(v2Prof?.buckets.pack), 'gpu-profile.json'],
  ['memo lookup + pairing plan, v2 run', f1(v2Prof?.buckets.plan), 'gpu-profile.json'],
  ['fitness accumulation, v2 run', f1(v2Prof?.buckets.accumulate), 'gpu-profile.json'],
  ['checkpoint + report, v2 run', f1(v2Prof ? v2Prof.buckets.checkpoint + v2Prof.buckets.report : null), 'gpu-profile.json'],
  ['gen 0, v1 / v2 run', `${f1(v1Run?.genS[0])} / ${f1(v2Run?.genS[0])}`, 'checkpoint timing'],
  ['final pass, v1 / v2 run', `${f1(v1Run?.finalS)} / ${f1(v2Run?.finalS)}`, 'evolve-result.json eliteTiming'],
]);

// ---------------------------------------------------------------- conclusion
const v1TailS = (() => { const sh = launchesV1.length ? median(launchesV1.map((l) => l.tail_share)) : null; return sh == null ? null : sh * v1.gpuPath; })();
const causes = [['kernel tail (the last battles/warps of each launch; launch time is set by its slowest warps, and warp divergence makes a mixed warp run several times its slowest member)', v1TailS], ['serial re-run of flagged (pool-overflow) rows after the GPU', v1.flaggedTail], ['small halving-round launches (latency-bound)', v1.smallLost]].filter(([, s]) => s != null).sort((a, b) => b[1] - a[1]);
const speedupV2 = v2Run?.done ? 32496 / v2Run.runningS : null; // CPU baseline 9h 01m 36s running
const conclusion = `Dominant cause of the x9.8: ${causes[0]?.[0] ?? 'pending'} (~${f0(causes[0]?.[1])} s of the v1 run's ${f0(v1RunningS)} s), then ${causes.slice(1).map(([n, s]) => `${n} (~${f0(s)} s)`).join(', ')}. ` +
  (speedupV2 ? `GPU-v2 runs the full search in ${hms(v2Run.runningS)}: x${speedupV2.toFixed(1)} vs the 9h 01m 36s CPU run.` : 'GPU-v2 full run pending.');

const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GPU Speed Profile</title>
<style>:root{--bg:#fff;--fg:#111;--line:#bbb;--head:#eee;--pass:#0a7a2f;--fail:#b3261e;--na:#8a6d00;--muted:#555}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151515;--fg:#eee;--line:#555;--head:#2a2a2a;--pass:#58d68d;--fail:#ff8a80;--na:#e6c24d;--muted:#aaa}}
:root[data-theme="dark"]{--bg:#151515;--fg:#eee;--line:#555;--head:#2a2a2a;--pass:#58d68d;--fail:#ff8a80;--na:#e6c24d;--muted:#aaa}
body{font:15px/1.5 system-ui,sans-serif;max-width:1200px;margin:2rem auto;padding:0 16px;background:var(--bg);color:var(--fg)}
.tw{overflow-x:auto}table{border-collapse:collapse;margin:.6rem 0 1.2rem}td,th{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}th{background:var(--head)}
.pass{color:var(--pass);font-weight:700}.fail{color:var(--fail);font-weight:700}.na{color:var(--na);font-weight:700}.small{font-size:13px;color:var(--muted)}.warn{color:var(--na)}
.concl{border:2px solid var(--line);padding:8px 14px;border-radius:6px}details{margin:.5rem 0}</style>
<h1>Why --gpu gave x9.8, and what changed</h1>
<p class="concl"><b>Conclusion:</b> ${esc(conclusion)}</p>
<p>Round 5: <a href="gpu-gap.html">why the v2 run reached 724 b/s and not 1,500, and what would close the gap</a>.</p>

<h2 id="s1">1. Where the time goes (R1)</h2>
<h3>GPU-v1 run (from its log; the v1 code logged only these totals)</h3>${v1Table}
<p class="small">${f0(v1.battles)} battles in ${v1Steps.length} steps, ${f0(v1.flagged)} flagged rows. Buckets are differences of logged totals, so only the last row is a check.</p>
<h3>GPU-v2 run (every bucket timed)</h3>${attributionTable(v2Prof)}
<details><summary>5-gen runs, one per fix (same command, 5 generations)</summary>${five.map((r) => `<h4>${esc(r.label)} <span class="small">(${esc(r.dir)})</span></h4>${attributionTable(r.prof)}`).join('')}</details>

<h2 id="s2">2. Kernel tail (R2)</h2>
<p>Launch time against batch size and against the longest battle (its turns and lookahead inner sims). Tail = time after half the launch's battles have finished, from per-battle <code>%globaltimer</code> stamps written by the kernel.</p>
<p>v1 kernel: ${tailSummary(launchesV1, (l) => l.span_s, (l) => l.n, (l) => l.battle_max_s, (l) => l.tail_share)}<br>
v2 kernel, 5-gen run: ${p1c ? tailSummary(p1c.launches, (l) => l.spanMs, (l) => l.n, (l) => l.maxBattleMs, (l) => (l.spanMs ? l.tailMs / l.spanMs : 0)) : 'pending'}<br>
v2 kernel, full run: ${v2Prof ? tailSummary(v2Prof.launches, (l) => l.spanMs, (l) => l.n, (l) => l.maxBattleMs, (l) => (l.spanMs ? l.tailMs / l.spanMs : 0)) : 'pending'}</p>
${table(['size', 'kernel', 'span s', 'b/s', 'tail share', 'flagged', 'longest battle s', 'turns / inner sims'], slices.map((r) => [f0(r.size), esc(r.variant), f1(r.span_s), f0(r.bps), pc(r.tail_share), r.flagged, f1(r.battle_max_s), `${r.longest?.turns ?? 'n/a'} / ${r.longest?.innerSims ?? 'n/a'}`]))}
<details><summary>Every launch (v1 replay and v2 5-gen run)</summary>${table(['source', '#', 'battles', 'span s', 'tail s', 'tail share', 'longest battle s', 'its turns', 'its inner sims', 'flagged'], [...v1LaunchRows, ...(p1c ? tailRows(p1c.launches, 'v2 kernel, 5-gen run (p1d)') : [])])}</details>

<h2 id="s3">3. Occupancy and divergence (R3)</h2>
${table(['lookahead state', 'pool', 'register cap', 'registers', 'local bytes / thread', 'spill bytes', 'max block', 'theoretical occupancy by block size'], resRows)}
<h3>Block-size sweep (v1 kernel; achieved occupancy = resident warp-time / SM warp capacity over the span)</h3>${table(['slice', 'block', 'register cap', 'span s', 'b/s', 'achieved occupancy', 'tail share'], sweepRows)}
<h3>Warp divergence</h3><p>${divergence ? `${divergence.n} battles run in their normal mixed warps (span ${f1(divergence.mixed_span_s)} s) and each alone in a warp of 32 identical copies. A mixed warp takes <b>x${divergence.warp_over_slowest_member.toFixed(1)}</b> its slowest member's solo time and x${divergence.warp_over_mean_member.toFixed(1)} its mean member's; running a warp's 32 battles one after another solo would take x${divergence.sum_solo_over_warp.toFixed(1)} the mixed warp. Results identical: ${divergence.same_results}.` : 'pending'}</p>
<h3>Layout and ordering prototypes (measured on the slices)</h3>${layoutRows.length ? table(['slice', 'variant', 'span s', 'b/s', 'tail share', 'vs one thread per battle', 'results'], layoutRows) : '<p class="na">pending</p>'}

<h2 id="s4">4. Scheduling and outside the kernel (R4, R5)</h2>${r45}
${share ? `<p>CPU share fit: ${esc(share.note ?? '')}</p>` : ''}
<h3>Flagged rows (R10)</h3><p>${[['v1 run command, gens 0-2 (gen 0 = the v1 run\'s own gen 0)', flagV1], ['5-gen pre-fix run (mega pool)', flagP0]].map(([n, f]) => (f ? `${esc(n)}: v1 kernel flags ${f.v1_flagged} of ${f0(f.dump_rows)} rows (${f.v1_pool_overflow} POOL_OVERFLOW); the v2 kernel on those rows: <b>${f.v2_pool_overflow_on_v1_set} POOL_OVERFLOW</b>, ${f.v2_flagged_on_v1_set} flagged, peak pool ${f.v2_pool_max_on_v1_set}; whole dump on v2: ${f.v2_flagged_whole_dump} flagged.` : `${esc(n)}: pending`)).join('<br>')}<br>Memory: 36,000 battles per launch still fit (the 36,000 slice runs as one launch on the 10 GB card; batch limit unchanged at 36,000).</p>

<h2 id="s5">5. Per-fix predicted vs measured (R6)</h2>
${table(['fix', 'req', 'change', 'applied', 'predicted saving, full run', 'basis', 'measured on slices (kernel span)', 'measured on 5-gen (per battle, scaled)', '20% rule'], fixRows)}
<p class="small">5-gen savings are over gens 1-4 (gen 0 holds one-time cold starts: the pre-fix run's gen 0 includes a ~55 s CUDA compile), per simulated battle and scaled to the earlier run's battle count, because GPU float results and CPU results differ in ~0.2% of winners and the searches diverge after gen 0 (gen 0 is the same set of pairings in every run, so its difference is shown too).</p>

<h2 id="s6">6. Slice vs full run (R7)</h2>${sliceVsFull()}
`;
writeFileSync('out/gpu-profile.html', html);
console.log('wrote out/gpu-profile.html');
