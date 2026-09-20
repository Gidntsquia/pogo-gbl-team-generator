import { initOpponentPool, isProtectedOpponent, rehydrateOpponentPool } from '../meta/opponentPool.js';
import { initPopulation, DEFAULT_CONVERGENCE_TRAILING, DEFAULT_CONVERGENCE_WINDOW } from '../teams/evolve.js';
import {
  assertCollectionMatchesCheckpoint,
  configsMatch,
  describeConfigMismatch,
  selectionTrailingOf,
} from './config.js';
import { opponentsAt, populationAt } from './schedule.js';
import {
  CHECKPOINT_FORMAT_VERSION,
  checkpointPath,
  readCheckpoint,
  seedFromCheckpoint,
} from './checkpoint.js';

/**
 * Drop the bulky arrays of every record but the newest. Only the newest
 * record's population is read back (as `lastEvaluated`, for the final pass);
 * the rest is already on disk in the checkpoints and would otherwise pin tens
 * of thousands of team objects for the whole run.
 *
 * @param {Array<object>} generationRecords - oldest first; mutated.
 */
export function trimSupersededRecords(generationRecords) {
  const superseded = generationRecords[generationRecords.length - 2];
  if (!superseded) return;
  superseded.population = null;
  superseded.nextPopulation = null;
  superseded.lineage = null;
  superseded.opponentLineage = null;
  superseded.nextOpponentPool = null;
}

/**
 * Free the `population` of the one history entry that just fell out of every
 * lookback window. trailingFitness looks back `selection-trailing`
 * generations and hasConverged looks back `window + 2*trailing - 2` (+5 slack
 * for custom windows), so an entry older than that is never dereferenced again.
 *
 * @param {Array<{population: Array|null}>} history - candidate or opponent history, oldest first; mutated.
 * @param {object} config - run config (selection trailing + convergence window).
 */
export function trimHistory(history, config) {
  const trailing = config.convergence?.trailing ?? DEFAULT_CONVERGENCE_TRAILING;
  const window = config.convergence?.window ?? DEFAULT_CONVERGENCE_WINDOW;
  const lookback = Math.max(selectionTrailingOf(config), window + 2 * trailing - 2) + 5;
  const stale = history.length - 1 - lookback;
  if (stale >= 0 && history[stale].population) history[stale].population = null;
}

/**
 * Build the loop state for this run: replay every config-matching checkpoint
 * in `outDir` (resume), or seed generation 0 from `--seed-from`, or sample it
 * fresh. Refuses (throws) to overwrite a directory whose checkpoints belong to
 * a different config, and to resume old-format or different-collection ones.
 *
 * @param {object} env - the buildEvolveSetup result plus `opts`.
 * @returns {object} state: generation, population, opponentPool, runStartedAtMs,
 *   history, opponentHistory, generationRecords, lastEvaluated, stopReason.
 */
export function initRunState(env) {
  const {
    config, outDir, opts, log, collectionHash, ctx, deduped, weights, candidateExcludeSpecies, pool,
    opponentLeadRoleScores, curatedPool, movesetPool,
  } = env;
  const state = {
    generation: 0,
    population: null,
    opponentPool: null, // live opponent entries for the NEXT generation
    runStartedAtMs: null,
    history: [], // [{population, fitness}], oldest first -- for hasConverged / trailing fitness
    opponentHistory: [], // same, entries shaped {id}: all trailingFitnessGeneric needs
    generationRecords: [], // per-generation records for the report
    lastEvaluated: null,
    stopReason: null,
  };
  let checkpointHash; // collectionHash of the last matching checkpoint

  for (;;) {
    const cp = readCheckpoint(outDir, state.generation);
    if (!cp || !configsMatch(cp.config, config)) break;
    checkpointHash = cp.collectionHash;
    if (cp.formatVersion !== CHECKPOINT_FORMAT_VERSION) {
      throw new Error(
        `evolve: ${checkpointPath(outDir, state.generation)} is checkpoint format ` +
          `${cp.formatVersion ?? '(unversioned, pre-lead-lock)'} but this code expects format ` +
          `${CHECKPOINT_FORMAT_VERSION} (evolving opponent pool + per-signature win-rate history). ` +
          'Old-format checkpoints cannot be resumed -- they carry no opponent pool to continue from, ' +
          'and (pre-v2) their population entries have no defined lead-slot convention. ' +
          'Delete out/evolve-gen*.json, out/evolve-generations.json, and ' +
          'out/evolve-DONE, then re-run from scratch.'
      );
    }
    state.history.push({ population: cp.population, fitness: cp.fitness });
    state.opponentHistory.push({ population: cp.opponentPool.map((e) => ({ id: e.id })), fitness: cp.opponentFitness });
    state.generationRecords.push({ ...cp, resumed: true });
    if (state.generation === 0) state.runStartedAtMs = new Date(cp.runStartedAt).getTime();
    state.population = cp.nextPopulation;
    state.opponentPool = cp.nextOpponentPool ? rehydrateOpponentPool(ctx, cp.nextOpponentPool, curatedPool, log) : null;
    state.generation += 1;
    // Same memory trims the live loop applies, so a resume doesn't re-inflate
    // an OOM-killed run's heap.
    trimSupersededRecords(state.generationRecords);
    trimHistory(state.history, config);
    trimHistory(state.opponentHistory, config);
  }

  if (state.generation === 0) {
    const stale = readCheckpoint(outDir, 0);
    if (stale && !configsMatch(stale.config, config) && !opts.forceFresh) {
      throw new Error(
        `evolve: ${checkpointPath(outDir, 0)} exists but its config doesn't match this run's flags ` +
          `(${describeConfigMismatch(stale.config, config)}). Refusing to overwrite it. ` +
          `A config change can't resume in place -- use a different --out-dir (optionally with ` +
          `--seed-from ${checkpointPath(outDir, 0)} to carry its population over), ` +
          `or pass --force-fresh to discard this directory's checkpoints and start over here.`
      );
    }
  }

  if (state.generation > 0) {
    assertCollectionMatchesCheckpoint({
      population: state.population,
      builtMons: deduped.builtMons,
      checkpointHash,
      collectionHash,
      csvPath: config.csvPath,
    });
    log(`evolve: resuming -- ${state.generation} generation(s) already complete (config matches)`);
  } else if (opts.seedFrom) {
    state.runStartedAtMs = Date.now();
    ({ population: state.population, opponentPool: state.opponentPool } = seedFromCheckpoint({
      seedPath: opts.seedFrom,
      ctx,
      deduped,
      pool,
      weights,
      populationCount: populationAt(0, config),
      opponentCount: opponentsAt(0, config),
      curatedPool,
      candidateExcludeSpecies,
      seed: config.seed,
      log,
    }));
  } else {
    state.runStartedAtMs = Date.now();
    state.population = initPopulation({
      matrix: deduped,
      pool,
      weights,
      count: populationAt(0, config),
      seed: `${config.seed}-gen0`,
      excludeSpecies: candidateExcludeSpecies,
    });
    state.opponentPool = initOpponentPool(ctx, {
      size: opponentsAt(0, config),
      weights,
      curated: curatedPool,
      curatedRatio: config.curatedRatio,
      roleScores: opponentLeadRoleScores,
      movesetPool,
      seed: `${config.seed}-opponents-gen0`,
    });
    log(
      `evolve: starting fresh -- population ${state.population.length} (requested ${config.population}), ` +
        `opponent pool ${state.opponentPool.length} ` +
        `(${state.opponentPool.filter(isProtectedOpponent).length} curated), seed ${config.seed}`
    );
  }

  state.lastEvaluated = state.generationRecords.length
    ? state.generationRecords[state.generationRecords.length - 1]
    : null;
  return state;
}
