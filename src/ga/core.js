// Shared GA scaffolding used by both src/teams/evolve.js (the candidate-side
// GA) and src/meta/opponentPool.js (the opponent-side GA). Pure functions
// only -- no battle math, no engine boot -- so both sides (and this module's
// own tests) can exercise it against fake fitness arrays.
//
// This does NOT attempt a literal merge of the two GAs' selection loops --
// see out/plan-unify-ga.md for why (population element shape, growth
// direction, curated/protected-origin handling and immigrant sourcing
// genuinely differ). What lands here is the machinery that WAS drifting
// apart for no reason: archetype-pair crowding weights for the voting side
// (previously species-share on the candidate side, archetype-pair on the
// opponent side) and trailing-mean selection smoothing (previously
// candidate-only). Shadow-twin rivalry, once a third shared helper here,
// lives in src/meta/archetypes.js coreRivalryFitness as the whole-team
// similarity term of core rivalry.

import { archetypeGroups, archetypeWeights } from '../meta/archetypes.js';

/**
 * Archetype-pair crowding weight per entry (src/meta/archetypes.js
 * archetypeGroups/archetypeWeights), generalised over WHAT an entry is via
 * `membersOf(entry)`. The opponent GA already discounted a crowded bred core
 * this way when the opponent pool votes on candidate fitness; this is the
 * same scheme applied to whichever population is doing the voting, so both
 * sides normalise their voters on one scheme instead of two.
 *
 * @param {Array} entries
 * @param {(entry: any) => Array<{speciesId?: string, spec?: {speciesId: string}}>} membersOf
 * @param {{beta?: number}} [opts]
 * @returns {number[]} weight per entry, parallel to `entries`.
 */
export function crowdingWeights(entries, membersOf, opts = {}) {
  const shaped = entries.map((entry) => ({ members: membersOf(entry) }));
  const groups = archetypeGroups(shaped);
  return archetypeWeights(groups, opts);
}

/**
 * Generalised trailing-mean fitness: a recency-weighted mean of an entry's
 * own fitness over the last `trailing` generations it appeared in, matched
 * across generations by `signature(entry)` rather than any one side's team
 * shape -- the generation `age` steps back from the newest contributes
 * `decay ** age` of the weight, exactly as src/teams/evolve.js's
 * `trailingFitness` (which now delegates here) has always done for
 * candidates. A team seen once is scored on that one sample; `trailing: 1`
 * returns the newest generation's raw fitness unchanged regardless of
 * `decay`.
 *
 * @param {Array<{population: any[], fitness: number[]}>} history - ordered
 *   oldest-to-newest; the newest entry is the one scored.
 * @param {(entry: any) => string} signature
 * @param {number} trailing - generations in the window.
 * @param {number} decay - per-generation-back weight decay.
 * @returns {number[]} parallel to `history[last].population`.
 */
export function trailingFitnessGeneric(history, signature, trailing, decay) {
  if (!Array.isArray(history) || history.length === 0) return [];
  const end = history.length - 1;
  const start = Math.max(0, end - Math.max(1, trailing) + 1);
  const sums = new Map();
  const weights = new Map();
  const alive = new Set(history[end].population.map(signature));
  for (let g = start; g <= end; g++) {
    const weight = decay ** (end - g);
    const { population, fitness } = history[g];
    for (let i = 0; i < population.length; i++) {
      const sig = signature(population[i]);
      if (!alive.has(sig)) continue;
      sums.set(sig, (sums.get(sig) ?? 0) + fitness[i] * weight);
      weights.set(sig, (weights.get(sig) ?? 0) + weight);
    }
  }
  const scores = new Map();
  for (const [sig, sum] of sums) scores.set(sig, sum / weights.get(sig));
  return history[end].population.map((entry, i) => scores.get(signature(entry)) ?? history[end].fitness[i]);
}
