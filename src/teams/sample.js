// JavaScript Document
//
// Weighted candidate-team sampler (GOALS T11, PLAN.md Rev 3). Builds the
// CANDIDATE side of the sampling initiative: instead of the exhaustive path's
// hard C(topK, 3) cutoff (src/teams/index.js's buildCandidates), this samples
// 3-mon teams from the user's WHOLE deduped collection, weighted so a mon
// that scores well in the user's own 1v1 matrix AND/OR is a current meta
// staple (src/meta/usage.js's T9 weights) lands on more candidate teams --
// without ever running a battle here. `evaluateTeams` (src/teams/index.js)
// is untouched: this is a pure list generator feeding its `candidates` param.

import { computeWeightedScore } from '../scoring/index.js';
import { pickWeighted, rngFromSeed } from '../util/rng.js';

const TEAM_SIZE = 3;

// P(mon) blend: normalized 1v1-matrix score and normalized species usage
// weight (T9), combined by simple linear interpolation. alpha in [0,1]
// controls how much the user's OWN battle performance vs. the broader meta's
// popularity drives candidate composition: alpha=0 is pure 1v1-score
// sampling (probabilistic analog of buildCandidates' topK cutoff); alpha=1 is
// pure meta-usage sampling (ignores how the user's own copy actually
// battles). 0.5 -- documented tunable, mirrors src/meta/usage.js's
// DEFAULT_GAMMA pattern -- weights both signals equally, so a mon that's
// BOTH a strong 1v1 performer AND a meta staple stands out clearly (PLAN Rev
// 3: "so Jaxon's OWN meta mons land on more candidate teams").
//
// Exported (GOALS T23) so src/teams/evolve.js's mutation swap-in step can
// weight its replacement-mon pick with the exact same blend, instead of
// re-deriving it -- PLAN Rev 5 explicitly says "swap-in weighted by the Rev
// 3 blend".
export const DEFAULT_BLEND_ALPHA = 0.5;

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

/**
 * Reduce `pool` (userMonKeys) to one scored entry per species: the matrix
 * entries `computeWeightedScore`s, deduped defensively by species (a team can
 * only ever contain one mon per species, same rule src/teams/index.js's
 * buildCandidates and src/cli.js's dedupeBestPerSpecies use -- callers are
 * expected to already pass a deduped pool, but this never trusts that alone).
 * Entries whose species is in `exclude`, or whose key is missing from the
 * matrix, are dropped.
 */
export function buildScoredPool(matrix, pool, exclude) {
  const bySpecies = new Map();
  for (const key of pool) {
    const built = matrix.builtMons[key];
    const ratings = matrix.ratings[key];
    if (!built || !ratings) continue;
    if (exclude.has(built.speciesId)) continue;
    const score = computeWeightedScore(ratings);
    const cur = bySpecies.get(built.speciesId);
    if (!cur || score > cur.score) {
      bySpecies.set(built.speciesId, { key, speciesId: built.speciesId, score });
    }
  }
  return [...bySpecies.values()];
}

/**
 * Build a `(entry) => number` sampling-weight function blending each entry's
 * normalized 1v1 score (within `entries`) and its species' normalized T9
 * usage weight (within `entries`). Normalizing WITHIN the pool (rather than
 * against the full rankings field) keeps the blend meaningful regardless of
 * how strong/weak the user's overall collection is.
 */
export function makeBlendedWeightFn(entries, weights, alpha) {
  const usageOf = (speciesId) => weights?.get(speciesId) ?? 0;
  const maxScore = Math.max(0, ...entries.map((e) => e.score)) || 1;
  const maxUsage = Math.max(0, ...entries.map((e) => usageOf(e.speciesId))) || 1;
  return (entry) => {
    const normScore = entry.score / maxScore;
    const normUsage = usageOf(entry.speciesId) / maxUsage;
    return (1 - alpha) * normScore + alpha * normUsage;
  };
}

/**
 * Sample weighted candidate 3-mon teams from a deduped user-mon pool. No
 * battles run here -- this only decides WHICH teams `evaluateTeams` will
 * later fight, mirroring src/meta/sampleTeams.js's opponent-side sampler.
 *
 * @param {{
 *   matrix: object,
 *   pool: string[],
 *   weights?: Map<string, number>,
 *   count: number,
 *   seed?: number|string,
 *   excludeSpecies?: string[],
 *   alpha?: number,
 * }} params
 *   `matrix` is scoreCollection's return (needs `ratings` + `builtMons`).
 *   `pool` is the userMonKeys to sample from -- expected to already be
 *   deduped to one instance per species (see `dedupeBestPerSpecies` in
 *   src/teams/index.js), though this function re-dedupes defensively so a
 *   non-deduped pool can never produce a same-species team. `weights` is
 *   T9's `loadUsageWeights` map (species missing from it are treated as
 *   usage weight 0, and an entirely omitted `weights` degrades gracefully to
 *   pure 1v1-score sampling). `count` is how many unique teams to return
 *   (gracefully capped at C(pool.length, 3) when the pool is too small to
 *   supply that many DISTINCT teams). `seed` makes sampling reproducible
 *   (default: a fixed fallback string, never wall-clock). `excludeSpecies`
 *   drops species from the pool before sampling. `alpha` overrides
 *   DEFAULT_BLEND_ALPHA (documented above).
 * @returns {string[][]} unique candidate teams, each 3 distinct userMonKeys
 *   (no duplicate species within a team); may be shorter than `count` if the
 *   pool can't supply that many distinct teams.
 */
export function sampleCandidateTeams(params) {
  const { matrix, pool, weights, count, seed, excludeSpecies = [], alpha } = params;
  const blendAlpha = typeof alpha === 'number' ? alpha : DEFAULT_BLEND_ALPHA;
  const exclude = new Set(excludeSpecies);
  const rng = rngFromSeed(seed, 'sampleCandidateTeams');

  const entries = buildScoredPool(matrix, pool, exclude);
  if (entries.length < TEAM_SIZE) return [];

  const weightFn = makeBlendedWeightFn(entries, weights, blendAlpha);

  const targetCount = Math.min(count, combinationsCount3(entries.length));
  const maxAttempts = targetCount * MAX_ATTEMPTS_MULTIPLIER + MAX_ATTEMPTS_FLOOR;

  const seen = new Set();
  const teams = [];
  let attempts = 0;
  while (teams.length < targetCount && attempts < maxAttempts) {
    attempts += 1;
    const picked = pickWeighted(rng, entries, weightFn, TEAM_SIZE);
    if (picked.length < TEAM_SIZE) break; // ran out of positive-weight entries entirely

    const keys = picked.map((e) => e.key);
    const signature = [...keys].sort().join('|');
    if (seen.has(signature)) continue;
    seen.add(signature);
    teams.push(keys);
  }

  return teams;
}
