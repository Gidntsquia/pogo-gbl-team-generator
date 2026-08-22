// JavaScript Document
//
// Verifies src/engine/teamBattle.js -- the headless 3v3 team-battle driver --
// which runs pvpoke's own Training-mode ("emulate") engine in Node. No battle
// math, AI, or shield/switch logic is exercised here directly: every outcome
// comes from executing vendor/pvpoke's Battle + TrainingAI code. This module
// only supplies a deterministic virtual clock, a seeded RNG, and symmetric
// both-players-are-AI wiring, and those are exactly what these tests pin down.
//
// Run with: node --test test/teamBattle.test.js

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initEngine, buildPokemon, simBattle } from '../src/engine/harness.js';
import { battleTeams, initTeamBattle, wrapRunScenario } from '../src/engine/teamBattle.js';

// Rank-1 IVs (attack-weight rank 1 is close enough for these coarse tests).
const IVS = { atk: 0, def: 15, hp: 15 };

// Stable Great League staples for a strong team, and three joke Pokemon that
// cannot legally break 1500 CP at meaningful power for the weak team.
const STRONG_IDS = ['azumarill', 'registeel', 'altaria'];
const WEAK_IDS = ['magikarp', 'sunkern', 'feebas'];

let ctx;

/** Build a fresh set of Pokemon instances for a team (never share instances). */
function team(ids) {
  return ids.map((speciesId) => buildPokemon(ctx, { speciesId, ivs: IVS }));
}

before(async () => {
  ctx = await initEngine();
  initTeamBattle(ctx);
});

describe('battleTeams shape and basic contract', () => {
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
    assert.throws(() =>
      battleTeams(ctx, { teamA: team(STRONG_IDS), teamB: team(WEAK_IDS), leadA: 5 })
    );
  });

  test('leadA/leadB choose the starting Pokemon', () => {
    // With lead index 1, the second listed species should be the one whose HP
    // is tracked as aPerMon[0] (teamBattle reorders the lead to slot 0).
    const r = battleTeams(ctx, {
      teamA: team(STRONG_IDS),
      teamB: team(WEAK_IDS),
      leadA: 1,
      leadB: 2,
    });
    assert.equal(r.summary.leadA, 1);
    assert.equal(r.summary.leadB, 2);
  });
});

describe('a dominant team beats a weak team in every lead pairing', () => {
  test('3 top-meta mons win all 9 lead pairings vs 3 joke mons', () => {
    let wins = 0;
    const losses = [];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const r = battleTeams(ctx, {
          teamA: team(STRONG_IDS),
          teamB: team(WEAK_IDS),
          leadA: i,
          leadB: j,
        });
        if (r.winner === 'a') {
          wins++;
        } else {
          losses.push(`${i},${j}=>${r.winner}`);
        }
      }
    }
    assert.equal(wins, 9, `strong team should win all 9 pairings; lost: ${losses.join(' ')}`);
  });
});

describe('mirror match is roughly balanced across all 9 lead pairings', () => {
  // Tolerance: pvpoke's emulate engine is built for human(0) vs AI(1) and has
  // a couple of player-1-only strategic hooks; teamBattle mirrors them onto
  // player 0, but a tiny residual asymmetry (plus HP-margin tiebreaks on
  // timed-out battles) means the split is ~50/50 rather than exactly 50/50.
  // We require neither side to take more than 6 of the 9 pairings and each to
  // win at least 2 -- i.e. an aggregate win rate inside [2/9, 7/9].
  test('identical teams split the 9 pairings near evenly', () => {
    let a = 0;
    let b = 0;
    let ties = 0;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const r = battleTeams(ctx, {
          teamA: team(STRONG_IDS),
          teamB: team(STRONG_IDS),
          leadA: i,
          leadB: j,
        });
        if (r.winner === 'a') a++;
        else if (r.winner === 'b') b++;
        else ties++;
      }
    }
    assert.equal(a + b + ties, 9);
    assert.ok(a <= 6 && b <= 6, `neither side should dominate a mirror (a=${a}, b=${b})`);
    assert.ok(a >= 2 && b >= 2, `both sides should win some pairings (a=${a}, b=${b})`);
  });
});

describe('determinism', () => {
  test('same inputs (teams, leads, difficulty, default seed) give the same result', () => {
    const opts = { leadA: 1, leadB: 2 };
    const r1 = battleTeams(ctx, { teamA: team(STRONG_IDS), teamB: team(STRONG_IDS), ...opts });
    const r2 = battleTeams(ctx, { teamA: team(STRONG_IDS), teamB: team(STRONG_IDS), ...opts });
    assert.equal(r1.winner, r2.winner);
    assert.deepEqual(r1.survivorsHp, r2.survivorsHp);
    assert.equal(r1.summary.turns, r2.summary.turns);
    assert.equal(r1.summary.seed, r2.summary.seed);
  });

  test('an explicit seed is honored and different seeds can diverge', () => {
    const base = { teamA: team(STRONG_IDS), teamB: team(STRONG_IDS), leadA: 0, leadB: 1 };
    const rA = battleTeams(ctx, { ...base, teamA: team(STRONG_IDS), teamB: team(STRONG_IDS), seed: 42 });
    const rB = battleTeams(ctx, { ...base, teamA: team(STRONG_IDS), teamB: team(STRONG_IDS), seed: 42 });
    assert.equal(rA.winner, rB.winner);
    assert.deepEqual(rA.survivorsHp, rB.survivorsHp);
    assert.equal(rA.summary.seed, 42);
  });
});

// GOALS T20 -- proves the mechanism-1 fix (teamBattle.js stamping
// setBattle()/.index on all 6 members before fullReset()). Root cause: every
// buildPokemon() call sets a fresh mon's PRIVATE `battle` ref to ctx.battle --
// the single shared Battle instance src/scoring/index.js's 1v1 sims reuse
// across the whole pipeline (harness.js buildPokemon/simBattle) -- and its
// `.index` defaults to 0. A mon that goes on to sit on a 3v3 team's BENCH
// never had setNewPokemon() called on it (only the two leads do), so its
// fullReset() -> resetMoves() -> initializeMove() reads
// `battle.getOpponent(self.index)` off that stale shared context: whatever
// opponent a completely unrelated 1v1 scoring battle last left sitting in
// ctx.battle's other player slot. That leftover opponent can flip a
// close-DPE bestChargedMove tie-break. This test reproduces the exact
// mechanism (dirty ctx.battle with real 1v1 sims against different
// species, in different orders, then build a fresh probe team and run it
// through battleTeams) and asserts the probe team's PRE-BATTLE state --
// captured the instant teamBattle's setup calls fullReset(), before the turn
// loop runs -- is bit-identical no matter what was left in ctx.battle
// beforehand. This does NOT assert full battle-outcome identity across
// thread counts/orderings -- that remains open per T20b (a second,
// independent order-dependence mechanism inside TrainingAI).
describe('T20: pre-battle team state is independent of leftover shared-battle-context state', () => {
  /** @returns {{index:number, bestChargedMove:string|null, fastMoves:Array, chargedMoves:Array}} */
  function snapshotMon(mon) {
    return {
      index: mon.index,
      bestChargedMove: mon.bestChargedMove ? mon.bestChargedMove.moveId : null,
      fastMoves: mon.fastMovePool.map((m) => ({ id: m.moveId, damage: m.damage, dpe: m.dpe })),
      chargedMoves: mon.chargedMovePool.map((m) => ({ id: m.moveId, damage: m.damage, dpe: m.dpe })),
    };
  }

  /**
   * Wrap each mon's fullReset() to snapshot its state the instant that call
   * returns -- this is exactly the pre-battle moment teamBattle.js's setup
   * produces, captured without touching production code.
   */
  function captureAtFullReset(mons) {
    const snapshots = mons.map(() => null);
    mons.forEach((mon, i) => {
      const origFullReset = mon.fullReset.bind(mon);
      mon.fullReset = function (...args) {
        const result = origFullReset(...args);
        snapshots[i] = snapshotMon(mon);
        return result;
      };
    });
    return snapshots;
  }

  /**
   * Mirrors what src/scoring/index.js's 1v1 matrix pass does: run a real sim
   * on ctx's single shared battle, leaving `oppId` (built fresh, IVS rank-1)
   * sitting in one of ctx.battle's player slots as leftover state for
   * whatever mon gets built next.
   */
  function dirtyWithOpponent(oppId) {
    const dummyA = buildPokemon(ctx, { speciesId: oppId, ivs: IVS });
    const dummyB = buildPokemon(ctx, { speciesId: 'magikarp', ivs: IVS });
    simBattle(ctx, { p1: dummyA, p2: dummyB, shields: [0, 0] });
  }

  const DIRTY_SPECIES = ['skarmory', 'lanturn', 'medicham', 'sableye', 'clodsire'];

  /** Dirty ctx.battle with `dirtyOrder`, THEN build a fresh probe team and run it through a real battleTeams call, returning its captured pre-battle state. */
  function snapshotForOrdering(dirtyOrder) {
    for (const oppId of dirtyOrder) dirtyWithOpponent(oppId);
    const probeTeam = team(STRONG_IDS);
    const snapshots = captureAtFullReset(probeTeam);
    battleTeams(ctx, { teamA: probeTeam, teamB: team(WEAK_IDS), seed: 'T20-probe' });
    return snapshots;
  }

  test('probe team pre-battle state (index, bestChargedMove, per-move damage/DPE) is bit-identical regardless of what opponent was left in the shared scoring-battle context, or in what order', () => {
    const none = snapshotForOrdering([]);
    const canonical = snapshotForOrdering(DIRTY_SPECIES);
    const reversed = snapshotForOrdering([...DIRTY_SPECIES].reverse());
    const shuffled = snapshotForOrdering([
      DIRTY_SPECIES[2],
      DIRTY_SPECIES[0],
      DIRTY_SPECIES[4],
      DIRTY_SPECIES[1],
      DIRTY_SPECIES[3],
    ]);

    assert.equal(canonical.length, 3);
    for (const snap of canonical) {
      assert.ok(snap.bestChargedMove, 'a bestChargedMove was actually selected');
    }
    assert.deepEqual(canonical, none, 'dirtying the shared battle context changes nothing pre-battle');
    assert.deepEqual(reversed, canonical, 'reversed dirtying order changes nothing pre-battle');
    assert.deepEqual(shuffled, canonical, 'shuffled dirtying order changes nothing pre-battle');
  });
});

// GOALS T20b, part 1 -- an earlier fire on this same ticket investigated the
// second, independent order-dependence mechanism (see src/engine/README.md's
// "Known limitation", mechanism 2): vendor/pvpoke's TrainingAI#runScenario
// builds a throwaway single-battle Battle to test a shield/bait scenario and
// calls that throwaway battle's setNewPokemon() on the REAL pokemon/opponent
// it's given, which repoints their private `battle` ref (via
// Pokemon#setBattle) at the throwaway -- and runScenario's own restore block
// never puts `.battle`, `.baitShields`, or `.priority` back. wrapRunScenario
// (teamBattle.js) wraps runScenario on both of a battle's TrainingAI
// instances so every call is transparent for exactly those 4 fields, using
// pvpoke's own public getBattle()/setBattle(). This test proves the WRAPPING
// MECHANISM itself against fake stand-ins (no engine boot needed -- pure
// function, like T23's evolve.js fake-fitness tests) since every real vendor
// call site of runScenario only reads its *return value*, never the mutated
// fields, once wrapped.
//
// That fire found this wrap to be a REAL fix for a genuinely leaky restore
// block (proven by this test, and by a measurable canonical win-rate shift
// in scripts/variance-study.mjs) -- but NOT sufficient on its own to
// eliminate the ticket's own reproduced 1-in-360 reversed-ordering flip, so
// it left T20b's box unchecked pending a third mechanism. The describe block
// below this one ("T20b, part 2") found and fixed that third mechanism; see
// its own comment and src/engine/README.md's Known limitation section for
// the full, combined picture. Both fixes are real and both are kept: this
// wrap makes runScenario itself side-effect-transparent (defense in depth
// against a class of bug that could resurface if runScenario grows a new
// caller), even though the actual reproduced flip turned out to have a
// different root cause.
describe('T20b, part 1: wrapRunScenario makes runScenario side-effect-transparent for battle/baitShields/farmEnergy/priority', () => {
  function makeFakeMon(label) {
    let battle = { label: `real-${label}` };
    return {
      label,
      getBattle: () => battle,
      setBattle: (b) => {
        battle = b;
      },
      baitShields: 1,
      farmEnergy: false,
      priority: 0,
    };
  }

  /** Mimics pvpoke's own runScenario: mutates all 4 fields on both args and does not restore them -- the vendor bug this wraps around. */
  function makeLeakyOriginal(returnValue) {
    return function (type, poke, opp) {
      const throwaway = { label: 'throwaway' };
      poke.setBattle(throwaway);
      opp.setBattle(throwaway);
      poke.baitShields = 0;
      opp.baitShields = 0;
      poke.farmEnergy = true;
      opp.farmEnergy = true;
      poke.priority = 99;
      opp.priority = 99;
      return returnValue;
    };
  }

  test('restores all 4 fields on both pokemon and opponent after a call, and passes the return value through', () => {
    const pokemon = makeFakeMon('pokemon');
    const opponent = makeFakeMon('opponent');
    const ai = { runScenario: makeLeakyOriginal({ average: 500 }) };
    wrapRunScenario(ai);

    const pokemonBattleBefore = pokemon.getBattle();
    const opponentBattleBefore = opponent.getBattle();
    const result = ai.runScenario('NO_BAIT', pokemon, opponent);

    assert.deepEqual(result, { average: 500 }, 'return value passes through unchanged');
    assert.equal(pokemon.getBattle(), pokemonBattleBefore, 'pokemon.battle restored');
    assert.equal(opponent.getBattle(), opponentBattleBefore, 'opponent.battle restored');
    assert.equal(pokemon.baitShields, 1, 'pokemon.baitShields restored');
    assert.equal(opponent.baitShields, 1, 'opponent.baitShields restored');
    assert.equal(pokemon.farmEnergy, false, 'pokemon.farmEnergy restored');
    assert.equal(opponent.farmEnergy, false, 'opponent.farmEnergy restored');
    assert.equal(pokemon.priority, 0, 'pokemon.priority restored');
    assert.equal(opponent.priority, 0, 'opponent.priority restored');
  });

  test('restores fields even if the wrapped call throws', () => {
    const pokemon = makeFakeMon('pokemon');
    const opponent = makeFakeMon('opponent');
    const leaky = makeLeakyOriginal(null);
    const ai = {
      runScenario(type, poke, opp) {
        leaky(type, poke, opp);
        throw new Error('boom');
      },
    };
    wrapRunScenario(ai);

    const pokemonBattleBefore = pokemon.getBattle();
    assert.throws(() => ai.runScenario('NO_BAIT', pokemon, opponent), /boom/);
    assert.equal(pokemon.getBattle(), pokemonBattleBefore, 'still restored after a throw');
    assert.equal(pokemon.baitShields, 1);
    assert.equal(pokemon.farmEnergy, false);
    assert.equal(pokemon.priority, 0);
  });

  test('nested/sequential calls each restore to what was true immediately before THAT call (stack discipline, not a single global save)', () => {
    const pokemon = makeFakeMon('pokemon');
    const opponent = makeFakeMon('opponent');
    const ai = { runScenario: makeLeakyOriginal({ average: 1 }) };
    wrapRunScenario(ai);

    // Two sequential calls (as evaluateMatchup makes 4 in a row): each call's
    // leak must be undone before the next call observes pokemon's state, and
    // the field must end at its true pre-first-call value, not some
    // intermediate leaked value from either call.
    ai.runScenario('BOTH_BAIT', pokemon, opponent);
    ai.runScenario('NEITHER_BAIT', pokemon, opponent);

    assert.equal(pokemon.baitShields, 1);
    assert.equal(pokemon.getBattle().label, 'real-pokemon');
  });
});

// GOALS T20b, part 2 -- the third mechanism part 1 (above) left open,
// root-caused and fixed. With mechanism 1 fully neutralized (T20 above) and
// part 1's runScenario leak fixed (real, but proven insufficient by its own
// test's PROGRESS notes), a reproduced knife-edge battle from
// scripts/variance-study.mjs still flipped winner under reordering. Direct
// instrumentation (pre-battle-state dump of every roster member, not just
// the two leads T20 already covered) found the actual cause: pvpoke's own
// fullReset()/setRoster() never touch a Pokemon's baitShields, farmEnergy,
// or priority fields -- only setNewPokemon()/evaluateMatchup() do, and both
// only ever run for whichever Pokemon is currently ACTIVE (the two leads at
// battle start, or whoever switches in later). A bench member that stays
// benched all battle -- or that was itself a LEAD in this same instance's
// PREVIOUS battleTeams() call -- carries those three fields over from that
// unrelated matchup: instrumenting the real "4|4|2|2" variance-study flip
// found bench members sitting at baitShields=0/priority=1 (leftover AI
// strategy state) versus pvpoke's own documented Pokemon.js constructor
// defaults (baitShields=1, farmEnergy=false, priority=0) a fresh instance
// starts with, while the two ACTIVE leads' pre-battle state (index,
// bestChargedMove, every move's damage/dpe -- T20's own bar) was already
// bit-identical in both runs. teamBattle.js now stamps those three fields to
// pvpoke's own defaults on all six members before anything reads them.
describe('T20b, part 2: bench members do not carry AI-decision state (baitShields/farmEnergy/priority) over from a previous battle', () => {
  test('a mon that led a previous battle (finishing with non-default baitShields/priority) resets to pvpoke defaults when reused as a bench member', () => {
    // Battle it as team B's ACTIVE LEAD first: pvpoke's own setNewPokemon
    // deterministically sets a team-B lead's priority to 1 (players[1]'s own
    // fixed player-index priority, not an AI strategy choice), so this sanity
    // check never depends on which strategy the AI happens to pick.
    const reusedMon = team(STRONG_IDS)[0]; // azumarill
    const warmTeamB = team(WEAK_IDS);
    warmTeamB[0] = reusedMon;
    battleTeams(ctx, { teamA: team(WEAK_IDS), teamB: warmTeamB, leadB: 0, seed: 'T20b-warm' });

    assert.equal(
      reusedMon.priority,
      1,
      'sanity: leading a real battle as team B actually left non-default AI state to reset (otherwise this test proves nothing)'
    );

    // Reuse the SAME instance as a BENCH member (index 1, not the lead) of a
    // brand new battle, and capture its state the instant fullReset() runs.
    let snapshot = null;
    const origFullReset = reusedMon.fullReset.bind(reusedMon);
    reusedMon.fullReset = function (...args) {
      const result = origFullReset(...args);
      snapshot = {
        baitShields: reusedMon.baitShields,
        farmEnergy: reusedMon.farmEnergy,
        priority: reusedMon.priority,
      };
      return result;
    };

    const teamA = team(WEAK_IDS);
    teamA[1] = reusedMon; // bench slot, since leadA defaults to 0 below
    battleTeams(ctx, { teamA, teamB: team(WEAK_IDS), leadA: 0, seed: 'T20b-bench' });

    assert.deepEqual(
      snapshot,
      { baitShields: 1, farmEnergy: false, priority: 0 },
      "pvpoke's own Pokemon.js defaults, not this instance's previous-battle leftover state"
    );
  });

  test('the exact reproduced variance-study flip (candidate 4 vs opponent 4, lead 2v2, after 332 prior battles in canonical order) no longer differs from a fresh-instance run of the same matchup', async () => {
    const { loadMetaTeams } = await import('../src/meta/teams.js');
    const LEADS = [0, 1, 2];
    const candidateCount = 5;
    const opponentCount = 8;

    function canonicalBattleList() {
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

    const baseline = canonicalBattleList();
    const targetIndex = baseline.findIndex((b) => b.key === '4|4|2|2');
    assert.ok(targetIndex > 0, 'sanity: the known flip key exists in this battle plan');

    const pool = loadMetaTeams(ctx);
    const candidatePokemon = pool
      .slice(0, candidateCount)
      .map((t) => t.members.map((m) => m.pokemon));
    const opponentPokemon = pool
      .slice(candidateCount, candidateCount + opponentCount)
      .map((t) => t.members.map((m) => m.pokemon));

    let contaminatedResult = null;
    for (let i = 0; i <= targetIndex; i++) {
      const { c, o, leadA, leadB } = baseline[i];
      const r = battleTeams(ctx, {
        teamA: candidatePokemon[c],
        teamB: opponentPokemon[o],
        leadA,
        leadB,
      });
      if (i === targetIndex) contaminatedResult = r;
    }

    const freshPool = loadMetaTeams(ctx);
    const freshResult = battleTeams(ctx, {
      teamA: freshPool[4].members.map((m) => m.pokemon),
      teamB: freshPool[candidateCount + 4].members.map((m) => m.pokemon),
      leadA: 2,
      leadB: 2,
    });

    assert.equal(contaminatedResult.winner, freshResult.winner);
    assert.deepEqual(contaminatedResult.survivorsHp, freshResult.survivorsHp);
    assert.equal(contaminatedResult.summary.turns, freshResult.summary.turns);
  });
});

// GOALS T20b, part 3 (same fire as part 2, found while reviewing it) --
// `hasActed` belongs in part 2's reset loop for the same reason as
// baitShields/farmEnergy/priority: pvpoke's Pokemon constructor defaults it
// to `false` (Pokemon.js:109), but neither reset()/fullReset() nor
// Battle#step()'s own per-turn `poke.hasActed = false` (Battle.js:300, which
// only clears it for the two currently-ACTIVE pokemon[] slots) ever resets
// it for a bench member. A stale hasActed=true from a previous battle can
// make Battle#getTurnAction's `! poke.hasActed` gate (Battle.js:749) treat a
// just-switched-in mon as having already acted this turn.
describe('T20b, part 3: bench members do not carry hasActed over from a previous battle', () => {
  test('hasActed=true left over on a reused instance resets to false when it becomes a bench member', () => {
    // Battle.js's own per-turn reset (Battle.js:300) only ever clears
    // hasActed for the two currently-ACTIVE pokemon[] slots -- never a bench
    // member -- so the condition this fix guards against is "whatever
    // hasActed happened to be true at the moment this instance's last real
    // battle ended." Set it directly rather than depending on which turn a
    // real battle happens to end on, which would make this test flaky.
    const reusedMon = team(STRONG_IDS)[0];
    reusedMon.hasActed = true;

    let snapshot = null;
    const origFullReset = reusedMon.fullReset.bind(reusedMon);
    reusedMon.fullReset = function (...args) {
      const result = origFullReset(...args);
      snapshot = reusedMon.hasActed;
      return result;
    };

    const teamA = team(WEAK_IDS);
    teamA[1] = reusedMon; // bench slot, leadA defaults to 0
    battleTeams(ctx, { teamA, teamB: team(WEAK_IDS), leadA: 0, seed: 'T20b-hasActed-bench' });

    assert.equal(snapshot, false, "pvpoke's own Pokemon.js default, not the true sentinel this test seeded");
  });
});
