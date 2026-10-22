// CPU vs GPU evolve comparison for recipe-ab-old-halving (plans/PLAN.md 2026-10-14, extended in round 4 with GPU-v2).
//   node gpu/gpu-ab.mjs agree [--v 2] [--n 2000] [--seed gpu-ab-agree]   2,000 pairings drawn from the CPU run's checkpoints, battled on CPU and GPU
//   node gpu/gpu-ab.mjs score [--v 2]                                    curated-100 win rate of a GPU run's finalists (CPU engine, like recipe-ab-score)
//   node gpu/gpu-ab.mjs report                                           out/recipe-ab-gpu.html (verdict judged on GPU-v2; v1 kept as a column)
// --v 1 = the round-3 run/kernel (needs POGO_GPU_KERNEL=v1 for agree), --v 2 (default) = the round-4 run/kernel.
// Reads out/evolve-recipe-ab-old-halving (CPU), the GPU dirs below, out/recipe-ab/curated100.json (CPU run's curated scores).
// Writes under out/recipe-ab-gpu/ (v1: agreement.json, curated100-gpu.json; v2: agreement-v2.json, curated100-gpu2.json).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { buildEvolveSetup } from '../src/evolve/setup.js';
import { parseEvolveArgs } from '../src/evolve/cli.js';
import { evaluateTeamsInOrder } from '../src/evolve/evaluate.js';
import { ownLeadPairing } from '../src/evolve/fitness.js';
import { buildMetaMon } from '../src/scoring/index.js';
import { mulberry32, hashSeed } from '../src/engine/battle/virtualClock.js';
import { createExecutor } from '../src/engine/parallel.js';

const CPU_DIR = 'out/evolve-recipe-ab-old-halving';
const RUNS = {
  1: { dir: 'out/evolve-recipe-ab-gpu-halving', repro: 'out/evolve-recipe-ab-gpu-halving-repro', agree: 'agreement.json', curated: 'curated100-gpu.json', label: 'GPU-v1: recipe-ab-gpu-halving' },
  2: { dir: 'out/evolve-recipe-ab-gpu2-halving', repro: 'out/evolve-recipe-ab-gpu2-repro', agree: 'agreement-v2.json', curated: 'curated100-gpu2.json', label: 'GPU-v2: recipe-ab-gpu2-halving' },
};
const STATE = 'out/recipe-ab-gpu', COLLECTION = 'jaxon-gl-collection.csv', SIM = 'recipe-ab-old-halving';
const [cmd, ...rest] = process.argv.slice(2);
const opt = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const V = Number(opt('v', 2));
if (!RUNS[V]) { console.error('--v must be 1 or 2'); process.exit(2); }
const GPU_DIR = RUNS[V].dir;
mkdirSync(STATE, { recursive: true });

async function setupFor() {
  const { csvPath, opts } = parseEvolveArgs([COLLECTION, '--cup', 'mega', '--seed', 'recipe-ab', '--curated-ratio', '0.66', '--opponent-meta-pool', '400', '--out-dir', path.join(STATE, '_setup')]);
  return buildEvolveSetup(csvPath, { ...opts, onLog: () => {} });
}

if (cmd === 'agree') {
  const N = Number(opt('n', 2000)), seed = opt('seed', 'gpu-ab-agree');
  const setup = await setupFor();
  const { ctx, deduped } = setup;
  const gens = readdirSync(CPU_DIR).filter((f) => /^evolve-gen\d+\.json$/.test(f)).map((f) => Number(f.match(/\d+/)[0])).sort((a, b) => a - b);
  const cps = new Map();
  const oppSpecs = new Map();
  const rng = mulberry32(hashSeed(seed));
  const specs = [], meta = [];
  while (specs.length < N) {
    const g = gens[Math.floor(rng() * gens.length)];
    if (!cps.has(g)) cps.set(g, readJson(path.join(CPU_DIR, `evolve-gen${g}.json`)));
    const cp = cps.get(g);
    const t = Math.floor(rng() * cp.population.length), o = Math.floor(rng() * cp.opponentPool.length);
    const opp = cp.opponentPool[o];
    const ok = `${g}/${o}`;
    if (!oppSpecs.has(ok)) oppSpecs.set(ok, opp.members.map((m) => buildMetaMon(ctx, m).spec));
    specs.push({ teamA: cp.population[t].map((k) => deduped.builtMons[k].spec), teamB: oppSpecs.get(ok), leadA: 0, leadB: opp.leadIndex ?? 0 });
    meta.push({ gen: g, team: t, opp: o });
  }
  const cpu = createExecutor({ threads: 8, vendorRoot: ctx.vendorRoot, continueOnError: true, cp: ctx.cp, cup: ctx.cup });
  const { createGpuExecutor } = await import('../src/engine/gpuExecutor.js');
  const gx = await createGpuExecutor({ ctx, cpuExecutor: createExecutor({ threads: 2, vendorRoot: ctx.vendorRoot, continueOnError: true, cp: ctx.cp, cup: ctx.cup }), cpuShare: 0, log: console.log });
  const t0 = Date.now();
  const c = await cpu.run(specs);
  const tCpu = Date.now() - t0;
  const t1 = Date.now();
  const g = await gx.run(specs);
  const tGpu = Date.now() - t1;
  let compared = 0, agree = 0, flagged = 0, aCpu = 0, aGpu = 0, hpEqual = 0, lfEqual = 0, errors = 0;
  c.forEach((r, i) => {
    if (!r.ok || !g[i].ok) { errors++; return; }
    if (!g[i].viaGpu) { flagged++; return; }
    compared++;
    if (r.value.winner === g[i].value.winner) agree++;
    if (r.value.winner === 'a') aCpu++;
    if (g[i].value.winner === 'a') aGpu++;
    if (r.value.survivorsHp.a === g[i].value.survivorsHp.a && r.value.survivorsHp.b === g[i].value.survivorsHp.b) hpEqual++;
    if (r.value.summary.leadFaintTurnA === g[i].value.summary.leadFaintTurnA && r.value.summary.leadFaintTurnB === g[i].value.summary.leadFaintTurnB) lfEqual++;
  });
  const out = { kernel: process.env.POGO_GPU_KERNEL === 'v1' ? 'v1 (pool 768)' : 'v2 (packed pool 2048)', sample: N, seed, generationsDrawnFrom: gens.length, compared, flaggedExcluded: flagged, errors, winnerAgreement: agree / compared, winnerMismatches: compared - agree,
    aWinRateCpu: aCpu / compared, aWinRateGpu: aGpu / compared, winRateDeltaPts: (aGpu - aCpu) / compared * 100,
    survivorHpEqual: hpEqual / compared, leadFaintEqual: lfEqual / compared, cpuMs: tCpu, gpuMs: tGpu };
  writeFileSync(path.join(STATE, RUNS[V].agree), JSON.stringify(out, null, 2));
  console.log(out);
  await cpu.close(); await gx.close();
  process.exit(0);
}

if (cmd === 'score') {
  if (!existsSync(path.join(GPU_DIR, 'evolve-DONE'))) { console.error('gpu run not finished'); process.exit(1); }
  // the CPU run's curated-100 scores used the archived mega curated file; score against the same set
  process.env.POGO_COMMUNITY_FILE ??= 'data/archive/meta-teams-community-mega-great.json';
  const setup = await setupFor();
  const opponents = setup.curatedPool.map((t) => ({ ...t, label: 'curated', leadIndex: t.leadIndex ?? 0 }));
  if (!opponents.length) { console.error(`no curated opponents from ${process.env.POGO_COMMUNITY_FILE}`); process.exit(1); }
  const executor = createExecutor({ threads: 8, vendorRoot: setup.ctx.vendorRoot, continueOnError: true, cp: setup.ctx.cp, cup: setup.ctx.cup });
  try {
    const result = readJson(path.join(GPU_DIR, 'evolve-result.json'));
    const finalists = result.elites.map((e) => ({ keys: e.members.map((m) => m.key), signature: e.signature }));
    const run = await evaluateTeamsInOrder(setup.ctx, { teams: finalists.map((f) => f.keys), matrix: setup.deduped, opponents, pairingsFor: ownLeadPairing,
      difficulty: setup.difficulty, executor, roleScores: setup.roleScores, cache: setup.battleCache });
    const sims = { [`gpu-${SIM}`]: finalists.map((f, i) => ({ signature: f.signature, curatedWinRate: run.results[i].rawWinRate })) };
    writeFileSync(path.join(STATE, RUNS[V].curated), JSON.stringify({ opponentCount: opponents.length, engine: 'cpu (pvpoke)', sims }, null, 2));
    console.log(`scored ${finalists.length} finalists vs ${opponents.length} curated; top1 ${(Object.values(sims)[0][0].curatedWinRate * 100).toFixed(1)}%`);
  } finally { await executor.close(); }
  process.exit(0);
}

if (cmd === 'report') {
  const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
  const fmtMs = (ms) => { if (ms == null) return 'n/a'; const s = Math.round(ms / 1000); return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`; };
  const n0 = (x) => (x == null ? 'n/a' : Math.round(x).toLocaleString('en-US'));
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const gensOf = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => /^evolve-gen\d+\.json$/.test(f)).map((f) => Number(f.match(/\d+/)[0])).sort((a, b) => a - b) : []);
  const curatedCpu = readJson('out/recipe-ab/curated100.json')?.sims?.[`recipe-ab-old-halving`];
  const quality = (sc) => (sc ? sc.slice(0, 5).reduce((s, x) => s + x.curatedWinRate, 0) / Math.min(5, sc.length) : null);
  const CPU_QUALITY = 0.576, CPU_RUNNING_MS = (9 * 3600 + 1 * 60 + 36) * 1000, BPS_TARGET = 1500; // plans/PLAN.md: 57.6%, 9h 01m 36s
  function load(dir, scored) {
    const result = readJson(path.join(dir, 'evolve-result.json'));
    const complete = existsSync(path.join(dir, 'evolve-DONE')) && !!result;
    const gens = gensOf(dir);
    const timings = gens.map((g) => readJson(path.join(dir, `evolve-gen${g}.json`))?.timing).filter(Boolean);
    const sum = (k) => timings.reduce((s, t) => s + (t[k] ?? 0), 0) + (complete ? result.eliteTiming?.[k] ?? 0 : 0);
    const runningMs = sum('elapsedMs');
    return { dir, result, complete, gens: gens.length, config: result?.config ?? readJson(path.join(dir, 'evolve-gen0.json'))?.config, runningMs,
      simulated: sum('battleCount'), cached: sum('cachedCount'), gen0Ms: timings[0]?.elapsedMs ?? null, finalMs: complete ? result.eliteTiming?.elapsedMs ?? 0 : 0,
      scored: scored ?? null, quality: quality(scored) };
  }
  /** Step-line totals of a GPU run's log (the v1 log has no `share` field; v2 lines add `share X (N CPU)`). */
  function logFacts(file) {
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const steps = [...text.matchAll(/gpu step -- (?:\d+ memo hits, )?(\d+) battles on GPU in ([\d.]+)s, (\d+) on CPU in ([\d.]+)s(?: \((\d+) GPU rows flagged)?(?:, share ([\w.]+) \((\d+) CPU\))?.*wall ([\d.]+)s/g)]
      .map((m) => ({ g: +m[1], gs: +m[2], c: +m[3], cs: +m[4], fl: +(m[5] ?? 0), share: m[6] ?? null, nCpuShare: m[7] == null ? null : +m[7], wall: +m[8] }));
    const S = (k) => steps.reduce((s, x) => s + (x[k] ?? 0), 0);
    const curatedLine = text.match(/evolve: starting[^\n]*\(\d+ curated\)[^\n]*|curated opponent pool is empty[^\n]*/)?.[0] ?? null;
    return { steps, gpuBattles: S('g'), cpuBattles: S('c'), gpuSecs: S('gs'), cpuSecs: S('cs'), stepWall: S('wall'), flagged: S('fl'), cpuShareBattles: S('nCpuShare'),
      share: steps.find((x) => x.share)?.share ?? null, curatedLine };
  }
  const cpu = load(CPU_DIR, curatedCpu);
  const runs = [1, 2].map((v) => {
    const R = RUNS[v];
    const scored = readJson(path.join(STATE, R.curated))?.sims?.[`gpu-${SIM}`];
    const run = load(R.dir, scored);
    const log = logFacts(`${R.dir}.log`);
    const agree = readJson(path.join(STATE, R.agree));
    const strip = (o) => (Array.isArray(o) ? o.map(strip) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([k]) => !/ms$|elapsed|^timing$|runStartedAt|^threadsUsed$|^resumed$|startedAt|finishedAt|csvPath|^analytics$/i.test(k)).map(([k, v]) => [k, strip(v)])) : o);
    const repro = [0, 1, 2, 3, 4].map((g) => {
      const a = readJson(path.join(R.dir, `evolve-gen${g}.json`)), b = readJson(path.join(R.repro, `evolve-gen${g}.json`));
      return { g, present: !!a && !!b, same: !!a && !!b && JSON.stringify(strip(a)) === JSON.stringify(strip(b)) };
    });
    return { v, R, run, log, agree, repro, scored };
  });
  const v1 = runs[0], v2 = runs[1];
  // verdict: judged on GPU-v2 against the fixed CPU numbers from the plan
  const speedup = v2.run.runningMs ? CPU_RUNNING_MS / v2.run.runningMs : null;
  const gap = v2.run.quality != null ? (v2.run.quality - CPU_QUALITY) * 100 : null;
  const reproAny = v2.repro.some((r) => r.present), reproPass = v2.repro.every((r) => r.same);
  const fullBps = v2.run.complete && v2.run.runningMs ? v2.run.simulated / (v2.run.runningMs / 1000) : null;
  const agree = v2.agree;
  const rows = [
    { name: 'Finalist quality drops more than 3 points vs the CPU run (57.6%)', ok: gap == null ? null : gap >= -3, detail: gap == null ? 'not scored yet' : `${pct(CPU_QUALITY)} CPU vs ${pct(v2.run.quality)} GPU-v2 (${gap >= 0 ? '+' : ''}${gap.toFixed(1)} pts; run-to-run noise is about 3 pts)` },
    { name: 'Winner agreement on sampled battles under 99%', ok: agree ? agree.winnerAgreement >= 0.99 : null, detail: agree ? `${(agree.winnerAgreement * 100).toFixed(2)}% of ${agree.compared} battles on the ${agree.kernel ?? 'v2'} kernel (${agree.winnerMismatches} differ; sample ${agree.sample}, ${agree.flaggedExcluded} flagged rows excluded, A-win rate ${(agree.aWinRateCpu * 100).toFixed(1)}% CPU vs ${(agree.aWinRateGpu * 100).toFixed(1)}% GPU)` : 'not measured yet' },
    { name: 'Speedup under x10 end-to-end (vs 9h 01m 36s CPU running time)', ok: speedup == null || !v2.run.complete ? null : speedup >= 10, detail: speedup == null ? 'n/a' : `x${speedup.toFixed(1)} (${fmtMs(CPU_RUNNING_MS)} CPU vs ${fmtMs(v2.run.runningMs)} GPU-v2${v2.run.complete ? '' : ', run incomplete'})` },
    { name: 'Two GPU-v2 runs with the same seed differ (gen 0-4)', ok: reproAny ? reproPass : null, detail: reproAny ? v2.repro.map((r) => `gen${r.g} ${r.present ? (r.same ? 'same' : 'DIFFERS') : 'missing'}`).join(', ') : 'repro run not finished' },
  ];
  const extra = { name: `GPU-v2 battles per second on the full run (target ${BPS_TARGET.toLocaleString('en-US')})`, ok: fullBps == null ? null : fullBps >= BPS_TARGET,
    detail: fullBps == null ? 'run incomplete' : `${n0(fullBps)} b/s end to end (simulated battles / running time); GPU side alone ${n0(v2.log.gpuSecs ? v2.log.gpuBattles / v2.log.gpuSecs : null)} b/s while it ran` };
  const mark = (ok) => (ok == null ? '<span class="na">pending</span>' : ok ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>');
  const failed = rows.filter((r) => r.ok === false);
  const bps = (sim, ms) => (ms ? sim / (ms / 1000) : null);
  const verdictLine = failed.length ? `<b>${failed.length} of 4 distrust checks FAIL on GPU-v2.</b> ${failed.map((r) => esc(r.name)).join('; ')}.`
    : rows.some((r) => r.ok == null) ? '<b>Incomplete:</b> some GPU-v2 checks are still pending.'
    : `<b>All four distrust checks pass on GPU-v2.</b> The GPU-v2 run is x${speedup.toFixed(1)} faster end to end than the CPU run, finalist quality ${gap >= 0 ? '+' : ''}${gap.toFixed(1)} pts.${extra.ok === false ? ` <b>The 1,500 b/s target is not met</b> (${n0(fullBps)} b/s end to end): launches are bound by their slowest battles, see out/gpu-profile.html and <a href="gpu-gap.html">why not 1,500 (gpu-gap.html)</a>, <a href="gpu-sched.html">round-6 scheduler (gpu-sched.html)</a>.` : ''}`;
  const cfg = (s, f) => (s.config ? f(s.config) : 'n/a');
  const perSim = [
    ['population schedule', (s) => cfg(s, (k) => `${k.population} -> ${Math.round(k.population * k.populationFinalRatio)} (final ratio ${k.populationFinalRatio})`)],
    ['opponents per gen', (s) => cfg(s, (k) => k.opponentsPerGen)], ['K (sampled opponents)', (s) => cfg(s, (k) => k.sampledOpponents ?? 'off')],
    ['halving rounds', (s) => cfg(s, (k) => k.halvingRounds ?? 0)], ['seed', (s) => cfg(s, (k) => k.seed)],
    ['stop reason', (s) => (s.complete ? s.result.stopReason : 'incomplete')], ['generations completed', (s) => s.gens],
    ['running wall time', (s) => fmtMs(s.runningMs)], ['battles simulated', (s) => n0(s.simulated)], ['battles served from cache', (s) => n0(s.cached)],
    ['mean ms per simulated battle', (s) => (s.simulated ? (s.runningMs / s.simulated).toFixed(1) : 'n/a')],
    ['battles per second (simulated / running time)', (s) => (bps(s.simulated, s.runningMs) ?? 0).toFixed(1)],
    ['gen-0 time', (s) => fmtMs(s.gen0Ms)], ['final-pass time', (s) => (s.complete ? fmtMs(s.finalMs) : 'n/a')], ['relaunches', () => 0],
    ['top-5 curated-100 quality', (s) => pct(s.quality)],
  ];
  const gpuRows = [
    ['curated opponents in the search', (x) => (x.log.curatedLine ? esc(x.log.curatedLine.replace(/^evolve: /, '')) : 'n/a')],
    ['battles on GPU', (x) => n0(x.log.gpuBattles)], ['battles on CPU (share + flagged re-runs)', (x) => n0(x.log.cpuBattles)],
    ['GPU battles per second (while the GPU side ran)', (x) => (x.log.gpuSecs ? (x.log.gpuBattles / x.log.gpuSecs).toFixed(1) : 'n/a')],
    ['GPU rows flagged invalid, re-run on CPU', (x) => n0(x.log.flagged)],
    ['CPU share (configured)', (x) => String(x.run.config?.gpuCpuShare ?? 'n/a') + (x.v === 2 && x.log.steps.length ? ` (${n0(x.log.cpuShareBattles)} battles = ${pct(x.log.cpuShareBattles / (x.log.gpuBattles + x.log.cpuBattles))} of all)` : '')],
    ['kernel', (x) => (x.v === 1 ? 'v1: lookahead pool 768, 28-byte states' : 'v2: packed 12-byte states, pool 2048')],
  ];
  const top = (s) => (s.complete ? s.result.elites.slice(0, 12) : []);
  const sp = (m) => m.speciesId ?? String(m.key).split('#')[0];
  const tk = (e) => `${sp(e.members[0])}||${e.members.slice(1).map(sp).sort().join('|')}`;
  const cores = (e) => { const s = [...new Set(e.members.map(sp))].sort(); const o = []; for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) o.push(`${s[i]}+${s[j]}`); return o; };
  const marks = (e, other) => { const ot = new Set(other.map(tk)), oc = new Set(other.flatMap(cores)), os = new Set(other.flatMap((x) => x.members.map(sp)));
    return [ot.has(tk(e)) ? 'T' : '', cores(e).some((c) => oc.has(c)) ? `C:${cores(e).filter((c) => oc.has(c)).length}` : '', `S:${[...new Set(e.members.map(sp))].filter((s) => os.has(s)).length}`].filter(Boolean).join(' '); };
  const topTable = (s, other, sc) => (s.complete ? `<table><tr><th>#</th><th>team (lead first)</th><th>final-pass score</th><th>curated-100</th><th>marks vs CPU run</th></tr>${top(s).map((e, i) => `<tr><td>${i + 1}</td><td>${esc(e.members.map((x) => x.name).join(' / '))}</td><td>${pct(e.combinedScore)}</td><td>${pct(sc?.find((x) => x.signature === e.signature)?.curatedWinRate)}</td><td>${marks(e, top(other))}</td></tr>`).join('')}</table>` : '<p class="na">run not finished</p>');
  const agreeText = (a) => (a ? `${a.sample.toLocaleString('en-US')} candidate-vs-opponent pairings drawn with seed "${a.seed}" from ${a.generationsDrawnFrom} CPU-run checkpoints, each battled once by battleTeams on CPU and once by the ${a.kernel ?? 'v1'} kernel. Winner agreement ${(a.winnerAgreement * 100).toFixed(2)}% (${a.winnerMismatches} of ${a.compared} differ); team-A win rate ${(a.aWinRateCpu * 100).toFixed(2)}% CPU vs ${(a.aWinRateGpu * 100).toFixed(2)}% GPU (delta ${a.winRateDeltaPts.toFixed(2)} pts); survivor HP identical in ${(a.survivorHpEqual * 100).toFixed(1)}%, lead-faint turns identical in ${(a.leadFaintEqual * 100).toFixed(1)}%. ${a.flaggedExcluded} rows the kernel flags invalid are re-run on CPU in the real run and are excluded here.` : 'not measured yet');
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GPU vs CPU evolve</title>
<style>:root{--bg:#fff;--fg:#111;--line:#bbb;--head:#eee;--pass:#0a7a2f;--fail:#b3261e;--na:#8a6d00}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151515;--fg:#eee;--line:#555;--head:#2a2a2a;--pass:#58d68d;--fail:#ff8a80;--na:#e6c24d}}
:root[data-theme="dark"]{--bg:#151515;--fg:#eee;--line:#555;--head:#2a2a2a;--pass:#58d68d;--fail:#ff8a80;--na:#e6c24d}
body{font:15px/1.5 system-ui,sans-serif;max-width:1200px;margin:2rem auto;padding:0 16px;background:var(--bg);color:var(--fg)}table{border-collapse:collapse;margin:1rem 0;display:block;overflow-x:auto}td,th{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}th{background:var(--head)}.pass{color:var(--pass);font-weight:700}.fail{color:var(--fail);font-weight:700}.na{color:var(--na);font-weight:700}.verdict{border:2px solid var(--line);padding:8px 14px;border-radius:6px}</style>
<h1>GPU vs CPU: recipe-ab-old-halving</h1>
<div class="verdict"><p>${verdictLine}</p>
<p>Judged on <b>GPU-v2</b>: speedup <b>${speedup ? 'x' + speedup.toFixed(1) : 'n/a'}</b> (running time, downtime excluded) &middot; quality gap <b>${gap == null ? 'n/a' : (gap >= 0 ? '+' : '') + gap.toFixed(1) + ' pts'}</b> (gaps under 3 pts are noise) &middot; winner agreement <b>${agree ? (agree.winnerAgreement * 100).toFixed(2) + '%' : 'n/a'}</b> on a ${agree ? agree.sample.toLocaleString('en-US') : '2,000'}-battle sample &middot; repro <b>${reproAny ? (reproPass ? 'PASS' : 'FAIL') : 'pending'}</b> &middot; full-run b/s <b>${n0(fullBps)}</b> (target 1,500 ${mark(extra.ok)}, <a href="gpu-gap.html">why</a>, <a href="gpu-sched.html">round-6 scheduler</a>)</p></div>
<h2>Distrust checks (GPU-v2)</h2><table><tr><th>check</th><th>result</th><th>detail</th></tr>${[...rows, extra].map((r) => `<tr><td>${esc(r.name)}</td><td>${mark(r.ok)}</td><td>${esc(r.detail)}</td></tr>`).join('')}</table>
<h2>Read this first</h2><p>&bull; Same seed and flags, but GPU results are float32 and differ from pvpoke in about 0.2% of winners, so the runs diverge into different (statistically comparable) searches. Battle counts differ for that reason.</p>
<p>&bull; <b>GPU-v1 caveat:</b> the GPU-v1 run's search saw 0 curated opponents (the curated file had been swapped to base Great League, which a mega cup filters to nothing), while the CPU run's search saw 79-83 per generation. Its finalists were then scored against the archived 100 mega curated teams. The v1 quality gap therefore mixes GPU float differences with that missing search signal. GPU-v2 ran with <code>POGO_COMMUNITY_FILE=data/archive/meta-teams-community-mega-great.json</code>, the CPU run's curated set.</p>
<p>&bull; Both GPU runs' finalists were scored on the curated 100 by the CPU engine. The curated teams were opponents during the search, so these are shared, not unseen, opponents. The CPU column comes from the existing out/evolve-recipe-ab-old-halving artifacts, no rerun. Why v2 is faster: <code>out/gpu-profile.html</code>.</p>
<h2>Per sim</h2><table><tr><th></th><th>CPU: recipe-ab-old-halving</th>${runs.map((x) => `<th>${esc(x.R.label)}</th>`).join('')}</tr>${perSim.map(([n, f]) => `<tr><td>${n}</td><td>${esc(f(cpu))}</td>${runs.map((x) => `<td>${esc(f(x.run))}</td>`).join('')}</tr>`).join('')}${gpuRows.map(([n, f]) => `<tr><td>${n}</td><td>n/a</td>${runs.map((x) => `<td>${f(x)}</td>`).join('')}</tr>`).join('')}</table>
<h2>Top 12 teams</h2><p>Teams are lead first. Marks vs the CPU run's top 12: <code>T</code> same team (lead species + set of others), <code>C:n</code> n two-species cores shared, <code>S:n</code> species shared.</p>
<h3>CPU run</h3>${topTable(cpu, v2.run, curatedCpu).replace('marks vs CPU run', 'marks vs GPU-v2 run')}<h3>GPU-v2 run</h3>${topTable(v2.run, cpu, v2.scored)}<h3>GPU-v1 run</h3>${topTable(v1.run, cpu, v1.scored)}
<h2>Agreement sample</h2><p><b>GPU-v2:</b> ${agreeText(v2.agree)}</p><p><b>GPU-v1:</b> ${agreeText(v1.agree)}</p>`;
  writeFileSync('out/recipe-ab-gpu.html', html);
  console.log('wrote out/recipe-ab-gpu.html');
  process.exit(0);
}
if (!['agree', 'score', 'report'].includes(cmd)) { console.error('usage: node gpu/gpu-ab.mjs agree|score|report'); process.exit(2); }
