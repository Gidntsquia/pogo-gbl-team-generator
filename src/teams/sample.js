// JavaScript Document
//
// Weighted candidate-team sampler. Builds the
// CANDIDATE side of the sampling initiative: instead of the exhaustive path's
// hard C(topK, 3) cutoff (src/teams/index.js's buildCandidates), this samples
// 3-mon teams from the user's WHOLE deduped collection, weighted so a mon
// that scores well in the user's own 1v1 matrix AND/OR is a current meta
// staple (src/meta/usage.js's usage weights) lands on more candidate teams --
// without ever running a battle here. `evaluateTeams` (src/teams/index.js)
// is untouched: this is a pure list generator feeding its `candidates` param.

import { computeWeightedScore } from '../scoring/index.js';
import { pickWeighted, rngFromSeed } from '../util/rng.js';

const TEAM_SIZE = 3;

// P(mon) blend: normalized 1v1-matrix score and normalized species usage
// weight, combined by simple linear interpolation. alpha in [0,1]
// controls how much the user's OWN battle performance vs. the broader meta's
// popularity drives candidate composition: alpha=0 is pure 1v1-score
// sampling (probabilistic analog of buildCandidates' topK cutoff); alpha=1 is
// pure meta-usage sampling (ignores how the user's own copy actually
// battles). 0.5 -- documented tunable, mirrors src/meta/usage.js's
// DEFAULT_GAMMA pattern -- weights both signals equally, so a mon that's
// BOTH a strong 1v1 performer AND a meta staple stands out clearly, so
// Jaxon's OWN meta mons land on more candidate teams.
//
// Exported so src/teams/evolve.js's mutation swap-in step can
// weight its replacement-mon pick with the exact same blend, instead of
// re-deriving it -- the swap-in is weighted by this blend by design.
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
export function buildScoredPool(matrix, pool, exclude, { perBuild = false } = {}) {
  const bySpecies = new Map();
  for (const key of pool) {
    const built = matrix.builtMons[key];
    const ratings = matrix.ratings[key];
    if (!built || !ratings) continue;
    if (exclude.has(built.speciesId)) continue;
    const score = computeWeightedScore(ratings);
    // usageId is the id pvpoke ranks this build under (`_shadow` suffixed),
    // so a shadow build reads its OWN usage weight. With `perBuild` (meta
    // mode) the shadow and the plain build are separate entries, exactly as
    // the opponent side's moveset pool lists them; otherwise one entry per
    // species (the best-scoring specimen), weighted by the species' base id.
    const usageId = perBuild ? `${built.speciesId}${built.spec?.shadow ? '_shadow' : ''}` : built.speciesId;
    const groupKey = perBuild ? usageId : built.speciesId;
    const cur = bySpecies.get(groupKey);
    if (!cur || score > cur.score) {
      bySpecies.set(groupKey, { key, speciesId: built.speciesId, usageId, score });
    }
  }
  return [...bySpecies.values()];
}

/**
 * Build a `(entry) => number` sampling-weight function blending each entry's
 * normalized 1v1 score (within `entries`) and its species' normalized
 * usage weight (within `entries`). Normalizing WITHIN the pool (rather than
 * against the full rankings field) keeps the blend meaningful regardless of
 * how strong/weak the user's overall collection is.
 */
export function makeBlendedWeightFn(entries, weights, alpha) {
  const usageOf = (speciesId) => weights?.get(speciesId) ?? 0;
  const maxScore = Math.max(0, ...entries.map((e) => e.score)) || 1;
  const maxUsage = Math.max(0, ...entries.map((e) => usageOf(e.usageId ?? e.speciesId))) || 1;
  return (entry) => {
    const normScore = entry.score / maxScore;
    const normUsage = usageOf(entry.usageId ?? entry.speciesId) / maxUsage;
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
 *   the `loadUsageWeights` map (species missing from it are treated as
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
  const { matrix, pool, weights, count, seed, excludeSpecies = [], alpha, perBuild = false, allowRepeatSets = false } = params;
  const blendAlpha = typeof alpha === 'number' ? alpha : DEFAULT_BLEND_ALPHA;
  const exclude = new Set(excludeSpecies);
  const rng = rngFromSeed(seed, 'sampleCandidateTeams');

  const entries = buildScoredPool(matrix, pool, exclude, { perBuild });
  if (new Set(entries.map((e) => e.speciesId)).size < TEAM_SIZE) return [];

  const weightFn = makeBlendedWeightFn(entries, weights, blendAlpha);

  const targetCount = allowRepeatSets ? count : Math.min(count, combinationsCount3(entries.length));
  const maxAttempts = targetCount * MAX_ATTEMPTS_MULTIPLIER + MAX_ATTEMPTS_FLOOR;

  const seen = new Set();
  const teams = [];
  let attempts = 0;
  while (teams.length < targetCount && attempts < maxAttempts) {
    attempts += 1;
    // One member at a time, never two builds of one species (a shadow and its
    // plain twin are separate entries under `perBuild`). Without `perBuild`
    // every entry is already a distinct species, so this is the same draw as
    // pickWeighted(entries, 3).
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
