// Tests for scripts/bench.mjs (GOALS T14: profile + benchmark harness).
// Two things are pinned down here: (1) the bench harness itself runs a tiny
// N deterministically and returns a well-formed timing/turns report, and (2)
// battleTeams results are bit-identical across repeat calls with the same
// inputs -- the invariant T14's "single-thread wins" (if any) are required
// to preserve, and T15's parallel executor will need to preserve too.
//
// Run with: node --test test/bench.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBench } from '../scripts/bench.mjs';
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
