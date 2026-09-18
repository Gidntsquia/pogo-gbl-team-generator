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
// -swap type -- see `DEFAULT_LEAD_ROTATION_RATE`. A third type, shadow-flip
// (`DEFAULT_SHADOW_FLIP_RATE`), swaps a random non-empty subset of members for
// their opposite-shadow twins when the pool holds both; a team and its shadow-twin then share a
// `shadowBlindSignature` and compete hard for one seat (the twin load of
// src/meta/archetypes.js coreRivalryFitness: a shadow and its base are
// near-maximally similar, 0.9, so the weaker twin is charged 2.8 rivalry
// steps against the better one -- high, but not a death sentence, so a twin
// that fights well still lives; the final ranking keeps one per signature).
// Downstream battle-driving
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
import { candidateProfiles, DEFAULT_CORE_RIVALRY, DEFAULT_SIMILAR_RIVALRY, DEFAULT_SIMILAR_FLOOR } from '../meta/archetypes.js';
import { createSimilarity } from '../engine/similarity.js';
import { trailingFitnessGeneric, evolveStep } from '../ga/core.js';

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
// Of the mutation successes, this share become a SHADOW-FLIP (swap a random
// non-empty subset of the flippable members for their opposite-shadow twins
// -- same species, same lead, only shadow flags change). Rolled AFTER
// lead-rotation on the same type draw, so with the defaults a success is 30%
// lead-rotation, 20% shadow-flip, 50% member-swap (Jaxon 2026-09-10: 0.15 ->
// 0.3 -> 0.2). Every combination of flips is equally likely, not just single
// flips: a trio may only clear the damage breakpoints it needs with two or
// three shadows at once, and a one-flip-at-a-time walk would see each
// intermediate step die and never get there (and vice versa for shedding
// shadows). A shadow-flip only exists when the pool actually holds the twin
// (see `buildShadowTwins`); when the chosen parent has no flippable slot the
// roll falls through to a member-swap, so a collection with no shadow twins
// evolves exactly as it did before this type was added.
export const DEFAULT_SHADOW_FLIP_RATE = 0.2;
// A floor of ~10% of P fresh IMMIGRANT teams is always reserved.
export const DEFAULT_IMMIGRANT_FRACTION = 0.1;
// Convergence (see `hasConverged`). TRAILING is the number of generations of
// a team's own fitness history averaged before teams are ranked against each
// other -- 10 was chosen from four real runs (383 generations): it takes
// late-run top-10 turnover to 1.2-1.9 per generation against 2.8-5.0 in the
// first quarter, a separation that a 5-generation window does not produce
// (2.2-2.9 vs 3.2-5.2, which overlap). MAX_CHURN sat at 1 (below the 1.2-1.9
// noise floor a still-moving run cannot hold under) until the meta-top200-1
// run showed a rule tolerating 1 swap/gen still lets the top teams visibly
// reshuffle across a "converged" stretch: its late-run smoothed churn trail
// was 1 1 1 0 0 1 0 -- zero-churn generations are routine once a run truly
// settles -- so the top-10 must now hold IDENTICAL for the whole window, and
// the --generations cap is the backstop for a run that never fully freezes.
// MIN_LIFT_GAIN is half a point of win rate: smaller than any per-quarter
// gain observed while a run was still improving. WINDOW sat at 3 until the
// meta-top200-1 run (2026-08-26) stopped at the FIRST generation a 3-streak
// existed -- replaying its 33-generation history, no window of 4 or more ever
// fired -- so a run now has to hold still for 6 consecutive generations
// before it is called done.
export const DEFAULT_CONVERGENCE_WINDOW = 6;
export const DEFAULT_CONVERGENCE_TOP_N = 10;
export const DEFAULT_CONVERGENCE_TRAILING = 10;
export const DEFAULT_CONVERGENCE_MAX_CHURN = 0;
export const DEFAULT_CONVERGENCE_MIN_LIFT_GAIN = 0.005;
// SELECTION's own trailing window (trailingFitness), independent of
// convergence's. 10 generations turned out too slow to react: at 35%/gen
// opponent turnover a team's environment is meaningfully different 10
// generations back, so averaging that far diluted a team that had genuinely
// improved with stale early-window noise. 5, weighted toward the most recent
// generations (DEFAULT_SELECTION_RECENCY_DECAY), still smooths the 3.9-point
// single-generation swing the s2 post-mortem measured while reacting faster
// to real drift (Jaxon 2026-09-05).
export const DEFAULT_SELECTION_TRAILING = 5;
// Exponential per-generation-back decay applied by trailingFitness: the
// newest generation in the window weighs 1, the one before it
// DEFAULT_SELECTION_RECENCY_DECAY, two back its square, etc. 0.6 halves a
// generation's influence roughly every generation and a half -- old enough to
// still smooth noise, recent enough that a team's current form dominates its
// score.
export const DEFAULT_SELECTION_RECENCY_DECAY = 0.6;

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
 * SHADOW-BLIND identity: the same lead-aware shape as `teamSignature`, but
 * built from each member's base speciesId instead of its userMonKey, so a
 * team and its shadow-twin (identical species and lead, one or more members
 * flipped between shadow and non-shadow) collapse to ONE signature. Two
 * teams sharing it are twins: `nextGeneration` ranks the weaker one under a
 * heavy core-rivalry penalty (coreRivalryFitness's twin load, `twins:
 * 'lead'`, is this same lead-aware shape scored on member similarity), and
 * the final ranking (scripts/evolve.mjs) keeps one per signature, so a
 * report never lists the same trio several times differing only in who is
 * shadow.
 *
 * @param {string[]} team - 3 userMonKeys, `team[0]` the lead.
 * @param {object} matrix - needs `builtMons[key].speciesId`.
 * @returns {string}
 */
export function shadowBlindSignature(team, matrix) {
  const species = team.map((key) => matrix.builtMons[key].speciesId);
  return `${species[0]}||${[...species.slice(1)].sort().join('|')}`;
}

/**
 * For every pool key, the key of its opposite-shadow twin (same speciesId,
 * opposite `spec.shadow` flag) when the pool holds one -- the target a
 * shadow-flip mutation swaps to. Species that are excluded, or that the pool
 * holds in only one shadow state, get no entry.
 */
function buildShadowTwins(matrix, pool, excludeSet) {
  const bySpecies = new Map();
  for (const key of pool) {
    const built = matrix.builtMons[key];
    if (!built || excludeSet.has(built.speciesId)) continue;
    const group = bySpecies.get(built.speciesId) ?? { shadow: null, base: null };
    group[built.spec?.shadow ? 'shadow' : 'base'] ??= key;
    bySpecies.set(built.speciesId, group);
  }
  const twins = new Map();
  for (const { shadow, base } of bySpecies.values()) {
    if (shadow && base) {
      twins.set(shadow, base);
      twins.set(base, shadow);
    }
  }
  return twins;
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
 *   count:number, seed?:number|string, excludeSpecies?:string[], alpha?:number}} params
 *   `alpha` (plans/PLAN.md Item 4 test-only switch, `--candidate-sample-alpha`
 *   in scripts/evolve.mjs): overrides `DEFAULT_BLEND_ALPHA` for gen-0
 *   sampling too, so a kept-row-5 measurement run samples generation zero
 *   with the same alpha `nextGeneration` uses for every later generation.
 * @returns {string[][]} up to `count` unique 3-userMonKey teams, each with
 *   `team[0]` as its designated lead.
 */
export function initPopulation({ matrix, pool, weights, count, seed, excludeSpecies, alpha, perBuild }) {
  const teams = sampleCandidateTeams({ matrix, pool, weights, count, seed, excludeSpecies, alpha, perBuild });
  const rng = rngFromSeed(seed, 'initPopulation-lead');
  return teams.map((team) => assignLead(team, rng));
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
function buildMutant(parentTeam, matrix, scoredPool, weightFn, accept, rng, maxAttempts) {
  const currentSpecies = new Set(parentTeam.map((key) => matrix.builtMons[key].speciesId));
  const eligible = scoredPool.filter((entry) => !currentSpecies.has(entry.speciesId));
  if (eligible.length === 0) return null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const slotIndex = Math.floor(rng() * TEAM_SIZE) % TEAM_SIZE;
    const picked = pickWeighted(rng, eligible, weightFn, 1);
    if (picked.length === 0) return null; // no positive-weight candidate at all -- won't improve on retry
    const mutantTeam = parentTeam.slice();
    mutantTeam[slotIndex] = picked[0].key;
    if (!accept(mutantTeam)) continue;
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
function buildLeadRotation(parentTeam, accept, rng, maxAttempts) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const promotedSlot = BACK_SLOTS[Math.floor(rng() * BACK_SLOTS.length) % BACK_SLOTS.length];
    const rotated = parentTeam.slice();
    [rotated[0], rotated[promotedSlot]] = [rotated[promotedSlot], rotated[0]];
    if (!accept(rotated)) continue;
    return { team: rotated, promotedSlot };
  }
  return null;
}

/**
 * Attempt to build one shadow-flip mutant of `parentTeam`: among the slots
 * whose mon has an opposite-shadow twin in the pool (`shadowTwins`), pick a
 * uniform-random NON-EMPTY subset (all 2^k - 1 combinations equally likely,
 * so a two- or three-shadow variant is as reachable in one step as a single
 * flip) and swap each chosen key for its twin -- same 3 species, same lead,
 * only shadow states change. Returns `{team, flippedSlots}` (ascending slot
 * indices), or `null` when no slot is flippable or every combination tried
 * collides with a used signature.
 */
function buildShadowFlip(parentTeam, shadowTwins, accept, rng, maxAttempts) {
  const flippable = [];
  parentTeam.forEach((key, slot) => {
    if (shadowTwins.has(key)) flippable.push(slot);
  });
  if (flippable.length === 0) return null;
  const combos = 2 ** flippable.length - 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const mask = 1 + (Math.floor(rng() * combos) % combos); // 1..combos, never the empty set
    const flippedSlots = flippable.filter((_, bit) => mask & (1 << bit));
    const flipped = parentTeam.slice();
    for (const slot of flippedSlots) flipped[slot] = shadowTwins.get(parentTeam[slot]);
    if (!accept(flipped)) continue;
    return { team: flipped, flippedSlots };
  }
  return null;
}

/**
 * Advance one generation: rank by this generation's fitness, kill the bottom
 * `deathRate` fraction (ranked on the core-rivalry-penalised fitness, under
 * which a shadow twin of a better team pays 2.8 steps; exact duplicates, if
 * a caller ever supplies any, die outright ON TOP of the cull), roll each
 * survivor's fitness-percentile-scaled
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
 *     leadRotationRate?: number, shadowFlipRate?: number,
 *     immigrantFraction?: number, alpha?: number,
 *     excludeSpecies?: string[],
 *     targetSize?: number, - size of the RETURNED population (default: the
 *       input population's length, i.e. hold steady). Cull/growth accounting
 *       is shared with the opponent GA (src/ga/core.js computeChurn): at
 *       least `deathRate * P` always die (so the cull still fires even while
 *       `targetSize` is growing a lot), and a smaller `targetSize` trims
 *       survivors further, down to `targetSize` itself, off the
 *       worst-performing end. Growth fills the extra slots with
 *       mutants/immigrants, subject to the same pool-exhaustion cap.
 *   },
 * }} params
 * @returns {{
 *   population: string[][],
 *   lineage: {
 *     died: number[],
 *     coreRivalryDied: number[],
 *     entries: Array<
 *       {origin:'survived', parentIndex:number} |
 *       {origin:'mutant', parentIndex:number, mutationType:'memberSwap', swappedSlot:number} |
 *       {origin:'mutant', parentIndex:number, mutationType:'leadRotation', promotedSlot:number} |
 *       {origin:'mutant', parentIndex:number, mutationType:'shadowFlip', flippedSlots:number[]} |
 *       {origin:'immigrant'}
 *     >,
 *   },
 * }}
 *   `population` is held at exactly `opts.targetSize` (default the input P) UNLESS
 *   the pool is too small to supply enough distinct new teams, in which case
 *   it gracefully falls short (mirrors sampleCandidateTeams' own cap
 *   behavior) rather than throwing or looping forever. `lineage.died` lists
 *   the OLD population's dead indices, worst-fitness first (shadow twins are
 *   handled by the rivalry penalty and show up in `coreRivalryDied` when it
 *   costs them their seat);
 *   `lineage.coreRivalryDied` the subset that died only because better teams
 *   sharing a two-species core -- or a similar core by pvpoke's similarity
 *   (`opts.similarity`, a src/engine/similarity.js createSimilarity scorer,
 *   built on demand when absent; `opts.similarFloor` / `opts.similarRivalry`,
 *   defaults DEFAULT_SIMILAR_FLOOR / DEFAULT_SIMILAR_RIVALRY) -- pushed them below the cut
 *   (`opts.coreRivalry`, default DEFAULT_CORE_RIVALRY, 0 disables -- see
 *   src/meta/archetypes.js coreRivalryFitness). `lineage.entries`
 *   is parallel to the RETURNED `population` (same order, same length): each
 *   entry says whether that slot is an unchanged survivor (with its index in
 *   the OLD population), a mutant (with its OLD-population parent index and
 *   which mutation it got -- a member-swap's changed slot, or a lead
 *   -rotation's promoted slot, a shadow-flip's flipped slots), or a fresh
 *   immigrant. Every returned team
 *   still has `team[0]` as its designated lead.
 */
export function nextGeneration({ population, fitness, pool, matrix, weights, seed, opts = {} }) {
  const P = population.length;
  if (P === 0) return { population: [], lineage: { died: [], coreRivalryDied: [], entries: [] } };

  const targetSize = Math.max(0, opts.targetSize ?? P);
  const deathRate = opts.deathRate ?? DEFAULT_DEATH_RATE;
  const mutationFloor = opts.mutationFloor ?? DEFAULT_MUTATION_FLOOR;
  const mutationCeil = opts.mutationCeil ?? DEFAULT_MUTATION_CEIL;
  const leadRotationRate = opts.leadRotationRate ?? DEFAULT_LEAD_ROTATION_RATE;
  const shadowFlipRate = opts.shadowFlipRate ?? DEFAULT_SHADOW_FLIP_RATE;
  const immigrantFraction = opts.immigrantFraction ?? DEFAULT_IMMIGRANT_FRACTION;
  const alpha = typeof opts.alpha === 'number' ? opts.alpha : DEFAULT_BLEND_ALPHA;
  const excludeSpecies = opts.excludeSpecies ?? [];
  const coreRivalry = opts.coreRivalry ?? DEFAULT_CORE_RIVALRY;
  const similarRivalry = opts.similarRivalry ?? DEFAULT_SIMILAR_RIVALRY;
  const similarFloor = opts.similarFloor ?? DEFAULT_SIMILAR_FLOOR;
  const similarity = coreRivalry > 0 && similarRivalry > 0 ? opts.similarity ?? createSimilarity() : null;
  const rng = rngFromSeed(seed, 'nextGeneration');

  // The whole generation step (rivalry ranking, cull, mutation roll, seat
  // split, fill, dedupe) is src/ga/core.js evolveStep, shared with the opponent
  // side. This side's adapter: a team is an array of matrix keys identified by
  // teamSignature; mutants/immigrants come from the collection `pool`.
  const excludeSet = new Set(excludeSpecies);
  const perBuild = !!opts.perBuild;
  const scoredPool = buildScoredPool(matrix, pool, excludeSet, { perBuild });
  const weightFn = makeBlendedWeightFn(scoredPool, weights, alpha);
  const shadowTwins = buildShadowTwins(matrix, pool, excludeSet);
  const adapter = {
    profilesOf: (team) => candidateProfiles(matrix, team),
    signatureOf: teamSignature,
    buildMutant(parent, type, accept, mrng, maxAttempts) {
      if (type === 'leadRotation') {
        const built = buildLeadRotation(parent, accept, mrng, maxAttempts);
        return built && { entry: built.team, promotedSlot: built.promotedSlot };
      }
      if (type === 'shadowFlip') {
        const built = buildShadowFlip(parent, shadowTwins, accept, mrng, maxAttempts);
        return built && { entry: built.team, flippedSlots: built.flippedSlots };
      }
      const built = buildMutant(parent, matrix, scoredPool, weightFn, accept, mrng, maxAttempts);
      return built && { entry: built.team, swappedSlot: built.swappedSlot };
    },
    // Fresh sampleCandidateTeams draw seeded from this function's own rng
    // stream; each unordered trio gets a seeded lead BEFORE the identity
    // check, since identity is lead-aware.
    *immigrants(budget, irng) {
      const drawn = sampleCandidateTeams({
        matrix, pool, weights, count: budget, seed: Math.floor(irng() * 0xffffffff), excludeSpecies, alpha, perBuild,
        allowRepeatSets: true, // dedupe is evolveStep's job (lead-aware), same as the opponent side
      });
      for (const team of drawn) yield assignLead(team, irng);
    },
  };
  const step = evolveStep({
    entries: population,
    fitness,
    targetSize,
    rng,
    rates: { deathRate, mutationFloor, mutationCeil, leadRotationRate, shadowFlipRate, immigrantFraction },
    rivalry: { coreRivalry, similar: similarRivalry, floor: similarFloor, similarity },
    adapter,
  });
  const { died, coreRivalryDied } = step;
  const survivorIndicesAsc = step.survivorIdx;
  const survivorsOut = survivorIndicesAsc.map((idx) => population[idx]);
  const mutantEntries = step.mutants.map((m) => ({ ...m, team: m.entry, mutationType: m.type }));
  const immigrantEntries = step.immigrants;

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
    ...mutantEntries.map((m) => {
      if (m.mutationType === 'leadRotation') return { origin: 'mutant', parentIndex: m.parentIndex, mutationType: 'leadRotation', promotedSlot: m.promotedSlot };
      if (m.mutationType === 'shadowFlip') return { origin: 'mutant', parentIndex: m.parentIndex, mutationType: 'shadowFlip', flippedSlots: m.flippedSlots };
      return { origin: 'mutant', parentIndex: m.parentIndex, mutationType: 'memberSwap', swappedSlot: m.swappedSlot };
    }),
    ...immigrantEntries.map(() => ({ origin: 'immigrant' })),
  ];

  return { population: nextPopulation, lineage: { died, coreRivalryDied, entries } };
}

/**
 * Mean fitness per team signature over the `trailing` generations ending at
 * `end` (inclusive), for the signatures alive in generation `end`.
 *
 * A single generation's fitness is a win rate over one freshly-drawn opponent
 * sample -- at the default 20 opponents its standard error is ~11 points,
 * which is ~35x the fitness gap that separates rank 10 from rank 11. Averaging
 * a team's own history is what makes cross-team comparison mean anything at
 * the elite boundary. Measured on four real runs (383 generations), it lifts
 * generation-to-generation top-10 carryover from 2.6/10 to ~8/10.
 *
 * Teams with fewer than `trailing` observations are still scored (on what
 * they have) rather than excluded: an eligibility cliff makes the early
 * generations trivially "stable" because almost nothing qualifies.
 */
function smoothedScores(history, end, trailing) {
  const start = Math.max(0, end - trailing + 1);
  const sums = new Map();
  const counts = new Map();
  const alive = new Set(history[end].population.map(teamSignature));
  for (let g = start; g <= end; g++) {
    const { population, fitness } = history[g];
    for (let i = 0; i < population.length; i++) {
      const signature = teamSignature(population[i]);
      if (!alive.has(signature)) continue;
      sums.set(signature, (sums.get(signature) ?? 0) + fitness[i]);
      counts.set(signature, (counts.get(signature) ?? 0) + 1);
    }
  }
  const scores = new Map();
  for (const [signature, sum] of sums) scores.set(signature, sum / counts.get(signature));
  return scores;
}

/**
 * Per-individual trailing fitness for the NEWEST generation in `history`: for
 * each team in `history[last].population`, a recency-weighted mean of its
 * fitness over the last `trailing` generations it appeared in (matched by
 * `teamSignature`, so a team keeps its history as its index moves) -- the
 * generation `age` steps back from the newest contributes `decay ** age` of
 * the weight, so the newest draw dominates and older ones fade rather than
 * counting equally. A team seen once is scored on that one sample; `trailing:
 * 1` returns the newest generation's raw fitness unchanged regardless of
 * `decay`.
 *
 * Selection's own window (DEFAULT_SELECTION_TRAILING/DEFAULT_SELECTION_
 * RECENCY_DECAY), separate from convergence's `smoothedScores` (Jaxon
 * 2026-09-05, tuned down from an initial equal-weighted 10-generation window
 * that reacted too slowly to real drift). Measured on the shared-s2-gen-1
 * run, a team's win rate moved 3.9 points generation to generation while
 * long-lived teams' true means were only 2.2 points apart, so a cull on one
 * generation's number was mostly culling on noise: three teams averaging 51%
 * over 19-24 generations died to one bad draw while the final top-15 held
 * teams with 1-4 observations.
 *
 * @param {Array<{population: string[][], fitness: number[]}>} history
 *   Ordered oldest-to-newest; the newest entry is the one scored.
 * @param {number} [trailing] - generations in the window (default DEFAULT_SELECTION_TRAILING).
 * @param {number} [decay] - per-generation-back weight decay (default DEFAULT_SELECTION_RECENCY_DECAY).
 * @returns {number[]} parallel to `history[last].population`.
 */
export function trailingFitness(history, trailing = DEFAULT_SELECTION_TRAILING, decay = DEFAULT_SELECTION_RECENCY_DECAY) {
  return trailingFitnessGeneric(history, teamSignature, trailing, decay);
}

/**
 * The `topN` best signatures by smoothed score, plus that generation's ELITE
 * LIFT: how far the elite mean sits above the population mean.
 *
 * Lift is the drift-immune half of the convergence test. Raw fitness is not
 * comparable across generations -- the opponent pool co-evolves, so a team
 * that is genuinely improving can post a FALLING win rate against opponents
 * that improved faster. Both terms of the lift are measured against the same
 * generation's opponents, so the difference survives that drift: it asks "how
 * much better than its own population is the elite?", which is a question
 * about the candidates alone.
 */
function eliteSnapshot(history, end, trailing, topN) {
  const scores = smoothedScores(history, end, trailing);
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const top = ranked.slice(0, Math.min(topN, ranked.length));
  const populationMean = ranked.reduce((sum, [, v]) => sum + v, 0) / (ranked.length || 1);
  const eliteMean = top.reduce((sum, [, v]) => sum + v, 0) / (top.length || 1);
  return { set: new Set(top.map(([signature]) => signature)), lift: eliteMean - populationMean };
}

/** How many of `next`'s members are not in `prev`. */
function churn(prev, next) {
  let carried = 0;
  for (const signature of next) if (prev.has(signature)) carried++;
  return next.size - carried;
}

/**
 * Convergence: converged once the run has stopped finding better teams, as
 * opposed to stopped SHUFFLING them.
 *
 * Two conditions, both required, both measured on the smoothed score
 * (`smoothedScores`) rather than on a single generation's win rate:
 *
 *  1. ELITE STABILITY -- at most `maxChurn` of the smoothed top-`topN` turns
 *     over in each of the last `window` generations.
 *  2. NO FRESH LIFT -- the elite's mean advantage over its own population
 *     (`eliteSnapshot`) is no more than `minLiftGain` above what it averaged
 *     over the preceding `trailing` generations. This is the condition that
 *     stops the run from halting while it is still climbing but happens to
 *     have held a stable top-10 for a few generations.
 *
 * The predecessor demanded that the top-10 be IDENTICAL for 3 generations
 * running. Backtested over 383 generations from four real runs it fired zero
 * times, longest stable streak 1 -- it was asking a ~0.3-point question of a
 * ~11-point-noise measurement, and 7.0 of the 7.4 top-10 slots that turned
 * over each generation were teams already in the population re-crossing the
 * rank-10 line. Exact identity is also the wrong thing to ask for: on those
 * same runs the top-10 from the halfway point overlapped the FINAL top-10 by
 * only 2-5 members, yet those teams still ranked in the 78th-92nd percentile
 * of the final population. Late churn is diffusion among near-equivalent
 * teams, so what a stopping rule must detect is a fitness plateau, not a
 * frozen roster.
 *
 * Needs `trailing + window` generations of history before it can fire at all,
 * so a short run (the 15-generation default) is cap-bound by construction.
 *
 * Deliberately does NOT know about `--generations` caps or
 * `--deadline-minutes` -- those are scripts/evolve.mjs's job, driven by
 * wall-clock/config concerns this pure module has no business touching.
 *
 * @param {Array<{population: string[][], fitness: number[]}>} history
 *   Ordered oldest-to-newest, one entry per generation actually run.
 * @param {{window?: number, topN?: number, trailing?: number,
 *          maxChurn?: number, minLiftGain?: number}} [opts]
 * @returns {{converged: boolean, reason: string|null}}
 */
export function hasConverged(history, opts = {}) {
  const window = opts.window ?? DEFAULT_CONVERGENCE_WINDOW;
  const topN = opts.topN ?? DEFAULT_CONVERGENCE_TOP_N;
  const trailing = opts.trailing ?? DEFAULT_CONVERGENCE_TRAILING;
  const maxChurn = opts.maxChurn ?? DEFAULT_CONVERGENCE_MAX_CHURN;
  const minLiftGain = opts.minLiftGain ?? DEFAULT_CONVERGENCE_MIN_LIFT_GAIN;
  const notConverged = { converged: false, reason: null };
  if (!Array.isArray(history) || history.length < trailing + window) return notConverged;

  const newest = history.length - 1;
  // One extra snapshot below the window supplies the `prev` that the window's
  // oldest generation is compared against.
  const snapshots = new Map();
  const snapshotAt = (g) => {
    if (!snapshots.has(g)) snapshots.set(g, eliteSnapshot(history, g, trailing, topN));
    return snapshots.get(g);
  };

  for (let g = newest - window + 1; g <= newest; g++) {
    if (churn(snapshotAt(g - 1).set, snapshotAt(g).set) > maxChurn) return notConverged;
  }

  const windowLift = [];
  for (let g = newest - window + 1; g <= newest; g++) windowLift.push(snapshotAt(g).lift);
  const baseline = [];
  for (let g = Math.max(0, newest - window + 1 - trailing); g < newest - window + 1; g++) {
    baseline.push(snapshotAt(g).lift);
  }
  if (!baseline.length) return notConverged;
  const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;
  const gain = mean(windowLift) - mean(baseline);
  if (gain > minLiftGain) return notConverged;

  return {
    converged: true,
    reason:
      `top-${topN} (by ${trailing}-generation mean win rate) turned over by at most ` +
      `${maxChurn} for ${window} consecutive generations, and the elite's lead over ` +
      `the population gained ${(gain * 100).toFixed(1)} points against a ` +
      `${(minLiftGain * 100).toFixed(1)}-point threshold`,
  };
}
