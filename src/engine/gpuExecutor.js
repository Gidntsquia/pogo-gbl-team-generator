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
import { buildPokemon } from './harness.js';
import { hashSeed } from './battle/virtualClock.js';
import { applyGroupMoveset } from '../scoring/index.js';
import { UserError } from '../util/userError.js';
import { makeDescriber } from '../../gpu/describe.mjs';
import { GpuSidecar, packBattles } from '../../gpu/client.mjs';

export const DEFAULT_GPU_CPU_SHARE = 0.015;
/** Battles per sidecar message (the sidecar also splits on its own if GPU memory runs out). */
export const GPU_BATCH_LIMIT = 36000;
const INVALID = 0x6e; // POOL_OVERFLOW|STACK_OVERFLOW|MOVES_OVERFLOW|GUARD|BADSTATE (see gpu/gpu/verify_3v3.py)
const WINNER = ['a', 'b', 'tie'];
const DEFAULT_DIFFICULTY = 3;

/** True when spec index `i` belongs to the CPU share. Deterministic in (i, share). */
export function isCpuIndex(i, share) {
  return Math.floor((i + 1) * share) > Math.floor(i * share);
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
 * @param {{ctx: object, cpuExecutor: object, cpuShare?: number, log?: (m:string)=>void, sidecar?: object}} opts
 *   `sidecar` (tests): object with setStatic(table) and batch3(packed) -> {out, cols, kernelUs, pieces}.
 */
export async function createGpuExecutor({ ctx, cpuExecutor, cpuShare = DEFAULT_GPU_CPU_SHARE, log = () => {}, sidecar = null }) {
  if (!(cpuShare >= 0 && cpuShare <= 1)) throw new UserError(`--gpu-cpu-share must be in [0,1], got ${cpuShare}`, 'use e.g. 0.015');
  let sc = sidecar;
  if (!sc) {
    try {
      sc = await GpuSidecar.start(); // a box without CUDA exits 1 here after the sidecar printed its own `gpu:` line
    } catch (err) {
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

  async function runGpu(specs) {
    const results = new Array(specs.length);
    const flaggedIdx = [];
    const t0 = performance.now();
    for (let lo = 0; lo < specs.length; lo += GPU_BATCH_LIMIT) {
      const part = specs.slice(lo, lo + GPU_BATCH_LIMIT);
      const battles = part.map((s) => {
        const diff = s.difficulty ?? DEFAULT_DIFFICULTY;
        if (diff !== DEFAULT_DIFFICULTY) throw new UserError(`gpu: kernel supports difficulty ${DEFAULT_DIFFICULTY} only, got ${diff}`, 'run without --gpu', 1);
        const A = s.teamA.map(descFor), B = s.teamB.map(descFor);
        return { teamA: A, teamB: B, leadA: s.leadA, leadB: s.leadB, seed: hashSeed(A.map((d) => d.builtId).join(',') + '|' + B.map((d) => d.builtId).join(',') + `|${s.leadA}:${s.leadB}:${diff}`) };
      });
      const packed = packBattles(battles);
      if (monTable.length !== sentStatic) { await sc.setStatic(monTable); sentStatic = monTable.length; }
      const r = await sc.batch3(packed);
      part.forEach((_, i) => {
        if (r.out[i * r.cols + 10] & INVALID) flaggedIdx.push(lo + i);
        else results[lo + i] = { ok: true, value: rowToResult(r.out, i * r.cols) };
      });
    }
    return { results, flaggedIdx, ms: performance.now() - t0 };
  }

  const info = { share: cpuShare };
  return {
    info,
    /** @returns {Promise<Array<{ok:boolean, value?:object, error?:object}>>} slots in spec order. */
    async run(specs) {
      const gpuI = [], cpuI = [];
      specs.forEach((_, i) => (isCpuIndex(i, cpuShare) ? cpuI : gpuI).push(i));
      const t0 = performance.now();
      let cpuMs = 0;
      const cpuP = cpuI.length ? cpuExecutor.run(cpuI.map((i) => specs[i])).then((r) => { cpuMs = performance.now() - t0; return r; }) : Promise.resolve([]);
      let g;
      try {
        g = gpuI.length ? await runGpu(gpuI.map((i) => specs[i])) : { results: [], flaggedIdx: [], ms: 0 };
      } catch (err) {
        cpuP.catch(() => {});
        throw gpuError(err);
      }
      const cpuSlots = await cpuP;
      const slots = new Array(specs.length);
      cpuI.forEach((i, k) => { slots[i] = cpuSlots[k]; });
      gpuI.forEach((i, k) => { if (g.results[k]) slots[i] = g.results[k]; });
      const redo = g.flaggedIdx.map((k) => gpuI[k]);
      if (redo.length) {
        const t1 = performance.now();
        const rs = await cpuExecutor.run(redo.map((i) => specs[i]));
        cpuMs += performance.now() - t1;
        redo.forEach((i, k) => { slots[i] = rs[k]; });
      }
      totals.steps += 1; totals.gpuBattles += gpuI.length - redo.length; totals.cpuBattles += cpuI.length + redo.length;
      totals.flagged += redo.length; totals.gpuMs += g.ms; totals.cpuMs += cpuMs;
      log(`evolve: gpu step -- ${gpuI.length - redo.length} battles on GPU in ${(g.ms / 1000).toFixed(1)}s, ${cpuI.length + redo.length} on CPU in ${(cpuMs / 1000).toFixed(1)}s` +
        `${redo.length ? ` (${redo.length} GPU rows flagged invalid, re-run on CPU)` : ''}, wall ${((performance.now() - t0) / 1000).toFixed(1)}s`);
      return slots;
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

function gpuError(err) {
  if (err instanceof UserError) { err.gpuFatal = true; return err; }
  const e = new UserError(`gpu: ${String(err?.message ?? err).split('\n')[0]}`, 'rerun the identical command to resume from the last complete generation', 1);
  e.gpuFatal = true;
  return e;
}
