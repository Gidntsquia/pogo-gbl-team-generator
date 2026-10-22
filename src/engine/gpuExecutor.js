// GPU + CPU battle executor for `evolve --gpu`. Same `run(specs)` / `stats()` / `close()` shape as
// createExecutor (src/engine/parallel.js), so evaluateTeamsInOrder needs no other change.
//
// Each run(specs) call splits its specs by a deterministic rule (a function of the index and the CPU share only,
// never of timing): about `cpuShare` of them go to the wrapped CPU executor, the rest go to the CUDA sidecar as
// packed binary batches, and both run at the same time. A GPU row the kernel flags invalid (lookahead pool or
// stack overflow, ...) is re-run on the CPU executor afterwards. GPU results are mapped to the fields the memo
// keeps (`trimBattleResult` in src/evolve/cache.js: winner, survivorsHp, summary.leadFaintTurnA/B).
// Any sidecar failure throws a UserError `gpu: <reason>` flagged `gpuFatal`, which evaluate.js does not swallow.
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildPokemon } from './harness.js';
import { hashSeed } from './battle/virtualClock.js';
import { applyGroupMoveset } from '../scoring/index.js';
import { UserError } from '../util/userError.js';
import { makeDescriber } from '../../gpu/describe.mjs';
import { GpuSidecar, GpuStartError, packBattles, packIsland } from '../../gpu/client.mjs';

/**
 * Default `--gpu-cpu-share`: 0, the GPU runs every battle and the CPU workers only re-run flagged rows (plans round 6, R5).
 * The `auto` share below (sized from GPU_RATE_MODEL) is kept but disabled: pass `--gpu-cpu-share auto` to use it.
 */
export const DEFAULT_GPU_CPU_SHARE = 0;
/**
 * Measured rates the `auto` share balances (plans/PLAN.md round 4, R8; `node gpu/fit-share.mjs --gpu out/evolve-gpu2-p1b
 * --cpu out/evolve-gpu2-p1s --cpu out/evolve-gpu2-p1c`, 5-gen runs of the recipe-ab command, docs/gpu-viability.md
 * "Round 4"). A GPU step takes 3.9-11 s whatever its size (3,000-18,000 battles; the slowest battles set it, r2 0.00
 * against the count), so moving battles to the CPU never shortens it: the model has no per-battle GPU term and sizes
 * the CPU share to finish inside the shortest measured GPU step (3.87 s) at 0.05 s + battles / 24.9 b/s, the rate the
 * 8 workers reach beside the GPU, i.e. 95 battles a step.
 */
export const GPU_RATE_MODEL = { gpuFixedS: 0.58, gpuPerBattleS: 0, cpuFixedS: 0.46, cpuBps: 21.3 }; // round 12 refit for lean 6 (8-gen runs, fit data gpu/gpu/r12/fitdata): shortest GPU step 0.58 s
/**
 * EXPERIMENTAL (round 12, off by default): POGO_GPU_CPU_BELOW=N runs every step with fewer than N battles (the small halving
 * rounds) entirely on the CPU workers instead of a GPU launch. Results are CPU float, so they can differ from the GPU's in
 * ~0.2% of winners (the agreement gate applies).
 */
export const GPU_CPU_BELOW = Math.max(0, Number.parseInt(process.env.POGO_GPU_CPU_BELOW ?? '0', 10) || 0);
/**
 * EXPERIMENTAL (round 12 R11a, off by default): POGO_GPU_RERUN=after holds flagged rows until every launch of the step has
 * returned and only then re-runs them on the CPU workers (the serial version). Default re-runs each launch's flagged rows
 * while the next launch is in flight. Same results either way; it exists to A/B the overlap.
 */
export const GPU_RERUN_AFTER = process.env.POGO_GPU_RERUN === 'after';
/** Battles per sidecar message (the sidecar also splits on its own if GPU memory runs out). */
export const GPU_BATCH_LIMIT = 36000;
/**
 * EXPERIMENTAL (plans round 6, R2), off by default: POGO_GPU_STREAMS=N cuts each step's GPU share into N launches that are in
 * flight on the sidecar together (tagged BATCH3T, one CUDA stream each), so one launch's tail overlaps the others' work.
 * The split is a function of the step size only; rows are reduced in index order, so results do not depend on timing.
 */
export const GPU_STREAMS = Math.max(1, Number.parseInt(process.env.POGO_GPU_STREAMS ?? '1', 10) || 1);
const INVALID = 0x6e; // POOL_OVERFLOW|STACK_OVERFLOW|MOVES_OVERFLOW|GUARD|BADSTATE (see gpu/gpu/verify_3v3.py)
const WINNER = ['a', 'b', 'tie'];
const DEFAULT_DIFFICULTY = 3;

/**
 * How many of a step's `n` specs go to the CPU executor at share `share`. Deterministic in (n, share).
 * @param {number} n
 * @param {number} share
 * @returns {number}
 */
export function cpuCount(n, share) {
  return Math.min(n, Math.floor(n * share));
}

/**
 * CPU battles of an `n`-battle step under the `auto` share: the count that makes the CPU share and the GPU side
 * finish together under `model`, i.e. cpuFixedS + c / cpuBps = gpuFixedS + gpuPerBattleS * (n - c).
 * Deterministic in (n, model); never more than half the step.
 * @param {number} n
 * @param {{gpuFixedS:number, gpuPerBattleS:number, cpuFixedS:number, cpuBps:number}} [model]
 * @returns {number}
 */
export function balancedCpuCount(n, model = GPU_RATE_MODEL) {
  if (!(model.cpuBps > 0) || n <= 0) return 0;
  const c = (model.gpuFixedS - model.cpuFixedS + model.gpuPerBattleS * n) / (model.gpuPerBattleS + 1 / model.cpuBps);
  return Math.max(0, Math.min(Math.floor(n / 2), Math.floor(c)));
}

/** CPU count of an `n`-battle step for a `--gpu-cpu-share` value (a fraction, or 'auto'). */
export function cpuCountFor(n, share) {
  return share === 'auto' ? balancedCpuCount(n) : cpuCount(n, share);
}

/** True when spec `i` of `n` is one of the `nCpu` CPU slots (spread evenly; exact integer arithmetic). */
export function isCpuSlot(i, nCpu, n) {
  return Math.floor(((i + 1) * nCpu) / n) > Math.floor((i * nCpu) / n);
}

/** One kernel output row -> the memo-shaped result. */
export function rowToResult(out, o) {
  const lfA = out[o + 18], lfB = out[o + 19];
  return {
    winner: WINNER[out[o]],
    survivorsHp: { a: out[o + 15], b: out[o + 16], aPerMon: [out[o + 3], out[o + 4], out[o + 5]], bPerMon: [out[o + 6], out[o + 7], out[o + 8]] },
    summary: { leadFaintTurnA: lfA < 0 ? null : lfA, leadFaintTurnB: lfB < 0 ? null : lfB },
  };
}

const monKey = (m) => `${m.speciesId}|${m.ivs.atk},${m.ivs.def},${m.ivs.hp}|${m.shadow ? 1 : 0}|${m.bestBuddy ? 1 : 0}|${m.fastMove ? `${m.fastMove}/${(m.chargedMoves || []).join(',')}` : ''}`;

/**
 * @param {{ctx: object, cpuExecutor: object, cpuShare?: number, log?: (m:string)=>void, sidecar?: object, profile?: object, streams?: number}} opts
 *   `profile` (optional): src/evolve/gpuProfile.js sink; each run() adds one timed step record.
 *   `sidecar` (tests): object with setStatic(table) and batch3(packed) -> {out, cols, kernelUs, pieces} (and batch3Async, same shape).
 *   `streams`: launches in flight per step (default GPU_STREAMS, i.e. POGO_GPU_STREAMS; 1 = one launch at a time).
 */
export async function createGpuExecutor({ ctx, cpuExecutor, cpuShare = DEFAULT_GPU_CPU_SHARE, log = () => {}, sidecar = null, profile = null, streams = GPU_STREAMS }) {
  let memoHitsNext = 0; // memo hits of the step about to run (set by evaluateTeamsInOrder via noteMemoHits)
  if (cpuShare !== 'auto' && !(cpuShare >= 0 && cpuShare <= 1)) throw new UserError(`--gpu-cpu-share must be in [0,1] or auto, got ${cpuShare}`, 'omit it for the measured default (auto)');
  let sc = sidecar;
  if (!sc) {
    try {
      sc = await GpuSidecar.start(); // a box without CUDA exits 1 here after the sidecar printed its own `gpu:` line
    } catch (err) {
      if (err instanceof GpuStartError) { err.gpuStart = true; throw err; } // run.js falls back to the CPU
      throw gpuError(err);
    }
  }
  const { describeMon, monTable } = makeDescriber(ctx);
  const descCache = new Map();
  function descFor(m) {
    const key = monKey(m);
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
  let sentStatic = -1;
  const totals = { gpuBattles: 0, cpuBattles: 0, flagged: 0, gpuMs: 0, cpuMs: 0, steps: 0 };
  const dumpDir = process.env.POGO_GPU_DUMP || null; // profiling: write every launch's BATCH3 body for gpu/gpu/profile_kernel.py
  let dumpK = 0;

  const pack = (part, dump = true) => {
    const battles = part.map((s) => {
      const diff = s.difficulty ?? DEFAULT_DIFFICULTY;
      if (diff !== DEFAULT_DIFFICULTY) throw new UserError(`gpu: kernel supports difficulty ${DEFAULT_DIFFICULTY} only, got ${diff}`, 'run without --gpu', 1);
      const A = s.teamA.map(descFor), B = s.teamB.map(descFor);
      return { teamA: A, teamB: B, leadA: s.leadA, leadB: s.leadB, seed: hashSeed(A.map((d) => d.builtId).join(',') + '|' + B.map((d) => d.builtId).join(',') + `|${s.leadA}:${s.leadB}:${diff}`) };
    });
    const packed = packBattles(battles);
    if (dumpDir && dump) dumpBatch(dumpDir, dumpK++, packed, monTable);
    return packed;
  };
  /**
   * GPU share of one step, cut into launches of at most GPU_BATCH_LIMIT. Rows a launch flags invalid go to the CPU
   * executor as soon as that launch returns (`rerun(specIdx)` -> promise), so they run while the next launch does.
   */
  async function runGpu(specs, rerun) {
    const results = new Array(specs.length);
    const flaggedIdx = [];
    const reruns = [];
    const launches = [];
    let mapMs = 0;
    const t0 = performance.now();
    const take = (lo, part, r, rec) => {
      const tm = performance.now();
      const mine = [];
      part.forEach((_, i) => {
        if (r.out[i * r.cols + 10] & INVALID) mine.push(lo + i);
        else results[lo + i] = { ok: true, value: rowToResult(r.out, i * r.cols), viaGpu: true };
      });
      if (mine.length) { flaggedIdx.push(...mine); reruns.push(rerun(mine)); }
      const timing = kernelTiming(r.out, r.cols, part.length);
      mapMs += performance.now() - tm;
      launches.push({ n: part.length, flagged: mine.length, ...rec, kernelUs: r.kernelUs, pieces: r.pieces, ...timing });
    };
    const tst = performance.now();
    for (const s of specs) { s.teamA.forEach(descFor); s.teamB.forEach(descFor); } // every mon of the step in the table first
    if (specs.length && monTable.length !== sentStatic) { await sc.setStatic(monTable); sentStatic = monTable.length; }
    const staticMs = performance.now() - tst;
    if (streams > 1 && sc.batch3Async) {
      // EXPERIMENTAL (round 6, R2): the step cut into GPU_STREAMS launches in flight together; results reduced by index
      const size = Math.min(GPU_BATCH_LIMIT, Math.max(1, Math.ceil(specs.length / streams)));
      const pending = [];
      for (let lo = 0; lo < specs.length; lo += size) {
        const tp = performance.now();
        const part = specs.slice(lo, lo + size);
        const packed = pack(part);
        const packMs = performance.now() - tp;
        const ts = performance.now();
        pending.push(sc.batch3Async(packed).then((r) => ({ lo, part, r, rec: { packMs, staticMs: lo ? 0 : staticMs, sidecarMs: performance.now() - ts, stream: pending.length } })));
      }
      for (const { lo, part, r, rec } of (await Promise.all(pending)).sort((x, y) => x.lo - y.lo)) take(lo, part, r, rec);
      return { results, flaggedIdx, reruns, launches, mapMs, ms: performance.now() - t0 };
    }
    for (let lo = 0; lo < specs.length; lo += GPU_BATCH_LIMIT) {
      const tp = performance.now();
      const part = specs.slice(lo, lo + GPU_BATCH_LIMIT);
      const packed = pack(part);
      const packMs = performance.now() - tp;
      const ts = performance.now();
      const r = await sc.batch3(packed);
      take(lo, part, r, { packMs, staticMs: lo ? 0 : staticMs, sidecarMs: performance.now() - ts });
    }
    return { results, flaggedIdx, reruns, launches, mapMs, ms: performance.now() - t0 };
  }

  const info = { share: cpuShare };
  return {
    info,
    /** @returns {Promise<Array<{ok:boolean, value?:object, error?:object}>>} slots in spec order. */
    noteMemoHits(n) { memoHitsNext = n; },
    /** evaluate.js plan/accumulate timings (profile only). */
    noteEval(rec) { profile?.noteEval(rec); },
    async run(specs) {
      const memo = memoHitsNext; memoHitsNext = 0;
      const t0 = performance.now();
      const gpuI = [], cpuI = [];
      const nCpu = specs.length < GPU_CPU_BELOW ? specs.length : cpuCountFor(specs.length, cpuShare);
      specs.forEach((_, i) => (isCpuSlot(i, nCpu, specs.length) ? cpuI : gpuI).push(i));
      let mapMs = performance.now() - t0;
      let cpuDone = t0;
      const cpuP = cpuI.length ? cpuExecutor.run(cpuI.map((i) => specs[i])).then((r) => { cpuDone = performance.now(); return r; }) : Promise.resolve([]);
      // flagged rows of a launch: queued on the CPU executor right away (behind the CPU share), awaited at the end
      let flaggedDone = t0;
      const rerunNow = (ks) => cpuExecutor.run(ks.map((k) => specs[gpuI[k]])).then((r) => { flaggedDone = performance.now(); return { ks, r }; });
      const held = [];
      const rerun = GPU_RERUN_AFTER ? (ks) => new Promise((res, rej) => held.push({ ks, res, rej })) : rerunNow;
      let g;
      try {
        g = gpuI.length ? await runGpu(gpuI.map((i) => specs[i]), rerun) : { results: [], flaggedIdx: [], reruns: [], launches: [], mapMs: 0, ms: 0 };
      } catch (err) {
        cpuP.catch(() => {});
        throw gpuError(err);
      }
      const gpuDone = performance.now();
      for (const h of held) rerunNow(h.ks).then(h.res, h.rej);
      const cpuSlots = await cpuP;
      const cpuShareDone = performance.now();
      const reruns = await Promise.all(g.reruns);
      const allDone = performance.now();
      const tm = performance.now();
      const slots = new Array(specs.length);
      cpuI.forEach((i, k) => { slots[i] = cpuSlots[k]; });
      gpuI.forEach((i, k) => { if (g.results[k]) slots[i] = g.results[k]; });
      for (const { ks, r } of reruns) ks.forEach((k, j) => { slots[gpuI[k]] = r[j]; });
      const nRedo = g.flaggedIdx.length;
      mapMs += g.mapMs + (performance.now() - tm);
      const wallMs = performance.now() - t0;
      const cpuMs = (cpuI.length ? cpuDone - t0 : 0) + (nRedo ? Math.max(0, flaggedDone - Math.max(gpuDone, t0)) : 0);
      totals.steps += 1; totals.gpuBattles += gpuI.length - nRedo; totals.cpuBattles += cpuI.length + nRedo;
      totals.flagged += nRedo; totals.gpuMs += g.ms; totals.cpuMs += cpuMs;
      if (profile) {
        const L = g.launches;
        const sumL = (f) => L.reduce((acc, l) => acc + f(l), 0) / 1000;
        // GPU path = pack + static + sidecar(kernel span + transport) + map, all measured; after it: waits on the CPU side
        const buckets = {
          plan: 0, pack: sumL((l) => l.packMs), transport: sumL((l) => l.staticMs + l.sidecarMs - l.spanMs),
          kernel: sumL((l) => l.bodyMs), tail: sumL((l) => l.tailMs),
          waitCpu: Math.max(0, cpuShareDone - gpuDone) / 1000, flagged: Math.max(0, allDone - Math.max(gpuDone, cpuShareDone)) / 1000,
          map: mapMs / 1000, accumulate: 0,
        };
        profile.step({
          n: specs.length, memoHits: memo, gpu: gpuI.length - nRedo, cpu: cpuI.length, flaggedRows: nRedo, share: cpuShare, cpuCount: cpuI.length,
          cpuShareS: cpuI.length ? (cpuDone - t0) / 1000 : 0, gpuPathS: (gpuDone - t0) / 1000,
          cpuIdleS: Math.max(0, gpuDone - (cpuI.length ? cpuDone : t0)) / 1000, wall: wallMs / 1000, buckets, launches: L,
        });
      }
      log(`evolve: gpu step -- ${memo} memo hits, ${gpuI.length - nRedo} battles on GPU in ${(g.ms / 1000).toFixed(1)}s, ${cpuI.length + nRedo} on CPU in ${(cpuMs / 1000).toFixed(1)}s` +
        `${nRedo ? ` (${nRedo} GPU rows flagged invalid, re-run on CPU)` : ''}, share ${cpuShare} (${cpuI.length} CPU), wall ${(wallMs / 1000).toFixed(1)}s`);
      return slots;
    },
    /**
     * EXPERIMENTAL (plans round 7 R7, POGO_GPU_ISLAND=on): every halving round of one generation step in ONE kernel launch
     * (gpu/gpu/island.py). Battle id = (c * nO + o) * 2 + seat; seat 0 = candidate c as team A against opponent o.
     * Rows the kernel flags invalid are re-run on the CPU executor. Logs one `evolve: gpu island step -- ...` line.
     * @param {{cand: object[][], opp: object[][], candLead: number, oppLeads: number[], difficulty?: number, known: Int32Array,
     *   canon: Int32Array, order: number[], sizes: number[], keep: number, islStart: number[], members: number[]}} job
     * @returns {Promise<{results: Map<number, object>, status: Int32Array, icut: Int32Array, info: object}>}
     */
    async runIsland(job) {
      const t0 = performance.now();
      const { cand, opp, candLead, oppLeads, known, canon, order, sizes, keep, islStart, members } = job;
      const diff = job.difficulty ?? DEFAULT_DIFFICULTY;
      if (diff !== DEFAULT_DIFFICULTY) throw new UserError(`gpu: kernel supports difficulty ${DEFAULT_DIFFICULTY} only, got ${diff}`, 'run without --gpu', 1);
      const nC = cand.length, nO = opp.length, nB = nC * nO * 2;
      const leadFirst = (team, lead) => [lead, ...[0, 1, 2].filter((j) => j !== lead)].map((j) => team[j]);
      const cD = cand.map((t) => t.map(descFor)), oD = opp.map((t) => t.map(descFor));
      if (monTable.length !== sentStatic) { await sc.setStatic(monTable); sentStatic = monTable.length; }
      const ids = (D) => D.map((d) => d.builtId).join(',');
      const cIds = cD.map(ids), oIds = oD.map(ids);
      const seeds = new Uint32Array(nB);
      for (let c = 0; c < nC; c++) {
        for (let o = 0; o < nO; o++) {
          const b = (c * nO + o) * 2;
          if (canon[b] === b && !known[b]) seeds[b] = hashSeed(`${cIds[c]}|${oIds[o]}|${candLead}:${oppLeads[o]}:${diff}`) >>> 0;
          if (canon[b + 1] === b + 1 && !known[b + 1]) seeds[b + 1] = hashSeed(`${oIds[o]}|${cIds[c]}|${oppLeads[o]}:${candLead}:${diff}`) >>> 0;
        }
      }
      const teams = [...cD.map((t) => leadFirst(t, candLead)), ...oD.map((t, o) => leadFirst(t, oppLeads[o]))];
      const body = packIsland({ teams, nC, nO, rounds: sizes.length, keep, seeds, canon, known, order, sizes, islStart, members });
      const packMs = performance.now() - t0;
      const ts = performance.now();
      let r;
      try { r = await sc.island(body); } catch (err) { throw gpuError(err); }
      const sidecarMs = performance.now() - ts;
      const w = r.words;
      const [G, spanUs, nRan, tasks] = w.subarray(0, 4);
      const status = w.slice(4, 4 + nB), icut = w.slice(4 + nB, 4 + nB + nC);
      const rows = w.subarray(4 + nB + nC);
      const cols = rows.length / Math.max(1, nRan);
      const results = new Map();
      const flagged = [];
      let k = 0;
      for (let b = 0; b < nB; b++) {
        if (status[b] !== 2) continue;
        const o = k++ * cols;
        if (rows[o + 10] & INVALID) flagged.push(b);
        else results.set(b, rowToResult(rows, o));
      }
      const specOf = (b) => {
        const c = Math.floor(b / 2 / nO), o = (b >> 1) % nO;
        return b & 1
          ? { teamA: opp[o], teamB: cand[c], leadA: oppLeads[o], leadB: candLead, difficulty: diff }
          : { teamA: cand[c], teamB: opp[o], leadA: candLead, leadB: oppLeads[o], difficulty: diff };
      };
      let cpuMs = 0;
      if (flagged.length) {
        const tc = performance.now();
        const slots = await cpuExecutor.run(flagged.map(specOf));
        slots.forEach((slot, i) => { if (slot.ok) results.set(flagged[i], slot.value); });
        cpuMs = performance.now() - tc;
      }
      const memo = status.reduce((a, v) => a + (v === 3 ? 1 : 0), 0);
      const dups = status.reduce((a, v) => a + (v === 4 ? 1 : 0), 0);
      const wallMs = performance.now() - t0;
      totals.steps += 1; totals.gpuBattles += nRan - flagged.length; totals.cpuBattles += flagged.length;
      totals.flagged += flagged.length; totals.gpuMs += packMs + sidecarMs; totals.cpuMs += cpuMs;
      const info = { width: G, spanS: spanUs / 1e6, ran: nRan, tasks, memo, dups, flagged: flagged.length, islands: islStart.length - 1, rounds: sizes.length, wallS: wallMs / 1000 };
      if (profile) {
        profile.step({
          n: nRan, memoHits: memo, gpu: nRan - flagged.length, cpu: 0, flaggedRows: flagged.length, share: 0, cpuCount: 0, cpuShareS: 0,
          gpuPathS: (packMs + sidecarMs) / 1000, cpuIdleS: (packMs + sidecarMs) / 1000, wall: wallMs / 1000, island: info,
          buckets: { plan: 0, pack: packMs / 1000, transport: Math.max(0, sidecarMs / 1000 - spanUs / 1e6), kernel: spanUs / 1e6, tail: 0, waitCpu: 0, flagged: cpuMs / 1000, map: 0, accumulate: 0 },
          launches: [{ n: nRan, flagged: flagged.length, packMs, staticMs: 0, sidecarMs, kernelUs: r.kernelUs, pieces: 1, spanMs: spanUs / 1000, bodyMs: spanUs / 1000, tailMs: 0, width: G, island: true }],
        });
      }
      log(`evolve: gpu island step -- 1 launch, ${info.islands} islands x ${info.rounds} rounds, ${tasks} pairings planned, ${memo} memo hits, ` +
        `${dups} duplicate keys, ${nRan - flagged.length} battles on GPU (G=${G}) in ${(sidecarMs / 1000).toFixed(1)}s (kernel ${(spanUs / 1e6).toFixed(1)}s), ` +
        `${flagged.length} on CPU${flagged.length ? ` (GPU rows flagged invalid, re-run) in ${(cpuMs / 1000).toFixed(1)}s` : ''}, wall ${(wallMs / 1000).toFixed(1)}s`);
      return { results, status, icut, info };
    },
    totals: () => ({ ...totals }),
    stats: () => cpuExecutor.stats(),
    async close() {
      const stats = await cpuExecutor.close();
      log(`evolve: gpu totals -- ${totals.gpuBattles} battles on GPU (${(totals.gpuMs / 1000).toFixed(0)}s), ${totals.cpuBattles} on CPU (${(totals.cpuMs / 1000).toFixed(0)}s), ${totals.flagged} flagged re-runs, ${totals.steps} steps`);
      try { await sc.close?.(); } catch { /* already gone */ }
      return stats;
    },
  };
}

/**
 * Kernel timing of one launch from the per-battle %globaltimer stamps (out cols 20..23): span (first start to last
 * end), body (span until half the battles have finished), tail (the rest), and the longest battle's
 * duration / turns / inner sims. All ms. Rows without stamps (stub sidecar) give zeros.
 */
export function kernelTiming(out, cols, n) {
  if (!n || cols < 24) return { spanMs: 0, bodyMs: 0, tailMs: 0, maxBattleMs: 0, p50BattleMs: 0, longest: null };
  const hi0 = out[21];
  const rel = (lo, hi) => (hi - hi0) * 4294967296 + (lo >>> 0);
  const starts = new Float64Array(n), ends = new Float64Array(n), durs = new Float64Array(n);
  let s0 = Infinity, e1 = -Infinity, longest = 0;
  for (let i = 0; i < n; i++) {
    const o = i * cols;
    starts[i] = rel(out[o + 20], out[o + 21]); ends[i] = rel(out[o + 22], out[o + 23]); durs[i] = ends[i] - starts[i];
    if (starts[i] < s0) s0 = starts[i];
    if (ends[i] > e1) e1 = ends[i];
    if (durs[i] > durs[longest]) longest = i;
  }
  if (!(e1 > s0)) return { spanMs: 0, bodyMs: 0, tailMs: 0, maxBattleMs: 0, p50BattleMs: 0, longest: null };
  const sortedEnds = Float64Array.from(ends).sort();
  const half = sortedEnds[Math.floor((n - 1) / 2)];
  const sortedDur = Float64Array.from(durs).sort();
  const o = longest * cols;
  return {
    spanMs: (e1 - s0) / 1e6, bodyMs: (half - s0) / 1e6, tailMs: (e1 - half) / 1e6,
    maxBattleMs: durs[longest] / 1e6, p50BattleMs: sortedDur[Math.floor((n - 1) / 2)] / 1e6,
    longest: { turns: out[o + 9], innerSims: out[o + 11], poolMax: out[o + 13] },
  };
}

/** POGO_GPU_DUMP: `<dir>/batch-<k>.bin` = the BATCH3 body (idx i32 | dyn f64 | seeds u32), `<dir>/mons.json` = static table so far. */
function dumpBatch(dir, k, packed, monTable) {
  mkdirSync(dir, { recursive: true });
  const bufs = [packed.idx, packed.dyn, packed.seeds].map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  writeFileSync(path.join(dir, `batch-${String(k).padStart(4, '0')}.bin`), Buffer.concat(bufs));
  writeFileSync(path.join(dir, 'mons.json'), JSON.stringify(monTable));
}

function gpuError(err) {
  if (err instanceof UserError) { err.gpuFatal = true; return err; }
  const e = new UserError(`gpu: ${String(err?.message ?? err).split('\n')[0]}`, 'rerun the identical command to resume from the last complete generation', 1);
  e.gpuFatal = true;
  return e;
}
