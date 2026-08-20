// JavaScript Document
//
// Team evaluator + ranking (PLAN.md Rev 2). Turns the 1v1 scoring matrix into
// candidate 3-mon teams, battles each candidate against every meta team across
// all 3x3 lead pairings using the real pvpoke 3v3 engine (src/engine/
// teamBattle.js), and ranks them by mean team-battle win rate. No battle math
// is reimplemented here: every win/loss comes from battleTeams, which runs
// pvpoke's own Training-mode emulate engine. This module only does the
// combinatorics (which teams to try, from which mons) and the bookkeeping
// (tally wins, average HP margins, pick the best lead).
//
// Fixed-side convention (see PROGRESS.md 2026-08-20T17:59Z / 18:03Z): pvpoke's
// emulate mode carries a small residual player-1 side edge. Every candidate is
// always evaluated as team A (the same fixed side), so that constant offset is
// identical for every candidate and cancels in the RELATIVE ranking. Absolute
// win% therefore carries that constant offset -- the report says so.

import { battleTeams } from '../engine/teamBattle.js';
import { computeWeightedScore } from '../scoring/index.js';

const TEAM_SIZE = 3;
const LEADS = [0, 1, 2];
const PAIRINGS_PER_META = LEADS.length * LEADS.length; // 9

/**
 * @typedef {object} CandidateMember
 * @property {string} key - userMonKey (matches matrix.ratings / matrix.builtMons).
 * @property {string} speciesId - base gamemaster speciesId.
 * @property {string} name - display name.
 */

/**
 * @typedef {object} PerMetaResult
 * @property {string} metaTeamId
 * @property {string} name - opposing team's display name.
 * @property {number} wins - candidate wins out of 9 lead pairings.
 * @property {number} losses
 * @property {number} ties
 * @property {number} winRate - (wins + 0.5*ties) / 9.
 * @property {number} avgHpMargin - mean (candidateSurvivingHp - metaSurvivingHp)
 *   over the 9 pairings (candidate is always side A).
 */

/**
 * @typedef {object} TeamResult
 * @property {CandidateMember[]} members - the 3 user mons on this team.
 * @property {number} winRate - overall mean win rate across all meta teams x 9.
 * @property {number} avgHpMargin - overall mean surviving-HP margin (tiebreak).
 * @property {{index:number, key:string, speciesId:string, name:string, winRate:number}} bestLead
 *   Which of the 3 members leads best (highest win rate when it starts).
 * @property {PerMetaResult[]} perMeta - one entry per meta team.
 * @property {Array<{metaTeamId:string, name:string, winRate:number}>} hardestTeams
 *   Up to 3 meta teams with the lowest win rate for this candidate.
 */

/** Base species of a user mon (collection speciesIds are already base ids -- shadow is a flag). */
function speciesOf(matrix, key) {
  return matrix.builtMons[key].speciesId;
}

/**
 * All C(pool, 3) index combinations of an array, in lexicographic order.
 * Small and pure; kept here rather than pulling in a dependency.
 */
function combinations3(items) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      for (let k = j + 1; k < items.length; k++) {
        out.push([items[i], items[j], items[k]]);
      }
    }
  }
  return out;
}

/**
 * Build the candidate team list from a scoring matrix: rank user mons by their
 * weighted 1v1 score, keep the topK, and form every 3-mon combination whose
 * members are all different species (shadow/base count as the same species,
 * because collection speciesIds are base ids and a shadow flag).
 *
 * Pure (no engine): exported so the combinatorics can be tested on a fake
 * matrix without running any battles.
 *
 * BUDGET MATH (why topK matters): this returns C(topK, 3) candidate teams
 * (minus any dropped for duplicate species). evaluateTeams then runs, per
 * candidate, |metaTeams| x 9 real 3v3 battles. So total battles =
 * (#candidates) x |metaTeams| x 9. With the default topK=20 that's up to
 * C(20,3)=1140 candidates; times a full 25-team meta times 9 is ~256k battles
 * -- far too many for an interactive run. The knobs to keep it sane are topK
 * here and `limit` on loadMetaTeams (and, for reporting only, teamCount). The
 * CLI (T5) is expected to pass a small topK and a capped meta for a quick run;
 * the default is left at the PLAN-specified 20 so a deliberate full run is
 * possible, but callers should size topK x metaTeams to their time budget.
 *
 * @param {object} matrix - scoreCollection's return (needs ratings + builtMons).
 * @param {{ topK?: number, excludeSpecies?: string[] }} [opts]
 * @returns {string[][]} candidate teams as arrays of 3 userMonKeys.
 */
export function buildCandidates(matrix, opts = {}) {
  const topK = typeof opts.topK === 'number' ? opts.topK : 20;
  const exclude = new Set(opts.excludeSpecies ?? []);

  const scored = Object.keys(matrix.ratings)
    .map((key) => ({ key, speciesId: speciesOf(matrix, key), score: computeWeightedScore(matrix.ratings[key]) }))
    .filter((m) => !exclude.has(m.speciesId))
    // Score desc; break ties on key so candidate generation is deterministic.
    .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const pool = scored.slice(0, topK);

  return combinations3(pool)
    .filter(([a, b, c]) => a.speciesId !== b.speciesId && a.speciesId !== c.speciesId && b.speciesId !== c.speciesId)
    .map((combo) => combo.map((m) => m.key));
}

/** argmax over an array of {winRate}; returns the winning object (first on ties). */
function bestBy(arr, valueFn) {
  let best = null;
  for (const item of arr) {
    if (best === null || valueFn(item) > valueFn(best)) best = item;
  }
  return best;
}

/**
 * Evaluate and rank candidate 3-mon teams by real 3v3 team-battle win rate.
 *
 * For each candidate (always evaluated as team A -- see the fixed-side note at
 * the top of this file), every meta team is fought across all 9 lead pairings
 * (3 candidate leads x 3 meta leads) via battleTeams. Teams are ranked by mean
 * win rate; ties broken by mean surviving-HP margin.
 *
 * @param {object} ctx - from initEngine (initTeamBattle is applied lazily by battleTeams).
 * @param {{
 *   metaTeams: Array<{id:string, name:string, members:Array<{pokemon:object}>}>,
 *   matrix: object,
 *   candidates?: string[][],
 *   opts?: {
 *     topK?: number,
 *     teamCount?: number,
 *     excludeSpecies?: string[],
 *     difficulty?: number,
 *     onProgress?: (p:{completed:number, total:number}) => void,
 *   }
 * }} params
 *   `candidates` (arrays of 3 userMonKeys) may be supplied directly; when
 *   omitted they are generated from `matrix` via buildCandidates(matrix, opts).
 *   `teamCount` caps how many ranked teams are returned (default: all).
 * @returns {TeamResult[]} ranked best-first.
 */
export function evaluateTeams(ctx, params) {
  const { metaTeams, matrix } = params;
  const opts = params.opts ?? {};
  if (!Array.isArray(metaTeams) || metaTeams.length === 0) {
    throw new Error('evaluateTeams: metaTeams must be a non-empty array');
  }
  const candidates = params.candidates ?? buildCandidates(matrix, opts);

  const results = [];
  let completed = 0;
  for (const keys of candidates) {
    const members = keys.map((key) => {
      const b = matrix.builtMons[key];
      if (!b) throw new Error(`evaluateTeams: no built pokemon for key "${key}"`);
      return { key, speciesId: b.speciesId, name: b.name, pokemon: b.pokemon };
    });
    const teamA = members.map((m) => m.pokemon);

    // Per-candidate-lead win tally (index 0..2), for bestLead.
    const leadWins = [0, 0, 0];
    let totalWins = 0;
    let totalTies = 0;
    let totalBattles = 0;
    let hpMarginSum = 0;
    const perMeta = [];

    for (const metaTeam of metaTeams) {
      const teamB = metaTeam.members.map((m) => m.pokemon);
      let wins = 0;
      let losses = 0;
      let ties = 0;
      let hpSum = 0;

      for (const leadA of LEADS) {
        for (const leadB of LEADS) {
          const r = battleTeams(ctx, { teamA, teamB, leadA, leadB, difficulty: opts.difficulty });
          const margin = r.survivorsHp.a - r.survivorsHp.b;
          hpSum += margin;
          if (r.winner === 'a') {
            wins += 1;
            leadWins[leadA] += 1;
          } else if (r.winner === 'b') {
            losses += 1;
          } else {
            ties += 1;
            leadWins[leadA] += 0.5;
          }
        }
      }

      const winRate = (wins + 0.5 * ties) / PAIRINGS_PER_META;
      perMeta.push({
        metaTeamId: metaTeam.id,
        name: metaTeam.name,
        wins,
        losses,
        ties,
        winRate,
        avgHpMargin: hpSum / PAIRINGS_PER_META,
      });

      totalWins += wins;
      totalTies += ties;
      totalBattles += PAIRINGS_PER_META;
      hpMarginSum += hpSum;
    }

    const winRate = (totalWins + 0.5 * totalTies) / totalBattles;
    const avgHpMargin = hpMarginSum / totalBattles;

    // Each candidate lead started 3 pairings per meta team; normalize by that.
    const battlesPerLead = metaTeams.length * LEADS.length;
    const leadStats = members.map((m, i) => ({
      index: i,
      key: m.key,
      speciesId: m.speciesId,
      name: m.name,
      winRate: leadWins[i] / battlesPerLead,
    }));
    const bestLead = bestBy(leadStats, (l) => l.winRate);

    const hardestTeams = [...perMeta]
      .sort((a, b) => a.winRate - b.winRate)
      .slice(0, 3)
      .map((p) => ({ metaTeamId: p.metaTeamId, name: p.name, winRate: p.winRate }));

    results.push({
      members: members.map(({ key, speciesId, name }) => ({ key, speciesId, name })),
      winRate,
      avgHpMargin,
      bestLead,
      perMeta,
      hardestTeams,
    });

    completed += 1;
    opts.onProgress?.({ completed, total: candidates.length });
  }

  results.sort((a, b) => b.winRate - a.winRate || b.avgHpMargin - a.avgHpMargin);

  return typeof opts.teamCount === 'number' ? results.slice(0, opts.teamCount) : results;
}
