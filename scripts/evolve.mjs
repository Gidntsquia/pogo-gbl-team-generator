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
// TWO-DIRECTION BATTLES (v13, Jaxon 2026-09-18, from plans/WORKER_NOTES.md's
// Item 1 experiment): every pairing, in every generation AND the final elites
// pass, is now fought BOTH ways -- candidate as team A vs opponent as team B,
// and opponent as team A vs candidate as team B (mirrorBattleResult flips the
// second result's labels back so it tallies as if the candidate had been team
// A) -- and both results feed the same tally. The old convention (candidates
// always as team A, described below as "cancels in the relative ranking")
// undercounted: Item 1 measured pvpoke emulate mode's own team-A/team-B seat
// bias as ONLY PART of the candidate/opponent fitness gap it was blamed for
// -- see RUNBOOK.md "Known artifact" for the measured decomposition. Battling
// both ways removes the seat bias structurally, at ~2x the battle count (see
// BUDGET MATH below); it does not and cannot remove a genuine population-
// strength difference between the two GAs' populations, which Item 1 also
// measured as real and separate.
//
// (Superseded fixed-side convention, kept for context: same as scripts/
// tournament.mjs / src/teams/index.js -- outside this file's two-direction
// path, a population member is still always battled as team A, so pvpoke
// emulate mode's small residual seat bias there is a constant offset shared
// by every team and cancels in the RELATIVE ranking.)
//
// Usage:
//   node scripts/evolve.mjs <collection.csv> [options]
//   node scripts/evolve.mjs --help    (the authoritative flag list)
//
// BUDGET MATH: battles/generation = 2 x population x opponents-per-gen (v13:
// every pairing fought both directions, see TWO-DIRECTION BATTLES above),
// held flat across the run by the schedule above. At the flag defaults:
// 2 x 100 x 20 = 4,000 pairings/generation; 15 generations = 60,000, plus a
// final elites pass of 2 x elites x (all curated + evolved) -- with the
// pinned data that is 2 x 10 x ~162 = ~3,240. The memo cache means the
// number of pairings SIMULATED is far lower than the number planned (the
// report prints both). Measured rates vary by machine (~18ms/battle threaded
// on Jaxon's Mac) -- size --population/--opponents-per-gen/--generations to
// your own time budget; --deadline-minutes is a simple stop-before-the-next
// -generation safety net, not a self-tuning scaler (unlike tournament.mjs's
// stage 2/3 tuning).
//
// GA TUNABLES: the candidate side's rates (--death-rate / --mutation-floor /
// --mutation-ceil / --immigrant-fraction) and the convergence shape
// (--conv-window / --conv-top-n) are CLI flags as of 2026-08-27 (Jaxon's
// top-400 run wanted hotter selection and a top-5 convergence test). Each
// enters the checkpoint config fingerprint ONLY when explicitly passed, so
// pre-existing checkpoint dirs (which never set them) still resume. The
// rest (leadRotationRate, shadowFlipRate, alpha, convergence trailing/maxChurn/minLiftGain,
// and the whole opponent side in src/meta/opponentPool.js) remain exported
// DEFAULT_* constants only.
//
// SELECTION SMOOTHING + HELD-OUT FINAL PASS (Jaxon 2026-09-05, from the
// shared-s2-gen-1 post-mortem). Two things made that run's ranking a single
// lucky draw:
//   1. The cull, the mutation odds and the finalist pick all ranked on ONE
//      generation's fitness, while the opponent pool turned over 35% per
//      generation -- a team's win rate moved 3.9 points generation to
//      generation against a 2.2-point true spread between long-lived teams.
//      Durable ~51% teams died to one bad draw; 1-4-observation teams made
//      the final 15. Selection and the finalist pick now act on each team's
//      recency-weighted mean over its last `--selection-trailing` generations
//      (default DEFAULT_SELECTION_TRAILING, weighted by DEFAULT_SELECTION_
//      RECENCY_DECAY -- its own window, separate from hasConverged's; see
//      src/teams/evolve.js trailingFitness). An initial equal-weighted
//      10-generation window reacted too slowly to real drift; 5, weighted
//      toward the newest generations, still smooths the noise without lagging
//      as much. `--selection-trailing 1` is the pre-2026-09-05 behavior. The
//      per-generation checkpoint keeps the raw `fitness` (history/analytics/
//      race chart are unchanged) and adds the `selectionFitness` actually used.
//   2. With --curated-ratio 0 the final pass graded the finalists against the
//      last generation's own opponent pool -- 0 new battles, every "elites
//      pass win%" byte-identical to the gen-73 number that had just chosen
//      them (the winner's curse, measured: the #1 team's 57% was 7 points
//      above its own lifetime mean). The pass now fights a HELD-OUT set: an
//      archive of the strongest opponents the opponent GA bred over the whole
//      run, excluding anything that sat in the pools of the generations the
//      finalists were selected on (buildOpponentArchive), plus fresh
//      meta-composed teams never fought before (`--final-archive` /
//      `--final-fresh`, neither in the checkpoint fingerprint), plus every
//      curated team as before. `--elites` is no longer in the fingerprint
//      either (configsMatch), so a finished run can be re-rendered with more
//      finalists without re-simulating a generation.
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

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { importCollection } from '../src/importer/index.js';
import { expandEvolutions } from '../src/evolution/index.js';
import { filterEligibleMons } from '../src/util/eligibility.js';
import { teamBuildCost } from '../src/cost/powerup.js';
import { initEngine } from '../src/engine/harness.js';
import { battleTeams } from '../src/engine/teamBattle.js';
import { createExecutor, defaultThreadCount } from '../src/engine/parallel.js';
import { scoreCollection, computeWeightedScore } from '../src/scoring/index.js';
import { loadUsageWeights } from '../src/meta/usage.js';
import { loadMovesetPool, DEFAULT_META_POOL_SIZE, baseIdOf, composeSampledOpponent } from '../src/meta/sampleTeams.js';
import { archetypeGroups, archetypeWeights, DEFAULT_ARCHETYPE_BETA, DEFAULT_CORE_RIVALRY, DEFAULT_SIMILAR_RIVALRY, DEFAULT_SIMILAR_FLOOR } from '../src/meta/archetypes.js';
import { createSimilarity } from '../src/engine/similarity.js';
import { crowdingWeights, trailingFitnessGeneric } from '../src/ga/core.js';
import { loadMetaTeams, curatedTierWeight } from '../src/meta/teams.js';
import { rngFromSeed } from '../src/util/rng.js';
import {
  initOpponentPool,
  nextOpponentPool,
  isProtectedOpponent,
  serializeOpponentPool,
  rehydrateOpponentPool,
  curatedHeadcount,
  DEFAULT_OPPONENT_MUTATION_FLOOR,
  DEFAULT_OPPONENT_MUTATION_CEIL,
} from '../src/meta/opponentPool.js';
import { dedupeBestPerSpecies } from '../src/teams/index.js';
import {
  initPopulation,
  nextGeneration,
  hasConverged,
  shadowBlindSignature,
  trailingFitness,
  DEFAULT_MUTATION_FLOOR,
  DEFAULT_MUTATION_CEIL,
  DEFAULT_SELECTION_TRAILING,
  DEFAULT_SELECTION_RECENCY_DECAY,
  DEFAULT_CONVERGENCE_TRAILING,
  DEFAULT_CONVERGENCE_WINDOW,
} from '../src/teams/evolve.js';
import { resolveFormat } from '../src/util/leagues.js';
import { loadRoleScores } from '../src/meta/roles.js';
import { buildTypeCoverageContext, computeSharedWeaknessScore } from '../src/teams/typeCoverage.js';
import { buildTopTeamSeries, renderChartInner } from '../src/report/raceChart.js';
import { LEAGUE_ACCENTS, championshipCss } from '../src/report/podiumTheme.js';

const DEFAULTS = Object.freeze({
  population: 100,
  opponentsPerGen: 20,
  generations: 15,
  seed: 'pogo-gbl-team-generator-evolve',
  cp: 1500,
  cup: 'all',
  elites: 10,
  scoreMeta: 20,
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
  // Final-pass held-out strata (see the header note): the archive is capped
  // at this many of the strongest never-recently-fought evolved opponents the
  // opponent GA actually bred -- real, selected-for-fitness teams, so 400
  // puts the binomial standard error of a finalist's win% near 1.8 points
  // (the s2 run's single-generation number carried ~3.6) for real weight.
  // `finalFresh` defaults to 0 (see finalFreshDefault): a freshly meta
  // -composed team is drawn from the same weighted-random sampler that seeds
  // immigrants, with none of the opponent GA's generations of selection
  // behind it, so in bulk it is closer to a random legal team than a strong
  // one -- padding the pass with hundreds of them would mostly measure a
  // finalist's win rate against mediocrity. Neither is in the checkpoint
  // fingerprint: they change only the final pass.
  finalArchive: 400,
  finalFresh: 0,
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
  // Sublinear per-archetype discount on candidate-side opponent weighting
  // (src/meta/archetypes.js) and on the elites-pass consistency score's
  // archetype grouping. See archetypeWeights' doc comment for the beta=0/1
  // extremes.
  archetypeBeta: DEFAULT_ARCHETYPE_BETA,
  // Frequency-normalised opponent fitness (see computeCandidateWeights):
  // down-weights a candidate team's contribution to an opponent's fitness by
  // the candidate's own most-common member's share of the population, so an
  // opponent isn't rewarded 15x for beating a 15%-share core instead of a
  // 1%-share one. On by default; --no-opponent-fitness-normalised restores
  // the old flat mean for comparison.
  opponentFitnessNormalised: true,
  // Opponent-strength weighting of each candidate's win rate (2026-09-09,
  // see evaluateTeamsInOrder): opponent j's vote is scaled by
  // (its own win rate against the population)^gamma, so beating a weak
  // singleton that barely wins anything itself earns little and beating a
  // strong team earns the most. 0 = off (every opponent votes equally).
  opponentStrengthGamma: 1,
  // Symmetric candidate-strength weighting of each opponent's fitness
  // (2026-09-17, see evaluateTeamsInOrder): mirrors opponentStrengthGamma on
  // the other side of the same ledger -- a candidate's vote toward an
  // opponent's fitness is scaled by (that candidate's own raw win rate
  // across the whole generation)^gamma, so an opponent that only ever beats
  // weak candidates doesn't outscore one that had to earn its wins. Without
  // this, opponentStrengthGamma alone discounted candidates' wins over weak
  // opponents but gave opponents no equivalent discount for beating weak
  // candidates, which pulled candidate fitness systematically below
  // opponent fitness on the same battles. 0 = off (every candidate votes
  // equally, the old behaviour).
  candidateStrengthGamma: 1,
  // Core rivalry on both GAs (src/meta/archetypes.js coreRivalryFitness):
  // each better team sharing a two-species core costs a team this fraction
  // of the field's fitness range before the cull ranks it -- a penalty
  // rather than a death sentence, so a second variant that plays differently
  // and fights well still survives. A team that is a better team's shadow
  // variant (whole-team similarity 0.9) pays 2.8 steps instead of 1 -- high,
  // but not fatal; only an exact duplicate dies outright, whatever R is.
  // Keeps a strong core from filling the pool with its own trailing
  // near-duplicates (the v2 run's opponent pool was 81% mutants of a few
  // cores by gen 59). 0 = off.
  coreRivalry: DEFAULT_CORE_RIVALRY,
  // SIMILAR cores in that penalty, scored by pvpoke's own "Similar Pokemon"
  // metric (src/engine/similarity.js: shared types, moves and traits,
  // normalised 0..1). Member pairs at or below `similarFloor` are unrelated;
  // above it they count linearly up to `similarRivalry` of an identical
  // species (Feraligatr vs Empoleon ~0.55 raw -> ~0.3 with the defaults).
  // A team is charged only for its most crowded core, never for two or
  // three at once. similarRivalry 0 = exact cores only.
  similarRivalry: DEFAULT_SIMILAR_RIVALRY,
  similarFloor: DEFAULT_SIMILAR_FLOOR,
  // Opponent composition normally rotates pvpoke's own published lead-prior
  // winner into slot 0 (composeSampledOpponent -> pickLeadIndex), while the
  // candidate side always assigns a uniform-random lead (assignLead /
  // buildLeadRotation) and only converges on a good one through selection.
  // For a meta-vs-meta run -- both sides drawing from the same pool, meant to
  // be symmetrical (see RUNBOOK's Symmetry rule) -- that gives the opponent
  // side a lead-quality head start the candidate side never gets, which
  // showed up as a persistent opponent-fitness-over-candidate-fitness gap
  // from generation 0 onward (2026-09-17, Jaxon). `--random-opponent-lead`
  // makes opponent composition assign a random lead too (roleScores omitted
  // from every composeSampledOpponent call), matching the candidate side
  // exactly. Off by default -- the standard recipe (real collection vs a
  // co-evolving meta) wants the opponent side's leads realistic, not random.
  randomOpponentLead: false,
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
 * Final-pass opponent weights (Jaxon 2026-08-27: "weight ladder teams more
 * than the curated/off meta teams, which should be weighted more than the
 * sample teams"). Curated opponents weigh in at their tier's
 * CURATED_TIER_WEIGHTS value (src/meta/teams.js: meta/ladder 1, recommended
 * 0.5, off-meta 0.25). The bred/composed strata (archive + fresh) together
 * carry the run's own evolved share -- a total of curatedTotal x (1 - r) / r
 * at --curated-ratio r, split evenly -- so the headline mixes real teams and
 * bred teams the way the generations that produced the finalists did (the
 * stated intent of the pre-2026-09-05 pass, which in practice fell far short
 * of it because the live pool held only a couple dozen evolvable entries).
 * With no curated teams (r = 0) every opponent weighs 1. Only the final-pass
 * win rate is weighted -- per-generation fitness and the `recent` ranking
 * term stay unweighted.
 *
 * @param {{curated: Array<object>, evolvedCount: number, curatedRatio: number}} params
 * @returns {number[]} weights, curated first then `evolvedCount` evolved.
 */
function finalPassWeights({ curated, evolvedCount, curatedRatio }) {
  const curatedWeights = curated.map((t) => curatedTierWeight(t));
  if (curated.length === 0 || evolvedCount === 0) {
    return [...curatedWeights, ...new Array(evolvedCount).fill(1)];
  }
  const curatedTotal = curatedWeights.reduce((s, w) => s + w, 0);
  const r = Math.min(Math.max(curatedRatio, 1e-9), 1);
  const each = (curatedTotal * (1 - r)) / r / evolvedCount;
  return [...curatedWeights, ...new Array(evolvedCount).fill(each)];
}

/** Trailing window selection and the finalist pick average over (see the header note; `--selection-trailing`). */
function selectionTrailingOf(config) {
  return Math.max(1, config.selectionTrailing ?? DEFAULT_SELECTION_TRAILING);
}

// `finalFresh` fallback when the flag is not set explicitly: 0 in the normal
// case (a curated set is in play, so the archive stratum is the only
// held-out one needed), but at --curated-ratio 0 there is no reality-check
// stratum at all, so a SMALL number of fresh teams is let in anyway -- kept
// low because a freshly composed team is essentially a random legal team,
// not one the opponent GA selected for strength (see DEFAULTS.finalFresh).
const FINAL_FRESH_WHEN_NO_CURATED = 20;
function finalFreshDefault(config) {
  return config.curatedRatio > 0 ? DEFAULTS.finalFresh : FINAL_FRESH_WHEN_NO_CURATED;
}

/**
 * Hall-of-fame archive for the final pass: every distinct evolved opponent
 * that ever sat in a generation's pool, ranked by its mean fitness (1 - the
 * candidate win rate against it) over the generations it was measured in,
 * EXCLUDING every opponent present in the pools of the last
 * `holdoutGenerations` generations -- those are the pools the finalists'
 * selection statistic was measured on, so re-fighting them would re-measure
 * the number that chose the finalists (see the header note). Curated entries
 * are skipped here because the pass takes every curated team separately.
 * Pure: reads only what the checkpoints already store, so a finished run can
 * be re-rendered against it. Deterministic (ties on id).
 *
 * @param {Array<{opponentPool?: Array<object>, opponentFitness?: number[]}>} records
 *   oldest-first per-generation records (checkpoint shape).
 * @param {{holdoutGenerations: number, limit: number}} opts
 * @returns {{archive: Array<object>, eligible: number, seen: number, heldOut: number}}
 *   `archive` holds serialized opponent entries (rehydrate before battling)
 *   with `meanFitness` and `generations` attached, strongest first.
 */
export function buildOpponentArchive(records, { holdoutGenerations, limit }) {
  const stats = new Map();
  const heldOut = new Set();
  const cutoff = records.length - Math.max(0, holdoutGenerations);
  records.forEach((r, g) => {
    const pool = r.opponentPool ?? [];
    const fit = r.opponentFitness ?? [];
    pool.forEach((o, i) => {
      if (o.origin === 'curated') return;
      if (g >= cutoff) {
        heldOut.add(o.id);
        return;
      }
      const s = stats.get(o.id) ?? { entry: o, sum: 0, n: 0 };
      s.sum += fit[i] ?? 0;
      s.n += 1;
      stats.set(o.id, s);
    });
  });
  const ranked = [...stats.values()]
    .filter((s) => !heldOut.has(s.entry.id))
    .map((s) => ({ ...s.entry, meanFitness: s.sum / s.n, generations: s.n }))
    .sort((a, b) => b.meanFitness - a.meanFitness || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    archive: ranked.slice(0, Math.max(0, limit)),
    eligible: ranked.length,
    seen: stats.size + [...heldOut].filter((id) => !stats.has(id)).length,
    heldOut: heldOut.size,
  };
}

/**
 * `count` fresh meta-composed opponents for the final pass, none of which
 * carries an id in `usedIds` (every opponent the run ever fielded), so the
 * stratum is genuinely never-fought. Same composer the opponent GA's
 * immigrants use; seeded, so a re-render draws the same teams.
 */
function composeFreshOpponents(ctx, { count, seed, movesetPool, weights, roleScores, usedIds }) {
  const rng = rngFromSeed(`${seed}-final-fresh`);
  const used = new Set(usedIds);
  const out = [];
  const maxAttempts = count * 20 + 50;
  for (let attempts = 0; out.length < count && attempts < maxAttempts; attempts++) {
    const team = composeSampledOpponent(ctx, rng, movesetPool, weights, roleScores);
    if (used.has(team.id)) continue;
    used.add(team.id);
    out.push({ ...team, origin: 'fresh', label: 'fresh' });
  }
  return out;
}

/** Unweighted win rate per final-pass stratum (`perMeta[].label`: curated / archive / fresh). */
function winRateByStratum(perMeta) {
  const acc = new Map();
  for (const m of perMeta ?? []) {
    const key = m.label ?? 'other';
    const cur = acc.get(key) ?? { sum: 0, n: 0 };
    cur.sum += m.winRate;
    cur.n += 1;
    acc.set(key, cur);
  }
  return Object.fromEntries([...acc.entries()].map(([k, v]) => [k, { winRate: v.sum / v.n, battles: v.n }]));
}

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
const FINAL_OPPONENT_POOL_REPORT_CAP = 20; // final-report-only cap (summarizeOpponentPool's `toughest`), separate from the smaller per-generation TOUGHEST_OPPONENTS_CAP.
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
const CORE_BREAK_WIN_RATE_MAX = 0.2;
const THREAT_WIN_RATE_MAX = 0.4;

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
 * The elite's break exposure: every species appearing in at least
 * CORE_BREAK_MIN_TEAMS of its elites-pass opponent teams against which the
 * elite's group win rate is at most THREAT_WIN_RATE_MAX, worst first. The
 * report splits this list at CORE_BREAK_WIN_RATE_MAX into core breakers vs
 * threats (splitBreakExposure). Report only (see the constants' comment).
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
function splitBreakExposure(cb) {
  const core = [];
  const threats = [];
  for (const s of cb ?? []) ((s.winRate ?? 0) <= CORE_BREAK_WIN_RATE_MAX ? core : threats).push(s);
  return { core, threats };
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

/**
 * HTML-escaped counterpart of {@link formatBuildCost} -- same content and
 * caveats (Stardust/Candy/Candy XL totals, evolution items, per-member
 * evolve-from notes, unknown-level/unpriced-evolution caveats), for the
 * HTML report's per-team detail card. Mirrors src/report/index.js's own
 * "Build cost:" line on the main CLI report, same convention.
 *
 * @param {object|undefined} cost - `t.buildCost` (teamBuildCost result);
 *   always present on a real run's elites (computed unconditionally in
 *   evaluateTeamsInOrder) -- undefined only on a hand-built fixture that
 *   omits it, handled here rather than crashing the report.
 * @returns {string}
 */
function buildCostHtml(cost) {
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

/**
 * Own-lead-locked single pairing: candidate's team[0] vs. the opponent's
 * declared lead. Exported (plans/WORKER_NOTES.md Item 3) so a study script
 * can feed `evaluateTeamsInOrder` the exact same pairing generator
 * `runEvolution`'s per-generation battles use, instead of a reimplementation.
 */
export function ownLeadPairing(opp) {
  return [{ leadA: CANDIDATE_LEAD, leadB: opponentLeadIndex(opp) }];
}

/**
 * Turn a `battleTeams` result fought with team A and team B swapped back into
 * one that reads as if the CANDIDATE had been team A all along (plans/
 * WORKER_NOTES.md Item 2 -- the fitness-symmetry fix). `winner` flips a<->b
 * (a tie stays a tie); `survivorsHp.{a,b,aPerMon,bPerMon}` swap; every
 * `summary` field whose name ends in `A` or `B` (both team-specific: leadA/
 * leadB, remainingA/B, throwAndGoSwitchesA/B, shieldsDeclinedA/B,
 * costlySwitchesA/B, freeSwitchesA/B, leadFaintTurnA/B, shieldsRemainingA/B)
 * swaps with its `B`/`A` partner; everything else (turns, duration,
 * difficulty, seed, endedBy, ...) is battle-wide and copied as-is. Throws if
 * an `A`/`B`-suffixed key has no partner -- a silent one-sided swap would
 * credit a battle to the wrong side rather than fail loudly. Pure: no battle
 * math, just relabeling an already-fought result (never edits
 * `vendor/pvpoke`, per AGENTS.md).
 * @param {object} r - a `battleTeams` result
 * @returns {object} the same battle, relabeled so its own team A is the side
 *   that was actually team B when it was fought
 */
export function mirrorBattleResult(r) {
  const winner = r.winner === 'tie' ? 'tie' : r.winner === 'a' ? 'b' : 'a';
  const survivorsHp = {
    a: r.survivorsHp.b,
    b: r.survivorsHp.a,
    aPerMon: r.survivorsHp.bPerMon,
    bPerMon: r.survivorsHp.aPerMon,
  };
  const summary = {};
  const done = new Set();
  for (const key of Object.keys(r.summary)) {
    if (done.has(key)) continue;
    if (key.endsWith('A') || key.endsWith('B')) {
      const otherSuffix = key.endsWith('A') ? 'B' : 'A';
      const pairKey = `${key.slice(0, -1)}${otherSuffix}`;
      if (!(pairKey in r.summary)) {
        throw new Error(`mirrorBattleResult: summary key "${key}" has no "${pairKey}" partner to swap with`);
      }
      summary[key] = r.summary[pairKey];
      summary[pairKey] = r.summary[key];
      done.add(key);
      done.add(pairKey);
    } else {
      summary[key] = r.summary[key];
    }
  }
  return { winner, survivorsHp, summary };
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
 * `consistency` (added 2026-09-08, see docs/plans/2026-09-08-fitness-restructure.md)
 * answers "how does this team do against its worst ARCHETYPE", pulling
 * fitness back for teams that only beat the majority core and fold against
 * everything else; it takes its share out of `winRate` and `snowball` rather
 * than being tacked on, since it is itself a transform of winRate data.
 */
/**
 * See buildRunConfig's `fitnessSemantics` comment. Bumped to v14
 * (plans/PLAN.md Item 2, fitness-symmetry loop): the candidate and opponent
 * GAs now share src/ga/core.js's churn/slot-allocation accounting (churn
 * based on live population, floored immigrant reserve, post-build immigrant
 * backfill on both sides -- previously only the opponent pool had the
 * latter two), the opponent pool gained a shadowFlip mutation type for
 * parity with the candidate side, and the shared-weakness coverage lookup
 * (src/teams/typeCoverage.js) now keys by build (species+moveset) instead
 * of matrix key, so an opponent lead gets real coverage relief for the
 * first time instead of always reading the empty-map fallback.
 */
const FITNESS_SEMANTICS = 'core-pair-archetypes-v14';
const TYPE_COVERAGE_META_SIZE = 200;
// Closer/consistency disabled for now (weights zeroed rather than removed,
// so they're a one-line revert away). Snowball is opt-in via
// --snowball-weight (candidate side only -- the opponent side has its own,
// separate win-rate fitness in src/meta/opponentPool.js, so this weight
// never touches it).
// `sharedWeakness` (added 2026-09-11) is likewise opt-in via
// --shared-weakness-weight: it rewards teams whose back line can actually be
// switched into when the lead's matchup goes bad (src/teams/typeCoverage.js).
// Unlike the other three it is a pure TYPE-CHART property of the roster, not
// a measurement of this generation's battles, so it stays off by default
// rather than quietly reshaping every run's selection pressure.
const DEFAULT_FITNESS_WEIGHTS = Object.freeze({ winRate: 1, consistency: 0, snowball: 0, closer: 0, sharedWeakness: 0 });

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

export function computeBlendFitness(
  { winRate, snowballScore, closerScore, consistencyScore, sharedWeaknessScore },
  weights = DEFAULT_FITNESS_WEIGHTS
) {
  const consistency = consistencyScore ?? winRate;
  const consistencyWeight = weights.consistency ?? 0;
  // A team whose shared-weakness score was never computed (an older
  // checkpoint's entry replayed through this function) contributes its own
  // winRate at that weight, the same neutral fallback computeSnowballScore
  // uses -- not 0, which would read as "maximally locked" on no evidence.
  const sharedWeakness = sharedWeaknessScore ?? winRate;
  const sharedWeaknessWeight = weights.sharedWeakness ?? 0;
  const totalWeight = weights.winRate + consistencyWeight + weights.snowball + weights.closer + sharedWeaknessWeight;
  const blend =
    weights.winRate * winRate +
    consistencyWeight * consistency +
    weights.snowball * (snowballScore ?? winRate) +
    weights.closer * (closerScore ?? winRate) +
    sharedWeaknessWeight * sharedWeakness;
  return totalWeight > 0 ? blend / totalWeight : 0;
}

/**
 * Linear-interpolated percentile of a SORTED numeric array (ascending),
 * p in [0,1]. Deterministic, no ties-breaking needed (arithmetic mean of
 * the two bracketing values).
 */
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = p * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac;
}

/**
 * Per-team consistency score (added 2026-09-08 -- see
 * docs/plans/2026-09-08-fitness-restructure.md, section D): the 25th
 * percentile of the team's mean win rate PER ARCHETYPE (see
 * src/meta/archetypes.js), i.e. "what does this team do against its worst
 * archetype", scale-free rather than a mean-minus-std. Fewer than 4
 * archetypes in the sample is too few for a percentile to mean anything, so
 * consistencyScore falls back to the team's overall winRate in that case.
 *
 * @param {Array<{winRate: number, archetypeGroup: number|null, strength?: number}>} perMeta -
 *   per-opponent results for one team this pass, each tagged with its
 *   opponent's archetype group id (null if no grouping was supplied).
 * @param {number} winRate - this team's overall (weighted) win rate, the
 *   fallback when there are too few archetypes to percentile over.
 * @returns {{consistencyScore: number, archetypeWinRates: number[]}}
 */
export function computeConsistencyScore(perMeta, winRate) {
  const byGroup = new Map();
  for (const p of perMeta) {
    if (p.archetypeGroup === null || p.archetypeGroup === undefined) continue;
    // Each opponent's vote inside its archetype carries its strength weight
    // (perMeta[].strength, 1 when strength weighting is off).
    const w = p.strength ?? 1;
    if (!(w > 0)) continue;
    const cur = byGroup.get(p.archetypeGroup) ?? { sum: 0, n: 0 };
    cur.sum += p.winRate * w;
    cur.n += w;
    byGroup.set(p.archetypeGroup, cur);
  }
  const archetypeWinRates = [...byGroup.values()].map((v) => v.sum / v.n);
  if (archetypeWinRates.length < 4) return { consistencyScore: winRate, archetypeWinRates };
  const sorted = [...archetypeWinRates].sort((a, b) => a - b);
  return { consistencyScore: percentile(sorted, 0.25), archetypeWinRates };
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
 * Candidate mutation floor/ceil for the generation being evolved FROM `g`
 * (i.e. the rates `nextGeneration` uses when producing generation g+1): a
 * straight linear anneal from the optional hot-start values
 * (`--mutation-floor-start` / `--mutation-ceil-start`) at generation 0 down
 * to the standard floor/ceil (`--mutation-floor` / `--mutation-ceil`, or
 * src/teams/evolve.js's defaults) at the last allowed generation -- same
 * ramp shape and indexing as {@link populationAt}. With no start value set,
 * each rate is constant across the run (the pre-anneal behavior, exactly).
 * Pure function of (g, config), so a resumed run recomputes the same rates.
 *
 * @param {number} g - generation index.
 * @param {object} config - resolved run config (buildRunConfig shape).
 * @returns {{mutationFloor: number, mutationCeil: number}}
 */
export function mutationRatesAt(g, config) {
  const endFloor = config.mutationFloor ?? DEFAULT_MUTATION_FLOOR;
  const endCeil = config.mutationCeil ?? DEFAULT_MUTATION_CEIL;
  const startFloor = config.mutationFloorStart ?? endFloor;
  const startCeil = config.mutationCeilStart ?? endCeil;
  const G = Math.max(1, config.generations);
  const t = G > 1 ? Math.min(1, g / (G - 1)) : 1;
  return {
    mutationFloor: startFloor + t * (endFloor - startFloor),
    mutationCeil: startCeil + t * (endCeil - startCeil),
  };
}

/**
 * Opponent-side mutation floor/ceil for the generation being evolved FROM
 * `g` -- the same linear anneal as {@link mutationRatesAt}, driven by the
 * `--opponent-mutation-*` flags and falling back to
 * src/meta/opponentPool.js's defaults. With nothing set the opponent GA runs
 * at its constant defaults, exactly as before these flags existed.
 *
 * @param {number} g - generation index.
 * @param {object} config - resolved run config (buildRunConfig shape).
 * @returns {{mutationFloor: number, mutationCeil: number}}
 */
export function opponentMutationRatesAt(g, config) {
  const endFloor = config.opponentMutationFloor ?? DEFAULT_OPPONENT_MUTATION_FLOOR;
  const endCeil = config.opponentMutationCeil ?? DEFAULT_OPPONENT_MUTATION_CEIL;
  const startFloor = config.opponentMutationFloorStart ?? endFloor;
  const startCeil = config.opponentMutationCeilStart ?? endCeil;
  const G = Math.max(1, config.generations);
  const t = G > 1 ? Math.min(1, g / (G - 1)) : 1;
  return {
    mutationFloor: startFloor + t * (endFloor - startFloor),
    mutationCeil: startCeil + t * (endCeil - startCeil),
  };
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
    // bPerMon (added v13, alongside aPerMon) so mirrorBattleResult can turn a
    // cached FORWARD hit into a valid reversed-direction result without a
    // missing field -- the two-direction elites pass runs with trackLeads.
    survivorsHp: {
      a: r.survivorsHp.a,
      b: r.survivorsHp.b,
      aPerMon: r.survivorsHp.aPerMon,
      bPerMon: r.survivorsHp.bPerMon,
    },
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
  for (const key of [
    'snowballWeight', 'closerWeight', 'consistencyWeight', 'sharedWeaknessWeight',
    'opponentSnowballWeight', 'opponentCloserWeight', 'opponentConsistencyWeight', 'opponentSharedWeaknessWeight',
  ]) {
    if (opts[key] !== undefined && (!Number.isFinite(opts[key]) || opts[key] < 0)) {
      throw new Error(`evolve: opts.${key} must be a non-negative finite number`);
    }
  }
  return {
    csvPath: path.resolve(csvPath),
    scoreMeta: opts.scoreMeta ?? DEFAULTS.scoreMeta,
    evolutions: opts.evolutions ?? true,
    // undefined = no cap, whole deduped collection (buildSamplingPool).
    pool: opts.pool ?? undefined,
    seed: String(opts.seed ?? DEFAULTS.seed),
    cp: opts.cp ?? DEFAULTS.cp,
    // Part of the fingerprint: a resume with a different cup must start
    // fresh rather than reuse a population bred from a different candidate/
    // opponent pool (and rankings/format that would make the memo's cached
    // battle outcomes meaningless for the new format).
    cup: opts.cup ?? DEFAULTS.cup,
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
    // Both change what every generation's battles WEIGH (archetypeBeta feeds
    // both opponentWeights and consistencyScore; opponentFitnessNormalised
    // changes which ledger opponentFitness reads), so both are part of the
    // checkpoint fingerprint -- resuming under a different value would
    // silently graft a different fitness semantics onto a population
    // selected/mutated under the old one.
    archetypeBeta: opts.archetypeBeta ?? DEFAULTS.archetypeBeta,
    opponentFitnessNormalised: opts.opponentFitnessNormalised ?? DEFAULTS.opponentFitnessNormalised,
    // Changes what a composed opponent's lead IS, not just a weighting --
    // resuming under a different value would silently regenerate every
    // future opponent with a different lead policy than the ones already in
    // the pool. Part of the fingerprint for the same reason as the two above.
    randomOpponentLead: opts.randomOpponentLead ?? DEFAULTS.randomOpponentLead,
    // Fingerprint of the grouping/weighting semantics themselves (not a
    // knob): bumped 2026-09-09 when archetypeGroups moved from transitive
    // union-find to dominant-core-pair grouping and computeCandidateWeights
    // moved its clamp after mean-normalisation, so the v2 checkpoints
    // written under the old semantics start fresh instead of resuming.
    // Bumped again to v6 the same day when computeCandidateWeights switched
    // from species-share normalisation to the shared archetype-pair
    // crowding scheme (src/ga/core.js crowdingWeights) and opponent
    // selection started reading trailing-mean fitness instead of raw
    // single-generation fitness -- both change what a generation's numbers
    // MEAN, not just how they're computed, so a v5 checkpoint must not
    // resume under v6 semantics.
    // Bumped to v7 2026-09-10 when computeBlendFitness stopped returning an
    // unnormalized weighted sum (weights.winRate + consistency + snowball +
    // closer summing above 1 inflated blendFitness well past true winRate,
    // e.g. observed 90.5% blend vs 65.3% real winRate with
    // --snowball-weight 0.2 --closer-weight 0.1 --consistency-weight 0.1) --
    // now divides by the weight total, so a v6 checkpoint's elites were
    // selected under the inflated scale and must not resume under v7. Bumped
    // to v8 when shared weakness changed from an absolute severity-product
    // load with a fixed cap to rank-weighted top-200 exposure with simulated
    // lead counterplay; to v9 when the expensive matchup table was replaced
    // by selected-move type coverage; to v10 when the double lead/back-average
    // normalization (which structurally capped ordinary shared weaknesses
    // near a 0.8-0.95 score, indistinguishable from clean teams) was replaced
    // with per-shared-type risk terms normalized against a fixed global
    // worst case (the worst defensive typing PvPoke's chart can produce at
    // all, not each lead's own typing); to v11 when raw type prevalence (an
    // 18x top-to-bottom range in real top-200 data, e.g. Water at 1 vs Rock
    // at 0.055) was found to swamp the other three weights and was blended
    // down via PREVALENCE_INFLUENCE so a rare attacking type still costs most
    // of a common one's weight. Bumped to v12 2026-09-17 when
    // candidateStrengthGamma was added to weight each candidate's
    // contribution to an opponent's fitness by that candidate's own raw win
    // rate -- opponentFitness values under v11 are not comparable to v12's.
    // Bumped to v13 2026-09-18 (plans/WORKER_NOTES.md Item 2/3) when every
    // pairing started battling BOTH directions (candidate-as-A and
    // opponent-as-A, the latter mirrored back through mirrorBattleResult and
    // tallied identically) instead of only candidate-as-A -- removes the
    // measured ~1.9pt team-A seat bias structurally. battles/generation is
    // now 2 x population x opponents-per-gen, and the final elites pass
    // battles both directions too. v12 checkpoints have half as many battles
    // per pairing and a seat-biased fitness scale; they are not
    // resume-compatible.
    fitnessSemantics: FITNESS_SEMANTICS,
    opponentStrengthGamma: opts.opponentStrengthGamma ?? DEFAULTS.opponentStrengthGamma,
    candidateStrengthGamma: opts.candidateStrengthGamma ?? DEFAULTS.candidateStrengthGamma,
    snowballWeight: opts.snowballWeight ?? DEFAULT_FITNESS_WEIGHTS.snowball,
    closerWeight: opts.closerWeight ?? DEFAULT_FITNESS_WEIGHTS.closer,
    consistencyWeight: opts.consistencyWeight ?? DEFAULT_FITNESS_WEIGHTS.consistency,
    coreRivalry: opts.coreRivalry ?? DEFAULTS.coreRivalry,
    similarRivalry: opts.similarRivalry ?? DEFAULTS.similarRivalry,
    similarFloor: opts.similarFloor ?? DEFAULTS.similarFloor,
    // Canonicalize omitted and explicit zero weights. v7 already rejects
    // older scoring semantics; changing this weight must also reject resume.
    sharedWeaknessWeight: opts.sharedWeaknessWeight ?? DEFAULT_FITNESS_WEIGHTS.sharedWeakness,
    // Opponent-side equivalents of the four weights above (Jaxon 2026-09-17:
    // "add opponent side versions of the candidate side flags so that we can
    // have a symmetrical sim"). Same computeBlendFitness, same zero default
    // (an unconfigured run's opponent fitness is unchanged plain win rate),
    // fed the opponent's OWN ledger (see evaluateTeamsInOrder's opponentTally
    // extension) instead of a candidate's.
    opponentSnowballWeight: opts.opponentSnowballWeight ?? DEFAULT_FITNESS_WEIGHTS.snowball,
    opponentCloserWeight: opts.opponentCloserWeight ?? DEFAULT_FITNESS_WEIGHTS.closer,
    opponentConsistencyWeight: opts.opponentConsistencyWeight ?? DEFAULT_FITNESS_WEIGHTS.consistency,
    opponentSharedWeaknessWeight: opts.opponentSharedWeaknessWeight ?? DEFAULT_FITNESS_WEIGHTS.sharedWeakness,
    // GA-rate / convergence overrides enter the fingerprint ONLY when set:
    // they change what every generation computes, but leaving them out when
    // absent keeps every pre-flag checkpoint dir resumable.
    ...(opts.deathRate !== undefined ? { deathRate: opts.deathRate } : {}),
    ...(opts.mutationFloor !== undefined ? { mutationFloor: opts.mutationFloor } : {}),
    ...(opts.mutationCeil !== undefined ? { mutationCeil: opts.mutationCeil } : {}),
    ...(opts.mutationFloorStart !== undefined ? { mutationFloorStart: opts.mutationFloorStart } : {}),
    ...(opts.mutationCeilStart !== undefined ? { mutationCeilStart: opts.mutationCeilStart } : {}),
    ...(opts.opponentDeathRate !== undefined ? { opponentDeathRate: opts.opponentDeathRate } : {}),
    ...(opts.opponentMutationFloor !== undefined ? { opponentMutationFloor: opts.opponentMutationFloor } : {}),
    ...(opts.opponentMutationCeil !== undefined ? { opponentMutationCeil: opts.opponentMutationCeil } : {}),
    ...(opts.opponentMutationFloorStart !== undefined ? { opponentMutationFloorStart: opts.opponentMutationFloorStart } : {}),
    ...(opts.opponentMutationCeilStart !== undefined ? { opponentMutationCeilStart: opts.opponentMutationCeilStart } : {}),
    ...(opts.opponentImmigrantFraction !== undefined ? { opponentImmigrantFraction: opts.opponentImmigrantFraction } : {}),
    ...(opts.immigrantFraction !== undefined ? { immigrantFraction: opts.immigrantFraction } : {}),
    // Selection smoothing window (see the header note). Only-when-set, like
    // the rates above, so every pre-2026-09-05 checkpoint dir still resumes --
    // it then continues under the smoothed default from the resume point.
    ...(opts.selectionTrailing !== undefined ? { selectionTrailing: opts.selectionTrailing } : {}),
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

/**
 * Does a checkpoint's stored config describe the same run as this one?
 * `eliteCount` is still WRITTEN into every config (the report prints it) but
 * ignored here: it decides only how many last-generation teams enter the final
 * pass, never what a generation computes, so `--elites 30` must be able to
 * re-render a finished run's final pass without invalidating its checkpoints.
 * Stripping it on both sides keeps every older checkpoint (which stored it)
 * matching too.
 */
export function configsMatch(a, b) {
  const strip = ({ eliteCount, ...rest }) => rest;
  return JSON.stringify(strip(a ?? {})) === JSON.stringify(strip(b ?? {}));
}

/** Which config keys differ between a stale checkpoint and this run, for a resume-refusal error message. */
function describeConfigMismatch(stale, current) {
  const keys = new Set([...Object.keys(stale ?? {}), ...Object.keys(current ?? {})]);
  keys.delete('eliteCount');
  const diffs = [];
  for (const key of keys) {
    const a = (stale ?? {})[key];
    const b = (current ?? {})[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${key}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  }
  return diffs.length > 0 ? diffs.join(', ') : 'unknown difference';
}

/**
 * Guard for the one input the config fingerprint cannot see: the collection's
 * CONTENT. Candidate keys are `${speciesId}#${sourceRow}` (src/scoring), so a
 * checkpoint's population only means something against the exact CSV it was
 * bred from. The 2026-09-09 `meta-vs-meta-newseason-v3` resume crashed with
 * `Cannot read properties of undefined (reading 'speciesId')` because sim.sh
 * --meta rebuilt out/meta-collection-1500.csv from a newer vendor pin whose
 * rankings order had shifted: every `speciesId#row` still parsed, but pointed
 * at a different species' row. Two checks, either of which throws a message
 * naming the actual cause instead of an undefined-property crash:
 *
 *  1. `collectionHash` (sha256 of the CSV bytes, written into every
 *     checkpoint alongside `config`, NOT part of the fingerprint so pre-hash
 *     checkpoint dirs still resume) must match when the checkpoint has one.
 *  2. Every key in the population to resume must resolve in the freshly
 *     built candidate lookup (`deduped.builtMons`) to the same speciesId the
 *     key names -- the fallback for checkpoints written before the hash.
 *
 * @param {object} args
 * @param {string[][]} args.population - teams (member keys) to resume from
 * @param {Record<string, {speciesId: string}>} args.builtMons - the freshly built lookup
 * @param {string|undefined} args.checkpointHash - `collectionHash` from the checkpoint, if any
 * @param {string} args.collectionHash - sha256 of the CSV about to be used
 * @param {string} args.csvPath - for the error text
 * @throws {Error} when the collection no longer matches the checkpoint
 */
export function assertCollectionMatchesCheckpoint({ population, builtMons, checkpointHash, collectionHash, csvPath }) {
  const hint =
    `Candidate keys are speciesId#csvRow, so a run can only resume against the byte-identical ` +
    `collection it started from (${csvPath}). Restore that file (for --meta runs: the CSV built ` +
    `from the vendor pin the run launched under), or delete the checkpoints to start fresh.`;
  if (checkpointHash && checkpointHash !== collectionHash) {
    throw new Error(
      `evolve: collection changed since the checkpoint was written ` +
        `(checkpoint sha256 ${checkpointHash.slice(0, 12)}, current ${collectionHash.slice(0, 12)}). ${hint}`
    );
  }
  const stale = [];
  for (const team of population) {
    for (const key of team) {
      const speciesOfKey = key.slice(0, key.lastIndexOf('#'));
      const built = builtMons[key];
      if (!built || built.speciesId !== speciesOfKey) stale.push(key);
    }
  }
  if (stale.length > 0) {
    const distinct = [...new Set(stale)];
    throw new Error(
      `evolve: ${distinct.length} candidate key(s) in the checkpoint population no longer resolve in the ` +
        `collection (e.g. ${distinct.slice(0, 5).join(', ')}). ${hint}`
    );
  }
}

function hashFile(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

/**
 * Pre-baked start / cross-flag "resume": load generation 0's population and
 * opponent pool from ANOTHER run's checkpoint file (`--seed-from`) instead of
 * sampling fresh via initPopulation/initOpponentPool. This is deliberately
 * NOT a config-matching resume -- the whole point is to let a new run start
 * a few generations in with different flags (population size, curated-ratio,
 * mutation rates, even a different-but-similar collection), which the
 * strict `configsMatch` in-place resume (see the main resume scan above)
 * cannot do without silently overwriting the source checkpoints. Point
 * `--out-dir` at a NEW directory and `--seed-from` at the old run's
 * checkpoint you want to branch from (e.g.
 * `out/evolve-old/evolve-gen42.json`); the new run gets its own fresh
 * checkpoint chain from generation 0, seeded with that population.
 *
 * Species keys that no longer resolve against the CURRENT collection
 * (checked the same way `assertCollectionMatchesCheckpoint` does, but as a
 * per-team filter rather than a hard stop -- a "similar" seed collection is
 * expected to differ) are dropped; if the collection hash also differs this
 * is logged, not thrown, since seeding across collections is the point.
 * Short of the target count, `initPopulation` tops up the remainder;
 * long, the fittest are kept (by the checkpoint's own last-measured
 * fitness, oldest members with no fitness score sorted last).
 *
 * @param {object} params
 * @param {string} params.seedPath - path to a `evolve-gen<N>.json` checkpoint
 * @param {object} params.ctx - engine context (for rehydrateOpponentPool)
 * @param {object} params.deduped - this run's scored/deduped matrix
 * @param {string[]} params.pool - this run's candidate sampling pool
 * @param {Map<string,number>} params.weights
 * @param {number} params.populationCount - target gen-0 population size
 * @param {number} params.opponentCount - target gen-0 opponent pool size
 * @param {Array<object>} params.curatedPool
 * @param {string[]} params.candidateExcludeSpecies
 * @param {string} params.seed
 * @param {(msg:string)=>void} params.log
 * @returns {{population: string[][], opponentPool: object[]}}
 */
function seedFromCheckpoint({
  seedPath,
  ctx,
  deduped,
  pool,
  weights,
  populationCount,
  opponentCount,
  curatedPool,
  candidateExcludeSpecies,
  seed,
  log,
}) {
  if (!existsSync(seedPath)) {
    throw new Error(`evolve: --seed-from ${seedPath} does not exist`);
  }
  const cp = JSON.parse(readFileSync(seedPath, 'utf8'));
  if (cp.formatVersion !== CHECKPOINT_FORMAT_VERSION) {
    throw new Error(
      `evolve: --seed-from ${seedPath} is checkpoint format ${cp.formatVersion ?? '(unversioned)'} but this ` +
        `code expects format ${CHECKPOINT_FORMAT_VERSION}. Re-run the source simulation with current code first.`
    );
  }
  const seedPopulation = cp.nextPopulation ?? [];
  const valid = [];
  let dropped = 0;
  for (const team of seedPopulation) {
    const ok = team.every((key) => {
      const speciesOfKey = key.slice(0, key.lastIndexOf('#'));
      const built = deduped.builtMons[key];
      return built && built.speciesId === speciesOfKey;
    });
    if (ok) valid.push(team);
    else dropped += 1;
  }
  if (dropped > 0) {
    log(`evolve: --seed-from dropped ${dropped}/${seedPopulation.length} seed team(s) whose species no longer resolve in this collection`);
  }
  // `cp.fitness` is index-aligned to `cp.population` (the checkpoint's last-scored
  // generation), not `nextPopulation` -- look each seed team up by signature so
  // elites carried over unchanged land their real fitness; bred offspring with no
  // match (undefined) sort last, per this function's own JSDoc.
  const fitnessBySignature = new Map(
    (cp.population ?? []).map((team, i) => [teamSignature(team), cp.fitness?.[i]])
  );
  const sortedValid = [...valid].sort((a, b) => {
    const fa = fitnessBySignature.get(teamSignature(a));
    const fb = fitnessBySignature.get(teamSignature(b));
    if (fa === undefined && fb === undefined) return 0;
    if (fa === undefined) return 1;
    if (fb === undefined) return -1;
    return fb - fa;
  });
  let population = sortedValid.slice(0, populationCount);
  if (population.length < populationCount) {
    const topUp = initPopulation({
      matrix: deduped,
      pool,
      weights,
      count: populationCount - population.length,
      seed: `${seed}-seed-topup`,
      excludeSpecies: candidateExcludeSpecies,
    });
    population = [...population, ...topUp];
  }

  let opponentPool = cp.nextOpponentPool ? rehydrateOpponentPool(ctx, cp.nextOpponentPool, curatedPool, log) : [];
  if (opponentPool.length > opponentCount) {
    opponentPool = opponentPool.slice(0, opponentCount);
  } else if (opponentPool.length < opponentCount) {
    const fresh = initOpponentPool(ctx, {
      size: opponentCount - opponentPool.length,
      weights,
      curated: [],
      curatedRatio: 0,
      roleScores: undefined,
      movesetPool: undefined,
      seed: `${seed}-seed-opponent-topup`,
    }).filter(Boolean);
    opponentPool = [...opponentPool, ...fresh];
  }

  log(
    `evolve: seeded from ${seedPath} -- population ${population.length} (${valid.length} carried over), ` +
      `opponent pool ${opponentPool.length}`
  );
  return { population, opponentPool };
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
  const finalPath = checkpointPath(outDir, generation);
  // Write to a temp file then rename over the final path -- rename is atomic
  // on POSIX, so a SIGTERM (e.g. from earlyoom) landing mid-write can
  // only ever leave a stray .tmp file, never a truncated checkpoint that
  // readCheckpoint's catch-and-return-null would silently treat as absent.
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmpPath, finalPath);
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

// `poolSize` counts SPECIES, not keys: `deduped` may hold both a shadow and a
// non-shadow key of one species (dedupeBestPerSpecies with keepShadowVariants),
// and both ride along once the species makes the cut on its better key, so a
// shadow twin never crowds a different species out of the pool. The sampler
// (src/teams/sample.js buildScoredPool) still draws one key per species; the
// twin is reachable only through the GA's shadow-flip mutation.
function buildSamplingPool(deduped, poolSize, excludeSpecies) {
  const exclude = new Set(excludeSpecies);
  const scored = Object.keys(deduped.ratings)
    .filter((key) => !exclude.has(deduped.builtMons[key].speciesId))
    .map((key) => ({ key, speciesId: deduped.builtMons[key].speciesId, score: computeWeightedScore(deduped.ratings[key]) }))
    .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // No poolSize (--pool not passed) or <= 0 means no cap -- the whole
  // (deduped) collection.
  if (!poolSize || poolSize <= 0) return scored.map((m) => m.key);
  const keptSpecies = new Set();
  for (const m of scored) {
    if (keptSpecies.size >= poolSize && !keptSpecies.has(m.speciesId)) break;
    keptSpecies.add(m.speciesId);
  }
  return scored.filter((m) => keptSpecies.has(m.speciesId)).map((m) => m.key);
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
/** Arithmetic mean, 0 for an empty array (never NaN into a checkpoint). */
function mean(values) {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

/** Share of total opponent vote weight (archetype weight x strength) held by archetypes of size 1. */
function singletonVoteShare(groups, weights, strength) {
  const size = new Map();
  for (const g of groups) size.set(g, (size.get(g) ?? 0) + 1);
  let total = 0;
  let single = 0;
  groups.forEach((g, j) => {
    const w = weights[j] * (strength?.[j] ?? 1);
    total += w;
    if (size.get(g) === 1) single += w;
  });
  return total > 0 ? single / total : 0;
}

function computeOpponentAnalytics({ opponents, opponentFitness, opponentArchetypeGroups = null }) {
  const opponentOriginCounts = {};
  for (const o of opponents) opponentOriginCounts[o.origin ?? o.label ?? 'unknown'] = (opponentOriginCounts[o.origin ?? o.label ?? 'unknown'] ?? 0) + 1;
  const ranked = opponents
    .map((o, i) => ({ id: o.id, name: o.name, origin: o.origin ?? o.label ?? null, fitness: opponentFitness[i] ?? 0 }))
    .sort((a, b) => b.fitness - a.fitness);
  let archetypeCount = null;
  let maxArchetypeSize = null;
  if (opponentArchetypeGroups) {
    const sizeByGroup = new Map();
    for (const g of opponentArchetypeGroups) sizeByGroup.set(g, (sizeByGroup.get(g) ?? 0) + 1);
    archetypeCount = sizeByGroup.size;
    maxArchetypeSize = sizeByGroup.size ? Math.max(...sizeByGroup.values()) : 0;
  }
  return {
    opponentOriginCounts,
    opponentMeanFitness: opponentFitness.length
      ? opponentFitness.reduce((sum, f) => sum + f, 0) / opponentFitness.length
      : 0,
    opponentMaxFitness: opponentFitness.length ? Math.max(...opponentFitness) : 0,
    toughestOpponents: ranked.slice(0, TOUGHEST_OPPONENTS_CAP),
    archetypeCount,
    maxArchetypeSize,
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
    toughest: ranked.slice(0, FINAL_OPPONENT_POOL_REPORT_CAP),
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
/**
 * Per-candidate weight for frequency-normalised opponent fitness: the same
 * archetype-pair crowding scheme the opponent pool already uses to discount
 * a crowded bred core when IT votes on candidate fitness (src/meta/
 * archetypes.js archetypeGroups/archetypeWeights, via the shared
 * src/ga/core.js crowdingWeights), applied here to the candidate population
 * so a counter-bred opponent isn't rewarded N times over just for beating a
 * majority-share candidate core. Replaces the prior species-share scheme
 * (computeSpeciesShare/computeCandidateWeights, removed 2026-09-09) so both
 * voting sides normalise on one scheme instead of two.
 *
 * @param {object} matrix
 * @param {string[][]} population
 * @param {{beta?: number}} [opts]
 * @returns {number[]} weight per team, parallel to `population`.
 */
export function computeCandidateWeights(matrix, population, opts = {}) {
  return crowdingWeights(population, (team) => team.map((key) => ({ speciesId: matrix.builtMons[key].speciesId })), opts);
}

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
    originCounts.coreRivalryDied = lineage.coreRivalryDied?.length ?? 0;

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
      consistencyScore: r?.consistencyScore ?? null,
      sharedWeaknessScore: r?.sharedWeaknessScore ?? null,
      sharedWeaknessTypes: r?.sharedWeaknessTypes ?? [],
      archetypeCount: r?.archetypeCount ?? null,
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
 *   cache?: object, opponentWeights?: number[], candidateWeights?: number[],
 *   opponentArchetypeGroups?: number[], opponentStrengthGamma?: number,
 *   candidateStrengthGamma?: number, typeCoverageContext?: object,
 * }} params -- `opponentWeights[j]` (optional, parallel to `opponents`)
 *   weights opponent j's battles in each team's `winRate`; with
 *   `opponentStrengthGamma` > 0 (default 0 = off) that weight is further
 *   multiplied by (opponent j's own raw win rate against every team in this
 *   call)^gamma, so a vote from an opponent that barely wins anything counts
 *   for little and a vote from a strong one counts most -- computed from the
 *   same battles in a second pass, no extra fights; raw counts
 *   (`battles`, per-opponent tallies) are never weighted. `candidateStrengthGamma`
 *   (default 0 = off) is the symmetric term on the OTHER side of the same
 *   ledger: each opponent's `weightedWinPoints`/`weightedBattles` (below) is
 *   further scaled by (that candidate's own raw win rate across every
 *   opponent in this call)^gamma, so an opponent that only ever beats weak
 *   candidates doesn't outscore one that beat strong ones -- same second-pass
 *   shape as `opponentStrengthGamma`, no extra fights. `candidateWeights[i]`
 *   (optional, parallel to `teams`) weights team i's contribution to
 *   `opponentTally[j].weightedWinPoints`/`weightedBattles` (frequency-
 *   normalised opponent fitness, only ever passed from the per-generation
 *   loop -- the elites pass does not evolve opponents). `opponentArchetypeGroups[j]`
 *   (optional, parallel to `opponents`, from src/meta/archetypes.js) tags
 *   each `perMeta` entry with its opponent's archetype group id, so
 *   consistencyScore can be computed below. `sharedWeaknessWeight`
 *   (default 0) is the blend weight on src/teams/typeCoverage.js's per-team
 *   shared-weakness score, which is precomputed and reported when enabled.
 * @returns {Promise<{results:object[], opponentTally:Array<{winPoints:number, battles:number}>,
 *   opponentStrength:number[], battleCount:number, cachedCount:number, errorCount:number, elapsedMs:number,
 *   startedAt:number, finishedAt:number}>}
 *   `opponentTally[j]` is the CANDIDATE side's ledger against `opponents[j]`
 *   across every team battled -- src/meta/opponentPool.js turns it into that
 *   opponent's fitness (`1 - winPoints/battles`) at no extra battle cost.
 *   `battleCount` counts battles actually SIMULATED; `cachedCount` counts
 *   pairings served from the memo (both are reported, so a run's speedup is
 *   visible rather than implied).
 */
export async function evaluateTeamsInOrder(ctx, params) {
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
    candidateWeights = null,
    opponentArchetypeGroups = null,
    candidateArchetypeGroups = null,
    opponentStrengthGamma = 0,
    candidateStrengthGamma = 0,
    snowballWeight = 0,
    closerWeight = 0,
    consistencyWeight = 0,
    sharedWeaknessWeight = 0,
    typeCoverageContext = null,
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

  // ---- (1) plan: TWO cache keys per pairing (forward + reversed seats), in
  // flat battle order -- v13's fitness-symmetry fix (plans/WORKER_NOTES.md
  // Item 2). `planKeys[i]` is `{fwdKey, revKey}`; accumulate (step 3) walks
  // this same array in the same order so the two loops stay in lockstep.
  const planKeys = [];
  const pendingKeys = [];
  const pendingSpecs = [];
  const pendingBattles = []; // serial-mode inputs, parallel to pendingSpecs
  const queued = new Set();
  function enqueue(key, teamASpec, leadA, teamBSpec, leadB, teamAPokemon, teamBPokemon) {
    if (cache.get(key) !== undefined || queued.has(key)) return;
    queued.add(key);
    pendingKeys.push(key);
    pendingSpecs.push({ teamA: teamASpec, teamB: teamBSpec, leadA, leadB, difficulty });
    pendingBattles.push({ teamA: teamAPokemon, teamB: teamBPokemon, leadA, leadB });
  }
  for (const { members, teamASpec, oppPlans } of prepared) {
    const teamA = members.map((m) => m.pokemon);
    for (const { opp, pairings } of oppPlans) {
      const teamBSpec = opp.members.map((m) => m.spec);
      const teamB = opp.members.map((m) => m.pokemon);
      for (const { leadA, leadB } of pairings) {
        const fwdKey = cache.keyFor(teamASpec, leadA, teamBSpec, leadB, difficulty);
        const revKey = cache.keyFor(teamBSpec, leadB, teamASpec, leadA, difficulty);
        planKeys.push({ fwdKey, revKey });
        enqueue(fwdKey, teamASpec, leadA, teamBSpec, leadB, teamA, teamB);
        enqueue(revKey, teamBSpec, leadB, teamASpec, leadA, teamB, teamA);
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
  const opponentTally = opponents.map(() => ({
    winPoints: 0, battles: 0, weightedWinPoints: 0, weightedBattles: 0, exchangeWon: 0, exchangeLost: 0,
  }));
  // Mirror of `perMeta` (candidate side's per-opponent record), one entry per
  // candidate team an opponent actually fought, so consistencyScore is
  // computable symmetrically: "how does this opponent do against its worst
  // CANDIDATE archetype" (`candidateArchetypeGroups`, parallel to `teams`,
  // from src/meta/archetypes.js -- same grouping machinery, run over the
  // candidate population instead of the opponent pool).
  const opponentPerCandidate = opponents.map(() => []);
  let cursor = 0;
  const partials = [];
  for (let idx = 0; idx < prepared.length; idx++) {
    const { members, oppPlans } = prepared[idx];
    const candWeight = candidateWeights ? (candidateWeights[idx] ?? 1) : 1;

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
      let oppExchangeWon = 0; // this opponent's lead fainted the candidate's lead first
      let oppExchangeLost = 0; // ...candidate's lead fainted this opponent's lead first

      // Tally ONE battle result that already reads as "candidate is team A" --
      // called once for the forward result and once for the MIRRORED reversed
      // result (mirrorBattleResult above), so both directions run through
      // identical bookkeeping (v13 fitness-symmetry fix, plans/WORKER_NOTES.md
      // Item 2). Closes over this opp-loop iteration's oppWeight/oppWinPoints/
      // etc and the team-loop's members/winPoints/etc. Counts battles (no /2):
      // a pairing now contributes 2 to `battles`/`oppBattles`, which is what
      // makes battleCount per generation exactly 2 x population x opponents.
      function tallyBattle(r, leadA, leadB) {
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
        if (exchange === 'a') oppExchangeWon += 1;
        else if (exchange === 'b') oppExchangeLost += 1;
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

      for (const { leadA, leadB } of pairings) {
        const { fwdKey, revKey } = planKeys[cursor++];
        const fwdOutcome = outcomeFor(fwdKey);
        const revOutcome = outcomeFor(revKey);
        if (!fwdOutcome.ok && !revOutcome.ok) {
          errorCount += 1;
          candidateErrors += 1;
          onLog?.(
            `battle error (skipped, both directions failed): team=[${members.map((m) => m.name).join('/')}] ` +
              `opponent="${opp.name}" leadA=${leadA} leadB=${leadB}: ${fwdOutcome.message}`
          );
          continue;
        }
        if (!fwdOutcome.ok || !revOutcome.ok) {
          // Exactly one direction errored: drop the whole pairing (a
          // half-counted pairing would reintroduce the side bias this fix
          // removes) and log once.
          errorCount += 1;
          candidateErrors += 1;
          const failed = fwdOutcome.ok ? 'reversed' : 'forward';
          const message = fwdOutcome.ok ? revOutcome.message : fwdOutcome.message;
          onLog?.(
            `battle error (${failed} direction failed, pairing dropped): team=[${members.map((m) => m.name).join('/')}] ` +
              `opponent="${opp.name}" leadA=${leadA} leadB=${leadB}: ${message}`
          );
          continue;
        }

        if (fwdOutcome.cached) cachedCount += 1;
        else battleCount += 1;
        if (revOutcome.cached) cachedCount += 1;
        else battleCount += 1;

        tallyBattle(fwdOutcome.value, leadA, leadB);
        tallyBattle(mirrorBattleResult(revOutcome.value), leadA, leadB);
      }

      if (oppBattles > 0) {
        opponentTally[oppIndex].winPoints += oppWinPoints;
        opponentTally[oppIndex].battles += oppBattles;
        opponentTally[oppIndex].weightedWinPoints += oppWinPoints * candWeight;
        opponentTally[oppIndex].weightedBattles += oppBattles * candWeight;
        opponentTally[oppIndex].exchangeWon += oppExchangeWon;
        opponentTally[oppIndex].exchangeLost += oppExchangeLost;
        opponentPerCandidate[oppIndex].push({
          archetypeGroup: candidateArchetypeGroups ? candidateArchetypeGroups[idx] ?? null : null,
          winRate: 1 - oppWinPoints / oppBattles, // this opponent's OWN win rate against this candidate
          strength: 1,
          // For the candidateStrengthGamma second pass below: this candidate's
          // index (to look up its own raw win rate once every opponent it
          // fought is known), its frequency weight, and this pair's raw tally.
          idx,
          candWeight,
          oppWinPoints,
          oppBattles,
        });
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
          archetypeGroup: opponentArchetypeGroups ? opponentArchetypeGroups[oppIndex] ?? null : null,
          oppIndex,
          oppWeight,
          strength: 1,
        });
      }
    }

    partials.push({
      members, perMeta, winPoints, weightedWinPoints, weightedBattles, hpSum, battles, candidateErrors,
      exchangeWon, exchangeLost, winsGivenExchangeWon, winsGivenExchangeLost,
      leadWins, leadBattles, swapHpSum, swapHpCount,
    });
  }

  // ---- (4) score: second pass, once every opponent's own win rate is known --
  // Opponent j's strength = its raw win rate against every team battled here
  // (the candidate side of the ledger inverted; same battles, no new ones).
  const opponentStrength = opponentTally.map((t) =>
    opponentStrengthGamma > 0 && t.battles > 0 ? Math.pow(Math.max(0, 1 - t.winPoints / t.battles), opponentStrengthGamma) : 1
  );
  // Symmetric candidate j's strength = its own raw win rate across every
  // opponent it fought here (the OTHER side of the same ledger opponentStrength
  // reads, unweighted, no new battles). Feeds the opponentTally reweight just
  // below, mirroring how opponentStrength feeds the candidate reweight further
  // down -- without it, only candidate fitness was discounted for cheap wins
  // over weak opposition; opponent fitness had no equivalent discount.
  const candidateStrength = partials.map((p) =>
    candidateStrengthGamma > 0 && p.battles > 0 ? Math.pow(Math.max(0, p.winPoints / p.battles), candidateStrengthGamma) : 1
  );
  if (candidateStrengthGamma > 0) {
    opponentTally.forEach((t, j) => {
      let sp = 0;
      let sb = 0;
      for (const p of opponentPerCandidate[j]) {
        const w = p.candWeight * candidateStrength[p.idx];
        sp += w * p.oppWinPoints;
        sb += w * p.oppBattles;
      }
      // Every candidate this opponent fought scored strength 0 (impossible
      // today -- strength 0 needs battles > 0 and a 0 win rate, which is a
      // valid state): fall back to the frequency-only weighting already
      // accumulated above rather than a 0/0 fitness.
      if (sb > 0) {
        t.weightedWinPoints = sp;
        t.weightedBattles = sb;
      }
    });
  }
  // Opponent-side battle-reality terms, symmetric with the candidate ones
  // above -- same helper functions, same OwnLeadPairing convention
  // (`opp.members[0]` is the opponent's own designated lead), just fed this
  // opponent's own ledger instead of a candidate's. Cheap: no extra battles,
  // closerScore/sharedWeaknessScore are pure roster lookups and
  // snowballScore/consistencyScore only re-read tallies this same pass
  // already accumulated.
  opponentTally.forEach((t, j) => {
    const oppWinRate = t.battles > 0 ? 1 - t.winPoints / t.battles : 0.5;
    t.winRate = oppWinRate;
    t.snowballScore = computeSnowballScore(t.exchangeWon, t.exchangeLost, oppWinRate);
    t.closerScore = computeCloserScore(opponents[j].members, roleScores);
    const sharedWeakness = typeCoverageContext
      ? computeSharedWeaknessScore(opponents[j].members, typeCoverageContext)
      : { score: null };
    t.sharedWeaknessScore = sharedWeakness.score;
    t.consistencyScore = computeConsistencyScore(opponentPerCandidate[j], oppWinRate).consistencyScore;
  });
  const results = [];
  for (const partial of partials) {
    const { members, perMeta, hpSum, battles, winPoints, candidateErrors, exchangeWon, exchangeLost,
      winsGivenExchangeWon, winsGivenExchangeLost, leadWins, leadBattles, swapHpSum, swapHpCount } = partial;
    let { weightedWinPoints, weightedBattles } = partial;
    if (opponentStrengthGamma > 0) {
      let sp = 0;
      let sb = 0;
      for (const p of perMeta) {
        p.strength = opponentStrength[p.oppIndex];
        const w = p.oppWeight * p.strength;
        const oppBattles = p.wins + p.losses + p.ties;
        sp += w * (p.wins + 0.5 * p.ties);
        sb += w * oppBattles;
      }
      // Every opponent lost everything (strength 0 across the board): fall
      // back to the archetype-weighted mean rather than 0/0.
      if (sb > 0) {
        weightedWinPoints = sp;
        weightedBattles = sb;
      }
    }
    for (const p of perMeta) {
      p.oppIndex = undefined;
      p.oppWeight = undefined;
    }

    // With no opponentWeights every oppWeight is 1 and this IS winPoints/battles.
    const winRate = weightedBattles > 0 ? weightedWinPoints / weightedBattles : 0;
    // Unweighted candidate win rate (plans/WORKER_NOTES.md Item 1): the same
    // ledger's `winPoints`/`battles` before any archetype/strength weighting,
    // parallel to `opponentTally[j].winRate` (also raw) below. Feeds
    // `candidateRawWinRateMean` so the two sides' raw means can be compared
    // like-for-like instead of one raw, one weighted.
    const rawWinRate = battles > 0 ? winPoints / battles : 0;
    const avgHpMargin = battles > 0 ? hpSum / battles : 0;
    const snowballScore = computeSnowballScore(exchangeWon, exchangeLost, winRate);
    const closerScore = computeCloserScore(members, roleScores);
    const sharedWeakness = typeCoverageContext
      ? computeSharedWeaknessScore(members, typeCoverageContext)
      : { score: null, sharedTypes: [] };
    const { consistencyScore, archetypeWinRates } = computeConsistencyScore(perMeta, winRate);
    const entry = {
      members: members.map((m) => ({ key: m.key, speciesId: m.speciesId, name: m.name, ...reportMemberDetail(m) })),
      buildCost: teamBuildCost(members),
      winRate,
      rawWinRate,
      avgHpMargin,
      battles,
      errors: candidateErrors,
      consistencyScore,
      archetypeCount: archetypeWinRates.length,
      // Battle-reality fitness components,
      // always computed (cheap) regardless of --fitness so the report can
      // surface them even in classic mode.
      exchangeWon,
      exchangeLost,
      snowballScore,
      closerScore,
      sharedWeaknessScore: sharedWeakness.score,
      sharedWeaknessTypes: sharedWeakness.sharedTypes,
      blendFitness: computeBlendFitness(
        { winRate, snowballScore, closerScore, consistencyScore, sharedWeaknessScore: sharedWeakness.score },
        {
          ...DEFAULT_FITNESS_WEIGHTS,
          snowball: snowballWeight,
          closer: closerWeight,
          consistency: consistencyWeight,
          sharedWeakness: sharedWeaknessWeight,
        }
      ),
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
    opponentStrength,
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
function finalPassDescription(eo, rk) {
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
function stratumLine(byStratum) {
  if (!byStratum) return '';
  const order = ['curated', 'archive', 'fresh'];
  const keys = [...order.filter((k) => k in byStratum), ...Object.keys(byStratum).filter((k) => !order.includes(k))];
  return keys.map((k) => `${k} ${pct(byStratum[k].winRate)} (${byStratum[k].battles})`).join(' · ');
}

function sharedWeaknessLine(sharedTypes) {
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
 *   fixedOpponents?:boolean,
 *   eliteCount?:number, - last-generation teams sent to the final pass (by
 *     trailing-mean fitness); written into the config but ignored by
 *     configsMatch, so it may change on a re-render.
 *   selectionTrailing?:number, - generations each team's fitness is averaged
 *     over (recency-weighted, see trailingFitness) before the cull/mutation
 *     ranking and the finalist pick (default DEFAULT_SELECTION_TRAILING; 1 =
 *     rank on the single generation, the pre-2026-09-05 behavior).
 *     Only-when-set fingerprint rule.
 *   finalArchive?:number, finalFresh?:number, - final-pass held-out strata
 *     sizes (see buildOpponentArchive / composeFreshOpponents; finalArchive
 *     defaults from DEFAULTS, finalFresh from finalFreshDefault -- 0 normally,
 *     a small nonzero fallback only at --curated-ratio 0). NOT in the
 *     fingerprint: they change only the final pass.
 *   deathRate?:number, mutationFloor?:number, mutationCeil?:number,
 *   immigrantFraction?:number, - candidate-side GA rate overrides, forwarded
 *     to nextGeneration; in the checkpoint fingerprint ONLY when set.
 *   mutationFloorStart?:number, mutationCeilStart?:number, - hot-start
 *     mutation rates at generation 0, annealed linearly to the standard
 *     floor/ceil by the last allowed generation (see mutationRatesAt); same
 *     only-when-set fingerprint rule.
 *   opponentDeathRate?:number, - opponent-side cull fraction (evolvable
 *     entries only), forwarded to nextOpponentPool; only-when-set fingerprint.
 *   opponentMutationFloor?:number, opponentMutationCeil?:number,
 *   opponentMutationFloorStart?:number, opponentMutationCeilStart?:number,
 *     - opponent-side mutation rates and hot-start anneal, forwarded to
 *     nextOpponentPool (see opponentMutationRatesAt); same only-when-set
 *     fingerprint rule.
 *   opponentImmigrantFraction?:number, - opponent-side fresh-immigrant share
 *     of the evolvable portion, forwarded to nextOpponentPool; same
 *     only-when-set fingerprint rule.
 *   convWindow?:number, convTopN?:number, - convergence window / top-set-size
 *     overrides for hasConverged; same only-when-set fingerprint rule.
 *   populationFinalRatio?:number, - candidate population at the last
 *     generation, as a fraction of `population` (see populationAt).
 *   opponentMetaPool?:number, - top-N species cap on the composed half of the
 *     opponent pool (see src/meta/sampleTeams.js).
 *   battleCache?:boolean, - memoize identical pairings (default true).
 *   profile?:boolean, - capture per-worker CPU profiles into outDir on a
 *     clean exit (default false; no-op without threads). Also gates a live
 *     per-generation poll (see parallel.js's executor.stats()): with
 *     --profile, every generation's log line adds each worker's current+peak
 *     heap, scenario-memo size, and mon-cache size, for mid-run memory/speed
 *     debugging -- off by default so a normal run pays nothing for it.
 *     Process RSS is logged every generation regardless of this flag.
 *     NOT part of the checkpoint fingerprint (pure performance knob).
 *   deadlineMinutes?:number, - simple stop-before-next-generation budget;
 *     NOT part of the checkpoint config fingerprint (see buildRunConfig).
 *   threads?:number, - when set, ONE persistent
 *     src/engine/parallel.js createExecutor() pool is booted for the WHOLE
 *     run and reused across every generation AND the final elites pass.
 *     Omitted/falsy keeps the serial battleTeams loop. NOT part of the
 *     checkpoint fingerprint (pure performance knob).
 *   seedFrom?:string, - path to another run's `evolve-gen<N>.json` checkpoint
 *     to seed generation 0's population and opponent pool from, instead of
 *     initPopulation/initOpponentPool sampling fresh (pre-baked start / a
 *     "resume with different flags" -- point --out-dir at a new directory
 *     and --seed-from at the old run's checkpoint; see seedFromCheckpoint).
 *     Ignored once an in-place config-matching checkpoint resume applies.
 *   forceFresh?:boolean, - allow starting fresh in an --out-dir whose
 *     evolve-gen0.json config doesn't match this run (discarding it),
 *     instead of the default hard error (see the resume-refusal check).
 *   outDir?:string, out?:string, - out = Markdown report path.
 *   html?:string, noHtml?:boolean, - HTML report path (default
 *     <outDir>/my-teams-evolve.html) and an opt-out (mirrors src/cli.js's
 *     --html/--no-html).
 *   onProgress?:(p:{generation:number, completed:number, total:number, startedAt:number})=>void,
 *   onLog?:(msg:string)=>void,
 * }} [opts]
 * @returns {Promise<object>} the full run result; also written to disk.
 */
/**
 * Everything a meta-vs-meta run needs before its first battle: collection
 * import, evolution expansion, cup eligibility, the 1v1 scoring matrix, the
 * candidate sampling pool, and the opponent side's curated/moveset pools and
 * (optional) shared-weakness context -- exactly the block `runEvolution` used
 * to inline before its generation loop. Extracted (plans/WORKER_NOTES.md
 * Item 3) so a study script can build the SAME gen-0 population/opponent-pool
 * inputs `runEvolution` would, via `initPopulation`/`initOpponentPool`,
 * without reimplementing any of this setup. `runEvolution` itself now just
 * calls this and destructures.
 *
 * @param {string} csvPath
 * @param {object} [opts] - same shape runEvolution accepts.
 * @returns {Promise<object>} every local this block used to produce, keyed
 *   by name (config, outDir, log, ctx, matrix, deduped, pool, curatedPool,
 *   movesetPool, typeCoverageContext, roleScores, opponentLeadRoleScores,
 *   weights, similarity, league, difficulty, collectionHash, importWarnings,
 *   candidateExcludeSpecies, banBaseIds, battleCache, threads, deadlineMs,
 *   reportPath, writeHtml, htmlPath).
 */
export async function buildEvolveSetup(csvPath, opts = {}) {
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

  log(`evolve: starting (collection=${config.csvPath}, cp=${config.cp}, cup=${config.cup}, out-dir=${outDir}, report=${reportPath})`);

  const { mons: importedMons, warnings: importWarnings } = importCollection(csvPath, { cp: config.cp });
  // Written into every checkpoint (not the fingerprint) so a resume against a
  // rewritten CSV fails with a real message -- see assertCollectionMatchesCheckpoint.
  const collectionHash = hashFile(csvPath);
  const ctx = await initEngine({ cp: config.cp, cup: config.cup });
  // One pvpoke similarity scorer (memoised per species/moveset pair) shared by both GAs' core rivalry.
  const similarity = createSimilarity();
  const league = resolveFormat({ cp: config.cp, cup: config.cup });
  // Same expansion src/cli.js does: each mon also competes as anything it can
  // evolve into, so the GA can pick a form you don't own yet. Part of the run
  // config below, so flipping it starts a new checkpoint rather than resuming
  // one whose population was bred from a different candidate pool.
  const expanded = config.evolutions
    ? expandEvolutions(ctx, importedMons)
    : { mons: importedMons, warnings: [] };
  // Same cup eligibility filter src/cli.js applies, always after evolution
  // expansion (see src/util/eligibility.js's header for why order matters).
  const eligible = filterEligibleMons(ctx, expanded.mons);
  const mons = eligible.mons;
  const matrix = scoreCollection(ctx, mons, { metaLimit: config.scoreMeta });
  // keepShadowVariants: the GA's shadow-flip mutation needs both the shadow and
  // the non-shadow specimen of a species on hand to swap between; the sampler
  // itself still sees one key per species (see buildSamplingPool).
  const deduped = dedupeBestPerSpecies(matrix, { keepShadowVariants: true });
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
  // Fed to composeSampledOpponent (initOpponentPool/nextOpponentPool/
  // composeFreshOpponents) only -- omitting roleScores there makes
  // pickLeadIndex fall back to a uniform-random lead (src/meta/sampleTeams.js),
  // matching the candidate side's assignLead/buildLeadRotation. `roleScores`
  // itself stays real everywhere else (evaluateTeamsInOrder's closer score is
  // a separate, already-symmetric fitness term).
  const opponentLeadRoleScores = config.randomOpponentLead ? null : roleScores;
  // The opponent side's two fixed inputs, both loaded once for the whole run:
  // every curated team for this CP cap (the pool the opponent GA's protected
  // entries are drawn from, and the opponent set the final elites pass uses in
  // full), and the meta-capped species pool composed teams are built out of.
  // Both are filtered by --ban here, once, so every downstream use (the
  // per-generation opponent pool AND the final elites pass for curatedPool;
  // initOpponentPool/nextOpponentPool and their mutation/immigrant draws for
  // movesetPool) sees an already-clean pool -- see the --ban helpers above.
  const curatedPool = filterBannedCuratedTeams(loadMetaTeams(ctx), banBaseIds);
  // Under a cup (or a heavy --ban) the curated set can filter down to nothing.
  // Treat that exactly like an explicit --curated-ratio 0: every downstream
  // read of config.curatedRatio (initOpponentPool, nextOpponentPool,
  // finalFreshDefault, the final elites pass) sees the forced value, since
  // they all read this same config object.
  if (curatedPool.length === 0 && config.curatedRatio > 0) {
    log(
      `evolve: curated opponent pool is empty after cup/ban filtering -- forcing curated-ratio 0 for this run ` +
        `(was ${config.curatedRatio})`
    );
    config.curatedRatio = 0;
  }
  const movesetPool = filterBannedMovesetPool(
    loadMovesetPool(ctx, { metaPoolSize: config.opponentMetaPool }),
    banBaseIds
  );
  // Shared weakness is opt-in, so its cheap top-200 type/moveset table is
  // built only when it can affect selection. No additional battles run here.
  let typeCoverageContext = null;
  if (config.sharedWeaknessWeight > 0) {
    const coverageEntries = loadMovesetPool(ctx, { metaPoolSize: TYPE_COVERAGE_META_SIZE });
    log(
      `evolve: building shared-weakness context -- ${Object.keys(deduped.builtMons).length} candidate movesets ` +
        `against ${coverageEntries.length} PvPoke-ranked type profiles (no battles)`
    );
    typeCoverageContext = buildTypeCoverageContext(ctx, deduped.builtMons, coverageEntries, weights);
  }
  const battleCache = opts.battleCache === false ? createNullBattleCache() : createBattleCache(BATTLE_CACHE_MAX_ENTRIES);
  log(
    `evolve: shared setup done -- ${matrix.mons.length} mons scored, sampling pool of ${pool.length} species, ` +
      `${curatedPool.length} curated opponent teams, opponent meta pool of ${movesetPool.length} species, league=${league.name}`
  );

  return {
    config, outDir, reportPath, writeHtml, htmlPath, log, difficulty, threads, deadlineMs,
    importedMons, importWarnings, expanded, eligible, collectionHash, ctx, similarity, league, matrix, deduped, weights,
    banBaseIds, candidateExcludeSpecies, pool, roleScores, opponentLeadRoleScores,
    curatedPool, movesetPool, typeCoverageContext, battleCache,
  };
}

export async function runEvolution(csvPath, opts = {}) {
  const {
    config, outDir, reportPath, writeHtml, htmlPath, log, difficulty, threads, deadlineMs,
    importedMons, importWarnings, expanded, eligible, collectionHash, ctx, similarity, league, matrix, deduped, weights,
    candidateExcludeSpecies, pool, roleScores, opponentLeadRoleScores,
    curatedPool, movesetPool, typeCoverageContext, battleCache,
  } = await buildEvolveSetup(csvPath, opts);

  const threaded = typeof threads === 'number' && threads > 0;
  const profileDir = opts.profile ? outDir : undefined;
  const executor = threaded
    ? createExecutor({ threads, vendorRoot: ctx.vendorRoot, continueOnError: true, profileDir, cp: ctx.cp, cup: ctx.cup })
    : null;

  try {
    return await runLoop();
  } finally {
    if (executor) {
      const stats = await executor.close();
      if (profileDir && stats.length > 0) {
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
    }
  }

  async function runLoop() {
    // ---- Resume scan: generation 0, 1, 2, ... while each checkpoint's config matches. ----
    let generation = 0;
    let population = null;
    let runStartedAtMs = null;
    let opponentPool = null; // live (rehydrated or freshly built) opponent entries for the NEXT generation
    const history = []; // [{population, fitness}], oldest-first -- for hasConverged
    // Opponent-side analog of `history`, entries shaped {id} (not the full
    // OpponentEntry -- only the id, which trailingFitnessGeneric's signature
    // adapter reads, needs to survive) so opponent selection can be smoothed
    // over the same trailing-mean window the candidate side already used
    // (src/ga/core.js trailingFitnessGeneric; see FITNESS_SEMANTICS v6).
    const opponentHistory = [];
    const generationRecords = []; // full per-generation records for the report
    let checkpointHash; // `collectionHash` of the last matching checkpoint (see assertCollectionMatchesCheckpoint)

    while (true) {
      const cp = readCheckpoint(outDir, generation);
      if (!cp || !configsMatch(cp.config, config)) break;
      checkpointHash = cp.collectionHash;
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
      opponentHistory.push({ population: cp.opponentPool.map((e) => ({ id: e.id })), fitness: cp.opponentFitness });
      generationRecords.push({ ...cp, resumed: true });
      if (generation === 0) runStartedAtMs = new Date(cp.runStartedAt).getTime();
      population = cp.nextPopulation;
      opponentPool = cp.nextOpponentPool ? rehydrateOpponentPool(ctx, cp.nextOpponentPool, curatedPool, log) : null;
      generation += 1;
      // MEMORY: apply the same per-generation trim the live loop applies below
      // (see the "only the newest record's population is ever read back out"
      // comment there) -- otherwise a resume pins every resumed generation's
      // full population/lineage/opponent-pool arrays for the rest of the run,
      // and an OOM-kill-then-resume cycle re-inflates this from scratch.
      const supersededOnResume = generationRecords[generationRecords.length - 2];
      if (supersededOnResume) {
        supersededOnResume.population = null;
        supersededOnResume.nextPopulation = null;
        supersededOnResume.lineage = null;
        supersededOnResume.opponentLineage = null;
        supersededOnResume.nextOpponentPool = null;
      }
      // Same historyLookback trim the live loop applies (see its comment below) --
      // `history` is rebuilt from checkpoints here too, so it needs the identical bound.
      const convergenceTrailingOnResume = config.convergence?.trailing ?? DEFAULT_CONVERGENCE_TRAILING;
      const convergenceWindowOnResume = config.convergence?.window ?? DEFAULT_CONVERGENCE_WINDOW;
      const historyLookbackOnResume =
        Math.max(selectionTrailingOf(config), convergenceWindowOnResume + 2 * convergenceTrailingOnResume - 2) + 5;
      const staleHistoryIdxOnResume = history.length - 1 - historyLookbackOnResume;
      if (staleHistoryIdxOnResume >= 0 && history[staleHistoryIdxOnResume].population) {
        history[staleHistoryIdxOnResume].population = null;
      }
      const staleOpponentHistoryIdxOnResume = opponentHistory.length - 1 - historyLookbackOnResume;
      if (staleOpponentHistoryIdxOnResume >= 0 && opponentHistory[staleOpponentHistoryIdxOnResume].population) {
        opponentHistory[staleOpponentHistoryIdxOnResume].population = null;
      }
    }

    if (generation === 0) {
      const stale = readCheckpoint(outDir, 0);
      if (stale && !configsMatch(stale.config, config) && !opts.forceFresh) {
        throw new Error(
          `evolve: ${checkpointPath(outDir, 0)} exists but its config doesn't match this run's flags ` +
            `(${describeConfigMismatch(stale.config, config)}). Refusing to overwrite it. ` +
            `A config change can't resume in place -- use a different --out-dir (optionally with ` +
            `--seed-from ${checkpointPath(outDir, 0)} to carry its population over), ` +
            `or pass --force-fresh to discard this directory's checkpoints and start over here.`
        );
      }
    }

    if (generation > 0) {
      assertCollectionMatchesCheckpoint({
        population,
        builtMons: deduped.builtMons,
        checkpointHash,
        collectionHash,
        csvPath: config.csvPath,
      });
      log(`evolve: resuming -- ${generation} generation(s) already complete (config matches)`);
    } else if (opts.seedFrom) {
      runStartedAtMs = Date.now();
      ({ population, opponentPool } = seedFromCheckpoint({
        seedPath: opts.seedFrom,
        ctx,
        deduped,
        pool,
        weights,
        populationCount: populationAt(0, config),
        opponentCount: opponentsAt(0, config),
        curatedPool,
        candidateExcludeSpecies,
        seed: config.seed,
        log,
      }));
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
        roleScores: opponentLeadRoleScores,
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
      // Archetype grouping over THIS generation's opponent pool (see
      // src/meta/archetypes.js) -- crowded bred cores get discounted both as
      // opponents (below, opponentWeights) and, symmetrically, as the
      // divisor in each candidate's consistencyScore inside
      // evaluateTeamsInOrder.
      const oppArchetypeGroups = archetypeGroups(opponents);
      const oppArchetypeWeights = archetypeWeights(oppArchetypeGroups, { beta: config.archetypeBeta });
      const candidateWeights = computeCandidateWeights(deduped, population, { beta: config.archetypeBeta });
      // Mirror of oppArchetypeGroups, over the CANDIDATE population, so the
      // opponent side's consistencyScore ("how does this opponent do against
      // its worst candidate archetype") can be computed symmetrically below.
      const candArchetypeGroups = archetypeGroups(
        population.map((keys) => ({ members: keys.map((key) => ({ speciesId: deduped.builtMons[key].speciesId })) }))
      );
      log(
        `generation ${generation}: battling ${population.length} teams against ${opponents.length} opponents ` +
          `(${curatedInPool} curated, ${opponents.length - curatedInPool} evolved); ` +
          `${new Set(oppArchetypeGroups).size} opponent archetypes, ` +
          `candidate weight min ${Math.min(...candidateWeights).toFixed(2)} / max ${Math.max(...candidateWeights).toFixed(2)}`
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
        opponentWeights: oppArchetypeWeights,
        candidateWeights: config.opponentFitnessNormalised ? candidateWeights : null,
        opponentArchetypeGroups: oppArchetypeGroups,
        candidateArchetypeGroups: candArchetypeGroups,
        opponentStrengthGamma: config.opponentStrengthGamma,
        candidateStrengthGamma: config.candidateStrengthGamma,
        snowballWeight: config.snowballWeight,
        closerWeight: config.closerWeight,
        consistencyWeight: config.consistencyWeight,
        sharedWeaknessWeight: config.sharedWeaknessWeight,
        typeCoverageContext,
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
      // Frequency-normalised (config.opponentFitnessNormalised, default on):
      // uses each candidate's C1 weight so an opponent isn't rewarded N x for
      // beating a majority-share core; falls back to the raw ledger when a
      // tally has no weighted battles (candidateWeights omitted, or --no-
      // opponent-fitness-normalised).
      // Same array's own inputs, captured alongside opponentFitness so
      // `opponentWeightedWinRateMean` (plans/WORKER_NOTES.md Item 1) reads the
      // exact win rate this side's fitness/selection was built from, not a
      // re-derivation.
      const opponentWeightedWinRate = [];
      const opponentFitness = run.opponentTally.map((t) => {
        const oppWinRate =
          config.opponentFitnessNormalised && t.weightedBattles > 0
            ? 1 - t.weightedWinPoints / t.weightedBattles
            : t.battles > 0
              ? 1 - t.winPoints / t.battles
              : 0.5;
        opponentWeightedWinRate.push(oppWinRate);
        // Symmetric with the candidate blend above -- same computeBlendFitness,
        // same DEFAULT_FITNESS_WEIGHTS shape, opponent-only weight flags
        // (--opponent-snowball-weight etc, 0 by default so an unconfigured
        // run's opponent fitness is unchanged from plain win rate).
        return computeBlendFitness(
          {
            winRate: oppWinRate,
            snowballScore: t.snowballScore,
            closerScore: t.closerScore,
            consistencyScore: t.consistencyScore,
            sharedWeaknessScore: t.sharedWeaknessScore,
          },
          {
            ...DEFAULT_FITNESS_WEIGHTS,
            snowball: config.opponentSnowballWeight,
            closer: config.opponentCloserWeight,
            consistency: config.opponentConsistencyWeight,
            sharedWeakness: config.opponentSharedWeaknessWeight,
          }
        );
      });

      history.push({ population, fitness });
      opponentHistory.push({ population: opponents.map((e) => ({ id: e.id })), fitness: opponentFitness });
      // MEMORY: trailingFitness/hasConverged only ever look back a bounded
      // number of generations from the current newest entry (selection's own
      // trailing window, or convergence's baseline scan) -- once an entry
      // falls further behind the newest than the widest of those lookbacks
      // will ever reach, it can never be dereferenced again by any later
      // iteration either (the lookback windows are fixed, the newest index
      // only moves forward). hasConverged's baseline scan reaches back
      // window + 2*trailing - 2 generations (eliteSnapshot's smoothedScores
      // call at the oldest baseline generation itself looks back `trailing`
      // more) -- retaining only trailing+window drops entries it still reads,
      // throwing on `history[g].population.map(...)`. +5 is slack for any
      // smaller custom windows a flag might set. Past that, `.population` is
      // dead weight -- same unbounded-growth shape as generationRecords above.
      const convergenceTrailing = config.convergence?.trailing ?? DEFAULT_CONVERGENCE_TRAILING;
      const convergenceWindow = config.convergence?.window ?? DEFAULT_CONVERGENCE_WINDOW;
      const historyLookback =
        Math.max(selectionTrailingOf(config), convergenceWindow + 2 * convergenceTrailing - 2) + 5;
      const staleHistoryIdx = history.length - 1 - historyLookback;
      if (staleHistoryIdx >= 0 && history[staleHistoryIdx].population) history[staleHistoryIdx].population = null;
      const staleOpponentHistoryIdx = opponentHistory.length - 1 - historyLookback;
      if (staleOpponentHistoryIdx >= 0 && opponentHistory[staleOpponentHistoryIdx].population) {
        opponentHistory[staleOpponentHistoryIdx].population = null;
      }
      // Selection ranks on each team's trailing mean, not this generation's
      // draw (see the header note) -- a pure function of `history`, so a
      // resumed run computes exactly the same values.
      const selectionFitness = trailingFitness(history, selectionTrailingOf(config));
      // Same trailing-mean smoothing, now applied to the opponent side too
      // (FITNESS_SEMANTICS v6): an opponent's single-generation fitness is
      // just as noisy a draw as a candidate's (see trailingFitness's header
      // for the s2 post-mortem numbers), so opponent selection reads its
      // trailing mean rather than raw `opponentFitness` -- matched across
      // generations by id (positional/lead-aware, stable across
      // rehydrateOpponentPool).
      const opponentSelectionFitness = trailingFitnessGeneric(
        opponentHistory,
        (e) => e.id,
        selectionTrailingOf(config),
        DEFAULT_SELECTION_RECENCY_DECAY
      );
      const isLastAllowedGeneration = generation === config.generations - 1;

      let lineage = null;
      let nextPopulation = [];
      let opponentLineage = null;
      let nextOpponents = [];
      if (!isLastAllowedGeneration) {
        const advanced = nextGeneration({
          population,
          fitness: selectionFitness,
          pool,
          matrix: deduped,
          weights,
          seed: `${config.seed}-next${generation}`,
          opts: {
            excludeSpecies: candidateExcludeSpecies,
            targetSize: populationAt(generation + 1, config),
            deathRate: config.deathRate,
            // Annealed per generation (constant when no start value is set)
            // -- see mutationRatesAt.
            ...mutationRatesAt(generation, config),
            immigrantFraction: config.immigrantFraction,
            coreRivalry: config.coreRivalry,
            similarRivalry: config.similarRivalry,
            similarFloor: config.similarFloor,
            similarity,
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
            fitness: opponentSelectionFitness,
            targetSize: opponentsAt(generation + 1, config),
            weights,
            curated: curatedPool,
            curatedRatio: config.curatedRatio,
            roleScores: opponentLeadRoleScores,
            movesetPool,
            seed: `${config.seed}-opponents-next${generation}`,
            opts: {
              ...(config.opponentDeathRate !== undefined ? { deathRate: config.opponentDeathRate } : {}),
              ...(config.opponentImmigrantFraction !== undefined ? { immigrantFraction: config.opponentImmigrantFraction } : {}),
              ...opponentMutationRatesAt(generation, config),
              coreRivalry: config.coreRivalry,
              similarRivalry: config.similarRivalry,
              similarFloor: config.similarFloor,
              similarity,
            },
          });
          nextOpponents = advancedOpponents.pool;
          opponentLineage = advancedOpponents.lineage;
        }
      }

      const record = {
        formatVersion: CHECKPOINT_FORMAT_VERSION,
        generation,
        config,
        collectionHash,
        runStartedAt: new Date(runStartedAtMs).toISOString(),
        threadsUsed: threaded ? threads : null,
        population,
        fitness,
        // The trailing-mean fitness selection actually ranked on this
        // generation (see selectionTrailingOf); `fitness` above stays the raw
        // single-generation number the history/analytics/race chart read.
        selectionFitness,
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
        // Trailing-mean smoothed opponent fitness actually used to select the
        // NEXT opponent pool (see opponentSelectionFitness above); `opponentFitness`
        // above stays the raw single-generation ledger.
        opponentSelectionFitness,
        opponentLineage: opponentLineage
          ? {
              diedCount: opponentLineage.died.length,
              coreRivalryDiedCount: opponentLineage.coreRivalryDied?.length ?? 0,
              originCounts: opponentLineage.originCounts,
            }
          : null,
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
          ...computeOpponentAnalytics({ opponents, opponentFitness, opponentArchetypeGroups: oppArchetypeGroups }),
          // Share of the candidates' total vote weight (archetype x strength)
          // held by singleton archetypes -- the number the 2026-09-09
          // strength weighting exists to bring down.
          singletonVoteShare: singletonVoteShare(oppArchetypeGroups, oppArchetypeWeights, run.opponentStrength),
          // plans/WORKER_NOTES.md Item 1: same-kind numbers for both sides,
          // additive only (FITNESS_SEMANTICS unchanged -- no fitness value
          // here is new, these are just means of fields that already exist
          // per team/opponent). "raw" = unweighted winPoints/battles off each
          // side's own ledger; "weighted" = the win rate that side's own
          // selection/fitness actually consumed this generation; blend means
          // (meanFitness/opponentMeanFitness) already exist above.
          candidateRawWinRateMean: mean(run.results.map((r) => r.rawWinRate)),
          opponentRawWinRateMean: mean(run.opponentTally.map((t) => t.winRate)),
          candidateWeightedWinRateMean: mean(run.results.map((r) => r.winRate)),
          opponentWeightedWinRateMean: mean(opponentWeightedWinRate),
        },
        resumed: false,
      };
      writeCheckpoint(outDir, generation, record);
      generationRecords.push(record);
      // MEMORY: only the newest record's population is ever read back out of
      // generationRecords (as lastEvaluated, for the final elites pass below);
      // everything else a later step reads is opponentPool/opponentFitness
      // (buildOpponentArchive, over the FULL run), winRateBySignature (the
      // trailing-window final ranking), or timing/analytics (both report
      // paths and buildTopTeamSeries) -- see the grep audit that motivated
      // this trim. population/nextPopulation/lineage/opponentLineage/
      // nextOpponentPool are already durably on disk via writeCheckpoint
      // above, so once a generation is no longer the newest they are dead
      // weight -- on a long run they otherwise pin tens of thousands of team
      // objects in the main process's heap for the run's entire duration.
      const superseded = generationRecords[generationRecords.length - 2];
      if (superseded) {
        superseded.population = null;
        superseded.nextPopulation = null;
        superseded.lineage = null;
        superseded.opponentLineage = null;
        superseded.nextOpponentPool = null;
      }
      writeGenerationsAnalytics(outDir, generationRecords);
      lastEvaluated = record;
      let workerStatsMsg = '';
      if (executor && profileDir) {
        // Live, non-destructive poll (see parallel.js's collectLiveStats) --
        // this is the mid-run visibility into per-worker memory/cache growth
        // that used to only exist as a one-shot dump on clean exit.
        const workerStats = await executor.stats();
        if (workerStats.length > 0) {
          // Per-isolate heap, NOT rss: inside a worker_thread rss is the whole
          // process's figure, so summing it just multiplies the RSS logged
          // below by the thread count (the "worker RSS 68 GB" lines in older
          // logs). Process RSS is logged once, below.
          const totalHeap = workerStats.reduce((s, w) => s + w.heapMb, 0);
          const peakHeap = Math.max(...workerStats.map((w) => w.peakHeapMb));
          const totalMemoSize = workerStats.reduce((s, w) => s + w.memoSize, 0);
          const totalCacheSize = workerStats.reduce((s, w) => s + w.cacheASize + w.cacheBSize, 0);
          workerStatsMsg =
            `, worker heap ${totalHeap}MB total (peak ${peakHeap}MB), ` +
            `scenario-memo ${totalMemoSize} entries, mon caches ${totalCacheSize} entries`;
        }
      }
      log(
        `generation ${generation}: done -- mean fitness ${(record.analytics.meanFitness * 100).toFixed(1)}%, ` +
          `opponent mean fitness ${record.opponentFitness && record.opponentFitness.length ? (record.analytics.opponentMeanFitness * 100).toFixed(1) + "%" : "n/a"}, ` +
          `raw win rate cand ${(record.analytics.candidateRawWinRateMean * 100).toFixed(1)}% / opp ${(record.analytics.opponentRawWinRateMean * 100).toFixed(1)}%, ` +
          `${run.battleCount} battles simulated + ${run.cachedCount} served from cache (both directions; ${run.errorCount} errors), ` +
          `${formatDuration(run.elapsedMs)} elapsed, process RSS ${(process.memoryUsage().rss / 1048576).toFixed(0)}MB` +
          workerStatsMsg
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
    // FINALISTS: the last generation's top `eliteCount` by the SAME trailing
    // mean selection ranks on (see the header note), not by the last
    // generation's single draw -- the s2 run's last-draw pick sent teams with
    // 1-4 observations to the pass and left out a team that had sat in the
    // top 7 for 8 of the last 13 generations.
    const trailing = selectionTrailingOf(config);
    const selectionAtEnd = trailingFitness(history, trailing);
    const rankedIdx = lastEvaluated.population
      .map((_, i) => i)
      .sort((a, b) => selectionAtEnd[b] - selectionAtEnd[a] || a - b);
    // Shadow twins (same species and lead, differing only in who is shadow)
    // normally settle inside nextGeneration -- only the fitter survives -- but
    // a twin bred in the final generation has never faced its rival, so the
    // ranking keeps the fitter of each pair here too. One line per trio.
    const seenShadowBlind = new Set();
    const eliteIdx = [];
    for (const i of rankedIdx) {
      if (eliteIdx.length >= config.eliteCount) break;
      const signature = shadowBlindSignature(lastEvaluated.population[i], deduped);
      if (seenShadowBlind.has(signature)) continue;
      seenShadowBlind.add(signature);
      eliteIdx.push(i);
    }
    const eliteTeams = eliteIdx.map((i) => lastEvaluated.population[i]);
    log(
      `evolve: finalists -- top ${eliteTeams.length} of ${lastEvaluated.population.length} last-generation teams ` +
        `by ${trailing}-generation mean fitness`
    );

    // OPPONENT SET (Jaxon 2026-08-26, held-out form 2026-09-05): EVERY curated
    // team, untouched and at its own declared lead -- the reality check, these
    // are the teams actually being played -- plus two held-out strata the
    // finalists have never been selected on: the ARCHIVE (the strongest
    // opponents the opponent GA bred over the whole run, minus anything that
    // sat in the pools of the generations the finalists' trailing mean was
    // measured on -- see buildOpponentArchive) and FRESH meta-composed teams
    // no candidate ever fought. Re-grading the finalists against the pool that
    // had just chosen them was the winner's curse the s2 run exposed (0 new
    // battles, every "elites pass" number equal to the selecting draw). One
    // battle per (elite, opponent) -- the elite at its locked lead, the
    // opponent at ITS designated lead -- rather than the old spread across the
    // opponent's 3 possible leads: now that every opponent carries a real
    // designated lead, fighting it at the other two is measuring a team that
    // nobody plays.
    const holdoutGenerations = Math.min(trailing, generationRecords.length);
    const archiveBuilt = buildOpponentArchive(generationRecords, {
      holdoutGenerations,
      limit: opts.finalArchive ?? DEFAULTS.finalArchive,
    });
    const archiveOpponents = rehydrateOpponentPool(ctx, archiveBuilt.archive, curatedPool, log).map((e) => ({
      ...e,
      label: 'archive',
    }));
    const everFielded = new Set();
    for (const r of generationRecords) for (const o of r.opponentPool ?? []) everFielded.add(o.id);
    const freshOpponents = composeFreshOpponents(ctx, {
      count: opts.finalFresh ?? finalFreshDefault(config),
      seed: config.seed,
      movesetPool,
      weights,
      roleScores: opponentLeadRoleScores,
      usedIds: everFielded,
    });
    // --curated-ratio 0 means "no curated teams in this run, full stop": a run
    // that deliberately excluded the (possibly stale) curated set is not
    // graded against it at the end either.
    const eliteCurated =
      config.curatedRatio > 0 ? curatedPool.map((t) => ({ ...t, label: 'curated', leadIndex: t.leadIndex ?? 0 })) : [];
    const eliteOpponents = [...eliteCurated, ...archiveOpponents, ...freshOpponents];
    const eliteOpponentWeights = finalPassWeights({
      curated: eliteCurated,
      evolvedCount: archiveOpponents.length + freshOpponents.length,
      curatedRatio: config.curatedRatio,
    });

    log(
      `evolve: final pass -- ${eliteTeams.length} teams x ${eliteOpponents.length} opponents ` +
        `(${eliteCurated.length} curated in full, ${archiveOpponents.length} archive held out of the last ` +
        `${holdoutGenerations} generation(s) [${archiveBuilt.eligible} eligible of ${archiveBuilt.seen} distinct evolved ` +
        `opponents seen], ${freshOpponents.length} fresh never fought before), each at its own lead`
    );
    // Archetype grouping over the elites-pass opponent set (archive + fresh +
    // curated), purely to compute each finalist's consistencyScore below --
    // NOT folded into combinedScore (D3: one behavioral change to finalist
    // ordering at a time; the user decides after seeing the number).
    const eliteArchetypeGroups = archetypeGroups(eliteOpponents);
    const eliteRun = await evaluateTeamsInOrder(ctx, {
      teams: eliteTeams,
      matrix: deduped,
      opponents: eliteOpponents,
      pairingsFor: ownLeadPairing,
      difficulty,
      opponentStrengthGamma: config.opponentStrengthGamma,
      snowballWeight: config.snowballWeight,
      closerWeight: config.closerWeight,
      consistencyWeight: config.consistencyWeight,
      sharedWeaknessWeight: config.sharedWeaknessWeight,
      typeCoverageContext,
      trackLeads: true,
      executor,
      onLog: log,
      roleScores,
      cache: battleCache,
      opponentWeights: eliteOpponentWeights,
      opponentArchetypeGroups: eliteArchetypeGroups,
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
          sourceIndex: eliteIdx[i],
          signature: teamSignature(eliteTeams[i]),
          // The trailing mean that made this team a finalist, and the pass
          // broken down by stratum (unweighted) so a reader can see "vs real
          // teams" / "vs the hardest bred counters" / "vs fresh meta teams"
          // separately from the weighted headline.
          selectionFitness: selectionAtEnd[eliteIdx[i]],
          winRateByStratum: winRateByStratum(r.perMeta),
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
      importWarnings: [...new Set([...importWarnings, ...expanded.warnings, ...eligible.warnings])],
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
        // `evolved` kept as the sum for anything reading the older shape.
        evolved: archiveOpponents.length + freshOpponents.length,
        archive: archiveOpponents.length,
        fresh: freshOpponents.length,
        holdoutGenerations,
        archiveEligible: archiveBuilt.eligible,
        archiveSeen: archiveBuilt.seen,
      },
      ranking: {
        weights: RANKING_WEIGHTS,
        recentWindow,
        selectionTrailing: trailing,
        generationsRun: generationRecords.length,
      },
      finalOpponentPool: summarizeOpponentPool(lastEvaluated.opponentPool ?? [], lastEvaluated.opponentFitness ?? []),
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

    // Trimmed re-render source: everything renderEvolveReport/renderEvolveReportHtml
    // read off `result`, minus the bulky per-generation population/opponentPool/lineage
    // detail (already on disk as evolve-gen*.json checkpoints) -- just each generation's
    // timing, which the report's battle/cache/thread totals need. Lets a report-only
    // fix (wording, a new section, a rendering bug) be re-applied with
    // `node scripts/render-report.mjs <out-dir>` instead of re-running the sim.
    writeFileSync(
      path.join(outDir, 'evolve-result.json'),
      JSON.stringify(
        { ...result, generationRecords: generationRecords.map((r) => ({ timing: r.timing, threadsUsed: r.threadsUsed })) },
        null,
        2
      ),
      'utf8'
    );

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
  --config PATH           JSON file of {"flag-name": value} pairs (dashed
                            flag names as keys, e.g. {"snowball-weight": 0.2}),
                            applied before individual flags -- an explicit
                            CLI flag always overrides the same key from
                            --config. Lets a recipe collapse to one flag
                            instead of a dozen; see recipes/standard.json
                                                                       (default: none)
  --population N         GA population size                        (default ${DEFAULTS.population})
  --opponents-per-gen M   opponent teams sampled each generation     (default ${DEFAULTS.opponentsPerGen})
                            every pairing battles both directions (candidate-
                            as-A and opponent-as-A, mirrored), so battles per
                            generation = 2 x population x opponents-per-gen
  --generations G         generation cap                            (default ${DEFAULTS.generations})
  --seed S                PRNG seed                                 (default "${DEFAULTS.seed}")
  --threads N             battle via ONE persistent worker-pool executor
                            shared across every generation; this CLI
                            defaults to max(1, cpus-1) capped at 8 (each
                            worker boots its own engine context, so more
                            threads costs memory, not just CPU) -- pass
                            --threads 1 for the serial reference mode, or
                            a value above 8 if the machine has memory to
                            spare                                        (default ${defaultThreadCount()} on this machine)
  --profile                capture a per-worker CPU profile (node:inspector)
                            spanning the whole run, written to
                            <out-dir>/worker-*.cpuprofile and
                            <out-dir>/profile-summary.json on a clean exit
                            (Ctrl-C/kill skips the flush -- only a normal or
                            --deadline-minutes stop captures data). Also adds
                            a live per-generation line: each worker's
                            current+peak heap, scenario-memo size, and
                            mon-cache size, polled between generations for
                            mid-run memory/speed debugging. Process RSS
                            is always logged every generation regardless.
                            Requires --threads > 0 (a no-op in serial mode)
  --deadline-minutes D    optional wall-clock budget (stop before the next
                            generation once past it; no self-tuning)   (default: none)
  --seed-from PATH        pre-bake generation 0's population + opponent pool
                            from another run's evolve-gen<N>.json checkpoint
                            instead of sampling fresh. Ignored if --out-dir
                            already has a matching in-place resume. This is
                            also how to "resume with different flags": point
                            --out-dir at a NEW directory and --seed-from at
                            the old run's checkpoint -- the new run gets its
                            own checkpoint chain from generation 0, seeded
                            with that population, under whatever new flags
                            you pass                                   (default: none)
  --force-fresh           allow starting fresh in an --out-dir whose
                            evolve-gen0.json config doesn't match this run's
                            flags, discarding it (without this, a config
                            mismatch is a hard error instead of a silent
                            overwrite -- see the resume-refusal message)
                                                                         (default: off)
  --cp N                  CP cap / league                            (default ${DEFAULTS.cp})
  --cup NAME              pvpoke cup id (e.g. willpower); restricts candidates,
                            opponents, movesets, usage weights, role priors,
                            and meta group to that cup's format          (default: ${DEFAULTS.cup})
  --fixed-opponents        freeze the opponent pool: one draw, never evolved
                            and never resized                          (default: off)
  --elites N               last-generation teams (by trailing-mean fitness)
                            given the final evaluation pass; not part of the
                            checkpoint fingerprint, so a finished run can be
                            re-rendered with more                      (default ${DEFAULTS.elites})
  --selection-trailing N   generations each team's fitness is averaged over
                            before the cull/mutation ranking and the finalist
                            pick; 1 = rank on the single generation
                                        (default: DEFAULT_SELECTION_TRAILING, ${DEFAULT_SELECTION_TRAILING})
  --final-archive N        final pass: strongest evolved opponents from the
                            whole run, held out of the generations the
                            finalists were selected on                (default ${DEFAULTS.finalArchive})
  --final-fresh N          final pass: fresh meta-composed opponents never
                            fought during the run -- kept low/off by default,
                            these are essentially random legal teams, not
                            opponent-GA-selected ones (default ${DEFAULTS.finalFresh}, or ${FINAL_FRESH_WHEN_NO_CURATED} at --curated-ratio 0)
  --score-meta S           1v1-pruning meta size                      (default ${DEFAULTS.scoreMeta})
  --pool P                 candidate sampling pool size, in species (top P
                            by 1v1 score)               (default: no cap, whole deduped collection)
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
  --mutation-floor-start R  hot-start mutation floor at generation 0,
                            annealed linearly down to --mutation-floor (or
                            its default) by the last generation   (default: no anneal)
  --mutation-ceil-start R   hot-start mutation ceil at generation 0, same
                            linear anneal to --mutation-ceil      (default: no anneal)
  --immigrant-fraction R   fresh-immigrant share of the population (default: DEFAULT_IMMIGRANT_FRACTION)
  --opponent-death-rate R            opponent-side cull fraction per generation;
                            mutants can only fill the seats the cull opens,
                            so raise this alongside the mutation rates
                                        (default: DEFAULT_OPPONENT_DEATH_RATE, 0.15)
  --opponent-mutation-floor R        opponent-side mutation floor  (default: DEFAULT_OPPONENT_MUTATION_FLOOR, 0.02)
  --opponent-mutation-ceil R         opponent-side mutation ceil   (default: DEFAULT_OPPONENT_MUTATION_CEIL, 0.2)
  --opponent-mutation-floor-start R  hot-start opponent floor at generation 0,
                            annealed linearly to --opponent-mutation-floor
                                                                   (default: no anneal)
  --opponent-mutation-ceil-start R   hot-start opponent ceil, same anneal to
                            --opponent-mutation-ceil               (default: no anneal)
  --opponent-immigrant-fraction R    opponent-side fresh-immigrant share of
                            the evolvable pool (default: DEFAULT_OPPONENT_IMMIGRANT_FRACTION, 0.08)
  --conv-window N          convergence: consecutive zero-churn generations
                            required                              (default: DEFAULT_CONVERGENCE_WINDOW)
  --conv-top-n N           convergence: size of the top set that must not
                            churn                                 (default: DEFAULT_CONVERGENCE_TOP_N)
  --archetype-beta R       sublinear discount on a crowded opponent
                            archetype's total weight (src/meta/archetypes.js);
                            0 = flat/raw mean, 1 = one-vote-per-archetype
                                                       (default ${DEFAULTS.archetypeBeta})
  --opponent-strength-gamma G  scale each opponent's vote in a candidate's
                            win rate by (that opponent's own win rate)^G, so
                            beating a strong team counts more than beating a
                            weak singleton; 0 = off        (default ${DEFAULTS.opponentStrengthGamma})
  --candidate-strength-gamma G  symmetric, other side of the same ledger:
                            scale each candidate's vote in an opponent's
                            fitness by (that candidate's own win rate)^G, so
                            an opponent that only beat weak candidates
                            doesn't outscore one that beat strong ones;
                            0 = off                (default ${DEFAULTS.candidateStrengthGamma})
  --snowball-weight R      candidate-side fitness weight on snowballScore
                            (own fraction of decided lead exchanges won),
                            on top of winRate=1; see --opponent-snowball-weight
                            for the opponent-side equivalent
                                                       (default ${DEFAULT_FITNESS_WEIGHTS.snowball})
  --closer-weight R        candidate-side fitness weight on closerScore (mean
                            role-prior closer score of the team's two back
                            members), on top of winRate=1; disabled by
                            default (see docs/plans/2026-09-08-fitness-restructure.md)
                                                       (default ${DEFAULT_FITNESS_WEIGHTS.closer})
  --consistency-weight R   candidate-side fitness weight on consistencyScore
                            (worst-quartile per-archetype win rate), on top of
                            winRate=1; disabled by default (same restructure
                            doc as --closer-weight)   (default ${DEFAULT_FITNESS_WEIGHTS.consistency})
  --shared-weakness-weight R  candidate-side fitness weight on
                            sharedWeaknessScore: rank-weighted PvPoke top-200
                            type exposure, softened double weaknesses, partial
                            resistance credit, and selected-move type coverage;
                            on top of winRate=1, battle-reality fitness only,
                            disabled by default, try 0.10-0.20
                            (see src/teams/typeCoverage.js)
                                                       (default ${DEFAULT_FITNESS_WEIGHTS.sharedWeakness})
  --opponent-snowball-weight R  opponent-side equivalent of --snowball-weight,
                            fed the opponent's OWN lead-exchange ledger; blends
                            into src/meta/opponentPool.js's fitness alongside
                            its plain win rate (Jaxon 2026-09-17, symmetry)
                                                       (default ${DEFAULT_FITNESS_WEIGHTS.snowball})
  --opponent-closer-weight R  opponent-side equivalent of --closer-weight
                                                       (default ${DEFAULT_FITNESS_WEIGHTS.closer})
  --opponent-consistency-weight R  opponent-side equivalent of
                            --consistency-weight (worst-quartile win rate
                            across the CANDIDATE archetypes this opponent
                            fought)                    (default ${DEFAULT_FITNESS_WEIGHTS.consistency})
  --opponent-shared-weakness-weight R  opponent-side equivalent of
                            --shared-weakness-weight  (default ${DEFAULT_FITNESS_WEIGHTS.sharedWeakness})
  --core-rivalry R         each better team sharing a two-species core costs
                            a team R x (field's fitness range) before the
                            cull ranks it, in the population and the opponent
                            pool alike; 0 = off             (default ${DEFAULTS.coreRivalry})
  --similar-rivalry S      weight of a maximally similar different-species
                            member in --core-rivalry, relative to the identical
                            species; similarity is pvpoke's own "Similar
                            Pokemon" score (types, moves, traits; 0..1); only a
                            team's most crowded core is charged; 0 = exact
                            cores only                      (default ${DEFAULTS.similarRivalry})
  --similar-floor F        pvpoke similarity at or below which two species are
                            unrelated for --similar-rivalry; above it the match
                            scales linearly (Feraligatr vs Empoleon ~0.55,
                            Charizard vs Blaziken ~0.62)    (default ${DEFAULTS.similarFloor})
  --no-opponent-fitness-normalised  disable frequency-normalised opponent
                            fitness (each candidate's contribution to an
                            opponent's win-rate ledger weighted down by its
                            most-common member's population share); restores
                            the old flat mean                    (default: normalised on)
  --random-opponent-lead   assign every composed opponent a uniform-random
                            lead instead of pvpoke's lead-prior winner,
                            matching the candidate side's own random lead
                            assignment. Use for meta-vs-meta runs, where both
                            sides are meant to be symmetrical -- otherwise the
                            opponent side's realistic leads give it an
                            unearned fitness edge from generation 0 on
                                                                (default: off)
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

/** A non-negative finite number flag (no upper bound, unlike fractionFlag). */
function numberFlag(value, name, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative number, got "${value}"`);
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

/**
 * CLI flag parsing only (plans/WORKER_NOTES.md Item 3): argv -> {csvPath,
 * opts} where `opts` is exactly the object `runEvolution` accepts, or `null`
 * if this call should just print help/an error (already written to
 * stdout/stderr, `process.exitCode` already set) -- so a study script can
 * accept the SAME `<collection.csv> <...evolve.mjs flags>` argv shape
 * `scripts/evolve.mjs` itself does, without re-declaring the ~70 flags below.
 * `main` now just calls this and runs the result through `runEvolution`.
 */
export function parseEvolveArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        population: { type: 'string' },
        'opponents-per-gen': { type: 'string' },
        generations: { type: 'string' },
        seed: { type: 'string' },
        threads: { type: 'string' },
        profile: { type: 'boolean' },
        'deadline-minutes': { type: 'string' },
        'seed-from': { type: 'string' },
        'force-fresh': { type: 'boolean' },
        cp: { type: 'string' },
        cup: { type: 'string' },
        'fixed-opponents': { type: 'boolean' },
        elites: { type: 'string' },
        'selection-trailing': { type: 'string' },
        'final-archive': { type: 'string' },
        'final-fresh': { type: 'string' },
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
        'mutation-floor-start': { type: 'string' },
        'mutation-ceil-start': { type: 'string' },
        'immigrant-fraction': { type: 'string' },
        'opponent-death-rate': { type: 'string' },
        'opponent-mutation-floor': { type: 'string' },
        'opponent-mutation-ceil': { type: 'string' },
        'opponent-mutation-floor-start': { type: 'string' },
        'opponent-mutation-ceil-start': { type: 'string' },
        'opponent-immigrant-fraction': { type: 'string' },
        'conv-window': { type: 'string' },
        'conv-top-n': { type: 'string' },
        'archetype-beta': { type: 'string' },
        'no-opponent-fitness-normalised': { type: 'boolean' },
        'opponent-strength-gamma': { type: 'string' },
        'candidate-strength-gamma': { type: 'string' },
        'snowball-weight': { type: 'string' },
        'closer-weight': { type: 'string' },
        'consistency-weight': { type: 'string' },
        'shared-weakness-weight': { type: 'string' },
        'opponent-snowball-weight': { type: 'string' },
        'opponent-closer-weight': { type: 'string' },
        'opponent-consistency-weight': { type: 'string' },
        'opponent-shared-weakness-weight': { type: 'string' },
        'core-rivalry': { type: 'string' },
        'similar-rivalry': { type: 'string' },
        'similar-floor': { type: 'string' },
        'random-opponent-lead': { type: 'boolean' },
        help: { type: 'boolean' },
      },
    });
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n\n${HELP}`);
    process.exitCode = 2;
    return null;
  }

  const { values, positionals } = parsed;

  if (values.config) {
    let fileValues;
    try {
      fileValues = JSON.parse(readFileSync(values.config, 'utf8'));
    } catch (err) {
      process.stderr.write(`Error: failed to read --config "${values.config}": ${err.message}\n`);
      process.exitCode = 2;
      return null;
    }
    // Explicit CLI flags win over the same key in --config.
    for (const [key, val] of Object.entries(fileValues)) {
      if (values[key] === undefined) values[key] = val;
    }
  }

  if (values.help || positionals.length === 0) {
    say(HELP);
    if (positionals.length === 0 && !values.help) process.exitCode = 2;
    return null;
  }

  const csvPath = positionals[0];
  const opts = {
    population: intFlag(values.population, 'population', DEFAULTS.population),
    opponentsPerGen: intFlag(values['opponents-per-gen'], 'opponents-per-gen', DEFAULTS.opponentsPerGen),
    generations: intFlag(values.generations, 'generations', DEFAULTS.generations),
    seed: values.seed ?? DEFAULTS.seed,
    threads: values.threads !== undefined ? intFlag(values.threads, 'threads', undefined) : defaultThreadCount(),
    profile: !!values.profile,
    deadlineMinutes: values['deadline-minutes'] !== undefined ? intFlag(values['deadline-minutes'], 'deadline-minutes', undefined) : undefined,
    seedFrom: values['seed-from'],
    forceFresh: !!values['force-fresh'],
    cp: intFlag(values.cp, 'cp', DEFAULTS.cp),
    cup: values.cup ?? DEFAULTS.cup,
    fixedOpponents: !!values['fixed-opponents'],
    eliteCount: intFlag(values.elites, 'elites', DEFAULTS.elites),
    selectionTrailing:
      values['selection-trailing'] !== undefined
        ? Math.max(1, intFlag(values['selection-trailing'], 'selection-trailing', undefined))
        : undefined,
    finalArchive: intFlag(values['final-archive'], 'final-archive', DEFAULTS.finalArchive),
    // Left undefined when not passed (rather than defaulted here) so
    // finalFreshDefault's curated-ratio-aware fallback applies.
    finalFresh: values['final-fresh'] !== undefined ? intFlag(values['final-fresh'], 'final-fresh', undefined) : undefined,
    scoreMeta: intFlag(values['score-meta'], 'score-meta', DEFAULTS.scoreMeta),
    evolutions: !values['no-evolutions'],
    // Left undefined when not passed (rather than defaulted here) so
    // buildSamplingPool's own "no cap" fallback applies.
    pool: values.pool !== undefined ? intFlag(values.pool, 'pool', undefined) : undefined,
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
    mutationFloorStart: fractionFlag(values['mutation-floor-start'], 'mutation-floor-start', undefined),
    mutationCeilStart: fractionFlag(values['mutation-ceil-start'], 'mutation-ceil-start', undefined),
    immigrantFraction: fractionFlag(values['immigrant-fraction'], 'immigrant-fraction', undefined),
    opponentDeathRate: fractionFlag(values['opponent-death-rate'], 'opponent-death-rate', undefined),
    opponentMutationFloor: fractionFlag(values['opponent-mutation-floor'], 'opponent-mutation-floor', undefined),
    opponentMutationCeil: fractionFlag(values['opponent-mutation-ceil'], 'opponent-mutation-ceil', undefined),
    opponentMutationFloorStart: fractionFlag(values['opponent-mutation-floor-start'], 'opponent-mutation-floor-start', undefined),
    opponentMutationCeilStart: fractionFlag(values['opponent-mutation-ceil-start'], 'opponent-mutation-ceil-start', undefined),
    opponentImmigrantFraction: fractionFlag(values['opponent-immigrant-fraction'], 'opponent-immigrant-fraction', undefined),
    convWindow: values['conv-window'] !== undefined ? intFlag(values['conv-window'], 'conv-window', undefined) : undefined,
    convTopN: values['conv-top-n'] !== undefined ? intFlag(values['conv-top-n'], 'conv-top-n', undefined) : undefined,
    archetypeBeta: fractionFlag(values['archetype-beta'], 'archetype-beta', undefined),
    opponentFitnessNormalised: values['no-opponent-fitness-normalised'] ? false : undefined,
    randomOpponentLead: values['random-opponent-lead'] ? true : undefined,
    opponentStrengthGamma: values['opponent-strength-gamma'] !== undefined ? numberFlag(values['opponent-strength-gamma'], 'opponent-strength-gamma') : undefined,
    candidateStrengthGamma: values['candidate-strength-gamma'] !== undefined ? numberFlag(values['candidate-strength-gamma'], 'candidate-strength-gamma') : undefined,
    snowballWeight: values['snowball-weight'] !== undefined ? numberFlag(values['snowball-weight'], 'snowball-weight') : undefined,
    closerWeight: values['closer-weight'] !== undefined ? numberFlag(values['closer-weight'], 'closer-weight') : undefined,
    consistencyWeight: values['consistency-weight'] !== undefined ? numberFlag(values['consistency-weight'], 'consistency-weight') : undefined,
    sharedWeaknessWeight:
      values['shared-weakness-weight'] !== undefined
        ? numberFlag(values['shared-weakness-weight'], 'shared-weakness-weight')
        : undefined,
    opponentSnowballWeight:
      values['opponent-snowball-weight'] !== undefined
        ? numberFlag(values['opponent-snowball-weight'], 'opponent-snowball-weight')
        : undefined,
    opponentCloserWeight:
      values['opponent-closer-weight'] !== undefined
        ? numberFlag(values['opponent-closer-weight'], 'opponent-closer-weight')
        : undefined,
    opponentConsistencyWeight:
      values['opponent-consistency-weight'] !== undefined
        ? numberFlag(values['opponent-consistency-weight'], 'opponent-consistency-weight')
        : undefined,
    opponentSharedWeaknessWeight:
      values['opponent-shared-weakness-weight'] !== undefined
        ? numberFlag(values['opponent-shared-weakness-weight'], 'opponent-shared-weakness-weight')
        : undefined,
    coreRivalry: values['core-rivalry'] !== undefined ? numberFlag(values['core-rivalry'], 'core-rivalry') : undefined,
    similarRivalry: values['similar-rivalry'] !== undefined ? numberFlag(values['similar-rivalry'], 'similar-rivalry') : undefined,
    similarFloor: values['similar-floor'] !== undefined ? numberFlag(values['similar-floor'], 'similar-floor') : undefined,
  };

  return { csvPath, opts };
}

async function main(argv) {
  const parsed = parseEvolveArgs(argv);
  if (!parsed) return;
  const { csvPath, opts } = parsed;

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
