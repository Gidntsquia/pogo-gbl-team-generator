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
// Parallelism comes from two places: the shared runs at module scope are
// launched concurrently, and each is handed `threads`, which runEvolution
// forwards to its worker-pool executor -- so the battles inside a
// run spread across cores instead of queueing on one.
//
// There is exactly ONE evolve run in this file (`sampled`), and every test
// that needs a full simulation reads it. A second run for determinism or for
// another league was dropped on purpose: same config, same seed is already
// pinned at the battle level (serial vs threaded below, repeated battleTeams).
//
// @slow -- the suite's only real-battle file; runs before a push.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderEvolveReport } from '../src/evolve/reportMd.js';
import { runEvolution } from '../src/evolve/run.js';
import { initEngine, buildPokemon } from '../src/engine/harness.js';
import { battleTeams, initTeamBattle } from '../src/engine/teamBattle.js';
import { runBattles } from '../src/engine/parallel.js';
import { loadCommunityTeams } from '../src/meta/teams.js';
import { mirrorBattleResult } from '../src/evolve/fitness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-pokegenie.csv');

// Rank-1 IVs; stable Great League staples against three joke Pokemon that
// cannot legally break 1500 CP at meaningful power.
const IVS = { atk: 0, def: 15, hp: 15 };
const STRONG_IDS = ['azumarill', 'registeel', 'altaria'];
const WEAK_IDS = ['magikarp', 'sunkern', 'feebas'];

// Small enough to finish quickly, large enough to form >= 1 team. No 1v1
// scoring exists in an evolve run: the pool comes from pvpoke rank alone.
const TINY = { generations: 2, population: 8, opponentsPerGen: 6, elites: 3, curatedRatio: 0, finalFresh: 0, noHtml: true, seed: 'e2e-test-seed' };
const scratch = (name) => path.join(mkdtempSync(path.join(tmpdir(), `gbl-e2e-${name}-`)));

/** One tiny evolve run, logging into an array so the tests can read the log. */
function tinyRun(csv, opts, name) {
  const log = [];
  const outDir = scratch(name);
  return runEvolution(csv, { ...opts, outDir, threads: 2, onLog: (m) => log.push(m) }).then((result) => ({ result, log, outDir }));
}

// ---------------------------------------------------------------- shared runs

// The one evolve run. The engine ctx below is separate (loose-battle tests).
const sampled = await tinyRun(FIXTURE, TINY, 'a');

let ctx;
before(async () => {
  ctx = await initEngine();
  initTeamBattle(ctx);
});

/** Fresh Pokemon instances for a team -- never share instances between battles. */
function team(ids) {
  return ids.map((speciesId) => buildPokemon(ctx, { speciesId, ivs: IVS }));
}

// ------------------------------------------------------------- the pipeline

describe('pipeline: fixture CSV -> runEvolution -> report on disk', () => {
  test('the run produces ranked, well-formed teams and writes its report', () => {
    const { result } = sampled;
    assert.ok(result.collectionMonCount >= 3, 'imported several mons from the fixture');
    assert.ok(result.elites.length >= 1, 'ranked at least one team');
    const top = result.elites[0];
    assert.equal(top.members.length, 3, 'a recommended team has 3 members');
    assert.equal(new Set(top.members.map((m) => m.speciesId)).size, 3, 'no duplicate species within a team');
    assert.ok(top.winRate >= 0 && top.winRate <= 1, 'win rate is a fraction');
    assert.ok(existsSync(result.reportPath), 'report written to disk');
    const onDisk = readFileSync(result.reportPath, 'utf8');
    assert.match(onDisk, /# Great League Evolutionary Team Search Report/);
    assert.ok(onDisk.includes(top.members[0].name), 'report names the top team');
    assert.ok(renderEvolveReport(result).includes('## Top '), 'the report renderer works on the result');
  });

  test('no 1v1 scoring runs: the log says mons were built, never scored', () => {
    const text = sampled.log.join('\n');
    assert.match(text, /mons built \(no 1v1 scoring\)/);
    assert.doesNotMatch(text, /mons scored/);
  });

  test('a malformed fixture row is surfaced, not silently dropped', () => {
    assert.ok(sampled.result.importWarnings.some((w) => /freakemon/i.test(w)), 'unknown-species row surfaced as a collection warning');
  });
});

// ------------------------------------------------------------ battle engine

describe('battleTeams: the 3v3 driver', () => {
  test('the scenario memo is a pure speed switch: memo on and off agree bit for bit', () => {
    // Two evenly matched teams so the AI's lookaheads actually steer switches
    // and shields; run once with the context memo (warm from earlier tests in
    // this file) and once bypassing it.
    const args = () => ({ teamA: team(STRONG_IDS), teamB: team(STRONG_IDS), leadA: 1, leadB: 2, seed: 7 });
    const memoized = battleTeams(ctx, { ...args(), scenarioMemo: true });
    const memo = ctx.__teamBattle.scenarioMemo;
    assert.ok(memo && memo.hits + memo.misses > 0, 'the memo saw this battle\'s lookaheads');
    const direct = battleTeams(ctx, { ...args(), scenarioMemo: false });
    assert.deepEqual(memoized, direct, 'memoized lookaheads change nothing about the outcome');
  });

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

  // plans/WORKER_NOTES.md Item 5: mirrorBattleResult on a REAL battleTeams
  // result, so the unpaired-key guard sees the real summary shape (not a
  // hand-built stub that could drift from what battleTeams actually returns).
  test('mirrorBattleResult relabels a reversed-seat battle back to "candidate is A"', () => {
    // STRONG always wins as team A vs WEAK (see the 9/9 test above), so
    // fighting it reversed (WEAK as team A, STRONG as team B) and mirroring
    // the result back should read as an "a" win again.
    const reversed = battleTeams(ctx, { teamA: team(WEAK_IDS), teamB: team(STRONG_IDS), leadA: 0, leadB: 0 });
    assert.equal(reversed.winner, 'b', 'sanity: STRONG (team B here) actually won');
    const mirrored = mirrorBattleResult(reversed);
    assert.equal(mirrored.winner, 'a');
    assert.equal(mirrored.survivorsHp.a, reversed.survivorsHp.b);
    assert.equal(mirrored.survivorsHp.b, reversed.survivorsHp.a);
    assert.deepEqual(mirrored.survivorsHp.aPerMon, reversed.survivorsHp.bPerMon);
    assert.deepEqual(mirrored.survivorsHp.bPerMon, reversed.survivorsHp.aPerMon);
    assert.equal(mirrored.summary.leadFaintTurnA, reversed.summary.leadFaintTurnB);
    assert.equal(mirrored.summary.leadFaintTurnB, reversed.summary.leadFaintTurnA);
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
    // The last three exist to put the executor's tail work-stealing under the
    // same assertion: 7 specs over 2 workers is an uneven split of unequal-cost
    // battles (a strong-vs-weak blowout is much shorter than a mirror), so a
    // worker finishes its chunk early and raids the other's tail. Which worker
    // ends up running which spec is timing-dependent by design now -- the
    // results must not be. See src/engine/parallel.js's "Tail work-stealing".
    { teamAIds: WEAK_IDS, teamBIds: STRONG_IDS, leadA: 0, leadB: 2, seed: 11 },
    { teamAIds: STRONG_IDS, teamBIds: WEAK_IDS, leadA: 1, leadB: 1, seed: 3 },
    { teamAIds: STRONG_IDS, teamBIds: STRONG_IDS, leadA: 2, leadB: 2, seed: 19 },
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

  // The property the battle memo cache in scripts/evolve.mjs and the executor's
  // tail work-stealing BOTH rest on: a battle's result depends on its own spec
  // and seed and nothing else -- not on what its Pokemon instances did in an
  // earlier battle. That was not always true (src/engine/README.md's "Resolved:
  // battle order and reused-instance state" documents four uninitialized bench
  // fields that made it false, fixed 2026-08-22), and the tests that pinned it
  // lived in test/teamBattle.test.js, which the consolidation folded away. The
  // memo cache turns a regression here from "rare HP drift" into "wrong number
  // served for the rest of the run", so it is pinned again, here, cheaply.
  test('a battle result does not depend on what its instances fought before', () => {
    const spec = { leadA: 1, leadB: 2, seed: 5150 };
    const baseline = battleTeams(ctx, { teamA: team(STRONG_IDS), teamB: team(WEAK_IDS), ...spec });

    // Same two instance sets, deliberately reused -- and dirtied first against
    // a different opponent, at different leads, in both team slots.
    const reusedA = team(STRONG_IDS);
    const reusedB = team(WEAK_IDS);
    const noise = team(STRONG_IDS);
    battleTeams(ctx, { teamA: reusedA, teamB: noise, leadA: 0, leadB: 2 });
    battleTeams(ctx, { teamA: noise, teamB: reusedB, leadA: 2, leadB: 0, seed: 11 });
    battleTeams(ctx, { teamA: reusedA, teamB: reusedB, leadA: 2, leadB: 1, seed: 99 });

    const afterUse = battleTeams(ctx, { teamA: reusedA, teamB: reusedB, ...spec });
    assert.deepEqual(afterUse, baseline, 'reused instances produced a different battle than fresh ones');
  });

  test('empty specs resolve to [] without spawning a worker', async () => {
    assert.deepEqual(await runBattles([], { threads: 2 }), []);
  });

  // The hand-built specs above carry no moveset, so they never reach the
  // worker's applyGroupMoveset branch. A curated team whose member records an
  // explicit moveset does -- and if that moveset failed to cross the thread
  // boundary the worker would silently rebuild the mon with pvpoke's
  // RECOMMENDED set and fight a different opponent than the serial path.
  test('a curated member\'s explicit moveset survives the worker rebuild', async () => {
    const community = loadCommunityTeams(ctx, { communityFile: 'data/archive/meta-teams-community-s27.json' });
    const withOverride = community.find((t) => t.members.some((m) => m.spec.fastMove));
    assert.ok(withOverride, 'the pinned community file has a member with an explicit moveset');
    const opponent = community.find((t) => t.id !== withOverride.id);

    const serial = battleTeams(ctx, {
      teamA: withOverride.members.map((m) => m.pokemon),
      teamB: opponent.members.map((m) => m.pokemon),
      leadA: withOverride.leadIndex,
      leadB: opponent.leadIndex,
    });
    const [threaded] = await runBattles(
      [
        {
          teamA: withOverride.members.map((m) => m.spec),
          teamB: opponent.members.map((m) => m.spec),
          leadA: withOverride.leadIndex,
          leadB: opponent.leadIndex,
        },
      ],
      { threads: 2 }
    );

    assert.deepEqual(threaded, serial);
  });
});
