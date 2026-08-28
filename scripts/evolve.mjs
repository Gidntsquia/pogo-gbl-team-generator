#!/usr/bin/env node
// JavaScript Document
//
// Evolutionary team search driver ("survival of the fittest"), sibling of
// scripts/tournament.mjs (which stays -- this is an alternate search strategy,
// not a replacement). Where the tournament funnel narrows a WIDE fixed sample
// down through progressively deeper opponent pools, this runs a CO-EVOLUTIONARY
// genetic algorithm: a population of candidate teams and a population of
// opponent teams are repeatedly battled against each other, and BOTH sides
// cull, mutate and take in immigrants -- so compute concentrates on already
// -good teams instead of being spread evenly across a static sample, and
// "good" keeps meaning something as the search goes on.
//
// All GA bookkeeping is in two pure modules with no battles inside:
// src/teams/evolve.js (candidate side) and src/meta/opponentPool.js (opponent
// side). This file's only job is the battle-driving glue: shared collection->
// matrix setup (mirrors scripts/tournament.mjs's sampled path exactly), running
// every pairing through the persistent executor, checkpointing, and rendering
// the report. No battle math is reimplemented anywhere here -- every win/loss/
// HP number comes from battleTeams (src/engine/teamBattle.js, pvpoke's own
// emulate engine).
//
// --- WHY BOTH SIDES EVOLVE (Jaxon 2026-08-26) ------------------------------
//
// The previous design drew a fresh opponent pool every generation: a curated
// majority plus a randomly-composed minority. Candidate teams OVERFIT to it,
// for two compounding reasons.
//   * The curated pool is a fixed list of ~110 real teams. Over a long run the
//     population converges on whatever beats those specific teams.
//   * The composed minority was drawn from pvpoke's FULL 1,144-species
//     rankings field, weighted by usage. Weighting alone does not make that
//     field meta -- the top 50 species hold only ~7% of the total weight, so
//     the long tail dominated every draw and the composed teams were fringe
//     junk applying no selection pressure at all.
// Both are fixed. The composed half is now built from a META-CAPPED species
// pool (the top N of pvpoke's own ranking -- see src/meta/sampleTeams.js), and
// the opponent pool is a PERSISTENT POPULATION that culls its weakest members,
// mutates its survivors and takes in fresh immigrants (src/meta/
// opponentPool.js), at rates deliberately far gentler than the candidate side's
// -- gentler still for curated entries, which are additionally never culled and
// never modified in place, so the pool keeps reflecting on-the-ground team
// realities while still getting harder.
//
// An opponent's fitness costs NO extra battles: it is the other side of the
// ledger the candidates' own battles already produce (`1 - mean candidate win
// rate against it`).
//
// --- SCHEDULE --------------------------------------------------------------
//
// The candidate population SHRINKS across the run and the opponent pool GROWS
// to match, so late generations spend the same battle budget measuring fewer,
// better teams against many more opponents. Opponent count is DERIVED from the
// population to hold `population x opponents` -- the per-generation battle grid
// -- flat, so the trade is cost-neutral. See populationAt/opponentsAt.
//
// --- LEADS -----------------------------------------------------------------
//
// A candidate's `team[0]` is its designated lead (src/teams/evolve.js's
// representation), so every battle runs the candidate at leadA=0 only, never
// averaged over its own 3 members. EVERY opponent now likewise carries an
// explicit designated lead at `members[0]`: curated teams by src/meta/teams.js's
// file-wide member-index-0-is-lead doctrine, composed teams because
// src/meta/sampleTeams.js picks their lead from pvpoke's own published `leads`
// rankings and rotates it into slot 0 at composition time. Lead assignment is
// therefore part of an opponent's identity and evolves with it (lead-rotation
// is one of the two opponent mutation types).
//
// --- FINAL ELITES PASS -----------------------------------------------------
//
// The top --elites teams of the last evaluated generation are re-measured
// against ONE broad, identical opponent set: every curated team, untouched and
// at its own established lead, plus the strongest teams the opponent GA evolved
// over the run (held to the run's own curated:evolved ratio). One battle per
// (elite, opponent) -- both sides at their designated lead. That replaces the
// old spread across the opponent's 3 possible leads: now that every opponent
// has a real lead, fighting it at the other two measures a team nobody plays.
//
// FINAL RANKING blends two win rates: the elites pass (the only apples-to
// -apples measurement, so it carries the majority) and the team's mean win rate
// over the trailing generations (measured against a moving pool, so not
// comparable in absolute terms, but it averages several independent opponent
// draws and so filters out a team that merely drew a friendly final
// generation). See RANKING_WEIGHTS / recentWindowSize.
//
// --- BATTLE MEMO CACHE -----------------------------------------------------
//
// battleTeams is deterministic given (teams, leads, difficulty), and with both
// populations persisting most of generation N's grid IS generation N-1's grid.
// Identical pairings are therefore memoized rather than re-simulated -- not an
// approximation, and typically the single largest cost saving in a long run.
// `--no-battle-cache` opts out, and is a pure speed switch: a cached run and
// an uncached one produce bit-identical results (see createBattleCache).
//
// Fixed-side convention (same as scripts/tournament.mjs / src/teams/
// index.js): every population member is always battled as team A, so
// pvpoke emulate mode's small residual player-1 edge is a constant offset
// shared by every team and cancels in the RELATIVE ranking.
//
// Usage:
//   node scripts/evolve.mjs <collection.csv> [options]
//   node scripts/evolve.mjs --help    (the authoritative flag list)
//
// BUDGET MATH: battles/generation = population x opponents-per-gen, held flat
// across the run by the schedule above. At the flag defaults: 100 x 20 = 2,000
// pairings/generation; 15 generations = 30,000, plus a final elites pass of
// elites x (all curated + evolved) -- with the pinned data that is 10 x ~162 =
// ~1,620. The memo cache means the number of pairings SIMULATED is far lower
// than the number planned (the report prints both). Measured rates vary by
// machine (~18ms/battle threaded on Jaxon's Mac) -- size --population/
// --opponents-per-gen/--generations to your own time budget; --deadline-minutes
// is a simple stop-before-the-next-generation safety net, not a self-tuning
// scaler (unlike tournament.mjs's stage 2/3 tuning).
//
// GA TUNABLES: the candidate side's rates (--death-rate / --mutation-floor /
// --mutation-ceil / --immigrant-fraction) and the convergence shape
// (--conv-window / --conv-top-n) are CLI flags as of 2026-08-27 (Jaxon's
// top-400 run wanted hotter selection and a top-5 convergence test). Each
// enters the checkpoint config fingerprint ONLY when explicitly passed, so
// pre-existing checkpoint dirs (which never set them) still resume. The
// rest (leadRotationRate, alpha, convergence trailing/maxChurn/minLiftGain,
// and the whole opponent side in src/meta/opponentPool.js) remain exported
// DEFAULT_* constants only.
//
// ROBUSTNESS: each generation writes out/evolve-gen<N>.json (config + that
// generation's population/fitness/lineage-to-next-gen + timing/analytics) as
// soon as it finishes. On startup, checkpoints are read in order starting at
// generation 0; a checkpoint whose `config` deep-equals this run's resolved
// config is accepted and the run continues from its stored `nextPopulation`
// at generation+1 -- the first missing/mismatched checkpoint stops the scan
// (mirrors scripts/tournament.mjs's per-stage resume, but sequential since
// each generation depends on the last). CHECKPOINT FORMAT VERSIONING
// (added when the prior fire's locked-lead representation change made
// this a real risk, not a hypothetical one): a checkpoint's `config` schema
// did NOT change when `team[0]` became a designated lead, so an old
// (pre-lead-lock) checkpoint could match a fresh run's config and be silently
// resumed as if its population entries already had a defined lead-slot
// convention -- they don't. Every checkpoint now carries a `formatVersion`;
// a config-matching checkpoint whose formatVersion disagrees throws a clear
// error instead of resuming (see CHECKPOINT_FORMAT_VERSION below) -- the
// fix is to delete the stale out/evolve-gen*.json / evolve-generations.json
// / evolve-DONE and re-run from scratch, never to silently reinterpret them.
// Individual battle errors are caught,
// logged, and counted (skip-and-continue) rather than aborting a generation.
// out/evolve-generations.json (analytics only, no population/lineage detail)
// is rewritten after every generation, so a killed run's analytics are never
// lost even without a full checkpoint resume. out/evolve-DONE is written
// LAST, only on a fully successful run.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { importCollection } from '../src/importer/index.js';
import { expandEvolutions } from '../src/evolution/index.js';
import { teamBuildCost } from '../src/cost/powerup.js';
import { initEngine } from '../src/engine/harness.js';
import { battleTeams } from '../src/engine/teamBattle.js';
import { createExecutor, defaultThreadCount } from '../src/engine/parallel.js';
import { scoreCollection, computeWeightedScore } from '../src/scoring/index.js';
import { loadUsageWeights } from '../src/meta/usage.js';
import { loadMovesetPool, DEFAULT_META_POOL_SIZE, baseIdOf } from '../src/meta/sampleTeams.js';
import { loadMetaTeams, curatedTierWeight } from '../src/meta/teams.js';
import {
  initOpponentPool,
  nextOpponentPool,
  isProtectedOpponent,
  serializeOpponentPool,
  rehydrateOpponentPool,
  curatedHeadcount,
} from '../src/meta/opponentPool.js';
import { dedupeBestPerSpecies } from '../src/teams/index.js';
import { initPopulation, nextGeneration, hasConverged } from '../src/teams/evolve.js';
import { leagueForCp } from '../src/util/leagues.js';
import { loadRoleScores } from '../src/meta/roles.js';
import { buildTopTeamSeries, renderChartInner } from '../src/report/raceChart.js';

const DEFAULTS = Object.freeze({
  population: 100,
  opponentsPerGen: 20,
  generations: 15,
  seed: 'pogo-gbl-team-generator-evolve',
  cp: 1500,
  elites: 10,
  scoreMeta: 20,
  pool: 40,
  // 0.66 (Jaxon 2026-08-26, down from the 0.70 his real runs were passing).
  // Curated teams are the only OBSERVED-reality anchor in the opponent pool,
  // so they stay the majority; the extra 4 points go to the evolving half,
  // which is now composed from a meta-capped species pool and gets stronger
  // over the run instead of being random filler.
  curatedRatio: 0.66,
  // Candidate population at the LAST generation, as a fraction of the
  // gen-0 population (Jaxon 2026-08-26: "cull the candidate team count and
  // correspondingly increase the opponent team count ... so we can spend more
  // time refining the strongest teams instead of wasting resources on teams
  // that are too weak"). Opponent count is then DERIVED to hold
  // population x opponents -- the per-generation battle grid -- flat, so the
  // run's cost per generation does not change as the trade is made. See
  // populationAt/opponentsAt.
  populationFinalRatio: 0.4,
  // Species pool the sampled half of the opponent pool is composed from: the
  // top N of pvpoke's own overall ranking for the run's CP cap. See
  // src/meta/sampleTeams.js's META-CAPPED POOL note.
  opponentMetaPool: DEFAULT_META_POOL_SIZE,
  outDir: 'out',
  html: 'my-teams-evolve.html', // resolved against outDir unless --html/opts.html is absolute or explicit
  // Flipped to 'battle-reality' as the DEFAULT -- backed by a real A/B
  // (out/evolve-ab-classic vs out/evolve-ab-reality, same seed/collection/
  // opponents): battle-reality's top-10 showed the exact shift Jaxon's
  // original directive asked for (Stunfisk (Galarian)/Azumarill's dominance
  // fell from 5/7 of 10 top teams to 2/5; Skarmory -- absent from classic's
  // top 10 entirely -- entered twice as a back-line closer pick; Medicham rose
  // 2 -> 5). `--fitness classic` remains a fully-supported escape hatch
  // (standing rule for this initiative).
  fitness: 'battle-reality',
});

const FITNESS_MODES = ['classic', 'battle-reality'];

/**
 * How the final ranking blends the two win-rate measurements
 * (Jaxon 2026-08-26). `elitePass` is the dedicated final pass -- every elite
 * against the SAME broad opponent set (the full curated pool plus the run's
 * strongest evolved opponents), which makes it the only directly comparable,
 * apples-to-apples number the run produces, so it carries the majority.
 * `recent` is the team's mean win rate across the last few generations, which
 * is measured against a moving opponent pool and is therefore not comparable
 * team-to-team in absolute terms -- but it averages over several independent
 * opponent draws, so it carries information the single elites pass cannot:
 * whether a team is durably good or just had a favorable final matchup set.
 */
const RANKING_WEIGHTS = Object.freeze({ elitePass: 0.7, recent: 0.3 });

/**
 * HTML report accent color per league group (src/util/leagues.js's `group`,
 * pvpoke's own great/ultra/master/little naming) -- a bright, glow-friendly
 * hue against the report's fixed dark "stage" background (see
 * renderEvolveReportHtml). Ties the report's one accent hue to which format
 * the run actually battled in rather than a fixed brand color: a Great
 * League report reads differently from a Master League one because they
 * ARE different formats, not as a decorative flourish.
 */
const LEAGUE_ACCENTS = Object.freeze({
  little: { accent: '#6FA8FF', accentHi: '#B0D0FF' },
  great: { accent: '#3DDC9B', accentHi: '#9BF3D0' },
  ultra: { accent: '#FF9D4D', accentHi: '#FFC98A' },
  master: { accent: '#B98CF2', accentHi: '#DEC5FA' },
});

// Elites-pass opponent weighting (Jaxon 2026-08-27: "weight ladder teams more
// than the curated/off meta teams, which should be weighted more than the
// sample teams"). Curated opponents weigh in at their tier's
// CURATED_TIER_WEIGHTS value (src/meta/teams.js: meta/ladder 1, recommended
// 0.5, off-meta 0.25); the GA's own evolved opponents continue that halving
// gradient one step further down. Only the elites-pass win rate is weighted --
// per-generation fitness and the `recent` ranking term stay unweighted.
const ELITES_PASS_SAMPLED_WEIGHT = 0.125;

/**
 * How many trailing generations the `recent` term above averages over: the
 * last 5, or the last quarter of the run when fewer than 20 generations
 * actually ran (the two rules agree exactly at 20). At least 1 either way, so
 * a 1-generation run still produces a number rather than a null.
 */
const RECENT_WINDOW_GENERATIONS = 5;
const RECENT_WINDOW_MIN_GENERATIONS = 20;

function recentWindowSize(generationsRun) {
  if (generationsRun >= RECENT_WINDOW_MIN_GENERATIONS) return RECENT_WINDOW_GENERATIONS;
  return Math.max(1, Math.ceil(generationsRun / 4));
}

// Used only if a generation somehow measures 0 battles (every battle errored)
// -- keeps timing math finite. Mirrors tournament.mjs's own fallback figure.
const FALLBACK_MS_PER_BATTLE = 200;
const SPECIES_STATS_CAP = 25; // report/analytics-JSON cap on how many species rows are kept per generation (documented, not silent -- see renderEvolveReport).
const TOP_CORES_CAP = 15;
const TRAJECTORY_SPECIES_CAP = 15;
const TOUGHEST_OPPONENTS_CAP = 15; // report/analytics-JSON cap on how many opponent rows are kept (same documented-not-silent rule as SPECIES_STATS_CAP).
// Core-break exposure (REPORT ONLY -- never part of any score or fitness;
// Jaxon 2026-08-27: the ranking stays pure win rate, "a hard loss and a
// slight loss cost the same"). Groups each elite's elites-pass results by
// the species its opponents contained, so a high-mean team whose average
// hides a systematic hole (an elite that went 2/8 into Altaria teams while
// holding 63% overall) is visible in the report rather than discovered on
// the ladder. A species must appear in at least CORE_BREAK_MIN_TEAMS
// opponent teams before its group win rate means anything, and it is called
// a core breaker only below CORE_BREAK_WIN_RATE_MAX -- a matchup the team
// loses decisively more often than it wins, not merely a soft spot. Every
// qualifying species is listed (Jaxon 2026-08-27: names only, "include more
// than one core breaker if it applies").
const CORE_BREAK_MIN_TEAMS = 5;
const CORE_BREAK_WIN_RATE_MAX = 0.4;

/**
 * Distinct base species of one opponent team, with display names -- shadow
 * and base group together (a "loses to Altaria" hole does not care which).
 *
 * @param {{members: Array<object>}} opp - elites-pass opponent entry.
 * @returns {Array<{id: string, name: string}>}
 */
function teamBaseSpecies(opp) {
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
 * The elite's core breakers: every species appearing in at least
 * CORE_BREAK_MIN_TEAMS of its elites-pass opponent teams against which the
 * elite's group win rate is at most CORE_BREAK_WIN_RATE_MAX, worst first.
 * Report only (see the constants' comment).
 *
 * @param {Array<object>} perMeta - per-opponent rows (wins/losses/ties + species).
 * @returns {Array<{id:string,name:string,teams:number,wins:number,losses:number,ties:number,winRate:number}>}
 */
function computeCoreBreakExposure(perMeta) {
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
    .filter((a) => a.winRate <= CORE_BREAK_WIN_RATE_MAX)
    .sort((a, b) => a.winRate - b.winRate || b.teams - a.teams || (a.id < b.id ? -1 : 1));
}

const LEADS = [0, 1, 2];

// Memo-cache ceiling. Measured (2026-08-26, heap-delta over a real run) at
// 289 bytes per trimmed entry plus its interned key, so a FULL cache is about
// 578 MB of main-process heap -- affordable for a run big enough to reach it,
// and well inside node's default old-space, but not free. Smaller runs never
// come close: a 120-generation run at the sizes Jaxon actually uses lands
// around a million distinct pairings, ~290 MB.
// Past the cap the cache simply stops accepting new entries -- see
// createBattleCache for why there is no eviction.
const BATTLE_CACHE_MAX_ENTRIES = 2_000_000;

// Bump whenever a checkpoint's on-disk SHAPE changes in a way `config`
// -matching alone can't detect (see the ROBUSTNESS comment above). v2 = the
// locked-lead population representation: `team[0]`
// is a designated lead, not an arbitrary array slot. v3 = the persistent,
// evolving opponent pool: a checkpoint now also carries the serialized
// opponent pool it was measured against and the pool it handed to the next
// generation, plus per-team win rates keyed by team signature (the input to
// the trailing-generations ranking term). A v2 checkpoint has none of that
// and cannot be resumed.
const CHECKPOINT_FORMAT_VERSION = 3;

// ---------------------------------------------------------------------------
// Small pure formatting helpers (duplicated from scripts/tournament.mjs --
// both files are small, standalone CLI scripts with no shared "funnel utils"
// module in this codebase; see src/teams/sample.js/sampleTeams.js for the
// same duplicated-small-helper pattern elsewhere).
// ---------------------------------------------------------------------------

function pct(x) {
  return x === null || x === undefined ? 'n/a' : `${Math.round(x * 100)}%`;
}

function signed(x) {
  const s = x.toFixed(1);
  return x > 0 ? `+${s}` : s;
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
 * Report-facing member name: stamp the shadow qualifier exactly the way
 * src/teams/index.js does at its own member-construction site (see the
 * comment there) -- a shadow and its ordinary counterpart share `b.name`,
 * so without this a team built on a shadow reads as the normal form.
 * Guarded so a name that already carries it is not double-suffixed.
 *
 * @param {object} b - built mon from matrix.builtMons.
 * @returns {string}
 */
function memberDisplayName(b) {
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
function reportMemberDetail(m) {
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
 * "Lead / Back / Back" team-name formatting (locked
 * leads) -- `members[0]` is always the designated lead end-to-end (see the
 * LOCKED LEADS note above and evaluateTeamsInOrder's own comment on why
 * `bestLead` always resolves to index 0). Plain-text (Markdown) variant.
 */
/**
 * One-line build cost for an elite team (src/cost/powerup.js). Local to this
 * script because src/report/index.js's copy isn't exported -- the GA writes
 * its own reports; the wording is deliberately identical.
 *
 * @param {object} cost - teamBuildCost result.
 * @returns {string}
 */
function formatBuildCost(cost) {
  const group = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const parts = [];
  if (cost.stardust) parts.push(`${group(cost.stardust)} Stardust`);
  if (cost.candy) parts.push(`${group(cost.candy)} Candy`);
  if (cost.candyXl) parts.push(`${group(cost.candyXl)} Candy XL`);
  let body = parts.length ? parts.join(' + ') : 'none -- already built';
  if (cost.evolveItems?.length) body += `, plus ${cost.evolveItems.join(' + ')}`;
  const evolving = cost.members.filter((m) => m.evolveFrom);
  if (evolving.length) {
    body += ` (evolve ${evolving.map((m) => `${m.evolveFrom} -> ${m.name}`).join(', ')})`;
  }
  const caveats = [];
  if (cost.unknownLevels) caveats.push(`${cost.unknownLevels} with no level in the CSV`);
  if (cost.unpricedEvolutions) caveats.push(`${cost.unpricedEvolutions} unpriced evolution(s)`);
  return caveats.length ? `${body} -- excludes ${caveats.join(' and ')}` : body;
}

function formatTeamMembers(members) {
  const [lead, ...backs] = members;
  return `${lead.name} (Lead) / ${backs.map((b) => b.name).join(' / ')}`;
}


function formatDuration(ms) {
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

// ---------------------------------------------------------------------------
// Lead-pairing schemes -- LOCKED LEADS: the
// candidate's own lead is always `team[0]` (never averaged over its 3
// members any more; see the header's LOCKED LEADS note). This intentionally
// diverges from scripts/tournament.mjs, which still
// runs its own averaged-own-lead scheme.
// ---------------------------------------------------------------------------

const CANDIDATE_LEAD = 0;

/**
 * Resolve an opponent team's designated lead index. Every opponent now
 * carries one explicitly: curated teams by src/meta/teams.js's file-wide
 * member-index-0-is-lead doctrine, and composed teams because
 * src/meta/sampleTeams.js rotates the chosen lead into slot 0 at composition
 * time (from pvpoke's own published `leads` rankings) and stamps
 * `leadIndex: 0`. The `?? 0` is the vendor-preset case, which shares the same
 * doctrine without stamping the field.
 */
function opponentLeadIndex(opp) {
  return opp.leadIndex ?? 0;
}

/** Own-lead-locked single pairing: candidate's team[0] vs. the opponent's declared lead. */
function ownLeadPairing(opp) {
  return [{ leadA: CANDIDATE_LEAD, leadB: opponentLeadIndex(opp) }];
}

// ---------------------------------------------------------------------------
// Battle-reality fitness. `evaluateTeamsInOrder`
// (below) already runs every generation's battles through `battleTeams`, whose
// `summary` carries the lead-exchange extraction (`leadFaintTurnA/B`) for
// free -- no new battles. This section classifies each battle's exchange
// outcome and blends it, plus the role priors, into an alternate fitness
// metric alongside the plain win rate `--fitness classic` already computed.
// ---------------------------------------------------------------------------

/**
 * Which side's ORIGINAL lead fainted first (lost the lead exchange), from
 * `battleTeams`' summary -- verbatim copy of scripts/alignment-study.mjs's
 * own `leadExchangeLoser` (duplicated per this
 * file's own established small-helper convention -- see the header comment
 * above `pct`/`signed`/`formatDuration` -- rather than importing a script).
 * @returns {'a'|'b'|'simultaneous'|'none'}
 */
function leadExchangeLoser(summary) {
  const { leadFaintTurnA: ta, leadFaintTurnB: tb } = summary;
  if (ta === null && tb === null) return 'none';
  if (ta === null) return 'b';
  if (tb === null) return 'a';
  if (ta === tb) return 'simultaneous';
  return ta < tb ? 'a' : 'b';
}

/**
 * Blend weights for `--fitness battle-reality` (documented judgment call --
 * a tunable blend whose numbers are chosen here;
 * not exposed as CLI flags, matching this file's own GA-TUNABLES
 * precedent above). `winRate` stays the majority component since it is the
 * only one measuring actual game outcomes; `snowball` is weighted
 * meaningfully (not a token amount) because a real-battle measurement
 * found winning the lead exchange roughly a 2.3-2.7x multiplier on win
 * probability (P(win|won)~=0.69-0.73 vs P(win|lost)~=0.27-0.31)
 * -- a strong, real signal about which
 * teams convert an early advantage, independent of whether their back line
 * ultimately closes the game out; `closer` gets the smallest share because
 * it is a SPECIES-level prior from pvpoke's own rankings, not a fact
 * about this collection's real battles the way the other two terms are.
 */
const DEFAULT_FITNESS_WEIGHTS = Object.freeze({ winRate: 0.6, snowball: 0.3, closer: 0.1 });

/**
 * Per-team snowball score: this team's OWN fraction of DECIDED lead exchanges
 * (across its battles fought this generation) it won -- i.e. how often its
 * lead outlasts the opponent's, independent of whether the game is ultimately
 * won or lost. `exchangeWon`/`exchangeLost` exclude `'simultaneous'`/`'none'`
 * battles (a real-battle sample found ~15-21% of battles never see
 * either lead faint -- not a meaningful exchange signal either way). Falls
 * back to `winRate` (not 0 or 0.5) when a team had zero decided exchanges
 * this generation (a tiny --opponents-per-gen, or a team that only ever
 * fights to a stalemate) -- a neutral choice that doesn't bias the blend
 * toward or away from a team the sample simply couldn't measure.
 */
function computeSnowballScore(exchangeWon, exchangeLost, winRate) {
  const decided = exchangeWon + exchangeLost;
  return decided > 0 ? exchangeWon / decided : winRate;
}

/**
 * Per-team closer score: mean of the `loadRoleScores` `closer` prior across
 * the team's two BACK members (`team[1]`/`team[2]`, i.e. `members.slice(1)`)
 * -- documented judgment call: the closer role is specifically about being
 * switched in with a shield advantage to close out a game (the shield
 * -banking findings), which is a back-line job under the locked-lead
 * convention, not the lead's. A species absent from the loader (never
 * happens for a real gamemaster speciesId under the pinned vendor commit,
 * but guarded anyway) contributes 0, not a skip -- an
 * unknown closer value is not evidence of a good one.
 */
function computeCloserScore(members, roleScores) {
  const backs = members.slice(1);
  if (backs.length === 0) return 0;
  const sum = backs.reduce((s, m) => s + (roleScores?.get(m.speciesId)?.closer ?? 0), 0);
  return sum / backs.length;
}

function computeBlendFitness({ winRate, snowballScore, closerScore }, weights = DEFAULT_FITNESS_WEIGHTS) {
  return weights.winRate * winRate + weights.snowball * snowballScore + weights.closer * closerScore;
}

// ---------------------------------------------------------------------------
// Report-facing metrics (distinct from the
// fitness-blend components above): `snowballScore`/`closerScore` above answer
// "how often does this team win the exchange" / "how good are its backs at
// closing, per pvpoke's priors" -- inputs to the fitness blend. These three
// answer the questions the report actually asks: given the
// exchange outcome, how often does the team go on to WIN THE GAME, and which
// specific back member is the better closer (not just the mean of both).
// Pure post-processing of data evaluateTeamsInOrder's battle loop already
// collects -- no new battles.
// ---------------------------------------------------------------------------

/**
 * P(win the game | won the lead exchange) -- `null` (not 0) when the team had
 * zero decided-and-won exchanges this run: the sample can't measure it, which
 * is different from measuring a 0% conversion rate.
 */
function computeSnowballIndex(winsGivenExchangeWon, exchangeWon) {
  return exchangeWon > 0 ? winsGivenExchangeWon / exchangeWon : null;
}

/** P(win the game | lost the lead exchange) -- the "comeback" rate. `null` when never measured (same reasoning as {@link computeSnowballIndex}). */
function computeComebackIndex(winsGivenExchangeLost, exchangeLost) {
  return exchangeLost > 0 ? winsGivenExchangeLost / exchangeLost : null;
}

/**
 * Designated closer: of the team's two BACK members, whichever carries the
 * HIGHER role-prior `closer` score (same "closing is a back-line job"
 * rationale as {@link computeCloserScore}, but reporting the standout member
 * rather than the pair's mean). `null` if the team has no back members. A
 * missing role-score (never happens for a real gamemaster speciesId under
 * the pinned vendor commit, but guarded anyway) counts
 * as 0, same convention as computeCloserScore.
 * @returns {{key:string, speciesId:string, name:string, closer:number}|null}
 */
function pickDesignatedCloser(members, roleScores) {
  const backs = members.slice(1);
  if (backs.length === 0) return null;
  return backs.reduce((best, m) => {
    const closer = roleScores?.get(m.speciesId)?.closer ?? 0;
    return !best || closer > best.closer ? { key: m.key, speciesId: m.speciesId, name: m.name, closer } : best;
  }, null);
}

// ---------------------------------------------------------------------------
// Population / opponent-count schedule (Jaxon 2026-08-26).
//
// The candidate population SHRINKS across the run and the opponent pool GROWS
// to match, so late generations spend the same battle budget measuring fewer,
// better teams against many more opponents (less sampling noise per team,
// less compute burned on teams that were already hopeless). Both are pure
// functions of the generation index and the run config -- no state, so a
// resumed run recomputes exactly the same sizes.
// ---------------------------------------------------------------------------

/** Smallest population the schedule will shrink to, whatever the ratio says -- below this the GA has no gene pool left to work with. Itself capped by `--population`: the floor may not INFLATE a run the caller deliberately asked to keep small (a `--population 8` smoke run must stay at 8). */
const MIN_SCHEDULED_POPULATION = 12;

/**
 * Candidate population for generation `g`: a straight linear ramp from the
 * configured `population` down to `population * populationFinalRatio` at the
 * last allowed generation.
 */
function populationAt(g, config) {
  const G = Math.max(1, config.generations);
  const t = G > 1 ? Math.min(1, g / (G - 1)) : 0;
  const ratio = 1 - t * (1 - config.populationFinalRatio);
  const floor = Math.min(MIN_SCHEDULED_POPULATION, config.population);
  return Math.max(floor, Math.min(config.population, Math.round(config.population * ratio)));
}

/**
 * Opponent-pool size for generation `g`: DERIVED from the population so the
 * per-generation battle grid (population x opponents) stays at its gen-0
 * value. That is what makes the trade cost-neutral -- the run does not get
 * slower as it narrows, it just re-spends the same battles on a better
 * question.
 */
function opponentsAt(g, config) {
  const budget = config.population * config.opponentsPerGen;
  return Math.max(1, Math.round(budget / populationAt(g, config)));
}

// ---------------------------------------------------------------------------
// Battle memo cache.
//
// `battleTeams` is deterministic given (teamA specs, teamB specs, leadA,
// leadB, difficulty) -- src/engine/teamBattle.js resets a fresh Battle, a
// fresh virtual clock and a seeded RNG per call, and derives its seed from
// exactly those inputs. The GA re-fights an enormous number of IDENTICAL
// pairings: two thirds of the candidate population survives each generation
// unchanged, and (since the opponent pool became persistent) so does most of
// the opponent pool, so most of generation N's grid is the same grid as
// generation N-1's. Memoizing it is not an approximation -- it returns the
// number the battle would have returned.
//
// BIT-IDENTICAL, not merely equivalent. An earlier draft of this comment
// hedged, citing src/engine/README.md's "Known limitation" -- a Pokemon
// INSTANCE reused across battles carrying a `resetMoves()` tie-break artifact
// that made exact HP totals (very rarely, winners) depend on the order that
// instance's battles ran in. That limitation was root-caused and FIXED on
// 2026-08-22 (uninitialized bench-member `baitShields`/`farmEnergy`/
// `priority`/`hasActed`; see the README's "Net effect: the doctrine is
// retired"). Same spec + seed -> same result, whatever ran before it. So the
// memo returns exactly what a re-simulation would have returned, and
// `--no-battle-cache` is a speed switch, not a correctness knob -- it exists
// to A/B the cache itself and to cap memory on a very long run.
// ---------------------------------------------------------------------------

/** Stable key for one plain-data mon spec. Mirrors src/engine/parallelWorker.js's own `monKey` -- same fields, same order, for the same reason (two specs differing only in an explicit moveset are different mons). */
function monSpecKey(m) {
  const moveset = m.fastMove ? `${m.fastMove}/${(m.chargedMoves || []).join(',')}` : '';
  return `${m.speciesId}|${m.ivs.atk},${m.ivs.def},${m.ivs.hp}|${m.shadow ? 1 : 0}|${m.bestBuddy ? 1 : 0}|${moveset}`;
}

/**
 * The battle-result fields anything downstream of `evaluateTeamsInOrder`
 * actually reads. Cached entries are trimmed to exactly this shape so a long
 * run's cache stays a few tens of MB instead of a few hundred: `winner`,
 * `survivorsHp.{a,b,aPerMon}` (win/loss, HP margin, and the per-member
 * switched-in HP the safe-swap stat needs), and the two `summary` fields the
 * lead-exchange classifier reads. ADDING A NEW CONSUMER OF SOME OTHER
 * `summary` FIELD MEANS ADDING IT HERE TOO -- otherwise it silently reads
 * `undefined` on a cache hit.
 */
function trimBattleResult(r) {
  return {
    winner: r.winner,
    survivorsHp: { a: r.survivorsHp.a, b: r.survivorsHp.b, aPerMon: r.survivorsHp.aPerMon },
    summary: { leadFaintTurnA: r.summary.leadFaintTurnA, leadFaintTurnB: r.summary.leadFaintTurnB },
  };
}

/**
 * Create the run-scoped battle memo. Team specs are interned to small integer
 * ids so a cache key is ~15 characters rather than the ~250 a pair of full
 * spec lists would cost -- at a million entries that is the difference
 * between tens and hundreds of megabytes of keys alone.
 *
 * @param {number} maxEntries - stop inserting past this many results (the
 *   cache degrades to "some misses" rather than growing without bound; there
 *   is no eviction, because the entries most worth keeping are the oldest --
 *   long-surviving elites against long-surviving opponents).
 */
function createBattleCache(maxEntries) {
  const teamIds = new Map();
  const results = new Map();
  let hits = 0;
  let misses = 0;
  let dropped = 0;

  function teamId(specs) {
    const key = specs.map(monSpecKey).join(';');
    let id = teamIds.get(key);
    if (id === undefined) {
      id = teamIds.size;
      teamIds.set(key, id);
    }
    return id;
  }

  return {
    keyFor(teamASpec, leadA, teamBSpec, leadB, difficulty) {
      return `${teamId(teamASpec)}:${leadA}|${teamId(teamBSpec)}:${leadB}|${difficulty ?? ''}`;
    },
    get(key) {
      const hit = results.get(key);
      if (hit === undefined) {
        misses += 1;
        return undefined;
      }
      hits += 1;
      return hit;
    },
    set(key, result) {
      if (results.size >= maxEntries) {
        dropped += 1;
        return;
      }
      results.set(key, trimBattleResult(result));
    },
    stats() {
      return { hits, misses, size: results.size, dropped };
    },
  };
}

/**
 * Cache-disabled stand-in with the same shape, so the battle loop has exactly
 * one code path. Every `keyFor` call returns a fresh unique string, so
 * nothing is ever a hit AND nothing is ever deduplicated within a batch
 * either -- `--no-battle-cache` reproduces the pre-cache behavior exactly,
 * including re-fighting a pairing that appears twice in the same generation.
 */
function createNullBattleCache() {
  let n = 0;
  return {
    keyFor: () => `uncached-${n++}`,
    get: () => undefined,
    set: () => undefined,
    stats: () => ({ hits: 0, misses: 0, size: 0, dropped: 0 }),
  };
}

// ---------------------------------------------------------------------------
// `--ban` helpers ("Competitor's Cup: no Mimikyu, no Cramorant"-style
// format-wide bans, distinct from `--exclude`'s candidate-only exclusion).
// Every check matches by BASE species id (src/meta/sampleTeams.js's
// baseIdOf), never an exact speciesId, so a ban on e.g. 'medicham' also
// catches 'medicham_shadow' -- an exact-match-only ban would miss the shadow
// variant. NOTE (Jaxon's brief said "forms/shadow variants" -- worth flagging
// since it proved narrower than written): baseIdOf only strips the literal
// `_shadow` suffix; it does NOT merge distinct battle/regional forms that are
// their own gamemaster speciesId (e.g. 'mimikyu' and 'mimikyu_busted' are two
// separate ids -- a ban on 'mimikyu' does not reach 'mimikyu_busted'). This
// matches the rest of the codebase's own definition of "base species" for
// dedup purposes (see src/meta/sampleTeams.js's own doc comment on baseIdOf,
// and this file's teamBaseSpecies), so it is deliberately NOT strengthened
// here into a different, --ban-only rule. Pure, no battles -- exported for
// tests.
// ---------------------------------------------------------------------------

/** True if any of `speciesIds` has a base form in `banBaseIds`. */
function anyBaseIdBanned(speciesIds, banBaseIds) {
  return speciesIds.some((id) => banBaseIds.has(baseIdOf(id)));
}

/**
 * Every concrete speciesId present in `builtMons` (a scoreCollection/dedupe
 * -shaped `{key: {speciesId}}` map, e.g. `dedupeBestPerSpecies`'s output)
 * whose base id (baseIdOf) is banned. Used to expand a `--ban` base-id list
 * into the exact-match `excludeSpecies` candidate teams already honor end to
 * end (src/teams/sample.js's buildScoredPool, src/teams/evolve.js's
 * initPopulation/nextGeneration) -- so a shadow variant the user happens to
 * own can't sneak a banned species onto a candidate team.
 *
 * @param {Record<string, {speciesId: string}>} builtMons
 * @param {Iterable<string>} banBaseIds
 * @returns {string[]}
 */
export function expandBanToCandidateSpeciesIds(builtMons, banBaseIds) {
  const banSet = banBaseIds instanceof Set ? banBaseIds : new Set(banBaseIds);
  if (banSet.size === 0) return [];
  const ids = new Set();
  for (const built of Object.values(builtMons)) {
    if (banSet.has(baseIdOf(built.speciesId))) ids.add(built.speciesId);
  }
  return [...ids];
}

/**
 * Drop WHOLE curated teams (src/meta/teams.js's loadMetaTeams output)
 * containing any banned base species -- a cup rule removes the team
 * entirely, not just the one banned member. Applying this once to the
 * `curatedPool` variable at load time reaches every use site downstream: the
 * per-generation opponent pool (initOpponentPool/nextOpponentPool's
 * `curated` param) and the final elites pass (`eliteCurated`).
 *
 * @param {import('../src/meta/teams.js').MetaTeam[]} teams
 * @param {Iterable<string>} banBaseIds
 * @returns {import('../src/meta/teams.js').MetaTeam[]}
 */
export function filterBannedCuratedTeams(teams, banBaseIds) {
  const banSet = banBaseIds instanceof Set ? banBaseIds : new Set(banBaseIds);
  if (banSet.size === 0) return teams;
  return teams.filter((t) => !anyBaseIdBanned(t.members.map((m) => m.speciesId), banSet));
}

/**
 * Drop banned-base-species entries from a moveset pool
 * (src/meta/sampleTeams.js's loadMovesetPool output). Applying this once to
 * the `movesetPool` variable reaches every composed-opponent path that
 * variable is threaded into: initOpponentPool, nextOpponentPool, and (through
 * nextOpponentPool's own `movesetPool` param) its buildMemberSwap mutation
 * and immigrant draws -- none of them load their own copy.
 *
 * @param {Array<{speciesId: string}>} pool
 * @param {Iterable<string>} banBaseIds
 * @returns {Array<{speciesId: string}>}
 */
export function filterBannedMovesetPool(pool, banBaseIds) {
  const banSet = banBaseIds instanceof Set ? banBaseIds : new Set(banBaseIds);
  if (banSet.size === 0) return pool;
  return pool.filter((e) => !banSet.has(baseIdOf(e.speciesId)));
}

// ---------------------------------------------------------------------------
// Run config (checkpoint fingerprint) + checkpoint I/O.
// ---------------------------------------------------------------------------

/**
 * Canonical JSON-serializable REQUESTED inputs for a run -- compared against
 * a checkpoint's `config` on resume (same key-order-stable, deliberately-
 * conservative approach as scripts/tournament.mjs's buildRunConfig).
 * `deadlineMinutes`, `threads` and `battleCache` are excluded on purpose:
 * none changes what any generation COMPUTES (deadline only decides whether to
 * stop before starting the next one; threads and the memo cache are pure
 * performance knobs), so changing any of them between runs must not
 * invalidate an existing checkpoint.
 */
function buildRunConfig(csvPath, opts) {
  return {
    csvPath: path.resolve(csvPath),
    scoreMeta: opts.scoreMeta ?? DEFAULTS.scoreMeta,
    evolutions: opts.evolutions ?? true,
    pool: opts.pool ?? DEFAULTS.pool,
    seed: String(opts.seed ?? DEFAULTS.seed),
    cp: opts.cp ?? DEFAULTS.cp,
    curatedRatio: opts.curatedRatio ?? DEFAULTS.curatedRatio,
    excludeSpecies: [...(opts.excludeSpecies ?? [])].sort(),
    // Format-wide ban ("no Mimikyu, no Cramorant"), normalized to BASE
    // species ids up front (see the `--ban` helpers above) so a checkpoint's
    // fingerprint is stable whatever form the caller happened to type --
    // always in the fingerprint (like excludeSpecies), never opt-in, since it
    // changes both sides of what every generation computes.
    banSpecies: [...new Set((opts.banSpecies ?? []).map(baseIdOf))].sort(),
    difficulty: opts.difficulty ?? null,
    population: opts.population ?? DEFAULTS.population,
    opponentsPerGen: opts.opponentsPerGen ?? DEFAULTS.opponentsPerGen,
    generations: opts.generations ?? DEFAULTS.generations,
    fixedOpponents: !!opts.fixedOpponents,
    eliteCount: opts.eliteCount ?? DEFAULTS.elites,
    // Both change what every generation COMPUTES (the schedule decides each
    // generation's population/opponent counts; the meta-pool cap decides which
    // species a composed opponent can be made of), so both are part of the
    // checkpoint fingerprint.
    populationFinalRatio: opts.populationFinalRatio ?? DEFAULTS.populationFinalRatio,
    opponentMetaPool: opts.opponentMetaPool ?? DEFAULTS.opponentMetaPool,
    // Part of the fingerprint -- resuming a 'classic' run's
    // checkpoints under 'battle-reality' (or vice versa) would silently graft
    // a different generation's fitness semantics onto a population that was
    // selected/mutated under the other one.
    fitness: opts.fitness ?? DEFAULTS.fitness,
    // GA-rate / convergence overrides enter the fingerprint ONLY when set:
    // they change what every generation computes, but leaving them out when
    // absent keeps every pre-flag checkpoint dir resumable.
    ...(opts.deathRate !== undefined ? { deathRate: opts.deathRate } : {}),
    ...(opts.mutationFloor !== undefined ? { mutationFloor: opts.mutationFloor } : {}),
    ...(opts.mutationCeil !== undefined ? { mutationCeil: opts.mutationCeil } : {}),
    ...(opts.immigrantFraction !== undefined ? { immigrantFraction: opts.immigrantFraction } : {}),
    ...(opts.convWindow !== undefined || opts.convTopN !== undefined
      ? {
          convergence: {
            ...(opts.convWindow !== undefined ? { window: opts.convWindow } : {}),
            ...(opts.convTopN !== undefined ? { topN: opts.convTopN } : {}),
          },
        }
      : {}),
    // NOT in the fingerprint, deliberately: `battleCache`, `threads` and
    // `deadlineMinutes` -- all three are pure speed knobs that cannot change a
    // battle's outcome (the memo returns what a re-simulation would return,
    // and worker count has been bit-identical to serial since the 2026-08-22
    // engine fix), so toggling one mid-run must not invalidate hours of
    // checkpoints.
  };
}

function configsMatch(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function checkpointPath(outDir, generation) {
  return path.join(outDir, `evolve-gen${generation}.json`);
}

function readCheckpoint(outDir, generation) {
  const p = checkpointPath(outDir, generation);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeCheckpoint(outDir, generation, data) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(checkpointPath(outDir, generation), JSON.stringify(data, null, 2), 'utf8');
}

function writeGenerationsAnalytics(outDir, generationRecords) {
  mkdirSync(outDir, { recursive: true });
  const analyticsOnly = generationRecords.map((r) => ({
    generation: r.generation,
    resumed: !!r.resumed,
    battleCount: r.timing.battleCount,
    errorCount: r.timing.errorCount,
    elapsedMs: r.timing.elapsedMs,
    msPerBattle: r.timing.msPerBattle,
    ...r.analytics,
  }));
  writeFileSync(path.join(outDir, 'evolve-generations.json'), JSON.stringify(analyticsOnly, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Sampling pool (verbatim duplicate of scripts/tournament.mjs's private
// buildSamplingPool -- pure list-ranking, no battle math, no engine calls).
// ---------------------------------------------------------------------------

function buildSamplingPool(deduped, poolSize, excludeSpecies) {
  const exclude = new Set(excludeSpecies);
  return Object.keys(deduped.ratings)
    .filter((key) => !exclude.has(deduped.builtMons[key].speciesId))
    .map((key) => ({ key, score: computeWeightedScore(deduped.ratings[key]) }))
    .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, poolSize)
    .map((m) => m.key);
}

// ---------------------------------------------------------------------------
// Species-set helpers + per-generation analytics (cheap -- it's
// just counting: computed entirely from data a generation's battles and
// src/teams/evolve.js's nextGeneration already produce; no extra battles).
// ---------------------------------------------------------------------------

function speciesOfTeam(matrix, team) {
  return team.map((key) => matrix.builtMons[key].speciesId);
}

/**
 * Lead-aware identity for a candidate team: the lead key, then the two backs
 * sorted (their relative order carries no meaning). This MUST stay
 * byte-identical to src/teams/evolve.js's own private `teamSignature` -- that
 * module uses it for uniqueness and convergence, and this file uses it to
 * follow one team's win rate across the generations it survived. It is
 * duplicated rather than exported because it is three lines and the two uses
 * are genuinely independent; if it ever grows, export it from there instead.
 */
function teamSignature(team) {
  return `${team[0]}||${[...team.slice(1)].sort().join('|')}`;
}

/**
 * Per-generation opponent-pool analytics: how the pool is composed and how
 * hard it actually is. Counting only, over data the generation's battles
 * already produced -- no extra battles.
 *
 * @param {{opponents: object[], opponentFitness: number[]}} params
 * @returns {{opponentOriginCounts: object, opponentMeanFitness: number,
 *   opponentMaxFitness: number, toughestOpponents: Array<object>}}
 */
function computeOpponentAnalytics({ opponents, opponentFitness }) {
  const opponentOriginCounts = {};
  for (const o of opponents) opponentOriginCounts[o.origin ?? o.label ?? 'unknown'] = (opponentOriginCounts[o.origin ?? o.label ?? 'unknown'] ?? 0) + 1;
  const ranked = opponents
    .map((o, i) => ({ id: o.id, name: o.name, origin: o.origin ?? o.label ?? null, fitness: opponentFitness[i] ?? 0 }))
    .sort((a, b) => b.fitness - a.fitness);
  return {
    opponentOriginCounts,
    opponentMeanFitness: opponentFitness.length
      ? opponentFitness.reduce((sum, f) => sum + f, 0) / opponentFitness.length
      : 0,
    opponentMaxFitness: opponentFitness.length ? Math.max(...opponentFitness) : 0,
    toughestOpponents: ranked.slice(0, TOUGHEST_OPPONENTS_CAP),
  };
}

/** Report-facing summary of the run's FINAL opponent pool (composition + its hardest members). */
function summarizeOpponentPool(pool, fitness) {
  const originCounts = {};
  for (const o of pool) originCounts[o.origin ?? o.label ?? 'unknown'] = (originCounts[o.origin ?? o.label ?? 'unknown'] ?? 0) + 1;
  const ranked = pool
    .map((o, i) => ({
      id: o.id,
      name: o.name,
      origin: o.origin ?? o.label ?? null,
      parentId: o.parentId ?? null,
      members: o.members.map((m) => m.speciesId),
      fitness: fitness[i] ?? 0,
    }))
    .sort((a, b) => b.fitness - a.fitness);
  return {
    size: pool.length,
    originCounts,
    toughest: ranked.slice(0, TOUGHEST_OPPONENTS_CAP),
  };
}

/**
 * @param {{matrix:object, population:string[][], fitness:number[],
 *   lineage:{died:number[], entries:Array<object>}|null, results?:object[]}} params
 *   `lineage` is the OUTGOING transition (this generation -> the next);
 *   null for a generation that had no next generation (the run's very last).
 *   `results` (optional) is `evaluateTeamsInOrder`'s own positional
 *   per-team output for THIS generation (same index as `population`/`fitness`)
 *   -- used only to source `topTeams`' snowballIndex/comebackIndex/designatedCloser;
 *   everything else here is unaffected if omitted.
 */
function computeGenerationAnalytics({ matrix, population, fitness, lineage, results }) {
  const bySpecies = new Map();
  population.forEach((team, i) => {
    for (const s of new Set(speciesOfTeam(matrix, team))) {
      const cur = bySpecies.get(s) ?? { count: 0, fitnessSum: 0 };
      cur.count += 1;
      cur.fitnessSum += fitness[i];
      bySpecies.set(s, cur);
    }
  });
  const speciesStats = [...bySpecies.entries()]
    .map(([speciesId, v]) => ({
      speciesId,
      representation: v.count / population.length,
      meanFitness: v.fitnessSum / v.count,
    }))
    .sort((a, b) => b.representation - a.representation || b.meanFitness - a.meanFitness);

  let originCounts = null;
  let survivalBySpecies = null;
  if (lineage) {
    originCounts = { survived: 0, mutant: 0, immigrant: 0 };
    for (const e of lineage.entries) originCounts[e.origin] = (originCounts[e.origin] ?? 0) + 1;

    const oldCounts = new Map();
    const survivedCounts = new Map();
    const diedSet = new Set(lineage.died);
    population.forEach((team, i) => {
      const survived = !diedSet.has(i);
      for (const s of new Set(speciesOfTeam(matrix, team))) {
        oldCounts.set(s, (oldCounts.get(s) ?? 0) + 1);
        if (survived) survivedCounts.set(s, (survivedCounts.get(s) ?? 0) + 1);
      }
    });
    survivalBySpecies = [...oldCounts.entries()]
      .map(([speciesId, total]) => ({ speciesId, survivalRate: (survivedCounts.get(speciesId) ?? 0) / total, total }))
      .sort((a, b) => b.survivalRate - a.survivalRate);
  }

  const rankedIdx = population.map((_, i) => i).sort((a, b) => fitness[b] - fitness[a] || a - b);
  const eliteIdx = rankedIdx.slice(0, Math.min(10, population.length)); // fixed top-10 for core-pair stats AND topTeams (below), independent of --elites (report's final-ranking count)

  // Per-team battle-reality metrics for THIS generation's top-10,
  // written into out/evolve-generations.json so they're trackable across
  // generations (not just the final elites pass, which already surfaces them
  // in the report). `results` is optional/positional; a caller that omits it
  // (none do today) just gets `null`s here rather than an error.
  const topTeams = eliteIdx.map((i, rank) => {
    const r = results?.[i];
    return {
      rank: rank + 1,
      members: population[i].map((key) => {
        const b = matrix.builtMons[key];
        return { key, speciesId: b.speciesId, name: memberDisplayName(b) };
      }),
      fitness: fitness[i],
      winRate: r?.winRate ?? null,
      snowballIndex: r?.snowballIndex ?? null,
      comebackIndex: r?.comebackIndex ?? null,
      designatedCloser: r?.designatedCloser ?? null,
    };
  });

  const coreCounts = new Map();
  for (const i of eliteIdx) {
    const species = [...new Set(speciesOfTeam(matrix, population[i]))].sort();
    for (let a = 0; a < species.length; a++) {
      for (let b = a + 1; b < species.length; b++) {
        const key = `${species[a]} + ${species[b]}`;
        coreCounts.set(key, (coreCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const topCores = [...coreCounts.entries()]
    .map(([core, count]) => ({ core, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_CORES_CAP);

  return {
    meanFitness: fitness.length ? fitness.reduce((s, f) => s + f, 0) / fitness.length : 0,
    maxFitness: fitness.length ? Math.max(...fitness) : 0,
    // Capped (SPECIES_STATS_CAP) rather than dumping every species every
    // generation -- documented here and in the report rather than silently
    // truncated; a full per-species history is still recoverable from the
    // per-generation checkpoints (out/evolve-gen<N>.json), which are NOT capped.
    speciesStats: speciesStats.slice(0, SPECIES_STATS_CAP),
    speciesStatsTruncated: speciesStats.length > SPECIES_STATS_CAP,
    originCounts,
    survivalBySpecies: survivalBySpecies ? survivalBySpecies.slice(0, SPECIES_STATS_CAP) : null,
    topCores,
    topTeams, // this generation's top-10 by fitness, with snowballIndex/comebackIndex/designatedCloser
  };
}

// ---------------------------------------------------------------------------
// Battle runner. Mirrors scripts/tournament.mjs's runFunnelStage's
// threaded-executor structure; the differences are no candidate narrowing
// (every generation battles its WHOLE population), preserved input order, and
// the memo cache above.
// ---------------------------------------------------------------------------

/**
 * Battle every team in `teams` against every opponent, in INPUT ORDER (not
 * sorted -- src/teams/evolve.js's nextGeneration needs fitness[i] to
 * correspond to population[i]).
 *
 * Structure: (1) plan every pairing and reduce it to a cache key; (2) run the
 * DISTINCT, not-already-cached pairings once, threaded or serial; (3) walk the
 * plan again and accumulate per-team and per-opponent statistics from the
 * outcome map. Step 2 is where the memo cache (and, with it, the whole
 * saving from re-fighting an unchanged grid) lives; steps 1 and 3 are the
 * same bookkeeping this function always did.
 *
 * @param {object} ctx
 * @param {{
 *   teams: string[][], matrix: object, opponents: object[],
 *   pairingsFor: (opp: object) => Array<{leadA:number, leadB:number}>,
 *   difficulty?: number, trackLeads?: boolean, executor?: object,
 *   onLog?: (msg:string)=>void, roleScores?: Map<string, object>,
 *   cache?: object, opponentWeights?: number[],
 * }} params -- `opponentWeights[j]` (optional, parallel to `opponents`)
 *   weights opponent j's battles in each team's `winRate`; raw counts
 *   (`battles`, per-opponent tallies) are never weighted.
 * @returns {Promise<{results:object[], opponentTally:Array<{winPoints:number, battles:number}>,
 *   battleCount:number, cachedCount:number, errorCount:number, elapsedMs:number,
 *   startedAt:number, finishedAt:number}>}
 *   `opponentTally[j]` is the CANDIDATE side's ledger against `opponents[j]`
 *   across every team battled -- src/meta/opponentPool.js turns it into that
 *   opponent's fitness (`1 - winPoints/battles`) at no extra battle cost.
 *   `battleCount` counts battles actually SIMULATED; `cachedCount` counts
 *   pairings served from the memo (both are reported, so a run's speedup is
 *   visible rather than implied).
 */
async function evaluateTeamsInOrder(ctx, params) {
  // trackLeads' bestLead computation (below) predates the locked
  // leads and still iterates all 3 of the team's OWN lead slots -- left
  // as-is rather than redesigned. It still resolves correctly without any
  // code change: `pairingsFor` now only ever produces leadA=0 battles (see
  // ownLeadPairing above), so leadWins[1]/leadWins[2] and
  // leadBattles[1]/leadBattles[2] stay at 0 and the max-by-winRate reduce
  // below trivially always resolves to index 0 (`team[0]`, the locked lead).
  const {
    teams,
    matrix,
    opponents,
    pairingsFor,
    difficulty,
    trackLeads = false,
    executor,
    onLog,
    roleScores,
    opponentWeights = null,
  } = params;
  const cache = params.cache ?? createNullBattleCache();
  const threaded = !!executor;
  const startedAt = Date.now();
  let battleCount = 0;
  let cachedCount = 0;
  let errorCount = 0;

  const prepared = teams.map((keys) => {
    const members = keys.map((key) => {
      const b = matrix.builtMons[key];
      return {
        key,
        speciesId: b.speciesId,
        name: memberDisplayName(b),
        pokemon: b.pokemon,
        spec: b.spec,
        // Build-cost inputs, same fields src/teams/index.js passes through:
        // where this mon is today vs the level/form the sim actually plays.
        currentLevel: b.currentLevel ?? null,
        targetLevel: b.pokemon.level,
        shadow: !!b.spec?.shadow,
        purified: !!b.purified,
        lucky: !!b.lucky,
        evolution: b.evolution ?? null,
      };
    });
    const teamASpec = members.map((m) => m.spec);
    const oppPlans = opponents.map((opp, oppIndex) => ({ opp, oppIndex, pairings: pairingsFor(opp) }));
    return { members, teamASpec, oppPlans };
  });

  // ---- (1) plan: one cache key per pairing, in flat battle order ----------
  const planKeys = [];
  const pendingKeys = [];
  const pendingSpecs = [];
  const pendingBattles = []; // serial-mode inputs, parallel to pendingSpecs
  const queued = new Set();
  for (const { members, teamASpec, oppPlans } of prepared) {
    const teamA = members.map((m) => m.pokemon);
    for (const { opp, pairings } of oppPlans) {
      const teamBSpec = opp.members.map((m) => m.spec);
      const teamB = opp.members.map((m) => m.pokemon);
      for (const { leadA, leadB } of pairings) {
        const key = cache.keyFor(teamASpec, leadA, teamBSpec, leadB, difficulty);
        planKeys.push(key);
        if (cache.get(key) !== undefined || queued.has(key)) continue;
        queued.add(key);
        pendingKeys.push(key);
        pendingSpecs.push({ teamA: teamASpec, teamB: teamBSpec, leadA, leadB, difficulty });
        pendingBattles.push({ teamA, teamB, leadA, leadB });
      }
    }
  }

  // ---- (2) run only the distinct, uncached pairings -----------------------
  /** @type {Map<string, {ok:true, value:object}|{ok:false, message:string}>} */
  const outcomes = new Map();
  if (threaded) {
    let slots = [];
    if (pendingSpecs.length > 0) {
      try {
        slots = await executor.run(pendingSpecs);
      } catch (err) {
        onLog?.(`battle batch error (whole generation's ${pendingSpecs.length} battles skipped): ${err.message}`);
        slots = new Array(pendingSpecs.length).fill({ ok: false, error: { message: err.message } });
      }
    }
    slots.forEach((slot, i) => {
      if (slot.ok) {
        cache.set(pendingKeys[i], slot.value);
        outcomes.set(pendingKeys[i], { ok: true, value: slot.value });
      } else {
        outcomes.set(pendingKeys[i], { ok: false, message: slot.error.message });
      }
    });
  } else {
    pendingBattles.forEach((b, i) => {
      try {
        const value = battleTeams(ctx, { ...b, difficulty });
        cache.set(pendingKeys[i], value);
        outcomes.set(pendingKeys[i], { ok: true, value });
      } catch (err) {
        outcomes.set(pendingKeys[i], { ok: false, message: err.message });
      }
    });
  }

  /** Resolve one planned pairing: this batch's fresh result, or the memo. */
  function outcomeFor(key) {
    const fresh = outcomes.get(key);
    if (fresh) return fresh;
    const hit = cache.get(key);
    return hit === undefined ? { ok: false, message: 'no result produced for this pairing' } : { ok: true, value: hit, cached: true };
  }

  // ---- (3) accumulate --------------------------------------------------
  const opponentTally = opponents.map(() => ({ winPoints: 0, battles: 0 }));
  let cursor = 0;
  const results = [];
  for (let idx = 0; idx < prepared.length; idx++) {
    const { members, oppPlans } = prepared[idx];

    let winPoints = 0;
    let weightedWinPoints = 0;
    let weightedBattles = 0;
    let hpSum = 0;
    let battles = 0;
    let candidateErrors = 0;
    let exchangeWon = 0; // this candidate's lead fainted the opponent's lead first
    let exchangeLost = 0; // ...opponent's lead fainted this candidate's lead first
    let winsGivenExchangeWon = 0; // of the exchangeWon battles, how many did this candidate go on to WIN
    let winsGivenExchangeLost = 0; // ...of the exchangeLost battles, how many did it still win (a comeback)
    const perMeta = [];
    const leadWins = [0, 0, 0];
    const leadBattles = [0, 0, 0];
    const swapHpSum = [0, 0, 0];
    const swapHpCount = [0, 0, 0];

    for (const { opp, oppIndex, pairings } of oppPlans) {
      const oppWeight = opponentWeights ? (opponentWeights[oppIndex] ?? 1) : 1;
      let oppWinPoints = 0;
      let oppHpSum = 0;
      let oppBattles = 0;
      let oppWins = 0;
      let oppLosses = 0;
      let oppTies = 0;

      for (const { leadA, leadB } of pairings) {
        const outcome = outcomeFor(planKeys[cursor++]);
        if (!outcome.ok) {
          errorCount += 1;
          candidateErrors += 1;
          onLog?.(
            `battle error (skipped): team=[${members.map((m) => m.name).join('/')}] ` +
              `opponent="${opp.name}" leadA=${leadA} leadB=${leadB}: ${outcome.message}`
          );
          continue;
        }
        const r = outcome.value;
        if (outcome.cached) cachedCount += 1;
        else battleCount += 1;

        battles += 1;
        weightedBattles += oppWeight;
        oppBattles += 1;
        const margin = r.survivorsHp.a - r.survivorsHp.b;
        hpSum += margin;
        oppHpSum += margin;
        if (r.winner === 'a') {
          winPoints += 1;
          weightedWinPoints += oppWeight;
          oppWinPoints += 1;
          oppWins += 1;
        } else if (r.winner === 'tie') {
          winPoints += 0.5;
          weightedWinPoints += oppWeight * 0.5;
          oppWinPoints += 0.5;
          oppTies += 1;
        } else {
          oppLosses += 1;
        }

        // Unconditional (cheap -- reads r.summary, no new
        // battles), regardless of trackLeads -- the per-generation fitness
        // loop needs this and never sets trackLeads.
        const exchange = leadExchangeLoser(r.summary);
        if (exchange === 'a') {
          exchangeLost += 1;
          if (r.winner === 'a') winsGivenExchangeLost += 1; // comeback -- lost the exchange, won the game
        } else if (exchange === 'b') {
          exchangeWon += 1;
          if (r.winner === 'a') winsGivenExchangeWon += 1; // converted the exchange into the win
        }
        // 'simultaneous'/'none' -- excluded, not a decided exchange (see computeSnowballScore).

        if (trackLeads) {
          if (r.winner === 'a') leadWins[leadA] += 1;
          else if (r.winner === 'tie') leadWins[leadA] += 0.5;
          leadBattles[leadA] += 1;

          const orderedIndices = [leadA, ...LEADS.filter((i) => i !== leadA)];
          r.survivorsHp.aPerMon.forEach((hp, k) => {
            const memberIdx = orderedIndices[k];
            if (memberIdx === leadA) return;
            const maxHp = members[memberIdx].pokemon.stats.hp;
            swapHpSum[memberIdx] += maxHp > 0 ? hp / maxHp : 0;
            swapHpCount[memberIdx] += 1;
          });
        }
      }

      if (oppBattles > 0) {
        opponentTally[oppIndex].winPoints += oppWinPoints;
        opponentTally[oppIndex].battles += oppBattles;
        perMeta.push({
          metaTeamId: opp.id,
          name: opp.name,
          label: opp.label ?? null,
          species: teamBaseSpecies(opp),
          wins: oppWins,
          losses: oppLosses,
          ties: oppTies,
          winRate: oppWinPoints / oppBattles,
          avgHpMargin: oppHpSum / oppBattles,
        });
      }
    }

    // With no opponentWeights every oppWeight is 1 and this IS winPoints/battles.
    const winRate = weightedBattles > 0 ? weightedWinPoints / weightedBattles : 0;
    const avgHpMargin = battles > 0 ? hpSum / battles : 0;
    const snowballScore = computeSnowballScore(exchangeWon, exchangeLost, winRate);
    const closerScore = computeCloserScore(members, roleScores);
    const entry = {
      members: members.map((m) => ({ key: m.key, speciesId: m.speciesId, name: m.name, ...reportMemberDetail(m) })),
      buildCost: teamBuildCost(members),
      winRate,
      avgHpMargin,
      battles,
      errors: candidateErrors,
      // Battle-reality fitness components,
      // always computed (cheap) regardless of --fitness so the report can
      // surface them even in classic mode.
      exchangeWon,
      exchangeLost,
      snowballScore,
      closerScore,
      blendFitness: computeBlendFitness({ winRate, snowballScore, closerScore }),
      // Report-facing metrics -- see the
      // comment above computeSnowballIndex for how these differ from
      // snowballScore/closerScore above. Always computed too (cheap).
      snowballIndex: computeSnowballIndex(winsGivenExchangeWon, exchangeWon),
      comebackIndex: computeComebackIndex(winsGivenExchangeLost, exchangeLost),
      designatedCloser: pickDesignatedCloser(members, roleScores),
    };

    if (trackLeads) {
      const leadStats = members.map((m, i) => ({
        index: i,
        key: m.key,
        speciesId: m.speciesId,
        name: m.name,
        winRate: leadBattles[i] > 0 ? leadWins[i] / leadBattles[i] : 0,
      }));
      entry.bestLead = leadStats.reduce((best, l) => (!best || l.winRate > best.winRate ? l : best), null);
      const swapStats = members
        .map((m, i) => ({
          index: i,
          key: m.key,
          speciesId: m.speciesId,
          name: m.name,
          avgHpPct: swapHpCount[i] > 0 ? swapHpSum[i] / swapHpCount[i] : 0,
        }))
        .filter((s) => s.index !== entry.bestLead.index);
      entry.safeSwap = swapStats.length
        ? swapStats.reduce((best, s) => (!best || s.avgHpPct > best.avgHpPct ? s : best), null)
        : null;
      entry.perMeta = perMeta;
      entry.hardestOpponents = [...perMeta]
        .sort((a, b) => a.winRate - b.winRate || a.avgHpMargin - b.avgHpMargin)
        .slice(0, 5);
      entry.coreBreakExposure = computeCoreBreakExposure(perMeta);
    }

    results.push(entry); // positional -- NOT sorted, unlike tournament.mjs's runFunnelStage
  }

  return {
    results,
    opponentTally,
    battleCount,
    cachedCount,
    errorCount,
    elapsedMs: Date.now() - startedAt,
    startedAt,
    finishedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Report + DONE-marker rendering.
// ---------------------------------------------------------------------------

function renderEvolveReport(result) {
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
  out.push(
    `Win% is a weighted mean over one battle against each of the ${eo.total} elites-pass opponents ` +
      `(${eo.curated} curated + ${eo.evolved} evolved), both sides at their designated leads: ladder-observed meta ` +
      'teams count in full, "recommended" curated teams at half weight, off-meta curated at a quarter, evolved ' +
      `opponents at an eighth. **Score** (the sort key) = ${rk.weights.elitePass} x that win% + ${rk.weights.recent} x ` +
      `the team's mean win% over the last ${rk.recentWindow} generation(s). Absolute win% carries pvpoke emulate ` +
      "mode's small constant team-A offset; the ranking is relative, so it cancels."
  );
  out.push('');
  if (elites.length === 0) {
    out.push('_No elite teams were produced._');
    out.push('');
  } else {
    out.push('| Rank | Team (Lead / Back / Back) | Score | Elites-pass win% | Last-gens win% | Core breakers |');
    out.push('| --- | --- | ---: | ---: | ---: | --- |');
    elites.forEach((t, i) => {
      const breakers = t.coreBreakExposure?.length ? t.coreBreakExposure.map((s) => s.name).join(', ') : 'none';
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
    out.push(
      `- **Lead:** ${t.bestLead.name}` +
        (t.safeSwap ? ` -- **safest first switch:** ${t.safeSwap.name} (avg ${pct(t.safeSwap.avgHpPct)} HP remaining when switched in)` : '')
    );
    out.push(`- **Core breakers:** ${t.coreBreakExposure?.length ? t.coreBreakExposure.map((s) => s.name).join(', ') : 'none'}`);
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

  out.push('## Run facts');
  out.push('');
  out.push(`- ${generationRecords.length} generation(s) of a ${config.generations} cap -- ${stopReason}`);
  out.push(
    `- ${totalBattles} battles simulated (+${totalCached} served from the memo cache, ${totalErrors} errors), ` +
      `${formatDuration(result.totalElapsedMs)} total, ${threadsLabel}`
  );
  out.push(
    `- seed \`${config.seed}\`, cp=${config.cp}, population ${config.population} -> ` +
      `${Math.round(config.population * config.populationFinalRatio)}, opponents ${config.opponentsPerGen} -> ` +
      `${opponentsAt(config.generations - 1, config)}, pool=${config.pool}, curated-ratio=${config.curatedRatio}, ` +
      `fitness=${config.fitness}` +
      (config.evolutions === false ? ', evolutions=off' : '') +
      (config.fixedOpponents ? ', fixed-opponents' : '') +
      (config.banSpecies.length ? `, ban=${config.banSpecies.join(',')}` : '')
  );
  if (config.deathRate !== undefined || config.mutationFloor !== undefined || config.mutationCeil !== undefined || config.immigrantFraction !== undefined || config.convergence !== undefined) {
    const ga = [];
    if (config.deathRate !== undefined) ga.push(`death-rate=${config.deathRate}`);
    if (config.mutationFloor !== undefined) ga.push(`mutation-floor=${config.mutationFloor}`);
    if (config.mutationCeil !== undefined) ga.push(`mutation-ceil=${config.mutationCeil}`);
    if (config.immigrantFraction !== undefined) ga.push(`immigrant-fraction=${config.immigrantFraction}`);
    if (config.convergence !== undefined) ga.push(`convergence=0-churn top-${config.convergence.topN} across ${config.convergence.window} generations`);
    out.push(`- GA overrides: ${ga.join(', ')}`);
  }
  if (config.excludeSpecies.length) out.push(`- excluded species: ${config.excludeSpecies.join(', ')}`);
  if (config.banSpecies.length) out.push(`- banned species (format-wide cup rule, candidates and opponents): ${config.banSpecies.join(', ')}`);
  for (const w of importWarnings) out.push(`- import warning: ${w}`);
  out.push('');

  return out.join('\n');
}

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
 * level/CP the simulator actually battled it at. Mirrors formatBuildCost's
 * wording/caveats but per-member and CP-aware (formatBuildCost only totals
 * Stardust/Candy for the whole team). Falls back to formatBuildCost's own
 * "no level on file" phrasing when the CSV stated none.
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
  return `${fromPart} &rarr; ${evolveNote}power up to <b>L${lvl(m.targetLevel)}, CP ${m.targetCp}</b>`;
}

/**
 * One team's detail card: roster table (Pokemon / moveset / build), score
 * line, safest-switch fact, core-breaker exposure and hardest-opponents
 * table -- the same facts renderEvolveReport's "Team detail" section prints
 * per elite, styled as a card. Ranks 1-3 additionally get the medal border
 * color and a medal-emoji heading (the "podium" cards); every other elite
 * gets the same card, numbered.
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
  if (t.safeSwap) {
    out.push(
      `<p class="factline">Safest first switch: <b>${escapeHtml(t.safeSwap.name)}</b> (avg ${pct(t.safeSwap.avgHpPct)} HP remaining when switched in).</p>`
    );
  }
  out.push(
    `<p class="breakers">Watch for: <b>${t.coreBreakExposure?.length ? t.coreBreakExposure.map((s) => escapeHtml(s.name)).join(', ') : 'nothing so far'}</b>` +
      ` — the species this team wins under ${Math.round(CORE_BREAK_WIN_RATE_MAX * 100)}% against when they show up.</p>`
  );
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
  out.push(`<style>
  :root {
    color-scheme: dark;
    --stage: #0A0D12; --stage-2: #14181F; --stage-3: #1C212B;
    --ink: #F5F2E8; --muted: #93A0AF; --line: rgba(255,255,255,0.09);
    --gold: #F7C948; --gold-hi: #FFE79A; --gold-ink: #2B1D02;
    --silver: #E2E6EE; --silver-hi: #FFFFFF; --silver-ink: #1B1F28;
    --bronze: #E8935A; --bronze-hi: #FFC28F; --bronze-ink: #2B1704;
    --accent: ${accents.accent}; --accent-hi: ${accents.accentHi};
    --shadow: 0 24px 60px rgba(0,0,0,0.55), 0 2px 10px rgba(0,0,0,0.45);
    --display: "Arial Black", "Arial Bold", "Helvetica Neue", Impact, "Segoe UI", sans-serif;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, "SF Mono", "Cascadia Mono", "Consolas", "Courier New", monospace;
  }
  /* One committed look (a night stadium stage) rather than a light/dark
     swap -- the podium spotlight concept doesn't have a coherent daylight
     reading, so every background/color below is explicit and fixed instead
     of branching on prefers-color-scheme. */
  * { box-sizing: border-box; }
  body { background: var(--stage); color: var(--ink); margin: 0;
    font-family: var(--sans); font-size: 16px; line-height: 1.6; }
  .wrap { max-width: 60rem; margin: 0 auto; padding: 0 1.25rem 4rem; }

  /* ---------- stage: the podium hero, full-bleed ---------- */
  .stage { position: relative; overflow: hidden; padding: 4.5rem 1.25rem 4rem; text-align: center;
    background: radial-gradient(58% 60% at 50% 18%, rgba(255,225,160,0.16), transparent 68%), var(--stage); }
  .stage::before { content: ""; position: absolute; inset: 0; pointer-events: none;
    background: radial-gradient(120% 85% at 50% -15%, transparent 45%, rgba(0,0,0,0.6) 100%); }
  .confetti-field { position: absolute; inset: 0; pointer-events: none; z-index: 0; }
  .confetti-field i { position: absolute; width: 0.5rem; height: 1.1rem; opacity: 0.55; border-radius: 1px; }
  .confetti-field i:nth-child(1) { top: 8%; left: 9%; background: var(--gold); transform: rotate(22deg); }
  .confetti-field i:nth-child(2) { top: 22%; left: 18%; background: var(--accent); transform: rotate(-12deg) scale(0.8); }
  .confetti-field i:nth-child(3) { top: 6%; left: 27%; background: var(--bronze); transform: rotate(58deg) scale(0.7); }
  .confetti-field i:nth-child(4) { top: 30%; left: 6%; background: var(--silver); transform: rotate(-30deg) scale(0.9); }
  .confetti-field i:nth-child(5) { top: 14%; right: 11%; background: var(--accent); transform: rotate(35deg); }
  .confetti-field i:nth-child(6) { top: 28%; right: 21%; background: var(--gold); transform: rotate(-18deg) scale(0.75); }
  .confetti-field i:nth-child(7) { top: 4%; right: 30%; background: var(--silver); transform: rotate(12deg) scale(0.85); }
  .confetti-field i:nth-child(8) { top: 36%; right: 6%; background: var(--bronze); transform: rotate(-48deg) scale(0.7); }
  .confetti-field i:nth-child(9) { top: 46%; left: 14%; background: var(--gold-hi); transform: rotate(8deg) scale(0.6); opacity: 0.35; }
  .confetti-field i:nth-child(10) { top: 44%; right: 16%; background: var(--accent-hi); transform: rotate(-20deg) scale(0.65); opacity: 0.35; }
  .stage > * { position: relative; z-index: 1; }
  .eyebrow { display: flex; align-items: center; justify-content: center; gap: 0.55rem;
    font-family: var(--mono); font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase;
    font-size: 0.78rem; color: var(--muted); margin: 0 0 1rem; }
  .eyebrow .dot { width: 0.5em; height: 0.5em; border-radius: 50%; background: var(--accent);
    box-shadow: 0 0 0.6em var(--accent); flex: none; }
  h1 { font-family: var(--display); font-weight: 900; font-size: clamp(2.8rem, 8vw, 5rem);
    line-height: 0.96; margin: 0 0 0.65rem; letter-spacing: -0.01em; text-transform: uppercase;
    background: linear-gradient(180deg, #FFFFFF, #CBD2DE 70%, #98A2B3);
    -webkit-background-clip: text; background-clip: text; color: transparent; }
  .sub { color: var(--muted); max-width: 38rem; margin: 0 auto 3.25rem; font-size: 1.02rem; }
  .sub strong { color: var(--ink); font-variant-numeric: tabular-nums; font-weight: 600; }

  .podium { display: grid; gap: clamp(0.6rem, 2vw, 1.5rem); align-items: end; margin: 0 auto 1.5rem;
    max-width: 52rem; }
  .step { position: relative; text-align: center; padding-top: 2.75rem; }
  .step .rank-watermark { position: absolute; top: -1.3rem; left: 50%; transform: translateX(-50%);
    font-family: var(--display); font-weight: 900; font-size: 7rem; line-height: 1; z-index: 0;
    color: transparent; -webkit-text-stroke: 1.5px rgba(255,255,255,0.08); user-select: none; }
  .p1 .rank-watermark { font-size: 9.5rem; top: -2rem; }
  .step > * { position: relative; z-index: 1; }
  .team { font-family: var(--display); font-weight: 900; text-transform: uppercase;
    font-size: clamp(1rem, 2.5vw, 1.4rem); line-height: 1.18; margin-bottom: 0.85rem; letter-spacing: 0.01em; }
  .team .mon { display: block; color: var(--ink); }
  .team .lead-tag { display: inline-block; vertical-align: 0.15em; margin-left: 0.35rem; font-family: var(--mono);
    font-size: 0.5em; font-weight: 700; letter-spacing: 0.1em; color: var(--stage); background: var(--accent);
    border-radius: 2px; padding: 0.1em 0.4em; }

  .medal-badge { width: 3.4rem; height: 3.4rem; margin: 0 auto 0.85rem; display: flex; align-items: center;
    justify-content: center; font-family: var(--mono); font-weight: 800; font-size: 1.4rem; border-radius: 50%;
    box-shadow: 0 6px 18px rgba(0,0,0,0.5), inset 0 2px 3px rgba(255,255,255,0.55), inset 0 -3px 5px rgba(0,0,0,0.25); }
  .p1 .medal-badge { background: radial-gradient(65% 65% at 35% 28%, var(--gold-hi), var(--gold) 70%); color: var(--gold-ink);
    box-shadow: 0 8px 26px rgba(247,201,72,0.45), inset 0 2px 3px rgba(255,255,255,0.6), inset 0 -3px 5px rgba(0,0,0,0.25); }
  .p2 .medal-badge { background: radial-gradient(65% 65% at 35% 28%, var(--silver-hi), var(--silver) 70%); color: var(--silver-ink);
    box-shadow: 0 8px 26px rgba(226,230,238,0.28), inset 0 2px 3px rgba(255,255,255,0.7), inset 0 -3px 5px rgba(0,0,0,0.2); }
  .p3 .medal-badge { background: radial-gradient(65% 65% at 35% 28%, var(--bronze-hi), var(--bronze) 70%); color: var(--bronze-ink);
    box-shadow: 0 8px 26px rgba(232,147,90,0.4), inset 0 2px 3px rgba(255,255,255,0.5), inset 0 -3px 5px rgba(0,0,0,0.25); }

  .block { border-radius: 0.35rem 0.35rem 0 0; display: flex; flex-direction: column; align-items: center;
    justify-content: flex-start; padding-top: 0.9rem; position: relative; overflow: hidden; }
  .block::after { content: ""; position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(115deg, transparent 30%, rgba(255,255,255,0.35) 46%, transparent 62%); }
  .block > * { position: relative; }
  .block .score { font-family: var(--mono); font-weight: 800; font-size: clamp(1.8rem, 4.4vw, 2.6rem); line-height: 1;
    font-variant-numeric: tabular-nums; }
  .block .score-label { font-size: 0.68rem; letter-spacing: 0.18em; text-transform: uppercase; opacity: 0.75; font-weight: 700; margin-top: 0.15rem; }
  .p1 .block { height: 11.5rem; background: linear-gradient(180deg, var(--gold-hi), var(--gold)); color: var(--gold-ink);
    box-shadow: 0 14px 34px -8px rgba(247,201,72,0.55); }
  .p2 .block { height: 8.25rem; background: linear-gradient(180deg, var(--silver-hi), var(--silver)); color: var(--silver-ink);
    box-shadow: 0 14px 34px -8px rgba(226,230,238,0.35); }
  .p3 .block { height: 6.75rem; background: linear-gradient(180deg, var(--bronze-hi), var(--bronze)); color: var(--bronze-ink);
    box-shadow: 0 14px 34px -8px rgba(232,147,90,0.5); }
  .podium-note { text-align: center; color: var(--muted); font-size: 0.9rem; max-width: 40rem; margin: 0 auto; padding-bottom: 3.5rem; }

  /* ---------- everything below the stage: quieter, contained ---------- */
  section { margin-top: 3rem; }
  h2 { font-family: var(--display); font-weight: 900; text-transform: uppercase; font-size: 1.3rem;
    letter-spacing: 0.03em; margin: 0 0 1.15rem; display: flex; align-items: baseline; gap: 0.85rem; color: var(--ink); }
  h2 .rule { flex: 1; height: 2px; transform: translateY(-0.25rem);
    background: linear-gradient(90deg, var(--accent), transparent); }
  .card { background: linear-gradient(180deg, var(--stage-3), var(--stage-2)); border: 1px solid var(--line);
    border-radius: 0.6rem; box-shadow: var(--shadow); padding: 1.4rem 1.5rem; margin-bottom: 1.35rem; }
  .card.gold { box-shadow: var(--shadow), inset 3px 0 0 var(--gold); }
  .card.silver { box-shadow: var(--shadow), inset 3px 0 0 var(--silver); }
  .card.bronze { box-shadow: var(--shadow), inset 3px 0 0 var(--bronze); }
  .scoreline { color: var(--muted); font-size: 0.92rem; margin: 0 0 1rem; }
  .scoreline b { color: var(--ink); font-family: var(--mono); font-variant-numeric: tabular-nums; }
  table { border-collapse: collapse; width: 100%; font-size: 0.95rem; }
  .roster-wrap, .table-wrap { overflow-x: auto; margin: 0.9rem 0; }
  th { text-align: left; font-family: var(--mono); font-size: 0.68rem; letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--muted); font-weight: 600; padding: 0.5rem 0.9rem 0.5rem 0; }
  td { padding: 0.65rem 0.9rem 0.65rem 0; vertical-align: top; border-top: 1px solid var(--line); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; padding-right: 0; }
  td.num, .scoreline b, .block .score { font-family: var(--mono); }
  .movestr { color: var(--muted); } .movestr b { color: var(--ink); font-weight: 600; }
  .build { font-size: 0.88rem; color: var(--muted); font-variant-numeric: tabular-nums; } .build b { color: var(--ink); }
  .factline, .breakers { margin: 0.6rem 0 0; font-size: 0.92rem; color: var(--muted); }
  .factline b, .breakers b { color: var(--ink); }
  .race-embed { background: linear-gradient(180deg, var(--stage-3), var(--stage-2)); border: 1px solid var(--line);
    border-radius: 0.6rem; box-shadow: var(--shadow); padding: 1.15rem 1.3rem; margin-bottom: 1.1rem; }
  .race-embed .controls { display: flex; gap: 0.75rem; align-items: center; margin: 0 0 0.85rem; }
  .race-embed button { font: 700 0.82rem var(--mono); letter-spacing: 0.04em; text-transform: uppercase; color: var(--stage);
    background: var(--accent); border: 0; border-radius: 999px; padding: 0.5rem 1.25rem; min-width: 5.6rem; cursor: pointer;
    box-shadow: 0 0 0.9em -0.1em var(--accent); }
  .race-embed button:focus-visible, .race-embed input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .race-embed input[type=range] { flex: 1; accent-color: var(--accent); margin: 0; }
  .race-embed #genlabel { font-family: var(--mono); font-variant-numeric: tabular-nums; color: var(--muted);
    font-size: 0.9rem; white-space: nowrap; }
  .race-embed #picked { min-height: 1.5em; margin: 0 0 0.6rem; font-size: 0.92rem; color: var(--muted); }
  .race-embed .chart-scroll { overflow-x: auto; }
  .race-embed svg { display: block; width: 100%; height: auto; min-width: 640px; }
  .race-embed .grid { stroke: var(--line); }
  .race-embed text { fill: var(--muted); font-family: var(--mono); font-size: 12px; }
  .race-embed .legend { display: grid; grid-template-columns: repeat(auto-fill, minmax(15.5rem, 1fr));
    gap: 0.25rem 1rem; list-style: none; padding: 0; margin: 0.9rem 0 0; font-size: 0.85rem; font-family: var(--mono); }
  .race-embed .legend li { display: flex; align-items: center; gap: 0.5rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .race-embed .legend .swatch { width: 1.05em; height: 0.32em; border-radius: 0.18em; flex: none; }
  .standings td:first-child { font-family: var(--mono); font-variant-numeric: tabular-nums; color: var(--muted); }
  .standings tr:nth-child(even) td { background: rgba(255,255,255,0.02); }
  .medal-dot { display: inline-block; width: 0.85em; height: 0.85em; margin-right: 0.5em; vertical-align: -0.1em;
    border-radius: 50%; box-shadow: inset 0 1px 1px rgba(255,255,255,0.6), inset 0 -1px 2px rgba(0,0,0,0.3); }
  ul.notes { padding-left: 0; margin: 0; list-style: none; }
  ul.notes li { margin-bottom: 0.65rem; padding-left: 1.1rem; border-left: 2px solid var(--accent); opacity: 0.92; }
  ul.notes b { font-weight: 700; color: var(--ink); }
  code { font-family: var(--mono); font-size: 0.85em; background: var(--stage-3);
    border: 1px solid var(--line); border-radius: 3px; padding: 0.06em 0.4em; color: var(--ink); }
  a { color: var(--accent); }
  .foot { margin-top: 3.5rem; color: var(--muted); font-size: 0.83rem; font-family: var(--mono);
    border-top: 1px solid var(--line); padding-top: 1.25rem; }
  @media (max-width: 560px) { .card { padding: 1.1rem; } .step .rank-watermark { font-size: 4.5rem; } .p1 .rank-watermark { font-size: 6rem; } }
  @media (prefers-reduced-motion: no-preference) {
    .stage .eyebrow, .stage h1, .stage .sub, .stage .podium-note { animation: rise 0.7s cubic-bezier(0.2, 0.7, 0.2, 1) backwards; }
    .stage h1 { animation-delay: 0.1s; }
    .step { animation: rise 0.8s cubic-bezier(0.2, 0.7, 0.2, 1) backwards; }
    .p1 { animation-delay: 0.25s; } .p2 { animation-delay: 0.45s; } .p3 { animation-delay: 0.6s; }
    .stage .sub { animation-delay: 0.8s; } .stage .podium-note { animation-delay: 0.95s; }
    @keyframes rise { from { transform: translateY(26px); opacity: 0; } to { transform: none; opacity: 1; } }
  }
</style>`);
  out.push('</head>');
  out.push('<body>');
  out.push('<header class="stage">');
  out.push('<div class="confetti-field" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>');

  out.push(`<p class="eyebrow"><span class="dot"></span>${escapeHtml(league.name)} · CP ${config.cp} · ${collectionBase}</p>`);
  out.push('<h1>The Podium</h1>');
  // The sim-description line renders BELOW the podium (Jaxon's requested
  // order: medals first, methodology after).
  const subHtml =
    `<p class="sub">${generationRecords.length} generation${generationRecords.length === 1 ? '' : 's'} of full 3v3 ` +
    `battle simulation${result.collectionMonCount ? ` over your ${result.collectionMonCount}-mon collection` : ''} ` +
    `— <strong>${num(totalBattles)} battles fought</strong> against ${eo.total} elites-pass opponents ` +
    `(${eo.curated} curated + ${eo.evolved} evolved), plus everything the earlier generations battled through. ` +
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
      out.push(`<span class="rank-watermark" aria-hidden="true">${rank}</span>`);
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
  out.push('</header>');
  out.push('<div class="wrap">');

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
  out.push('<h2>Run notes<span class="rule"></span></h2>');
  out.push('<ul class="notes">');
  out.push(`<li><b>${generationRecords.length} generation(s)</b> of a ${config.generations} cap — ${escapeHtml(stopReason)}.</li>`);
  out.push(
    `<li><b>${num(totalBattles)} battles</b> simulated (+${num(totalCached)} served from the memo cache, ${totalErrors} errors), ` +
      `${escapeHtml(formatDuration(result.totalElapsedMs))} total, ${escapeHtml(threadsLabel)}. Population ${config.population} ` +
      `→ ${Math.round(config.population * config.populationFinalRatio)} while the opponent pool grew ${config.opponentsPerGen} ` +
      `→ ${opponentsAt(config.generations - 1, config)}.</li>`
  );
  out.push(
    `<li><b>Opponent quality is weighted, not flat.</b> The final elites pass ran each finalist against all ${eo.total} ` +
      'opponents: real ladder-observed teams count in full, "recommended" curated teams at half weight, off-meta curated ' +
      'at a quarter, and the GA\'s own evolved opponents at an eighth.</li>'
  );
  out.push(
    `<li><b>Setup:</b> seed <code>${escapeHtml(config.seed)}</code>, cp=${config.cp}, pool=${config.pool}, ` +
      `curated-ratio=${config.curatedRatio}, fitness=${escapeHtml(config.fitness)}` +
      (config.evolutions === false ? ', evolutions=off' : '') +
      (config.fixedOpponents ? ', fixed-opponents' : '') +
      '.</li>'
  );
  if (config.deathRate !== undefined || config.mutationFloor !== undefined || config.mutationCeil !== undefined || config.immigrantFraction !== undefined || config.convergence !== undefined) {
    const ga = [];
    if (config.deathRate !== undefined) ga.push(`death-rate=${config.deathRate}`);
    if (config.mutationFloor !== undefined) ga.push(`mutation-floor=${config.mutationFloor}`);
    if (config.mutationCeil !== undefined) ga.push(`mutation-ceil=${config.mutationCeil}`);
    if (config.immigrantFraction !== undefined) ga.push(`immigrant-fraction=${config.immigrantFraction}`);
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
      `&middot; ${collectionBase}${result.collectionMonCount ? ` (${result.collectionMonCount} mons${result.scoredMonCount && result.scoredMonCount !== result.collectionMonCount ? `, ${result.scoredMonCount} scored with evolutions` : ''})` : ''} ` +
      `&middot; simulated ${escapeHtml(new Date().toISOString().slice(0, 10))} with pvpoke's own battle engine &middot; ` +
      `full details in <code>${escapeHtml(result.reportPath ?? 'my-teams-evolve.md')}</code></p>`
  );

  out.push('</div></body>');
  out.push('</html>');

  return out.join('\n');
}

function renderDoneMarker(result) {
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

// ---------------------------------------------------------------------------
// Main pipeline.
// ---------------------------------------------------------------------------

/**
 * Run the full evolutionary search and write per-generation checkpoints, the
 * rolling analytics file, the final report, and the DONE marker. Exported so
 * a test could drive it in-process (the dedicated evolve test was folded into test/e2e.test.js; same pattern as
 * scripts/tournament.mjs's runTournament / src/cli.js's runPipeline).
 *
 * @param {string} csvPath
 * @param {{
 *   scoreMeta?:number, pool?:number, seed?:number|string, cp?:number,
 *   curatedRatio?:number, excludeSpecies?:string[], difficulty?:number,
 *   banSpecies?:string[], - format-wide ban ("no Mimikyu, no Cramorant"):
 *     matched by BASE species id (src/meta/sampleTeams.js's baseIdOf), so a
 *     shadow variant is caught too (NOT a distinct battle/regional form --
 *     see the `--ban` helpers' own comment above). Unlike excludeSpecies
 *     (candidates only), this also drops whole curated teams and
 *     moveset-pool entries containing a banned species on the opponent side.
 *     Always in the checkpoint fingerprint.
 *   population?:number, opponentsPerGen?:number, generations?:number,
 *   fixedOpponents?:boolean, eliteCount?:number,
 *   deathRate?:number, mutationFloor?:number, mutationCeil?:number,
 *   immigrantFraction?:number, - candidate-side GA rate overrides, forwarded
 *     to nextGeneration; in the checkpoint fingerprint ONLY when set.
 *   convWindow?:number, convTopN?:number, - convergence window / top-set-size
 *     overrides for hasConverged; same only-when-set fingerprint rule.
 *   populationFinalRatio?:number, - candidate population at the last
 *     generation, as a fraction of `population` (see populationAt).
 *   opponentMetaPool?:number, - top-N species cap on the composed half of the
 *     opponent pool (see src/meta/sampleTeams.js).
 *   battleCache?:boolean, - memoize identical pairings (default true).
 *     NOT part of the checkpoint fingerprint (pure performance knob).
 *   deadlineMinutes?:number, - simple stop-before-next-generation budget;
 *     NOT part of the checkpoint config fingerprint (see buildRunConfig).
 *   threads?:number, - when set, ONE persistent
 *     src/engine/parallel.js createExecutor() pool is booted for the WHOLE
 *     run and reused across every generation AND the final elites pass.
 *     Omitted/falsy keeps the serial battleTeams loop. NOT part of the
 *     checkpoint fingerprint (pure performance knob).
 *   outDir?:string, out?:string, - out = Markdown report path.
 *   html?:string, noHtml?:boolean, - HTML report path (default
 *     <outDir>/my-teams-evolve.html) and an opt-out (mirrors src/cli.js's
 *     --html/--no-html).
 *   onProgress?:(p:{generation:number, completed:number, total:number, startedAt:number})=>void,
 *   onLog?:(msg:string)=>void,
 * }} [opts]
 * @returns {Promise<object>} the full run result; also written to disk.
 */
export async function runEvolution(csvPath, opts = {}) {
  if (opts.fitness !== undefined && !FITNESS_MODES.includes(opts.fitness)) {
    throw new Error(`evolve: opts.fitness must be one of ${FITNESS_MODES.join('|')}, got "${opts.fitness}"`);
  }
  const config = buildRunConfig(csvPath, opts);
  const outDir = opts.outDir ?? DEFAULTS.outDir;
  const reportPath = opts.out ?? path.join(outDir, 'my-teams-evolve.md');
  const writeHtml = opts.noHtml !== true;
  const htmlPath = opts.html ?? path.join(outDir, DEFAULTS.html);
  mkdirSync(outDir, { recursive: true });

  const log = (msg) => opts.onLog?.(msg);
  const difficulty = config.difficulty ?? undefined;
  const threads = opts.threads;
  const deadlineMs = typeof opts.deadlineMinutes === 'number' ? opts.deadlineMinutes * 60000 : null;

  log(`evolve: starting (collection=${config.csvPath}, out-dir=${outDir}, report=${reportPath})`);

  const { mons: importedMons, warnings: importWarnings } = importCollection(csvPath);
  const ctx = await initEngine({ cp: config.cp });
  const league = leagueForCp(config.cp);
  // Same expansion src/cli.js does: each mon also competes as anything it can
  // evolve into, so the GA can pick a form you don't own yet. Part of the run
  // config below, so flipping it starts a new checkpoint rather than resuming
  // one whose population was bred from a different candidate pool.
  const expanded = config.evolutions
    ? expandEvolutions(ctx, importedMons)
    : { mons: importedMons, warnings: [] };
  const mons = expanded.mons;
  const matrix = scoreCollection(ctx, mons, { metaLimit: config.scoreMeta });
  const deduped = dedupeBestPerSpecies(matrix);
  const weights = loadUsageWeights(ctx);
  const banBaseIds = new Set(config.banSpecies);
  // --ban is format-wide: on the candidate side it is folded into
  // excludeSpecies (expanded from base ids to every concrete speciesId the
  // collection actually has, so a shadow variant can't sneak through
  // --exclude's exact-match check) BEFORE the sampling pool is built, so a
  // banned species never enters `pool` in the first place.
  const candidateExcludeSpecies = banBaseIds.size
    ? [...new Set([...config.excludeSpecies, ...expandBanToCandidateSpeciesIds(deduped.builtMons, banBaseIds)])]
    : config.excludeSpecies;
  const pool = buildSamplingPool(deduped, config.pool, candidateExcludeSpecies);
  const roleScores = loadRoleScores(ctx); // lead/closer/switch priors, cheap local-file read
  // The opponent side's two fixed inputs, both loaded once for the whole run:
  // every curated team for this CP cap (the pool the opponent GA's protected
  // entries are drawn from, and the opponent set the final elites pass uses in
  // full), and the meta-capped species pool composed teams are built out of.
  // Both are filtered by --ban here, once, so every downstream use (the
  // per-generation opponent pool AND the final elites pass for curatedPool;
  // initOpponentPool/nextOpponentPool and their mutation/immigrant draws for
  // movesetPool) sees an already-clean pool -- see the --ban helpers above.
  const curatedPool = filterBannedCuratedTeams(loadMetaTeams(ctx), banBaseIds);
  const movesetPool = filterBannedMovesetPool(
    loadMovesetPool(ctx, { metaPoolSize: config.opponentMetaPool }),
    banBaseIds
  );
  const battleCache = opts.battleCache === false ? createNullBattleCache() : createBattleCache(BATTLE_CACHE_MAX_ENTRIES);
  log(
    `evolve: shared setup done -- ${matrix.mons.length} mons scored, sampling pool of ${pool.length} species, ` +
      `${curatedPool.length} curated opponent teams, opponent meta pool of ${movesetPool.length} species, league=${league.name}`
  );

  const threaded = typeof threads === 'number' && threads > 0;
  const executor = threaded ? createExecutor({ threads, vendorRoot: ctx.vendorRoot, continueOnError: true }) : null;

  try {
    return await runLoop();
  } finally {
    if (executor) await executor.close();
  }

  async function runLoop() {
    // ---- Resume scan: generation 0, 1, 2, ... while each checkpoint's config matches. ----
    let generation = 0;
    let population = null;
    let runStartedAtMs = null;
    let opponentPool = null; // live (rehydrated or freshly built) opponent entries for the NEXT generation
    const history = []; // [{population, fitness}], oldest-first -- for hasConverged
    const generationRecords = []; // full per-generation records for the report

    while (true) {
      const cp = readCheckpoint(outDir, generation);
      if (!cp || !configsMatch(cp.config, config)) break;
      if (cp.formatVersion !== CHECKPOINT_FORMAT_VERSION) {
        throw new Error(
          `evolve: ${checkpointPath(outDir, generation)} is checkpoint format ` +
            `${cp.formatVersion ?? '(unversioned, pre-lead-lock)'} but this code expects format ` +
            `${CHECKPOINT_FORMAT_VERSION} (evolving opponent pool + per-signature win-rate history). ` +
            'Old-format checkpoints cannot be resumed -- they carry no opponent pool to continue from, ' +
            'and (pre-v2) their population entries have no defined lead-slot convention. ' +
            'Delete out/evolve-gen*.json, out/evolve-generations.json, and ' +
            'out/evolve-DONE, then re-run from scratch.'
        );
      }
      history.push({ population: cp.population, fitness: cp.fitness });
      generationRecords.push({ ...cp, resumed: true });
      if (generation === 0) runStartedAtMs = new Date(cp.runStartedAt).getTime();
      population = cp.nextPopulation;
      opponentPool = cp.nextOpponentPool ? rehydrateOpponentPool(ctx, cp.nextOpponentPool, curatedPool, log) : null;
      generation += 1;
    }

    if (generation > 0) {
      log(`evolve: resuming -- ${generation} generation(s) already complete (config matches)`);
    } else {
      runStartedAtMs = Date.now();
      population = initPopulation({
        matrix: deduped,
        pool,
        weights,
        count: populationAt(0, config),
        seed: `${config.seed}-gen0`,
        excludeSpecies: candidateExcludeSpecies,
      });
      opponentPool = initOpponentPool(ctx, {
        size: opponentsAt(0, config),
        weights,
        curated: curatedPool,
        curatedRatio: config.curatedRatio,
        roleScores,
        movesetPool,
        seed: `${config.seed}-opponents-gen0`,
      });
      log(
        `evolve: starting fresh -- population ${population.length} (requested ${config.population}), ` +
          `opponent pool ${opponentPool.length} ` +
          `(${opponentPool.filter(isProtectedOpponent).length} curated), seed ${config.seed}`
      );
    }

    let stopReason = null;
    let lastEvaluated = generationRecords.length ? generationRecords[generationRecords.length - 1] : null;
    // Live opponent pool + fitness for the generation `lastEvaluated` describes
    // -- the final elites pass needs the strongest EVOLVED opponents, and
    // rebuilding them from the checkpoint is only necessary on a run that
    // resumed straight past its last generation.
    let lastOpponentPool = null;
    let lastOpponentFitness = null;

    while (generation < config.generations) {
      if (deadlineMs !== null && Date.now() - runStartedAtMs >= deadlineMs) {
        stopReason = `deadline reached (${opts.deadlineMinutes} minutes) before generation ${generation}`;
        log(`evolve: ${stopReason}`);
        break;
      }
      if (population.length === 0) {
        stopReason = `population exhausted (sampling pool too small) before generation ${generation}`;
        log(`evolve: ${stopReason}`);
        break;
      }

      const opponents = opponentPool;
      const curatedInPool = opponents.filter(isProtectedOpponent).length;
      log(
        `generation ${generation}: battling ${population.length} teams against ${opponents.length} opponents ` +
          `(${curatedInPool} curated, ${opponents.length - curatedInPool} evolved)`
      );
      const run = await evaluateTeamsInOrder(ctx, {
        teams: population,
        matrix: deduped,
        opponents,
        pairingsFor: ownLeadPairing,
        difficulty,
        executor,
        onLog: log,
        roleScores,
        cache: battleCache,
      });
      // 'classic' (default) keeps today's plain win-rate
      // fitness; 'battle-reality' uses the blend (see computeBlendFitness) --
      // both are always computed on every result (cheap), so switching modes
      // never changes what a generation's battles measure, only which number
      // selection/mutation/convergence act on.
      const fitness = run.results.map((r) => (config.fitness === 'battle-reality' ? r.blendFitness : r.winRate));
      // An opponent's fitness is the other side of the same ledger the
      // candidates just produced -- no extra battles. A team nobody fought
      // (impossible today, but a zero-population generation would do it)
      // scores 0.5 rather than 0, so "unmeasured" never reads as "terrible".
      const opponentFitness = run.opponentTally.map((t) => (t.battles > 0 ? 1 - t.winPoints / t.battles : 0.5));

      history.push({ population, fitness });
      const isLastAllowedGeneration = generation === config.generations - 1;

      let lineage = null;
      let nextPopulation = [];
      let opponentLineage = null;
      let nextOpponents = [];
      if (!isLastAllowedGeneration) {
        const advanced = nextGeneration({
          population,
          fitness,
          pool,
          matrix: deduped,
          weights,
          seed: `${config.seed}-next${generation}`,
          opts: {
            excludeSpecies: candidateExcludeSpecies,
            targetSize: populationAt(generation + 1, config),
            deathRate: config.deathRate,
            mutationFloor: config.mutationFloor,
            mutationCeil: config.mutationCeil,
            immigrantFraction: config.immigrantFraction,
          },
        });
        lineage = advanced.lineage;
        nextPopulation = advanced.population;

        if (config.fixedOpponents) {
          // One draw, reused verbatim for the whole run: no culling, no
          // mutation, no immigration, and no schedule-driven growth either.
          nextOpponents = opponents;
        } else {
          const advancedOpponents = nextOpponentPool(ctx, {
            pool: opponents,
            fitness: opponentFitness,
            targetSize: opponentsAt(generation + 1, config),
            weights,
            curated: curatedPool,
            curatedRatio: config.curatedRatio,
            roleScores,
            movesetPool,
            seed: `${config.seed}-opponents-next${generation}`,
          });
          nextOpponents = advancedOpponents.pool;
          opponentLineage = advancedOpponents.lineage;
        }
      }

      const record = {
        formatVersion: CHECKPOINT_FORMAT_VERSION,
        generation,
        config,
        runStartedAt: new Date(runStartedAtMs).toISOString(),
        threadsUsed: threaded ? threads : null,
        population,
        fitness,
        // Per-team win rate keyed by the SAME lead-aware signature
        // src/teams/evolve.js uses for identity, so the final ranking can
        // average a team's win rate across the generations it survived even
        // though its index in `population` moves generation to generation.
        winRateBySignature: Object.fromEntries(
          population.map((team, i) => [teamSignature(team), run.results[i].winRate])
        ),
        opponentCount: opponents.length,
        opponentPool: serializeOpponentPool(opponents),
        opponentFitness,
        opponentLineage: opponentLineage ? { diedCount: opponentLineage.died.length, originCounts: opponentLineage.originCounts } : null,
        lineage,
        nextPopulation,
        nextOpponentPool: serializeOpponentPool(nextOpponents),
        timing: {
          startedAt: new Date(run.startedAt).toISOString(),
          finishedAt: new Date(run.finishedAt).toISOString(),
          elapsedMs: run.elapsedMs,
          battleCount: run.battleCount,
          cachedCount: run.cachedCount,
          errorCount: run.errorCount,
          msPerBattle: run.battleCount > 0 ? run.elapsedMs / run.battleCount : FALLBACK_MS_PER_BATTLE,
        },
        analytics: {
          ...computeGenerationAnalytics({ matrix: deduped, population, fitness, lineage, results: run.results }),
          ...computeOpponentAnalytics({ opponents, opponentFitness }),
        },
        resumed: false,
      };
      writeCheckpoint(outDir, generation, record);
      generationRecords.push(record);
      writeGenerationsAnalytics(outDir, generationRecords);
      lastEvaluated = record;
      lastOpponentPool = opponents;
      lastOpponentFitness = opponentFitness;
      log(
        `generation ${generation}: done -- mean fitness ${(record.analytics.meanFitness * 100).toFixed(1)}%, ` +
          `${run.battleCount} battles simulated + ${run.cachedCount} served from cache (${run.errorCount} errors), ` +
          `${formatDuration(run.elapsedMs)} elapsed`
      );

      const conv = hasConverged(history, config.convergence ?? {});
      generation += 1;
      if (conv.converged) {
        stopReason = `converged: ${conv.reason}`;
        log(`evolve: ${stopReason}`);
        break;
      }
      if (isLastAllowedGeneration) {
        stopReason = `generations cap reached (${config.generations})`;
      }
      population = nextPopulation;
      opponentPool = nextOpponents;
    }

    if (!stopReason) stopReason = `generations cap reached (${config.generations})`;
    if (!lastEvaluated) {
      throw new Error('evolve: no generation was ever evaluated (population sampling produced 0 teams from the start)');
    }

    // ---- Final elites pass ------------------------------------------------
    // Opponent set (Jaxon 2026-08-26): EVERY curated team, untouched and at
    // its own declared lead, plus the strongest teams the opponent GA evolved
    // over the run. The curated half is the reality check (these are the teams
    // actually being played); the evolved half is the hardest opposition the
    // run was able to construct, which is what stops the headline number being
    // a score against a fixed list the population has had every generation to
    // memorize. One battle per (elite, opponent) -- the elite at its locked
    // lead, the opponent at ITS designated lead -- rather than the old spread
    // across the opponent's 3 possible leads: now that every opponent carries
    // a real designated lead, fighting it at the other two is measuring a team
    // that nobody plays.
    const rankedIdx = lastEvaluated.population
      .map((_, i) => i)
      .sort((a, b) => lastEvaluated.fitness[b] - lastEvaluated.fitness[a] || a - b);
    const eliteTeams = rankedIdx.slice(0, config.eliteCount).map((i) => lastEvaluated.population[i]);

    const finalOpponentPool =
      lastOpponentPool ?? rehydrateOpponentPool(ctx, lastEvaluated.opponentPool ?? [], curatedPool, log);
    const finalOpponentFitness = lastOpponentFitness ?? lastEvaluated.opponentFitness ?? [];
    const evolvedRanked = finalOpponentPool
      .map((entry, i) => ({ entry, fitness: finalOpponentFitness[i] ?? 0 }))
      .filter(({ entry }) => !isProtectedOpponent(entry))
      .sort((a, b) => b.fitness - a.fitness);
    // Aim for the run's own curated:evolved ratio, so the headline win% is
    // weighted the same way the generations that produced these teams were --
    // but this is a CEILING, not a quota. Every curated team is in the pass by
    // definition (all ~110 of them), and the live opponent pool only ever
    // holds a couple dozen evolvable entries, so in practice the pass takes
    // every evolved opponent there is and lands well short of the ratio. That
    // is the intended trade: an elites-pass win% that leans curated is the
    // number worth reporting, because the curated teams are the real ones.
    const evolvedWanted = Math.round((curatedPool.length * (1 - config.curatedRatio)) / Math.max(config.curatedRatio, 1e-9));
    const eliteEvolved = evolvedRanked.slice(0, Math.min(evolvedWanted, evolvedRanked.length)).map(({ entry }) => entry);
    const eliteCurated = curatedPool.map((t) => ({ ...t, label: 'curated', leadIndex: t.leadIndex ?? 0 }));
    const eliteOpponents = [...eliteCurated, ...eliteEvolved];
    const eliteOpponentWeights = [
      ...eliteCurated.map((t) => curatedTierWeight(t)),
      ...eliteEvolved.map(() => ELITES_PASS_SAMPLED_WEIGHT),
    ];

    log(
      `evolve: final elites pass -- ${eliteTeams.length} teams x ${eliteOpponents.length} opponents ` +
        `(${eliteCurated.length} curated in full, ${eliteEvolved.length} strongest evolved), each at its own lead`
    );
    const eliteRun = await evaluateTeamsInOrder(ctx, {
      teams: eliteTeams,
      matrix: deduped,
      opponents: eliteOpponents,
      pairingsFor: ownLeadPairing,
      difficulty,
      trackLeads: true,
      executor,
      onLog: log,
      roleScores,
      cache: battleCache,
      opponentWeights: eliteOpponentWeights,
    });

    // ---- Final ranking (Jaxon 2026-08-26) ---------------------------------
    // The elites pass measures every elite against one broad, identical
    // opponent set -- comparable, but a single sample. A team's mean win rate
    // across the last few generations is measured against a moving pool, so it
    // is not comparable in absolute terms, but it averages several independent
    // opponent draws and so carries information one pass cannot: whether the
    // team is durably good. Rank on a weighted blend of the two, favoring the
    // elites pass. See RANKING_WEIGHTS / recentWindowSize.
    const recentWindow = recentWindowSize(generationRecords.length);
    const recentRecords = generationRecords.slice(-recentWindow);
    const recentWinRateFor = (signature) => {
      let sum = 0;
      let n = 0;
      for (const r of recentRecords) {
        const v = r.winRateBySignature?.[signature];
        if (typeof v === 'number') {
          sum += v;
          n += 1;
        }
      }
      return n > 0 ? { mean: sum / n, generations: n } : null;
    };

    const elites = eliteRun.results
      .map((r, i) => {
        // A team newer than the window (an immigrant in the final generation)
        // has no trailing history to average; it ranks on its elites-pass win
        // rate alone rather than being penalized for being new.
        const recent = recentWinRateFor(teamSignature(eliteTeams[i]));
        const combinedScore = recent
          ? RANKING_WEIGHTS.elitePass * r.winRate + RANKING_WEIGHTS.recent * recent.mean
          : r.winRate;
        return {
          ...r,
          sourceIndex: rankedIdx[i],
          signature: teamSignature(eliteTeams[i]),
          recentWinRate: recent?.mean ?? null,
          recentGenerations: recent?.generations ?? 0,
          combinedScore,
        };
      })
      .sort((a, b) => b.combinedScore - a.combinedScore || b.winRate - a.winRate || b.avgHpMargin - a.avgHpMargin);

    const cacheStats = battleCache.stats();
    if (cacheStats.hits + cacheStats.misses > 0) {
      log(
        `evolve: battle cache -- ${cacheStats.hits} hits / ${cacheStats.hits + cacheStats.misses} lookups ` +
          `(${Math.round((100 * cacheStats.hits) / (cacheStats.hits + cacheStats.misses))}%), ` +
          `${cacheStats.size} entries held${cacheStats.dropped ? `, ${cacheStats.dropped} dropped at the cap` : ''}`
      );
    }


    const result = {
      collectionPath: csvPath,
      reportPath,
      htmlPath: writeHtml ? htmlPath : null,
      outDir,
      donePath: path.join(outDir, 'evolve-DONE'),
      config,
      league,
      runStartedAt: new Date(runStartedAtMs).toISOString(),
      importWarnings: [...importWarnings, ...expanded.warnings],
      // Collection-size facts for the report's hero/footer -- raw CSV rows vs.
      // how many were actually scored once evolutions (default on) expanded
      // the pool. Both already computed above; just threaded through.
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
      // Everything the report needs about how the headline number was
      // measured and how the ranking was formed.
      eliteOpponents: {
        total: eliteOpponents.length,
        curated: eliteCurated.length,
        evolved: eliteEvolved.length,
      },
      ranking: {
        weights: RANKING_WEIGHTS,
        recentWindow,
        generationsRun: generationRecords.length,
      },
      finalOpponentPool: summarizeOpponentPool(finalOpponentPool, finalOpponentFitness),
      battleCacheStats: cacheStats,
      totalElapsedMs: Date.now() - runStartedAtMs,
    };

    const markdown = renderEvolveReport(result);
    mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
    writeFileSync(reportPath, markdown, 'utf8');
    log(`report written to ${reportPath}`);

    if (writeHtml) {
      const html = renderEvolveReportHtml(result);
      mkdirSync(path.dirname(path.resolve(htmlPath)), { recursive: true });
      writeFileSync(htmlPath, html, 'utf8');
      log(`HTML report written to ${htmlPath}`);
    }

    // Small machine-readable final ranking; scripts/chart-top-teams.mjs uses
    // it to pick which trajectories to animate.
    writeFileSync(
      path.join(outDir, 'evolve-ranking.json'),
      JSON.stringify(
        elites.map((t, i) => ({
          rank: i + 1,
          name: formatTeamMembers(t.members),
          signature: t.signature,
          combinedScore: t.combinedScore,
          winRate: t.winRate,
          recentWinRate: t.recentWinRate,
        })),
        null,
        2
      ),
      'utf8'
    );

    writeFileSync(result.donePath, renderDoneMarker(result), 'utf8');
    log(`evolve: DONE (${result.donePath})`);

    return result;
  }
}

// ---------------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------------

const HELP = `pogo-gbl-team-generator evolve -- genetic-algorithm team search

Usage:
  node scripts/evolve.mjs <collection.csv> [options]

Options:
  --population N         GA population size                        (default ${DEFAULTS.population})
  --opponents-per-gen M   opponent teams sampled each generation     (default ${DEFAULTS.opponentsPerGen})
  --generations G         generation cap                            (default ${DEFAULTS.generations})
  --seed S                PRNG seed                                 (default "${DEFAULTS.seed}")
  --threads N             battle via ONE persistent worker-pool executor
                            shared across every generation; this CLI
                            defaults to max(1, cpus-1) -- pass --threads 1
                            for the serial reference mode              (default ${defaultThreadCount()} on this machine)
  --deadline-minutes D    optional wall-clock budget (stop before the next
                            generation once past it; no self-tuning)   (default: none)
  --cp N                  CP cap / league                            (default ${DEFAULTS.cp})
  --fixed-opponents        freeze the opponent pool: one draw, never evolved
                            and never resized                          (default: off)
  --elites N               final-generation teams given the final evaluation
                            pass (all curated teams + the strongest evolved
                            opponents, each at its own lead)           (default ${DEFAULTS.elites})
  --score-meta S           1v1-pruning meta size                      (default ${DEFAULTS.scoreMeta})
  --pool P                 sampling pool size                         (default ${DEFAULTS.pool})
  --curated-ratio R        curated-vs-evolved opponent mix             (default ${DEFAULTS.curatedRatio})
  --population-final-ratio R  candidate population at the LAST generation as
                            a fraction of --population; the opponent count
                            grows to match, holding the per-generation
                            battle grid flat                           (default ${DEFAULTS.populationFinalRatio})
  --opponent-meta-pool N   composed opponents are built from the top N species
                            of pvpoke's own overall ranking (0 = the full
                            field, the pre-2026-08-26 behavior)        (default ${DEFAULTS.opponentMetaPool})
  --no-battle-cache        re-simulate every pairing instead of memoizing
                            identical ones (identical pairings are
                            deterministic, so the memo returns the same
                            numbers -- this is an escape hatch, not a
                            correctness knob)                          (default: cache on)
  --exclude a,b            species ids excluded from candidate teams   (default: none)
  --ban a,b                species ids banned FORMAT-WIDE for a cup rule
                            (e.g. "no Mimikyu, no Cramorant"): dropped from
                            candidate teams AND from the opponent side (whole
                            curated teams containing one, and the composed/
                            evolved-opponent moveset pool). Matched by BASE
                            species id, so a shadow variant is caught too
                            (not a distinct battle/regional-form id --
                            same "base species" rule the rest of this repo
                            uses)                                       (default: none)
  --difficulty D           AI difficulty 0-3 override                 (default: engine default, 3)
  --out PATH               final Markdown report path                 (default <out-dir>/my-teams-evolve.md)
  --html PATH              final HTML report path                     (default <out-dir>/${DEFAULTS.html})
  --no-evolutions          score mons only in the form you own (never evolve them)
  --no-html                skip writing the HTML report
  --out-dir DIR            checkpoints + DONE marker + default reports (default "${DEFAULTS.outDir}")
  --fitness classic|battle-reality  metric selection/mutation/convergence
                            act on -- 'battle-reality' blends win rate with
                            a snowball term and a closer term
                            (default "${DEFAULTS.fitness}")
  --death-rate R           candidate cull fraction per generation
                            (default: src/teams/evolve.js DEFAULT_DEATH_RATE)
  --mutation-floor R       lowest per-survivor mutation chance    (default: DEFAULT_MUTATION_FLOOR)
  --mutation-ceil R        highest per-survivor mutation chance   (default: DEFAULT_MUTATION_CEIL)
  --immigrant-fraction R   fresh-immigrant share of the population (default: DEFAULT_IMMIGRANT_FRACTION)
  --conv-window N          convergence: consecutive zero-churn generations
                            required                              (default: DEFAULT_CONVERGENCE_WINDOW)
  --conv-top-n N           convergence: size of the top set that must not
                            churn                                 (default: DEFAULT_CONVERGENCE_TOP_N)
  --help                   print this help and exit
`;

function say(line = '') {
  process.stdout.write(`${line}\n`);
}

function intFlag(value, name, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative integer, got "${value}"`);
  }
  return n;
}

function fractionFlag(value, name, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`--${name} must be a number in [0,1], got "${value}"`);
  }
  return n;
}

function fitnessFlag(value) {
  if (value === undefined) return DEFAULTS.fitness;
  if (!FITNESS_MODES.includes(value)) {
    throw new Error(`--fitness must be one of ${FITNESS_MODES.join('|')}, got "${value}"`);
  }
  return value;
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        population: { type: 'string' },
        'opponents-per-gen': { type: 'string' },
        generations: { type: 'string' },
        seed: { type: 'string' },
        threads: { type: 'string' },
        'deadline-minutes': { type: 'string' },
        cp: { type: 'string' },
        'fixed-opponents': { type: 'boolean' },
        elites: { type: 'string' },
        'score-meta': { type: 'string' },
        pool: { type: 'string' },
        'curated-ratio': { type: 'string' },
        'population-final-ratio': { type: 'string' },
        'opponent-meta-pool': { type: 'string' },
        'no-battle-cache': { type: 'boolean' },
        exclude: { type: 'string' },
        ban: { type: 'string' },
        difficulty: { type: 'string' },
        out: { type: 'string' },
        html: { type: 'string' },
        'no-html': { type: 'boolean' },
        'no-evolutions': { type: 'boolean' },
        'out-dir': { type: 'string' },
        fitness: { type: 'string' },
        'death-rate': { type: 'string' },
        'mutation-floor': { type: 'string' },
        'mutation-ceil': { type: 'string' },
        'immigrant-fraction': { type: 'string' },
        'conv-window': { type: 'string' },
        'conv-top-n': { type: 'string' },
        help: { type: 'boolean' },
      },
    });
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }

  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) {
    say(HELP);
    if (positionals.length === 0 && !values.help) process.exitCode = 2;
    return;
  }

  const csvPath = positionals[0];
  const opts = {
    population: intFlag(values.population, 'population', DEFAULTS.population),
    opponentsPerGen: intFlag(values['opponents-per-gen'], 'opponents-per-gen', DEFAULTS.opponentsPerGen),
    generations: intFlag(values.generations, 'generations', DEFAULTS.generations),
    seed: values.seed ?? DEFAULTS.seed,
    threads: values.threads !== undefined ? intFlag(values.threads, 'threads', undefined) : defaultThreadCount(),
    deadlineMinutes: values['deadline-minutes'] !== undefined ? intFlag(values['deadline-minutes'], 'deadline-minutes', undefined) : undefined,
    cp: intFlag(values.cp, 'cp', DEFAULTS.cp),
    fixedOpponents: !!values['fixed-opponents'],
    eliteCount: intFlag(values.elites, 'elites', DEFAULTS.elites),
    scoreMeta: intFlag(values['score-meta'], 'score-meta', DEFAULTS.scoreMeta),
    evolutions: !values['no-evolutions'],
    pool: intFlag(values.pool, 'pool', DEFAULTS.pool),
    curatedRatio: fractionFlag(values['curated-ratio'], 'curated-ratio', DEFAULTS.curatedRatio),
    populationFinalRatio: fractionFlag(values['population-final-ratio'], 'population-final-ratio', DEFAULTS.populationFinalRatio),
    opponentMetaPool: intFlag(values['opponent-meta-pool'], 'opponent-meta-pool', DEFAULTS.opponentMetaPool),
    battleCache: !values['no-battle-cache'],
    excludeSpecies: values.exclude ? values.exclude.split(',').map((s) => s.trim()).filter(Boolean) : [],
    banSpecies: values.ban ? values.ban.split(',').map((s) => s.trim()).filter(Boolean) : [],
    difficulty: values.difficulty !== undefined ? intFlag(values.difficulty, 'difficulty', undefined) : undefined,
    outDir: values['out-dir'] ?? DEFAULTS.outDir,
    out: values.out,
    html: values.html,
    noHtml: !!values['no-html'],
    fitness: fitnessFlag(values.fitness),
    deathRate: fractionFlag(values['death-rate'], 'death-rate', undefined),
    mutationFloor: fractionFlag(values['mutation-floor'], 'mutation-floor', undefined),
    mutationCeil: fractionFlag(values['mutation-ceil'], 'mutation-ceil', undefined),
    immigrantFraction: fractionFlag(values['immigrant-fraction'], 'immigrant-fraction', undefined),
    convWindow: values['conv-window'] !== undefined ? intFlag(values['conv-window'], 'conv-window', undefined) : undefined,
    convTopN: values['conv-top-n'] !== undefined ? intFlag(values['conv-top-n'], 'conv-top-n', undefined) : undefined,
  };

  const realLog = console.log;
  console.log = () => undefined;
  console.info = () => undefined;
  console.debug = () => undefined;

  let result;
  try {
    result = await runEvolution(csvPath, {
      ...opts,
      onLog: (msg) => process.stderr.write(`${msg}\n`),
      onProgress: () => {},
    });
  } finally {
    console.log = realLog;
  }

  say(`Evolution complete. ${result.generationRecords.length} generation(s) run (${result.stopReason}).`);
  if (result.elites[0]) {
    const top = result.elites[0];
    say(
      `Top team: ${formatTeamMembers(top.members)} -- score ${pct(top.combinedScore)} ` +
        `(${pct(top.winRate)} elites-pass win rate, ${pct(top.recentWinRate)} over the last ${result.ranking.recentWindow} generation(s)).`
    );
  }
  say('');
  say(`Full report written to ${result.reportPath}`);
  if (result.htmlPath) say(`HTML report written to ${result.htmlPath}`);
  say(`Done marker written to ${result.donePath}`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`\nError: ${err.message}\n`);
    process.exitCode = 1;
  });
}
