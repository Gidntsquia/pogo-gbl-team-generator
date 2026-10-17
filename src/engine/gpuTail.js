// EXPERIMENTAL (round 9 GPU study; on only with POGO_GPU_STUDY=tail or tail,certain; default runs never load this path).
//
// The GPU executor's side of tail speculation. A halving round's launch carries, besides its own battles ("main"), a pool of
// the next round's battles (src/evolve/tailSpec.js). The kernel (gpu/gpu/study/tail/tail.cuh) runs pool battles only on
// workers whose warp has no main battle left, once at most `idle` of the workers still have one; the launch still ends the
// moment the last main battle ends, so a pool battle still running then is dropped. Finished pool rows are kept in a store
// keyed by battle-cache key and handed back by the NEXT run() call for exactly the specs it asks for: they reach the battle
// cache as that call's own fresh results, so fitness, counts and checkpoints are the same as without the study flag.
//
// tail,certain adds a second, exact tier: while the launch runs, the host reads the finished main rows every ~50 ms, runs
// the halving cut's certainty test (gpu/gpu/study/tail/certainty.mjs, a port of round 8's certainty.py) and appends the pool
// battles of teams that are now certain to survive to an in-kernel queue the idle workers take from first.

import { leadExchangeLoser, mirrorBattleResult } from '../evolve/fitness.js';

const STUDY = (process.env.POGO_GPU_STUDY ?? '').split(',').map((s) => s.trim());
export const TAIL_ON = STUDY.includes('tail');
export const TAIL_CERTAIN = TAIL_ON && STUDY.includes('certain');
const POLL_MS = Math.max(5, Number(process.env.POGO_GPU_TAIL_POLL_MS ?? 50) || 50);
const INFO = ['n', 'pool', 'started', 'kept', 'discarded', 'fromCertain', 'keptCertain', 'fed', 'specListed', 'specRanked',
  'overrunUs', 'specAtUs', 'mainEndUs', 'workers', 'thr', 'segmentsDropped'];
const WINNER = ['a', 'b', 'tie'];

/** Candidate-view {wp, ex} of a memo-shaped result; seat 1 = the candidate was team B (mirrored first). */
export function candidateView(value, seat) {
  const r = seat === 0 ? value : mirrorBattleResult(value);
  const e = leadExchangeLoser(r.summary);
  return { wp: r.winner === 'a' ? 1 : r.winner === 'tie' ? 0.5 : 0, ex: e === 'b' ? 1 : e === 'a' ? -1 : 0 };
}

/**
 * Tail state of one GPU executor.
 * @param {{log: (m: string) => void}} opts
 */
export function createTail({ log }) {
  let job = null; // speculation job for the next run() (halving round r)
  let plan = null; // certain mode: evaluate.js plan record for the next run()
  let store = new Map(); // cache key -> memo-shaped result, from the last tail launch's pool
  let storeKeyFor = null;
  let certainMod = null;
  const totals = { launches: 0, speculated: 0, kept: 0, discarded: 0, served: 0, certain: 0 };

  return {
    totals,
    /** halving.js: the next run() is round r of a halving step; `j` from tailJob. */
    speculate(j) { job = j; },
    /** evaluate.js (certain mode only): the next run()'s plan, for the certainty test. */
    notePlan(p) { plan = p; },
    /**
     * Start of run(specs): specs answered by the last launch's pool (served) and the job meant for this call (or null).
     * @returns {{served: Map<number, object>, job: object|null, plan: object|null}}
     */
    begin(specs) {
      const served = new Map();
      if (store.size && storeKeyFor) specs.forEach((s, i) => { const v = store.get(storeKeyFor(s)); if (v) served.set(i, v); });
      store = new Map();
      const j = job, p = plan;
      job = null; plan = null;
      if (j && j.main.length !== specs.length) {
        log(`evolve: gpu tail -- job skipped: ${j.main.length} planned main battles, run() got ${specs.length}`);
        return { served, job: null, plan: null };
      }
      return { served, job: j, plan: p };
    },
    /**
     * One TAIL launch for `specs` (this call's GPU battles, none served) plus `j.pool`.
     * @param {object} sc sidecar
     * @param {(part: object[]) => object} pack packBattles of specs
     * @param {Function} packTail gpu/client.mjs packTail
     * @param {object[]} specs
     * @param {object} j tailJob
     * @param {{plan: object|null, specIndex: number[], served: Map<number, object>, ensureStatic?: () => Promise<void>}} cert certain-mode
     *   inputs: specIndex[k] = this call's spec index of launch row k; served = results already known; ensureStatic resends the
     *   mon table when packing the pool added mons
     * @returns {Promise<{out: Int32Array, cols: number, kernelUs: number, info: object, packMs: number, sidecarMs: number}>}
     */
    async launch(sc, pack, packTail, specs, j, cert) {
      const tp = performance.now();
      const tagByKey = new Map(j.main.map((m) => [m.key, m.team * 2 + m.seat]));
      const mainTag = Int32Array.from(specs, (s) => tagByKey.get(j.keyFor(s)) ?? -1);
      const certainOn = TAIL_CERTAIN && !!cert.plan && cert.plan.gamma === 1;
      if (TAIL_CERTAIN && cert.plan && cert.plan.gamma !== 1) log(`evolve: gpu tail -- certain tier off: opponent-strength-gamma ${cert.plan.gamma} (bounds need 1)`);
      const body = packTail({
        main: pack(specs), pool: pack(j.pool.map((p) => p.spec)), mainTag, poolTeam: Int32Array.from(j.pool, (p) => p.team),
        priorPts: j.priorPts, priorN: j.priorN, keepK: j.keepK, spec: true, certain: certainOn,
      });
      if (cert.ensureStatic) await cert.ensureStatic();
      const packMs = performance.now() - tp;
      const ts = performance.now();
      const { tag, done } = await sc.tailStart(body);
      let fin = false;
      let fed = 0;
      const poller = certainOn ? pollCertain(sc, tag, done.then(() => { fin = true; }), () => fin, j, cert, specs.length).then((n) => { fed = n; }) : null;
      const r = await done;
      fin = true;
      if (poller) await poller;
      const sidecarMs = performance.now() - ts;
      const w = r.words;
      const info = Object.fromEntries(INFO.map((k, i) => [k, w[i]]));
      const nP = j.pool.length, n = specs.length;
      const pdone = w.subarray(16, 16 + nP);
      const rowsOff = 16 + nP;
      const cols = (w.length - rowsOff) / (n + nP);
      if (!Number.isInteger(cols)) throw new Error(`gpu tail: reply of ${w.length} words does not fit ${n}+${nP} rows`);
      const out = w.slice(rowsOff, rowsOff + n * cols);
      let kept = 0;
      const INVALID = 0x6e;
      for (let p = 0; p < nP; p++) {
        if (!pdone[p]) continue;
        const o = rowsOff + (n + p) * cols;
        if (w[o + 10] & INVALID) continue;
        const lfA = w[o + 18], lfB = w[o + 19];
        store.set(j.pool[p].key, {
          winner: WINNER[w[o]],
          survivorsHp: { a: w[o + 15], b: w[o + 16], aPerMon: [w[o + 3], w[o + 4], w[o + 5]], bPerMon: [w[o + 6], w[o + 7], w[o + 8]] },
          summary: { leadFaintTurnA: lfA < 0 ? null : lfA, leadFaintTurnB: lfB < 0 ? null : lfB },
        });
        kept += 1;
      }
      storeKeyFor = j.keyFor;
      info.fedHost = fed;
      info.keptValid = kept;
      totals.launches += 1; totals.speculated += info.started; totals.kept += kept; totals.discarded += info.discarded; totals.certain += info.fromCertain;
      return { out, cols, kernelUs: r.kernelUs, info, packMs, sidecarMs };
    },
    /** Log line for one run() with a tail launch (`served` = specs this call took from the previous launch's pool). */
    logLine(info, served, nPool) {
      const ms = (us) => (us < 0 ? '-' : `${(us / 1000).toFixed(0)}ms`);
      log(`evolve: gpu tail -- pool ${nPool}, speculated ${info.started} (${info.fromCertain} certain), kept ${info.keptValid}, discarded ${info.discarded}, ` +
        `overrun ${info.overrunUs}us, served ${served} from the previous launch; ranked at ${ms(info.specAtUs)} of ${ms(info.mainEndUs)} (thr ${info.thr}/${info.workers} workers)`);
    },
    logServedOnly(served) { if (served) log(`evolve: gpu tail -- served ${served} from the previous launch (no pool this call)`); },
  };

  /** Certain tier: every POLL_MS read the finished main rows, run the certainty test, feed new certain teams' pool battles. */
  async function pollCertain(sc, tag, doneP, isDone, j, cert, n) {
    certainMod ??= await import('../../gpu/gpu/study/tail/certainty.mjs');
    const { prepareRound, bounds, certainTeams, rowView } = certainMod;
    // the cut ranks by blendFitness under --fitness battle-reality, else by winRate (all blend weights 0 -> bounds = win rate)
    const zero = { snowball: 0, closer: 0, consistency: 0, sharedWeakness: 0 };
    const R = prepareRound(j.blend === false ? { ...cert.plan, weights: zero } : cert.plan);
    const rowOfSpec = new Map(cert.specIndex.map((si, k) => [si, k]));
    const byTeam = new Map();
    j.pool.forEach((p, i) => { if (!byTeam.has(p.team)) byTeam.set(p.team, []); byTeam.get(p.team).push(i); });
    const fedTeams = new Set();
    let fed = 0;
    const known = (rows, seat) => (ix) => {
      const v = cert.served.get(ix);
      if (v) return candidateView(v, seat);
      const k = rowOfSpec.get(ix);
      if (k === undefined || !rows || k >= rows.length / 4 || !rows[k * 4 + 3]) return null;
      // a peeked row holds winner and lead-faint turns only (no HP): read it with the port's rowView
      return rowView(rows[k * 4], rows[k * 4 + 1], rows[k * 4 + 2], seat);
    };
    const stop = new Promise((res) => doneP.then(res));
    while (!isDone()) {
      await Promise.race([new Promise((res) => setTimeout(res, POLL_MS)), stop]);
      if (isDone()) break;
      const rows = await sc.peek(tag);
      if (isDone() || rows.length < n * 4) break;
      const { lo, hi } = bounds(R, known(rows, 0), known(rows, 1));
      const c = certainTeams(lo, hi, j.keep);
      const add = [];
      c.forEach((v, t) => { if (v && !fedTeams.has(t)) { fedTeams.add(t); add.push(...(byTeam.get(t) ?? [])); } });
      if (add.length && !isDone()) fed += await sc.feed(tag, add);
      if (fedTeams.size === c.length) break;
    }
    return fed;
  }
}
