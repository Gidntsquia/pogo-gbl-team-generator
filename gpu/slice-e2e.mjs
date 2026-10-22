// Measured end-to-end slice: the first N battles of the profile run's gen 0 timed three ways on this box.
//
//   node gpu/dump-gen0-specs.mjs out/evolve-gpu-profile/evolve-gen0.json jaxon-gl-collection.csv out/gpu/slice-specs.json 5000 --slice
//   node gpu/slice-e2e.mjs [--specs out/gpu/slice-specs.json] [--n 5000] [--threads 8] [--gpu-share auto|0.0-1.0] [--out out/gpu]
//
//   (i)   CPU only      8 worker threads, battleTeams as the evolve pipeline runs them (scenario memo ON, cold pool)
//   (ii)  GPU only      describe + pack in node, binary batch over the sidecar, 3v3 CUDA kernel (float32)
//   (iii) overlapped    the GPU takes a share of the slice while the CPU workers run the rest at the same time;
//                       wall time = the later of the two. A second run re-balances the share from the first run's rates.
// Writes <out>/slice-<n>.json. Imports only src/engine/, src/scoring/ (plus the gpu/ helpers).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createExecutor } from '../src/engine/parallel.js';
import { initEngine, buildPokemon } from '../src/engine/harness.js';
import { initTeamBattle } from '../src/engine/teamBattle.js';
import { hashSeed } from '../src/engine/battle/virtualClock.js';
import { applyGroupMoveset } from '../src/scoring/index.js';
import { makeDescriber } from './describe.mjs';
import { GpuSidecar, packBattles } from './client.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const specsPath = opt('specs', 'out/gpu/slice-specs.json');
const N = Number(opt('n', 5000));
const threads = Number(opt('threads', 8));
const shareArg = opt('gpu-share', 'auto');
const outDir = opt('out', 'out/gpu');
const DIFFICULTY = 3; // evolve's default (config.difficulty null -> battleTeams default)

const log = (m) => console.log(m);
const secs = (ms) => (ms / 1000).toFixed(2);
const specs = JSON.parse(readFileSync(specsPath, 'utf8')).battles.slice(0, N).map((b) => ({ teamA: b.teamA, teamB: b.teamB, leadA: b.leadA, leadB: b.leadB }));
if (specs.length < N) log(`note: only ${specs.length} battles in ${specsPath}`);
const n = specs.length;
const tStart = performance.now();
const sidecar = await GpuSidecar.start(); // first, so a GPU-less box fails in seconds with the sidecar's one-line reason
const startMs = performance.now() - tStart;

// ---------------------------------------------------------------- CPU side
const DUMMY = (() => {
  const IVS = { atk: 0, def: 15, hp: 15 };
  const mk = (ids) => ids.map((speciesId) => ({ speciesId, ivs: IVS }));
  return { teamA: mk(['azumarill', 'registeel', 'altaria']), teamB: mk(['magikarp', 'sunkern', 'feebas']), leadA: 0, leadB: 0 };
})();

async function freshPool() {
  const ex = createExecutor({ threads });
  await ex.run(Array.from({ length: threads }, () => DUMMY)); // boot every worker (gamemaster parse) before the clock starts
  return ex;
}
const sumMemo = (stats) => stats.reduce((a, s) => ({ hits: a.hits + s.memoHits, misses: a.misses + s.memoMisses }), { hits: 0, misses: 0 });

async function cpuRun(list) {
  const ex = await freshPool();
  const before = sumMemo(await ex.stats());
  const t = performance.now();
  const results = await ex.run(list);
  const ms = performance.now() - t;
  const after = sumMemo(await ex.stats());
  await ex.close();
  return { results, ms, hits: after.hits - before.hits, misses: after.misses - before.misses };
}

// ---------------------------------------------------------------- GPU side
const ctx = await initEngine();
initTeamBattle(ctx);
const { describeMon, monTable } = makeDescriber(ctx);
const descCache = new Map();
function descFor(m) {
  const key = JSON.stringify(m);
  let d = descCache.get(key);
  if (!d) {
    const p = buildPokemon(ctx, { speciesId: m.speciesId, ivs: m.ivs, shadow: !!m.shadow, bestBuddy: !!m.bestBuddy });
    if (m.fastMove) applyGroupMoveset(p, { fastMove: m.fastMove, chargedMoves: m.chargedMoves });
    d = describeMon(p, false);
    d.builtId = p.speciesId; // battleTeams hashes the BUILT id ("x_shadow" for shadows) into its seed
    descCache.set(key, d);
  }
  return d;
}
const seedOf = (s) => hashSeed(s.teamA.map((m) => descFor(m).builtId).join(',') + '|' + s.teamB.map((m) => descFor(m).builtId).join(',') + `|${s.leadA}:${s.leadB}:${DIFFICULTY}`);

const WIN = ['a', 'b', 'tie'];
/** Describe + pack + send one list of specs, return winners and the time split. */
async function gpuRun(list, sidecar) {
  const t0 = performance.now();
  const battles = list.map((s) => ({ teamA: s.teamA.map(descFor), teamB: s.teamB.map(descFor), leadA: s.leadA, leadB: s.leadB, seed: seedOf(s) }));
  const packed = packBattles(battles);
  const t1 = performance.now();
  await sidecar.setStatic(monTable);
  const r = await sidecar.batch3(packed);
  const t2 = performance.now();
  const winners = Array.from({ length: list.length }, (_, i) => WIN[r.out[i * r.cols]]);
  return { winners, ms: t2 - t0, packMs: t1 - t0, sendKernelMs: t2 - t1, kernelMs: r.kernelUs / 1000, pieces: r.pieces, out: r.out, cols: r.cols };
}

// ---------------------------------------------------------------- run
log(`slice: ${n} battles from ${specsPath}, ${threads} CPU worker threads, difficulty ${DIFFICULTY}`);

log('(i) CPU only ...');
const cpu = await cpuRun(specs);
const cpuBps = n / (cpu.ms / 1000);
const hitRate = cpu.hits / Math.max(1, cpu.hits + cpu.misses);
log(`(i) CPU only: ${secs(cpu.ms)} s -> ${cpuBps.toFixed(2)} battles/s; scenario memo hit rate ${(100 * hitRate).toFixed(1)}% (${cpu.hits} hits / ${cpu.misses} misses)`);
const seedOk = cpu.results.every((r, i) => r.summary.seed === seedOf(specs[i]));
log(`    seed derivation matches battleTeams for all ${n} battles: ${seedOk}`);
const cpuWinners = cpu.results.map((r) => r.winner);

log('(ii) GPU only ...');
// warm-up: JIT/cache-load the kernel on 64 battles (not timed), then the timed full slice
const warm = await gpuRun(specs.slice(0, 64), sidecar);
log(`    sidecar start ${secs(startMs)} s + warm-up batch of 64 ${secs(warm.ms)} s (excluded from the timing)`);
const gpu = await gpuRun(specs, sidecar);
const gpuBps = n / (gpu.ms / 1000);
const agree = gpu.winners.filter((w, i) => w === cpuWinners[i]).length;
const aWinCpu = cpuWinners.filter((w) => w === 'a').length / n;
const aWinGpu = gpu.winners.filter((w) => w === 'a').length / n;
log(`(ii) GPU only: ${secs(gpu.ms)} s -> ${gpuBps.toFixed(1)} battles/s (describe+pack ${secs(gpu.packMs)} s, send+kernel+receive ${secs(gpu.sendKernelMs)} s, kernel side ${secs(gpu.kernelMs)} s, ${gpu.pieces} piece(s))`);
log(`    winner agreement with the CPU run: ${agree}/${n} = ${(100 * agree / n).toFixed(2)}%; team-A win rate CPU ${(100 * aWinCpu).toFixed(2)}% vs GPU ${(100 * aWinGpu).toFixed(2)}%`);

async function overlapped(share) {
  const k = Math.max(0, Math.min(n, Math.round(n * share)));
  const gpuList = specs.slice(n - k), cpuList = specs.slice(0, n - k);
  const ex = await freshPool();
  const t = performance.now();
  let tCpu = 0, tGpu = 0;
  const [cr, gr] = await Promise.all([
    cpuList.length ? ex.run(cpuList).then((r) => { tCpu = performance.now() - t; return r; }) : Promise.resolve([]),
    k ? gpuRun(gpuList, sidecar).then((r) => { tGpu = performance.now() - t; return r; }) : Promise.resolve(null),
  ]);
  const wall = Math.max(tCpu, tGpu);
  await ex.close();
  const mixed = [...cr.map((r) => r.winner), ...(gr ? gr.winners : [])];
  return { share, gpuBattles: k, cpuBattles: n - k, wallMs: wall, cpuMs: tCpu, gpuMs: tGpu, bps: n / (wall / 1000), speedup: cpu.ms / wall,
    finishedFirst: tGpu < tCpu ? 'gpu' : 'cpu', cpuRate: cpuList.length / (tCpu / 1000), gpuRate: k / (tGpu / 1000), mixedAWin: mixed.filter((w) => w === 'a').length / n };
}

log('(iii) overlapped CPU + GPU ...');
const runs = [];
let share = shareArg === 'auto' ? gpuBps / (gpuBps + cpuBps) : Number(shareArg);
runs.push(await overlapped(share));
const show = (r, tag) => log(`(iii${tag}) GPU ${r.gpuBattles} + CPU ${r.cpuBattles} battles (GPU share ${(100 * r.share).toFixed(1)}%): wall ${secs(r.wallMs)} s -> ${r.bps.toFixed(2)} b/s; CPU side done ${secs(r.cpuMs)} s, GPU side done ${secs(r.gpuMs)} s (${r.finishedFirst} first); speedup vs (i): x${r.speedup.toFixed(2)}`);
show(runs[0], 'a');
if (shareArg === 'auto') {
  const r0 = runs[0];
  if (Math.abs(r0.cpuMs - r0.gpuMs) / r0.wallMs > 0.1 && r0.gpuBattles > 0 && r0.cpuBattles > 0) {
    // re-balance: share that makes both sides finish together at the rates this run observed (CPU side slows while the GPU pipeline competes for cores)
    const s2 = r0.gpuRate / (r0.gpuRate + r0.cpuRate);
    runs.push(await overlapped(s2));
    show(runs[1], 'b');
  }
}
const best = runs.reduce((a, b) => (b.wallMs < a.wallMs ? b : a));
await sidecar.close();

const result = {
  generatedAt: new Date().toISOString(), specs: specsPath, battles: n, threads, difficulty: DIFFICULTY, seedDerivationMatches: seedOk,
  cpuOnly: { wallSeconds: cpu.ms / 1000, battlesPerSecond: cpuBps, memoHits: cpu.hits, memoMisses: cpu.misses, memoHitRate: hitRate },
  gpuOnly: { wallSeconds: gpu.ms / 1000, battlesPerSecond: gpuBps, describePackSeconds: gpu.packMs / 1000, sendKernelReceiveSeconds: gpu.sendKernelMs / 1000,
    kernelSideSeconds: gpu.kernelMs / 1000, pieces: gpu.pieces, winnerAgreement: agree / n, aWinRateCpu: aWinCpu, aWinRateGpu: aWinGpu, sidecarStartSeconds: startMs / 1000 },
  overlapped: { runs, best },
  speedup: best.speedup,
};
mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `slice-${n}.json`);
writeFileSync(file, JSON.stringify(result, null, 1));
log(`\nmeasured slice speedup (iii best / i): x${best.speedup.toFixed(2)}  (${secs(cpu.ms)} s -> ${secs(best.wallMs)} s for ${n} battles)\nwrote ${file}`);
process.exit(0);
