// Sampled combats (--sampled-combats F): instead of every candidate fighting
// every opponent, each candidate fights a random 1/K sample of the opponent
// pool (F = 1/K), and the saved battles are spent on bigger populations.
//
// Design: a block sample. Each generation, a seeded shuffle splits the
// opponents into K disjoint chunks and the candidates into K groups; group g
// fights only chunk g. Every candidate therefore sees a random 1/K sample, and
// every opponent is fought by 1/K of the candidates, so no side ends the
// generation without a fitness value. Each block is a plain evaluate call
// (Sequential Halving or the full grid), so every fitness term is computed by
// the same code as the unsampled path, and with Halving on each candidate's
// slices come from its own sample.
//
// Fixed-K mode (--sampled-opponents K): the block count is ceil(opponents / K), so each
// candidate fights ~K opponents (never more) no matter how big the pools are. Needs at least
// that many candidates, or some opponent would end the generation with no fitness (the CLI
// refuses such sizes at start).
//
// Randomness: src/util/rng.js only, seeded per generation.

import { rngFromSeed } from '../util/rng.js';
import { evaluateTeamsInOrder } from './evaluate.js';
import { evaluateWithHalving } from './halving.js';

/** Number of blocks for a sampling fraction: 0.5 -> 2, 0.25 -> 4. Fractions must be 1/K, K >= 2. */
export function blocksForFraction(fraction) {
  const k = Math.round(1 / fraction);
  return k >= 2 && Math.abs(1 / k - fraction) < 1e-9 ? k : null;
}

/**
 * Fixed-K mode (--sampled-opponents K): blocks needed so no candidate fights more than K of
 * `opponentCount` opponents. K >= opponents -> 1 block (everyone fights everyone).
 */
export function blocksForPerCandidate(opponentCount, k) {
  return Math.max(1, Math.ceil(opponentCount / k));
}

function shuffledIndices(n, seed) {
  const rng = rngFromSeed(seed);
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const pick = (arr, idxs) => (arr ? idxs.map((i) => arr[i]) : arr);

/**
 * Drop-in for evaluateTeamsInOrder / evaluateWithHalving (same params, same
 * return shape, results positional) that battles one random 1/K block per
 * candidate.
 *
 * @param {object} ctx
 * @param {object} params - evaluateTeamsInOrder's params
 * @param {{ fraction: number, seed: string, halving?: { rounds: number, keep?: number, fitnessOf: Function } }} sampled
 */
export async function evaluateWithSampling(ctx, params, sampled) {
  const { teams, opponents } = params;
  const { fraction, seed, halving } = sampled;
  const wanted = sampled.perCandidate ? blocksForPerCandidate(opponents.length, sampled.perCandidate) : blocksForFraction(fraction) ?? 1;
  const K = Math.min(wanted, teams.length, opponents.length);
  const teamOrder = shuffledIndices(teams.length, `${seed}-sample-teams`);
  const oppOrder = shuffledIndices(opponents.length, `${seed}-sample-opps`);

  const results = new Array(teams.length);
  const opponentTally = new Array(opponents.length);
  const opponentStrength = new Array(opponents.length);
  let battleCount = 0, cachedCount = 0, errorCount = 0;
  let startedAt = null;
  const blocks = [];
  for (let g = 0; g < K; g++) {
    const ti = teamOrder.filter((_, pos) => pos % K === g).sort((a, b) => a - b);
    const oi = oppOrder.filter((_, pos) => pos % K === g).sort((a, b) => a - b);
    const sub = {
      ...params,
      teams: ti.map((i) => teams[i]),
      opponents: oi.map((j) => opponents[j]),
      opponentWeights: pick(params.opponentWeights, oi),
      opponentArchetypeGroups: pick(params.opponentArchetypeGroups, oi),
      candidateWeights: pick(params.candidateWeights, ti),
      candidateArchetypeGroups: pick(params.candidateArchetypeGroups, ti),
    };
    const run = halving
      ? await evaluateWithHalving(ctx, sub, { ...halving, seed: `${seed}-block${g}` })
      : await evaluateTeamsInOrder(ctx, sub);
    startedAt = startedAt === null ? run.startedAt : Math.min(startedAt, run.startedAt);
    battleCount += run.battleCount;
    cachedCount += run.cachedCount;
    errorCount += run.errorCount;
    ti.forEach((t, k) => { results[t] = run.results[k]; });
    oi.forEach((o, k) => { opponentTally[o] = run.opponentTally[k]; opponentStrength[o] = run.opponentStrength[k]; });
    blocks.push({ teams: ti.length, opponents: oi.length });
  }
  return {
    results,
    opponentTally,
    opponentStrength,
    battleCount,
    cachedCount,
    errorCount,
    elapsedMs: Date.now() - startedAt,
    startedAt,
    finishedAt: Date.now(),
    sampled: { ...(sampled.perCandidate ? { perCandidate: sampled.perCandidate } : { fraction }), blocks },
  };
}
