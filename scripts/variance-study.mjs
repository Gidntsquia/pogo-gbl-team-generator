#!/usr/bin/env node
// JavaScript Document
//
// TrainingAI variance study: quantifies how much team-battle
// results move when the SAME set of battles runs in a DIFFERENT ORDER,
// isolating that from AI/seed randomness (which is already pinned -- see
// below) so the ticket's actual open question gets a real number instead of
// an anecdote.
//
// Background (see src/engine/README.md's "Known limitation" section):
// vendor/pvpoke's own TrainingAI makes plenty of Math.random()
// calls (energy estimation, move-option selection, IV-combo picks, buff
// rolls -- see vendor/pvpoke/src/js/training/TrainingAI.js), but
// src/engine/teamBattle.js already patches the vm's Math.random with a
// seeded mulberry32 PRNG derived per battle from (teams, leads, seed) --
// test/bench.test.js already verifies battleTeams is bit-identical for a
// FIXED battle order under a fixed seed. So "AI randomness" itself
// contributes ZERO variance once pinned; the actual variance source found
// earlier is different: pvpoke's own Pokemon#resetMoves() reads a
// stale `self.index` (this Pokemon's battle SLOT from whichever Battle it
// last fought in) when picking its bestChargedMove tie-break, so a REUSED
// Pokemon instance's chosen moveset -- and therefore that battle's winner --
// can depend on which OTHER battle it fought immediately before, i.e. on
// BATTLE ORDER, not on the seed. One such flip was found by hand (1 battle
// out of 90). This script quantifies it properly: run the SAME real battle
// set (K candidates x M opponents x all 9 lead pairings) through several
// different, seeded-deterministic orderings of that same list, and measure:
//   - how many individual battle winners flip vs a canonical baseline order
//   - whether any candidate's aggregate win rate changes
//   - whether the candidates' RANKING (sorted by win rate) ever changes
// No battle math is reimplemented or touched -- every result still comes
// from battleTeams (src/engine/teamBattle.js), which drives vendor/pvpoke's
// own engine unmodified. This script only decides what order to feed it in.
//
// Usage: node scripts/variance-study.mjs [--candidates 5] [--opponents 5]
//                                        [--shuffles 3] [--seed S] [--json]

import { initEngine } from '../src/engine/harness.js';
import { battleTeams, initTeamBattle } from '../src/engine/teamBattle.js';
import { loadMetaTeams } from '../src/meta/teams.js';
import { rngFromSeed } from '../src/util/rng.js';

const LEADS = [0, 1, 2];

function parseArgs(argv) {
  const opts = { candidates: 5, opponents: 5, shuffles: 3, seed: 'variance-study', json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--candidates') opts.candidates = Number(argv[++i]);
    else if (a === '--opponents') opts.opponents = Number(argv[++i]);
    else if (a === '--shuffles') opts.shuffles = Number(argv[++i]);
    else if (a === '--seed') opts.seed = argv[++i];
    else if (a === '--json') opts.json = true;
  }
  return opts;
}

/** Canonical battle list: candidate outer, opponent middle, lead pairing inner -- same iteration order src/teams/index.js's evaluateTeams uses. */
function canonicalBattleList(candidateCount, opponentCount) {
  const list = [];
  for (let c = 0; c < candidateCount; c++) {
    for (let o = 0; o < opponentCount; o++) {
      for (const leadA of LEADS) {
        for (const leadB of LEADS) {
          list.push({ c, o, leadA, leadB, key: `${c}|${o}|${leadA}|${leadB}` });
        }
      }
    }
  }
  return list;
}

/** Deterministic Fisher-Yates shuffle using the project's own seeded PRNG (not Math.random -- this script's own ordering choices must be reproducible too). */
function seededShuffle(list, seed) {
  const rng = rngFromSeed(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Every ordering to compare against the canonical baseline: the reverse of
 * the canonical list (maximally different adjacency from the baseline) plus
 * `shuffleCount` independently-seeded random shuffles.
 */
function buildOrderings(baseline, shuffleCount, seed) {
  const orderings = [{ name: 'canonical', list: baseline }, { name: 'reversed', list: [...baseline].reverse() }];
  for (let i = 0; i < shuffleCount; i++) {
    orderings.push({ name: `shuffle-${i}`, list: seededShuffle(baseline, `${seed}|shuffle|${i}`) });
  }
  return orderings;
}

/**
 * Run every battle in `ordering` (in that exact sequence) against FRESH
 * candidate/opponent Pokemon instances built just for this ordering (never
 * shared with another ordering's run -- otherwise one ordering's battle
 * history would contaminate the next, defeating the whole point of isolating
 * order effects). Instances ARE reused across every battle WITHIN this one
 * ordering, same as evaluateTeams/tournament.mjs's real build-once-battle-
 * many usage pattern -- that reuse is exactly what the resetMoves()
 * order-sensitivity needs to manifest.
 *
 * @returns {Map<string, {winner:string, hpA:number, hpB:number}>} keyed by the battle's canonical "c|o|leadA|leadB" key (NOT insertion order), so different orderings' results can be compared by key.
 */
async function runOrdering(ctx, ordering, candidateTeams, opponentTeams, difficulty) {
  const candidatePokemon = candidateTeams.map((t) => t.members.map((m) => m.pokemon));
  const opponentPokemon = opponentTeams.map((t) => t.members.map((m) => m.pokemon));

  const results = new Map();
  for (const { c, o, leadA, leadB, key } of ordering.list) {
    const r = battleTeams(ctx, { teamA: candidatePokemon[c], teamB: opponentPokemon[o], leadA, leadB, difficulty });
    results.set(key, { winner: r.winner, hpA: r.survivorsHp.a, hpB: r.survivorsHp.b });
  }
  return results;
}

function winRatesByCandidate(results, candidateCount, opponentCount) {
  const rates = [];
  for (let c = 0; c < candidateCount; c++) {
    let points = 0;
    let battles = 0;
    for (let o = 0; o < opponentCount; o++) {
      for (const leadA of LEADS) {
        for (const leadB of LEADS) {
          const r = results.get(`${c}|${o}|${leadA}|${leadB}`);
          battles += 1;
          if (r.winner === 'a') points += 1;
          else if (r.winner === 'tie') points += 0.5;
        }
      }
    }
    rates.push(points / battles);
  }
  return rates;
}

/** Candidate indices sorted best-first by win rate (ties broken by index, for a stable comparison). */
function rankingOf(rates) {
  return rates.map((rate, c) => ({ c, rate })).sort((a, b) => b.rate - a.rate || a.c - b.c).map((r) => r.c);
}

/**
 * @param {object} ctx - from initEngine.
 * @param {{ candidates?:number, opponents?:number, shuffles?:number, seed?:string|number, difficulty?:number }} [opts]
 * @returns {Promise<object>} a summary report (see inline shape below); also printed as text/JSON by main().
 */
export async function runVarianceStudy(ctx, opts = {}) {
  const candidateCount = opts.candidates ?? 5;
  const opponentCount = opts.opponents ?? 5;
  const shuffleCount = opts.shuffles ?? 3;
  const seed = opts.seed ?? 'variance-study';
  const difficulty = opts.difficulty;

  initTeamBattle(ctx);

  const pool = loadMetaTeams(ctx);
  const needed = candidateCount + opponentCount;
  if (pool.length < needed) {
    throw new Error(
      `runVarianceStudy: curated meta pool only has ${pool.length} teams, need ${needed} (candidates + opponents)`
    );
  }

  const baseline = canonicalBattleList(candidateCount, opponentCount);
  const orderings = buildOrderings(baseline, shuffleCount, seed);
  const totalBattlesPerOrdering = baseline.length;

  const orderingReports = [];
  let baselineResults = null;
  let baselineRates = null;
  let baselineRanking = null;

  for (const ordering of orderings) {
    // Fresh team instances per ordering -- loadMetaTeams(ctx) rebuilds every
    // Pokemon from scratch, so no battle history carries over from a
    // previous ordering's run (see this function's/runOrdering's header
    // comments for why that matters).
    const freshPool = loadMetaTeams(ctx);
    const candidateTeams = freshPool.slice(0, candidateCount);
    const opponentTeams = freshPool.slice(candidateCount, candidateCount + opponentCount);

    const results = await runOrdering(ctx, ordering, candidateTeams, opponentTeams, difficulty);
    const rates = winRatesByCandidate(results, candidateCount, opponentCount);
    const ranking = rankingOf(rates);

    if (ordering.name === 'canonical') {
      baselineResults = results;
      baselineRates = rates;
      baselineRanking = ranking;
      orderingReports.push({ name: ordering.name, flips: 0, flipRate: 0, winRates: rates, rankingChanged: false });
      continue;
    }

    let flips = 0;
    for (const [key, r] of results) {
      if (r.winner !== baselineResults.get(key).winner) flips += 1;
    }
    const rankingChanged = JSON.stringify(ranking) !== JSON.stringify(baselineRanking);

    orderingReports.push({
      name: ordering.name,
      flips,
      flipRate: flips / totalBattlesPerOrdering,
      winRates: rates,
      rankingChanged,
    });
  }

  const nonBaseline = orderingReports.filter((o) => o.name !== 'canonical');
  const totalFlips = nonBaseline.reduce((sum, o) => sum + o.flips, 0);
  const maxWinRateDelta = Math.max(
    0,
    ...nonBaseline.flatMap((o) => o.winRates.map((rate, c) => Math.abs(rate - baselineRates[c])))
  );

  return {
    candidateCount,
    opponentCount,
    totalBattlesPerOrdering,
    orderingCount: orderings.length,
    orderings: orderingReports,
    summary: {
      totalFlipsAcrossNonBaselineOrderings: totalFlips,
      meanFlipRate: nonBaseline.length ? totalFlips / (nonBaseline.length * totalBattlesPerOrdering) : 0,
      maxWinRateDelta,
      anyRankingChanged: nonBaseline.some((o) => o.rankingChanged),
    },
  };
}

function printReport(report) {
  console.log(
    `variance-study: ${report.candidateCount} candidates x ${report.opponentCount} opponents x 9 pairings ` +
      `= ${report.totalBattlesPerOrdering} battles/ordering, ${report.orderingCount} orderings (1 baseline + ${
        report.orderingCount - 1
      } compared)`
  );
  for (const o of report.orderings) {
    if (o.name === 'canonical') {
      console.log(`  ${o.name} (baseline): win rates = [${o.winRates.map((r) => r.toFixed(3)).join(', ')}]`);
      continue;
    }
    console.log(
      `  ${o.name}: ${o.flips}/${report.totalBattlesPerOrdering} battles flipped ` +
        `(${(o.flipRate * 100).toFixed(2)}%), ranking changed: ${o.rankingChanged}, ` +
        `win rates = [${o.winRates.map((r) => r.toFixed(3)).join(', ')}]`
    );
  }
  const s = report.summary;
  console.log(
    `  SUMMARY: ${s.totalFlipsAcrossNonBaselineOrderings} total flips across all non-baseline orderings ` +
      `(mean flip rate ${(s.meanFlipRate * 100).toFixed(3)}%), max win-rate delta ${s.maxWinRateDelta.toFixed(4)}, ` +
      `ranking ever changed: ${s.anyRankingChanged}`
  );
}

async function main(argv) {
  const opts = parseArgs(argv);
  const ctx = await initEngine();
  const report = await runVarianceStudy(ctx, opts);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printReport(report);
  }
}

// Only run when invoked directly (not when imported by tests).
import path from 'node:path';
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`\nError: ${err.message}\n`);
    process.exitCode = 1;
  });
}
