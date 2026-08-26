// Tests for scripts/bench.mjs (the profile + benchmark harness).
// Two things are pinned down here: (1) the bench harness itself runs a tiny
// N deterministically and returns a well-formed timing/turns report, and (2)
// battleTeams results are bit-identical across repeat calls with the same
// inputs -- the invariant profiling's "single-thread wins" (if any) are required
// to preserve, and the parallel executor will need to preserve too.
//
// Run with: node --test test/bench.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBench, runBenchThreaded, runBenchPersistent } from '../scripts/bench.mjs';
import { initEngine, buildPokemon } from '../src/engine/harness.js';
import { battleTeams, initTeamBattle } from '../src/engine/teamBattle.js';

test('runBench produces a well-formed report for a tiny N', async () => {
  const result = await runBench({ n: 6, difficulty: 3 });

  assert.equal(result.n, 6);
  assert.equal(result.turns.length, 6);
  for (const t of result.turns) {
    assert.ok(Number.isFinite(t) && t > 0, 'each battle ran a positive number of turns');
  }
  assert.ok(result.setupMs >= 0);
  assert.ok(result.buildMs >= 0);
  assert.ok(result.battleMs >= 0);
  assert.ok(Number.isFinite(result.msPerBattle) && result.msPerBattle > 0);
});

test('runBench turn counts are deterministic across repeat runs (same n, same seeds)', async () => {
  const a = await runBench({ n: 6, difficulty: 3 });
  const b = await runBench({ n: 6, difficulty: 3 });
  assert.deepEqual(a.turns, b.turns, 'identical seeded battles produce identical turn counts');
});

test('battleTeams itself is bit-identical for a fixed battle set (guards single-thread + future parallel wins)', async () => {
  const ctx = await initEngine();
  initTeamBattle(ctx);
  const IVS = { atk: 0, def: 15, hp: 15 };
  const buildTeams = () => ({
    teamA: ['azumarill', 'registeel', 'altaria'].map((speciesId) =>
      buildPokemon(ctx, { speciesId, ivs: IVS })
    ),
    teamB: ['stunfisk_galarian', 'mandibuzz', 'clodsire'].map((speciesId) =>
      buildPokemon(ctx, { speciesId, ivs: IVS })
    ),
  });

  const specs = [
    { leadA: 0, leadB: 0, seed: 42 },
    { leadA: 1, leadB: 2, seed: 43 },
    { leadA: 2, leadB: 1, seed: 44 },
  ];

  const run = () => {
    const { teamA, teamB } = buildTeams();
    return specs.map((s) => battleTeams(ctx, { teamA, teamB, ...s }));
  };

  const first = run();
  const second = run();
  assert.deepEqual(second, first, 'same teams/leads/seeds must reproduce identical results');
});

test('runBenchThreaded reproduces the same turn counts as the serial runBench, at threads=1 and threads=4', async () => {
  const serial = await runBench({ n: 6, difficulty: 3 });
  const single = await runBenchThreaded({ n: 6, difficulty: 3, threads: 1 });
  const quad = await runBenchThreaded({ n: 6, difficulty: 3, threads: 4 });
  assert.deepEqual(single.turns, serial.turns, 'threads=1 must match the serial loop exactly');
  assert.deepEqual(quad.turns, serial.turns, 'threads=4 must match the serial loop exactly');
});

test('runBenchPersistent produces a well-formed multi-batch report for a tiny N', async () => {
  const result = await runBenchPersistent({ n: 6, difficulty: 3, threads: 2, batches: 3 });

  assert.equal(result.n, 6);
  assert.equal(result.batches, 3);
  assert.equal(result.batchResults.length, 3);
  assert.equal(
    result.batchResults.reduce((s, b) => s + b.n, 0),
    6,
    'batch sizes sum to the requested n'
  );
  for (const b of result.batchResults) {
    assert.ok(b.battleMs >= 0);
    assert.ok(Number.isFinite(b.msPerBattle) && b.msPerBattle > 0);
    assert.equal(b.turns.length, b.n);
  }
  assert.equal(result.turns.length, 6);
  assert.ok(Number.isFinite(result.msPerBattle) && result.msPerBattle > 0);
});

test('runBenchPersistent reproduces the same turn counts as the serial runBench across batch splits', async () => {
  const serial = await runBench({ n: 8, difficulty: 3 });
  const oneBatch = await runBenchPersistent({ n: 8, difficulty: 3, threads: 3, batches: 1 });
  const threeBatches = await runBenchPersistent({ n: 8, difficulty: 3, threads: 3, batches: 3 });
  assert.deepEqual(oneBatch.turns, serial.turns, 'a single batch against the persistent pool must match serial');
  assert.deepEqual(
    threeBatches.turns,
    serial.turns,
    'splitting the same n across multiple run() calls on one pool must not change any battle result'
  );
});

test('runBenchPersistent closes its executor -- process can exit without lingering workers', async () => {
  // No explicit assertion beyond "this resolves" -- if close() were skipped,
  // a worker_threads handle would keep the test process alive past its
  // timeout instead of node:test moving on cleanly.
  await runBenchPersistent({ n: 4, difficulty: 3, threads: 2, batches: 2 });
  assert.ok(true);
});
