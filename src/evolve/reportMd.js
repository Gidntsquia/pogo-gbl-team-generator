import { DEFAULT_OPPONENT_MUTATION_FLOOR, DEFAULT_OPPONENT_MUTATION_CEIL } from '../meta/opponentPool.js';
import { DEFAULT_MUTATION_FLOOR, DEFAULT_MUTATION_CEIL } from '../teams/evolve.js';
import { DEFAULTS, RANKING_WEIGHTS } from './config.js';
import { opponentsAt } from './schedule.js';
import { splitBreakExposure } from './breakExposure.js';
import { formatDuration, formatTeamMembers, pct, signed } from './format.js';

/**
 * Fitness/GA weight flags worth surfacing in a report, as ordered
 * [label, value] pairs -- shared by the Markdown and HTML renderers so the
 * two never drift. Pulled straight off `config`; only flags actually present
 * are shown, so an older checkpoint's report just omits newer ones.
 */
export function fitnessWeightRows(config) {
  const rows = [
    ['snowball weight', config.snowballWeight],
    ['closer weight', config.closerWeight],
    ['consistency weight', config.consistencyWeight],
    ['core-rivalry weight', config.coreRivalry],
    ['similar-rivalry weight', config.similarRivalry],
    ['similar floor', config.similarFloor],
    ['shared-weakness weight', config.sharedWeaknessWeight],
    ['opponent snowball weight', config.opponentSnowballWeight],
    ['opponent closer weight', config.opponentCloserWeight],
    ['opponent consistency weight', config.opponentConsistencyWeight],
    ['opponent shared-weakness weight', config.opponentSharedWeaknessWeight],
    ['archetype beta', config.archetypeBeta],
    ['opponent-strength gamma', config.opponentStrengthGamma],
    ['candidate-strength gamma', config.candidateStrengthGamma],
    ['opponent fitness normalised', config.opponentFitnessNormalised],
    ['fitness semantics', config.fitnessSemantics],
  ];
  return rows.filter(([, value]) => value !== undefined && value !== null);
}

export function renderEvolveReport(result) {
  const { config, generationRecords, elites, stopReason, importWarnings, league } = result;
  const eo = result.eliteOpponents ?? { total: 0, curated: 0, evolved: 0 };
  const rk = result.ranking ?? { weights: RANKING_WEIGHTS, recentWindow: 0, generationsRun: generationRecords.length };
  const totalBattles = generationRecords.reduce((s, r) => s + r.timing.battleCount, 0) + result.eliteTiming.battleCount;
  const totalCached = generationRecords.reduce((s, r) => s + (r.timing.cachedCount ?? 0), 0) + (result.eliteTiming.cachedCount ?? 0);
  const totalErrors = generationRecords.reduce((s, r) => s + r.timing.errorCount, 0) + result.eliteTiming.errorCount;
  const lastRecord = generationRecords.length ? generationRecords[generationRecords.length - 1] : null;
  const threadsLabel = lastRecord?.threadsUsed ? `${lastRecord.threadsUsed} threads` : 'serial';
  const out = [];

  out.push(`# ${league.name} Evolutionary Team Search Report`);
  out.push('');
  out.push(`Collection: \`${result.collectionPath}\` -- generated ${new Date().toISOString()}`);
  out.push('');

  out.push(`## Top ${elites.length} teams`);
  out.push('');
  out.push(finalPassDescription(eo, rk));
  out.push('');
  if (elites.length === 0) {
    out.push('_No elite teams were produced._');
    out.push('');
  } else {
    out.push('| Rank | Team (Lead / Back / Back) | Score | Elites-pass win% | Last-gens win% | Core breakers |');
    out.push('| --- | --- | ---: | ---: | ---: | --- |');
    elites.forEach((t, i) => {
      const { core } = splitBreakExposure(t.coreBreakExposure);
      const breakers = core.length ? core.map((s) => s.name).join(', ') : 'none';
      out.push(
        `| ${i + 1} | ${formatTeamMembers(t.members)} | **${pct(t.combinedScore)}** | ${pct(t.winRate)} | ` +
          `${pct(t.recentWinRate)} | ${breakers} |`
      );
    });
    out.push('');
  }

  out.push('## Team detail');
  out.push('');
  elites.forEach((t, i) => {
    out.push(`### ${i + 1}. ${formatTeamMembers(t.members)}`);
    out.push('');
    out.push(
      `- **Score:** ${pct(t.combinedScore)} -- ${pct(t.winRate)} elites-pass across ${t.battles} battles` +
        `${t.errors ? ` (${t.errors} errors)` : ''}, ${pct(t.recentWinRate)} over the ` +
        `${t.recentGenerations || 0} generation(s) it lived through the trailing window` +
        (t.recentGenerations ? '' : ' (newer than the window; ranks on the elites pass alone)')
    );
    const strata = stratumLine(t.winRateByStratum);
    if (strata) out.push(`- **By opponent stratum (unweighted):** ${strata}`);
    if (typeof t.consistencyScore === 'number') {
      out.push(
        `- **Worst-quartile archetype win%:** ${pct(t.consistencyScore)}` +
          (t.archetypeCount ? ` (25th percentile over ${t.archetypeCount} opponent archetypes)` : ' (fallback: overall win rate, too few archetypes)')
      );
    }
    if (typeof t.sharedWeaknessScore === 'number') {
      out.push(`- **Shared-weakness coverage:** ${pct(t.sharedWeaknessScore)}`);
      const threats = sharedWeaknessLine(t.sharedWeaknessTypes);
      if (threats) out.push(`- **Shared type pressure:** ${threats}`);
    }
    if (typeof t.selectionFitness === 'number') {
      out.push(`- **Finalist on:** ${pct(t.selectionFitness)} mean fitness over its last ${rk.selectionTrailing ?? '?'} generation(s)`);
    }
    out.push(
      `- **Lead:** ${t.bestLead.name}` +
        (t.safeSwap ? ` -- **safest first switch:** ${t.safeSwap.name} (avg ${pct(t.safeSwap.avgHpPct)} HP remaining when switched in)` : '')
    );
    const { core, threats } = splitBreakExposure(t.coreBreakExposure);
    out.push(`- **Core breakers:** ${core.length ? core.map((s) => s.name).join(', ') : 'none'}`);
    if (threats.length) {
      out.push(`- **Threats:** ${threats.map((s) => s.name).join(', ')}`);
    }
    out.push('');
    out.push('5 hardest opponents (by win%):');
    out.push('');
    out.push('| Opponent | Win% | W | L | T | HP margin |');
    out.push('| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const h of t.hardestOpponents) {
      out.push(`| ${h.name}${h.label ? ` _(${h.label})_` : ''} | ${pct(h.winRate)} | ${h.wins} | ${h.losses} | ${h.ties} | ${signed(h.avgHpMargin)} |`);
    }
    out.push('');
  });

  out.push('## Fitness weights');
  out.push('');
  out.push('| Flag | Value |');
  out.push('| --- | ---: |');
  for (const [label, value] of fitnessWeightRows(config)) out.push(`| ${label} | ${value} |`);
  out.push('');

  if (result.finalOpponentPool?.toughest?.length) {
    out.push(`## Top ${result.finalOpponentPool.toughest.length} opponent teams`);
    out.push('');
    out.push("Final generation's opponent pool, ranked by opponent fitness -- the strongest teams the opponent GA bred to beat the candidates above.");
    out.push('');
    out.push('| Rank | Team | Origin | Fitness |');
    out.push('| --- | --- | --- | ---: |');
    result.finalOpponentPool.toughest.forEach((o, i) => {
      out.push(`| ${i + 1} | ${o.name} | ${o.origin ?? 'unknown'} | ${pct(o.fitness)} |`);
    });
    out.push('');
  }

  out.push('## Run facts');
  out.push('');
  out.push(`- ${generationRecords.length} generation(s) of a ${config.generations} cap -- ${stopReason}`);
  out.push(
    `- ${totalBattles} battles simulated (+${totalCached} served from the memo cache, ${totalErrors} errors), ` +
      `${formatDuration(result.totalElapsedMs)} total, ${threadsLabel}`
  );
  out.push(
    `- seed \`${config.seed}\`, cp=${config.cp}, cup=${config.cup ?? DEFAULTS.cup}, population ${config.population} -> ` +
      `${Math.round(config.population * config.populationFinalRatio)}, opponents ${config.opponentsPerGen} -> ` +
      `${opponentsAt(config.generations - 1, config)}, pool=${config.pool}, curated-ratio=${config.curatedRatio}, ` +
      `fitness=${config.fitness}` +
      (config.evolutions === false ? ', evolutions=off' : '') +
      (config.fixedOpponents ? ', fixed-opponents' : '') +
      (config.banSpecies.length ? `, ban=${config.banSpecies.join(',')}` : '')
  );
  if (config.deathRate !== undefined || config.mutationFloor !== undefined || config.mutationCeil !== undefined || config.mutationFloorStart !== undefined || config.mutationCeilStart !== undefined || config.immigrantFraction !== undefined || config.opponentImmigrantFraction !== undefined || config.convergence !== undefined) {
    const ga = [];
    if (config.deathRate !== undefined) ga.push(`death-rate=${config.deathRate}`);
    if (config.mutationFloor !== undefined) ga.push(`mutation-floor=${config.mutationFloor}`);
    if (config.mutationCeil !== undefined) ga.push(`mutation-ceil=${config.mutationCeil}`);
    if (config.mutationFloorStart !== undefined) ga.push(`mutation-floor-start=${config.mutationFloorStart} (annealed to ${config.mutationFloor ?? DEFAULT_MUTATION_FLOOR})`);
    if (config.mutationCeilStart !== undefined) ga.push(`mutation-ceil-start=${config.mutationCeilStart} (annealed to ${config.mutationCeil ?? DEFAULT_MUTATION_CEIL})`);
    if (config.immigrantFraction !== undefined) ga.push(`immigrant-fraction=${config.immigrantFraction}`);
    if (config.opponentDeathRate !== undefined) ga.push(`opponent-death-rate=${config.opponentDeathRate}`);
    if (config.opponentMutationFloor !== undefined) ga.push(`opponent-mutation-floor=${config.opponentMutationFloor}`);
    if (config.opponentMutationCeil !== undefined) ga.push(`opponent-mutation-ceil=${config.opponentMutationCeil}`);
    if (config.opponentMutationFloorStart !== undefined) ga.push(`opponent-mutation-floor-start=${config.opponentMutationFloorStart} (annealed to ${config.opponentMutationFloor ?? DEFAULT_OPPONENT_MUTATION_FLOOR})`);
    if (config.opponentMutationCeilStart !== undefined) ga.push(`opponent-mutation-ceil-start=${config.opponentMutationCeilStart} (annealed to ${config.opponentMutationCeil ?? DEFAULT_OPPONENT_MUTATION_CEIL})`);
    if (config.opponentImmigrantFraction !== undefined) ga.push(`opponent-immigrant-fraction=${config.opponentImmigrantFraction}`);
    if (config.convergence !== undefined) ga.push(`convergence=0-churn top-${config.convergence.topN} across ${config.convergence.window} generations`);
    out.push(`- GA overrides: ${ga.join(', ')}`);
  }
  if (config.excludeSpecies.length) out.push(`- excluded species: ${config.excludeSpecies.join(', ')}`);
  if (config.banSpecies.length) out.push(`- banned species (format-wide cup rule, candidates and opponents): ${config.banSpecies.join(', ')}`);
  for (const w of importWarnings) out.push(`- import warning: ${w}`);
  out.push('');

  return out.join('\n');
}

/**
 * The one paragraph both reports open with: what the final pass fought, how
 * it is weighted, and how the finalists were picked. `eo` is
 * `result.eliteOpponents`; an older shape (no `archive`/`fresh`) is described
 * as plain "evolved" opponents.
 */
export function finalPassDescription(eo, rk) {
  const hasStrata = typeof eo.archive === 'number' || typeof eo.fresh === 'number';
  const mix = hasStrata
    ? `${eo.curated} curated + ${eo.archive ?? 0} held-out archive + ${eo.fresh ?? 0} fresh`
    : `${eo.curated} curated + ${eo.evolved} evolved`;
  const weighting =
    eo.curated > 0
      ? 'Curated teams are weighted by tier (ladder-observed 1, "recommended" 0.5, off-meta 0.25); the bred and ' +
        'composed opponents together carry the run\'s own curated-ratio share of the total weight.'
      : 'Every opponent carries the same weight.';
  const holdout = hasStrata
    ? ` The archive holds the strongest opponents the opponent GA bred over the whole run, excluding any that sat in ` +
      `the pools of the last ${eo.holdoutGenerations ?? '?'} generation(s)` +
      (typeof eo.archiveEligible === 'number' ? ` (${eo.archiveEligible} eligible of ${eo.archiveSeen} seen)` : '') +
      '; the fresh teams are meta-composed and were never fought during the run -- so the pass is out-of-sample for ' +
      'the number that chose the finalists.'
    : '';
  const finalists =
    typeof rk.selectionTrailing === 'number'
      ? ` Finalists are the last generation's top teams by their mean fitness over their last ${rk.selectionTrailing} generation(s).`
      : '';
  return (
    `Win% is a weighted mean over battles against each of the ${eo.total} elites-pass opponents (${mix}), each ` +
    `opponent battled from both seats (both directions) at their designated leads and the mirrored result tallied ` +
    `identically. ${weighting}${holdout}${finalists} **Score** (the sort key) = ` +
    `${rk.weights.elitePass} x that win% + ${rk.weights.recent} x the team's mean win% over the last ` +
    `${rk.recentWindow} generation(s). Absolute win% carries pvpoke emulate mode's small constant team-A offset; ` +
    'the ranking is relative, so it cancels.'
  );
}

/** "curated 52% (147) · archive 48% (400) · fresh 55% (400)" from an elite's `winRateByStratum`, or '' when absent. */
export function stratumLine(byStratum) {
  if (!byStratum) return '';
  const order = ['curated', 'archive', 'fresh'];
  const keys = [...order.filter((k) => k in byStratum), ...Object.keys(byStratum).filter((k) => !order.includes(k))];
  return keys.map((k) => `${k} ${pct(byStratum[k].winRate)} (${byStratum[k].battles})`).join(' · ');
}

export function sharedWeaknessLine(sharedTypes) {
  return [...(sharedTypes ?? [])]
    .filter((entry) => entry.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution || a.type.localeCompare(b.type))
    .map(
      (entry) =>
        `${entry.type} (${pct(entry.prevalence)} meta share, ${pct(entry.leadCoverage)} moveset coverage, ` +
        `${pct(entry.resistanceOffset)} resistance offset)`
    )
    .join('; ');
}

export function renderDoneMarker(result) {
  const lines = [new Date().toISOString()];
  lines.push(`Evolution complete: ${result.generationRecords.length} generation(s) run (${result.stopReason}).`);
  const top = result.elites[0];
  if (top) {
    lines.push(
      `Top team: ${formatTeamMembers(top.members)} (score ${pct(top.combinedScore)} = ` +
        `${pct(top.winRate)} elites-pass / ${pct(top.recentWinRate)} last-${result.ranking?.recentWindow ?? '?'}-generations).`
    );
  } else {
    lines.push('No elite teams were produced.');
  }
  if (result.config.banSpecies?.length) {
    lines.push(`Banned species (format-wide cup rule): ${result.config.banSpecies.join(', ')}.`);
  }
  const totalBattles = result.generationRecords.reduce((s, r) => s + r.timing.battleCount, 0) + result.eliteTiming.battleCount;
  const totalErrors = result.generationRecords.reduce((s, r) => s + r.timing.errorCount, 0) + result.eliteTiming.errorCount;
  lines.push(`Battle errors: ${totalErrors} of ${totalBattles} total battles (skip-and-continue; see report for details).`);
  lines.push(`Total elapsed: ${formatDuration(result.totalElapsedMs)}.`);
  lines.push(`Report: ${result.reportPath}`);
  return `${lines.join('\n')}\n`;
}
