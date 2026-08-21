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
// Usage: node scripts/bench.mjs [--n 200] [--difficulty 3] [--threads N]
//          [--batches B] [--json]
//
// GOALS T15: --threads N runs the same N deterministic battles through
// src/engine/parallel.js's runBattles() instead of a serial loop, so the two
// modes are directly comparable (same teams, same lead cycling, same seeds).
//
// GOALS T22: --threads N --batches B (B > 1) instead drives the same N
// battles, split into B roughly-equal batches, through ONE persistent
// createExecutor() pool via repeated run() calls -- the "amortized across
// many run() calls" scenario src/engine/README.md's Performance section
// flagged as unmeasured (bench.mjs previously only ever made one runBattles()
// call per process, so every measurement paid pool-boot cost exactly once
// per invocation regardless of N; this mode shows what real multi-call
// callers like scripts/tournament.mjs (T21) and a future evolve driver (T24)
// actually experience: boot cost paid ONCE, then amortized across every
// subsequent batch). --batches is ignored (and --threads alone reproduces
// the pre-T22 one-shot runBattles() behavior byte-for-byte) unless > 1.

import { initEngine, buildPokemon } from '../src/engine/harness.js';
import { battleTeams, initTeamBattle } from '../src/engine/teamBattle.js';
import { runBattles, createExecutor, defaultThreadCount } from '../src/engine/parallel.js';

const IVS = { atk: 0, def: 15, hp: 15 };
// Two competitively-matched Great League staple trios (not a blowout like
// the STRONG_IDS/WEAK_IDS pair in test/teamBattle.test.js) so turn counts and
// per-battle cost are representative of real evaluator/tournament runs,
// which pit strong candidate teams against strong meta teams.
const TEAM_A_IDS = ['azumarill', 'registeel', 'altaria'];
const TEAM_B_IDS = ['stunfisk_galarian', 'mandibuzz', 'clodsire'];
const LEADS = [0, 1, 2];

function parseArgs(argv) {
  const opts = { n: 200, difficulty: 3, json: false, threads: undefined, batches: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--n') opts.n = Number(argv[++i]);
    else if (a === '--difficulty') opts.difficulty = Number(argv[++i]);
    else if (a === '--threads') opts.threads = Number(argv[++i]);
    else if (a === '--batches') opts.batches = Number(argv[++i]);
    else if (a === '--json') opts.json = true;
  }
  return opts;
}

function team(ctx, ids) {
  return ids.map((speciesId) => buildPokemon(ctx, { speciesId, ivs: IVS }));
}

function monSpecs(ids) {
  return ids.map((speciesId) => ({ speciesId, ivs: IVS }));
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

/**
 * Same N deterministic battles as runBench, but driven through runBattles()
 * across `threads` worker threads instead of a serial loop -- each worker
 * boots its own engine context (that one-time cost is NOT split out here the
 * way runBench splits setup/build/battle, since it happens inside the
 * workers; battleMs is the whole runBattles() wall-clock instead).
 *
 * @param {{ n?: number, difficulty?: number, threads?: number }} [opts]
 * @returns {Promise<{ threads: number, battleMs: number, n: number, msPerBattle: number, turns: number[] }>}
 */
export async function runBenchThreaded(opts = {}) {
  const { n = 200, difficulty = 3, threads } = opts;

  const specs = [];
  for (let i = 0; i < n; i++) {
    specs.push({
      teamA: monSpecs(TEAM_A_IDS),
      teamB: monSpecs(TEAM_B_IDS),
      leadA: LEADS[i % 3],
      leadB: LEADS[Math.floor(i / 3) % 3],
      difficulty,
      seed: 1000 + i,
    });
  }

  const t0 = nowMs();
  const results = await runBattles(specs, { threads });
  const t1 = nowMs();

  return {
    threads: threads ?? defaultThreadCount(),
    battleMs: t1 - t0,
    n,
    msPerBattle: (t1 - t0) / n,
    turns: results.map((r) => r.summary.turns),
  };
}

/**
 * Same N deterministic battles as runBench/runBenchThreaded, but split into
 * `batches` roughly-equal groups and run through repeated `run()` calls
 * against ONE persistent `createExecutor()` pool (GOALS T22), instead of one
 * `runBattles()` call that boots and tears down a pool per invocation. This
 * is what lets a caller SEE the pool-reuse amortization `createExecutor`
 * (GOALS T19/T21) was built for: the first batch pays lazy pool-boot cost,
 * every batch after it does not. Per-batch timings are returned so a caller
 * can compare batch 0 (boot included) against later batches (amortized).
 *
 * @param {{ n?: number, difficulty?: number, threads?: number, batches?: number }} [opts]
 * @returns {Promise<{
 *   threads: number, batches: number, n: number,
 *   batchResults: Array<{batch:number, n:number, battleMs:number, msPerBattle:number, turns:number[]}>,
 *   totalMs: number, msPerBattle: number, turns: number[]
 * }>}
 */
export async function runBenchPersistent(opts = {}) {
  const { n = 200, difficulty = 3, threads, batches = 4 } = opts;
  const batchCount = Math.max(1, Math.floor(batches));
  const perBatch = Math.ceil(n / batchCount);

  const executor = createExecutor({ threads });
  const batchResults = [];
  try {
    let start = 0;
    for (let b = 0; b < batchCount && start < n; b++) {
      const size = Math.min(perBatch, n - start);
      const specs = [];
      for (let i = 0; i < size; i++) {
        const idx = start + i;
        specs.push({
          teamA: monSpecs(TEAM_A_IDS),
          teamB: monSpecs(TEAM_B_IDS),
          leadA: LEADS[idx % 3],
          leadB: LEADS[Math.floor(idx / 3) % 3],
          difficulty,
          seed: 1000 + idx,
        });
      }

      const t0 = nowMs();
      const results = await executor.run(specs);
      const t1 = nowMs();

      batchResults.push({
        batch: b,
        n: size,
        battleMs: t1 - t0,
        msPerBattle: (t1 - t0) / size,
        turns: results.map((r) => r.summary.turns),
      });
      start += size;
    }
  } finally {
    await executor.close();
  }

  const totalMs = batchResults.reduce((s, r) => s + r.battleMs, 0);
  return {
    threads: threads ?? defaultThreadCount(),
    batches: batchResults.length,
    n,
    batchResults,
    totalMs,
    msPerBattle: totalMs / n,
    turns: batchResults.flatMap((r) => r.turns),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.threads !== undefined && opts.batches !== undefined && opts.batches > 1) {
    const result = await runBenchPersistent(opts);
    if (opts.json) {
      console.log(JSON.stringify(result));
      return;
    }
    console.log(
      `bench (persistent pool): ${result.n} battles, difficulty=${opts.difficulty}, ` +
        `threads=${result.threads}, batches=${result.batches}`
    );
    for (const b of result.batchResults) {
      const tag = b.batch === 0 ? '(boot + battles)' : '(amortized, no boot)';
      console.log(
        `  batch ${b.batch}: ${b.n} battles, ${b.battleMs.toFixed(1)}ms total, ` +
          `${b.msPerBattle.toFixed(2)}ms/battle ${tag}`
      );
    }
    console.log(`  overall ms/battle:     ${result.msPerBattle.toFixed(2)}ms`);
    return;
  }

  if (opts.threads !== undefined) {
    const result = await runBenchThreaded(opts);
    const avgTurns = result.turns.reduce((s, t) => s + t, 0) / result.turns.length;
    if (opts.json) {
      console.log(JSON.stringify(result));
      return;
    }
    console.log(`bench (threaded): ${result.n} battles, difficulty=${opts.difficulty}, threads=${result.threads}`);
    console.log(`  wall-clock total:      ${result.battleMs.toFixed(1)}ms`);
    console.log(`  ms/battle (wall):      ${result.msPerBattle.toFixed(2)}ms`);
    console.log(`  avg turns/battle:      ${avgTurns.toFixed(1)}`);
    return;
  }

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
