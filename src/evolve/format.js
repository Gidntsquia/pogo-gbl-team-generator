
export function pct(x) {
  return x === null || x === undefined ? 'n/a' : `${Math.round(x * 100)}%`;
}

export function signed(x) {
  const s = x.toFixed(1);
  return x > 0 ? `+${s}` : s;
}

/** Escape text for safe interpolation into HTML (report data includes raw CSV/species strings). */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

/**
 * Report-facing member name: stamp the shadow qualifier exactly the way
 * src/teams/index.js does at its own member-construction site (see the
 * comment there) -- a shadow and its ordinary counterpart share `b.name`,
 * so without this a team built on a shadow reads as the normal form.
 * Guarded so a name that already carries it is not double-suffixed.
 *
 * @param {object} b - built mon from matrix.builtMons.
 * @returns {string}
 */
export function memberDisplayName(b) {
  return b.spec?.shadow && !/\(Shadow\)/.test(b.name) ? `${b.name} (Shadow)` : b.name;
}

/**
 * Report-facing detail for one evaluated team member: the moveset pvpoke
 * actually battled it with (recommended, unless `--current-moves` was
 * requested -- either way this reads the live `pokemon` instance's
 * post-`selectRecommendedMoveset`/`applyGroupMoveset` moves, not the input
 * spec) plus the build-cost inputs (current vs. target level/CP, IVs,
 * shadow/purified, evolution-from). Extracted once here, on the FULL
 * (untrimmed) `members` entry evaluateTeamsInOrder builds internally, so the
 * HTML report's detail cards can show real moves/builds rather than only the
 * aggregate {@link teamBuildCost} totals -- see renderEvolveReportHtml's
 * movesetLine/buildLine. Every field is plain data (numbers/strings), safe
 * to carry on the elite entry alongside the existing trimmed
 * {key, speciesId, name}.
 *
 * @param {object} m - one entry of evaluateTeamsInOrder's internal `members`
 *   array (has `.pokemon`, the live pvpoke instance, and `.spec`/
 *   `.currentLevel`/`.shadow`/`.purified`/`.evolution`, same fields
 *   {@link teamBuildCost} reads).
 * @returns {object}
 */
export function reportMemberDetail(m) {
  const currentCp =
    m.currentLevel != null
      ? m.pokemon.calculateCP(m.pokemon.getCPMByLevel(m.currentLevel), m.spec.ivs.atk, m.spec.ivs.def, m.spec.ivs.hp)
      : null;
  return {
    ivs: m.spec.ivs,
    shadow: !!m.shadow,
    purified: !!m.purified,
    currentLevel: m.currentLevel,
    currentCp,
    targetLevel: m.targetLevel,
    targetCp: m.pokemon.cp,
    fastMove: m.pokemon.fastMove?.name ?? null,
    chargedMoves: (m.pokemon.chargedMoves ?? []).map((c) => c.name),
    evolveFrom: m.evolution?.fromName ?? null,
    evolveItems: m.evolution?.items ?? [],
  };
}

/**
 * Team build cost as HTML for the report's per-team detail card: Stardust /
 * Candy / Candy XL totals, evolution items, per-member evolve-from notes, and
 * unknown-level / unpriced-evolution caveats.
 *
 * @param {object|undefined} cost - `t.buildCost` (teamBuildCost result);
 *   always present on a real run's elites (computed unconditionally in
 *   evaluateTeamsInOrder) -- undefined only on a hand-built fixture that
 *   omits it, handled here rather than crashing the report.
 * @returns {string}
 */
export function buildCostHtml(cost) {
  if (!cost) return 'not available for this team';
  const group = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const parts = [];
  if (cost.stardust) parts.push(`${group(cost.stardust)} Stardust`);
  if (cost.candy) parts.push(`${group(cost.candy)} Candy`);
  if (cost.candyXl) parts.push(`${group(cost.candyXl)} Candy XL`);
  let body = parts.length ? `<b>${parts.join(' + ')}</b>` : 'none — already built';
  if (cost.evolveItems?.length) body += `, plus ${cost.evolveItems.map(escapeHtml).join(' + ')}`;
  const evolving = cost.members?.filter((m) => m.evolveFrom) ?? [];
  if (evolving.length) {
    body += ` (evolve ${evolving.map((m) => `${escapeHtml(m.evolveFrom)} &rarr; ${escapeHtml(m.name)}`).join(', ')})`;
  }
  const caveats = [];
  if (cost.unknownLevels) caveats.push(`${cost.unknownLevels} with no level in the CSV`);
  if (cost.unpricedEvolutions) caveats.push(`${cost.unpricedEvolutions} unpriced evolution(s)`);
  return caveats.length ? `${body} — excludes ${caveats.join(' and ')}` : body;
}

/** "Lead (Lead) / Back / Back" team name; `members[0]` is always the designated lead. */
export function formatTeamMembers(members) {
  const [lead, ...backs] = members;
  return `${lead.name} (Lead) / ${backs.map((b) => b.name).join(' / ')}`;
}

/** "1h 2m 3s" from milliseconds. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  const totalSec = Math.round(Math.max(0, ms) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (h || m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}
