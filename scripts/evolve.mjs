#!/usr/bin/env node
// JavaScript Document
//
// GOALS T24: evolutionary team search driver ("survival of the fittest",
// PLAN.md Rev 5), sibling of scripts/tournament.mjs (which stays -- this is
// an alternate search strategy, not a replacement). Where the tournament
// funnel narrows a WIDE fixed sample down through progressively deeper
// opponent pools, this instead runs a genetic algorithm: a population of
// candidate teams is repeatedly battled, the worst performers die, some
// survivors mutate (one member swapped), fresh immigrants keep the gene pool
// open, and the process repeats until the top teams converge -- so compute
// concentrates on already-good teams instead of being spread evenly across a
// static sample.
//
// All GA bookkeeping (selection/mutation/immigration/convergence) is
// src/teams/evolve.js (GOALS T23) -- pure, no battles. This file's only job
// is the battle-driving glue: shared collection->matrix setup (mirrors
// scripts/tournament.mjs's sampled path exactly), per-generation opponent
// sampling, running every team's battles through the Rev 4 persistent
// executor, checkpointing, and rendering the report. No battle math is
// reimplemented anywhere here -- every win/loss/HP number comes from
// battleTeams (src/engine/teamBattle.js, pvpoke's own emulate engine).
//
// EVERY team in the population is battled every generation (elites included
// -- PLAN Rev 5 is explicit: "no stale fitness carryover, no overfitting to
// one opponent sample"), against a FRESH seeded opponent draw each
// generation by default (`--fixed-opponents` opts out and reuses one draw
// for the whole run, per PLAN Rev 5's own wording of that flag).
//
// Fixed-side convention (same as scripts/tournament.mjs / src/teams/
// index.js): every population member is always battled as team A, so
// pvpoke emulate mode's small residual player-1 edge is a constant offset
// shared by every team and cancels in the RELATIVE ranking.
//
// Usage:
//   node scripts/evolve.mjs <collection.csv> [options]
//
// Flags (defaults):
//   --population N        GA population size                        (100)
//   --opponents-per-gen M  opponent teams sampled each generation     (20)
//   --generations G        generation cap                            (15)
//   --seed S               PRNG seed                                 ("pogo-gbl-team-generator-evolve")
//   --threads N             battle via ONE persistent worker-pool executor
//                            shared across every generation (src/engine/
//                            parallel.js), like scripts/tournament.mjs's T21
//                            adoption; this CLI defaults to max(1, cpus-1)
//                            (--threads 1 for the serial reference mode)
//   --deadline-minutes D   optional wall-clock budget -- if set, the run
//                            stops BEFORE starting a generation once already
//                            past the deadline (no opponent-count self-
//                            tuning like tournament.mjs's stages; simpler,
//                            since PLAN Rev 5 never asked for that here --
//                            see the header note below). Omitted = no
//                            deadline, only --generations/convergence stop it. (none)
//   --cp N                 CP cap / league, forwarded to initEngine like
//                            every other CLI in this repo (T18c)          (1500)
//   --fixed-opponents       draw ONE opponent set (seed `${seed}-opponents`)
//                            and reuse it every generation, instead of a
//                            fresh draw per generation                    (off)
//   --elites N              how many of the final generation's top-fitness
//                            teams get the full 9-lead-pairing evaluation +
//                            bestLead/safeSwap for the report (a count PLAN
//                            Rev 5 doesn't specify -- documented judgment
//                            call, mirrors tournament.mjs's s3Top default)  (10)
//   --score-meta S          1v1-pruning meta size (candidate-pool ranking
//                            only, mirrors tournament.mjs)                (20)
//   --pool P                sampling pool size (best-scoring, deduped)     (40)
//   --curated-ratio R       curated-vs-sampled opponent mix                (0.4)
//   --exclude a,b            species ids excluded from candidate teams     (none)
//   --difficulty D           AI difficulty 0-3 override                   (engine default, 3)
//   --out PATH               final Markdown report path            (<out-dir>/my-teams-evolve.md)
//   --html PATH              final HTML report path (self-contained, no
//                            build step, mirrors src/cli.js's --html /
//                            src/report/index.js's renderReportHtml pattern,
//                            GOALS T25)              (<out-dir>/my-teams-evolve.html)
//   --no-html                skip writing the HTML report                 (off)
//   --out-dir DIR            checkpoints + DONE marker + default reports  ("out")
//   --help                   print this help and exit
//
// BUDGET MATH (PLAN Rev 5's own example): battles/generation = population x
// opponents-per-gen x 3 (seeded-random leadB, same scheme as tournament.mjs's
// stages 1-2). At the flag defaults: 100 x 20 x 3 = 6,000 battles/generation;
// 15 generations (if run to the cap, no early convergence) = 90,000 battles,
// plus a final elites pass at 9 full lead pairings (elites x opponents-per-gen
// x 9 = 10 x 20 x 9 = 1,800). Measured rates vary by machine (~172ms/battle in
// the sandbox, ~73ms/battle on Jaxon's local Mac per PROGRESS.md's T14 note,
// both MUCH faster threaded -- see T22's measured numbers) -- size
// --population/--opponents-per-gen/--generations to your own time budget;
// --deadline-minutes is a simple stop-before-the-next-generation safety net,
// not a self-tuning scaler (unlike tournament.mjs's stage 2/3 tuning -- PLAN
// Rev 5's own flag list never asks for that here, and per-generation
// opponent/population counts don't have tournament's "narrowing funnel"
// structure to tune against, so a flat stop is the honest, simple choice).
//
// GA TUNABLES (deathRate/mutationFloor/mutationCeil/immigrantFraction/alpha,
// convergence window/topN): deliberately NOT exposed as CLI flags here --
// PLAN Rev 5's own flag list for this ticket doesn't mention them, and
// src/teams/evolve.js's exported DEFAULT_* constants (bottom-quarter death,
// 0.05->0.40 percentile-scaled mutation, ~10% immigrant floor, top-10
// stable-for-3-generations convergence) already encode Jaxon's revised
// scheme. A future ticket can add flags if tuning them from the CLI turns
// out to matter in practice.
//
// ROBUSTNESS: each generation writes out/evolve-gen<N>.json (config + that
// generation's population/fitness/lineage-to-next-gen + timing/analytics) as
// soon as it finishes. On startup, checkpoints are read in order starting at
// generation 0; a checkpoint whose `config` deep-equals this run's resolved
// config is accepted and the run continues from its stored `nextPopulation`
// at generation+1 -- the first missing/mismatched checkpoint stops the scan
// (mirrors scripts/tournament.mjs's per-stage resume, but sequential since
// each generation depends on the last). Individual battle errors are caught,
// logged, and counted (skip-and-continue) rather than aborting a generation.
// out/evolve-generations.json (analytics only, no population/lineage detail)
// is rewritten after every generation, so a killed run's analytics are never
// lost even without a full checkpoint resume. out/evolve-DONE is written
// LAST, only on a fully successful run.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { importCollection } from '../src/importer/index.js';
import { initEngine } from '../src/engine/harness.js';
import { battleTeams } from '../src/engine/teamBattle.js';
import { createExecutor, defaultThreadCount } from '../src/engine/parallel.js';
import { scoreCollection, computeWeightedScore } from '../src/scoring/index.js';
import { loadUsageWeights } from '../src/meta/usage.js';
import { sampleOpponentTeams } from '../src/meta/sampleTeams.js';
import { dedupeBestPerSpecies } from '../src/teams/index.js';
import { initPopulation, nextGeneration, hasConverged } from '../src/teams/evolve.js';
import { rngFromSeed } from '../src/util/rng.js';
import { leagueForCp } from '../src/util/leagues.js';

const DEFAULTS = Object.freeze({
  population: 100,
  opponentsPerGen: 20,
  generations: 15,
  seed: 'pogo-gbl-team-generator-evolve',
  cp: 1500,
  elites: 10,
  scoreMeta: 20,
  pool: 40,
  curatedRatio: 0.4,
  outDir: 'out',
  html: 'my-teams-evolve.html', // resolved against outDir unless --html/opts.html is absolute or explicit
});

// Used only if a generation somehow measures 0 battles (every battle errored)
// -- keeps timing math finite. Mirrors tournament.mjs's own fallback figure.
const FALLBACK_MS_PER_BATTLE = 200;
const SPECIES_STATS_CAP = 25; // report/analytics-JSON cap on how many species rows are kept per generation (documented, not silent -- see renderEvolveReport).
const TOP_CORES_CAP = 15;
const TRAJECTORY_SPECIES_CAP = 15;

const LEADS = [0, 1, 2];

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
// Lead-pairing schemes (same conventions as scripts/tournament.mjs).
// ---------------------------------------------------------------------------

function pickLeadB(stageSeed, candidateSig, opponentId, leadA) {
  const rng = rngFromSeed(`${stageSeed}|leadB|${candidateSig}|${opponentId}|${leadA}`);
  return Math.floor(rng() * LEADS.length);
}

function threeRandomPairings(stageSeed, candidateSig, opponentId) {
  return LEADS.map((leadA) => ({ leadA, leadB: pickLeadB(stageSeed, candidateSig, opponentId, leadA) }));
}

function ninePairings() {
  const out = [];
  for (const leadA of LEADS) {
    for (const leadB of LEADS) out.push({ leadA, leadB });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run config (checkpoint fingerprint) + checkpoint I/O.
// ---------------------------------------------------------------------------

/**
 * Canonical JSON-serializable REQUESTED inputs for a run -- compared against
 * a checkpoint's `config` on resume (same key-order-stable, deliberately-
 * conservative approach as scripts/tournament.mjs's buildRunConfig).
 * `deadlineMinutes` and `threads` are excluded on purpose: neither changes
 * what any generation COMPUTES (deadline only decides whether to stop before
 * starting the next one; threads is a pure performance knob), so changing
 * either between runs must not invalidate an existing checkpoint.
 */
function buildRunConfig(csvPath, opts) {
  return {
    csvPath: path.resolve(csvPath),
    scoreMeta: opts.scoreMeta ?? DEFAULTS.scoreMeta,
    pool: opts.pool ?? DEFAULTS.pool,
    seed: String(opts.seed ?? DEFAULTS.seed),
    cp: opts.cp ?? DEFAULTS.cp,
    curatedRatio: opts.curatedRatio ?? DEFAULTS.curatedRatio,
    excludeSpecies: [...(opts.excludeSpecies ?? [])].sort(),
    difficulty: opts.difficulty ?? null,
    population: opts.population ?? DEFAULTS.population,
    opponentsPerGen: opts.opponentsPerGen ?? DEFAULTS.opponentsPerGen,
    generations: opts.generations ?? DEFAULTS.generations,
    fixedOpponents: !!opts.fixedOpponents,
    eliteCount: opts.eliteCount ?? DEFAULTS.elites,
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
// Species-set helpers + per-generation analytics (PLAN Rev 5: "cheap -- it's
// just counting" -- computed entirely from data a generation's battles and
// src/teams/evolve.js's nextGeneration already produce; no extra battles).
// ---------------------------------------------------------------------------

function speciesOfTeam(matrix, team) {
  return team.map((key) => matrix.builtMons[key].speciesId);
}

/**
 * @param {{matrix:object, population:string[][], fitness:number[],
 *   lineage:{died:number[], entries:Array<object>}|null}} params
 *   `lineage` is the OUTGOING transition (this generation -> the next);
 *   null for a generation that had no next generation (the run's very last).
 */
function computeGenerationAnalytics({ matrix, population, fitness, lineage }) {
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
  const eliteIdx = rankedIdx.slice(0, Math.min(10, population.length)); // fixed top-10 for core-pair stats, independent of --elites (report's final-ranking count)
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
  };
}

// ---------------------------------------------------------------------------
// Battle runner: every team in `population` (or a narrower elite slice)
// against every opponent, in INPUT ORDER (not sorted -- src/teams/evolve.js's
// nextGeneration needs fitness[i] to correspond to population[i]). Mirrors
// scripts/tournament.mjs's runFunnelStage's pass1/pass2 + threaded-executor
// structure; the difference is no candidate narrowing (every generation
// battles its WHOLE population) and preserved input order.
// ---------------------------------------------------------------------------

async function evaluateTeamsInOrder(ctx, params) {
  const { teams, matrix, opponents, pairingsFor, difficulty, trackLeads = false, executor, onLog } = params;
  const threaded = !!executor;
  const startedAt = Date.now();
  let battleCount = 0;
  let errorCount = 0;

  const prepared = teams.map((keys) => {
    const members = keys.map((key) => {
      const b = matrix.builtMons[key];
      return { key, speciesId: b.speciesId, name: b.name, pokemon: b.pokemon, spec: b.spec };
    });
    const teamASpec = members.map((m) => m.spec);
    const sig = [...keys].sort().join('|');
    const oppPlans = opponents.map((opp) => ({ opp, pairings: pairingsFor(sig, opp.id) }));
    return { members, teamASpec, oppPlans };
  });

  let allResults = [];
  if (threaded) {
    const allSpecs = [];
    for (const { teamASpec, oppPlans } of prepared) {
      for (const { opp, pairings } of oppPlans) {
        const teamBSpec = opp.members.map((m) => m.spec);
        for (const { leadA, leadB } of pairings) {
          allSpecs.push({ teamA: teamASpec, teamB: teamBSpec, leadA, leadB, difficulty });
        }
      }
    }
    if (allSpecs.length > 0) {
      try {
        allResults = await executor.run(allSpecs);
      } catch (err) {
        onLog?.(`battle batch error (whole generation's ${allSpecs.length} battles skipped): ${err.message}`);
        allResults = new Array(allSpecs.length).fill({ ok: false, error: { message: err.message } });
      }
    }
  }
  let cursor = 0;

  const results = [];
  for (let idx = 0; idx < prepared.length; idx++) {
    const { members, oppPlans } = prepared[idx];
    const teamA = members.map((m) => m.pokemon);

    let winPoints = 0;
    let hpSum = 0;
    let battles = 0;
    let candidateErrors = 0;
    const perMeta = [];
    const leadWins = [0, 0, 0];
    const leadBattles = [0, 0, 0];
    const swapHpSum = [0, 0, 0];
    const swapHpCount = [0, 0, 0];

    for (const { opp, pairings } of oppPlans) {
      const teamB = opp.members.map((m) => m.pokemon);
      let oppWinPoints = 0;
      let oppHpSum = 0;
      let oppBattles = 0;
      let oppWins = 0;
      let oppLosses = 0;
      let oppTies = 0;

      for (const { leadA, leadB } of pairings) {
        let r;
        if (threaded) {
          const slot = allResults[cursor++];
          if (!slot.ok) {
            errorCount += 1;
            candidateErrors += 1;
            onLog?.(
              `battle error (skipped): team=[${members.map((m) => m.name).join('/')}] ` +
                `opponent="${opp.name}" leadA=${leadA} leadB=${leadB}: ${slot.error.message}`
            );
            continue;
          }
          r = slot.value;
        } else {
          try {
            r = battleTeams(ctx, { teamA, teamB, leadA, leadB, difficulty });
          } catch (err) {
            errorCount += 1;
            candidateErrors += 1;
            onLog?.(
              `battle error (skipped): team=[${members.map((m) => m.name).join('/')}] ` +
                `opponent="${opp.name}" leadA=${leadA} leadB=${leadB}: ${err.message}`
            );
            continue;
          }
        }

        battleCount += 1;
        battles += 1;
        oppBattles += 1;
        const margin = r.survivorsHp.a - r.survivorsHp.b;
        hpSum += margin;
        oppHpSum += margin;
        if (r.winner === 'a') {
          winPoints += 1;
          oppWinPoints += 1;
          oppWins += 1;
        } else if (r.winner === 'tie') {
          winPoints += 0.5;
          oppWinPoints += 0.5;
          oppTies += 1;
        } else {
          oppLosses += 1;
        }

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
        perMeta.push({
          metaTeamId: opp.id,
          name: opp.name,
          label: opp.label ?? null,
          wins: oppWins,
          losses: oppLosses,
          ties: oppTies,
          winRate: oppWinPoints / oppBattles,
          avgHpMargin: oppHpSum / oppBattles,
        });
      }
    }

    const winRate = battles > 0 ? winPoints / battles : 0;
    const avgHpMargin = battles > 0 ? hpSum / battles : 0;
    const entry = {
      members: members.map(({ key, speciesId, name }) => ({ key, speciesId, name })),
      winRate,
      avgHpMargin,
      battles,
      errors: candidateErrors,
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
    }

    results.push(entry); // positional -- NOT sorted, unlike tournament.mjs's runFunnelStage
  }

  return { results, battleCount, errorCount, elapsedMs: Date.now() - startedAt, startedAt, finishedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Report + DONE-marker rendering.
// ---------------------------------------------------------------------------

function renderEvolveReport(result) {
  const { config, generationRecords, elites, stopReason, importWarnings, league } = result;
  const out = [];

  out.push(`# ${league.name} Evolutionary Team Search Report`);
  out.push('');
  out.push(`Collection: \`${result.collectionPath}\``);
  out.push(`Generated: ${new Date().toISOString()}`);
  out.push(`Run started: ${result.runStartedAt}`);
  out.push('');
  out.push(
    'Genetic-algorithm search (PLAN.md Rev 5): a population of candidate teams is repeatedly battled, the ' +
      'worst performers die, some survivors mutate one team member, fresh immigrant teams keep the gene pool ' +
      "open, and the process repeats until the top teams converge or the generation/deadline cap is hit. Every " +
      "battle runs through pvpoke's own 3v3 emulate engine (`battleTeams`, `src/engine/teamBattle.js`) -- no " +
      'battle math is reimplemented here.'
  );
  out.push('');
  out.push(
    '> **Reading the win%:** every team is always evaluated as team A (the fixed-side convention from ' +
      "`src/teams/index.js`), so pvpoke emulate mode's small residual player-1 edge is a constant offset shared " +
      'by every team -- it cancels in the *relative* ranking, but absolute win% carries that constant offset.'
  );
  out.push('');

  out.push('## Settings');
  out.push('');
  out.push(`- Seed: \`${config.seed}\` (per-generation opponent draws: \`-gen<N>\`; population sampling: \`-gen0\`)`);
  out.push(`- League: ${league.name} (cp=${config.cp})`);
  out.push(
    `- population=${config.population}, opponents-per-gen=${config.opponentsPerGen}, generations cap=${config.generations}, ` +
      `elites=${config.eliteCount}${config.fixedOpponents ? ', fixed-opponents (one draw reused every generation)' : ''}`
  );
  out.push(`- score-meta=${config.scoreMeta}, pool=${config.pool}, curated-ratio=${config.curatedRatio}`);
  const threadsLabel = (r) => (r.threadsUsed ? `${r.threadsUsed} (worker-pool executor)` : 'serial');
  out.push(`- threads: ${generationRecords.length ? threadsLabel(generationRecords[generationRecords.length - 1]) : 'n/a'}`);
  if (config.excludeSpecies.length) out.push(`- excluded species: ${config.excludeSpecies.join(', ')}`);
  if (config.difficulty !== null) out.push(`- AI difficulty override: ${config.difficulty}`);
  out.push('');

  out.push('## Run summary');
  out.push('');
  const totalBattles = generationRecords.reduce((s, r) => s + r.timing.battleCount, 0) + result.eliteTiming.battleCount;
  const totalErrors = generationRecords.reduce((s, r) => s + r.timing.errorCount, 0) + result.eliteTiming.errorCount;
  out.push(`- Generations run: ${generationRecords.length} of a ${config.generations} cap`);
  out.push(`- Stop reason: ${stopReason}`);
  out.push(`- Total battles: ${totalBattles} (${totalErrors} errors, skip-and-continue)`);
  out.push(`- Total elapsed: ${formatDuration(result.totalElapsedMs)}`);
  out.push('');

  out.push('## Generation-by-generation summary');
  out.push('');
  out.push('| Gen | Mean fitness | Max fitness | Battles | Errors | Survived | Mutant | Immigrant | Elapsed |');
  out.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const r of generationRecords) {
    const oc = r.analytics.originCounts;
    out.push(
      `| ${r.generation}${r.resumed ? ' _(resumed)_' : ''} | ${(r.analytics.meanFitness * 100).toFixed(1)}% | ` +
        `${(r.analytics.maxFitness * 100).toFixed(1)}% | ${r.timing.battleCount} | ${r.timing.errorCount} | ` +
        `${oc ? oc.survived : '-'} | ${oc ? oc.mutant : '-'} | ${oc ? oc.immigrant : '-'} | ${formatDuration(r.timing.elapsedMs)} |`
    );
  }
  out.push('');

  const lastAnalytics = generationRecords.length ? generationRecords[generationRecords.length - 1].analytics : null;
  out.push('## Species trajectory (representation per generation)');
  out.push('');
  if (!lastAnalytics || lastAnalytics.speciesStats.length === 0) {
    out.push('_No species data available._');
  } else {
    const topSpecies = lastAnalytics.speciesStats.slice(0, TRAJECTORY_SPECIES_CAP).map((s) => s.speciesId);
    const header = ['Species', ...generationRecords.map((r) => `Gen ${r.generation}`)];
    out.push(`| ${header.join(' | ')} |`);
    out.push(`| ${header.map(() => '---').join(' | ')} |`);
    for (const speciesId of topSpecies) {
      const row = generationRecords.map((r) => {
        const s = r.analytics.speciesStats.find((x) => x.speciesId === speciesId);
        return s ? pct(s.representation) : '-';
      });
      out.push(`| ${speciesId} | ${row.join(' | ')} |`);
    }
    if (lastAnalytics.speciesStatsTruncated) {
      out.push('');
      out.push(`_Species list capped at ${SPECIES_STATS_CAP} per generation in the analytics JSON; showing the top ${TRAJECTORY_SPECIES_CAP} by final representation here._`);
    }
  }
  out.push('');

  out.push('## Top cores (elite 2-species pairs, final generation)');
  out.push('');
  if (!lastAnalytics || lastAnalytics.topCores.length === 0) {
    out.push('_No core data available._');
  } else {
    out.push('| Core | Count among top 10 |');
    out.push('| --- | ---: |');
    for (const c of lastAnalytics.topCores) out.push(`| ${c.core} | ${c.count} |`);
  }
  out.push('');

  out.push(`## Top ${elites.length} teams (final-generation elites, full 9-lead-pairing evaluation)`);
  out.push('');
  if (elites.length === 0) {
    out.push('_No elite teams were produced._');
    out.push('');
  } else {
    out.push('| Rank | Team | Win% | Best lead | Avg HP margin |');
    out.push('| --- | --- | ---: | --- | ---: |');
    elites.forEach((t, i) => {
      out.push(`| ${i + 1} | ${t.members.map((m) => m.name).join(', ')} | ${pct(t.winRate)} | ${t.bestLead.name} | ${signed(t.avgHpMargin)} |`);
    });
    out.push('');
  }

  out.push('## Elite team detail');
  out.push('');
  elites.forEach((t, i) => {
    out.push(`### ${i + 1}. ${t.members.map((m) => m.name).join(', ')}`);
    out.push('');
    out.push(`- **Win rate:** ${pct(t.winRate)} across ${t.battles} battles (${t.errors} errors)`);
    out.push(`- **Best lead:** ${t.bestLead.name} (${pct(t.bestLead.winRate)} when leading)`);
    if (t.safeSwap) {
      out.push(`- **Safest first switch:** ${t.safeSwap.name} (avg ${pct(t.safeSwap.avgHpPct)} HP remaining when switched in)`);
    }
    out.push(`- **Avg surviving-HP margin:** ${signed(t.avgHpMargin)}`);
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

  out.push('## Collection warnings');
  out.push('');
  if (importWarnings.length === 0) {
    out.push('_None -- every row imported and scored cleanly._');
  } else {
    for (const w of importWarnings) out.push(`- ${w}`);
  }
  out.push('');

  return out.join('\n');
}

/**
 * Render the same run result as a single self-contained HTML page (no
 * external CSS/JS/fonts -- opens directly via `file://`), mirroring
 * src/report/index.js's renderReportHtml pattern (same section order and
 * content as {@link renderEvolveReport}, just HTML markup). All interpolated
 * text sourced from user CSV/gamemaster data is HTML-escaped.
 *
 * @param {object} result - same shape renderEvolveReport takes.
 * @returns {string} HTML document text.
 */
function renderEvolveReportHtml(result) {
  const { config, generationRecords, elites, stopReason, importWarnings, league } = result;
  const threadsLabel = (r) => (r.threadsUsed ? `${r.threadsUsed} (worker-pool executor)` : 'serial');
  const settingsLine = [
    `population=${config.population}`,
    `opponents-per-gen=${config.opponentsPerGen}`,
    `generations cap=${config.generations}`,
    `elites=${config.eliteCount}`,
    config.fixedOpponents ? 'fixed-opponents (one draw reused every generation)' : null,
    `score-meta=${config.scoreMeta}`,
    `pool=${config.pool}`,
    `curated-ratio=${config.curatedRatio}`,
    `threads=${generationRecords.length ? threadsLabel(generationRecords[generationRecords.length - 1]) : 'n/a'}`,
    config.excludeSpecies.length ? `excluded species: ${config.excludeSpecies.map(escapeHtml).join(', ')}` : null,
    config.difficulty !== null ? `AI difficulty override: ${config.difficulty}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const totalBattles = generationRecords.reduce((s, r) => s + r.timing.battleCount, 0) + result.eliteTiming.battleCount;
  const totalErrors = generationRecords.reduce((s, r) => s + r.timing.errorCount, 0) + result.eliteTiming.errorCount;

  const out = [];
  out.push('<!doctype html>');
  out.push('<html lang="en">');
  out.push('<head>');
  out.push('<meta charset="utf-8">');
  out.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  out.push(`<title>${escapeHtml(league.name)} Evolutionary Team Search Report${result.collectionPath ? ` -- ${escapeHtml(result.collectionPath)}` : ''}</title>`);
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

  out.push(`<h1>${escapeHtml(league.name)} Evolutionary Team Search Report</h1>`);
  out.push(`<p>Collection: <code>${escapeHtml(result.collectionPath)}</code>` +
    `<br>Generated: ${escapeHtml(new Date().toISOString())}` +
    `<br>Run started: ${escapeHtml(result.runStartedAt)}</p>`);
  out.push(
    '<p>Genetic-algorithm search (PLAN.md Rev 5): a population of candidate teams is repeatedly battled, the ' +
      'worst performers die, some survivors mutate one team member, fresh immigrant teams keep the gene pool ' +
      "open, and the process repeats until the top teams converge or the generation/deadline cap is hit. Every " +
      "battle runs through pvpoke's own 3v3 emulate engine (<code>battleTeams</code>, " +
      '<code>src/engine/teamBattle.js</code>) -- no battle math is reimplemented here.</p>'
  );
  out.push(
    '<p class="callout"><strong>Reading the win%:</strong> every team is always evaluated as team A (the ' +
      'fixed-side convention from <code>src/teams/index.js</code>), so pvpoke emulate mode\'s small residual ' +
      "player-1 edge is a constant offset shared by every team -- it cancels in the <em>relative</em> ranking, " +
      'but absolute win% carries that constant offset.</p>'
  );

  out.push('<h2>Settings</h2>');
  out.push(`<p class="settings">Seed: <code>${escapeHtml(config.seed)}</code> (per-generation opponent draws: ` +
    `<code>-gen&lt;N&gt;</code>; population sampling: <code>-gen0</code>)<br>` +
    `League: ${escapeHtml(league.name)} (cp=${config.cp})<br>` +
    `${escapeHtml(settingsLine)}</p>`);

  out.push('<h2>Run summary</h2>');
  out.push('<ul>');
  out.push(`<li>Generations run: ${generationRecords.length} of a ${config.generations} cap</li>`);
  out.push(`<li>Stop reason: ${escapeHtml(stopReason)}</li>`);
  out.push(`<li>Total battles: ${totalBattles} (${totalErrors} errors, skip-and-continue)</li>`);
  out.push(`<li>Total elapsed: ${escapeHtml(formatDuration(result.totalElapsedMs))}</li>`);
  out.push('</ul>');

  out.push('<h2>Generation-by-generation summary</h2>');
  out.push('<table>');
  out.push('<thead><tr><th>Gen</th><th>Mean fitness</th><th>Max fitness</th><th>Battles</th>' +
    '<th>Errors</th><th>Survived</th><th>Mutant</th><th>Immigrant</th><th>Elapsed</th></tr></thead>');
  out.push('<tbody>');
  for (const r of generationRecords) {
    const oc = r.analytics.originCounts;
    out.push(
      `<tr><td>${r.generation}${r.resumed ? ' <em>(resumed)</em>' : ''}</td>` +
        `<td>${(r.analytics.meanFitness * 100).toFixed(1)}%</td>` +
        `<td>${(r.analytics.maxFitness * 100).toFixed(1)}%</td>` +
        `<td>${r.timing.battleCount}</td><td>${r.timing.errorCount}</td>` +
        `<td>${oc ? oc.survived : '-'}</td><td>${oc ? oc.mutant : '-'}</td><td>${oc ? oc.immigrant : '-'}</td>` +
        `<td>${escapeHtml(formatDuration(r.timing.elapsedMs))}</td></tr>`
    );
  }
  out.push('</tbody></table>');

  const lastAnalytics = generationRecords.length ? generationRecords[generationRecords.length - 1].analytics : null;
  out.push('<h2>Species trajectory (representation per generation)</h2>');
  if (!lastAnalytics || lastAnalytics.speciesStats.length === 0) {
    out.push('<p><em>No species data available.</em></p>');
  } else {
    const topSpecies = lastAnalytics.speciesStats.slice(0, TRAJECTORY_SPECIES_CAP).map((s) => s.speciesId);
    out.push('<table>');
    out.push(`<thead><tr><th>Species</th>${generationRecords.map((r) => `<th>Gen ${r.generation}</th>`).join('')}</tr></thead>`);
    out.push('<tbody>');
    for (const speciesId of topSpecies) {
      const row = generationRecords.map((r) => {
        const s = r.analytics.speciesStats.find((x) => x.speciesId === speciesId);
        return `<td>${s ? pct(s.representation) : '-'}</td>`;
      });
      out.push(`<tr><td>${escapeHtml(speciesId)}</td>${row.join('')}</tr>`);
    }
    out.push('</tbody></table>');
    if (lastAnalytics.speciesStatsTruncated) {
      out.push(`<p><em>Species list capped at ${SPECIES_STATS_CAP} per generation in the analytics JSON; ` +
        `showing the top ${TRAJECTORY_SPECIES_CAP} by final representation here.</em></p>`);
    }
  }

  out.push('<h2>Top cores (elite 2-species pairs, final generation)</h2>');
  if (!lastAnalytics || lastAnalytics.topCores.length === 0) {
    out.push('<p><em>No core data available.</em></p>');
  } else {
    out.push('<table>');
    out.push('<thead><tr><th>Core</th><th>Count among top 10</th></tr></thead>');
    out.push('<tbody>');
    for (const c of lastAnalytics.topCores) out.push(`<tr><td>${escapeHtml(c.core)}</td><td>${c.count}</td></tr>`);
    out.push('</tbody></table>');
  }

  out.push(`<h2>Top ${elites.length} teams (final-generation elites, full 9-lead-pairing evaluation)</h2>`);
  if (elites.length === 0) {
    out.push('<p><em>No elite teams were produced.</em></p>');
  } else {
    out.push('<table>');
    out.push('<thead><tr><th>Rank</th><th>Team</th><th>Win%</th><th>Best lead</th><th>Avg HP margin</th></tr></thead>');
    out.push('<tbody>');
    elites.forEach((t, i) => {
      out.push(
        `<tr><td>${i + 1}</td><td>${escapeHtml(t.members.map((m) => m.name).join(', '))}</td>` +
          `<td>${pct(t.winRate)}</td><td>${escapeHtml(t.bestLead.name)}</td><td>${signed(t.avgHpMargin)}</td></tr>`
      );
    });
    out.push('</tbody></table>');
  }

  out.push('<h2>Elite team detail</h2>');
  elites.forEach((t, i) => {
    out.push('<section class="team">');
    out.push(`<h3>${i + 1}. ${escapeHtml(t.members.map((m) => m.name).join(', '))}</h3>`);
    out.push('<ul class="team-stats">');
    out.push(`<li><strong>Win rate:</strong> ${pct(t.winRate)} across ${t.battles} battles (${t.errors} errors)</li>`);
    out.push(`<li><strong>Best lead:</strong> ${escapeHtml(t.bestLead.name)} (${pct(t.bestLead.winRate)} when leading)</li>`);
    if (t.safeSwap) {
      out.push(
        `<li><strong>Safest first switch:</strong> ${escapeHtml(t.safeSwap.name)} ` +
          `(avg ${pct(t.safeSwap.avgHpPct)} HP remaining when switched in)</li>`
      );
    }
    out.push(`<li><strong>Avg surviving-HP margin:</strong> ${signed(t.avgHpMargin)}</li>`);
    out.push('</ul>');
    out.push('<p>5 hardest opponents (by win%):</p>');
    out.push('<table>');
    out.push('<thead><tr><th>Opponent</th><th>Win%</th><th>W</th><th>L</th><th>T</th><th>HP margin</th></tr></thead>');
    out.push('<tbody>');
    for (const h of t.hardestOpponents) {
      out.push(
        `<tr><td>${escapeHtml(h.name)}${h.label ? ` <em>(${escapeHtml(h.label)})</em>` : ''}</td>` +
          `<td>${pct(h.winRate)}</td><td>${h.wins}</td><td>${h.losses}</td><td>${h.ties}</td>` +
          `<td>${signed(h.avgHpMargin)}</td></tr>`
      );
    }
    out.push('</tbody></table>');
    out.push('</section>');
  });

  out.push('<h2>Collection warnings</h2>');
  if (importWarnings.length === 0) {
    out.push('<p><em>None -- every row imported and scored cleanly.</em></p>');
  } else {
    out.push('<ul>');
    for (const w of importWarnings) out.push(`<li>${escapeHtml(w)}</li>`);
    out.push('</ul>');
  }

  out.push('</body>');
  out.push('</html>');

  return out.join('\n');
}

function renderDoneMarker(result) {
  const lines = [new Date().toISOString()];
  lines.push(`Evolution complete: ${result.generationRecords.length} generation(s) run (${result.stopReason}).`);
  const top = result.elites[0];
  if (top) {
    lines.push(`Top team: ${top.members.map((m) => m.name).join(', ')} (${pct(top.winRate)} win rate, best lead ${top.bestLead.name}).`);
  } else {
    lines.push('No elite teams were produced.');
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
 * test/evolveScript.test.js can drive it in-process (same pattern as
 * scripts/tournament.mjs's runTournament / src/cli.js's runPipeline).
 *
 * @param {string} csvPath
 * @param {{
 *   scoreMeta?:number, pool?:number, seed?:number|string, cp?:number,
 *   curatedRatio?:number, excludeSpecies?:string[], difficulty?:number,
 *   population?:number, opponentsPerGen?:number, generations?:number,
 *   fixedOpponents?:boolean, eliteCount?:number,
 *   deadlineMinutes?:number, - simple stop-before-next-generation budget;
 *     NOT part of the checkpoint config fingerprint (see buildRunConfig).
 *   threads?:number, - GOALS T21-style: when set, ONE persistent
 *     src/engine/parallel.js createExecutor() pool is booted for the WHOLE
 *     run and reused across every generation AND the final elites pass.
 *     Omitted/falsy keeps the serial battleTeams loop. NOT part of the
 *     checkpoint fingerprint (pure performance knob).
 *   outDir?:string, out?:string, - out = Markdown report path.
 *   html?:string, noHtml?:boolean, - HTML report path (default
 *     <outDir>/my-teams-evolve.html) and an opt-out (mirrors src/cli.js's
 *     --html/--no-html), GOALS T25.
 *   onProgress?:(p:{generation:number, completed:number, total:number, startedAt:number})=>void,
 *   onLog?:(msg:string)=>void,
 * }} [opts]
 * @returns {Promise<object>} the full run result; also written to disk.
 */
export async function runEvolution(csvPath, opts = {}) {
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

  const { mons, warnings: importWarnings } = importCollection(csvPath);
  const ctx = await initEngine({ cp: config.cp });
  const league = leagueForCp(config.cp);
  const matrix = scoreCollection(ctx, mons, { metaLimit: config.scoreMeta });
  const deduped = dedupeBestPerSpecies(matrix);
  const weights = loadUsageWeights(ctx);
  const pool = buildSamplingPool(deduped, config.pool, config.excludeSpecies);
  log(`evolve: shared setup done -- ${matrix.mons.length} mons scored, sampling pool of ${pool.length} species, league=${league.name}`);

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
    const history = []; // [{population, fitness}], oldest-first -- for hasConverged
    const generationRecords = []; // full per-generation records for the report

    while (true) {
      const cp = readCheckpoint(outDir, generation);
      if (!cp || !configsMatch(cp.config, config)) break;
      history.push({ population: cp.population, fitness: cp.fitness });
      generationRecords.push({ ...cp, resumed: true });
      if (generation === 0) runStartedAtMs = new Date(cp.runStartedAt).getTime();
      population = cp.nextPopulation;
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
        count: config.population,
        seed: `${config.seed}-gen0`,
        excludeSpecies: config.excludeSpecies,
      });
      log(`evolve: starting fresh -- population ${population.length} (requested ${config.population}), seed ${config.seed}`);
    }

    let stopReason = null;
    let fixedOpponentsPool = null;
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

      const opponents = config.fixedOpponents
        ? (fixedOpponentsPool ??= sampleOpponentTeams(ctx, {
            count: config.opponentsPerGen,
            weights,
            seed: `${config.seed}-opponents`,
            curatedRatio: config.curatedRatio,
          }))
        : sampleOpponentTeams(ctx, {
            count: config.opponentsPerGen,
            weights,
            seed: `${config.seed}-gen${generation}`,
            curatedRatio: config.curatedRatio,
          });

      log(`generation ${generation}: battling ${population.length} teams against ${opponents.length} opponents`);
      const run = await evaluateTeamsInOrder(ctx, {
        teams: population,
        matrix: deduped,
        opponents,
        pairingsFor: (sig, oppId) => threeRandomPairings(`${config.seed}-gen${generation}`, sig, oppId),
        difficulty,
        executor,
        onLog: log,
      });
      const fitness = run.results.map((r) => r.winRate);

      history.push({ population, fitness });
      const isLastAllowedGeneration = generation === config.generations - 1;

      let lineage = null;
      let nextPopulation = [];
      if (!isLastAllowedGeneration) {
        const advanced = nextGeneration({
          population,
          fitness,
          pool,
          matrix: deduped,
          weights,
          seed: `${config.seed}-next${generation}`,
          opts: { excludeSpecies: config.excludeSpecies },
        });
        lineage = advanced.lineage;
        nextPopulation = advanced.population;
      }

      const record = {
        generation,
        config,
        runStartedAt: new Date(runStartedAtMs).toISOString(),
        threadsUsed: threaded ? threads : null,
        population,
        fitness,
        opponentCount: opponents.length,
        lineage,
        nextPopulation,
        timing: {
          startedAt: new Date(run.startedAt).toISOString(),
          finishedAt: new Date(run.finishedAt).toISOString(),
          elapsedMs: run.elapsedMs,
          battleCount: run.battleCount,
          errorCount: run.errorCount,
          msPerBattle: run.battleCount > 0 ? run.elapsedMs / run.battleCount : FALLBACK_MS_PER_BATTLE,
        },
        analytics: computeGenerationAnalytics({ matrix: deduped, population, fitness, lineage }),
        resumed: false,
      };
      writeCheckpoint(outDir, generation, record);
      generationRecords.push(record);
      writeGenerationsAnalytics(outDir, generationRecords);
      lastEvaluated = record;
      log(
        `generation ${generation}: done -- mean fitness ${(record.analytics.meanFitness * 100).toFixed(1)}%, ` +
          `${run.battleCount} battles (${run.errorCount} errors), ${formatDuration(run.elapsedMs)} elapsed`
      );

      const conv = hasConverged(history);
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
    }

    if (!stopReason) stopReason = `generations cap reached (${config.generations})`;
    if (!lastEvaluated) {
      throw new Error('evolve: no generation was ever evaluated (population sampling produced 0 teams from the start)');
    }

    // ---- Final elites pass: top --elites of the LAST EVALUATED generation, full 9 lead pairings. ----
    const rankedIdx = lastEvaluated.population
      .map((_, i) => i)
      .sort((a, b) => lastEvaluated.fitness[b] - lastEvaluated.fitness[a] || a - b);
    const eliteTeams = rankedIdx.slice(0, config.eliteCount).map((i) => lastEvaluated.population[i]);

    const eliteOpponents = sampleOpponentTeams(ctx, {
      count: config.opponentsPerGen,
      weights,
      seed: `${config.seed}-elites`,
      curatedRatio: config.curatedRatio,
    });
    log(`evolve: final elites pass -- ${eliteTeams.length} teams x ${eliteOpponents.length} opponents, full 9 lead pairings`);
    const eliteRun = await evaluateTeamsInOrder(ctx, {
      teams: eliteTeams,
      matrix: deduped,
      opponents: eliteOpponents,
      pairingsFor: () => ninePairings(),
      difficulty,
      trackLeads: true,
      executor,
      onLog: log,
    });
    const elites = eliteRun.results
      .map((r, i) => ({ ...r, sourceIndex: rankedIdx[i] }))
      .sort((a, b) => b.winRate - a.winRate || b.avgHpMargin - a.avgHpMargin);

    const result = {
      collectionPath: csvPath,
      reportPath,
      htmlPath: writeHtml ? htmlPath : null,
      outDir,
      donePath: path.join(outDir, 'evolve-DONE'),
      config,
      league,
      runStartedAt: new Date(runStartedAtMs).toISOString(),
      importWarnings,
      generationRecords,
      stopReason,
      elites,
      eliteTiming: {
        battleCount: eliteRun.battleCount,
        errorCount: eliteRun.errorCount,
        elapsedMs: eliteRun.elapsedMs,
      },
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

    writeFileSync(result.donePath, renderDoneMarker(result), 'utf8');
    log(`evolve: DONE (${result.donePath})`);

    return result;
  }
}

// ---------------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------------

const HELP = `pogo-gbl-team-generator evolve -- genetic-algorithm team search (PLAN.md Rev 5)

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
  --fixed-opponents        reuse ONE opponent draw for every generation
                            instead of a fresh draw per generation     (default: off)
  --elites N               final-generation teams given the full 9-lead-
                            pairing evaluation for the report          (default ${DEFAULTS.elites})
  --score-meta S           1v1-pruning meta size                      (default ${DEFAULTS.scoreMeta})
  --pool P                 sampling pool size                         (default ${DEFAULTS.pool})
  --curated-ratio R        curated-vs-sampled opponent mix             (default ${DEFAULTS.curatedRatio})
  --exclude a,b            species ids excluded from candidate teams   (default: none)
  --difficulty D           AI difficulty 0-3 override                 (default: engine default, 3)
  --out PATH               final Markdown report path                 (default <out-dir>/my-teams-evolve.md)
  --html PATH              final HTML report path                     (default <out-dir>/${DEFAULTS.html})
  --no-html                skip writing the HTML report
  --out-dir DIR            checkpoints + DONE marker + default reports (default "${DEFAULTS.outDir}")
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
        exclude: { type: 'string' },
        difficulty: { type: 'string' },
        out: { type: 'string' },
        html: { type: 'string' },
        'no-html': { type: 'boolean' },
        'out-dir': { type: 'string' },
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
    pool: intFlag(values.pool, 'pool', DEFAULTS.pool),
    curatedRatio: fractionFlag(values['curated-ratio'], 'curated-ratio', DEFAULTS.curatedRatio),
    excludeSpecies: values.exclude ? values.exclude.split(',').map((s) => s.trim()).filter(Boolean) : [],
    difficulty: values.difficulty !== undefined ? intFlag(values.difficulty, 'difficulty', undefined) : undefined,
    outDir: values['out-dir'] ?? DEFAULTS.outDir,
    out: values.out,
    html: values.html,
    noHtml: !!values['no-html'],
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
    say(`Top team: ${top.members.map((m) => m.name).join(', ')} -- ${pct(top.winRate)} win rate.`);
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
