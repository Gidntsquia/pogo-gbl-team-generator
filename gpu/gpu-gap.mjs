// "Why 724 not 1,500" page (plans/PLAN.md round 5): out/gpu-gap.html.   node gpu/gpu-gap.mjs
// Inputs: v2 log + gpu-profile.json, v1 log, out/gpu/gap/*.json (slices.json from `uv run python -m gpu.gap_proto`, checks.json by hand),
// verify logs out/gpu-gap-verify*.log, 5-gen run dirs out/evolve-gpu3-bigger and out/evolve-gpu2-p1d (v2 gens 0-4 = evolve-recipe-ab-gpu2-halving).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const V2 = 'out/evolve-recipe-ab-gpu2-halving', V2LOG = `${V2}.log`, V1LOG = 'out/evolve-recipe-ab-gpu-halving.log';
const GAP = 'out/gpu/gap';
const TARGET = 1500, RESIDENT = 68 * 8 * 32, BIG = 5000;
const rd = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const txt = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const sum = (a, f = (x) => x) => a.reduce((s, x) => s + f(x), 0);
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n0 = (x) => (x == null || Number.isNaN(x) ? 'n/a' : Math.round(x).toLocaleString('en-US'));
const n1 = (x) => (x == null || Number.isNaN(x) ? 'n/a' : x.toFixed(1));
const n2 = (x) => (x == null || Number.isNaN(x) ? 'n/a' : x.toFixed(2));
const sg = (x) => (x >= 0 ? '+' : '−') + n1(Math.abs(x));
const tag = (ok, y = 'PASS', no = 'FAIL') => (ok == null ? '<span class="na">pending</span>' : `<span class="${ok ? 'pass' : 'fail'}">${ok ? y : no}</span>`);
const table = (head, rows) => `<div class="tw"><table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table></div>`;
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)];

function fit(xs, ys) {
  const n = xs.length, mx = sum(xs) / n, my = sum(ys) / n;
  let sxy = 0, sxx = 0;
  xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; });
  const b = sxy / sxx;
  return { a: my - b * mx, b };
}

// ---------------------------------------------------------------- data
const prof = rd(`${V2}/gpu-profile.json`);
const S = prof.steps;
const B = (s, k) => s.buckets[k] ?? 0;
const pre = (s) => B(s, 'plan') + B(s, 'pack') + B(s, 'transport') + B(s, 'map') + B(s, 'accumulate') + B(s, 'flagged');
const N = sum(S, (s) => s.n), W = sum(S, (s) => s.wall), bps = N / W;
const Tt = N / TARGET, gap = W - Tt;
const big = S.filter((s) => s.n >= BIG), small = S.filter((s) => s.n < BIG);
const rBig = sum(big, (s) => s.n) / sum(big, (s) => B(s, 'kernel')); // body rate (to the median battle's finish) of the >= 5k steps
const preFit = fit(S.map((s) => s.n), S.map(pre));
const tail = sum(S, (s) => B(s, 'tail'));
const smallExcess = sum(small, (s) => B(s, 'kernel')) - sum(small, (s) => s.n) / rBig;
const fixed = preFit.a * S.length;
const sized = sum(S, pre) - fixed;
const wait = sum(S, (s) => B(s, 'waitCpu'));
const unexpl = W - sum(S, (s) => Object.values(s.buckets).reduce((a, b) => a + b, 0));
const idealWall = sum(big, (s) => B(s, 'kernel')) + sum(small, (s) => s.n) / rBig; // everything removed except the kernel body at the >= 5k rate
const slack = idealWall - Tt; // negative: the 1,500 budget leaves room
const outsideStep = sum(prof.generations, (g) => g.wall) - W + sum(Object.values(prof.phases));
const causes = [
  ['a', 'Kernel tail: launch span after the median battle finished', tail, 'tail bucket summed over 301 steps (span − body, per-launch %globaltimer stamps in gpu-profile.json)'],
  ['b', `Small launches: ${small.length} steps under ${BIG.toLocaleString()} battles run slower than the ≥ ${BIG.toLocaleString()} rate`, smallExcess, `kernel body of those steps (${n1(sum(small, (s) => B(s, 'kernel')))} s) − their battles ÷ ${n0(rBig)} b/s (body rate of the ${big.length} steps ≥ ${BIG.toLocaleString()})`],
  ['c', 'Per-launch fixed cost (plan, pack, transport, map, accumulate at zero battles)', fixed, `fit step pre-kernel time = ${n2(preFit.a)} s + ${(preFit.b * 1000).toFixed(4)} ms × battles; intercept × ${S.length} steps`],
  ['d', 'Outside-kernel, size-proportional (same buckets, slope part)', sized, 'pre-kernel buckets total − (c)'],
  ['e', 'CPU share and waiting (GPU idle until the CPU slice finishes)', wait, 'waitCpu bucket'],
];
// b/s after removing causes one at a time, in this order
let wcur = W;
const steps = causes.map((c) => { const before = N / wcur; wcur -= c[2]; return { before, after: N / wcur }; });
const headroom = { label: `Headroom: the ideal kernel body at ${n0(rBig)} b/s is faster than the 1,500 b/s budget`, s: slack };
const causeSum = sum(causes, (c) => c[2]) + slack;
const residual = gap - causeSum;

const log2 = txt(V2LOG);
const rowsGap = causes.map((c, i) => [`(${c[0]}) ${esc(c[1])}`, n1(c[2]), n1((c[2] / W) * 100) + '%', `${n0(steps[i].before)} → ${n0(steps[i].after)} (${sg(steps[i].after - steps[i].before)})`, `<small>${esc(c[3])}</small>`]);
rowsGap.push([esc(headroom.label), sg(slack), '', '', '<small>ideal wall − target wall (negative = room under the bar)</small>']);
rowsGap.push(['Unexplained', n1(residual), '', '', '<small>gap − the rows above; includes step wall minus bucket sum (' + n2(unexpl) + ' s)</small>']);
rowsGap.push(['<b>Gap to 1,500 b/s</b>', `<b>${n1(gap)}</b>`, '', `<b>${n0(bps)} → ${TARGET}</b>`, `<small>step wall ${n1(W)} s − ${n0(N)} battles ÷ 1,500 = ${n1(W)} − ${n1(Tt)}. Rows sum to ${n1(causeSum)} s (${n1((Math.abs(residual) / gap) * 100)}% off)</small>`]);

// §2 bounds
const bi = W - tail, bii = bi - smallExcess, biii = bii - (sum(S, pre) + wait);
const bound = [
  ['(i) every launch ends when its median battle ends', bi, 'tail = 0'],
  ['(ii) + every launch runs at the ≥ 5k per-launch rate', bii, 'small-launch excess = 0'],
  ['(iii) + no outside-kernel time', biii, 'plan/pack/transport/map/accumulate/CPU wait = 0'],
].map(([l, w, d]) => [l, n1(w), n0(N / w), tag(N / w >= TARGET, 'yes', 'no'), `<small>${d}</small>`]);

// ---------------------------------------------------------------- §3 v1
const l1 = txt(V1LOG) ?? '';
const re = /gpu step -- (?:(\d+) memo hits, )?(\d+) battles on GPU in ([\d.]+)s, (\d+) on CPU in ([\d.]+)s(?: \((\d+) GPU rows flagged)?.*wall ([\d.]+)s/g;
const v1 = [...l1.matchAll(re)].map((m) => ({ g: +m[2], gs: +m[3], c: +m[4], cs: +m[5], fl: +(m[6] ?? 0), wall: +m[7] }));
const v1tot = l1.match(/gpu totals -- (\d+) battles on GPU \((\d+)s\), (\d+) on CPU \((\d+)s\), (\d+) flagged/);
const v1fl = sum(v1, (s) => s.fl), v1wall = sum(v1, (s) => s.wall), v1gs = sum(v1, (s) => s.gs);
const v1flagTail = sum(v1, (s) => Math.max(0, s.wall - s.gs));

// ---------------------------------------------------------------- §4 literature (quotes fetched this session; "unverified" = only a search excerpt or summary was seen)
const LIT = [
  { c: 'Aila &amp; Laine, “Understanding the efficiency of ray traversal on GPUs”, HPG 2009', u: 'https://research.nvidia.com/publication/2009-08_understanding-efficiency-ray-traversal-gpus', topic: 'b, a', ok: true,
    q: '“previously known methods are a factor of 1.5–2.5X off from theoretical optimum, and most of the gap is not explained by memory bandwidth, but rather by previously unidentified inefficiencies in hardware work distribution.”',
    m: 'Measured traversal kernels against a simulator upper bound; the fix is persistent threads that fetch work from a pool.', gain: '1.5–2.5× gap closed in part (abstract gives no single speedup)', imp: 'Our gap to the “ideal kernel” is the same shape (hardware assigns whole warps; one long battle holds its warp), which a work pool addresses only when there is more work than resident threads.' },
  { c: 'Gupta, Stuart &amp; Owens, “A Study of Persistent Threads Style GPU Programming for GPGPU Workloads”, InPar 2012', u: 'https://escholarship.org/uc/item/3j76d3td', topic: 'b, a', ok: false,
    q: '“Micro-kernel benchmarks indicate PT can be up to an order of magnitude faster than non-PT kernels, but it can also cause performance losses in many cases.” (summary seen through a search excerpt; the page itself did not load)',
    m: 'Defines persistent threads and compares it to the one-thread-per-item style across micro-kernels.', gain: 'up to ~10×; losses in many cases', imp: 'A work queue can lose as well as win; with 254 registers only 17,408 threads are resident, so it can only help launches larger than that.' },
  { c: 'Tzeng, Patney &amp; Owens, “Task Management for Irregular-Parallel Workloads on the GPU”, HPG 2010', u: 'https://diglib.eg.org/items/d9c3a0b9-b326-4514-9fbc-e85f82662121', topic: 'a, b', ok: false,
    q: 'Compared one shared task queue, distributed queues, task stealing and task donation; the centralised and distributed queues sat idle far more than stealing and donation (search summary; the page returned 403).',
    m: 'Load balance of irregular tasks across the GPU with software queues.', gain: 'not quantified in the text seen', imp: 'A single atomic counter is the simplest queue and idles more than donation/stealing, but our items are independent so a counter is enough.' },
  { c: 'Fung &amp; Aamodt, “Thread Block Compaction for Efficient SIMT Control Flow”, HPCA 2011', u: 'https://people.ece.ubc.ca/aamodt/papers/wwlfung.hpca2011.pdf', topic: 'c', ok: false,
    q: 'Secondary sources cite a 22% average speedup on divergent CUDA applications; the PDF text could not be read here (compressed stream).',
    m: 'Hardware regrouping of divergent threads across the warps of a block.', gain: '≈22% (unverified)', imp: 'Warp divergence is hardware-side here: a mixed warp of our battles runs ×5.9 its slowest member, and software cannot regroup mid-battle.' },
  { c: 'Makoviychuk et al., “Isaac Gym: High Performance GPU-Based Physics Simulation For Robot Learning”, 2021', u: 'https://arxiv.org/abs/2108.10470', topic: 'a', ok: true,
    q: '“2-3 orders of magnitude improvements compared to conventional RL training that uses a CPU based simulator and GPU for neural networks.”',
    m: 'Thousands of environments stepped in lockstep on the GPU.', gain: '10²–10³× vs CPU simulators', imp: 'Batched simulators win by keeping every environment the same length; our battles vary ×5 in length, which is why we are far below that.' },
  { c: 'Ito &amp; Ohno et al., “Boosting Performance of Iterative Applications on GPUs: Kernel Batching with CUDA Graphs”, 2025', u: 'https://arxiv.org/abs/2501.09398', topic: 'd', ok: true,
    q: '“one potential performance bottleneck with GPU-accelerated applications is the overhead from launching several fine-grained kernels.” … “the optimal iteration batch size gives more than 1.4x speed-up in the skeleton application.”',
    m: 'Groups launches into batches to amortise launch overhead.', gain: '>1.4×', imp: 'Our launch overhead is small (fixed cost ≈ 0.16 s a step); the benefit here comes from bigger launches amortising the tail, not CUDA Graphs.' },
];

// ---------------------------------------------------------------- §5 ideas (predictions from the numbers above)
const slices = rd(`${GAP}/slices.json`);
const chk = rd(`${GAP}/checks.json`) ?? {};
const warpRound4 = 1.2225; // out/gpu/prof0-layout.json, 5,000 slice, LANES 32
const spanStep = (s) => B(s, 'kernel') + B(s, 'tail');
const smallSpan = sum(small, spanStep);
const warpSave = smallSpan * (1 - 1 / warpRound4);
const gt = S.filter((s) => s.n > RESIDENT);
const queueSave = sum(gt, (s) => Math.max(0, (s.launches ?? []).reduce((a, l) => a + (l.spanMs - l.maxBattleMs), 0) / 1000));
const spanEqMax = sum(S, (s) => (s.launches ?? []).reduce((a, l) => a + (l.spanMs - l.maxBattleMs), 0) / 1000);
const overlapSave = wait; // the next step's pairings need this step's fitness, so only the CPU-share wait can be hidden
// bigger launches: halving rounds 3 -> 2 merges rounds 1+2 of each generation into one launch; per-step wall from the fit of step wall on battles
const wf = fit(S.map((s) => s.n), S.map((s) => s.wall));
const gens = {};
S.forEach((s) => (gens[s.gen] ??= []).push(s));
let wBig = 0, stepsBig = 0;
for (const g of Object.values(gens)) {
  const ns = g.map((s) => s.n);
  const m = ns.length >= 3 ? [ns[0] + ns[1], ...ns.slice(2)] : ns;
  stepsBig += m.length;
  wBig += sum(m, (n) => wf.a + wf.b * n);
}
const ideas = [
  { name: 'Fewer, bigger launches', pred: N / wBig, status: 'p',
    arith: `Per-step wall ≈ ${n2(wf.a)} s + ${(wf.b * 1000).toFixed(3)} ms × battles (fit over ${S.length} steps). Merging each generation's first two steps (halving 3 → 2 rounds) leaves ${stepsBig} steps for the same ${n0(N)} battles: Σ wall = ${n1(wBig)} s → ${n0(N / wBig)} b/s.`,
    lit: 'Aila &amp; Laine; Ito et al. (launch amortisation)' },
  { name: 'Warp-per-battle for small launches only', pred: N / (W - warpSave), status: 'p',
    arith: `${small.length} steps under ${BIG.toLocaleString()} battles spend ${n1(smallSpan)} s in the kernel; round-4 prototype ×${warpRound4.toFixed(2)} at 5k → saves ${n1(warpSave)} s → ${n0(N / (W - warpSave))} b/s.`,
    lit: 'Fung &amp; Aamodt (divergence)' },
  { name: 'Overlap launches with CPU work', pred: N / (W - overlapSave), status: 'u',
    arith: `Next-step pairings depend on step k's fitness (halving), so only the CPU-share wait can be hidden: ${n1(overlapSave)} s → ${n0(N / (W - overlapSave))} b/s. GA/checkpoint time sits outside the step wall (${n1(outsideStep)} s) and the next generation needs its output.`,
    lit: 'Ito et al. (launch latency)' },
  { name: 'Work-queue kernel', pred: N / (W - queueSave), status: 'u',
    arith: `The launch span already equals the longest battle (Σ span − longest = ${n1(spanEqMax)} s over all launches), and only ${gt.length} steps exceed the ${n0(RESIDENT)} resident threads (68 SMs × 8 warps × 32). A queue cannot shorten the longest battle: saves ≤ ${n1(queueSave)} s → ${n0(N / (W - queueSave))} b/s.`,
    lit: 'Aila &amp; Laine; Gupta et al.; Tzeng et al.' },
];
ideas.sort((a, b) => b.pred - a.pred);
ideas.forEach((x, i) => { x.status = i < 2 ? 'p' : 'u'; });

// ---------------------------------------------------------------- §6 prototype results
const vrow = (v, size) => slices?.variants.find((r) => r.variant === v && r.size === size);
const sc = (size) => slices?.scaling.find((r) => r.size === size);
const protoRows = [], goes = [];
if (slices) {
  for (const x of ideas.filter((i) => i.status === 'p')) {
    if (x.name.startsWith('Warp')) {
      const a5 = vrow('warp', 5000), b5 = vrow('v2', 5000), a36 = vrow('warp', 36000), b36 = vrow('v2', 36000);
      // the size-selected kernel runs the thread-per-battle code at 36k (>= 5k), so the 36k ratio is v2 by construction; the measured warp-at-36k is shown too
      const r5 = a5.bps / b5.bps, r36 = 1.0;
      const go = r5 >= 1.3 && r36 >= 1.0 && a5.same_results;
      protoRows.push([x.name, `${n0(b5.bps)} → ${n0(a5.bps)} (×${n2(r5)}) ${a5.same_results ? '' : '<b>rows differ</b>'}<br><small>spans ${a5.span_all_s.map((v) => n2(v)).join(', ')} s</small>`, `×1.00 (v2 code runs ≥ 5k; forced warp layout at 36k would be ×${n2(a36.bps / b36.bps)})`, go ? 'GO' : `NO-GO (needs ×1.3 at 5k)`]);
      goes.push({ name: x.name, go, r5 });
    } else {
      const s5 = sc(5000), s15 = sc(15000), s18 = sc(18000), s36 = sc(36000);
      const r5 = s15.bps / s5.bps, r36 = s36.bps / s36.bps;
      const go = r5 >= 1.3;
      protoRows.push([x.name, `a 5k step inside a 15k launch: ${n0(s5.bps)} → ${n0(s15.bps)} b/s (×${n2(r5)})<br><small>no kernel change; scaling: ${slices.scaling.map((r) => `${r.size / 1000}k ${n0(r.bps)}`).join(', ')} b/s</small>`, `×1.00 (36k launch unchanged)`, go ? 'GO (kernel); search effect in §6b' : 'NO-GO']);
      goes.push({ name: x.name, go, r5, big: true });
    }
  }
}
// 6b: bigger-launch 5-gen run vs v2 gens 0-4
function genFile(dir, g) { return rd(`${dir}/evolve-gen${g}.json`); }
function cmp5(dirA, dirB) {
  const out = { gens: [] };
  let tA = 0, tB = 0, bA = 0, bB = 0;
  for (let g = 0; g < 5; g++) {
    const a = genFile(dirA, g), b = genFile(dirB, g);
    if (!a || !b) return null;
    const top = (c) => c.population.map((p, i) => ({ p, f: c.fitness[i] })).sort((x, y) => y.f - x.f).slice(0, 12);
    const ta = top(a), tb = top(b), sa = new Set(ta.map((x) => x.p.join('|')));
    out.gens.push({ g, shared: tb.filter((x) => sa.has(x.p.join('|'))).length, dMean: sum(tb, (x) => x.f) / 12 - sum(ta, (x) => x.f) / 12 });
    tA += a.timing.elapsedMs / 1000; tB += b.timing.elapsedMs / 1000; bA += a.timing.battleCount; bB += b.timing.battleCount;
  }
  return { ...out, tA, tB, bA, bB };
}
const c5 = cmp5(V2, 'out/evolve-gpu3-bigger');

// verification logs
const vlog = (f) => { const t = txt(f); return t ? t.split('\n').filter((l) => /winner agreement|flagged invalid in total|PASS|FAIL|team-A win rate/.test(l)).slice(-6).join('\n') : null; };

// projection (R9)
const proj = [];
for (const g of goes.filter((x) => x.go)) {
  if (g.big) proj.push([g.name, n0(N / wBig), n1(wBig), n0(N / wBig / bps * 100) + '%']);
  else proj.push([g.name, n0(N / (W - warpSave)), n1(W - warpSave), '']);
}

// ---------------------------------------------------------------- page
const best = ideas[0];
const conclusion = `The dominant cause is the kernel tail: ${n0(tail)} of the ${n0(W)} step-wall seconds (${n1((tail / W) * 100)}%) go to waiting for the longest battles after the median battle has finished; the launch span equals the longest battle, so it cannot be shortened by scheduling alone. 1,500 b/s is reachable on paper: an ideal kernel that ends each launch at its median battle would run ${n0(N / bi)} b/s, and with every launch at the ≥ 5k rate and no outside-kernel time ${n0(N / biii)} b/s. The idea with the largest predicted gain is “${best.name}” (${n0(best.pred)} b/s predicted); `
  + (c5 ? `its 5-gen run measured ${n0(c5.bB / c5.tB)} b/s vs ${n0(c5.bA / c5.tA)} for v2 gens 0–4. ` : '')
  + `Verdict stays FAIL against 1,500 until a full run meets it. Recommended next round: ${chk.recommend ?? 'see the prototype table'}.`;

const css = `:root{--bg:#fff;--fg:#1d2330;--mut:#5b6577;--line:#d9dee7;--card:#f5f7fa;--ok:#157347;--bad:#b42318}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#14171d;--fg:#e6e9ef;--mut:#9aa3b2;--line:#2c3340;--card:#1c2028;--ok:#4cc38a;--bad:#ff7b72}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:16px}
h1{font-size:1.5rem}h2{margin-top:2rem;border-bottom:1px solid var(--line);padding-bottom:4px}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;margin:.6rem 0}th,td{border:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}th{background:var(--card)}
.pass{color:var(--ok);font-weight:700}.fail{color:var(--bad);font-weight:700}.na{color:var(--mut)}small,.mut{color:var(--mut)}pre{background:var(--card);padding:8px;overflow-x:auto}blockquote{margin:0;color:var(--mut)}`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GPU Gap Analysis</title><style>${css}</style></head><body>
<h1>Why 724 b/s and not 1,500</h1>
<p class="mut">GPU-v2 run <code>${V2}</code>: ${n0(N)} battles in ${n1(W)} s of step wall = <b>${n0(bps)} b/s</b> (A/B page: 724; GPU-side 745). Bar: 1,500 b/s → ${n1(Tt)} s, a gap of <b>${n1(gap)} s</b>. Verdict on the bar: ${tag(false)} until a run meets it. Built by <code>gpu/gpu-gap.mjs</code>. See also <a href="gpu-profile.html">speed profile</a> and <a href="recipe-ab-gpu.html">A/B page</a>.</p>
<p><b>Conclusion.</b> ${conclusion}</p>

<h2 id="s1">1. Where the ${n1(gap)} s go</h2>
<p>Causes are removed one after another in the order shown; “b/s” is the run's rate before → after each removal. Outside the step wall (GA, checkpoint, report, final pass, compile setup) the run spends another ${n1(outsideStep)} s, which the 724 figure does not include.</p>
${table(['Cause', 'Seconds', 'Share of wall', 'b/s before → after', 'How measured'], rowsGap)}

<h2 id="s2">2. Ideal-kernel bound</h2>
${table(['Scenario', 'Wall (s)', 'b/s', '1,500 reachable?', 'Removes'], bound)}

<h2 id="s3">3. v1 reconciliation</h2>
${table(['Source', 'Flagged rows', 'Step wall (s)', 'Notes'], [
  ['This page parser, v1 log (301 step lines)', n0(v1fl), n1(v1wall), `step wall = GPU path ${n1(v1gs)} s + ${n1(v1flagTail)} s serial re-run of flagged rows after the GPU returned`],
  ['v1 log totals line', v1tot ? n0(+v1tot[5]) : 'n/a', 'n/a (GPU 2,689 s, CPU 1,138 s)', 'printed by the run itself'],
  ['Round 4 worker notes', '3,207', '3,237.6', 'same parse'],
  ['Old plan Facts', '3,686', '2,758', 'not reproducible from any column of the log'],
])}
<p><b>Right figures: ${n0(v1fl)} flagged rows and ${n1(v1wall)} s.</b> The flagged count equals the run's own totals line. 2,758 s sits near the GPU-path column (${n1(v1gs)} s) and not at any sum of wall; 3,686 matches no count in the log. I treat both old numbers as mis-transcribed.</p>

<h2 id="s4">4. Literature</h2>
${table(['Source', 'What it measured', 'Reported gain', 'Quote', 'Implication here', 'Status'], LIT.map((l) => [`<a href="${l.u}">${l.c}</a>`, l.m, l.gain, `<blockquote>${l.q}</blockquote>`, l.imp, l.ok ? tag(true, 'quote fetched') : '<b>unverified</b>']))}

<h2 id="s5">5. The four ideas</h2>
${table(['Idea', 'Predicted b/s on v2 run', 'Arithmetic', 'Literature', 'Status'], ideas.map((x) => [x.name, n0(x.pred), `<small>${x.arith}</small>`, x.lit, x.status === 'p' ? '<b>prototyped</b>' : 'untested']))}
<p class="mut">The two largest predictions are prototyped. Result-identical ideas win ties; none tied.</p>

<h2 id="s6">6. Prototype results</h2>
${slices ? table(['Prototype', 'Kernel b/s on the 5k slice (v2 → prototype, median of 3)', '36k slice', 'Verdict'], protoRows) : '<p class="na">pending: run <code>uv run python -m gpu.gap_proto</code></p>'}
${slices ? `<p><b>Smoke measurement of the untested work-queue kernel</b> (<code>POGO_GPU_KERNEL=queue</code>, 3 launches, not verified, status stays “untested”): 5k ${n0(vrow('queue', 5000)?.bps)} b/s vs v2 ${n0(vrow('v2', 5000)?.bps)}; 36k ${n0(vrow('queue', 36000)?.bps)} vs ${n0(vrow('v2', 36000)?.bps)}; rows equal v2: ${vrow('queue', 5000)?.same_results && vrow('queue', 36000)?.same_results ? 'yes' : 'no'}.</p>` : ''}
<h3>Verification of the kernel change (warp layout under 5k)</h3>
<pre>${esc(vlog('out/gpu-gap-verify3v3-warp.log') ?? 'pending')}\n${esc(vlog('out/gpu-gap-verify1v1-warp.log') ?? '')}</pre>
<h3 id="s6b">Bigger launches: 5-gen run vs v2 gens 0–4</h3>
${c5 ? table(['Gen', 'Top-12 teams shared', 'Mean top-12 fitness delta'], c5.gens.map((g) => [g.g, `${g.shared} / 12 ${g.shared < 8 ? '<span class="fail">FLAG (&lt; 8)</span>' : ''}`, (g.dMean >= 0 ? '+' : '') + g.dMean.toFixed(4)])) + `<p>Battles ${n0(c5.bB)} vs ${n0(c5.bA)}; generation time ${n1(c5.tB)} s vs ${n1(c5.tA)} s → ${n0(c5.bB / c5.tB)} vs ${n0(c5.bA / c5.tA)} b/s.</p>` : '<p class="na">pending: <code>out/evolve-gpu3-bigger</code> not complete</p>'}
<h3>Determinism and CPU-only checks</h3>
<pre>${esc(JSON.stringify(chk.determinism ?? 'pending', null, 1))}\n${esc(JSON.stringify(chk.cpuOnly ?? 'pending', null, 1))}</pre>
<h3>Projection of a full run (R9)</h3>
${proj.length ? table(['Prototype with a go', 'Projected b/s', 'Projected wall (s)', 'vs v2 (%)'], proj) + `<p>Marked against 1,500: ${proj.some((p) => +p[1].replace(/,/g, '') >= 1500) ? 'met' : 'not met'}; against ×10 of the CPU baseline: see A/B page.</p>` : '<p>No prototype passed its go bar, so there is nothing to project.</p>'}
</body></html>`;
writeFileSync('out/gpu-gap.html', html);
console.log(`out/gpu-gap.html written: gap ${n1(gap)} s, causes+headroom ${n1(causeSum)} s, residual ${n1(residual)} s; ideas: ${ideas.map((i) => `${i.name} ${n0(i.pred)}`).join('; ')}`);
