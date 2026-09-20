import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RANKING_WEIGHTS } from './config.js';
import { formatTeamMembers } from './format.js';
import { summarizeOpponentPool } from './analytics.js';
import { renderDoneMarker, renderEvolveReport } from './reportMd.js';
import { renderEvolveReportHtml } from './reportHtml.js';

/** Assemble the `result` object the reports render from. */
export function buildResult(env, state, csvPath, fin) {
  const { config, outDir, reportPath, writeHtml, htmlPath, league, importedMons, importWarnings, expanded, eligible, matrix, battleCache } = env;
  const { generationRecords, lastEvaluated, runStartedAtMs, stopReason } = state;
  const { elites, eliteRun, opp, recentWindow, trailing } = fin;
  return {
    collectionPath: csvPath,
    reportPath,
    htmlPath: writeHtml ? htmlPath : null,
    outDir,
    donePath: path.join(outDir, 'evolve-DONE'),
    config,
    league,
    runStartedAt: new Date(runStartedAtMs).toISOString(),
    importWarnings: [...new Set([...importWarnings, ...expanded.warnings, ...eligible.warnings])],
    // Raw CSV rows vs. how many were scored once evolutions expanded the pool.
    collectionMonCount: importedMons.length,
    scoredMonCount: matrix.mons.length,
    generationRecords,
    stopReason,
    elites,
    eliteTiming: {
      battleCount: eliteRun.battleCount,
      cachedCount: eliteRun.cachedCount,
      errorCount: eliteRun.errorCount,
      elapsedMs: eliteRun.elapsedMs,
    },
    eliteOpponents: {
      total: opp.eliteOpponents.length,
      curated: opp.eliteCurated.length,
      evolved: opp.archiveOpponents.length + opp.freshOpponents.length, // sum, for anything reading the older shape
      archive: opp.archiveOpponents.length,
      fresh: opp.freshOpponents.length,
      holdoutGenerations: opp.holdoutGenerations,
      archiveEligible: opp.archiveBuilt.eligible,
      archiveSeen: opp.archiveBuilt.seen,
    },
    ranking: {
      weights: RANKING_WEIGHTS,
      recentWindow,
      selectionTrailing: trailing,
      generationsRun: generationRecords.length,
    },
    finalOpponentPool: summarizeOpponentPool(lastEvaluated.opponentPool ?? [], lastEvaluated.opponentFitness ?? []),
    battleCacheStats: battleCache.stats(),
    totalElapsedMs: Date.now() - runStartedAtMs,
  };
}

/**
 * Write the md/html reports, the trimmed re-render source (evolve-result.json,
 * for `scripts/render-report.mjs`), the machine-readable ranking and the DONE marker.
 */
export function writeOutputs(env, result) {
  const { outDir, reportPath, writeHtml, htmlPath, log } = env;
  mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
  writeFileSync(reportPath, renderEvolveReport(result), 'utf8');
  log(`report written to ${reportPath}`);
  if (writeHtml) {
    mkdirSync(path.dirname(path.resolve(htmlPath)), { recursive: true });
    writeFileSync(htmlPath, renderEvolveReportHtml(result), 'utf8');
    log(`HTML report written to ${htmlPath}`);
  }
  // The bulky per-generation detail is already on disk as checkpoints; keep only each generation's timing.
  const slimRecords = result.generationRecords.map((r) => ({ timing: r.timing, threadsUsed: r.threadsUsed }));
  writeFileSync(
    path.join(outDir, 'evolve-result.json'),
    JSON.stringify({ ...result, generationRecords: slimRecords }, null, 2),
    'utf8'
  );
  writeFileSync(
    path.join(outDir, 'evolve-ranking.json'),
    JSON.stringify(
      result.elites.map((t, i) => ({
        rank: i + 1,
        name: formatTeamMembers(t.members),
        signature: t.signature,
        combinedScore: t.combinedScore,
        winRate: t.winRate,
        recentWinRate: t.recentWinRate,
        selectionFitness: t.selectionFitness,
        sharedWeaknessScore: t.sharedWeaknessScore,
        sharedWeaknessTypes: t.sharedWeaknessTypes,
        winRateByStratum: t.winRateByStratum,
      })),
      null,
      2
    ),
    'utf8'
  );
  writeFileSync(result.donePath, renderDoneMarker(result), 'utf8');
  log(`evolve: DONE (${result.donePath})`);
}

/** Log the --profile summary and close the worker pool. */
export async function closeExecutor(executor, profileDir, log) {
  const stats = await executor.close();
  if (!profileDir || stats.length === 0) return;
  const totalHits = stats.reduce((s, w) => s + w.memoHits, 0);
  const totalMisses = stats.reduce((s, w) => s + w.memoMisses, 0);
  const hitRate = totalHits + totalMisses > 0 ? totalHits / (totalHits + totalMisses) : 0;
  const peakHeapMb = Math.max(...stats.map((w) => w.peakHeapMb ?? 0));
  const totalHeapMb = stats.reduce((s, w) => s + (w.heapMb ?? 0), 0);
  writeFileSync(path.join(profileDir, 'profile-summary.json'), JSON.stringify(stats, null, 2), 'utf8');
  log(
    `evolve: profiling captured -- ${stats.length} worker .cpuprofile file(s) in ${profileDir}, ` +
      `scenario-memo hit rate ${(hitRate * 100).toFixed(1)}% (${totalHits} hits / ${totalMisses} misses), ` +
      `worker heap at exit ${totalHeapMb}MB total (peak ${peakHeapMb}MB on the worst worker); ` +
      `per-worker detail in ${path.join(profileDir, 'profile-summary.json')}`
  );
}
