#!/usr/bin/env node
// JavaScript Document
//
// GOALS T27 (PLAN.md Rev 6): alignment/shield ground-truth investigation.
// Jaxon's observation, after an 82-generation evolve run, was that the sim
// favors consistent neutral-matchup mons (Stunfisk in 9/10 elites) because
// fitness averages lead pairings uniformly and ignores two real GBL
// dynamics: (1) winning the LEAD EXCHANGE (whichever side's starting
// Pokemon faints first) grants switch/counter-pick advantage and often
// snowballs the game; (2) banking shields for a back-line "closer" is a real
// winning strategy the symmetric-shields view misses. The diagnosis (see
// PLAN.md Rev 6) is that vendor/pvpoke's own TrainingAI already MODELS both
// mechanics (counter-switching after faints, shield/bait decisions) -- the
// gap is in OUR measurement and fitness, not the engine. This script
// measures, as the engine actually plays real 3v3 battles, how strongly a
// won lead exchange predicts an overall win, and how win rate varies with
// shields remaining at battle end. No battle math is reimplemented: every
// number comes straight out of battleTeams() (src/engine/teamBattle.js),
// reading pvpoke's own live per-Pokemon/per-Player state (lead HP reaching
// 0, Player#getShields()) that GOALS T27 added to battleTeams' summary.
//
// AI difficulty (T27 question 1): src/engine/teamBattle.js's
// DEFAULT_DIFFICULTY = 3, which vendor/pvpoke/src/data/training/
// aiArchetypes.json confirms is index 3 = "Champion" (Novice=0, Rival=1,
// Elite=2, Champion=3) -- the strongest archetype pvpoke ships, matching the
// GOALS T2 spec ("highest AI difficulty") and unchanged since. This script
// uses that same default unless --difficulty overrides it.
//
// Usage: node scripts/alignment-study.mjs [--candidates 5] [--opponents 8]
//                                          [--seeds 2] [--seed S]
//                                          [--difficulty 3] [--json]

import { initEngine } from '../src/engine/harness.js';
import { battleTeams, initTeamBattle } from '../src/engine/teamBattle.js';
import { loadMetaTeams } from '../src/meta/teams.js';
import { seedFromString } from '../src/util/rng.js';

const LEADS = [0, 1, 2];

function parseArgs(argv) {
  const opts = { candidates: 5, opponents: 8, seeds: 2, seed: 'alignment-study', json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--candidates') opts.candidates = Number(argv[++i]);
    else if (a === '--opponents') opts.opponents = Number(argv[++i]);
    else if (a === '--seeds') opts.seeds = Number(argv[++i]);
    else if (a === '--seed') opts.seed = argv[++i];
    else if (a === '--difficulty') opts.difficulty = Number(argv[++i]);
    else if (a === '--json') opts.json = true;
  }
  return opts;
}

/**
 * One battle spec per (seed variant, candidate, opponent, leadA, leadB).
 * Each seed variant gets its own deterministically-derived per-battle seed
 * (via the project's own seedFromString -- no Math.random), so repeating the
 * SAME candidate/opponent/lead matchup across variants exercises genuinely
 * different AI-random play (energy estimates, move-option picks, buff
 * rolls -- see src/engine/teamBattle.js) rather than just re-running the
 * identical battle, which is what makes >1 seed variant add real samples
 * instead of duplicate ones.
 */
function buildBattleList(candidateCount, opponentCount, seedVariantCount, baseSeed) {
  const list = [];
  for (let v = 0; v < seedVariantCount; v++) {
    for (let c = 0; c < candidateCount; c++) {
      for (let o = 0; o < opponentCount; o++) {
        for (const leadA of LEADS) {
          for (const leadB of LEADS) {
            const seed = seedFromString(`${baseSeed}|v${v}|${c}|${o}|${leadA}|${leadB}`);
            list.push({ v, c, o, leadA, leadB, seed });
          }
        }
      }
    }
  }
  return list;
}

/**
 * Classify one battle's lead-exchange outcome from battleTeams' summary
 * (T27's leadFaintTurnA/leadFaintTurnB fields).
 * @returns {'a'|'b'|'simultaneous'|'none'} which side's lead fainted FIRST
 *   ('a'/'b' = that side LOST the lead exchange -- the other side won it);
 *   'simultaneous' if both leads fainted on the same turn (no clear winner);
 *   'none' if neither lead ever fainted (battle resolved without a lead
 *   exchange -- e.g. decided by bench mons, or ended by timeout).
 */
function leadExchangeLoser(summary) {
  const { leadFaintTurnA: ta, leadFaintTurnB: tb } = summary;
  if (ta === null && tb === null) return 'none';
  if (ta === null) return 'b';
  if (tb === null) return 'a';
  if (ta === tb) return 'simultaneous';
  return ta < tb ? 'a' : 'b';
}

function emptyBucket() {
  return { battles: 0, wins: 0 };
}
function record(bucket, won) {
  bucket.battles += 1;
  if (won) bucket.wins += 1;
}
function rate(bucket) {
  return bucket.battles > 0 ? bucket.wins / bucket.battles : null;
}

/**
 * @param {object} ctx - from initEngine().
 * @param {{ candidates?:number, opponents?:number, seeds?:number, seed?:string|number, difficulty?:number }} [opts]
 * @returns {Promise<object>} a summary report (see inline shape below); also printed as text/JSON by main().
 */
export async function runAlignmentStudy(ctx, opts = {}) {
  const candidateCount = opts.candidates ?? 5;
  const opponentCount = opts.opponents ?? 8;
  const seedVariantCount = opts.seeds ?? 2;
  const baseSeed = opts.seed ?? 'alignment-study';
  const difficulty = opts.difficulty;

  initTeamBattle(ctx);

  const pool = loadMetaTeams(ctx);
  const needed = candidateCount + opponentCount;
  if (pool.length < needed) {
    throw new Error(
      `runAlignmentStudy: curated meta pool only has ${pool.length} teams, need ${needed} (candidates + opponents)`
    );
  }
  const candidateTeams = pool.slice(0, candidateCount).map((t) => t.members.map((m) => m.pokemon));
  const opponentTeams = pool.slice(candidateCount, needed).map((t) => t.members.map((m) => m.pokemon));

  const battleList = buildBattleList(candidateCount, opponentCount, seedVariantCount, baseSeed);

  // Lead-exchange conditional win rates, pooled over BOTH sides' perspective:
  // a decided battle contributes one "exchange winner" data point and one
  // "exchange loser" data point. Side A/B is an arbitrary labeling (which
  // pool a team happened to be sliced into here), not a real asymmetry
  // pvpoke's AI treats specially, so pooling both sides is the honest read.
  const wonExchange = emptyBucket();
  const lostExchange = emptyBucket();
  let simultaneousCount = 0;
  let noExchangeCount = 0;
  let tieCount = 0;

  // Shield banking: for each non-tie battle, both sides contribute a data
  // point of (shields remaining at battle end, did that side win).
  const shieldBuckets = [emptyBucket(), emptyBucket(), emptyBucket()];

  let battlesRun = 0;
  for (const spec of battleList) {
    const r = battleTeams(ctx, {
      teamA: candidateTeams[spec.c],
      teamB: opponentTeams[spec.o],
      leadA: spec.leadA,
      leadB: spec.leadB,
      difficulty,
      seed: spec.seed,
    });
    battlesRun += 1;
    const { summary } = r;

    if (r.winner === 'tie') {
      tieCount += 1;
      continue;
    }

    const loser = leadExchangeLoser(summary);
    if (loser === 'none') noExchangeCount += 1;
    else if (loser === 'simultaneous') simultaneousCount += 1;
    else {
      const exchangeWinnerSide = loser === 'a' ? 'b' : 'a';
      record(wonExchange, r.winner === exchangeWinnerSide);
      record(lostExchange, r.winner !== exchangeWinnerSide);
    }

    record(shieldBuckets[summary.shieldsRemainingA], r.winner === 'a');
    record(shieldBuckets[summary.shieldsRemainingB], r.winner === 'b');
  }

  return {
    candidateCount,
    opponentCount,
    seedVariantCount,
    battlesPerSeedVariant: candidateCount * opponentCount * 9,
    totalBattles: battlesRun,
    tieCount,
    leadExchange: {
      decided: wonExchange.battles,
      simultaneousCount,
      noExchangeCount,
      pWinGivenWonExchange: rate(wonExchange),
      pWinGivenLostExchange: rate(lostExchange),
    },
    shields: {
      byRemaining: shieldBuckets.map((b, remaining) => ({
        remaining,
        battles: b.battles,
        winRate: rate(b),
      })),
    },
  };
}

function printReport(report) {
  console.log(
    `alignment-study: ${report.candidateCount} candidates x ${report.opponentCount} opponents x 9 pairings x ` +
      `${report.seedVariantCount} seed variants = ${report.totalBattles} battles`
  );
  const le = report.leadExchange;
  console.log(
    `  lead exchange: ${le.decided} decided, ${le.simultaneousCount} simultaneous, ` +
      `${le.noExchangeCount} no-faint, ${report.tieCount} game ties`
  );
  console.log(
    `  P(win | won lead exchange)  = ${le.pWinGivenWonExchange === null ? 'n/a' : le.pWinGivenWonExchange.toFixed(3)}`
  );
  console.log(
    `  P(win | lost lead exchange) = ${le.pWinGivenLostExchange === null ? 'n/a' : le.pWinGivenLostExchange.toFixed(3)}`
  );
  console.log('  shields remaining at battle end vs win rate:');
  for (const b of report.shields.byRemaining) {
    console.log(
      `    ${b.remaining} shields: ${b.battles} sides, win rate ${b.winRate === null ? 'n/a' : b.winRate.toFixed(3)}`
    );
  }
}

async function main(argv) {
  const opts = parseArgs(argv);
  const ctx = await initEngine();
  const report = await runAlignmentStudy(ctx, opts);
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
