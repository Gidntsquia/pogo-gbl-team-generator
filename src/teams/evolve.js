// JavaScript Document
//
// GA core module ("survival of the fittest"; the locked-lead representation
// was a later addition). Pure generational
// logic -- selection, mutation, immigration, convergence -- with NO battles
// inside, so it is unit-testable against fake fitness arrays without booting
// the pvpoke engine. `scripts/evolve.mjs` is the driver that actually
// runs battles (via the persistent executor) to produce each generation's
// `fitness` array and feeds it back into `nextGeneration`.
//
// A "team" here is the same shape used throughout src/teams/*: an array of 3
// distinct userMonKeys (matrix.ratings/matrix.builtMons keys), no duplicate
// species within a team (shadow/base share a species, same rule as
// src/teams/index.js's dedupeBestPerSpecies and src/teams/sample.js's
// sampleCandidateTeams). GA code is sampling machinery, not battle math --
// vendor stays untouched, no pvpoke import here at all.
//
// LOCKED LEADS (Jaxon): a team is (lead, back1, back2), not an
// unordered trio -- by convention `team[0]` is the designated lead and
// `team[1]`/`team[2]` are the backs (their relative order carries no
// meaning). Individual IDENTITY for dedup/uniqueness purposes is therefore
// (lead, {backs}) -- the SAME 3 species with a DIFFERENT lead is a DIFFERENT
// individual (see `teamSignature`). `initPopulation` assigns each freshly
// -sampled species-set a seeded-random lead; mutation gains a second type,
// lead-rotation (promote a back to lead), alongside the pre-existing member
// -swap type -- see `DEFAULT_LEAD_ROTATION_RATE`. Downstream battle-driving
// code (scripts/evolve.mjs) deciding to evaluate a team ONLY at its own
// `team[0]` lead (a ~3x battle-count saving) is NOT this module's
// concern -- this module only defines and evolves the representation.

import { rngFromSeed, pickWeighted } from '../util/rng.js';
import {
  sampleCandidateTeams,
  buildScoredPool,
  makeBlendedWeightFn,
  DEFAULT_BLEND_ALPHA,
} from './sample.js';

const TEAM_SIZE = 3;
const BACK_SLOTS = [1, 2];

// Selection defaults, revised 2026-08-21 by Jaxon: bottom-50%
// death was judged "too harsh" -- only a quarter of the population dies each
// generation, and mutation is a probabilistic roll (not a deterministic
// top-quartile entitlement) whose odds simply rise with fitness percentile.
export const DEFAULT_DEATH_RATE = 1 / 3; // Jaxon 2026-08-22: bottom third dies (was 0.25)
export const DEFAULT_MUTATION_FLOOR = 0.05;
export const DEFAULT_MUTATION_CEIL = 0.4;
// Of the mutation successes rolled via mutationFloor/Ceil above, this share
// become a LEAD-ROTATION (promote a back to lead, same species-set) instead
// of a member-swap (replace one slot's species): lead-rotation is a mutation
// type in its own right, alongside member-swap. 0.3 is a documented
// judgment call (no value was specified for it): common enough that lead
// -assignment is genuinely explored by evolution, but member-swap (which
// still explores species composition, including at the lead slot) stays the
// majority of mutations, matching its pre-existing primacy.
export const DEFAULT_LEAD_ROTATION_RATE = 0.3;
// A floor of ~10% of P fresh IMMIGRANT teams is always reserved.
export const DEFAULT_IMMIGRANT_FRACTION = 0.1;
export const DEFAULT_CONVERGENCE_WINDOW = 3;
export const DEFAULT_CONVERGENCE_TOP_N = 10;

// Sampling without replacement (mutant swap-ins, immigrant draws) can collide
// with an already-used species-set signature, especially on a small pool;
// collisions are discarded and retried rather than kept. Mirrors
// src/teams/sample.js's own MAX_ATTEMPTS pattern.
const MAX_ATTEMPTS_MULTIPLIER = 20;
const MAX_ATTEMPTS_FLOOR = 50;

/**
 * Identity signature for a LOCKED-LEAD team: `team[0]` (the lead) plus the
 * sorted set of `team[1]`/`team[2]` (the backs, unordered). Two teams with
 * the same 3 species but a DIFFERENT lead produce DIFFERENT signatures --
 * same trio, different lead = different individual -- so
 * every uniqueness/dedup check in this module (population fill, mutant/
 * immigrant collision checks, convergence's top-N set) is lead-aware for
 * free by routing through this one function.
 */
function teamSignature(team) {
  return `${team[0]}||${[...team.slice(1)].sort().join('|')}`;
}

/**
 * Assign a seeded-random lead to an unordered 3-species team by rotating the
 * chosen slot into index 0 (swap with whatever was already there). Used both
 * by `initPopulation` (every freshly-sampled gen-0 team needs a lead) and by
 * `nextGeneration`'s immigrant draw (fresh `sampleCandidateTeams` results are
 * likewise unordered and need one assigned before they can be compared by
 * `teamSignature`).
 */
function assignLead(team, rng) {
  const leadSlot = Math.floor(rng() * TEAM_SIZE) % TEAM_SIZE;
  if (leadSlot === 0) return team.slice();
  const reordered = team.slice();
  [reordered[0], reordered[leadSlot]] = [reordered[leadSlot], reordered[0]];
  return reordered;
}

/**
 * Gen 0: delegate straight to `sampleCandidateTeams` for WHICH 3 species
 * make up each team (`initPopulation` is deliberately a thin
 * wrapper -- the weighted 1v1-score / meta-usage blend that seeds candidate
 * teams elsewhere in the app is exactly what should seed generation zero
 * too), then assign each team a seeded-random lead (locked
 * leads) -- `sampleCandidateTeams` already guarantees unique species-sets,
 * and a single lead-assignment per gen-0 team can't collide with itself, so
 * no retry loop is needed here.
 *
 * @param {{matrix:object, pool:string[], weights?:Map<string,number>,
 *   count:number, seed?:number|string, excludeSpecies?:string[]}} params
 * @returns {string[][]} up to `count` unique 3-userMonKey teams, each with
 *   `team[0]` as its designated lead.
 */
export function initPopulation({ matrix, pool, weights, count, seed, excludeSpecies }) {
  const teams = sampleCandidateTeams({ matrix, pool, weights, count, seed, excludeSpecies });
  const rng = rngFromSeed(seed, 'initPopulation-lead');
  return teams.map((team) => assignLead(team, rng));
}

/**
 * Roll each survivor's mutation chance in a fixed, seed-derived order
 * (ascending fitness among survivors -- i.e. always the same order for the
 * same inputs) and return the ones that rolled a success, in that same
 * order, each tagged with its fitness percentile among survivors and which
 * mutation TYPE it rolled (a second, immediately-following rng() draw on
 * success only, so the sequence stays fully deterministic under a fixed
 * seed): `'leadRotation'` with probability `leadRotationRate`, else
 * `'memberSwap'` (the two mutation types).
 */
function rollMutations(survivorIndicesByFitnessAsc, fitness, mutationFloor, mutationCeil, leadRotationRate, rng) {
  const n = survivorIndicesByFitnessAsc.length;
  const successes = [];
  survivorIndicesByFitnessAsc.forEach((idx, rank) => {
    const percentile = n <= 1 ? 1 : rank / (n - 1);
    const chance = mutationFloor + (mutationCeil - mutationFloor) * percentile;
    const roll = rng();
    if (roll < chance) {
      const typeRoll = rng();
      const type = typeRoll < leadRotationRate ? 'leadRotation' : 'memberSwap';
      successes.push({ idx, percentile, type });
    }
  });
  return successes;
}

/**
 * Attempt to build one member-swap mutant of `parentTeam`: pick a uniform
 * -random slot (any of the 3, including the lead slot 0 -- replacing the
 * lead's species still counts as a member swap; the dedicated
 * lead-ROTATION mutation below is the one that changes only WHO leads, not
 * WHICH species are on the team), replace it with a DIFFERENT eligible pool
 * mon (P(new mon) proportional to the score/usage blend), retrying a
 * bounded number of times if the result collides with an already-used team
 * signature (`usedSignatures`) or no eligible replacement exists for the
 * chosen slot. Returns `{team, swappedSlot}` or `null` if no valid mutant
 * could be found within the attempt budget.
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
 * Attempt to build one lead-rotation mutant of `parentTeam`:
 * promote a uniform-random BACK slot (index 1 or 2) into the lead slot
 * (index 0), demoting the current lead into that back slot -- same 3
 * species, a different designated lead, hence a different individual under
 * `teamSignature`. Retries on a signature collision (there are only 2
 * possible rotations of a 3-member team, so this exhausts quickly if both
 * are already taken). Returns `{team, promotedSlot}` or `null`.
 */
function buildLeadRotation(parentTeam, usedSignatures, rng, maxAttempts) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const promotedSlot = BACK_SLOTS[Math.floor(rng() * BACK_SLOTS.length) % BACK_SLOTS.length];
    const rotated = parentTeam.slice();
    [rotated[0], rotated[promotedSlot]] = [rotated[promotedSlot], rotated[0]];
    const signature = teamSignature(rotated);
    if (usedSignatures.has(signature)) continue;
    usedSignatures.add(signature);
    return { team: rotated, promotedSlot };
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
 * re-evaluated by the caller, never carried over stale, by design).
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
 *     leadRotationRate?: number, immigrantFraction?: number, alpha?: number,
 *     excludeSpecies?: string[],
 *   },
 * }} params
 * @returns {{
 *   population: string[][],
 *   lineage: {
 *     died: number[],
 *     entries: Array<
 *       {origin:'survived', parentIndex:number} |
 *       {origin:'mutant', parentIndex:number, mutationType:'memberSwap', swappedSlot:number} |
 *       {origin:'mutant', parentIndex:number, mutationType:'leadRotation', promotedSlot:number} |
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
 *   which mutation it got -- a member-swap's changed slot, or a lead
 *   -rotation's promoted slot), or a fresh immigrant. Every returned team
 *   still has `team[0]` as its designated lead.
 */
export function nextGeneration({ population, fitness, pool, matrix, weights, seed, opts = {} }) {
  const P = population.length;
  if (P === 0) return { population: [], lineage: { died: [], entries: [] } };

  const deathRate = opts.deathRate ?? DEFAULT_DEATH_RATE;
  const mutationFloor = opts.mutationFloor ?? DEFAULT_MUTATION_FLOOR;
  const mutationCeil = opts.mutationCeil ?? DEFAULT_MUTATION_CEIL;
  const leadRotationRate = opts.leadRotationRate ?? DEFAULT_LEAD_ROTATION_RATE;
  const immigrantFraction = opts.immigrantFraction ?? DEFAULT_IMMIGRANT_FRACTION;
  const alpha = typeof opts.alpha === 'number' ? opts.alpha : DEFAULT_BLEND_ALPHA;
  const excludeSpecies = opts.excludeSpecies ?? [];
  const rng = rngFromSeed(seed, 'nextGeneration');

  // Worst-fitness-first ranking (ties broken by original index for determinism).
  const rankedWorstFirst = population.map((_, i) => i).sort((a, b) => fitness[a] - fitness[b] || a - b);
  const deathCount = Math.min(P, Math.round(deathRate * P));
  const died = rankedWorstFirst.slice(0, deathCount);
  const survivorIndicesAsc = rankedWorstFirst.slice(deathCount); // still worst-to-best among survivors

  const mutationSuccesses = rollMutations(survivorIndicesAsc, fitness, mutationFloor, mutationCeil, leadRotationRate, rng);

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
  for (const { idx, type } of chosenMutants) {
    if (type === 'leadRotation') {
      const built = buildLeadRotation(population[idx], usedSignatures, rng, mutantMaxAttempts);
      if (!built) continue; // bounded retries exhausted (both rotations already taken) -- drop, graceful shortfall
      mutantEntries.push({ team: built.team, parentIndex: idx, mutationType: 'leadRotation', promotedSlot: built.promotedSlot });
    } else {
      const built = buildMutant(population[idx], matrix, scoredPool, weightFn, usedSignatures, rng, mutantMaxAttempts);
      if (!built) continue; // bounded retries exhausted -- drop this mutant, graceful shortfall
      mutantEntries.push({ team: built.team, parentIndex: idx, mutationType: 'memberSwap', swappedSlot: built.swappedSlot });
    }
  }

  // Immigrants: fresh sampleCandidateTeams draw, over-requested so post-dedupe
  // filtering still has a shot at hitting the target count, seeded from this
  // function's own rng stream so the whole generation stays one deterministic
  // draw under `seed` (no wall-clock, no second independent seed to track).
  // Each drawn (unordered) species-set gets a seeded lead assigned the same
  // way initPopulation does BEFORE the signature check, since identity is
  // now lead-aware -- an immigrant sharing an existing species-set but with
  // a different lead is a legitimately distinct individual, not a collision.
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
      const withLead = assignLead(team, rng);
      const signature = teamSignature(withLead);
      if (usedSignatures.has(signature)) continue;
      usedSignatures.add(signature);
      immigrantEntries.push(withLead);
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
    ...mutantEntries.map((m) => (
      m.mutationType === 'leadRotation'
        ? { origin: 'mutant', parentIndex: m.parentIndex, mutationType: 'leadRotation', promotedSlot: m.promotedSlot }
        : { origin: 'mutant', parentIndex: m.parentIndex, mutationType: 'memberSwap', swappedSlot: m.swappedSlot }
    )),
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
 * Convergence: converged once the top-N (default 10, by
 * fitness) team-composition set has been IDENTICAL for `window` (default 3)
 * consecutive generations. Deliberately does NOT know about `--generations`
 * caps or `--deadline-minutes` -- those are scripts/evolve.mjs's job,
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
