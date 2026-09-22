// Hoeffding Races for one generation's candidate-vs-opponent grid (research
// idea #3, EXPERIMENTAL, off by default: --hoeffding-races). Same insertion
// point as Sequential Halving (halving.js) and the same goal -- battle fewer
// pairings by cutting teams that can no longer catch up -- but a different
// schedule: opponents are revealed in FIXED-size chunks (not doubling), and
// after every chunk but the last, each alive team's win-rate confidence
// interval (Wilson score interval, unweighted battles-so-far) is checked
// against the current cull-line team's interval. A team is cut only when its
// interval's upper bound falls below the cull-line team's lower bound --
// evidence it cannot pass, not just that it is currently behind. Unlike
// halving's fixed schedule this is adaptive: a generation with clear early
// losers cuts them sooner, a close generation keeps everyone longer.
//
// The research report says pick one of Halving (#1) or Hoeffding (#3), not
// both -- they solve the same problem at the same insertion point. When
// --hoeffding-races is on, generation.js dispatches here INSTEAD of halving,
// regardless of --halving-rounds (see RUNBOOK.md).
//
// Same shape as halving.js: each chunk is a plain evaluateTeamsInOrder call
// on the survivors and the slice so far (every fitness term computed by the
// same code as the full grid), pairings from earlier chunks are served from
// a generation-local battle memo, and a team cut in round k is capped at the
// lowest final fitness of the teams that outlasted it.

import { rngFromSeed } from '../util/rng.js';
import { createBattleCache, BATTLE_CACHE_MAX_ENTRIES } from './cache.js';
import { evaluateTeamsInOrder } from './evaluate.js';

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
 * Wilson score interval for a binomial proportion (wins/n), the standard
 * finite-sample-safe interval (unlike the raw Hoeffding bound, it stays
 * inside [0,1] and isn't overly conservative at small n, which matters here
 * since early chunks may see only a handful of battles per team).
 *
 * @param {number} wins
 * @param {number} n
 * @param {number} z - 1.96 for a 95% interval (the default)
 * @returns {{lo: number, hi: number}}
 */
export function wilsonInterval(wins, n, z = 1.96) {
  if (n <= 0) return { lo: 0, hi: 1 };
  const phat = Math.min(1, Math.max(0, wins / n));
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
  return { lo: Math.max(0, (center - margin) / denom), hi: Math.min(1, (center + margin) / denom) };
}

/**
 * Drop-in replacement for evaluateTeamsInOrder (same params, same return
 * shape) that battles fewer pairings by early-stopping teams the confidence
 * interval says can no longer catch the cull line.
 *
 * @param {object} ctx
 * @param {object} params - evaluateTeamsInOrder's params
 * @param {{ chunk?: number, keep?: number, confidence?: number, seed: string, fitnessOf: (r: object) => number }} hoeffding
 *   `chunk` opponents revealed per round (default 10). `keep` is the same
 *   "cull line" concept as halving's keep fraction: after each round, the
 *   team at rank ceil(alive*keep) (by current fitness) is the cull line, and
 *   any alive team whose win-rate interval upper bound is below the cull
 *   line's interval lower bound is cut (default 0.5). `confidence` sets z
 *   (default 0.95 -> z=1.96).
 */
export async function evaluateWithHoeffding(ctx, params, hoeffding) {
  const { teams, opponents } = params;
  const { chunk = 10, keep = 0.5, confidence = 0.95, seed, fitnessOf } = hoeffding;
  const z = confidence >= 0.99 ? 2.576 : confidence >= 0.95 ? 1.96 : confidence >= 0.9 ? 1.645 : 1.96;
  // Later rounds replay earlier rounds' pairings, so a real memo is required even under --no-battle-cache.
  const cache = params.cache && !params.cache.disabled ? params.cache : createBattleCache(BATTLE_CACHE_MAX_ENTRIES);
  const order = shuffled(opponents.map((_, j) => j), `${seed}-hoeffding`);
  const chunkSize = Math.max(1, chunk);
  const numRounds = Math.max(1, Math.ceil(opponents.length / chunkSize));

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
  let cutBattlesSkipped = 0; // pairings never fought because a team was cut early

  for (let r = 0; r < numRounds; r++) {
    const sliceEnd = Math.min(opponents.length, (r + 1) * chunkSize);
    const slice = order.slice(0, sliceEnd);
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
    cachedCount += Math.max(0, sub.cachedCount - alive.length * seen * 2);
    errorCount += sub.errorCount;
    alive.forEach((teamIdx, k) => { results[teamIdx] = sub.results[k]; });
    for (let k = seen; k < slice.length; k++) {
      opponentTally[slice[k]] = sub.opponentTally[k];
      opponentStrength[slice[k]] = sub.opponentStrength[k];
    }
    seen = slice.length;

    const isLast = sliceEnd >= opponents.length;
    if (!isLast && alive.length > 1) {
      const ranked = alive
        .map((teamIdx, k) => {
          const res = sub.results[k];
          const battles = res.battles ?? 0;
          const wins = Math.round((res.rawWinRate ?? 0) * battles);
          return { teamIdx, f: fitnessOf(res), battles, wins, ci: wilsonInterval(wins, battles, z) };
        })
        .sort((a, b) => b.f - a.f || a.teamIdx - b.teamIdx);
      const cullRank = Math.min(ranked.length - 1, Math.max(0, Math.ceil(ranked.length * keep) - 1));
      const cullLine = ranked[cullRank];
      const survivors = [];
      for (const entry of ranked) {
        if (entry === cullLine || entry.ci.hi >= cullLine.ci.lo) {
          survivors.push(entry.teamIdx);
        } else {
          cutAtRound[entry.teamIdx] = r;
          cutBattlesSkipped += opponents.length - sliceEnd;
        }
      }
      alive = survivors.sort((a, b) => a - b);
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
    hoeffding: { chunk: chunkSize, keep, confidence, rounds: numRounds, cutBattlesSkipped },
  };
}
