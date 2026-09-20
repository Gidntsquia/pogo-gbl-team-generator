// Sequential Halving for one generation's candidate-vs-opponent grid
// (Karnin, Koren & Somekh, ICML 2013; --halving-rounds). Instead of battling
// every team against every opponent, the opponents are put in a seeded random
// order and revealed in growing slices (1/2^(R-1), ..., 1/2, all). After each
// round but the last, only the top `keep` fraction of teams (by that round's
// win rate over the slices seen so far) continue. Teams cut early are never
// battled against the opponents they would have lost to anyway.
//
// Each round is a plain evaluateTeamsInOrder call on the survivors and the
// slice so far, so every fitness term (archetype weights, strength gammas,
// blend) is computed by the same code as the full grid; pairings from earlier
// rounds are served from a generation-local battle memo, never re-simulated.
//
// Fitness the GA sees: a team's result comes from the last round it played.
// Teams cut in round k are capped at the lowest final fitness of the teams that
// outlasted them, so a cut team can never outrank a survivor just because its
// partial estimate was taken on an easier slice.

import { rngFromSeed } from '../util/rng.js';
import { createBattleCache, BATTLE_CACHE_MAX_ENTRIES } from './cache.js';
import { evaluateTeamsInOrder } from './evaluate.js';

/** Opponent-slice sizes per round: doubling up to the full pool, e.g. 3 rounds of 40 -> [10, 20, 40]. */
export function halvingSlices(total, rounds) {
  const sizes = [];
  for (let r = 0; r < rounds; r++) sizes.push(Math.max(1, Math.ceil(total / 2 ** (rounds - 1 - r))));
  return sizes;
}

function shuffled(items, seed) {
  const rng = rngFromSeed(seed);
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const pick = (arr, idxs) => (arr ? idxs.map((i) => arr[i]) : arr);

/**
 * Drop-in replacement for evaluateTeamsInOrder (same params, same return shape)
 * that battles fewer pairings. `fitnessOf(result)` is the number selection
 * ranks on (winRate or blendFitness). Results stay positional.
 *
 * @param {object} ctx
 * @param {object} params - evaluateTeamsInOrder's params
 * @param {{ rounds: number, keep?: number, seed: string, fitnessOf: (r: object) => number }} halving
 */
export async function evaluateWithHalving(ctx, params, halving) {
  const { teams, opponents } = params;
  const { rounds, keep = 0.5, seed, fitnessOf } = halving;
  // Later rounds replay earlier rounds' pairings, so a real memo is required even under --no-battle-cache.
  const cache = params.cache && !params.cache.disabled ? params.cache : createBattleCache(BATTLE_CACHE_MAX_ENTRIES);
  const order = shuffled(opponents.map((_, j) => j), `${seed}-halving`);
  const sizes = halvingSlices(opponents.length, rounds);

  const results = new Array(teams.length);
  const cutAtRound = new Array(teams.length).fill(-1);
  const opponentTally = new Array(opponents.length);
  const opponentStrength = new Array(opponents.length);
  let battleCount = 0;
  let cachedCount = 0;
  let errorCount = 0;
  let startedAt = null;
  let alive = teams.map((_, i) => i);
  let seen = 0;

  for (let r = 0; r < rounds; r++) {
    const slice = order.slice(0, sizes[r]);
    const sub = await evaluateTeamsInOrder(ctx, {
      ...params,
      cache,
      teams: alive.map((i) => teams[i]),
      opponents: slice.map((j) => opponents[j]),
      opponentWeights: pick(params.opponentWeights, slice),
      opponentArchetypeGroups: pick(params.opponentArchetypeGroups, slice),
      candidateWeights: pick(params.candidateWeights, alive),
      candidateArchetypeGroups: pick(params.candidateArchetypeGroups, alive),
    });
    startedAt ??= sub.startedAt;
    battleCount += sub.battleCount;
    // Pairings replayed from earlier rounds are memo hits by construction, not saved work.
    cachedCount += Math.max(0, sub.cachedCount - alive.length * seen * 2);
    errorCount += sub.errorCount;
    alive.forEach((teamIdx, k) => { results[teamIdx] = sub.results[k]; });
    // An opponent's ledger comes from the round that first revealed it (against
    // every team still alive then), so late opponents are not scored only
    // against the survivors' inflated strength across several rounds.
    for (let k = seen; k < slice.length; k++) {
      opponentTally[slice[k]] = sub.opponentTally[k];
      opponentStrength[slice[k]] = sub.opponentStrength[k];
    }
    seen = slice.length;
    if (r < rounds - 1) {
      const ranked = alive
        .map((teamIdx, k) => ({ teamIdx, f: fitnessOf(sub.results[k]) }))
        .sort((a, b) => b.f - a.f || a.teamIdx - b.teamIdx);
      const survivors = Math.max(1, Math.ceil(ranked.length * keep));
      for (const { teamIdx } of ranked.slice(survivors)) cutAtRound[teamIdx] = r;
      alive = ranked.slice(0, survivors).map((x) => x.teamIdx).sort((a, b) => a - b);
    }
  }

  // Cap each cut team below everyone who outlasted it (see header).
  const finalFitness = results.map(fitnessOf);
  const floorAfter = (round) => Math.min(...finalFitness.filter((_, i) => cutAtRound[i] === -1 || cutAtRound[i] > round));
  const capped = results.map((res, i) => {
    if (cutAtRound[i] === -1) return res;
    const cap = floorAfter(cutAtRound[i]);
    return fitnessOf(res) <= cap ? res : { ...res, winRate: Math.min(res.winRate, cap), blendFitness: Math.min(res.blendFitness, cap) };
  });

  return {
    results: capped,
    opponentTally,
    opponentStrength,
    battleCount,
    cachedCount,
    errorCount,
    elapsedMs: Date.now() - startedAt,
    startedAt,
    finishedAt: Date.now(),
    halving: { rounds, keep, sizes },
  };
}
