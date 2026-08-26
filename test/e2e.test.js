// THE simulation test. This is the only file in the suite that runs real
// pvpoke battles; every other test file works on hand-built fixtures, fake
// matrices, or pure functions. If you are adding a test that needs the engine
// to actually fight, it belongs here, asserted against one of the shared runs
// below rather than a run of its own.
//
// The consolidation is the point. The suite used to spin up the engine from
// eleven files -- fourteen full evolution runs, twelve pipeline runs, hundreds
// of loose battles -- almost all of it re-simulating to check plumbing that a
// single run already proves. Here the expensive work happens once, at module
// scope, and the tests are assertions against those results.
//
// Parallelism comes from two places: the four pipeline runs are launched
// concurrently, and each is handed `threads`, which runPipeline forwards to
// evaluateTeams' worker-pool executor -- so the battles inside a run spread
// across cores instead of queueing on one.
//
// @slow -- the suite's only real-battle file; runs before a push.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPipeline } from '../src/cli.js';
import { renderReport } from '../src/report/index.js';
import { initEngine, buildPokemon } from '../src/engine/harness.js';
import { battleTeams, initTeamBattle } from '../src/engine/teamBattle.js';
import { runBattles } from '../src/engine/parallel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-pokegenie.csv');

// Rank-1 IVs; stable Great League staples against three joke Pokemon that
// cannot legally break 1500 CP at meaningful power.
const IVS = { atk: 0, def: 15, hp: 15 };
const STRONG_IDS = ['azumarill', 'registeel', 'altaria'];
const WEAK_IDS = ['magikarp', 'sunkern', 'feebas'];

// Small enough to finish quickly, large enough to form >= 1 team.
const SAMPLED_TINY = { candidates: 4, opponents: 2, pool: 6, scoreMeta: 4, top: 3, seed: 'e2e-test-seed' };
const EXHAUSTIVE_TINY = { exhaustive: true, topK: 4, meta: 2, scoreMeta: 4, top: 3 };
const ULTRA_TINY = { candidates: 3, opponents: 1, pool: 5, scoreMeta: 3, top: 2, seed: 'e2e-ultra-seed', cp: 2500 };

// ---------------------------------------------------------------- shared runs

// Concurrent on purpose: each runPipeline builds its own engine context, so
// they share no state, and `threads` puts the battles inside each one onto the
// worker pool. `sampledRepeat` is the same config and seed as `sampled` --
// the determinism check compares the two.
const [sampled, sampledRepeat, ultra, exhaustive] = await Promise.all([
  runPipeline(FIXTURE, { ...SAMPLED_TINY, threads: 2 }),
  runPipeline(FIXTURE, { ...SAMPLED_TINY, threads: 2 }),
  runPipeline(FIXTURE, ULTRA_TINY),
  runPipeline(FIXTURE, EXHAUSTIVE_TINY),
]);

let ctx;
before(async () => {
  ctx = await initEngine();
  initTeamBattle(ctx);
});

/** Fresh Pokemon instances for a team -- never share instances between battles. */
function team(ids) {
  return ids.map((speciesId) => buildPokemon(ctx, { speciesId, ivs: IVS }));
}

/** Write a report to a scratch dir the way the CLI does, and read it back. */
function writeAndRead(report, prefix) {
  const outPath = path.join(mkdtempSync(path.join(tmpdir(), prefix)), 'report.md');
  writeFileSync(outPath, renderReport(report), 'utf8');
  assert.ok(existsSync(outPath), 'report.md was written');
  return readFileSync(outPath, 'utf8');
}

// ------------------------------------------------------------- the pipeline

describe('pipeline: fixture CSV -> runPipeline -> report.md on disk', () => {
  test('the sampled (default) path produces a well-formed report', () => {
    assert.ok(sampled.monCount >= 3, 'scored several mons from the fixture');
    assert.ok(sampled.rankedTeams.length >= 1, 'ranked at least one team');
    assert.ok(sampled.rankedTeams.length <= SAMPLED_TINY.top, 'teamCount cap honored');
    assert.equal(sampled.metaTeams.length, SAMPLED_TINY.opponents, 'opponent team count honored');
    assert.equal(sampled.settings.mode, 'sampled', 'default path runs in sampled mode');

    const top = sampled.rankedTeams[0];
    assert.equal(top.members.length, 3, 'a recommended team has 3 members');
    assert.equal(new Set(top.members.map((m) => m.speciesId)).size, 3, 'no duplicate species within a team');
    assert.ok(top.winRate >= 0 && top.winRate <= 1, 'win rate is a fraction');
  });

  test('teams come back ranked, best first', () => {
    for (let i = 1; i < sampled.rankedTeams.length; i++) {
      assert.ok(
        sampled.rankedTeams[i - 1].winRate >= sampled.rankedTeams[i].winRate,
        `team ${i - 1} should not rank below team ${i}`
      );
    }
  });

  test('a malformed fixture row is surfaced, not silently dropped', () => {
    assert.ok(
      sampled.warnings.some((w) => /freakemon/i.test(w)),
      'unknown-species row surfaced as a collection warning'
    );
  });

  test('the report names its sections and its top team', () => {
    const onDisk = writeAndRead(sampled, 'gbl-e2e-');
    assert.match(onDisk, /# Great League Team Report/);
    assert.match(onDisk, /## Recommended teams/);
    assert.match(onDisk, /## Appendix: per-Pokemon 1v1 scores/);
    assert.match(onDisk, /mode=sampled/);
    assert.ok(
      onDisk.includes(sampled.rankedTeams[0].members[0].name),
      'report names the top recommended team'
    );
  });

  test('a shadow member renders with the (Shadow) qualifier', () => {
    const onDisk = writeAndRead(sampled, 'gbl-e2e-shadow-');
    const shadows = sampled.rankedTeams.flatMap((t) => t.members).filter((m) => m.shadow);
    // The fixture may or may not land a shadow on a recommended team; assert
    // the rendering rule only when one is actually there.
    for (const m of shadows) {
      assert.match(m.name, /\(Shadow\)/, 'a shadow member carries the qualifier in its name');
      assert.ok(onDisk.includes(m.name), 'the qualified name reaches the report');
    }
  });

  test('--cp 2500 runs Ultra League end to end and labels the report', () => {
    assert.ok(ultra.rankedTeams.length >= 1, 'ranked at least one team');
    assert.equal(ultra.settings.cp, 2500, 'cp carried into settings');

    const onDisk = writeAndRead(ultra, 'gbl-e2e-ultra-');
    assert.match(onDisk, /# Ultra League Team Report/);
    assert.match(onDisk, /cp=2500/);
    assert.ok(onDisk.includes(ultra.rankedTeams[0].members[0].name), 'report names the top team');
  });

  test('--exhaustive runs the older combinatorial path', () => {
    assert.ok(exhaustive.rankedTeams.length >= 1, 'ranked at least one team');
    assert.equal(exhaustive.metaTeams.length, EXHAUSTIVE_TINY.meta, 'meta team count honored');
    assert.equal(exhaustive.settings.mode, 'exhaustive', '--exhaustive runs in exhaustive mode');

    const markdown = renderReport(exhaustive);
    assert.match(markdown, /# Great League Team Report/);
    assert.doesNotMatch(markdown, /mode=sampled/, 'exhaustive report does not claim sampled mode');
  });

  test('same seed and settings reproduce the same ranking', () => {
    assert.deepEqual(
      sampledRepeat.rankedTeams.map((t) => [t.members.map((m) => m.key), t.winRate]),
      sampled.rankedTeams.map((t) => [t.members.map((m) => m.key), t.winRate]),
      'a repeat run at the same seed ranks identically'
    );
  });
});

// ------------------------------------------------------------ battle engine

describe('battleTeams: the 3v3 driver', () => {
  test('returns a well-formed result object', () => {
    const r = battleTeams(ctx, { teamA: team(STRONG_IDS), teamB: team(WEAK_IDS) });
    assert.ok(['a', 'b', 'tie'].includes(r.winner), 'winner is a|b|tie');
    assert.equal(typeof r.survivorsHp.a, 'number');
    assert.equal(typeof r.survivorsHp.b, 'number');
    assert.equal(r.survivorsHp.aPerMon.length, 3);
    assert.equal(r.survivorsHp.bPerMon.length, 3);
    assert.ok(r.summary.remainingA >= 0 && r.summary.remainingA <= 3);
    assert.ok(r.summary.remainingB >= 0 && r.summary.remainingB <= 3);
    assert.ok(r.summary.turns > 0, 'battle ran at least one turn');
    assert.ok(['ko', 'timeout'].includes(r.summary.endedBy));
    assert.equal(r.summary.difficulty, 3, 'defaults to highest difficulty');
  });

  test('rejects empty teams and out-of-range leads', () => {
    assert.throws(() => battleTeams(ctx, { teamA: [], teamB: team(WEAK_IDS) }));
    assert.throws(() => battleTeams(ctx, { teamA: team(STRONG_IDS), teamB: team(WEAK_IDS), leadA: 5 }));
  });

  test('leadA/leadB choose the starting Pokemon', () => {
    const r = battleTeams(ctx, { teamA: team(STRONG_IDS), teamB: team(WEAK_IDS), leadA: 1, leadB: 2 });
    assert.equal(r.summary.leadA, 1);
    assert.equal(r.summary.leadB, 2);
  });

  test('3 top-meta mons win all 9 lead pairings vs 3 joke mons', () => {
    const losses = [];
    let wins = 0;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const r = battleTeams(ctx, { teamA: team(STRONG_IDS), teamB: team(WEAK_IDS), leadA: i, leadB: j });
        if (r.winner === 'a') wins++;
        else losses.push(`${i},${j}=>${r.winner}`);
      }
    }
    assert.equal(wins, 9, `strong team should win all 9 pairings; lost: ${losses.join(' ')}`);
  });

  // Tolerance: pvpoke's emulate engine is built for human(0) vs AI(1) and has a
  // couple of player-1-only strategic hooks; teamBattle mirrors them onto
  // player 0, but a tiny residual asymmetry (plus HP-margin tiebreaks on
  // timed-out battles) means the split is ~50/50 rather than exactly 50/50.
  test('identical teams split the 9 lead pairings near evenly', () => {
    let a = 0;
    let b = 0;
    let ties = 0;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const r = battleTeams(ctx, { teamA: team(STRONG_IDS), teamB: team(STRONG_IDS), leadA: i, leadB: j });
        if (r.winner === 'a') a++;
        else if (r.winner === 'b') b++;
        else ties++;
      }
    }
    assert.equal(a + b + ties, 9);
    assert.ok(a <= 6 && b <= 6, `neither side should dominate a mirror (a=${a}, b=${b})`);
    assert.ok(a >= 2 && b >= 2, `both sides should win some pairings (a=${a}, b=${b})`);
  });

  test('same inputs give the same result, and an explicit seed is honored', () => {
    const opts = { leadA: 1, leadB: 2 };
    const r1 = battleTeams(ctx, { teamA: team(STRONG_IDS), teamB: team(STRONG_IDS), ...opts });
    const r2 = battleTeams(ctx, { teamA: team(STRONG_IDS), teamB: team(STRONG_IDS), ...opts });
    assert.equal(r1.winner, r2.winner);
    assert.deepEqual(r1.survivorsHp, r2.survivorsHp);
    assert.equal(r1.summary.turns, r2.summary.turns);
    assert.equal(r1.summary.seed, r2.summary.seed);

    const seeded = { teamA: team(STRONG_IDS), teamB: team(STRONG_IDS), leadA: 0, leadB: 1, seed: 42 };
    const sA = battleTeams(ctx, seeded);
    const sB = battleTeams(ctx, { ...seeded, teamA: team(STRONG_IDS), teamB: team(STRONG_IDS) });
    assert.equal(sA.winner, sB.winner);
    assert.deepEqual(sA.survivorsHp, sB.survivorsHp);
    assert.equal(sA.summary.seed, 42);
  });
});

// -------------------------------------------------------- the worker pool

// The invariant the whole parallel executor exists to preserve: threading the
// battles must not change a single result. A mixed plan -- strong-vs-weak at
// several leads, plus mirror matches, which are what exercise the worker's
// cacheA/cacheB split (teamA and teamB must be distinct instances even when
// the species are identical).
describe('runBattles is bit-identical to a serial battleTeams loop', () => {
  const PLAN = [
    { teamAIds: STRONG_IDS, teamBIds: WEAK_IDS, leadA: 0, leadB: 0 },
    { teamAIds: STRONG_IDS, teamBIds: WEAK_IDS, leadA: 2, leadB: 1, seed: 42 },
    { teamAIds: STRONG_IDS, teamBIds: STRONG_IDS, leadA: 1, leadB: 0, seed: 7 },
    { teamAIds: WEAK_IDS, teamBIds: WEAK_IDS, leadA: 2, leadB: 2 },
  ];

  test('identical winner/survivorsHp/summary for every spec, in spec order', async () => {
    const serial = PLAN.map((p) =>
      battleTeams(ctx, {
        teamA: team(p.teamAIds),
        teamB: team(p.teamBIds),
        leadA: p.leadA,
        leadB: p.leadB,
        seed: p.seed,
      })
    );
    const threaded = await runBattles(
      PLAN.map((p) => ({
        teamA: p.teamAIds.map((speciesId) => ({ speciesId, ivs: IVS })),
        teamB: p.teamBIds.map((speciesId) => ({ speciesId, ivs: IVS })),
        leadA: p.leadA,
        leadB: p.leadB,
        seed: p.seed,
      })),
      { threads: 2 }
    );

    assert.equal(threaded.length, serial.length);
    threaded.forEach((r, i) => {
      assert.deepEqual(r, serial[i], `battle ${i} (leadA=${PLAN[i].leadA}, leadB=${PLAN[i].leadB}) mismatched`);
    });
  });

  test('empty specs resolve to [] without spawning a worker', async () => {
    assert.deepEqual(await runBattles([], { threads: 2 }), []);
  });
});
