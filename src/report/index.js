// JavaScript Document
//
// Report rendering for the Great League team generator (GOALS T5). Pure
// formatting: takes the already-computed pipeline outputs (ranked teams from
// src/teams/evaluateTeams, the 1v1 score matrix from src/scoring, and the
// collection warnings) and turns them into (a) a short terminal summary and
// (b) a full Markdown report. No engine, no I/O, no battle math -- callers do
// the computing and the file writing; this module only formats strings, which
// keeps it trivially unit-testable.

/** Format a 0..1 win rate as a whole-number percentage string, e.g. "72%". */
function pct(x) {
  return `${Math.round(x * 100)}%`;
}

/** Format a signed HP margin to one decimal, e.g. "+12.4" / "-3.0". */
function signed(x) {
  const s = x.toFixed(1);
  return x > 0 ? `+${s}` : s;
}

/** Comma-joined member display names for a candidate team. */
function memberNames(team) {
  return team.members.map((m) => m.name).join(', ');
}

/**
 * @typedef {object} ReportInput
 * @property {string} collectionPath - path the collection CSV was read from.
 * @property {number} monCount - user mons successfully scored.
 * @property {import('../teams/index.js').TeamResult[]} rankedTeams
 * @property {Array<{speciesId:string, name:string, score:number, leadIn:string}>} monScores
 *   matrix.mons (per-mon 1v1 weighted scores + lead-in summary).
 * @property {Array<{id:string, name:string}>} metaTeams - opponent pool used.
 * @property {string[]} warnings - collection + scoring warnings, surfaced verbatim.
 * @property {object} settings - the run knobs (topK, metaCount, scoreMeta, etc.).
 * @property {string} [generatedAt] - optional ISO timestamp; omitted -> no date line.
 */

/**
 * Render the short terminal summary (what a user sees on stdout after a run).
 *
 * @param {ReportInput} input
 * @returns {string}
 */
export function renderSummary(input) {
  const { rankedTeams, warnings } = input;
  const lines = [];
  lines.push(`Scored ${input.monCount} Pokemon vs ${input.metaTeams.length} meta teams.`);
  if (rankedTeams.length === 0) {
    lines.push('No candidate teams could be formed (need >= 3 distinct species).');
    return lines.join('\n');
  }
  const shown = Math.min(rankedTeams.length, 5);
  lines.push('');
  lines.push(`Top ${shown} teams by 3v3 win rate:`);
  for (let i = 0; i < shown; i++) {
    const t = rankedTeams[i];
    lines.push(
      `  ${i + 1}. ${memberNames(t)} -- ${pct(t.winRate)} ` +
        `(lead ${t.bestLead.name}, HP margin ${signed(t.avgHpMargin)})`
    );
  }
  if (warnings.length) {
    lines.push('');
    lines.push(`${warnings.length} collection warning(s) -- see report.`);
  }
  return lines.join('\n');
}

/** One ranked-team block in the Markdown report. */
function renderTeamSection(team, rank) {
  const lines = [];
  lines.push(`### ${rank}. ${memberNames(team)}`);
  lines.push('');
  lines.push(`- **Overall win rate:** ${pct(team.winRate)}`);
  lines.push(`- **Best lead:** ${team.bestLead.name} (${pct(team.bestLead.winRate)} when leading)`);
  lines.push(`- **Avg surviving-HP margin:** ${signed(team.avgHpMargin)}`);
  if (team.hardestTeams.length) {
    const hard = team.hardestTeams
      .map((h) => `${h.name} (${pct(h.winRate)})`)
      .join(', ');
    lines.push(`- **Hardest matchups:** ${hard}`);
  }
  lines.push('');
  lines.push('| Opposing meta team | Win% | W | L | T | HP margin |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const pm of team.perMeta) {
    lines.push(
      `| ${pm.name} | ${pct(pm.winRate)} | ${pm.wins} | ${pm.losses} | ${pm.ties} | ${signed(pm.avgHpMargin)} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Render the full Markdown report.
 *
 * Sections: header + settings, ranked team recommendations (each with a win%
 * table vs every meta team, best lead, hardest matchups), a per-mon 1v1 score
 * appendix, and any collection warnings. The fixed-side offset caveat (pvpoke
 * emulate's residual player-1 edge -- see src/teams/index.js) is stated once so
 * absolute win% numbers are read correctly.
 *
 * @param {ReportInput} input
 * @returns {string} Markdown text.
 */
export function renderReport(input) {
  const { rankedTeams, monScores, metaTeams, warnings, settings } = input;
  const out = [];

  out.push('# Great League Team Report');
  out.push('');
  out.push(`Collection: \`${input.collectionPath}\``);
  if (input.generatedAt) out.push(`Generated: ${input.generatedAt}`);
  out.push('');
  out.push(
    `Scored **${input.monCount}** Pokemon from your collection and ranked ` +
      `candidate teams of 3 by simulated **3v3 team-battle** win rate against ` +
      `**${metaTeams.length}** curated meta teams, using pvpoke's own battle engine ` +
      `across all 9 lead pairings per matchup.`
  );
  out.push('');
  out.push(
    '> **Reading the win%:** every candidate is evaluated from the same fixed ' +
      'side, so pvpoke emulate mode\'s small residual player-1 edge is a constant ' +
      'offset shared by all teams -- it cancels in the *relative* ranking, but ' +
      'absolute win% carries that constant offset.'
  );
  out.push('');

  const s = settings;
  out.push('**Settings:** ' +
    [
      `topK=${s.topK}`,
      `candidates=${s.candidateCount}`,
      `metaTeams=${metaTeams.length}`,
      `scoreMeta=${s.scoreMeta}`,
      s.difficulty !== undefined ? `difficulty=${s.difficulty}` : null,
      s.excludeSpecies?.length ? `exclude=${s.excludeSpecies.join('/')}` : null,
    ]
      .filter(Boolean)
      .join(', '));
  out.push('');

  out.push('## Recommended teams');
  out.push('');
  if (rankedTeams.length === 0) {
    out.push('_No candidate teams could be formed -- need at least 3 distinct species in the collection._');
    out.push('');
  } else {
    rankedTeams.forEach((team, i) => {
      out.push(renderTeamSection(team, i + 1));
    });
  }

  out.push('## Opponent meta teams');
  out.push('');
  out.push('The candidate teams above were battled against these curated Great League teams:');
  out.push('');
  metaTeams.forEach((m, i) => out.push(`${i + 1}. ${m.name}`));
  out.push('');

  out.push('## Appendix: per-Pokemon 1v1 scores');
  out.push('');
  out.push(
    'Weighted 1v1 battle rating (0.25·s00 + 0.50·s11 + 0.25·s22, ' +
      'pvpoke 0-1000 scale, averaged over the scoring meta). Used to prune the ' +
      'collection down to the candidate pool; higher is better.'
  );
  out.push('');
  out.push('| Pokemon | Score | 1v1 notes |');
  out.push('| --- | ---: | --- |');
  const sortedMons = [...monScores].sort((a, b) => b.score - a.score);
  for (const m of sortedMons) {
    out.push(`| ${m.name} | ${m.score.toFixed(1)} | ${m.leadIn || ''} |`);
  }
  out.push('');

  out.push('## Collection warnings');
  out.push('');
  if (warnings.length === 0) {
    out.push('_None -- every row imported and scored cleanly._');
  } else {
    for (const w of warnings) out.push(`- ${w}`);
  }
  out.push('');

  return out.join('\n');
}
