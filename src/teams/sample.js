// JavaScript Document
//
// Weighted candidate-team sampler (the candidate side of evolve runs). Samples
// 3-mon teams from the collection, each build weighted by pvpoke's own rank
// for that build (src/meta/usage.js: 1/(rank+20)) -- exactly the weight the
// opponent side's sampler uses. No 1v1 battles, no blend: a build pvpoke does
// not rank for the format is last place (`lastPlaceWeight`). Nothing here runs
// a battle; it only decides WHICH teams get fought.

import { lastPlaceWeight } from '../meta/usage.js';
import { pickWeighted, rngFromSeed } from '../util/rng.js';

const TEAM_SIZE = 3;

// Sampling without replacement can re-draw the same 3-species team more than
// once, especially on a small pool or heavily skewed weights; duplicates are
// discarded and re-tried rather than kept. This caps retries so a
// near-exhausted pool degrades to "return fewer than requested" (graceful
// cap, matches C(pool,3) < count) instead of looping forever.
const MAX_ATTEMPTS_MULTIPLIER = 20;
const MAX_ATTEMPTS_FLOOR = 50;

/** C(n, 3), or 0 when n < 3. */
function combinationsCount3(n) {
  return n < 3 ? 0 : (n * (n - 1) * (n - 2)) / 6;
}

/** The id pvpoke ranks a built mon under: the species id, `_shadow` suffixed for a Shadow build. */
export function usageIdOf(built) {
  return `${built.speciesId}${built.spec?.shadow ? '_shadow' : ''}`;
}

/**
 * One entry per build (species + shadow flag) in `pool`, so a shadow and its
 * plain twin are separate entries, each read at its own rank. Entries whose
 * species is in `exclude`, or whose key is missing from `builtMons`, are
 * dropped. A pool is expected to be deduped already (src/teams/rankedPool.js);
 * if two keys share a build, the lexicographically first key wins.
 */
export function buildScoredPool(matrix, pool, exclude) {
  const byBuild = new Map();
  for (const key of [...pool].sort()) {
    const built = matrix.builtMons[key];
    if (!built || exclude.has(built.speciesId)) continue;
    const usageId = usageIdOf(built);
    if (!byBuild.has(usageId)) byBuild.set(usageId, { key, speciesId: built.speciesId, usageId });
  }
  return [...byBuild.values()];
}

/**
 * `(entry) => weight`: the entry's build's pvpoke-rank weight from `weights`
 * (loadUsageWeights), or the last-place weight when the build is unranked.
 */
export function makeRankWeightFn(weights) {
  const fallback = lastPlaceWeight(weights);
  return (entry) => weights.get(entry.usageId) ?? fallback;
}

/**
 * Sample weighted candidate 3-mon teams from a deduped user-mon pool. No
 * battles run here -- this only decides WHICH teams get fought, mirroring
 * src/meta/sampleTeams.js's opponent-side sampler.
 *
 * @param {{
 *   matrix: {builtMons: object},
 *   pool: string[],
 *   weights: Map<string, number>,
 *   count: number,
 *   seed?: number|string,
 *   excludeSpecies?: string[],
 *   allowRepeatSets?: boolean,
 * }} params
 *   `matrix.builtMons` maps userMonKey to the built mon (`speciesId`,
 *   `spec.shadow`). `pool` is the userMonKeys to sample from, one entry per
 *   build (see buildScoredPool). `weights` is the `loadUsageWeights` map: a
 *   build's draw weight is its pvpoke-rank weight, last place when unranked.
 *   `count` is how many unique teams to return (capped at C(pool,3) when the
 *   pool cannot supply that many distinct teams). `seed` makes sampling
 *   reproducible. `excludeSpecies` drops species from the pool.
 * @returns {string[][]} unique candidate teams, each 3 userMonKeys with no
 *   species repeated (a shadow and its plain twin never share a team); may be
 *   shorter than `count`.
 */
export function sampleCandidateTeams(params) {
  const { matrix, pool, weights, count, seed, excludeSpecies = [], allowRepeatSets = false } = params;
  const exclude = new Set(excludeSpecies);
  const rng = rngFromSeed(seed, 'sampleCandidateTeams');

  const entries = buildScoredPool(matrix, pool, exclude);
  if (new Set(entries.map((e) => e.speciesId)).size < TEAM_SIZE) return [];

  const weightFn = makeRankWeightFn(weights);

  const targetCount = allowRepeatSets ? count : Math.min(count, combinationsCount3(entries.length));
  const maxAttempts = targetCount * MAX_ATTEMPTS_MULTIPLIER + MAX_ATTEMPTS_FLOOR;

  const seen = new Set();
  const teams = [];
  let attempts = 0;
  while (teams.length < targetCount && attempts < maxAttempts) {
    attempts += 1;
    // One member at a time, never two builds of one species (a shadow and its
    // plain twin are separate entries).
    const picked = [];
    while (picked.length < TEAM_SIZE) {
      const taken = new Set(picked.map((e) => e.speciesId));
      const [pick] = pickWeighted(rng, entries.filter((e) => !taken.has(e.speciesId)), weightFn, 1);
      if (!pick) break;
      picked.push(pick);
    }
    if (picked.length < TEAM_SIZE) break; // ran out of positive-weight entries entirely

    const keys = picked.map((e) => e.key);
    const signature = [...keys].sort().join('|');
    if (!allowRepeatSets && seen.has(signature)) continue;
    seen.add(signature);
    teams.push(keys);
  }

  return teams;
}
