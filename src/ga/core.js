// Shared GA scaffolding used by both src/teams/evolve.js (the candidate-side
// GA) and src/meta/opponentPool.js (the opponent-side GA). Pure functions
// only -- no battle math, no engine boot -- so both sides (and this module's
// own tests) can exercise it against fake fitness arrays.
//
// `evolveStep` below is THE generation step for both sides: rivalry ranking,
// cull, mutation roll, mutant/immigrant seat split, fill and dedupe. Each side
// supplies only an adapter (how a team is identified and profiled, how a mutant
// or an immigrant is built) plus, on the opponent side, its protected (curated)
// entries. nextGeneration / nextOpponentPool are thin callers.

import { archetypeGroups, archetypeWeights, coreRivalryFitness } from '../meta/archetypes.js';

// Bounded retries when a mutant/immigrant collides with an already-used
// identity -- one constant shared by both sides instead of two copies.
export const MAX_ATTEMPTS_MULTIPLIER = 20;
export const MAX_ATTEMPTS_FLOOR = 50;

/**
 * Shared churn/cull accounting (plans/PLAN.md Item 2/3): how many of the
 * current LIVE population die this generation, how many survive, and how
 * many slots in the NEXT generation are open for mutants/immigrants.
 *
 * `deathRate` always means "fraction of what's alive now" -- `churn` is
 * based on `liveCount`, never on `targetSize`. `survivorsWanted` is
 * `min(liveCount - churn, targetSize)`: at least `churn` always die (this is
 * what makes the cull fire even while the population is growing hard --
 * `targetSize` alone can't cap `survivorsWanted` below `liveCount - churn`),
 * and no more survive than `targetSize` allows (a deep shrink trims further,
 * on top of the ordinary churn death).
 *
 * This is the opponent pool's pre-existing formula (its population only
 * ever grows, so this was always exercised correctly there); the candidate
 * side previously computed `survivorsWanted` as `targetSize - churn`
 * directly, which is what a HOLD-STEADY or a mild-shrink generation reduces
 * to as well (`churn` slots stay open regardless of direction) but breaks
 * under a large target increase: `targetSize - churn` can exceed
 * `liveCount`, giving a negative `liveCount - survivorsWanted` that clamps
 * `deathCount` to 0 -- no one dies no matter how stale the population is,
 * simply because the target grew a lot. `min(liveCount - churn, targetSize)`
 * has no such failure mode (verified against
 * test/opponentPool.test.js's "the cull still fires while the pool is
 * growing" case, which a `targetSize - churn` version fails: churn=1 on a
 * live count of 4 growing to a target of 10 zeroes deathCount out).
 * The one real behavior change from this unification is on a DEEP shrink
 * (`targetSize < liveCount - churn`): previously the candidate side still
 * reserved `churn` slots of new blood even then; under the shared rule it
 * does not (`survivorsWanted` clamps to `targetSize`, `openSlots` is 0)
 * unless `targetSize` already leaves room. Inert under BASE
 * (`--population-final-ratio 1` never shrinks the candidate side, and a
 * fixed `--opponents-per-gen` never shrinks the opponent side either).
 *
 * @param {{liveCount: number, contenders: number, targetSize: number, deathRate: number}} params
 *   `contenders` is `liveCount` minus any duplicate/twin-cull losses already
 *   removed before ranking (both sides fold twin losses into `died`
 *   separately, on top of this cull); those losses are never survivors, so
 *   the caller's own survivor count is `contenders - deathCount` and its
 *   `openSlots` is `targetSize - (contenders - deathCount)`.
 * @returns {{churn: number, survivorsWanted: number, deathCount: number}}
 */
export function computeChurn({ liveCount, contenders, targetSize, deathRate }) {
  const churn = Math.min(liveCount, Math.round(deathRate * liveCount));
  const survivorsWanted = Math.max(0, Math.min(liveCount - churn, targetSize));
  const deathCount = Math.max(0, Math.min(contenders, liveCount - survivorsWanted));
  return { churn, survivorsWanted, deathCount };
}

/**
 * Shared new-slot allocation (plans/PLAN.md Item 2/3): given `openSlots` in
 * the next generation and a list of successful mutation rolls (each
 * `{percentile}`, highest-fitness-parent rolls win when oversubscribed),
 * decide how many slots are reserved for immigrants vs offered to mutation,
 * then (after the caller actually attempts to BUILD the chosen mutants,
 * since a bounded-retry build can fail) how many immigrants are needed to
 * fill whatever is still open.
 *
 * `Math.floor` on the immigrant reserve (not `Math.round`) on BOTH sides --
 * previously only the opponent pool floored (documented reason: rounding UP
 * at its small evolvable scale, ~7 entries, could claim every open seat and
 * starve mutation outright); the candidate side rounded. Flooring never
 * over-claims the budget at any scale, so it is the one rule that is safe
 * for both a small pool and a large one -- the candidate side loses at most
 * one slot's worth of immigrant reservation from this (e.g. `floor(0.08*60)
 * = 4` vs the old `round(0.08*60) = 5`).
 *
 * The BORROW-ONE-SEAT rule (if flooring leaves zero mutant seats but a roll
 * fired and slots are open, take one seat from the immigrant reserve) was
 * previously opponent-only; both sides now apply it, since it is the same
 * "don't let a rounding artifact silently discard a real roll" fix on
 * either side.
 *
 * Immigrant count is computed AFTER mutant building (`builtMutantCount`,
 * passed in by the caller once it knows how many of `chosenRolls` actually
 * produced a team) rather than from the roll count alone -- previously only
 * the opponent pool backfilled a failed mutant build with an extra
 * immigrant; the candidate side left the slot empty. Backfilling is the
 * correct rule for both: a bounded-retry build failure is pool exhaustion,
 * not evidence the slot shouldn't exist.
 *
 * @param {{openSlots: number, immigrantFraction: number, targetSize: number, rolls: Array<{percentile: number}>}} params
 * @returns {{chosenRolls: Array<{percentile: number}>, immigrantReserve: number}}
 *   `immigrantReserve` is the planned reserve; call {@link finalizeImmigrantCount}
 *   once mutants are actually built to get the real immigrant draw count.
 */
function allocateNewSlots({ openSlots, immigrantFraction, targetSize, rolls }) {
  const immigrantReserve = Math.min(openSlots, Math.floor(immigrantFraction * targetSize));
  let mutantSlots = Math.max(0, openSlots - immigrantReserve);
  if (mutantSlots === 0 && openSlots > 0 && rolls.length > 0) mutantSlots = 1;
  const chosenRolls =
    rolls.length > mutantSlots
      ? rolls.slice().sort((a, b) => b.percentile - a.percentile).slice(0, mutantSlots)
      : rolls;
  return { chosenRolls, immigrantReserve };
}

/**
 * See {@link allocateNewSlots}: the immigrant draw target once the caller
 * knows how many of `chosenRolls` actually built successfully.
 */
function finalizeImmigrantCount({ openSlots, builtMutantCount }) {
  return Math.max(0, openSlots - builtMutantCount);
}

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

/**
 * One GA generation step, shared by both sides. Side-agnostic: everything a
 * side contributes comes through `adapter`, and the function never asks which
 * side is calling.
 *
 * Order of work (one rng stream, deterministic):
 *  1. rivalry ranking (coreRivalryFitness, whole-team twins read `'lead'`:
 *     same lead, backs in either order -- the same identity `signatureOf` uses);
 *  2. cull (computeChurn), exact-duplicate losers die on top of it;
 *  3. mutation roll per survivor, chance ramping floor->ceil with rank
 *     percentile, one type roll per success; `extraParents` (protected
 *     entries, never culled) roll a flat `extraParentRate`;
 *  4. seat split (allocateNewSlots), mutants built through the adapter -- a
 *     shadowFlip that cannot be built falls through to a memberSwap;
 *  5. immigrants fill the rest (finalizeImmigrantCount), bounded retries;
 *  6. dedupe: `used` holds the signature of EVERY entry alive at the start
 *     (culled ones included, so a team just judged weakest is not re-created
 *     the same generation), `reserved`, and each new team as it is accepted.
 *
 * @param {object} params
 * @param {any[]} params.entries - the evolvable entries.
 * @param {number[]} params.fitness - parallel to `entries`.
 * @param {number} params.targetSize - next generation's evolvable headcount.
 * @param {() => number} params.rng
 * @param {{deathRate:number, mutationFloor:number, mutationCeil:number, leadRotationRate:number,
 *   shadowFlipRate:number, immigrantFraction:number}} params.rates
 * @param {{coreRivalry:number, similar:number, floor:number, similarity:any}} params.rivalry
 * @param {{profilesOf:(e:any)=>any[], signatureOf:(e:any)=>string,
 *   buildMutant:(parent:any, type:string, accept:(e:any)=>boolean, rng:()=>number, maxAttempts:number)=>object|null,
 *   immigrants:(count:number, rng:()=>number)=>Iterable<any>}} params.adapter -
 *   `buildMutant` returns `{entry, ...detail}` for an entry `accept` took, or
 *   null; `accept(entry)` is the dedupe check (true = new, now recorded).
 * @param {any[]} [params.extraParents] - protected entries that may parent a mutant.
 * @param {number} [params.extraParentRate]
 * @param {string[]} [params.reserved] - signatures new teams must also avoid.
 * @returns {{died:number[], coreRivalryDied:number[], survivorIdx:number[],
 *   mutants:Array<object>, immigrants:any[]}} indices are into `entries`;
 *   `survivorIdx` ascending; each mutant is `{entry, parent, parentIndex, type, ...detail}`
 *   (`parentIndex` -1 for an extra parent).
 */
export function evolveStep({ entries, fitness, targetSize, rng, rates, rivalry, adapter, extraParents = [], extraParentRate = 0, reserved = [] }) {
  const { deathRate, mutationFloor, mutationCeil, leadRotationRate, shadowFlipRate, immigrantFraction } = rates;
  const { shared, rivalsAbove, twinLosers } = coreRivalryFitness(
    entries.map(adapter.profilesOf),
    fitness,
    rivalry.coreRivalry,
    { similar: rivalry.similar, floor: rivalry.floor, similarity: rivalry.similarity, twins: 'lead' }
  );
  const loserSet = new Set(twinLosers);
  const contenderIdx = entries.map((_, i) => i).filter((i) => !loserSet.has(i));
  const rankedWorstFirst = contenderIdx.slice().sort((a, b) => shared[a] - shared[b] || a - b);
  const { deathCount } = computeChurn({ liveCount: entries.length, contenders: rankedWorstFirst.length, targetSize, deathRate });
  const byRaw = (a, b) => fitness[a] - fitness[b] || a - b;
  const died = [...twinLosers, ...rankedWorstFirst.slice(0, deathCount)].sort(byRaw);
  const survivorsAsc = rankedWorstFirst.slice(deathCount);
  const rawCut = new Set(contenderIdx.slice().sort(byRaw).slice(deathCount));
  const coreRivalryDied = rankedWorstFirst.slice(0, deathCount).filter((i) => rawCut.has(i) && rivalsAbove[i] > 0);

  const rollType = () => {
    const t = rng();
    return t < leadRotationRate ? 'leadRotation' : t < leadRotationRate + shadowFlipRate ? 'shadowFlip' : 'memberSwap';
  };
  const rolls = [];
  const n = survivorsAsc.length;
  survivorsAsc.forEach((idx, rank) => {
    const percentile = n <= 1 ? 1 : rank / (n - 1);
    if (rng() < mutationFloor + (mutationCeil - mutationFloor) * percentile) {
      rolls.push({ parent: entries[idx], parentIndex: idx, percentile, type: rollType() });
    }
  });
  for (const parent of extraParents) {
    if (rng() < extraParentRate) rolls.push({ parent, parentIndex: -1, percentile: 0, type: rollType() });
  }

  const openSlots = Math.max(0, targetSize - survivorsAsc.length);
  const { chosenRolls } = allocateNewSlots({ openSlots, immigrantFraction, targetSize, rolls });

  const used = new Set([...entries.map(adapter.signatureOf), ...reserved]);
  const accept = (entry) => {
    const sig = adapter.signatureOf(entry);
    if (used.has(sig)) return false;
    used.add(sig);
    return true;
  };
  const maxAttempts = Math.max(chosenRolls.length, 1) * MAX_ATTEMPTS_MULTIPLIER + MAX_ATTEMPTS_FLOOR;
  const mutants = [];
  for (const { parent, parentIndex, type } of chosenRolls) {
    let builtType = type;
    let built = adapter.buildMutant(parent, type, accept, rng, maxAttempts);
    if (!built && type === 'shadowFlip') {
      builtType = 'memberSwap';
      built = adapter.buildMutant(parent, builtType, accept, rng, maxAttempts);
    }
    if (!built) continue; // bounded retries exhausted -- graceful shortfall, backfilled below
    mutants.push({ ...built, parent, parentIndex, type: builtType });
  }

  const immigrantCount = finalizeImmigrantCount({ openSlots, builtMutantCount: mutants.length });
  const immigrants = [];
  if (immigrantCount > 0) {
    const budget = immigrantCount * MAX_ATTEMPTS_MULTIPLIER + MAX_ATTEMPTS_FLOOR;
    let attempts = 0;
    for (const entry of adapter.immigrants(budget, rng)) {
      if (immigrants.length >= immigrantCount || attempts >= budget) break;
      attempts += 1;
      if (accept(entry)) immigrants.push(entry);
    }
  }
  return { died, coreRivalryDied, survivorIdx: survivorsAsc.slice().sort((a, b) => a - b), mutants, immigrants };
}
