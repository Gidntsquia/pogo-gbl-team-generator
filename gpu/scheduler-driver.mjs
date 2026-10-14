// Inner-sim batching driver (path (a) of docs/gpu-viability.md): N CPU-side 3v3 battles run concurrently; every
// TrainingAI lookahead sim is held until all of them are blocked on their next answer, then the whole step goes to the
// GPU as ONE 1v1 batch (gpu/gpu/scheduler.py via the binary sidecar). Each battle lives in a worker thread ("fiber") that
// blocks in Atomics.wait while its sim is outstanding, so the battle's call stack is suspended without being replayed.
//
//   node gpu/scheduler-driver.mjs [--specs out/gpu/slice-specs.json] [--battles 160] [--fibers 8,16,32] [--threads 8]
//
// Prints, per fiber count: wall time, sims sent, mean batch, effective inner-sim rate, the S it reaches versus the CPU pool's
// inner-sim capacity on the same battles, and the 10.6 needed for 5x end to end (Amdahl with inner simulate = 86.2% of
// worker time, profile of out/evolve-gpu-profile). Also checks the winners against the exact CPU battles.
// Imports only src/engine/, src/scoring/ (plus gpu/ helpers). Interface of the batching piece: gpu/gpu/scheduler.py.
//
// Fidelity note: the 1v1 kernel returns rating/hp/energy/shields/buffs/turnsToKO/draws; fields the CPU memo also carries
// back into the outer battle (cooldown, damageWindow, faintSource, chargedMovesOnly, active form) are left as runScenario
// restored them, hasActed is set true. Winner agreement below measures what that costs.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { initEngine, buildPokemon } from '../src/engine/harness.js';
import { battleTeams, initTeamBattle } from '../src/engine/teamBattle.js';
import { applyGroupMoveset } from '../src/scoring/index.js';
import { makeDescriber } from './describe.mjs';

const D_N = 17, OUT_N = 18;
const INNER_SHARE = 0.862; // inner simulate() share of worker time (profile-inclusive.mjs on out/evolve-gpu-profile)
const S_NEEDED = 10.6;

if (!isMainThread) {
  // ------------------------------------------------------------ fiber: one battle at a time, blocking on its sims
  const { ctrlBuf } = workerData; // Int32 view: [0] flag, [1..18] result row
  const ctrl = new Int32Array(ctrlBuf);
  const ctx = await initEngine();
  initTeamBattle(ctx);
  const { describeMon, monTable } = makeDescriber(ctx);
  const vmMath = ctx.__teamBattle.vmMath;
  const cache = new Map();
  const sentMons = new Set();
  let reqs = 0, localHits = 0;
  const buildCache = new Map();
  const build = (m) => {
    const k = JSON.stringify(m);
    if (!buildCache.has(k)) {
      const p = buildPokemon(ctx, { speciesId: m.speciesId, ivs: m.ivs, shadow: !!m.shadow, bestBuddy: !!m.bestBuddy });
      if (m.fastMove) applyGroupMoveset(p, { fastMove: m.fastMove, chargedMoves: m.chargedMoves });
      buildCache.set(k, p);
    }
    return buildCache.get(k);
  };
  ctx.context.__gpuSim = (b) => {
    const [p0, p1] = b.getPokemon();
    const e = [describeMon(p0, true), describeMon(p1, true)];
    const key = JSON.stringify(e);
    let res = cache.get(key);
    if (res) localHits++;
    else {
      for (const x of e) if (!sentMons.has(x.mon)) { sentMons.add(x.mon); parentPort.postMessage({ type: 'mon', local: x.mon, row: monTable[x.mon] }); }
      const dyn = new Float64Array(2 * D_N);
      e.forEach((x, i) => {
        const o = i * D_N;
        dyn[o] = x.startHp; dyn[o + 1] = x.startEnergy; dyn[o + 2] = x.startCooldown; dyn[o + 3] = x.startingShields;
        dyn[o + 4] = x.startStatBuffs[0]; dyn[o + 5] = x.startStatBuffs[1]; dyn[o + 6] = x.nativeStatBuffs[0]; dyn[o + 7] = x.nativeStatBuffs[1];
        dyn[o + 8] = Number(x.priority); dyn[o + 9] = x.turnsToKO; dyn[o + 10] = Number(x.baitShields); dyn[o + 11] = Number(x.farmEnergy);
        dyn[o + 12] = Number(x.optimizeMoveTiming); dyn[o + 13] = x.statBuffs?.[0] ?? 0; dyn[o + 14] = x.statBuffs?.[1] ?? 0;
        dyn[o + 15] = x.startForm ?? 0; dyn[o + 16] = x.origForm ?? 0;
      });
      Atomics.store(ctrl, 0, 0);
      reqs++;
      parentPort.postMessage({ type: 'req', local: [e[0].mon, e[1].mon], dyn });
      Atomics.wait(ctrl, 0, 0); // suspended here until the batch answers
      res = Array.from(ctrl.subarray(1, 1 + OUT_N));
      if (cache.size >= 20000) cache.clear();
      cache.set(key, res);
    }
    for (let k = 0; k < res[15]; k++) vmMath.random();
    [p0, p1].forEach((p, i) => {
      p.hp = res[2 + i]; p.energy = res[4 + i]; p.shields = res[6 + i];
      p.statBuffs = [res[8 + 2 * i], res[9 + 2 * i]];
      p.turnsToKO = res[13 + i]; p.hasActed = true;
    });
    b.getBattleRatings = () => [res[0], 0];
    return [];
  };
  vm.runInContext(`(function () { const Orig = Battle; Battle = function () { const b = new Orig(); b.simulate = function () { return __gpuSim(b); }; return b; }; Battle.prototype = Orig.prototype; })()`, ctx.context);
  parentPort.on('message', (msg) => {
    if (msg.type !== 'run') return;
    const teamA = msg.spec.teamA.map(build), teamB = msg.spec.teamB.map(build);
    const r = battleTeams(ctx, { teamA, teamB, leadA: msg.spec.leadA, leadB: msg.spec.leadB, scenarioMemo: false });
    parentPort.postMessage({ type: 'done', id: msg.id, winner: r.winner, reqs, localHits });
    reqs = 0; localHits = 0;
  });
  parentPort.postMessage({ type: 'ready' });
} else {
  // ------------------------------------------------------------------------------------------------- main
  const { createExecutor } = await import('../src/engine/parallel.js');
  const { GpuSidecar } = await import('./client.mjs');
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
  const specsPath = opt('specs', 'out/gpu/slice-specs.json');
  const K = Number(opt('battles', 160));
  const fiberList = opt('fibers', '8,16,32').split(',').map(Number);
  const threads = Number(opt('threads', 8));
  const specs = JSON.parse(readFileSync(specsPath, 'utf8')).battles.slice(0, K).map((b) => ({ teamA: b.teamA, teamB: b.teamB, leadA: b.leadA, leadB: b.leadB }));
  const secs = (ms) => (ms / 1000).toFixed(1);

  const sidecar = await GpuSidecar.start(); // first: a GPU-less box exits 1 here with the sidecar's one-line reason

  // exact CPU reference: same battles on the normal pool (memo on)
  const ex = createExecutor({ threads });
  const dummy = { teamA: [{ speciesId: 'azumarill', ivs: { atk: 0, def: 15, hp: 15 } }, { speciesId: 'registeel', ivs: { atk: 0, def: 15, hp: 15 } }, { speciesId: 'altaria', ivs: { atk: 0, def: 15, hp: 15 } }], teamB: [{ speciesId: 'magikarp', ivs: { atk: 0, def: 15, hp: 15 } }, { speciesId: 'sunkern', ivs: { atk: 0, def: 15, hp: 15 } }, { speciesId: 'feebas', ivs: { atk: 0, def: 15, hp: 15 } }], leadA: 0, leadB: 0 };
  await ex.run(Array.from({ length: threads }, () => dummy));
  const s0 = (await ex.stats()).reduce((a, s) => ({ h: a.h + s.memoHits, m: a.m + s.memoMisses }), { h: 0, m: 0 });
  const tc = performance.now();
  const cpu = await ex.run(specs);
  const cpuMs = performance.now() - tc;
  const s1 = (await ex.stats()).reduce((a, s) => ({ h: a.h + s.memoHits, m: a.m + s.memoMisses }), { h: 0, m: 0 });
  await ex.close();
  const cpuMisses = s1.m - s0.m;
  const cpuSimRate = cpuMisses / (INNER_SHARE * cpuMs / 1000); // sims/s the pool could do if all of its sim time were spent on sims
  console.log(`CPU reference (${threads} threads, memo on): ${K} battles in ${secs(cpuMs)} s = ${(K / (cpuMs / 1000)).toFixed(2)} b/s; ${cpuMisses} memo-miss sims -> inner-sim capacity ${cpuSimRate.toFixed(0)} sims/s (${(INNER_SHARE * 100).toFixed(1)}% of time in simulate)`);

  const results = [];
  for (const N of fiberList) {
    const r = await runFibers(N);
    results.push(r);
  }
  await sidecar.close();
  mkdirSync('out/gpu', { recursive: true });
  writeFileSync('out/gpu/scheduler.json', JSON.stringify({ battles: K, cpuMs, cpuMisses, cpuSimRate, innerShare: INNER_SHARE, sNeeded: S_NEEDED, results }, null, 1));
  console.log('wrote out/gpu/scheduler.json');
  process.exit(0);

  async function runFibers(N) {
    const here = fileURLToPath(import.meta.url);
    const table = new Map(); // row JSON -> global id
    const rows = [];
    let sentRows = 0;
    const fibers = [];
    const t0 = performance.now();
    await Promise.all(Array.from({ length: N }, (_, i) => new Promise((res) => {
      const ctrlBuf = new SharedArrayBuffer(4 * (1 + OUT_N));
      const w = new Worker(here, { workerData: { ctrlBuf }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
      const f = { w, ctrl: new Int32Array(ctrlBuf), local: new Map(), busy: false, id: i };
      fibers.push(f);
      w.once('message', () => res());
    })));
    const bootMs = performance.now() - t0;
    const rss = process.memoryUsage().rss / 2 ** 20;
    let next = 0, running = 0, done = 0, flushing = false;
    const pending = [];
    const winners = new Array(K);
    let simsSent = 0, distinct = 0, batches = 0, kernelUs = 0, localHits = 0, maxBatch = 0;
    const t1 = performance.now();
    await new Promise((resolveAll) => {
      const assign = (f) => {
        if (next >= K) return;
        f.busy = true; running++;
        f.w.postMessage({ type: 'run', id: next, spec: specs[next] });
        next++;
      };
      const maybeFlush = async () => {
        if (flushing || !pending.length || pending.length < running) return;
        flushing = true;
        const batch = pending.splice(0);
        if (rows.length !== sentRows) { await sidecar.setStatic(rows); sentRows = rows.length; }
        const n = batch.length;
        const idx = new Int32Array(n * 2), dyn = new Float64Array(n * 2 * D_N);
        batch.forEach((q, i) => { idx[2 * i] = q.g[0]; idx[2 * i + 1] = q.g[1]; dyn.set(q.dyn, i * 2 * D_N); });
        distinct += new Set(batch.map((q, i) => `${q.g}|${Array.from(q.dyn)}`)).size;
        const r = await sidecar.batch1({ idx, dyn });
        batches++; simsSent += n; kernelUs += r.kernelUs; maxBatch = Math.max(maxBatch, n);
        batch.forEach((q, i) => {
          q.f.ctrl.set(r.out.subarray(i * r.cols, i * r.cols + OUT_N), 1);
          Atomics.store(q.f.ctrl, 0, 1);
          Atomics.notify(q.f.ctrl, 0);
        });
        flushing = false;
        maybeFlush();
      };
      for (const f of fibers) {
        f.w.on('message', (m) => {
          if (m.type === 'mon') {
            const key = JSON.stringify(m.row);
            if (!table.has(key)) { table.set(key, rows.length); rows.push(m.row); }
            f.local.set(m.local, table.get(key));
          } else if (m.type === 'req') {
            pending.push({ f, g: [f.local.get(m.local[0]), f.local.get(m.local[1])], dyn: m.dyn });
            maybeFlush();
          } else if (m.type === 'done') {
            winners[m.id] = m.winner; done++; running--; f.busy = false; localHits += m.localHits;
            if (next < K) assign(f);
            if (done === K) resolveAll();
            else maybeFlush();
          }
        });
        assign(f);
      }
    });
    const ms = performance.now() - t1;
    await Promise.all(fibers.map((f) => f.w.terminate()));
    const rate = simsSent / (ms / 1000);
    const S = rate / cpuSimRate;
    const agree = winners.filter((w, i) => w === cpu[i].winner).length;
    console.log(`fibers=${N}: ${K} battles in ${secs(ms)} s (boot ${secs(bootMs)} s, RSS ${rss.toFixed(0)} MB) = ${(K / (ms / 1000)).toFixed(2)} b/s; ${batches} steps, ${simsSent} sims sent (${distinct} distinct), mean batch ${(simsSent / batches).toFixed(1)}, max ${maxBatch}, local-cache hits ${localHits}`);
    console.log(`    effective inner-sim rate ${rate.toFixed(0)} sims/s -> S = ${S.toFixed(2)} vs ${S_NEEDED} needed (${S >= S_NEEDED ? 'reaches' : 'short of'} 5x); end-to-end vs CPU pool: x${(cpuMs / ms).toFixed(2)}; winner agreement with exact CPU battles ${agree}/${K} (${(100 * agree / K).toFixed(1)}%); kernel side ${(kernelUs / 1e6).toFixed(2)} s of ${secs(ms)} s`);
    return { fibers: N, ms, bootMs, rssMb: rss, battlesPerSecond: K / (ms / 1000), steps: batches, simsSent, distinct, meanBatch: simsSent / batches, maxBatch, localHits, simRate: rate, S, speedupVsCpu: cpuMs / ms, winnerAgreement: agree / K, kernelSeconds: kernelUs / 1e6 };
  }
}
