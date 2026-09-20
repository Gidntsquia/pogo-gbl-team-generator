import path from 'node:path';
import { DEFAULT_OPPONENT_MUTATION_FLOOR, DEFAULT_OPPONENT_MUTATION_CEIL } from '../meta/opponentPool.js';
import { DEFAULT_MUTATION_FLOOR, DEFAULT_MUTATION_CEIL } from '../teams/evolve.js';
import { buildTopTeamSeries, renderChartInner } from '../report/raceChart.js';
import { LEAGUE_ACCENTS, championshipCss } from '../report/podiumTheme.js';
import { DEFAULTS, RANKING_WEIGHTS } from './config.js';
import { opponentsAt } from './schedule.js';
import { CORE_BREAK_WIN_RATE_MAX, THREAT_WIN_RATE_MAX, splitBreakExposure } from './breakExposure.js';
import { buildCostHtml, escapeHtml, formatDuration, formatTeamMembers, pct, signed } from './format.js';
import { finalPassDescription, fitnessWeightRows, sharedWeaknessLine, stratumLine } from './reportMd.js';

/** Thousands-separate an integer without depending on the host locale. Mirrors src/report/index.js's own `num`. */
function num(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** A level for display: "24" rather than "24.0", but "24.5" kept. Mirrors src/report/index.js's own `lvl`. */
function lvl(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Plain (no "(Lead)" suffix) HTML-escaped "A / B / C" team name, lead first -- used in podium/card headings. */
function plainTeamNamesHtml(members) {
  return members.map((m) => escapeHtml(m.name)).join(' / ');
}

/**
 * "<b>Fast Move</b> + Charged1 / Charged2" -- the moveset {@link
 * reportMemberDetail} read off the member's actual battle-ready `pokemon`
 * instance. Falls back to a plain note when a member predates this field
 * (e.g. an old checkpoint's elites, or a hand-built test fixture) rather
 * than emitting "undefined".
 */
function movesetHtml(m) {
  if (!m.fastMove) return '<span class="movestr">moveset not recorded</span>';
  const charged = (m.chargedMoves ?? []).map(escapeHtml).join(' / ') || '(no charged moves)';
  return `<b>${escapeHtml(m.fastMove)}</b> + ${charged}`;
}

/**
 * "Your 0/6/14 (CP 600, L11) &rarr; power up to L27.5, CP 1500" -- the build
 * line for one team member: where the collection's own copy is today vs. the
 * level/CP the simulator actually battled it at ("no level on file" when the
 * CSV stated none).
 */
function buildLineHtml(m) {
  if (m.ivs == null) return '<span class="build">build not recorded</span>';
  const ivs = `${m.ivs.atk}/${m.ivs.def}/${m.ivs.hp}`;
  const tag = m.shadow ? ' (Shadow)' : m.purified ? ' (Purified)' : '';
  const evolveNote = m.evolveFrom ? `evolve from ${escapeHtml(m.evolveFrom)}, then ` : '';
  if (m.currentLevel == null) {
    return (
      `Your ${ivs}${tag} -- no level on file &rarr; ${evolveNote}` +
      `simulated at <b>L${lvl(m.targetLevel)}, CP ${m.targetCp}</b>`
    );
  }
  const fromPart = `Your ${ivs}${tag} (CP ${m.currentCp}, L${lvl(m.currentLevel)})`;
  if (!m.evolveFrom && m.currentLevel >= m.targetLevel) {
    return `${fromPart} -- already at or above the level simulated`;
  }
  if (m.evolveFrom && m.currentLevel > m.targetLevel) {
    // Evolving preserves level and levels can't go down, so this copy lands
    // above the CP cap -- the simulated build does not exist. (currentCp is
    // the EVOLVED form's CP at the copy's level -- see reportMemberDetail.)
    return (
      `Your ${ivs}${tag} ${escapeHtml(m.evolveFrom)} (L${lvl(m.currentLevel)}) &rarr; ` +
      `<b>not buildable</b>: evolving keeps its level, landing at CP ${m.currentCp} — over the cap ` +
      `(the sim used L${lvl(m.targetLevel)}, CP ${m.targetCp}, and levels can't go down)`
    );
  }
  return `${fromPart} &rarr; ${evolveNote}power up to <b>L${lvl(m.targetLevel)}, CP ${m.targetCp}</b>`;
}

/**
 * One team's detail card: roster table (Pokemon / moveset / build), total
 * build cost (Stardust/Candy/Candy XL, same src/cost/powerup.js totals and
 * caveats the main CLI report's "Build cost:" line uses), score line,
 * safest-switch fact, core-breaker exposure and hardest-opponents table --
 * the same facts renderEvolveReport's "Team detail" section prints per
 * elite, styled as a card. Ranks 1-3 additionally get the medal border color
 * and a medal-emoji heading (the "podium" cards); every other elite gets the
 * same card, numbered.
 *
 * @param {object} t - one `result.elites` entry.
 * @param {number} rank - 1-based.
 * @returns {string} HTML.
 */
function renderTeamCardHtml(t, rank) {
  const medal = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : null;
  const medalEmoji = { gold: '\u{1F947}', silver: '\u{1F948}', bronze: '\u{1F949}' }[medal];
  const heading = medal
    ? `${medalEmoji} ${medal[0].toUpperCase()}${medal.slice(1)} — ${plainTeamNamesHtml(t.members)}`
    : `${rank}. ${plainTeamNamesHtml(t.members)}`;

  const out = [];
  out.push('<section>');
  out.push(`<h2 id="team-${rank}">${heading}<span class="rule"></span></h2>`);
  out.push(`<div class="card${medal ? ` ${medal}` : ''}">`);
  out.push(
    `<p class="scoreline"><b>${pct(t.combinedScore)} score</b> &middot; ${pct(t.winRate)} across the elites pass ` +
      `(${t.battles} battles${t.errors ? `, ${t.errors} errors` : ''}) &middot; ${pct(t.recentWinRate)} over its last ` +
      `${t.recentGenerations || 0} generation(s)${t.recentGenerations ? '' : ' (newer than the trailing window; ranks on the elites pass alone)'}</p>`
  );
  const strata = stratumLine(t.winRateByStratum);
  if (strata) out.push(`<p class="factline">By opponent stratum (unweighted): ${escapeHtml(strata)}</p>`);
  if (typeof t.consistencyScore === 'number') {
    out.push(
      `<p class="factline">Worst-quartile archetype win%: ${pct(t.consistencyScore)}` +
        (t.archetypeCount ? ` (25th percentile over ${t.archetypeCount} opponent archetypes)` : ' (fallback: overall win rate, too few archetypes)') +
        '</p>'
    );
  }
  if (typeof t.sharedWeaknessScore === 'number') {
    out.push(`<p class="factline">Shared-weakness coverage: ${pct(t.sharedWeaknessScore)}</p>`);
    const threats = sharedWeaknessLine(t.sharedWeaknessTypes);
    if (threats) out.push(`<p class="factline">Shared type pressure: ${escapeHtml(threats)}</p>`);
  }
  out.push('<div class="roster-wrap">');
  out.push('<table><tr><th>Pokémon</th><th>Moves (as simulated)</th><th>Build from your collection</th></tr>');
  t.members.forEach((m, i) => {
    out.push(
      `<tr><td><b>${escapeHtml(m.name)}</b>${i === 0 ? ' — lead' : ''}</td>` +
        `<td class="movestr">${movesetHtml(m)}</td>` +
        `<td class="build">${buildLineHtml(m)}</td></tr>`
    );
  });
  out.push('</table>');
  out.push('</div>');
  out.push(`<p class="factline">Build cost: ${buildCostHtml(t.buildCost)}</p>`);
  if (t.safeSwap) {
    out.push(
      `<p class="factline">Safest first switch: <b>${escapeHtml(t.safeSwap.name)}</b> (avg ${pct(t.safeSwap.avgHpPct)} HP remaining when switched in).</p>`
    );
  }
  const { core, threats } = splitBreakExposure(t.coreBreakExposure);
  out.push(
    `<p class="breakers">Watch for: <b>${core.length ? core.map((s) => escapeHtml(s.name)).join(', ') : 'nothing so far'}</b>` +
      ` — the species this team wins under ${Math.round(CORE_BREAK_WIN_RATE_MAX * 100)}% against when they show up.</p>`
  );
  if (threats.length) {
    out.push(
      `<p class="breakers">Threats: ${threats.map((s) => escapeHtml(s.name)).join(', ')}` +
        ` — matchups it only wins ${Math.round(CORE_BREAK_WIN_RATE_MAX * 100)}–${Math.round(THREAT_WIN_RATE_MAX * 100)}% of the time, worst first.</p>`
    );
  }
  if (t.hardestOpponents?.length) {
    out.push('<div class="table-wrap"><table><tr><th>Hardest opponents</th><th class="num">Win%</th><th class="num">W</th><th class="num">L</th><th class="num">T</th><th class="num">HP margin</th></tr>');
    for (const h of t.hardestOpponents) {
      out.push(
        `<tr><td>${escapeHtml(h.name)}${h.label ? ` <em>(${escapeHtml(h.label)})</em>` : ''}</td>` +
          `<td class="num">${pct(h.winRate)}</td><td class="num">${h.wins}</td><td class="num">${h.losses}</td>` +
          `<td class="num">${h.ties}</td><td class="num">${signed(h.avgHpMargin)}</td></tr>`
      );
    }
    out.push('</table></div>');
  }
  out.push('</div>');
  out.push('</section>');
  return out.join('\n');
}

/**
 * Render the same run result as a single self-contained HTML page (no
 * external requests -- opens directly via `file://` and is safe to publish
 * as a claude.ai Artifact): a podium hero for the top 3 elites, a full detail
 * card per elite, the animated per-generation win-rate race (embedded straight
 * from `result.generationRecords`/`result.elites` -- see
 * src/report/raceChart.js), a full-standings table, data-driven run notes and
 * a footer. Same underlying facts as {@link renderEvolveReport} (nothing that
 * report says is dropped here, only re-homed into this design's sections);
 * see the module-level design note above renderEvolveReport for the shared
 * numbers. All interpolated text sourced from user CSV/gamemaster data is
 * HTML-escaped.
 *
 * @param {object} result - same shape renderEvolveReport takes.
 * @returns {string} HTML document text.
 */
export function renderEvolveReportHtml(result) {
  const { config, generationRecords, elites, stopReason, importWarnings, league } = result;
  const eo = result.eliteOpponents ?? { total: 0, curated: 0, evolved: 0 };
  const totalBattles = generationRecords.reduce((s, r) => s + r.timing.battleCount, 0) + result.eliteTiming.battleCount;
  const totalCached = generationRecords.reduce((s, r) => s + (r.timing.cachedCount ?? 0), 0) + (result.eliteTiming.cachedCount ?? 0);
  const totalErrors = generationRecords.reduce((s, r) => s + r.timing.errorCount, 0) + result.eliteTiming.errorCount;
  const lastRecord = generationRecords.length ? generationRecords[generationRecords.length - 1] : null;
  const threadsLabel = lastRecord?.threadsUsed ? `${lastRecord.threadsUsed} threads` : 'serial';
  const collectionBase = escapeHtml(path.basename(result.collectionPath ?? 'collection.csv'));
  const podiumCount = Math.min(3, elites.length);
  // Accent color keyed to the actual league this run battled in (pvpoke's own
  // group names, see src/util/leagues.js) -- a Great League report reads
  // differently from a Master League one because they ARE different formats,
  // not as a decorative flourish. Falls back to Great League's green for any
  // future group leagueForCp might add.
  const accents = LEAGUE_ACCENTS[league.group] ?? LEAGUE_ACCENTS.great;

  // Race chart: built straight from the in-memory generation records this
  // very run just produced (see requirement note above raceChart.js's
  // buildTopTeamSeries) -- no re-reading the checkpoint files it also wrote.
  const rankingEntries = elites.map((t, i) => ({ signature: t.signature, rank: i + 1, name: formatTeamMembers(t.members) }));
  const chartData = buildTopTeamSeries(generationRecords, rankingEntries, 10);

  const out = [];
  out.push('<!doctype html>');
  out.push('<html lang="en">');
  out.push('<head>');
  out.push('<meta charset="utf-8">');
  out.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  out.push(`<title>${escapeHtml(league.name)} Podium — ${collectionBase}</title>`);
  out.push(`<style>${championshipCss(accents)}</style>`);
  out.push('</head>');
  out.push('<body>');
  out.push('<div class="wrap">');

  out.push(`<p class="eyebrow">${escapeHtml(league.name)} · CP ${config.cp} · ${collectionBase}</p>`);
  out.push('<h1>The Podium</h1>');
  // The sim-description line renders BELOW the podium (Jaxon's requested
  // order: medals first, methodology after).
  const subHtml =
    `<p class="sub">${generationRecords.length} generation${generationRecords.length === 1 ? '' : 's'} of full 3v3 ` +
    `battle simulation${result.collectionMonCount ? ` over your ${result.collectionMonCount}-mon collection` : ''} ` +
    `— <strong>${num(totalBattles)} battles fought</strong> against ${eo.total} elites-pass opponents ` +
    `(${typeof eo.archive === 'number' ? `${eo.curated} curated + ${eo.archive} held-out archive + ${eo.fresh ?? 0} fresh` : `${eo.curated} curated + ${eo.evolved} evolved`}), ` +
    'plus everything the earlier generations battled through. ' +
    `${podiumCount === 1 ? 'This team' : `These ${podiumCount} teams`} survived everything the run threw at ` +
    `${podiumCount === 1 ? 'it' : 'them'}.</p>`;

  if (elites.length === 0) {
    out.push('<p><em>No elite teams were produced.</em></p>');
    out.push(subHtml);
  } else {
    const podium = elites.slice(0, podiumCount);
    // DOM order p2/p1/p3 (matches the design's Olympic-podium visual: 1st in
    // the tall middle column) -- only as many steps as elites exist.
    const order = [1, 0, 2].filter((i) => i < podium.length);
    out.push(`<div class="podium" aria-label="Top ${podium.length} teams, Olympic podium" style="grid-template-columns: repeat(${podium.length}, 1fr);">`);
    for (const i of order) {
      const t = podium[i];
      const rank = i + 1;
      const label = rank === 1 ? 'First place' : rank === 2 ? 'Second place' : 'Third place';
      out.push(`<div class="step p${rank}">`);
      out.push(`<div class="medal-badge" aria-label="${label}">${rank}</div>`);
      out.push('<div class="team">');
      t.members.forEach((m, mi) => {
        out.push(`<span class="mon">${escapeHtml(m.name)}${mi === 0 ? '<span class="lead-tag">LEAD</span>' : ''}</span>`);
      });
      out.push('</div>');
      out.push(`<div class="block"><span class="score">${pct(t.combinedScore)}</span><span class="score-label">score</span></div>`);
      out.push('</div>');
    }
    out.push('</div>');
    out.push(subHtml);
    const podiumSpecies = [...new Set(podium.flatMap((t) => t.members.map((m) => m.name)))];
    out.push(
      `<p class="podium-note">Score = ${result.ranking?.weights?.elitePass ?? RANKING_WEIGHTS.elitePass} &times; the ` +
        `elites-pass win% + ${result.ranking?.weights?.recent ?? RANKING_WEIGHTS.recent} &times; the mean win% over the ` +
        `last ${result.ranking?.recentWindow ?? 0} generation(s). ${podiumSpecies.length} build${podiumSpecies.length === 1 ? '' : 's'} ` +
        `— ${podiumSpecies.map(escapeHtml).join(', ')} — ${podiumSpecies.length === 1 ? 'is' : 'unlock'} ` +
        `${podiumCount === 1 ? 'this team' : `all ${podiumCount} teams`}.</p>`
    );
  }

  // The race sits directly under the podium -- the same story continued,
  // not a supporting appendix -- so it comes before the per-team detail
  // cards and standings.
  out.push('<section>');
  out.push('<h2>The race<span class="rule"></span></h2>');
  out.push('<div class="race-embed">');
  if (chartData.teams.length > 0) {
    out.push(
      `<p class="note" style="color:var(--muted);font-size:0.9rem;margin:0 0 0.75rem;">Every team that cracked a ` +
        `generation's top ${chartData.topCount} by fitness across all ${chartData.generations} generation(s); the ` +
        `${chartData.teams.filter((t) => t.rank !== null).length} teams in the final ranking are colored, the rest are ` +
        'the muted field that got bred out.</p>'
    );
    out.push('<div class="chart-scroll">');
    out.push(renderChartInner(chartData));
    out.push('</div>');
  } else {
    out.push('<p><em>No per-generation history to animate (0 generations ran).</em></p>');
  }
  out.push('</div>');
  out.push('</section>');

  if (elites.length > 0) {
    elites.forEach((t, i) => out.push(renderTeamCardHtml(t, i + 1)));
  }

  out.push('<section>');
  out.push('<h2>Full standings<span class="rule"></span></h2>');
  out.push('<div class="table-wrap">');
  out.push('<table class="standings"><tr><th>#</th><th>Team (lead first)</th><th class="num">Score</th><th class="num">Elites pass</th><th class="num">Last gens</th></tr>');
  elites.forEach((t, i) => {
    const rank = i + 1;
    const dot = rank === 1 ? 'var(--gold)' : rank === 2 ? 'var(--silver)' : rank === 3 ? 'var(--bronze)' : null;
    out.push(
      `<tr><td>${rank}</td><td>${dot ? `<span class="medal-dot" style="background:${dot}"></span>` : ''}` +
        `${plainTeamNamesHtml(t.members)}</td><td class="num">${rank <= 3 ? `<b>${pct(t.combinedScore)}</b>` : pct(t.combinedScore)}</td>` +
        `<td class="num">${pct(t.winRate)}</td><td class="num">${pct(t.recentWinRate)}</td></tr>`
    );
  });
  out.push('</table>');
  out.push('</div>');
  out.push('</section>');

  out.push('<section>');
  out.push('<h2>Fitness weights<span class="rule"></span></h2>');
  out.push('<div class="table-wrap">');
  out.push('<table><tr><th>Flag</th><th class="num">Value</th></tr>');
  for (const [label, value] of fitnessWeightRows(config)) {
    out.push(`<tr><td>${escapeHtml(label)}</td><td class="num">${escapeHtml(String(value))}</td></tr>`);
  }
  out.push('</table>');
  out.push('</div>');
  out.push('</section>');

  if (result.finalOpponentPool?.toughest?.length) {
    out.push('<section>');
    out.push(`<h2>Top ${result.finalOpponentPool.toughest.length} opponent teams<span class="rule"></span></h2>`);
    out.push('<p class="podium-note" style="margin-bottom:1.25rem;">Final generation\'s opponent pool, ranked by opponent fitness — the strongest teams the opponent GA bred to beat the candidates above.</p>');
    out.push('<div class="table-wrap">');
    out.push('<table><tr><th class="num">#</th><th>Team</th><th>Origin</th><th class="num">Fitness</th></tr>');
    result.finalOpponentPool.toughest.forEach((o, i) => {
      out.push(
        `<tr><td class="num">${i + 1}</td><td>${escapeHtml(o.name)}</td><td>${escapeHtml(o.origin ?? 'unknown')}</td>` +
          `<td class="num">${pct(o.fitness)}</td></tr>`
      );
    });
    out.push('</table>');
    out.push('</div>');
    out.push('</section>');
  }

  out.push('<section>');
  out.push('<h2>Run notes<span class="rule"></span></h2>');
  out.push('<ul class="notes">');
  out.push(`<li><b>${generationRecords.length} generation(s)</b> of a ${config.generations} cap — ${escapeHtml(stopReason)}.</li>`);
  out.push(
    `<li><b>${num(totalBattles)} battles</b> simulated (+${num(totalCached)} served from the memo cache, ${totalErrors} errors), ` +
      `${escapeHtml(formatDuration(result.totalElapsedMs))} total, ${escapeHtml(threadsLabel)}. Population ${config.population} ` +
      `→ ${Math.round(config.population * config.populationFinalRatio)} while the opponent pool grew ${config.opponentsPerGen} ` +
      `→ ${opponentsAt(config.generations - 1, config)}.</li>`
  );
  out.push(`<li><b>How the final pass was scored.</b> ${escapeHtml(finalPassDescription(eo, result.ranking ?? { weights: RANKING_WEIGHTS, recentWindow: 0 })).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</li>`);
  out.push(
    `<li><b>Setup:</b> seed <code>${escapeHtml(config.seed)}</code>, cp=${config.cp}, cup=${config.cup ?? DEFAULTS.cup}, pool=${config.pool}, ` +
      `curated-ratio=${config.curatedRatio}, fitness=${escapeHtml(config.fitness)}` +
      (config.evolutions === false ? ', evolutions=off' : '') +
      (config.fixedOpponents ? ', fixed-opponents' : '') +
      '.</li>'
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
    out.push(`<li><b>GA overrides:</b> ${escapeHtml(ga.join(', '))}.</li>`);
  }
  if (config.excludeSpecies.length) out.push(`<li><b>Excluded species:</b> ${config.excludeSpecies.map(escapeHtml).join(', ')}.</li>`);
  if (config.banSpecies.length) out.push(`<li><b>Banned species</b> (format-wide cup rule, candidates and opponents): ${config.banSpecies.map(escapeHtml).join(', ')}.</li>`);
  for (const w of importWarnings) out.push(`<li><b>Import warning:</b> ${escapeHtml(w)}</li>`);
  out.push('</ul>');
  out.push('</section>');

  out.push(
    `<p class="foot">${escapeHtml(path.basename(result.outDir ?? '.'))} &middot; seed <code>${escapeHtml(config.seed)}</code> ` +
      `&middot; ${collectionBase}${result.collectionMonCount ? ` (${result.collectionMonCount} mons${result.scoredMonCount && result.scoredMonCount !== result.collectionMonCount ? `, ${result.scoredMonCount} with evolutions` : ''})` : ''} ` +
      `&middot; simulated ${escapeHtml(new Date().toISOString().slice(0, 10))} with pvpoke's own battle engine &middot; ` +
      `full details in <code>${escapeHtml(result.reportPath ?? 'my-teams-evolve.md')}</code></p>`
  );

  out.push('</div></body>');
  out.push('</html>');

  return out.join('\n');
}
