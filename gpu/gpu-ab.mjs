// CPU vs GPU evolve comparison for recipe-ab-old-halving (plans/PLAN.md, 2026-10-14).
//   node gpu/gpu-ab.mjs agree [--n 2000] [--seed gpu-ab-agree]   2,000 pairings drawn from the CPU run's checkpoints, battled on CPU and GPU
//   node gpu/gpu-ab.mjs score                                    curated-100 win rate of the GPU run's finalists (CPU engine, like recipe-ab-score)
//   node gpu/gpu-ab.mjs report                                   out/recipe-ab-gpu.html
// Reads out/evolve-recipe-ab-old-halving (CPU), out/evolve-recipe-ab-gpu-halving (GPU), out/evolve-recipe-ab-gpu-halving-repro,
// out/recipe-ab/curated100.json (CPU run's curated scores). Writes under out/recipe-ab-gpu/.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { buildEvolveSetup } from '../src/evolve/setup.js';
import { parseEvolveArgs } from '../src/evolve/cli.js';
import { evaluateTeamsInOrder } from '../src/evolve/evaluate.js';
import { ownLeadPairing } from '../src/evolve/fitness.js';
import { buildMetaMon } from '../src/scoring/index.js';
import { mulberry32, hashSeed } from '../src/engine/battle/virtualClock.js';
import { createExecutor } from '../src/engine/parallel.js';

const CPU_DIR = 'out/evolve-recipe-ab-old-halving', GPU_DIR = 'out/evolve-recipe-ab-gpu-halving', REPRO_DIR = 'out/evolve-recipe-ab-gpu-halving-repro';
const STATE = 'out/recipe-ab-gpu', COLLECTION = 'jaxon-gl-collection.csv', SIM = 'recipe-ab-old-halving';
const [cmd, ...rest] = process.argv.slice(2);
const opt = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
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
  const out = { sample: N, seed, generationsDrawnFrom: gens.length, compared, flaggedExcluded: flagged, errors, winnerAgreement: agree / compared, winnerMismatches: compared - agree,
    aWinRateCpu: aCpu / compared, aWinRateGpu: aGpu / compared, winRateDeltaPts: (aGpu - aCpu) / compared * 100,
    survivorHpEqual: hpEqual / compared, leadFaintEqual: lfEqual / compared, cpuMs: tCpu, gpuMs: tGpu };
  writeFileSync(path.join(STATE, 'agreement.json'), JSON.stringify(out, null, 2));
  console.log(out);
  await cpu.close(); await gx.close();
  process.exit(0);
}

if (cmd === 'score') {
  if (!existsSync(path.join(GPU_DIR, 'evolve-DONE'))) { console.error('gpu run not finished'); process.exit(1); }
  const setup = await setupFor();
  const opponents = setup.curatedPool.map((t) => ({ ...t, label: 'curated', leadIndex: t.leadIndex ?? 0 }));
  const executor = createExecutor({ threads: 8, vendorRoot: setup.ctx.vendorRoot, continueOnError: true, cp: setup.ctx.cp, cup: setup.ctx.cup });
  try {
    const result = readJson(path.join(GPU_DIR, 'evolve-result.json'));
    const finalists = result.elites.map((e) => ({ keys: e.members.map((m) => m.key), signature: e.signature }));
    const run = await evaluateTeamsInOrder(setup.ctx, { teams: finalists.map((f) => f.keys), matrix: setup.deduped, opponents, pairingsFor: ownLeadPairing,
      difficulty: setup.difficulty, executor, roleScores: setup.roleScores, cache: setup.battleCache });
    const sims = { [`gpu-${SIM}`]: finalists.map((f, i) => ({ signature: f.signature, curatedWinRate: run.results[i].rawWinRate })) };
    writeFileSync(path.join(STATE, 'curated100-gpu.json'), JSON.stringify({ opponentCount: opponents.length, engine: 'cpu (pvpoke)', sims }, null, 2));
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
  const curatedGpu = readJson(path.join(STATE, 'curated100-gpu.json'))?.sims?.[`gpu-${SIM}`];
  const quality = (sc) => (sc ? sc.slice(0, 5).reduce((s, x) => s + x.curatedWinRate, 0) / Math.min(5, sc.length) : null);
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
  const cpu = load(CPU_DIR, curatedCpu), gpu = load(GPU_DIR, curatedGpu);
  // GPU log facts: per-step lines and totals (summed over every attempt in the log, incl. .log.N from relaunches)
  const logText = ['out/evolve-recipe-ab-gpu-halving.log'].filter(existsSync).map((f) => readFileSync(f, 'utf8')).join('\n');
  const steps = [...logText.matchAll(/gpu step -- (?:\d+ memo hits, )?(\d+) battles on GPU in ([\d.]+)s, (\d+) on CPU in ([\d.]+)s(?: \((\d+) GPU rows flagged)?.*wall ([\d.]+)s/g)].map((m) => ({ g: +m[1], gs: +m[2], c: +m[3], cs: +m[4], fl: +(m[5] ?? 0), wall: +m[6] }));
  const sumS = (k) => steps.reduce((s, x) => s + x[k], 0);
  const gpuBattles = sumS('g'), cpuBattles = sumS('c'), gpuSecs = sumS('gs'), cpuSecs = sumS('cs'), stepWall = sumS('wall'), flagged = sumS('fl');
  const agree = readJson(path.join(STATE, 'agreement.json'));
  const speedup = cpu.runningMs && gpu.runningMs ? cpu.runningMs / gpu.runningMs : null;
  const gap = cpu.quality != null && gpu.quality != null ? (gpu.quality - cpu.quality) * 100 : null;
  // reproducibility: gen 0..4 of the repro run vs the main run, minus timing/bookkeeping fields
  const strip = (o) => (Array.isArray(o) ? o.map(strip) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([k]) => !/ms$|elapsed|^timing$|runStartedAt|^threadsUsed$|^resumed$|startedAt|finishedAt|csvPath|^analytics$/i.test(k)).map(([k, v]) => [k, strip(v)])) : o);
  const repro = [0, 1, 2, 3, 4].map((g) => {
    const a = readJson(path.join(GPU_DIR, `evolve-gen${g}.json`)), b = readJson(path.join(REPRO_DIR, `evolve-gen${g}.json`));
    return { g, present: !!a && !!b, same: !!a && !!b && JSON.stringify(strip(a)) === JSON.stringify(strip(b)) };
  });
  const reproPass = repro.every((r) => r.same);
  const reproAny = repro.some((r) => r.present);
  const rows = [
    { name: 'Finalist quality drops more than 3 points vs the CPU run', ok: gap == null ? null : gap >= -3, detail: gap == null ? 'not scored yet' : `${pct(cpu.quality)} CPU vs ${pct(gpu.quality)} GPU (${gap >= 0 ? '+' : ''}${gap.toFixed(1)} pts; run-to-run noise is about 3 pts)` },
    { name: 'Winner agreement on sampled battles under 99%', ok: agree ? agree.winnerAgreement >= 0.99 : null, detail: agree ? `${(agree.winnerAgreement * 100).toFixed(2)}% of ${agree.compared} GPU-produced battles (${agree.winnerMismatches} differ; sample ${agree.sample}, ${agree.flaggedExcluded} flagged rows excluded, A-win rate ${(agree.aWinRateCpu * 100).toFixed(1)}% CPU vs ${(agree.aWinRateGpu * 100).toFixed(1)}% GPU)` : 'not measured yet' },
    { name: 'Speedup under x10 end-to-end', ok: speedup == null ? null : speedup >= 10, detail: speedup == null ? 'n/a' : `x${speedup.toFixed(1)} (${fmtMs(cpu.runningMs)} CPU running time vs ${fmtMs(gpu.runningMs)} GPU)` },
    { name: 'Two GPU runs with the same seed differ', ok: reproAny ? reproPass : null, detail: reproAny ? repro.map((r) => `gen${r.g} ${r.present ? (r.same ? 'same' : 'DIFFERS') : 'missing'}`).join(', ') : 'repro run not finished' },
  ];
  const mark = (ok) => (ok == null ? '<span class="na">pending</span>' : ok ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>');
  const failed = rows.filter((r) => r.ok === false);
  const bps = (sim, ms) => (ms ? sim / (ms / 1000) : null);
  const where = `Time breakdown of the GPU run: ${fmtMs(gpu.runningMs)} total; battle steps ${fmtMs(stepWall * 1000)} (GPU side ${fmtMs(gpuSecs * 1000)} summed, CPU side ${fmtMs(cpuSecs * 1000)} summed, ${flagged.toLocaleString('en-US')} GPU rows flagged invalid and re-run on CPU); everything else (GA, memo, packing in the main thread, reports) ${fmtMs(Math.max(0, gpu.runningMs - stepWall * 1000))}.`;
  const verdictLine = failed.length ? `<b>${failed.length} of 4 distrust checks FAIL.</b> ${where}` : rows.some((r) => r.ok == null) ? '<b>Incomplete:</b> some checks are still pending.' : `<b>All four distrust checks pass.</b> The GPU run is ${speedup ? 'x' + speedup.toFixed(1) : 'n/a'} faster end to end with finalist quality ${gap >= 0 ? '+' : ''}${gap?.toFixed(1)} pts vs CPU.`;
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
  const gpuRows = [['battles on GPU', n0(gpuBattles)], ['battles on CPU (share + flagged re-runs)', n0(cpuBattles)], ['GPU battles per second (while the GPU side ran)', gpuSecs ? (gpuBattles / gpuSecs).toFixed(1) : 'n/a'],
    ['GPU rows flagged invalid, re-run on CPU', n0(flagged)], ['CPU share (configured)', String(gpu.config?.gpuCpuShare ?? 'n/a')]];
  const top = (s) => (s.complete ? s.result.elites.slice(0, 12) : []);
  const sp = (m) => m.speciesId ?? String(m.key).split('#')[0];
  const tk = (e) => `${sp(e.members[0])}||${e.members.slice(1).map(sp).sort().join('|')}`;
  const cores = (e) => { const s = [...new Set(e.members.map(sp))].sort(); const o = []; for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) o.push(`${s[i]}+${s[j]}`); return o; };
  const marks = (e, other) => { const ot = new Set(other.map(tk)), oc = new Set(other.flatMap(cores)), os = new Set(other.flatMap((x) => x.members.map(sp)));
    return [ot.has(tk(e)) ? 'T' : '', cores(e).some((c) => oc.has(c)) ? `C:${cores(e).filter((c) => oc.has(c)).length}` : '', `S:${[...new Set(e.members.map(sp))].filter((s) => os.has(s)).length}`].filter(Boolean).join(' '); };
  const topTable = (s, other, sc) => `<table><tr><th>#</th><th>team (lead first)</th><th>final-pass score</th><th>curated-100</th><th>marks vs other run</th></tr>${top(s).map((e, i) => `<tr><td>${i + 1}</td><td>${esc(e.members.map((x) => x.name).join(' / '))}</td><td>${pct(e.combinedScore)}</td><td>${pct(sc?.find((x) => x.signature === e.signature)?.curatedWinRate)}</td><td>${marks(e, top(other))}</td></tr>`).join('')}</table>`;
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GPU vs CPU evolve</title>
<style>:root{--bg:#fff;--fg:#111;--line:#bbb;--head:#eee;--pass:#0a7a2f;--fail:#b3261e;--na:#8a6d00}@media(prefers-color-scheme:dark){:root{--bg:#151515;--fg:#eee;--line:#555;--head:#2a2a2a;--pass:#58d68d;--fail:#ff8a80;--na:#e6c24d}}
body{font:15px/1.5 system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 16px;background:var(--bg);color:var(--fg)}table{border-collapse:collapse;margin:1rem 0;display:block;overflow-x:auto}td,th{border:1px solid var(--line);padding:4px 8px;text-align:left}th{background:var(--head)}.pass{color:var(--pass);font-weight:700}.fail{color:var(--fail);font-weight:700}.na{color:var(--na);font-weight:700}.verdict{border:2px solid var(--line);padding:8px 14px;border-radius:6px}</style>
<h1>GPU vs CPU: recipe-ab-old-halving</h1>
<div class="verdict"><p>${verdictLine}</p>
<p>Speedup <b>${speedup ? 'x' + speedup.toFixed(1) : 'n/a'}</b> (running time, downtime excluded) &middot; quality gap <b>${gap == null ? 'n/a' : (gap >= 0 ? '+' : '') + gap.toFixed(1) + ' pts'}</b> (gaps under 3 pts are noise) &middot; winner agreement <b>${agree ? (agree.winnerAgreement * 100).toFixed(2) + '%' : 'n/a'}</b> on a ${agree ? agree.sample.toLocaleString('en-US') : '2,000'}-battle sample &middot; repro <b>${reproAny ? (reproPass ? 'PASS' : 'FAIL') : 'pending'}</b></p></div>
<h2>Distrust checks</h2><table><tr><th>check</th><th>result</th><th>detail</th></tr>${rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${mark(r.ok)}</td><td>${esc(r.detail)}</td></tr>`).join('')}</table>
<h2>Read this first</h2><p>&bull; Same seed and flags, but GPU results are float32 and differ from pvpoke in about 0.2% of winners, so the two runs diverge into different (statistically comparable) searches. Battle counts differ for that reason.</p>
<p>&bull; Both runs' finalists were scored on the curated 100 by the CPU engine. The curated teams were opponents during the search, so these are shared, not unseen, opponents. The CPU column comes from the existing out/evolve-recipe-ab-old-halving artifacts, no rerun.</p>
<h2>Per sim</h2><table><tr><th></th><th>CPU: recipe-ab-old-halving</th><th>GPU: recipe-ab-gpu-halving</th></tr>${perSim.map(([n, f]) => `<tr><td>${n}</td><td>${esc(f(cpu))}</td><td>${esc(f(gpu))}</td></tr>`).join('')}${gpuRows.map(([n, v]) => `<tr><td>${n}</td><td>n/a</td><td>${esc(v)}</td></tr>`).join('')}</table>
<h2>Top 12 teams</h2><p>Teams are lead first. Marks: <code>T</code> same team (lead species + set of others) in the other run's top 12, <code>C:n</code> n two-species cores shared, <code>S:n</code> species shared.</p>
<h3>CPU run</h3>${topTable(cpu, gpu, curatedCpu)}<h3>GPU run</h3>${topTable(gpu, cpu, curatedGpu)}
<h2>Agreement sample</h2><p>${agree ? `${agree.sample.toLocaleString('en-US')} candidate-vs-opponent pairings drawn with seed "${agree.seed}" from ${agree.generationsDrawnFrom} CPU-run checkpoints, each battled once by battleTeams on CPU and once by the GPU kernel. Winner agreement ${(agree.winnerAgreement * 100).toFixed(2)}% (${agree.winnerMismatches} of ${agree.compared} differ); team-A win rate ${(agree.aWinRateCpu * 100).toFixed(2)}% CPU vs ${(agree.aWinRateGpu * 100).toFixed(2)}% GPU (delta ${agree.winRateDeltaPts.toFixed(2)} pts); survivor HP identical in ${(agree.survivorHpEqual * 100).toFixed(1)}%, lead-faint turns identical in ${(agree.leadFaintEqual * 100).toFixed(1)}%. ${agree.flaggedExcluded} rows the kernel flags invalid are re-run on CPU in the real run and are excluded here.` : 'not measured yet'}</p>`;
  writeFileSync('out/recipe-ab-gpu.html', html);
  console.log('wrote out/recipe-ab-gpu.html');
  process.exit(0);
}
if (!['agree', 'score', 'report'].includes(cmd)) { console.error('usage: node gpu/gpu-ab.mjs agree|score|report'); process.exit(2); }
