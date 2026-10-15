import { performance } from 'node:perf_hooks';
import { createExecutor } from '../engine/parallel.js';
import { createGpuProfile } from './gpuProfile.js';
import { runFinalPass } from './finalPass.js';
import { buildEvolveSetup } from './setup.js';
import { initRunState } from './state.js';
import { runGeneration } from './generation.js';
import { buildResult, closeExecutor, writeOutputs } from './output.js';
import { saveBattleCacheFile } from './cache.js';

/** One startup line under --gpu: device name, memory, batch limit, cpu share. */
async function gpuStartupLine(share) {
  const { execFileSync } = await import('node:child_process');
  const { GPU_BATCH_LIMIT } = await import('../engine/gpuExecutor.js');
  let dev = 'CUDA device';
  try {
    dev = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { encoding: 'utf8' }).split('\n')[0].trim();
  } catch { /* name unavailable; the sidecar already proved a device exists */ }
  return `evolve: gpu on -- ${dev}, batch limit ${GPU_BATCH_LIMIT} battles per message (sidecar halves on out-of-memory), cpu share ${share}`;
}

/**
 * Run (or resume) the whole search on one collection: setup, generation loop,
 * final pass, reports. Checkpoints land in `outDir` after every generation.
 *
 * @param {string} csvPath - collection CSV.
 * @param {object} [opts] - the parsed CLI options (see parseEvolveArgs).
 * @returns {Promise<object>} the `result` the reports were rendered from.
 */
export async function runEvolution(csvPath, opts = {}) {
  const tSetup0 = performance.now();
  const setup = await buildEvolveSetup(csvPath, opts);
  const setupS = (performance.now() - tSetup0) / 1000;
  const { config, outDir, log, threads, deadlineMs, ctx, battleCache } = setup;
  const threaded = typeof threads === 'number' && threads > 0;
  const profileDir = opts.profile ? outDir : undefined;
  const cpuExecutor = threaded
    ? createExecutor({ threads, vendorRoot: ctx.vendorRoot, continueOnError: true, profileDir, cp: ctx.cp, cup: ctx.cup })
    : null;
  let executor = cpuExecutor;
  let gpuProfile = null;
  if (opts.gpu) {
    const tSc0 = performance.now();
    const { createGpuExecutor, GPU_BATCH_LIMIT } = await import('../engine/gpuExecutor.js');
    gpuProfile = createGpuProfile(outDir, { cpuShare: config.gpuCpuShare, batchLimit: GPU_BATCH_LIMIT, threads });
    gpuProfile.setPhase('setup', setupS);
    executor = await createGpuExecutor({ ctx, cpuExecutor, cpuShare: config.gpuCpuShare, log, profile: gpuProfile });
    log(await gpuStartupLine(config.gpuCpuShare));
    gpuProfile.setPhase('sidecarStart', (performance.now() - tSc0) / 1000);
  }
  const env = { ...setup, opts, threaded, executor, profileDir, gpuProfile };

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

    const diskHitsInGenerations = battleCache.stats().diskHits ?? 0;
    gpuProfile?.beginGen('final');
    const tFin0 = performance.now();
    const fin = await runFinalPass(env, state);
    gpuProfile?.setPhase('finalPass', (performance.now() - tFin0) / 1000);
    const tOut0 = performance.now();
    const cacheStats = battleCache.stats();
    if (cacheStats.hits + cacheStats.misses > 0) {
      log(
        `evolve: battle cache -- ${cacheStats.hits} hits / ${cacheStats.hits + cacheStats.misses} lookups ` +
          `(${Math.round((100 * cacheStats.hits) / (cacheStats.hits + cacheStats.misses))}%), ` +
          `${cacheStats.size} entries held${cacheStats.dropped ? `, ${cacheStats.dropped} dropped at the cap` : ''}`
      );
    }
    if (opts.battleCacheFile && opts.battleCache !== false) {
      const t0 = Date.now();
      saveBattleCacheFile(battleCache, opts.battleCacheFile, setup.battleCacheScope);
      log(`evolve: battle cache file saved (${cacheStats.size} battles, ${cacheStats.diskHits} hits from the file) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    const result = buildResult(env, state, csvPath, fin);
    if (opts.battleCacheFile) result.battleCacheStats.diskHitsInGenerations = diskHitsInGenerations;
    writeOutputs(env, result);
    if (gpuProfile) { gpuProfile.setPhase('outputs', (performance.now() - tOut0) / 1000); gpuProfile.write(); }
    return result;
  } finally {
    if (executor) await closeExecutor(executor, profileDir, log);
  }
}
