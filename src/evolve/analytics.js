import { crowdingWeights } from '../ga/core.js';
import { memberDisplayName } from './format.js';

// Used only if a generation somehow measures 0 battles (every battle errored)
// -- keeps timing math finite.
export const FALLBACK_MS_PER_BATTLE = 200;

const SPECIES_STATS_CAP = 25; // report/analytics-JSON cap on how many species rows are kept per generation (documented, not silent -- see renderEvolveReport).

const TOP_CORES_CAP = 15;


const TOUGHEST_OPPONENTS_CAP = 15; // report/analytics-JSON cap on how many opponent rows are kept (same documented-not-silent rule as SPECIES_STATS_CAP).

const FINAL_OPPONENT_POOL_REPORT_CAP = 20; // final-report-only cap (summarizeOpponentPool's `toughest`), separate from the smaller per-generation TOUGHEST_OPPONENTS_CAP.

function speciesOfTeam(matrix, team) {
  return team.map((key) => matrix.builtMons[key].speciesId);
}

/**
 * Lead-aware identity for a candidate team: the lead key, then the two backs
 * sorted (their relative order carries no meaning). This MUST stay
 * byte-identical to src/teams/evolve.js's own private `teamSignature` -- that
 * module uses it for uniqueness and convergence, and this file uses it to
 * follow one team's win rate across the generations it survived. It is
 * duplicated rather than exported because it is three lines and the two uses
 * are genuinely independent; if it ever grows, export it from there instead.
 */
export function teamSignature(team) {
  return `${team[0]}||${[...team.slice(1)].sort().join('|')}`;
}

/**
 * Per-generation opponent-pool analytics: how the pool is composed and how
 * hard it actually is. Counting only, over data the generation's battles
 * already produced -- no extra battles.
 *
 * @param {{opponents: object[], opponentFitness: number[]}} params
 * @returns {{opponentOriginCounts: object, opponentMeanFitness: number,
 *   opponentMaxFitness: number, toughestOpponents: Array<object>}}
 */
/** Arithmetic mean, 0 for an empty array (never NaN into a checkpoint). */
export function mean(values) {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

/** Share of total opponent vote weight (archetype weight x strength) held by archetypes of size 1. */
export function singletonVoteShare(groups, weights, strength) {
  const size = new Map();
  for (const g of groups) size.set(g, (size.get(g) ?? 0) + 1);
  let total = 0;
  let single = 0;
  groups.forEach((g, j) => {
    const w = weights[j] * (strength?.[j] ?? 1);
    total += w;
    if (size.get(g) === 1) single += w;
  });
  return total > 0 ? single / total : 0;
}

export function computeOpponentAnalytics({ opponents, opponentFitness, opponentArchetypeGroups = null }) {
  const opponentOriginCounts = {};
  for (const o of opponents) opponentOriginCounts[o.origin ?? o.label ?? 'unknown'] = (opponentOriginCounts[o.origin ?? o.label ?? 'unknown'] ?? 0) + 1;
  const ranked = opponents
    .map((o, i) => ({ id: o.id, name: o.name, origin: o.origin ?? o.label ?? null, fitness: opponentFitness[i] ?? 0 }))
    .sort((a, b) => b.fitness - a.fitness);
  let archetypeCount = null;
  let maxArchetypeSize = null;
  if (opponentArchetypeGroups) {
    const sizeByGroup = new Map();
    for (const g of opponentArchetypeGroups) sizeByGroup.set(g, (sizeByGroup.get(g) ?? 0) + 1);
    archetypeCount = sizeByGroup.size;
    maxArchetypeSize = sizeByGroup.size ? Math.max(...sizeByGroup.values()) : 0;
  }
  return {
    opponentOriginCounts,
    opponentMeanFitness: opponentFitness.length
      ? opponentFitness.reduce((sum, f) => sum + f, 0) / opponentFitness.length
      : 0,
    opponentMaxFitness: opponentFitness.length ? Math.max(...opponentFitness) : 0,
    toughestOpponents: ranked.slice(0, TOUGHEST_OPPONENTS_CAP),
    archetypeCount,
    maxArchetypeSize,
  };
}

/** Report-facing summary of the run's FINAL opponent pool (composition + its hardest members). */
export function summarizeOpponentPool(pool, fitness) {
  const originCounts = {};
  for (const o of pool) originCounts[o.origin ?? o.label ?? 'unknown'] = (originCounts[o.origin ?? o.label ?? 'unknown'] ?? 0) + 1;
  const ranked = pool
    .map((o, i) => ({
      id: o.id,
      name: o.name,
      origin: o.origin ?? o.label ?? null,
      parentId: o.parentId ?? null,
      members: o.members.map((m) => m.speciesId),
      fitness: fitness[i] ?? 0,
    }))
    .sort((a, b) => b.fitness - a.fitness);
  return {
    size: pool.length,
    originCounts,
    toughest: ranked.slice(0, FINAL_OPPONENT_POOL_REPORT_CAP),
  };
}

/**
 * @param {{matrix:object, population:string[][], fitness:number[],
 *   lineage:{died:number[], entries:Array<object>}|null, results?:object[]}} params
 *   `lineage` is the OUTGOING transition (this generation -> the next);
 *   null for a generation that had no next generation (the run's very last).
 *   `results` (optional) is `evaluateTeamsInOrder`'s own positional
 *   per-team output for THIS generation (same index as `population`/`fitness`)
 *   -- used only to source `topTeams`' snowballIndex/comebackIndex/designatedCloser;
 *   everything else here is unaffected if omitted.
 */
/**
 * Per-candidate weight for frequency-normalised opponent fitness: the same
 * archetype-pair crowding scheme the opponent pool already uses to discount
 * a crowded bred core when IT votes on candidate fitness (src/meta/
 * archetypes.js archetypeGroups/archetypeWeights, via the shared
 * src/ga/core.js crowdingWeights), applied here to the candidate population
 * so a counter-bred opponent isn't rewarded N times over just for beating a
 * majority-share candidate core. Replaces the prior species-share scheme
 * (computeSpeciesShare/computeCandidateWeights, removed 2026-09-09) so both
 * voting sides normalise on one scheme instead of two.
 *
 * @param {object} matrix
 * @param {string[][]} population
 * @param {{beta?: number}} [opts]
 * @returns {number[]} weight per team, parallel to `population`.
 */
export function computeCandidateWeights(matrix, population, opts = {}) {
  return crowdingWeights(population, (team) => team.map((key) => ({ speciesId: matrix.builtMons[key].speciesId })), opts);
}

export function computeGenerationAnalytics({ matrix, population, fitness, lineage, results }) {
  const bySpecies = new Map();
  population.forEach((team, i) => {
    for (const s of new Set(speciesOfTeam(matrix, team))) {
      const cur = bySpecies.get(s) ?? { count: 0, fitnessSum: 0 };
      cur.count += 1;
      cur.fitnessSum += fitness[i];
      bySpecies.set(s, cur);
    }
  });
  const speciesStats = [...bySpecies.entries()]
    .map(([speciesId, v]) => ({
      speciesId,
      representation: v.count / population.length,
      meanFitness: v.fitnessSum / v.count,
    }))
    .sort((a, b) => b.representation - a.representation || b.meanFitness - a.meanFitness);

  let originCounts = null;
  let survivalBySpecies = null;
  if (lineage) {
    originCounts = { survived: 0, mutant: 0, immigrant: 0 };
    for (const e of lineage.entries) originCounts[e.origin] = (originCounts[e.origin] ?? 0) + 1;
    originCounts.coreRivalryDied = lineage.coreRivalryDied?.length ?? 0;

    const oldCounts = new Map();
    const survivedCounts = new Map();
    const diedSet = new Set(lineage.died);
    population.forEach((team, i) => {
      const survived = !diedSet.has(i);
      for (const s of new Set(speciesOfTeam(matrix, team))) {
        oldCounts.set(s, (oldCounts.get(s) ?? 0) + 1);
        if (survived) survivedCounts.set(s, (survivedCounts.get(s) ?? 0) + 1);
      }
    });
    survivalBySpecies = [...oldCounts.entries()]
      .map(([speciesId, total]) => ({ speciesId, survivalRate: (survivedCounts.get(speciesId) ?? 0) / total, total }))
      .sort((a, b) => b.survivalRate - a.survivalRate);
  }

  const rankedIdx = population.map((_, i) => i).sort((a, b) => fitness[b] - fitness[a] || a - b);
  const eliteIdx = rankedIdx.slice(0, Math.min(10, population.length)); // fixed top-10 for core-pair stats AND topTeams (below), independent of --elites (report's final-ranking count)

  // Per-team battle-reality metrics for THIS generation's top-10,
  // written into out/evolve-generations.json so they're trackable across
  // generations (not just the final elites pass, which already surfaces them
  // in the report). `results` is optional/positional; a caller that omits it
  // (none do today) just gets `null`s here rather than an error.
  const topTeams = eliteIdx.map((i, rank) => {
    const r = results?.[i];
    return {
      rank: rank + 1,
      members: population[i].map((key) => {
        const b = matrix.builtMons[key];
        return { key, speciesId: b.speciesId, name: memberDisplayName(b) };
      }),
      fitness: fitness[i],
      winRate: r?.winRate ?? null,
      snowballIndex: r?.snowballIndex ?? null,
      comebackIndex: r?.comebackIndex ?? null,
      designatedCloser: r?.designatedCloser ?? null,
      consistencyScore: r?.consistencyScore ?? null,
      sharedWeaknessScore: r?.sharedWeaknessScore ?? null,
      sharedWeaknessTypes: r?.sharedWeaknessTypes ?? [],
      archetypeCount: r?.archetypeCount ?? null,
    };
  });

  const coreCounts = new Map();
  for (const i of eliteIdx) {
    const species = [...new Set(speciesOfTeam(matrix, population[i]))].sort();
    for (let a = 0; a < species.length; a++) {
      for (let b = a + 1; b < species.length; b++) {
        const key = `${species[a]} + ${species[b]}`;
        coreCounts.set(key, (coreCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const topCores = [...coreCounts.entries()]
    .map(([core, count]) => ({ core, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_CORES_CAP);

  return {
    meanFitness: fitness.length ? fitness.reduce((s, f) => s + f, 0) / fitness.length : 0,
    maxFitness: fitness.length ? Math.max(...fitness) : 0,
    // Capped (SPECIES_STATS_CAP) rather than dumping every species every
    // generation -- documented here and in the report rather than silently
    // truncated; a full per-species history is still recoverable from the
    // per-generation checkpoints (out/evolve-gen<N>.json), which are NOT capped.
    speciesStats: speciesStats.slice(0, SPECIES_STATS_CAP),
    speciesStatsTruncated: speciesStats.length > SPECIES_STATS_CAP,
    originCounts,
    survivalBySpecies: survivalBySpecies ? survivalBySpecies.slice(0, SPECIES_STATS_CAP) : null,
    topCores,
    topTeams, // this generation's top-10 by fitness, with snowballIndex/comebackIndex/designatedCloser
  };
}
