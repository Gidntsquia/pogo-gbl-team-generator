// EXPERIMENTAL (plans round 7 R7), off by default: POGO_GPU_ISLAND=on under `evolve --gpu` with --halving-rounds >= 2.
// Island halving: every Sequential-Halving round of a generation step runs in ONE GPU launch.
//
// The candidate teams are split into islands (a seeded shuffle, islandSize() teams each: 8 x 2^(rounds-1) by default). Every island
// sees the same opponent order and slices as CPU halving (halving.js). On the GPU (gpu/gpu/island.py), an island whose
// round-r battles are done ranks its alive teams by raw win points over the opponents seen so far (win 2, tie 1 per seat;
// ties to the lower team index), keeps ceil(alive * keep) and queues the survivors' next-round battles -- no island waits
// for another. The host then pools the results here:
//   1. every battle the launch ran goes into the run's memo (flagged rows were re-run on the CPU by the executor);
//   2. the island cuts are recomputed on the host from those winners (this reference is authoritative; a team whose kernel
//      cut differs is logged, and any battle the reference needs that the launch did not run goes through executor.run);
//   3. halving.js scores each round's alive set with the same evaluateTeamsInOrder code as CPU halving (all memo hits).
// Differences from CPU halving (for the evaluator): the cut is local to an island and ranks on raw win share, not on
// blendFitness over the whole population.
import { rngFromSeed } from '../util/rng.js';

/** POGO_GPU_ISLAND=on */
export const ISLAND_ON = process.env.POGO_GPU_ISLAND === 'on';
/**
 * Teams per island: POGO_GPU_ISLAND_SIZE, else 8 x 2^(rounds-1) (halving 3: 32, halving 2: 16), so every island keeps 8 teams
 * into its last round at keep 0.5; the island count then follows the population (300 teams, halving 3: 10 islands).
 * @param {number} rounds
 * @returns {number}
 */
export function islandSize(rounds) {
  const env = Number.parseInt(process.env.POGO_GPU_ISLAND_SIZE ?? '', 10);
  return env >= 2 ? env : 8 * 2 ** Math.max(0, rounds - 1);
}
const WCODE = { a: 0, b: 1, tie: 2 };

/**
 * Islands of `n` teams: a seeded shuffle cut into ceil(n / size) near-equal parts.
 * @param {number} n
 * @param {number} size
 * @param {string} seed
 * @returns {{islStart: number[], members: number[]}} members[islStart[k]..islStart[k+1]) = island k's team indices, ascending.
 */
export function makeIslands(n, size, seed) {
  const rng = rngFromSeed(seed);
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  const nIsl = Math.max(1, Math.ceil(n / size));
  const islStart = [0];
  const members = [];
  for (let k = 0; k < nIsl; k++) {
    const lo = Math.floor((k * n) / nIsl), hi = Math.floor(((k + 1) * n) / nIsl);
    members.push(...a.slice(lo, hi).sort((x, y) => x - y));
    islStart.push(hi);
  }
  return { islStart, members };
}

/**
 * The island cuts from known winners (the host reference of the kernel's cut). `winnerOf(bid)` -> 0 a / 1 b / 2 tie, or
 * undefined when the battle has not been run; `fetch(bids)` runs missing ones and returns when winnerOf knows them.
 * @returns {Promise<{aliveByRound: number[][], cutAt: Int32Array}>}
 */
export async function islandCuts({ nC, nO, order, sizes, keep, islStart, members }, winnerOf, fetch) {
  const R = sizes.length;
  const pts = new Float64Array(nC);
  const cutAt = new Int32Array(nC).fill(-1);
  let alive = [];
  for (let k = 0; k + 1 < islStart.length; k++) alive.push(members.slice(islStart[k], islStart[k + 1]));
  const aliveByRound = [];
  for (let r = 0; r < R; r++) {
    aliveByRound.push(alive.flat().sort((x, y) => x - y));
    const o0 = r === 0 ? 0 : sizes[r - 1], o1 = sizes[r];
    const bids = [];
    for (const isl of alive) for (const c of isl) for (let oi = o0; oi < o1; oi++) for (const s of [0, 1]) bids.push((c * nO + order[oi]) * 2 + s);
    const missing = bids.filter((b) => winnerOf(b) === undefined);
    if (missing.length) await fetch(missing);
    for (const b of bids) {
      const w = winnerOf(b);
      pts[Math.floor(b / 2 / nO)] += w === 2 ? 1 : w === (b & 1) ? 2 : 0;
    }
    if (r < R - 1) {
      alive = alive.map((isl) => {
        const keepN = Math.max(1, Math.ceil(isl.length * keep));
        const ranked = [...isl].sort((x, y) => pts[y] - pts[x] || x - y);
        ranked.slice(keepN).forEach((c) => { cutAt[c] = r; });
        return ranked.slice(0, keepN).sort((x, y) => x - y);
      });
    }
  }
  return { aliveByRound, cutAt };
}

/**
 * halving.js prepass for island mode, or null when it does not apply (not on, no runIsland, < 2 rounds, a pairing
 * generator with more than one pairing per opponent).
 * @param {object} params - evaluateTeamsInOrder params (teams, matrix, opponents, pairingsFor, difficulty, executor, onLog)
 * @param {string} seed - the generation's halving seed
 * @returns {null | ((h: {cache: object, order: number[], sizes: number[], keep: number}) => Promise<{aliveByRound: number[][], battleCount: number, cachedCount: number}>)}
 */
export function islandPrepass(params, seed) {
  const { teams, matrix, opponents, pairingsFor, difficulty, executor, onLog } = params;
  if (!ISLAND_ON || !executor?.runIsland) return null;
  const pairs = opponents.map((o) => pairingsFor(o));
  if (pairs.some((p) => p.length !== 1) || new Set(pairs.map((p) => p[0].leadA)).size > 1) return null;
  return async ({ cache, order, sizes, keep }) => {
    if (sizes.length < 2) return null;
    const nC = teams.length, nO = opponents.length, nB = nC * nO * 2;
    const cand = teams.map((keys) => keys.map((k) => matrix.builtMons[k].spec));
    const opp = opponents.map((o) => o.members.map((m) => m.spec));
    const candLead = pairs[0][0].leadA;
    const oppLeads = pairs.map((p) => p[0].leadB);
    const keys = new Array(nB);
    const known = new Int32Array(nB), canon = new Int32Array(nB);
    const first = new Map();
    const winner = new Int8Array(nB).fill(-1);
    for (let c = 0; c < nC; c++) {
      for (let o = 0; o < nO; o++) {
        const b = (c * nO + o) * 2;
        keys[b] = cache.keyFor(cand[c], candLead, opp[o], oppLeads[o], difficulty);
        keys[b + 1] = cache.keyFor(opp[o], oppLeads[o], cand[c], candLead, difficulty);
        for (const x of [b, b + 1]) {
          const hit = cache.get(keys[x]);
          if (hit !== undefined) { known[x] = 1 + WCODE[hit.winner]; winner[x] = WCODE[hit.winner]; }
          if (!first.has(keys[x])) first.set(keys[x], x);
          canon[x] = first.get(keys[x]);
        }
      }
    }
    const { islStart, members } = makeIslands(nC, islandSize(sizes.length), `${seed}-islands`);
    const job = { cand, opp, candLead, oppLeads, difficulty, known, canon, order, sizes, keep, islStart, members };
    const res = await executor.runIsland(job);
    let battleCount = 0;
    for (const [b, value] of res.results) {
      cache.set(keys[b], value);
      battleCount += 1;
      winner[b] = WCODE[value.winner];
    }
    // duplicates and cross-island repeats share their canonical battle's result
    const winnerOf = (b) => {
      if (winner[b] >= 0) return winner[b];
      const hit = cache.get(keys[b]);
      if (hit === undefined) return undefined;
      winner[b] = WCODE[hit.winner];
      return winner[b];
    };
    let extra = 0;
    const specOf = (b) => {
      const c = Math.floor(b / 2 / nO), o = (b >> 1) % nO;
      return b & 1
        ? { teamA: opp[o], teamB: cand[c], leadA: oppLeads[o], leadB: candLead, difficulty }
        : { teamA: cand[c], teamB: opp[o], leadA: candLead, leadB: oppLeads[o], difficulty };
    };
    const fetch = async (bids) => {
      const uniq = [...new Map(bids.map((b) => [keys[b], b])).values()];
      const slots = await executor.run(uniq.map(specOf));
      slots.forEach((slot, i) => {
        if (!slot.ok) throw new Error(`island halving: battle ${uniq[i]} failed: ${slot.error?.message}`);
        cache.set(keys[uniq[i]], slot.value);
      });
      extra += uniq.length;
    };
    const { aliveByRound, cutAt } = await islandCuts({ nC, nO, order, sizes, keep, islStart, members }, winnerOf, fetch);
    let mismatch = 0;
    for (let c = 0; c < nC; c++) if (cutAt[c] !== res.icut[c]) mismatch += 1;
    if (mismatch || extra) onLog?.(`evolve: gpu island check -- ${mismatch} teams cut differently by the kernel than by the host reference, ${extra} extra battles run for the reference`);
    const memoKeys = new Set();
    aliveByRound.forEach((alive, r) => {
      for (const c of alive) {
        for (let oi = r === 0 ? 0 : sizes[r - 1]; oi < sizes[r]; oi++) {
          for (const s of [0, 1]) { const b = (c * nO + order[oi]) * 2 + s; if (known[b]) memoKeys.add(keys[b]); }
        }
      }
    });
    const cachedCount = memoKeys.size;
    return { aliveByRound, battleCount: battleCount + extra, cachedCount };
  };
}
