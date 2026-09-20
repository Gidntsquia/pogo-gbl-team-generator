// JavaScript Document
//
// Best-specimen-per-species dedupe over a 1v1 scoring matrix. Used by
// scripts/build-shared-collection.mjs; evolve runs dedupe by pvpoke rank
// instead (src/teams/rankedPool.js).

import { computeWeightedScore } from '../scoring/index.js';

/**
 * Keep only the best-scoring built instance per species, so two copies of the
 * same Pokemon (e.g. two Azumarill with different IVs) don't fill several
 * near-identical "different" candidate teams -- and, when the collection has
 * been expanded with evolutions (src/evolution/index.js), only the best form
 * of each physical Pokemon. Returns a shallow matrix copy
 * with pruned `ratings`/`builtMons`; other fields are shared unchanged.
 *
 * @param {object} matrix - scoreCollection's return (needs ratings + builtMons).
 * @param {{keepShadowVariants?: boolean}} [opts] - `keepShadowVariants: true`
 *   keys the species pass by (species, shadow flag) instead of species alone,
 *   so a collection holding BOTH a shadow and a non-shadow of one species keeps
 *   its best specimen of each. The GA (src/teams/evolve.js) needs that: its
 *   shadow-flip mutation swaps a team member for its opposite-shadow twin, which
 *   only exists to swap to if this pass kept it. Default false = one key per
 *   species, the CLI's behavior.
 * @returns {object} matrix with `ratings`/`builtMons` pruned to one key per species
 *   (or per species+shadow when `keepShadowVariants`).
 */
export function dedupeBestPerSpecies(matrix, { keepShadowVariants = false } = {}) {
  // Pass 1 (lineage): when src/evolution/index.js has expanded the collection,
  // one physical Pokemon appears several times -- Phantump AND Trevenant off
  // the same CSV row. Keep only whichever form actually scored best, which is
  // both how "evolve it if the current form isn't viable" gets decided and
  // what makes it impossible for a team to field two forms of one mon. Mons
  // from an unexpanded collection each have their own lineage, so this pass
  // is a no-op for them.
  const bestByLineage = new Map();
  for (const key of Object.keys(matrix.ratings)) {
    const lineageKey = matrix.builtMons[key].lineageKey ?? key;
    const score = computeWeightedScore(matrix.ratings[key]);
    const cur = bestByLineage.get(lineageKey);
    if (!cur || score > cur.score) bestByLineage.set(lineageKey, { key, score });
  }

  // Pass 2 (species): two DIFFERENT physical Pokemon of the same species (or
  // two rows that evolve into it) still can't share a team.
  const bestBySpecies = new Map();
  for (const { key, score } of bestByLineage.values()) {
    const built = matrix.builtMons[key];
    const groupKey = keepShadowVariants ? `${built.speciesId}|${built.spec?.shadow ? 'shadow' : 'base'}` : built.speciesId;
    const cur = bestBySpecies.get(groupKey);
    if (!cur || score > cur.score) bestBySpecies.set(groupKey, { key, score });
  }
  const keep = new Set([...bestBySpecies.values()].map((v) => v.key));
  const ratings = {};
  const builtMons = {};
  for (const key of keep) {
    ratings[key] = matrix.ratings[key];
    builtMons[key] = matrix.builtMons[key];
  }
  return { ...matrix, ratings, builtMons };
}
