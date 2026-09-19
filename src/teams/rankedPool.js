// JavaScript Document
//
// The candidate pool of an evolve run, chosen by pvpoke rank alone -- no 1v1
// scoring. Two pure steps over `builtMons` (userMonKey -> built mon):
//
//   dedupeByRank      one specimen per lineage, then one per (species, shadow)
//   buildRankedPool   the keys the GA may draw from, capped at the N best-ranked species
//
// "Rank" is the weight `loadUsageWeights` gives the build (1/(rank+20)); a
// build pvpoke does not rank for the format gets `lastPlaceWeight`.

import { lastPlaceWeight } from '../meta/usage.js';
import { usageIdOf } from './sample.js';

/** Weight of one built mon's build: its pvpoke-rank weight, last place when unranked. */
export function rankWeightOf(built, weights, fallback = lastPlaceWeight(weights)) {
  return weights.get(usageIdOf(built)) ?? fallback;
}

/** atk * def * hp of the built instance at the level it plays -- a battle-free tiebreak between specimens of one build. */
function statProduct(built) {
  const s = built.pokemon?.stats;
  return s ? s.atk * s.def * s.hp : 0;
}

/**
 * Deterministic "better specimen" order: higher rank weight, then higher
 * stat product, then the smaller userMonKey. Returns true when `a` beats `b`.
 */
function beats(a, b, weights, fallback) {
  const wa = rankWeightOf(a.built, weights, fallback);
  const wb = rankWeightOf(b.built, weights, fallback);
  if (wa !== wb) return wa > wb;
  const pa = statProduct(a.built);
  const pb = statProduct(b.built);
  if (pa !== pb) return pa > pb;
  return a.key < b.key;
}

/**
 * Collapse `builtMons` so a team can never field two forms of one physical
 * Pokemon or two specimens of one build.
 *
 * Pass 1 (lineage): one CSV row and the evolutions it expands to share a
 * `lineageKey`; keep the form whose build pvpoke ranks best (so an evolution
 * is picked when it is the ranked form). Pass 2: among different physical
 * mons of one (species, shadow) build keep the best specimen. Both passes use
 * the same deterministic order: higher rank weight, then higher atk*def*hp
 * stat product, then the smaller userMonKey.
 *
 * @param {Record<string, object>} builtMons
 * @param {Map<string, number>} weights - loadUsageWeights.
 * @returns {Record<string, object>} pruned copy of `builtMons`.
 */
export function dedupeByRank(builtMons, weights) {
  const fallback = lastPlaceWeight(weights);
  const bestBy = (entries, groupOf) => {
    const best = new Map();
    for (const e of entries) {
      const g = groupOf(e);
      const cur = best.get(g);
      if (!cur || beats(e, cur, weights, fallback)) best.set(g, e);
    }
    return [...best.values()];
  };
  const all = Object.keys(builtMons).map((key) => ({ key, built: builtMons[key] }));
  const perLineage = bestBy(all, (e) => e.built.lineageKey ?? e.key);
  const perBuild = bestBy(perLineage, (e) => usageIdOf(e.built));
  const out = {};
  for (const e of perBuild) out[e.key] = e.built;
  return out;
}

/**
 * The sampling pool of a real-collection run: every key of `builtMons` not in
 * `excludeSpecies`; with `poolSize`, only the species of the `poolSize`
 * best-ranked builds (a shadow twin rides along once its species is in).
 * Sorted best-ranked first, ties by key.
 *
 * @param {Record<string, object>} builtMons - already deduped.
 * @param {Map<string, number>} weights
 * @param {number|undefined} poolSize - species count; falsy or <= 0 = no cap.
 * @param {Iterable<string>} [excludeSpecies]
 * @returns {string[]} userMonKeys.
 */
export function buildRankedPool(builtMons, weights, poolSize, excludeSpecies = []) {
  const exclude = new Set(excludeSpecies);
  const fallback = lastPlaceWeight(weights);
  const ranked = Object.keys(builtMons)
    .filter((key) => !exclude.has(builtMons[key].speciesId))
    .map((key) => ({ key, speciesId: builtMons[key].speciesId, w: rankWeightOf(builtMons[key], weights, fallback) }))
    .sort((a, b) => b.w - a.w || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (!poolSize || poolSize <= 0) return ranked.map((m) => m.key);
  const kept = new Set();
  for (const m of ranked) {
    if (kept.size >= poolSize && !kept.has(m.speciesId)) break;
    kept.add(m.speciesId);
  }
  return ranked.filter((m) => kept.has(m.speciesId)).map((m) => m.key);
}
