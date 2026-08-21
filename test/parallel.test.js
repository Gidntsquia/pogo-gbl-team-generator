// JavaScript Document
//
// Verifies src/engine/parallel.js -- the worker_threads battle executor
// (GOALS T15). No battle math is exercised directly here: the whole point of
// this suite is that runBattles() produces results IDENTICAL to a plain
// serial loop of battleTeams() calls, in spec order, regardless of thread
// count, and that a broken worker surfaces as a rejected promise rather than
// a hang.
//
// Run with: node --test test/parallel.test.js

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { initEngine, buildPokemon } from '../src/engine/harness.js';
import { battleTeams } from '../src/engine/teamBattle.js';
import {
  runBattles,
  createExecutor,
  defaultThreadCount,
  resolveThreadCount,
  THREADS_ENV_VAR,
} from '../src/engine/parallel.js';

const IVS = { atk: 0, def: 15, hp: 15 };
const STRONG_IDS = ['azumarill', 'registeel', 'altaria'];
const WEAK_IDS = ['magikarp', 'sunkern', 'feebas'];

/** Plain-data MonSpec array (what runBattles' specs carry) for a team of species ids. */
function monSpecs(ids) {
  return ids.map((speciesId) => ({ speciesId, ivs: IVS }));
}

/** Built Pokemon instances (what a serial battleTeams() call needs) for the same ids. */
function buildTeam(ctx, ids) {
  return ids.map((speciesId) => buildPokemon(ctx, { speciesId, ivs: IVS }));
}

// A small mixed plan: strong-vs-weak (several leads, one explicit seed), plus
// two mirror matches (same species on both sides, at different seeds) -- the
// mirror cases are what exercise parallelWorker.js's cacheA/cacheB split
// (teamA and teamB must be distinct Pokemon instances even when identical).
const BATTLE_PLAN = [
  { teamAIds: STRONG_IDS, teamBIds: WEAK_IDS, leadA: 0, leadB: 0 },
  { teamAIds: STRONG_IDS, teamBIds: WEAK_IDS, leadA: 1, leadB: 2 },
  { teamAIds: STRONG_IDS, teamBIds: WEAK_IDS, leadA: 2, leadB: 1, seed: 42 },
  { teamAIds: STRONG_IDS, teamBIds: STRONG_IDS, leadA: 0, leadB: 1 },
  { teamAIds: STRONG_IDS, teamBIds: STRONG_IDS, leadA: 1, leadB: 0, seed: 7 },
  { teamAIds: WEAK_IDS, teamBIds: WEAK_IDS, leadA: 2, leadB: 2 },
];

function toSpecs(plan = BATTLE_PLAN) {
  return plan.map((p) => ({
    teamA: monSpecs(p.teamAIds),
    teamB: monSpecs(p.teamBIds),
    leadA: p.leadA,
    leadB: p.leadB,
    seed: p.seed,
  }));
}

/** Serial battleTeams() results for a plan, for comparison against a pooled/threaded run. */
function serialBattles(ctx, plan) {
  return plan.map((p) =>
    battleTeams(ctx, {
      teamA: buildTeam(ctx, p.teamAIds),
      teamB: buildTeam(ctx, p.teamBIds),
      leadA: p.leadA,
      leadB: p.leadB,
      seed: p.seed,
    })
  );
}

let ctx;
before(async () => {
  ctx = await initEngine();
});

describe('runBattles vs a serial battleTeams loop', () => {
  test('identical winner/survivorsHp/summary for every spec, in spec order', async () => {
    const serial = BATTLE_PLAN.map((p) =>
      battleTeams(ctx, {
        teamA: buildTeam(ctx, p.teamAIds),
        teamB: buildTeam(ctx, p.teamBIds),
        leadA: p.leadA,
        leadB: p.leadB,
        seed: p.seed,
      })
    );
    const parallel = await runBattles(toSpecs(), { threads: 2 });
    assert.equal(parallel.length, serial.length);
    parallel.forEach((r, i) => {
      assert.deepEqual(r, serial[i], `battle ${i} (leadA=${BATTLE_PLAN[i].leadA}, leadB=${BATTLE_PLAN[i].leadB}) mismatched`);
    });
  });
});

describe('thread-count edge cases', () => {
  test('threads=1 matches threads=2', async () => {
    const baseline = await runBattles(toSpecs(), { threads: 2 });
    const single = await runBattles(toSpecs(), { threads: 1 });
    assert.deepEqual(single, baseline);
  });

  test('threads=4 matches threads=2', async () => {
    const baseline = await runBattles(toSpecs(), { threads: 2 });
    const quad = await runBattles(toSpecs(), { threads: 4 });
    assert.deepEqual(quad, baseline);
  });

  test('threads is clamped to specs.length (no work-starved extra workers to hang on)', async () => {
    const specs = toSpecs().slice(0, 2);
    const result = await runBattles(specs, { threads: 16 });
    assert.equal(result.length, 2);
  });

  test('empty specs resolves to [] without spawning any worker', async () => {
    const result = await runBattles([]);
    assert.deepEqual(result, []);
  });
});

describe('failure handling', () => {
  test('a worker crash rejects the whole run instead of hanging', async () => {
    const specs = toSpecs();
    specs[1] = { ...specs[1], __crashWorker: true };
    await assert.rejects(() => runBattles(specs, { threads: 2 }));
  });

  test('an invalid spec rejects with a clear error instead of hanging', async () => {
    const specs = [
      {
        teamA: [{ speciesId: 'not-a-real-species-xyz', ivs: IVS }],
        teamB: monSpecs(WEAK_IDS),
        leadA: 0,
        leadB: 0,
      },
    ];
    await assert.rejects(() => runBattles(specs, { threads: 1 }), /not-a-real-species-xyz/);
  });
});

describe('thread-count resolution', () => {
  test('defaultThreadCount is max(1, cpus - 1)', () => {
    assert.equal(defaultThreadCount(), Math.max(1, os.cpus().length - 1));
  });

  test('resolveThreadCount prefers an explicit value over env and default', () => {
    assert.equal(resolveThreadCount(3, { [THREADS_ENV_VAR]: '7' }), 3);
  });

  test('resolveThreadCount falls back to the env var when no explicit value is given', () => {
    assert.equal(resolveThreadCount(undefined, { [THREADS_ENV_VAR]: '5' }), 5);
  });

  test('resolveThreadCount falls back to the default when neither is set', () => {
    assert.equal(resolveThreadCount(undefined, {}), defaultThreadCount());
  });

  test('a malformed env var degrades to the default instead of throwing', () => {
    assert.equal(resolveThreadCount(undefined, { [THREADS_ENV_VAR]: 'not-a-number' }), defaultThreadCount());
  });

  test('a non-positive explicit value falls through instead of being used', () => {
    assert.equal(resolveThreadCount(0, { [THREADS_ENV_VAR]: '5' }), 5);
    assert.equal(resolveThreadCount(-2, {}), defaultThreadCount());
  });
});

// --- GOALS T19: createExecutor -- persistent pool + per-spec fault isolation ---
//
// runBattles() above still gets its own dedicated coverage (it's now a thin
// create->run->close wrapper, and every test above already proves its
// observable behavior is unchanged). These describe blocks cover what's NEW:
// a pool that survives across many run() calls, continueOnError's per-slot
// fault isolation, and close()/crash lifecycle semantics.

describe('createExecutor: pool reused across many run() calls', () => {
  test('3 successive run() calls on one executor match a serial battleTeams loop every time', async () => {
    const executor = createExecutor({ threads: 2 });
    try {
      const expected = serialBattles(ctx, BATTLE_PLAN);
      for (let round = 0; round < 3; round++) {
        const result = await executor.run(toSpecs());
        assert.deepEqual(result, expected, `round ${round} mismatched`);
      }
    } finally {
      await executor.close();
    }
  });

  test('successive run() calls with DIFFERENT specs each get their own correct results', async () => {
    const executor = createExecutor({ threads: 2 });
    try {
      const planA = BATTLE_PLAN.slice(0, 3);
      const planB = BATTLE_PLAN.slice(3);
      const resultA = await executor.run(toSpecs(planA));
      const resultB = await executor.run(toSpecs(planB));
      assert.deepEqual(resultA, serialBattles(ctx, planA));
      assert.deepEqual(resultB, serialBattles(ctx, planB));
    } finally {
      await executor.close();
    }
  });

  test('concurrent (unawaited) run() calls are serialized safely -- each resolves with its own correct results, not mixed up', async () => {
    const executor = createExecutor({ threads: 2 });
    try {
      const planA = BATTLE_PLAN.slice(0, 3);
      const planB = BATTLE_PLAN.slice(3);
      const [resultA, resultB] = await Promise.all([executor.run(toSpecs(planA)), executor.run(toSpecs(planB))]);
      assert.deepEqual(resultA, serialBattles(ctx, planA));
      assert.deepEqual(resultB, serialBattles(ctx, planB));
    } finally {
      await executor.close();
    }
  });

  test('run([]) resolves to [] without booting a pool', async () => {
    const executor = createExecutor({ threads: 2 });
    try {
      assert.deepEqual(await executor.run([]), []);
    } finally {
      await executor.close();
    }
  });
});

describe('createExecutor: thread counts', () => {
  for (const threads of [1, 4]) {
    test(`threads=${threads} matches a serial battleTeams loop`, async () => {
      const executor = createExecutor({ threads });
      try {
        const result = await executor.run(toSpecs());
        assert.deepEqual(result, serialBattles(ctx, BATTLE_PLAN));
      } finally {
        await executor.close();
      }
    });
  }
});

describe('createExecutor: continueOnError per-spec fault isolation', () => {
  function planWithBadSpec() {
    const specs = toSpecs(BATTLE_PLAN.slice(0, 3));
    specs[1] = { ...specs[1], teamA: [{ speciesId: 'not-a-real-species-xyz', ivs: IVS }] };
    return specs;
  }

  test('continueOnError:true -- the bad spec errors only its own slot; the rest complete normally', async () => {
    const executor = createExecutor({ threads: 2, continueOnError: true });
    try {
      const expectedGood = serialBattles(ctx, [BATTLE_PLAN[0], BATTLE_PLAN[2]]);
      const result = await executor.run(planWithBadSpec());
      assert.equal(result.length, 3);
      assert.deepEqual(result[0], { ok: true, value: expectedGood[0] });
      assert.equal(result[1].ok, false);
      assert.match(result[1].error.message, /not-a-real-species-xyz/);
      assert.deepEqual(result[2], { ok: true, value: expectedGood[1] });
    } finally {
      await executor.close();
    }
  });

  test('continueOnError:false (default) -- the same bad spec rejects the WHOLE run(), as runBattles does today', async () => {
    const executor = createExecutor({ threads: 2 });
    try {
      await assert.rejects(() => executor.run(planWithBadSpec()), /not-a-real-species-xyz/);
    } finally {
      await executor.close();
    }
  });

  test('the pool survives a continueOnError-isolated bad spec: the next run() call reuses it with no re-boot needed', async () => {
    const executor = createExecutor({ threads: 2, continueOnError: true });
    try {
      await executor.run(planWithBadSpec());
      const result = await executor.run(toSpecs(BATTLE_PLAN.slice(0, 2)));
      const expected = serialBattles(ctx, BATTLE_PLAN.slice(0, 2)).map((value) => ({ ok: true, value }));
      assert.deepEqual(result, expected);
    } finally {
      await executor.close();
    }
  });

  test('a worker crash rejects the run even under continueOnError -- it is an infra fault, not a per-spec one', async () => {
    const executor = createExecutor({ threads: 2, continueOnError: true });
    try {
      const specs = toSpecs(BATTLE_PLAN.slice(0, 2));
      specs[0] = { ...specs[0], __crashWorker: true };
      await assert.rejects(() => executor.run(specs));
    } finally {
      await executor.close();
    }
  });
});

describe('createExecutor: lifecycle (close/crash)', () => {
  test('run() after close() rejects cleanly instead of touching a torn-down pool', async () => {
    const executor = createExecutor({ threads: 1 });
    await executor.run(toSpecs(BATTLE_PLAN.slice(0, 1))); // boot the pool first
    await executor.close();
    await assert.rejects(() => executor.run(toSpecs(BATTLE_PLAN.slice(0, 1))), /close/);
  });

  test('close() is safe with no prior run() at all, and safe to call twice', async () => {
    const executor = createExecutor({ threads: 1 });
    await executor.close();
    await executor.close();
  });

  test('after a worker crash, the NEXT run() call transparently boots a fresh pool and succeeds', async () => {
    const executor = createExecutor({ threads: 2 });
    try {
      const crashSpecs = toSpecs(BATTLE_PLAN.slice(0, 2));
      crashSpecs[0] = { ...crashSpecs[0], __crashWorker: true };
      await assert.rejects(() => executor.run(crashSpecs));

      const okSpecs = toSpecs(BATTLE_PLAN.slice(0, 2));
      const result = await executor.run(okSpecs);
      assert.deepEqual(result, serialBattles(ctx, BATTLE_PLAN.slice(0, 2)));
    } finally {
      await executor.close();
    }
  });
});

describe('runBattles (legacy wrapper): return shape unchanged by the T19 rewrite', () => {
  test('never returns {ok,...} SpecResult slots -- always raw battleTeams() shape, or a whole-batch rejection', async () => {
    const result = await runBattles(toSpecs(BATTLE_PLAN.slice(0, 1)), { threads: 1 });
    assert.equal(result.length, 1);
    assert.ok('winner' in result[0]);
    assert.ok(!('ok' in result[0]));
  });
});
