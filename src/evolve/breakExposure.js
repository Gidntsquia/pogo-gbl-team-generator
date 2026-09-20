
// Core-break exposure (REPORT ONLY -- never part of any score or fitness;
// Jaxon 2026-08-27: the ranking stays pure win rate, "a hard loss and a
// slight loss cost the same"). Groups each elite's elites-pass results by
// the species its opponents contained, so a high-mean team whose average
// hides a systematic hole (an elite that went 2/8 into Altaria teams while
// holding 63% overall) is visible in the report rather than discovered on
// the ladder. A species must appear in at least CORE_BREAK_MIN_TEAMS
// opponent teams before its group win rate means anything, and it is called
// a core breaker only at or below CORE_BREAK_WIN_RATE_MAX -- a matchup the
// team loses hard, not merely a soft spot. Species in the milder
// (CORE_BREAK_WIN_RATE_MAX, THREAT_WIN_RATE_MAX] band are listed under
// "Threats" instead (Jaxon 2026-08-30: threshold split, not a hard cap;
// names only per Jaxon 2026-08-27).
const CORE_BREAK_MIN_TEAMS = 5;

export const CORE_BREAK_WIN_RATE_MAX = 0.2;

export const THREAT_WIN_RATE_MAX = 0.4;

/**
 * Distinct base species of one opponent team, with display names -- shadow
 * and base group together (a "loses to Altaria" hole does not care which).
 *
 * @param {{members: Array<object>}} opp - elites-pass opponent entry.
 * @returns {Array<{id: string, name: string}>}
 */
export function teamBaseSpecies(opp) {
  const seen = new Map();
  for (const m of opp.members) {
    const id = String(m.spec?.speciesId ?? m.speciesId ?? '').replace(/_shadow$/, '');
    if (!id || seen.has(id)) continue;
    const raw = m.pokemon?.speciesName ?? m.name ?? id;
    seen.set(id, { id, name: String(raw).replace(/ \(Shadow\)$/, '') });
  }
  return [...seen.values()];
}

/**
 * The elite's break exposure: every species appearing in at least
 * CORE_BREAK_MIN_TEAMS of its elites-pass opponent teams against which the
 * elite's group win rate is at most THREAT_WIN_RATE_MAX, worst first. The
 * report splits this list at CORE_BREAK_WIN_RATE_MAX into core breakers vs
 * threats (splitBreakExposure). Report only (see the constants' comment).
 *
 * @param {Array<object>} perMeta - per-opponent rows (wins/losses/ties + species).
 * @returns {Array<{id:string,name:string,teams:number,wins:number,losses:number,ties:number,winRate:number}>}
 */
export function computeCoreBreakExposure(perMeta) {
  const bySpecies = new Map();
  for (const row of perMeta) {
    for (const s of row.species ?? []) {
      const a = bySpecies.get(s.id) ?? { id: s.id, name: s.name, teams: 0, wins: 0, losses: 0, ties: 0 };
      a.teams += 1;
      a.wins += row.wins;
      a.losses += row.losses;
      a.ties += row.ties;
      bySpecies.set(s.id, a);
    }
  }
  return [...bySpecies.values()]
    .filter((a) => a.teams >= CORE_BREAK_MIN_TEAMS)
    .map((a) => ({ ...a, winRate: (a.wins + 0.5 * a.ties) / (a.wins + a.losses + a.ties) }))
    .filter((a) => a.winRate <= THREAT_WIN_RATE_MAX)
    .sort((a, b) => a.winRate - b.winRate || b.teams - a.teams || (a.id < b.id ? -1 : 1));
}

/**
 * Split a coreBreakExposure list (worst first) at CORE_BREAK_WIN_RATE_MAX:
 * `core` = the hard losses, `threats` = the milder band up to
 * THREAT_WIN_RATE_MAX. Entries from old checkpoints that carry no winRate
 * count as core breakers (they were computed under the old single cutoff).
 *
 * @param {Array<{name:string,winRate?:number}>|undefined} cb
 * @returns {{core: Array<object>, threats: Array<object>}}
 */
export function splitBreakExposure(cb) {
  const core = [];
  const threats = [];
  for (const s of cb ?? []) ((s.winRate ?? 0) <= CORE_BREAK_WIN_RATE_MAX ? core : threats).push(s);
  return { core, threats };
}
