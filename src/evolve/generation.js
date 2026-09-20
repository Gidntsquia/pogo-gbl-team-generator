import { archetypeGroups, archetypeWeights } from '../meta/archetypes.js';
import { trailingFitnessGeneric } from '../ga/core.js';
import { nextOpponentPool, isProtectedOpponent, serializeOpponentPool } from '../meta/opponentPool.js';
import {
  nextGeneration,
  hasConverged,
  trailingFitness,
  DEFAULT_SELECTION_RECENCY_DECAY,
} from '../teams/evolve.js';
import { selectionTrailingOf } from './config.js';
import { mutationRatesAt, opponentMutationRatesAt, opponentsAt, populationAt } from './schedule.js';
import { formatDuration } from './format.js';
import { DEFAULT_FITNESS_WEIGHTS, computeBlendFitness, ownLeadPairing } from './fitness.js';
import { CHECKPOINT_FORMAT_VERSION, writeCheckpoint, writeGenerationsAnalytics } from './checkpoint.js';
import {
  FALLBACK_MS_PER_BATTLE,
  computeCandidateWeights,
  computeGenerationAnalytics,
  computeOpponentAnalytics,
  mean,
  singletonVoteShare,
  teamSignature,
} from './analytics.js';
import { evaluateTeamsInOrder } from './evaluate.js';
import { trimHistory, trimSupersededRecords } from './state.js';

/**
 * Each opponent's fitness: the other side of the ledger the candidates just
 * produced, so no extra battles. Frequency-normalised (default) it uses each
 * candidate's archetype weight so an opponent isn't rewarded N times for
 * beating a majority-share core; a team nobody fought scores 0.5, not 0.
 *
 * @returns {{opponentFitness: number[], opponentWeightedWinRate: number[]}}
 */
function opponentFitnessOf(run, config) {
  const opponentWeightedWinRate = [];
  const opponentFitness = run.opponentTally.map((t) => {
    const oppWinRate =
      config.opponentFitnessNormalised && t.weightedBattles > 0
        ? 1 - t.weightedWinPoints / t.weightedBattles
        : t.battles > 0
          ? 1 - t.winPoints / t.battles
          : 0.5;
    opponentWeightedWinRate.push(oppWinRate);
    return computeBlendFitness(
      {
        winRate: oppWinRate,
        snowballScore: t.snowballScore,
        closerScore: t.closerScore,
        consistencyScore: t.consistencyScore,
        sharedWeaknessScore: t.sharedWeaknessScore,
      },
      {
        ...DEFAULT_FITNESS_WEIGHTS,
        snowball: config.opponentSnowballWeight,
        closer: config.opponentCloserWeight,
        consistency: config.opponentConsistencyWeight,
        sharedWeakness: config.opponentSharedWeaknessWeight,
      }
    );
  });
  return { opponentFitness, opponentWeightedWinRate };
}

/** Breed both sides' next generation from this one's selection fitness. */
function advanceSides(env, state, { opponents, selectionFitness, opponentSelectionFitness }) {
  const { config, ctx, similarity, deduped, weights, candidateExcludeSpecies, pool, opponentLeadRoleScores, curatedPool, movesetPool } = env;
  const { generation, population } = state;
  const advanced = nextGeneration({
    population,
    fitness: selectionFitness,
    pool,
    matrix: deduped,
    weights,
    seed: `${config.seed}-next${generation}`,
    opts: {
      excludeSpecies: candidateExcludeSpecies,
      targetSize: populationAt(generation + 1, config),
      deathRate: config.deathRate,
      ...mutationRatesAt(generation, config), // annealed per generation
      immigrantFraction: config.immigrantFraction,
      coreRivalry: config.coreRivalry,
      similarRivalry: config.similarRivalry,
      similarFloor: config.similarFloor,
      similarity,
    },
  });
  if (config.fixedOpponents) {
    // One draw, reused verbatim for the whole run.
    return { lineage: advanced.lineage, nextPopulation: advanced.population, opponentLineage: null, nextOpponents: opponents };
  }
  const advancedOpponents = nextOpponentPool(ctx, {
    pool: opponents,
    fitness: opponentSelectionFitness,
    targetSize: opponentsAt(generation + 1, config),
    weights,
    curated: curatedPool,
    curatedRatio: config.curatedRatio,
    roleScores: opponentLeadRoleScores,
    movesetPool,
    seed: `${config.seed}-opponents-next${generation}`,
    opts: {
      ...(config.opponentDeathRate !== undefined ? { deathRate: config.opponentDeathRate } : {}),
      ...(config.opponentImmigrantFraction !== undefined ? { immigrantFraction: config.opponentImmigrantFraction } : {}),
      ...opponentMutationRatesAt(generation, config),
      coreRivalry: config.coreRivalry,
      similarRivalry: config.similarRivalry,
      similarFloor: config.similarFloor,
      similarity,
    },
  });
  return {
    lineage: advanced.lineage,
    nextPopulation: advanced.population,
    opponentLineage: advancedOpponents.lineage,
    nextOpponents: advancedOpponents.pool,
  };
}

/** ", worker heap ..." log suffix from a live per-worker poll (--profile only); '' otherwise. */
async function workerStatsSuffix(executor) {
  const workerStats = await executor.stats();
  if (workerStats.length === 0) return '';
  // Per-isolate heap, NOT rss: inside a worker_thread rss is the whole process's figure.
  const totalHeap = workerStats.reduce((s, w) => s + w.heapMb, 0);
  const peakHeap = Math.max(...workerStats.map((w) => w.peakHeapMb));
  const totalMemoSize = workerStats.reduce((s, w) => s + w.memoSize, 0);
  const totalCacheSize = workerStats.reduce((s, w) => s + w.cacheASize + w.cacheBSize, 0);
  return (
    `, worker heap ${totalHeap}MB total (peak ${peakHeap}MB), ` +
    `scenario-memo ${totalMemoSize} entries, mon caches ${totalCacheSize} entries`
  );
}

/**
 * Evaluate one generation, checkpoint it, and breed the next. Advances
 * `state.generation/population/opponentPool` unless the run stops here.
 *
 * @returns {Promise<{converged: boolean, reason?: string}>} convergence verdict.
 */
export async function runGeneration(env, state) {
  const {
    config, outDir, log, difficulty, threads, threaded, executor, profileDir, collectionHash, roleScores, deduped,
    typeCoverageContext, battleCache,
  } = env;
  const { generation, population, history, opponentHistory, generationRecords } = state;
  const opponents = state.opponentPool;
  const curatedInPool = opponents.filter(isProtectedOpponent).length;
  // Archetype grouping over THIS generation's opponents: crowded bred cores
  // are discounted as opponents and, mirrored, over the candidate population.
  const oppArchetypeGroups = archetypeGroups(opponents);
  const oppArchetypeWeights = archetypeWeights(oppArchetypeGroups, { beta: config.archetypeBeta });
  const candidateWeights = computeCandidateWeights(deduped, population, { beta: config.archetypeBeta });
  const candArchetypeGroups = archetypeGroups(
    population.map((keys) => ({ members: keys.map((key) => ({ speciesId: deduped.builtMons[key].speciesId })) }))
  );
  log(
    `generation ${generation}: battling ${population.length} teams against ${opponents.length} opponents ` +
      `(${curatedInPool} curated, ${opponents.length - curatedInPool} evolved); ` +
      `${new Set(oppArchetypeGroups).size} opponent archetypes, ` +
      `candidate weight min ${Math.min(...candidateWeights).toFixed(2)} / max ${Math.max(...candidateWeights).toFixed(2)}`
  );
  const run = await evaluateTeamsInOrder(env.ctx, {
    teams: population,
    matrix: deduped,
    opponents,
    pairingsFor: ownLeadPairing,
    difficulty,
    executor,
    onLog: log,
    roleScores,
    cache: battleCache,
    opponentWeights: oppArchetypeWeights,
    candidateWeights: config.opponentFitnessNormalised ? candidateWeights : null,
    opponentArchetypeGroups: oppArchetypeGroups,
    candidateArchetypeGroups: candArchetypeGroups,
    opponentStrengthGamma: config.opponentStrengthGamma,
    candidateStrengthGamma: config.candidateStrengthGamma,
    snowballWeight: config.snowballWeight,
    closerWeight: config.closerWeight,
    consistencyWeight: config.consistencyWeight,
    sharedWeaknessWeight: config.sharedWeaknessWeight,
    typeCoverageContext,
  });
  // Both fitness numbers are computed on every result; the mode only picks
  // which one selection/mutation/convergence act on.
  const fitness = run.results.map((r) => (config.fitness === 'battle-reality' ? r.blendFitness : r.winRate));
  const { opponentFitness, opponentWeightedWinRate } = opponentFitnessOf(run, config);

  history.push({ population, fitness });
  opponentHistory.push({ population: opponents.map((e) => ({ id: e.id })), fitness: opponentFitness });
  trimHistory(history, config);
  trimHistory(opponentHistory, config);
  // Selection ranks on each side's trailing mean, not this generation's draw --
  // a pure function of `history`, so a resumed run computes the same values.
  const selectionFitness = trailingFitness(history, selectionTrailingOf(config));
  const opponentSelectionFitness = trailingFitnessGeneric(
    opponentHistory,
    (e) => e.id,
    selectionTrailingOf(config),
    DEFAULT_SELECTION_RECENCY_DECAY
  );
  const isLastAllowedGeneration = generation === config.generations - 1;

  let lineage = null;
  let nextPopulation = [];
  let opponentLineage = null;
  let nextOpponents = [];
  if (!isLastAllowedGeneration) {
    ({ lineage, nextPopulation, opponentLineage, nextOpponents } = advanceSides(env, state, {
      opponents,
      selectionFitness,
      opponentSelectionFitness,
    }));
  }

  const record = {
    formatVersion: CHECKPOINT_FORMAT_VERSION,
    generation,
    config,
    collectionHash,
    runStartedAt: new Date(state.runStartedAtMs).toISOString(),
    threadsUsed: threaded ? threads : null,
    population,
    fitness, // raw single-generation number the history/analytics/race chart read
    selectionFitness, // the trailing mean selection actually ranked on
    // Per-team win rate keyed by the lead-aware signature, so the final ranking
    // can average a team's win rate across the generations it survived.
    winRateBySignature: Object.fromEntries(population.map((team, i) => [teamSignature(team), run.results[i].winRate])),
    opponentCount: opponents.length,
    opponentPool: serializeOpponentPool(opponents),
    opponentFitness,
    opponentSelectionFitness,
    opponentLineage: opponentLineage
      ? {
          diedCount: opponentLineage.died.length,
          coreRivalryDiedCount: opponentLineage.coreRivalryDied?.length ?? 0,
          originCounts: opponentLineage.originCounts,
        }
      : null,
    lineage,
    nextPopulation,
    nextOpponentPool: serializeOpponentPool(nextOpponents),
    timing: {
      startedAt: new Date(run.startedAt).toISOString(),
      finishedAt: new Date(run.finishedAt).toISOString(),
      elapsedMs: run.elapsedMs,
      battleCount: run.battleCount,
      cachedCount: run.cachedCount,
      errorCount: run.errorCount,
      msPerBattle: run.battleCount > 0 ? run.elapsedMs / run.battleCount : FALLBACK_MS_PER_BATTLE,
    },
    analytics: {
      ...computeGenerationAnalytics({ matrix: deduped, population, fitness, lineage, results: run.results }),
      ...computeOpponentAnalytics({ opponents, opponentFitness, opponentArchetypeGroups: oppArchetypeGroups }),
      // Share of the candidates' total vote weight (archetype x strength) held by singleton archetypes.
      singletonVoteShare: singletonVoteShare(oppArchetypeGroups, oppArchetypeWeights, run.opponentStrength),
      // Same-kind means for both sides: raw = winPoints/battles off each side's
      // own ledger; weighted = the win rate that side's fitness consumed.
      candidateRawWinRateMean: mean(run.results.map((r) => r.rawWinRate)),
      opponentRawWinRateMean: mean(run.opponentTally.map((t) => t.winRate)),
      candidateWeightedWinRateMean: mean(run.results.map((r) => r.winRate)),
      opponentWeightedWinRateMean: mean(opponentWeightedWinRate),
    },
    resumed: false,
  };
  writeCheckpoint(outDir, generation, record);
  generationRecords.push(record);
  trimSupersededRecords(generationRecords);
  writeGenerationsAnalytics(outDir, generationRecords);
  state.lastEvaluated = record;
  const workerStatsMsg = executor && profileDir ? await workerStatsSuffix(executor) : '';
  log(
    `generation ${generation}: done -- mean fitness ${(record.analytics.meanFitness * 100).toFixed(1)}%, ` +
      `opponent mean fitness ${record.opponentFitness && record.opponentFitness.length ? (record.analytics.opponentMeanFitness * 100).toFixed(1) + "%" : "n/a"}, ` +
      `raw win rate cand ${(record.analytics.candidateRawWinRateMean * 100).toFixed(1)}% / opp ${(record.analytics.opponentRawWinRateMean * 100).toFixed(1)}%, ` +
      `${run.battleCount} battles simulated + ${run.cachedCount} served from cache (both directions; ${run.errorCount} errors), ` +
      `${formatDuration(run.elapsedMs)} elapsed, process RSS ${(process.memoryUsage().rss / 1048576).toFixed(0)}MB` +
      workerStatsMsg
  );

  const conv = hasConverged(history, config.convergence ?? {});
  state.generation += 1;
  if (conv.converged) {
    state.stopReason = `converged: ${conv.reason}`;
    log(`evolve: ${state.stopReason}`);
    return conv;
  }
  if (isLastAllowedGeneration) state.stopReason = `generations cap reached (${config.generations})`;
  state.population = nextPopulation;
  state.opponentPool = nextOpponents;
  return conv;
}
