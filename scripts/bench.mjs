#!/usr/bin/env node
// JavaScript Document
//
// GOALS T14: benchmark harness for battleTeams throughput. Times N repeated,
// fully deterministic battles between two fixed, competitively-matched teams
// (built ONCE and reused -- battleTeams.fullReset()s them per call, same as
// evaluateTeams/tournament.mjs's own build-once-battle-many usage pattern) and
// reports ms/battle plus a coarse phase breakdown (one-time engine setup vs
// per-battle time). No battle math is touched or reimplemented -- this file
// only calls the existing public battleTeams/buildPokemon/initEngine API and
// measures wall-clock time around those calls.
//
// For a fine-grained breakdown of where time goes INSIDE battleTeams (our
// wrapper code vs vendor/pvpoke's own Battle/TrainingAI code), run this
// script under Node's built-in V8 profiler and inspect the report, e.g.:
//   node --prof scripts/bench.mjs --n 300
//   node --prof-process isolate-*.log > out/bench-profile.txt
//   rm isolate-*.log
// (ticks attributed to files under src/engine/ are OUR overhead; ticks under
// vendor/pvpoke/src/js/ are the engine itself -- see PROGRESS.md for the T14
// findings from one such run.)
//
// Usage: node scripts/bench.mjs [--n 200] [--difficulty 3] [--json]

import { initEngine, buildPokemon } from '../src/engine/harness.js';
import { battleTeams, initTeamBattle } from '../src/engine/teamBattle.js';

const IVS = { atk: 0, def: 15, hp: 15 };
// Two competitively-matched Great League staple trios (not a blowout like
// the STRONG_IDS/WEAK_IDS pair in test/teamBattle.test.js) so turn counts and
// per-battle cost are representative of real evaluator/tournament runs,
// which pit strong candidate teams against strong meta teams.
const TEAM_A_IDS = ['azumarill', 'registeel', 'altaria'];
const TEAM_B_IDS = ['stunfisk_galarian', 'mandibuzz', 'clodsire'];
const LEADS = [0, 1, 2];

function parseArgs(argv) {
  const opts = { n: 200, difficulty: 3, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--n') opts.n = Number(argv[++i]);
    else if (a === '--difficulty') opts.difficulty = Number(argv[++i]);
    else if (a === '--json') opts.json = true;
  }
  return opts;
}

function team(ctx, ids) {
  return ids.map((speciesId) => buildPokemon(ctx, { speciesId, ivs: IVS }));
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

/**
 * Run the benchmark: build engine + teams once, then battle N times with
 * deterministic seeds (index-derived) cycling all 9 lead pairings.
 *
 * @param {{ n?: number, difficulty?: number }} [opts]
 * @returns {Promise<{
 *   setupMs: number, buildMs: number, battleMs: number, n: number,
 *   msPerBattle: number, turns: number[]
 * }>}
 */
export async function runBench(opts = {}) {
  const { n = 200, difficulty = 3 } = opts;

  const t0 = nowMs();
  const ctx = await initEngine();
  initTeamBattle(ctx);
  const t1 = nowMs();

  const teamA = team(ctx, TEAM_A_IDS);
  const teamB = team(ctx, TEAM_B_IDS);
  const t2 = nowMs();

  const turns = [];
  const t3 = nowMs();
  for (let i = 0; i < n; i++) {
    const leadA = LEADS[i % 3];
    const leadB = LEADS[Math.floor(i / 3) % 3];
    const r = battleTeams(ctx, { teamA, teamB, leadA, leadB, difficulty, seed: 1000 + i });
    turns.push(r.summary.turns);
  }
  const t4 = nowMs();

  return {
    setupMs: t1 - t0,
    buildMs: t2 - t1,
    battleMs: t4 - t3,
    n,
    msPerBattle: (t4 - t3) / n,
    turns,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = await runBench(opts);
  const avgTurns = result.turns.reduce((s, t) => s + t, 0) / result.turns.length;

  if (opts.json) {
    console.log(JSON.stringify(result));
    return;
  }

  console.log(`bench: ${result.n} battles, difficulty=${opts.difficulty}`);
  console.log(`  one-time engine setup: ${result.setupMs.toFixed(1)}ms`);
  console.log(`  one-time team build:   ${result.buildMs.toFixed(1)}ms`);
  console.log(`  battle loop total:     ${result.battleMs.toFixed(1)}ms`);
  console.log(`  ms/battle:             ${result.msPerBattle.toFixed(2)}ms`);
  console.log(`  avg turns/battle:      ${avgTurns.toFixed(1)}`);
}

// Only auto-run when executed directly (not when imported by bench.test.js).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
