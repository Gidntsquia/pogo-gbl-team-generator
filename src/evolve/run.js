import { createExecutor } from '../engine/parallel.js';
import { runFinalPass } from './finalPass.js';
import { buildEvolveSetup } from './setup.js';
import { initRunState } from './state.js';
import { runGeneration } from './generation.js';
import { buildResult, closeExecutor, writeOutputs } from './output.js';

/**
 * Run (or resume) the whole search on one collection: setup, generation loop,
 * final pass, reports. Checkpoints land in `outDir` after every generation.
 *
 * @param {string} csvPath - collection CSV.
 * @param {object} [opts] - the parsed CLI options (see parseEvolveArgs).
 * @returns {Promise<object>} the `result` the reports were rendered from.
 */
export async function runEvolution(csvPath, opts = {}) {
  const setup = await buildEvolveSetup(csvPath, opts);
  const { config, outDir, log, threads, deadlineMs, ctx, battleCache } = setup;
  const threaded = typeof threads === 'number' && threads > 0;
  const profileDir = opts.profile ? outDir : undefined;
  const executor = threaded
    ? createExecutor({ threads, vendorRoot: ctx.vendorRoot, continueOnError: true, profileDir, cp: ctx.cp, cup: ctx.cup })
    : null;
  const env = { ...setup, opts, threaded, executor, profileDir };

  try {
    const state = initRunState(env);
    while (state.generation < config.generations) {
      if (deadlineMs !== null && Date.now() - state.runStartedAtMs >= deadlineMs) {
        state.stopReason = `deadline reached (${opts.deadlineMinutes} minutes) before generation ${state.generation}`;
        log(`evolve: ${state.stopReason}`);
        break;
      }
      if (state.population.length === 0) {
        state.stopReason = `population exhausted (sampling pool too small) before generation ${state.generation}`;
        log(`evolve: ${state.stopReason}`);
        break;
      }
      if ((await runGeneration(env, state)).converged) break;
    }
    if (!state.stopReason) state.stopReason = `generations cap reached (${config.generations})`;
    if (!state.lastEvaluated) {
      throw new Error('evolve: no generation was ever evaluated (population sampling produced 0 teams from the start)');
    }

    const fin = await runFinalPass(env, state);
    const cacheStats = battleCache.stats();
    if (cacheStats.hits + cacheStats.misses > 0) {
      log(
        `evolve: battle cache -- ${cacheStats.hits} hits / ${cacheStats.hits + cacheStats.misses} lookups ` +
          `(${Math.round((100 * cacheStats.hits) / (cacheStats.hits + cacheStats.misses))}%), ` +
          `${cacheStats.size} entries held${cacheStats.dropped ? `, ${cacheStats.dropped} dropped at the cap` : ''}`
      );
    }
    const result = buildResult(env, state, csvPath, fin);
    writeOutputs(env, result);
    return result;
  } finally {
    if (executor) await closeExecutor(executor, profileDir, log);
  }
}
