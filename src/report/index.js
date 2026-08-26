// JavaScript Document
//
// Report rendering for the team generator. Pure
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
 * Format one role score ([0,1] from src/meta/roles.js) as a
 * percentage for a report cell, or an em dash when the species has no entry
 * in `roleScores` at all (never happens for a real gamemaster speciesId
 * under the pinned vendor commit, but `roleScores` is caller-supplied and a
 * missing species should render as "no data," not crash).
 */
function roleCell(roleScores, speciesId, role) {
  const entry = roleScores?.get(speciesId);
  return entry ? pct(entry[role]) : '—';
}

/** Thousands-separate an integer without depending on the host locale. */
function num(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** A level for display: "24" rather than "24.0", but "24.5" kept. */
function lvl(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * Human summary of a team's build cost (src/cost/powerup.js), e.g.
 * "168,500 Stardust + 214 Candy". Zero cost means every member is already at
 * (or past) the level the simulator played it at.
 *
 * @param {object} cost - TeamResult.buildCost
 * @returns {string}
 */
function formatBuildCost(cost) {
  const parts = [];
  if (cost.stardust) parts.push(`${num(cost.stardust)} Stardust`);
  if (cost.candy) parts.push(`${num(cost.candy)} Candy`);
  if (cost.candyXl) parts.push(`${num(cost.candyXl)} Candy XL`);
  let body = parts.length ? parts.join(' + ') : 'none -- already built';
  if (cost.evolveItems?.length) body += `, plus ${cost.evolveItems.join(' + ')}`;

  const caveats = [];
  if (cost.unknownLevels) {
    caveats.push(
      `${cost.unknownLevels} member${cost.unknownLevels === 1 ? '' : 's'} whose collection row stated no level`
    );
  }
  if (cost.unpricedEvolutions) {
    caveats.push(
      `${cost.unpricedEvolutions} evolution${cost.unpricedEvolutions === 1 ? '' : 's'} with no published candy cost`
    );
  }
  return caveats.length ? `${body} (excludes ${caveats.join(' and ')})` : body;
}

/** "from Phantump (200 candy)" for a member the pipeline had to evolve. */
function evolveCell(m) {
  if (!m.evolveFrom) return null;
  const bits = [`from ${m.evolveFrom}`];
  if (m.evolvePriced) bits.push(`${num(m.evolveCandy)} candy`);
  else bits.push('candy cost unpublished');
  if (m.evolveBuddyKm) bits.push(`${m.evolveBuddyKm} km buddy`);
  if (m.evolveItems.length) bits.push(m.evolveItems.join(' + '));
  return `${bits[0]} (${bits.slice(1).join(', ')})`;
}

/**
 * How to describe what was scored. With evolution expansion on (the default)
 * `monCount` counts FORMS, not Pokemon -- one Phantump is scored twice, as
 * itself and as Trevenant -- so say so rather than overstating the size of
 * the collection.
 *
 * @param {ReportInput} input
 * @returns {string}
 */
function formsPhrase(input) {
  const owned = input.ownedCount;
  if (typeof owned !== 'number' || owned === input.monCount) return 'Pokemon from your collection';
  return `forms of the ${num(owned)} Pokemon in your collection (each scored as itself and as anything it can evolve into)`;
}

/** Escape text for safe interpolation into HTML (report data includes raw CSV/species strings). */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

/**
 * @typedef {object} ReportInput
 * @property {string} collectionPath - path the collection CSV was read from.
 * @property {number} monCount - user mons successfully scored. With evolution
 *   expansion on this counts FORMS, not distinct Pokemon -- see `ownedCount`.
 * @property {number} [ownedCount] - how many Pokemon the collection CSV
 *   actually held, before evolved variants were added.
 * @property {import('../teams/index.js').TeamResult[]} rankedTeams
 * @property {Array<{speciesId:string, name:string, score:number, leadIn:string}>} monScores
 *   matrix.mons (per-mon 1v1 weighted scores + lead-in summary).
 * @property {Map<string, {lead:number, closer:number, switch:number}>} [roleScores]
 *   Per-species lead/closer/switch priors from
 *   src/meta/roles.js's `loadRoleScores` (each in [0,1]), keyed by
 *   speciesId. Optional -- when absent, the per-mon appendix renders
 *   exactly as it did without them (no extra columns), so older callers/tests
 *   that don't supply it are unaffected.
 * @property {Array<{id:string, name:string, label?:('curated'|'sampled'|null)}>} metaTeams
 *   opponent pool used. `label` is present when the opponent pool
 *   was sampled (src/meta/sampleTeams.js); null/absent for the exhaustive
 *   curated-only path.
 * @property {string[]} warnings - collection + scoring warnings, surfaced verbatim.
 * @property {object} settings - the run knobs. `settings.mode` is `'sampled'`
 *   (the default: candidateTarget/poolSize/seed/curatedRatio) or
 *   `'exhaustive'`/absent (topK/candidateCount), plus scoreMeta/difficulty/
 *   excludeSpecies common to both. `settings.cp`/`settings.league`
 *   name the league; absent = Great League, and a cp of 1500 is left
 *   off the settings line as the default.
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
  lines.push(`Scored ${input.monCount} ${formsPhrase(input)} vs ${input.metaTeams.length} meta teams.`);
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
        `(lead ${t.bestLead.name}, HP margin ${signed(t.avgHpMargin)})` +
        (t.buildCost ? `\n     build cost: ${formatBuildCost(t.buildCost)}` : '')
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
  if (team.safeSwap) {
    lines.push(
      `- **Safest first switch:** ${team.safeSwap.name} ` +
        `(avg ${pct(team.safeSwap.avgHpPct)} HP remaining when switched in)`
    );
  }
  if (team.hardestTeams.length) {
    const hard = team.hardestTeams
      .map((h) => `${h.name} (${pct(h.winRate)})`)
      .join(', ');
    lines.push(`- **Hardest matchups:** ${hard}`);
  }
  if (team.buildCost) {
    lines.push(`- **Build cost:** ${formatBuildCost(team.buildCost)}`);
  }
  lines.push('');
  if (team.buildCost) {
    lines.push('| Member | Evolve | Level | Stardust | Candy | Candy XL |');
    lines.push('| --- | --- | --- | ---: | ---: | ---: |');
    for (const m of team.buildCost.members) {
      const levels = m.known ? `${lvl(m.fromLevel)} \u2192 ${lvl(m.toLevel)}` : `? \u2192 ${lvl(m.toLevel)}`;
      const cells = m.known
        ? `${num(m.stardust)} | ${num(m.candy)} | ${num(m.candyXl)}`
        : `unknown | ${m.evolveCandy ? num(m.evolveCandy) : 'unknown'} | unknown`;
      lines.push(`| ${m.name} | ${evolveCell(m) ?? '-'} | ${levels} | ${cells} |`);
    }
    const c = team.buildCost;
    lines.push(
      `| **Total** | | | **${num(c.stardust)}** | **${num(c.candy)}** | **${num(c.candyXl)}** |`
    );
    lines.push('');
  }
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
 * League label for the report headings: `settings.league` when
 * the pipeline supplied one, else Great League -- the only league that
 * existed before --cp, so an older settings object still renders as it did.
 *
 * @param {object} settings
 * @returns {string}
 */
function leagueLabel(settings) {
  return settings?.league ?? 'Great League';
}

/**
 * `cp=<n>` for the settings line, but only when it differs from the Great
 * League default -- a default run's report stays byte-identical to what it
 * was before other leagues were supported.
 *
 * @param {object} settings
 * @returns {string | null}
 */
function cpSetting(settings) {
  return settings?.cp && settings.cp !== 1500 ? `cp=${settings.cp}` : null;
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
  const { rankedTeams, monScores, metaTeams, warnings, settings, roleScores } = input;
  const out = [];

  out.push(`# ${leagueLabel(settings)} Team Report`);
  out.push('');
  out.push(`Collection: \`${input.collectionPath}\``);
  if (input.generatedAt) out.push(`Generated: ${input.generatedAt}`);
  out.push('');
  out.push(
    `Scored **${input.monCount}** ${formsPhrase(input)} and ranked ` +
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
  // settings.mode is 'sampled' (default) or 'exhaustive'/absent
  // (the original shape -- absent is treated as exhaustive so a caller-built
  // settings object without `mode`, e.g. an older test fixture, still renders).
  const modeParts =
    s.mode === 'sampled'
      ? [
          'mode=sampled',
          `candidates=${s.candidateCount}${
            s.candidateTarget !== undefined && s.candidateTarget !== s.candidateCount
              ? ` (requested ${s.candidateTarget})`
              : ''
          }`,
          `opponents=${metaTeams.length}`,
          `pool=${s.poolSize}`,
          `seed=${s.seed}`,
          `curatedRatio=${s.curatedRatio}`,
        ]
      : [`topK=${s.topK}`, `candidates=${s.candidateCount}`, `metaTeams=${metaTeams.length}`];
  out.push('**Settings:** ' +
    [
      cpSetting(s),
      ...modeParts,
      `scoreMeta=${s.scoreMeta}`,
      s.difficulty !== undefined ? `difficulty=${s.difficulty}` : null,
      s.excludeSpecies?.length ? `exclude=${s.excludeSpecies.join('/')}` : null,
      s.threads ? `threads=${s.threads}` : null,
      s.currentMoves ? 'currentMoves=on' : null,
      s.evolutions === false ? 'evolutions=off' : null,
    ]
      .filter(Boolean)
      .join(', '));
  out.push('');

  out.push('## Recommended teams');
  out.push('');
  if (rankedTeams.some((t) => t.buildCost)) {
    out.push('_**Build cost** is what it takes to actually field this team: the Stardust and Candy to bring each member from the level your collection CSV states up to the level the simulator played it at (every mon is played at the highest level whose CP still fits under the cap), plus the Candy to evolve it if the team wants a form you do not own yet. Shadow costs 20% more, purified less, lucky half the Stardust; levels 40+ spend Candy XL, which cannot be bought._');
    out.push('');
  }
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
  out.push(`The candidate teams above were battled against these ${leagueLabel(settings)} teams ` +
    '(curated presets and community-submitted teams; in sampled mode also ' +
    'weighted-random compositions from the current meta -- see Settings above ' +
    'for the seed used):');
  out.push('');
  metaTeams.forEach((m, i) => out.push(`${i + 1}. ${m.name}${m.label ? ` _(${m.label})_` : ''}`));
  out.push('');

  out.push('## Appendix: per-Pokemon 1v1 scores');
  out.push('');
  out.push(
    'Weighted 1v1 battle rating (0.25·s00 + 0.50·s11 + 0.25·s22, ' +
      'pvpoke 0-1000 scale, averaged over the scoring meta). Used to prune the ' +
      'collection down to the candidate pool; higher is better.'
  );
  out.push('');
  if (roleScores) {
    out.push(
      '_Lead/Closer/Switch columns are pvpoke\'s own published role-specific ' +
        'priors (rankings/all/{leads,closers,switches}) under its recommended movesets -- ' +
        'species-level context, not this collection\'s own instance/IV-specific 1v1 score._'
    );
    out.push('');
  }
  const roleHeader = roleScores ? ' Lead | Closer | Switch |' : '';
  const roleDivider = roleScores ? ' ---: | ---: | ---: |' : '';
  out.push(`| Pokemon | Score | 1v1 notes |${roleHeader}`);
  out.push(`| --- | ---: | --- |${roleDivider}`);
  const sortedMons = [...monScores].sort((a, b) => b.score - a.score);
  for (const m of sortedMons) {
    const roleCells = roleScores
      ? ` ${roleCell(roleScores, m.speciesId, 'lead')} | ${roleCell(roleScores, m.speciesId, 'closer')} | ${roleCell(roleScores, m.speciesId, 'switch')} |`
      : '';
    out.push(`| ${m.name} | ${m.score.toFixed(1)} | ${m.leadIn || ''} |${roleCells}`);
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

/** One ranked-team block in the HTML report. */
function renderTeamSectionHtml(team, rank) {
  const out = [];
  out.push(`<section class="team">`);
  out.push(`<h3>${rank}. ${escapeHtml(memberNames(team))}</h3>`);
  out.push('<ul class="team-stats">');
  out.push(`<li><strong>Overall win rate:</strong> ${pct(team.winRate)}</li>`);
  out.push(
    `<li><strong>Best lead:</strong> ${escapeHtml(team.bestLead.name)} ` +
      `(${pct(team.bestLead.winRate)} when leading)</li>`
  );
  out.push(`<li><strong>Avg surviving-HP margin:</strong> ${signed(team.avgHpMargin)}</li>`);
  if (team.safeSwap) {
    out.push(
      `<li><strong>Safest first switch:</strong> ${escapeHtml(team.safeSwap.name)} ` +
        `(avg ${pct(team.safeSwap.avgHpPct)} HP remaining when switched in)</li>`
    );
  }
  if (team.hardestTeams.length) {
    const hard = team.hardestTeams
      .map((h) => `${escapeHtml(h.name)} (${pct(h.winRate)})`)
      .join(', ');
    out.push(`<li><strong>Hardest matchups:</strong> ${hard}</li>`);
  }
  if (team.buildCost) {
    out.push(`<li><strong>Build cost:</strong> ${escapeHtml(formatBuildCost(team.buildCost))}</li>`);
  }
  out.push('</ul>');
  if (team.buildCost) {
    out.push('<table>');
    out.push(
      '<thead><tr><th>Member</th><th>Evolve</th><th>Level</th><th>Stardust</th>' +
        '<th>Candy</th><th>Candy XL</th></tr></thead>'
    );
    out.push('<tbody>');
    for (const m of team.buildCost.members) {
      const levels = m.known
        ? `${lvl(m.fromLevel)} &rarr; ${lvl(m.toLevel)}`
        : `? &rarr; ${lvl(m.toLevel)}`;
      const cells = m.known
        ? `<td>${num(m.stardust)}</td><td>${num(m.candy)}</td><td>${num(m.candyXl)}</td>`
        : `<td>unknown</td><td>${m.evolveCandy ? num(m.evolveCandy) : 'unknown'}</td><td>unknown</td>`;
      const evolve = evolveCell(m);
      out.push(
        `<tr><td>${escapeHtml(m.name)}</td><td>${evolve ? escapeHtml(evolve) : '&mdash;'}</td>` +
          `<td>${levels}</td>${cells}</tr>`
      );
    }
    const c = team.buildCost;
    out.push(
      `<tr><td><strong>Total</strong></td><td></td><td></td><td><strong>${num(c.stardust)}</strong></td>` +
        `<td><strong>${num(c.candy)}</strong></td><td><strong>${num(c.candyXl)}</strong></td></tr>`
    );
    out.push('</tbody></table>');
  }
  out.push('<table>');
  out.push('<thead><tr><th>Opposing meta team</th><th>Win%</th><th>W</th><th>L</th><th>T</th><th>HP margin</th></tr></thead>');
  out.push('<tbody>');
  for (const pm of team.perMeta) {
    out.push(
      `<tr><td>${escapeHtml(pm.name)}</td><td>${pct(pm.winRate)}</td><td>${pm.wins}</td>` +
        `<td>${pm.losses}</td><td>${pm.ties}</td><td>${signed(pm.avgHpMargin)}</td></tr>`
    );
  }
  out.push('</tbody></table>');
  out.push('</section>');
  return out.join('\n');
}

/**
 * Render the full report as a single self-contained HTML page (no external
 * CSS/JS/fonts -- opens directly from disk via `file://`). Same content and
 * section order as {@link renderReport}; purely a nicer-to-read presentation
 * of the same `ReportInput`.
 *
 * @param {ReportInput} input
 * @returns {string} HTML document text.
 */
export function renderReportHtml(input) {
  const { rankedTeams, monScores, metaTeams, warnings, settings, roleScores } = input;
  const s = settings;
  const modeParts =
    s.mode === 'sampled'
      ? [
          'mode=sampled',
          `candidates=${s.candidateCount}${
            s.candidateTarget !== undefined && s.candidateTarget !== s.candidateCount
              ? ` (requested ${s.candidateTarget})`
              : ''
          }`,
          `opponents=${metaTeams.length}`,
          `pool=${s.poolSize}`,
          `seed=${s.seed}`,
          `curatedRatio=${s.curatedRatio}`,
        ]
      : [`topK=${s.topK}`, `candidates=${s.candidateCount}`, `metaTeams=${metaTeams.length}`];
  const settingsLine = [
    cpSetting(s),
    ...modeParts,
    `scoreMeta=${s.scoreMeta}`,
    s.difficulty !== undefined ? `difficulty=${s.difficulty}` : null,
    s.excludeSpecies?.length ? `exclude=${s.excludeSpecies.map(escapeHtml).join('/')}` : null,
    s.threads ? `threads=${s.threads}` : null,
    s.currentMoves ? 'currentMoves=on' : null,
    s.evolutions === false ? 'evolutions=off' : null,
  ]
    .filter(Boolean)
    .join(', ');

  const out = [];
  out.push('<!doctype html>');
  out.push('<html lang="en">');
  out.push('<head>');
  out.push('<meta charset="utf-8">');
  out.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  out.push(`<title>${leagueLabel(settings)} Team Report${input.collectionPath ? ` -- ${escapeHtml(input.collectionPath)}` : ''}</title>`);
  out.push(`<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    max-width: 60rem; margin: 0 auto; padding: 1.5rem; }
  h1, h2, h3 { line-height: 1.25; }
  .callout { background: rgba(127,127,127,0.12); border-left: 4px solid currentColor;
    padding: 0.75rem 1rem; border-radius: 0.25rem; }
  .settings { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
  section.team { border: 1px solid rgba(127,127,127,0.3); border-radius: 0.5rem;
    padding: 1rem 1.25rem; margin: 1rem 0; }
  table { border-collapse: collapse; width: 100%; margin: 0.75rem 0; }
  th, td { text-align: left; padding: 0.3rem 0.6rem; border-bottom: 1px solid rgba(127,127,127,0.25); }
  th { font-weight: 600; }
  td:not(:first-child), th:not(:first-child) { text-align: right; }
  .team-stats { list-style: none; padding: 0; margin: 0.5rem 0; }
  .team-stats li { padding: 0.15rem 0; }
</style>`);
  out.push('</head>');
  out.push('<body>');

  out.push(`<h1>${leagueLabel(settings)} Team Report</h1>`);
  out.push(`<p>Collection: <code>${escapeHtml(input.collectionPath)}</code>` +
    (input.generatedAt ? `<br>Generated: ${escapeHtml(input.generatedAt)}` : '') + '</p>');
  out.push(
    `<p>Scored <strong>${input.monCount}</strong> ${formsPhrase(input)} and ranked ` +
      `candidate teams of 3 by simulated <strong>3v3 team-battle</strong> win rate against ` +
      `<strong>${metaTeams.length}</strong> curated meta teams, using pvpoke's own battle engine ` +
      `across all 9 lead pairings per matchup.</p>`
  );
  out.push(
    '<p class="callout"><strong>Reading the win%:</strong> every candidate is evaluated from the ' +
      "same fixed side, so pvpoke emulate mode's small residual player-1 edge is a constant offset " +
      'shared by all teams -- it cancels in the <em>relative</em> ranking, but absolute win% carries ' +
      'that constant offset.</p>'
  );
  out.push(`<p class="settings"><strong>Settings:</strong> ${settingsLine}</p>`);

  out.push('<h2>Recommended teams</h2>');
  if (rankedTeams.some((t) => t.buildCost)) {
    out.push('<p><em><strong>Build cost</strong> is what it takes to actually field this team: the Stardust and Candy to bring each member from the level your collection CSV states up to the level the simulator played it at (every mon is played at the highest level whose CP still fits under the cap), plus the Candy to evolve it if the team wants a form you do not own yet. Shadow costs 20% more, purified less, lucky half the Stardust; levels 40+ spend Candy XL, which cannot be bought.</em></p>');
  }
  if (rankedTeams.length === 0) {
    out.push('<p><em>No candidate teams could be formed -- need at least 3 distinct species in the collection.</em></p>');
  } else {
    rankedTeams.forEach((team, i) => out.push(renderTeamSectionHtml(team, i + 1)));
  }

  out.push('<h2>Opponent meta teams</h2>');
  out.push(
    `<p>The candidate teams above were battled against these ${leagueLabel(settings)} teams ` +
      '(curated presets and community-submitted teams; in sampled mode also ' +
      'weighted-random compositions from the current meta -- see Settings above ' +
      'for the seed used):</p>'
  );
  out.push('<ol>');
  metaTeams.forEach((m) =>
    out.push(`<li>${escapeHtml(m.name)}${m.label ? ` <em>(${escapeHtml(m.label)})</em>` : ''}</li>`)
  );
  out.push('</ol>');

  out.push('<h2>Appendix: per-Pokemon 1v1 scores</h2>');
  out.push(
    '<p>Weighted 1v1 battle rating (0.25&middot;s00 + 0.50&middot;s11 + 0.25&middot;s22, ' +
      'pvpoke 0-1000 scale, averaged over the scoring meta). Used to prune the ' +
      'collection down to the candidate pool; higher is better.</p>'
  );
  if (roleScores) {
    out.push(
      '<p><em>Lead/Closer/Switch columns are pvpoke&rsquo;s own published ' +
        'role-specific priors (rankings/all/{leads,closers,switches}) under its recommended ' +
        'movesets -- species-level context, not this collection&rsquo;s own instance/IV-specific ' +
        '1v1 score.</em></p>'
    );
  }
  out.push('<table>');
  out.push(
    `<thead><tr><th>Pokemon</th><th>Score</th><th>1v1 notes</th>${
      roleScores ? '<th>Lead</th><th>Closer</th><th>Switch</th>' : ''
    }</tr></thead>`
  );
  out.push('<tbody>');
  const sortedMons = [...monScores].sort((a, b) => b.score - a.score);
  for (const m of sortedMons) {
    const roleCells = roleScores
      ? `<td>${roleCell(roleScores, m.speciesId, 'lead')}</td><td>${roleCell(roleScores, m.speciesId, 'closer')}</td><td>${roleCell(roleScores, m.speciesId, 'switch')}</td>`
      : '';
    out.push(
      `<tr><td>${escapeHtml(m.name)}</td><td>${m.score.toFixed(1)}</td><td>${escapeHtml(m.leadIn || '')}</td>${roleCells}</tr>`
    );
  }
  out.push('</tbody></table>');

  out.push('<h2>Collection warnings</h2>');
  if (warnings.length === 0) {
    out.push('<p><em>None -- every row imported and scored cleanly.</em></p>');
  } else {
    out.push('<ul>');
    for (const w of warnings) out.push(`<li>${escapeHtml(w)}</li>`);
    out.push('</ul>');
  }

  out.push('</body>');
  out.push('</html>');

  return out.join('\n');
}
