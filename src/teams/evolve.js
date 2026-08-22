// JavaScript Document
//
// GA core module (GOALS T23, PLAN.md Rev 5 "survival of the fittest"). Pure
// generational logic -- selection, mutation, immigration, convergence -- with
// NO battles inside, so it is unit-testable against fake fitness arrays
// without booting the pvpoke engine. `scripts/evolve.mjs` (T24) is the driver
// that actually runs battles (via the Rev 4 executor) to produce each
// generation's `fitness` array and feeds it back into `nextGeneration`.
//
// A "team" here is the same shape used throughout src/teams/*: an array of 3
// distinct userMonKeys (matrix.ratings/matrix.builtMons keys), no duplicate
// species within a team (shadow/base share a species, same rule as
// src/teams/index.js's dedupeBestPerSpecies and src/teams/sample.js's
// sampleCandidateTeams). GA code is sampling machinery, not battle math --
// vendor stays untouched, no pvpoke import here at all.

import { rngFromSeed, pickWeighted } from '../util/rng.js';
import {
  sampleCandidateTeams,
  buildScoredPool,
  makeBlendedWeightFn,
  DEFAULT_BLEND_ALPHA,
} from './sample.js';

const TEAM_SIZE = 3;

// Selection defaults, revised 2026-08-21 by Jaxon (PLAN Rev 5): bottom-50%
// death was judged "too harsh" -- only a quarter of the population dies each
// generation, and mutation is a probabilistic roll (not a deterministic
// top-quartile entitlement) whose odds simply rise with fitness percentile.
export const DEFAULT_DEATH_RATE = 1 / 3; // Jaxon 2026-08-22: bottom third dies (was 0.25)
export const DEFAULT_MUTATION_FLOOR = 0.05;
export const DEFAULT_MUTATION_CEIL = 0.4;
// "a floor of ~10% of P fresh IMMIGRANT teams is always reserved" (PLAN Rev 5).
export const DEFAULT_IMMIGRANT_FRACTION = 0.1;
export const DEFAULT_CONVERGENCE_WINDOW = 3;
export const DEFAULT_CONVERGENCE_TOP_N = 10;

// Sampling without replacement (mutant swap-ins, immigrant draws) can collide
// with an already-used species-set signature, especially on a small pool;
// collisions are discarded and retried rather than kept. Mirrors
// src/teams/sample.js's own MAX_ATTEMPTS pattern.
const MAX_ATTEMPTS_MULTIPLIER = 20;
const MAX_ATTEMPTS_FLOOR = 50;

/** Sorted-key signature for a team, used to dedupe the population by composition. */
function teamSignature(team) {
  return [...team].sort().join('|');
}

/**
 * Gen 0: delegate straight to `sampleCandidateTeams` (PLAN Rev 5's
 * `initPopulation` is explicitly a thin wrapper -- the weighted 1v1-score /
 * meta-usage blend that seeds candidate teams elsewhere in the app is
 * exactly what should seed generation zero too).
 *
 * @param {{matrix:object, pool:string[], weights?:Map<string,number>,
 *   count:number, seed?:number|string, excludeSpecies?:string[]}} params
 * @returns {string[][]} up to `count` unique 3-userMonKey teams.
 */
export function initPopulation({ matrix, pool, weights, count, seed, excludeSpecies }) {
  return sampleCandidateTeams({ matrix, pool, weights, count, seed, excludeSpecies });
}

/**
 * Roll each survivor's mutation chance in a fixed, seed-derived order
 * (ascending fitness among survivors -- i.e. always the same order for the
 * same inputs) and return the ones that rolled a success, in that same
 * order, each tagged with its fitness percentile among survivors.
 */
function rollMutations(survivorIndicesByFitnessAsc, fitness, mutationFloor, mutationCeil, rng) {
  const n = survivorIndicesByFitnessAsc.length;
  const successes = [];
  survivorIndicesByFitnessAsc.forEach((idx, rank) => {
    const percentile = n <= 1 ? 1 : rank / (n - 1);
    const chance = mutationFloor + (mutationCeil - mutationFloor) * percentile;
    const roll = rng();
    if (roll < chance) successes.push({ idx, percentile });
  });
  return successes;
}

/**
 * Attempt to build one mutant of `parentTeam`: pick a uniform-random slot,
 * replace it with a DIFFERENT eligible pool mon (P(new mon) proportional to
 * the Rev 3 score/usage blend), retrying a bounded number of times if the
 * result collides with an already-used team signature (`usedSignatures`) or
 * no eligible replacement exists for the chosen slot. Returns
 * `{team, swappedSlot}` or `null` if no valid mutant could be found within
 * the attempt budget.
 */
function buildMutant(parentTeam, matrix, scoredPool, weightFn, usedSignatures, rng, maxAttempts) {
  const currentSpecies = new Set(parentTeam.map((key) => matrix.builtMons[key].speciesId));
  const eligible = scoredPool.filter((entry) => !currentSpecies.has(entry.speciesId));
  if (eligible.length === 0) return null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const slotIndex = Math.floor(rng() * TEAM_SIZE) % TEAM_SIZE;
    const picked = pickWeighted(rng, eligible, weightFn, 1);
    if (picked.length === 0) return null; // no positive-weight candidate at all -- won't improve on retry
    const mutantTeam = parentTeam.slice();
    mutantTeam[slotIndex] = picked[0].key;
    const signature = teamSignature(mutantTeam);
    if (usedSignatures.has(signature)) continue;
    usedSignatures.add(signature);
    return { team: mutantTeam, swappedSlot: slotIndex };
  }
  return null;
}

/**
 * Advance one generation: rank by this generation's fitness, kill the bottom
 * `deathRate` fraction, roll each survivor's fitness-percentile-scaled
 * mutation chance, fill the freed slots with the resulting mutants (capped,
 * oversubscription favors higher-percentile parents) plus fresh immigrants
 * (an always-reserved ~`immigrantFraction` of P, grown further if mutation
 * undersubscribes), and dedupe the whole next population by species-set
 * composition. Pure -- no battles run here; `fitness[i]` must already be
 * `population[i]`'s measured win rate for THIS generation (elites are always
 * re-evaluated by the caller, never carried over stale, per PLAN Rev 5).
 *
 * @param {{
 *   population: string[][],
 *   fitness: number[],
 *   pool: string[],
 *   matrix: object,
 *   weights?: Map<string, number>,
 *   seed?: number|string,
 *   opts?: {
 *     deathRate?: number, mutationFloor?: number, mutationCeil?: number,
 *     immigrantFraction?: number, alpha?: number, excludeSpecies?: string[],
 *   },
 * }} params
 * @returns {{
 *   population: string[][],
 *   lineage: {
 *     died: number[],
 *     entries: Array<
 *       {origin:'survived', parentIndex:number} |
 *       {origin:'mutant', parentIndex:number, swappedSlot:number} |
 *       {origin:'immigrant'}
 *     >,
 *   },
 * }}
 *   `population` is held at exactly `population.length` (the input P) UNLESS
 *   the pool is too small to supply enough distinct new teams, in which case
 *   it gracefully falls short (mirrors sampleCandidateTeams' own cap
 *   behavior) rather than throwing or looping forever. `lineage.died` lists
 *   the OLD population's dead indices, worst-fitness first. `lineage.entries`
 *   is parallel to the RETURNED `population` (same order, same length): each
 *   entry says whether that slot is an unchanged survivor (with its index in
 *   the OLD population), a mutant (with its OLD-population parent index and
 *   which slot got swapped), or a fresh immigrant.
 */
export function nextGeneration({ population, fitness, pool, matrix, weights, seed, opts = {} }) {
  const P = population.length;
  if (P === 0) return { population: [], lineage: { died: [], entries: [] } };

  const deathRate = opts.deathRate ?? DEFAULT_DEATH_RATE;
  const mutationFloor = opts.mutationFloor ?? DEFAULT_MUTATION_FLOOR;
  const mutationCeil = opts.mutationCeil ?? DEFAULT_MUTATION_CEIL;
  const immigrantFraction = opts.immigrantFraction ?? DEFAULT_IMMIGRANT_FRACTION;
  const alpha = typeof opts.alpha === 'number' ? opts.alpha : DEFAULT_BLEND_ALPHA;
  const excludeSpecies = opts.excludeSpecies ?? [];
  const rng = rngFromSeed(seed, 'nextGeneration');

  // Worst-fitness-first ranking (ties broken by original index for determinism).
  const rankedWorstFirst = population.map((_, i) => i).sort((a, b) => fitness[a] - fitness[b] || a - b);
  const deathCount = Math.min(P, Math.round(deathRate * P));
  const died = rankedWorstFirst.slice(0, deathCount);
  const survivorIndicesAsc = rankedWorstFirst.slice(deathCount); // still worst-to-best among survivors

  const mutationSuccesses = rollMutations(survivorIndicesAsc, fitness, mutationFloor, mutationCeil, rng);

  const deadSlots = P - survivorIndicesAsc.length;
  const immigrantFloor = Math.min(deadSlots, Math.round(immigrantFraction * P));
  const mutantSlotsAvailable = Math.max(deadSlots - immigrantFloor, 0);

  let chosenMutants;
  let immigrantCount;
  if (mutationSuccesses.length > mutantSlotsAvailable) {
    // Oversubscription: keep the highest-percentile parents' rolls.
    chosenMutants = mutationSuccesses
      .slice()
      .sort((a, b) => b.percentile - a.percentile || a.idx - b.idx)
      .slice(0, mutantSlotsAvailable);
    immigrantCount = immigrantFloor;
  } else {
    // Undersubscription (or exact fit): every successful roll gets a slot,
    // and the immigrant share grows to fill whatever's left over.
    chosenMutants = mutationSuccesses;
    immigrantCount = deadSlots - chosenMutants.length;
  }

  const survivorsOut = survivorIndicesAsc
    .slice()
    .sort((a, b) => a - b) // restore original population order among survivors
    .map((idx) => population[idx]);

  const usedSignatures = new Set(survivorsOut.map(teamSignature));
  const excludeSet = new Set(excludeSpecies);
  const scoredPool = buildScoredPool(matrix, pool, excludeSet);
  const weightFn = makeBlendedWeightFn(scoredPool, weights, alpha);
  const mutantMaxAttempts = Math.max(chosenMutants.length, 1) * MAX_ATTEMPTS_MULTIPLIER + MAX_ATTEMPTS_FLOOR;

  const mutantEntries = [];
  for (const { idx } of chosenMutants) {
    const built = buildMutant(population[idx], matrix, scoredPool, weightFn, usedSignatures, rng, mutantMaxAttempts);
    if (!built) continue; // bounded retries exhausted -- drop this mutant, graceful shortfall
    mutantEntries.push({ team: built.team, parentIndex: idx, swappedSlot: built.swappedSlot });
  }

  // Immigrants: fresh sampleCandidateTeams draw, over-requested so post-dedupe
  // filtering still has a shot at hitting the target count, seeded from this
  // function's own rng stream so the whole generation stays one deterministic
  // draw under `seed` (no wall-clock, no second independent seed to track).
  const immigrantEntries = [];
  if (immigrantCount > 0) {
    const requestCount = immigrantCount * MAX_ATTEMPTS_MULTIPLIER + MAX_ATTEMPTS_FLOOR;
    const immigrantSeed = Math.floor(rng() * 0xffffffff);
    const drawn = sampleCandidateTeams({
      matrix,
      pool,
      weights,
      count: requestCount,
      seed: immigrantSeed,
      excludeSpecies,
      alpha,
    });
    for (const team of drawn) {
      if (immigrantEntries.length >= immigrantCount) break;
      const signature = teamSignature(team);
      if (usedSignatures.has(signature)) continue;
      usedSignatures.add(signature);
      immigrantEntries.push(team);
    }
  }

  const nextPopulation = [
    ...survivorsOut,
    ...mutantEntries.map((m) => m.team),
    ...immigrantEntries,
  ];

  const entries = [
    ...survivorIndicesAsc
      .slice()
      .sort((a, b) => a - b)
      .map((idx) => ({ origin: 'survived', parentIndex: idx })),
    ...mutantEntries.map((m) => ({ origin: 'mutant', parentIndex: m.parentIndex, swappedSlot: m.swappedSlot })),
    ...immigrantEntries.map(() => ({ origin: 'immigrant' })),
  ];

  return { population: nextPopulation, lineage: { died, entries } };
}

/** Top-N-by-fitness team signatures for one `{population, fitness}` generation snapshot. */
function topSetSignature(generation, topN) {
  const { population, fitness } = generation;
  const rankedBestFirst = population.map((_, i) => i).sort((a, b) => fitness[b] - fitness[a] || a - b);
  const top = rankedBestFirst.slice(0, Math.min(topN, population.length));
  return new Set(top.map((i) => teamSignature(population[i])));
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/**
 * Convergence per PLAN Rev 5: converged once the top-N (default 10, by
 * fitness) team-composition set has been IDENTICAL for `window` (default 3)
 * consecutive generations. Deliberately does NOT know about `--generations`
 * caps or `--deadline-minutes` -- those are scripts/evolve.mjs's (T24) job,
 * driven by wall-clock/config concerns this pure module has no business
 * touching.
 *
 * @param {Array<{population: string[][], fitness: number[]}>} history
 *   Ordered oldest-to-newest, one entry per generation actually run.
 * @param {{window?: number, topN?: number}} [opts]
 * @returns {{converged: boolean, reason: string|null}}
 */
export function hasConverged(history, opts = {}) {
  const window = opts.window ?? DEFAULT_CONVERGENCE_WINDOW;
  const topN = opts.topN ?? DEFAULT_CONVERGENCE_TOP_N;
  if (!Array.isArray(history) || history.length < window) {
    return { converged: false, reason: null };
  }
  const recent = history.slice(-window);
  const signatures = recent.map((generation) => topSetSignature(generation, topN));
  const stable = signatures.every((set) => setsEqual(set, signatures[0]));
  if (!stable) return { converged: false, reason: null };
  return {
    converged: true,
    reason: `top-${topN} composition unchanged for ${window} consecutive generations`,
  };
}
