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
import {
  battleTeams,
  beingFarmedDown,
  canTankAndAnswer,
  initTeamBattle,
  setReactionTime,
  wrapRunScenario,
  wrapShieldBanking,
  wrapSwitchCost,
} from '../src/engine/teamBattle.js';

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

describe('reaction time (both players)', () => {
  test('setReactionTime writes ms/500 turns onto the shared archetype, and null restores pvpoke\'s own value', () => {
    const archetype = ctx.context.aiData[3];
    // The PRISTINE archetype value captured at initTeamBattle time -- not
    // whatever a previous battle in this file happened to leave behind, which
    // is exactly the distinction `null` restores to.
    const pvpokeDefault = ctx.__teamBattle.baseReactionTimes[3];
    assert.equal(pvpokeDefault, 0, 'Champion ships reactionTime 0 (instant)');

    assert.equal(setReactionTime(ctx, 3, 200), 0.4);
    assert.equal(archetype.reactionTime, 0.4, 'ms is converted to 500ms turns');

    assert.equal(setReactionTime(ctx, 3, 1000), 2, '1000ms is two full turns');

    assert.equal(setReactionTime(ctx, 3, null), pvpokeDefault, 'null restores the archetype');
    assert.equal(archetype.reactionTime, pvpokeDefault);

    assert.throws(() => setReactionTime(ctx, 99, 200), /no AI archetype/);
  });

  test('battleTeams defaults to 200ms, reports it, and honors an override', () => {
    const dflt = battleTeams(ctx, { teamA: team(STRONG_IDS), teamB: team(WEAK_IDS), seed: 7 });
    assert.equal(dflt.summary.reactionTimeMs, 200);
    // The archetype is left holding what the battle ran with -- both players
    // read the same object, which is the point of the knob.
    assert.equal(ctx.context.aiData[3].reactionTime, 0.4);

    const slow = battleTeams(ctx, {
      teamA: team(STRONG_IDS),
      teamB: team(WEAK_IDS),
      seed: 7,
      reactionTimeMs: 2000,
    });
    assert.equal(slow.summary.reactionTimeMs, 2000);
    assert.equal(ctx.context.aiData[3].reactionTime, 4);
  });
});

describe('beingFarmedDown', () => {
  // Synthetic move/Pokemon shapes -- only the fields the function reads.
  const mon = (hp, energy, fast, chargedEnergies) => ({
    hp,
    energy,
    fastMove: fast,
    chargedMoves: chargedEnergies.map((e) => ({ energy: e })),
  });
  // dps is damage per 500ms turn; energyPerTurn is energyGain / (cooldown/500).
  const move = (dps, energyGain, cooldown) => ({ dps, energyGain, cooldown });

  test('the Talonflame case: faints before it can bank another charged move', () => {
    // Real numbers off the traced battle at T29. Talonflame is on 28 HP taking
    // 6 damage/turn (Thievul's Sucker Punch, boosted by Brave Bird's own -3
    // defense debuff) -> gone in 4.7 turns. Incinerate is 20 energy on a
    // 5-turn cooldown = 4 energy/turn, and its cheapest charged move (Fly) is
    // 45, so from 20 energy it needs 6.25 turns. It cannot answer.
    const talonflame = mon(28, 20, move(3.2, 20, 2500), [45, 55]);
    const thievul = mon(32, 49, move(6, 7, 1000), [35, 45]);
    assert.equal(beingFarmedDown(talonflame, thievul), true);
  });

  test('the Thievul case: can still answer, so it stays in', () => {
    // Same battle, the other side. Thievul on 49 HP taking 3.2/turn survives
    // ~15 turns; Sucker Punch banks 3.5 energy/turn, so from 21 it reaches
    // Night Slash (35) in 4. Winning or losing on HP is not the question --
    // having an answer is.
    const thievul = mon(49, 21, move(3.5, 7, 1000), [35, 45]);
    const talonflame = mon(42, 55, move(3.2, 20, 2500), [45, 55]);
    assert.equal(beingFarmedDown(thievul, talonflame), false);
  });

  test('already holding enough energy is never farmed down, however low its HP', () => {
    const almostDead = mon(1, 40, move(1, 3, 500), [35, 50]);
    const attacker = mon(100, 0, move(20, 3, 500), [40]);
    assert.equal(beingFarmedDown(almostDead, attacker), false);
  });

  test('an even matchup is not a farm-down (mirror safety)', () => {
    const fast = move(3, 8, 1000);
    const one = mon(100, 0, fast, [40]);
    const two = mon(100, 0, fast, [40]);
    assert.equal(beingFarmedDown(one, two), false);
    assert.equal(beingFarmedDown(two, one), false);
    // Nor does a one-point HP deficit flip it -- an HP race has no margin, and
    // that is exactly why this is measured in energy instead.
    assert.equal(beingFarmedDown(mon(99, 0, fast, [40]), two), false);
  });

  test('a zero-damage fast move farms nobody down; no charged move means never an answer', () => {
    const harmless = move(0, 10, 500);
    assert.equal(beingFarmedDown(mon(10, 0, move(3, 5, 500), [50]), mon(100, 0, harmless, [40])), false);
    assert.equal(beingFarmedDown(mon(10, 0, move(3, 5, 500), []), mon(100, 0, move(3, 5, 500), [40])), true);
  });

  test('returns false rather than throwing on missing pokemon or moves', () => {
    assert.equal(beingFarmedDown(null, null), false);
    assert.equal(beingFarmedDown({ hp: 10 }, { hp: 10 }), false);
  });
});

describe('throw-and-go', () => {

  // The real matchup this behavior was built from (Jaxon's own team and an
  // opponent he actually fought), at his actual IVs -- Talonflame is the
  // canonical farm-down victim: a 5-turn fast move and two expensive charged
  // moves, so once it has thrown both it cannot bank a third before Thievul's
  // Sucker Punch finishes it.
  // Team A at Jaxon's own collection IVs; team B at the gamemaster default GL
  // IVs the sim builds curated opponents with.
  const TAG_A_IDS = [
    ['thievul', { atk: 0, def: 6, hp: 14 }],
    ['araquanid', { atk: 0, def: 12, hp: 5 }],
    ['stunfisk', { atk: 2, def: 9, hp: 9 }],
  ];
  const TAG_B_IDS = [
    ['talonflame', { atk: 4, def: 12, hp: 15 }],
    ['greninja', { atk: 5, def: 12, hp: 12 }],
    ['empoleon', { atk: 5, def: 15, hp: 13 }],
  ];
  const tagTeam = (ids) => ids.map(([speciesId, ivs]) => buildPokemon(ctx, { speciesId, ivs }));
  const TAG_A = 'A';
  const TAG_B = 'B';
  const team = (which) => tagTeam(which === 'A' ? TAG_A_IDS : TAG_B_IDS);

  test('is on by default at 2 moves, is reported, and can be disabled with 0', () => {
    const on = battleTeams(ctx, { teamA: team(TAG_A), teamB: team(TAG_B), seed: 3 });
    assert.equal(on.summary.throwAndGoMoves, 2);
    assert.ok(Number.isInteger(on.summary.throwAndGoSwitchesA));
    assert.ok(Number.isInteger(on.summary.throwAndGoSwitchesB));

    const off = battleTeams(ctx, {
      teamA: team(TAG_A),
      teamB: team(TAG_B),
      seed: 3,
      throwAndGoMoves: 0,
    });
    assert.equal(off.summary.throwAndGoMoves, 0);
    assert.equal(off.summary.throwAndGoSwitchesA, 0, 'disabled means never fires');
    assert.equal(off.summary.throwAndGoSwitchesB, 0);
  });

  // bankShields is pinned off in the two tests below. They assert a specific
  // traced battle, and that trace was taken before shield banking existed;
  // with banking on, Talonflame declines the first Night Slash and is dead by
  // T23, so it never reaches the throw-and-go it is here to demonstrate.
  // Isolating wrapThrowAndGo is the point -- see the shield-banking suite for
  // the combined default.
  test('Talonflame throws twice and leaves; Thievul, which can still answer, stays', () => {
    const r = battleTeams(ctx, { teamA: team(TAG_A), teamB: team(TAG_B), bankShields: false });
    assert.equal(r.summary.throwAndGoSwitchesB, 1, 'Talonflame throws Fly + Brave Bird, then goes');
    assert.equal(
      r.summary.throwAndGoSwitchesA,
      0,
      'Thievul banks Night Slash faster than it is chipped, so it never throw-and-goes'
    );
  });

  test('a threshold of 5 charged moves never fires where 2 does', () => {
    const opts = { bankShields: false };
    const two = battleTeams(ctx, { teamA: team(TAG_A), teamB: team(TAG_B), throwAndGoMoves: 2, ...opts });
    const five = battleTeams(ctx, { teamA: team(TAG_A), teamB: team(TAG_B), throwAndGoMoves: 5, ...opts });
    const total = (r) => r.summary.throwAndGoSwitchesA + r.summary.throwAndGoSwitchesB;
    assert.ok(total(two) > 0);
    assert.equal(total(five), 0, 'nothing in this battle lands 5 charged moves in one stint');
  });

  test('stays deterministic: same seed and settings reproduce the same battle', () => {
    const opts = { seed: 11, reactionTimeMs: 200, throwAndGoMoves: 2 };
    const r1 = battleTeams(ctx, { teamA: team(TAG_A), teamB: team(TAG_B), ...opts });
    const r2 = battleTeams(ctx, { teamA: team(TAG_A), teamB: team(TAG_B), ...opts });
    assert.deepEqual(r1, r2);
  });
});

describe('canTankAndAnswer', () => {
  // Only the fields the function reads. Energy/cooldown are pvpoke's units:
  // energyGain per use, cooldown in ms (500 = one turn).
  const fast = (energyGain, cooldown) => ({ energyGain, cooldown });

  // The traced Thievul/Talonflame lead fight, at its real numbers.
  // Talonflame: 135 HP, Incinerate (20 energy, 5 turns => 4 energy/turn),
  // cheapest charged move Fly at 45 => a full cycle is 11.25 turns.
  // Thievul: Sucker Punch does 7 per 2-turn use => 3.5 chip per turn, so
  // Talonflame needs 39.4 HP left over to see another move of its own.
  const talonflame = (hp, shields = 2) => ({
    hp,
    energy: 0,
    shields,
    stats: { hp: 135 },
    fastMove: fast(20, 2500),
    chargedMoves: [{ energy: 45 }, { energy: 55 }],
  });
  // Thievul as the attacker: Sucker Punch on a 2-turn cooldown, banking 3.5
  // energy a turn, with Night Slash at 35 to come back to.
  const thievulAttacking = (energy = 49) => ({ energy, fastMove: fast(7, 1000) });
  const nightSlash = (damage) => ({ damage, energy: 35 });

  test('the traced T14 Night Slash: tanks it and still gets another move', () => {
    // 86 - 41 = 45 left. Chip over the 11.25-turn window is 39.4, and the one
    // Night Slash Thievul can fit in that window is covered by a shield
    // Talonflame still has because it declined this one.
    const r = canTankAndAnswer(talonflame(86), thievulAttacking(), nightSlash(41), 7, {
      damage: 41,
      energy: 35,
    });
    assert.equal(r, true);
  });

  test('the same move nine turns later is the shield that has to be spent', () => {
    // T23: 50 - 41 = 9, well under the 39.4 of chip alone.
    const r = canTankAndAnswer(talonflame(50), thievulAttacking(), nightSlash(41), 7, {
      damage: 41,
      energy: 35,
    });
    assert.equal(r, false);
  });

  test('a move it cannot tank at all', () => {
    assert.equal(canTankAndAnswer(talonflame(40), thievulAttacking(), nightSlash(41), 7), false);
    assert.equal(canTankAndAnswer(talonflame(41), thievulAttacking(), nightSlash(41), 7), false);
  });

  test('a hit over half a health bar is shielded however the sums come out', () => {
    // Araquanid on 122 of 134 taking a 108-damage Meteor Beam. The 14 HP left
    // does survive 14 turns of 1-damage chip, which is longer than the 13.3
    // turns it needs to charge Water Pulse -- and it is still not a hit to
    // tank. 0.81 of a health bar.
    const araquanid = {
      hp: 122,
      energy: 0,
      shields: 2,
      stats: { hp: 134 },
      fastMove: fast(3, 500),
      chargedMoves: [{ energy: 40 }, { energy: 50 }],
    };
    const attacker = { energy: 0, fastMove: fast(4, 500) };
    const meteorBeam = { damage: 108, energy: 60 };
    assert.equal(canTankAndAnswer(araquanid, attacker, meteorBeam, 1), false);
    // The same Pokemon, the same window, a hit under the ceiling: fine.
    assert.equal(canTankAndAnswer(araquanid, attacker, { damage: 60, energy: 60 }, 1), true);
  });

  test('follow-up charged moves count, but only past the shields still held', () => {
    // A defender that needs a long time to come back (35 energy at 1/turn =
    // 35 turns) against an attacker that banks 5 energy a turn and has a
    // 40-energy move: 175 energy in the window, so 4 more throws.
    const defender = {
      hp: 200,
      energy: 0,
      shields: 1,
      stats: { hp: 400 },
      fastMove: fast(1, 500),
      chargedMoves: [{ energy: 35 }],
    };
    const attacker = { energy: 40, fastMove: fast(5, 500) };
    const incoming = { damage: 20, energy: 40 };
    const followUp = { damage: 40, energy: 40 };

    // With no follow-up term at all it looks survivable: 180 left, no chip.
    assert.equal(canTankAndAnswer(defender, attacker, incoming, 0), true);
    // Four throws, one blocked by the shield it kept => 3 x 40 = 120 < 180.
    assert.equal(canTankAndAnswer(defender, attacker, incoming, 0, followUp), true);
    // Same board, a harder follow-up: 3 x 70 = 210 > 180.
    assert.equal(
      canTankAndAnswer(defender, attacker, incoming, 0, { damage: 70, energy: 40 }),
      false
    );
    // Two shields in hand covers one more of them.
    const twoShields = { ...defender, shields: 2 };
    assert.equal(
      canTankAndAnswer(twoShields, attacker, incoming, 0, { damage: 70, energy: 40 }),
      true
    );
  });

  test('energy already in hand does not make it free', () => {
    // The move in hand is not "another move of my own" -- the horizon is a
    // full charge cycle either way, so holding 45 energy changes nothing.
    const loaded = { ...talonflame(50), energy: 45 };
    assert.equal(canTankAndAnswer(loaded, thievulAttacking(), nightSlash(41), 7), false);
  });

  test('nothing chipping it and nothing to follow up with is bankable', () => {
    assert.equal(canTankAndAnswer(talonflame(50), thievulAttacking(), nightSlash(41), 0), true);
  });

  test('no charged move to come back to means the shield gets spent', () => {
    const noAnswer = { ...talonflame(120), chargedMoves: [] };
    assert.equal(
      canTankAndAnswer(noAnswer, thievulAttacking(), { damage: 10, energy: 35 }, 7),
      false
    );
  });

  test('a fast move that banks no energy is the same story', () => {
    const noEnergy = { ...talonflame(120), fastMove: fast(0, 1000) };
    assert.equal(
      canTankAndAnswer(noEnergy, thievulAttacking(), { damage: 10, energy: 35 }, 7),
      false
    );
  });

  test('missing inputs are safe', () => {
    assert.equal(canTankAndAnswer(null, thievulAttacking(), nightSlash(41), 7), false);
    assert.equal(canTankAndAnswer(talonflame(86), null, nightSlash(41), 7), false);
    assert.equal(canTankAndAnswer(talonflame(86), {}, nightSlash(41), 7), false);
    assert.equal(canTankAndAnswer(talonflame(86), thievulAttacking(), null, 7), false);
  });
});

describe('shield banking', () => {
  const BANK_A_IDS = [
    ['thievul', { atk: 0, def: 6, hp: 14 }],
    ['araquanid', { atk: 0, def: 12, hp: 5 }],
    ['stunfisk', { atk: 2, def: 9, hp: 9 }],
  ];
  const BANK_B_IDS = [
    ['talonflame', { atk: 4, def: 12, hp: 15 }],
    ['greninja', { atk: 5, def: 12, hp: 12 }],
    ['empoleon', { atk: 5, def: 15, hp: 13 }],
  ];
  const bankTeam = (which) =>
    (which === 'A' ? BANK_A_IDS : BANK_B_IDS).map(([speciesId, ivs]) =>
      buildPokemon(ctx, { speciesId, ivs })
    );

  test('is on by default, is reported, and can be disabled', () => {
    const on = battleTeams(ctx, { teamA: bankTeam('A'), teamB: bankTeam('B'), seed: 3 });
    assert.equal(on.summary.bankShields, true);
    assert.ok(Number.isInteger(on.summary.shieldsDeclinedA));
    assert.ok(Number.isInteger(on.summary.shieldsDeclinedB));

    const off = battleTeams(ctx, {
      teamA: bankTeam('A'),
      teamB: bankTeam('B'),
      seed: 3,
      bankShields: false,
    });
    assert.equal(off.summary.bankShields, false);
    assert.equal(off.summary.shieldsDeclinedA, 0, 'disabled means never declines');
    assert.equal(off.summary.shieldsDeclinedB, 0);
  });

  test('Talonflame declines the first Night Slash', () => {
    // The traced case: pvpoke shields a 41-damage, 35-energy Night Slash at
    // 86 of 135 HP with two Pokemon still in the back. With banking on it
    // takes the hit instead.
    const r = battleTeams(ctx, { teamA: bankTeam('A'), teamB: bankTeam('B') });
    assert.ok(r.summary.shieldsDeclinedB > 0, 'B keeps a shield it would have spent');
  });

  test('declining shields leaves more of them on the board', () => {
    const opts = { teamA: bankTeam('A'), teamB: bankTeam('B'), seed: 7 };
    const on = battleTeams(ctx, { ...opts, teamA: bankTeam('A'), teamB: bankTeam('B') });
    const off = battleTeams(ctx, {
      teamA: bankTeam('A'),
      teamB: bankTeam('B'),
      seed: 7,
      bankShields: false,
    });
    const left = (r) => r.summary.shieldsRemainingA + r.summary.shieldsRemainingB;
    assert.ok(
      left(on) >= left(off),
      `banking should not spend more shields (on=${left(on)} off=${left(off)})`
    );
  });

  test('a shield is never declined by the last Pokemon standing', () => {
    // Nothing in the back means the banked shield has no later value, so the
    // rule stands aside even on a textbook cheap chip. Driven through
    // wrapShieldBanking directly with a stub player, because the only way to
    // reach a real last-Pokemon shield decision is to script a whole battle.
    // The traced T14 board: Talonflame on 86 taking a 41-damage Night Slash.
    const defender = {
      hp: 86,
      energy: 0,
      shields: 2,
      stats: { hp: 135 },
      fastMove: { energyGain: 20, cooldown: 2500 },
      chargedMoves: [{ energy: 45 }, { energy: 55 }],
    };
    const attacker = {
      energy: 49,
      fastMove: { energy: 0, energyGain: 7, cooldown: 1000 },
      chargedMoves: [{ energy: 35 }],
    };
    const nightSlash = { energy: 35 };
    // 41 for the charged move, 7 for the fast move -- the traced numbers.
    const DamageCalculator = { damage: (a, d, m) => (m.energy > 0 ? 41 : 7) };

    const stubPlayer = (remaining) => {
      const ai = { decideShield: () => true };
      return { getAI: () => ai, getIndex: () => 0, getRemainingPokemon: () => remaining };
    };

    const withBench = stubPlayer(2);
    wrapShieldBanking([withBench], DamageCalculator);
    assert.equal(
      withBench.getAI().decideShield(attacker, defender, nightSlash),
      false,
      'with a Pokemon in the back the cheap chip is taken'
    );

    const lastOne = stubPlayer(1);
    wrapShieldBanking([lastOne], DamageCalculator);
    assert.equal(
      lastOne.getAI().decideShield(attacker, defender, nightSlash),
      true,
      'as the last Pokemon it shields exactly as pvpoke decided'
    );
  });

  test('being behind on bodies does not block banking on its own', () => {
    // Shields are match-wide, not per-Pokemon: with a bench left, there is
    // still a later to spend a banked shield on even while down a body, so
    // a tankable hit gets declined exactly as it would level on bodies. Only
    // being on your own last Pokemon (see the last-Pokemon test above) means
    // there is no later at all.
    const defender = {
      hp: 86,
      energy: 0,
      shields: 2,
      stats: { hp: 135 },
      fastMove: { energyGain: 20, cooldown: 2500 },
      chargedMoves: [{ energy: 45 }, { energy: 55 }],
    };
    const attacker = {
      energy: 49,
      fastMove: { energy: 0, energyGain: 7, cooldown: 1000 },
      chargedMoves: [{ energy: 35 }],
    };
    const nightSlash = { energy: 35 };
    const DamageCalculator = { damage: (a, d, m) => (m.energy > 0 ? 41 : 7) };

    const pair = (mine, theirs) => {
      const ai = { decideShield: () => true };
      const me = { getAI: () => ai, getIndex: () => 0, getRemainingPokemon: () => mine };
      const them = { getAI: () => null, getIndex: () => 1, getRemainingPokemon: () => theirs };
      wrapShieldBanking([me, them], DamageCalculator);
      return me;
    };

    assert.equal(
      pair(2, 2).getAI().decideShield(attacker, defender, nightSlash),
      false,
      'level on bodies: the cheap chip is taken'
    );
    assert.equal(
      pair(2, 3).getAI().decideShield(attacker, defender, nightSlash),
      false,
      'down a body with a bench left: still declined, there is a later to bank for'
    );
  });

  test('never turns a no into a yes', () => {
    const defender = {
      hp: 200,
      energy: 0,
      shields: 2,
      stats: { hp: 300 },
      fastMove: { energyGain: 8, cooldown: 500 },
      chargedMoves: [{ energy: 35 }],
    };
    const attacker = {
      energy: 0,
      fastMove: { energy: 0, energyGain: 3, cooldown: 1000 },
      chargedMoves: [{ energy: 50 }],
    };
    const DamageCalculator = { damage: (a, d, m) => (m.energy > 0 ? 10 : 1) };
    const ai = { decideShield: () => false };
    const player = { getAI: () => ai, getIndex: () => 0, getRemainingPokemon: () => 3 };
    const declined = wrapShieldBanking([player], DamageCalculator);
    assert.equal(player.getAI().decideShield(attacker, defender, { energy: 35 }), false);
    assert.equal(declined[0], 0, 'a shield pvpoke already declined is not counted');
  });

  test('stays deterministic: same seed and settings reproduce the same battle', () => {
    const opts = { seed: 13, bankShields: true };
    const r1 = battleTeams(ctx, { teamA: bankTeam('A'), teamB: bankTeam('B'), ...opts });
    const r2 = battleTeams(ctx, { teamA: bankTeam('A'), teamB: bankTeam('B'), ...opts });
    assert.deepEqual(r1, r2);
  });
});

describe('switch turn cost', () => {
  // A minimal stand-in for pvpoke's Battle: just the four things wrapSwitchCost
  // touches. Driving it directly is the only way to hit each of the three
  // free-switch cases deliberately rather than hoping a real battle produces
  // one of each.
  function fakeBattle() {
    let turns = 1;
    const active = [
      { index: 0, hp: 100, cooldown: 0 },
      { index: 1, hp: 100, cooldown: 0 },
    ];
    return {
      getTurns: () => turns,
      goToTurn(t) {
        turns = t;
      },
      getPokemon: () => active,
      useMove() {},
      processAction(action, poke) {
        active[poke.index] = action.incoming;
      },
    };
  }
  const bench = () => ({ index: 0, hp: 100, cooldown: 0 });
  const switchAction = (incoming) => ({ type: 'switch', valid: true, incoming });

  test('an ordinary switch costs the incoming Pokemon a turn', () => {
    const battle = fakeBattle();
    const counts = wrapSwitchCost(battle);
    const outgoing = battle.getPokemon()[0];
    const incoming = bench();

    battle.processAction(switchAction(incoming), outgoing);

    assert.equal(incoming.cooldown, 1000, 'one turn, charged before step decrements it');
    assert.deepEqual(counts.costly, [1, 0]);
    assert.deepEqual(counts.free, [0, 0]);
  });

  test('a switch on the turn a charged move resolved is free', () => {
    const battle = fakeBattle();
    const counts = wrapSwitchCost(battle);
    const outgoing = battle.getPokemon()[0];
    const incoming = bench();

    battle.goToTurn(20);
    battle.useMove(outgoing, battle.getPokemon()[1], { energy: 45 });
    battle.processAction(switchAction(incoming), outgoing);

    assert.equal(incoming.cooldown, 0);
    assert.deepEqual(counts.free, [1, 0]);
    assert.deepEqual(counts.costly, [0, 0]);
  });

  test("the opponent's charged move opens the window too", () => {
    const battle = fakeBattle();
    const counts = wrapSwitchCost(battle);
    const [mine, theirs] = battle.getPokemon();
    const incoming = bench();

    battle.goToTurn(20);
    battle.useMove(theirs, mine, { energy: 45 });
    battle.processAction(switchAction(incoming), mine);

    assert.equal(incoming.cooldown, 0);
    assert.deepEqual(counts.free, [1, 0]);
  });

  test('a fast move does not open the window', () => {
    const battle = fakeBattle();
    wrapSwitchCost(battle);
    const outgoing = battle.getPokemon()[0];
    const incoming = bench();

    battle.goToTurn(20);
    battle.useMove(outgoing, battle.getPokemon()[1], { energy: 0, energyGain: 7 });
    battle.processAction(switchAction(incoming), outgoing);

    assert.equal(incoming.cooldown, 1000);
  });

  test('the window closes on the next turn', () => {
    const battle = fakeBattle();
    wrapSwitchCost(battle);
    const outgoing = battle.getPokemon()[0];
    const incoming = bench();

    battle.goToTurn(20);
    battle.useMove(outgoing, battle.getPokemon()[1], { energy: 45 });
    battle.goToTurn(21);
    battle.processAction(switchAction(incoming), outgoing);

    assert.equal(incoming.cooldown, 1000);
  });

  test('a replacement after a faint is free', () => {
    const battle = fakeBattle();
    const counts = wrapSwitchCost(battle);
    const outgoing = battle.getPokemon()[0];
    outgoing.hp = 0;
    const incoming = bench();

    battle.goToTurn(20);
    battle.processAction(switchAction(incoming), outgoing);

    assert.equal(incoming.cooldown, 0);
    assert.deepEqual(counts.free, [1, 0]);
  });

  test('disabled still counts, but never charges', () => {
    const battle = fakeBattle();
    const counts = wrapSwitchCost(battle, { enabled: false });
    const outgoing = battle.getPokemon()[0];
    const incoming = bench();

    battle.processAction(switchAction(incoming), outgoing);

    assert.equal(incoming.cooldown, 0);
    assert.deepEqual(counts.costly, [1, 0], 'the switch is still classified');
  });

  test('a non-switch action is left alone', () => {
    const battle = fakeBattle();
    const counts = wrapSwitchCost(battle);
    const poke = battle.getPokemon()[0];
    battle.processAction({ type: 'fast', valid: true, incoming: poke }, poke);
    assert.deepEqual(counts.costly, [0, 0]);
    assert.deepEqual(counts.free, [0, 0]);
  });

  test('in a real battle: on by default, reported, and disableable', () => {
    const A = [
      ['thievul', { atk: 0, def: 6, hp: 14 }],
      ['araquanid', { atk: 0, def: 12, hp: 5 }],
      ['stunfisk', { atk: 2, def: 9, hp: 9 }],
    ];
    const B = [
      ['talonflame', { atk: 4, def: 12, hp: 15 }],
      ['greninja', { atk: 5, def: 12, hp: 12 }],
      ['empoleon', { atk: 5, def: 15, hp: 13 }],
    ];
    const mk = (ids) => ids.map(([speciesId, ivs]) => buildPokemon(ctx, { speciesId, ivs }));

    const on = battleTeams(ctx, { teamA: mk(A), teamB: mk(B) });
    assert.equal(on.summary.switchTurnCost, true);
    // Leads are placed with a direct setNewPokemon call, so they are never
    // classified at all: every counted switch happened mid-battle.
    const counted =
      on.summary.costlySwitchesA +
      on.summary.costlySwitchesB +
      on.summary.freeSwitchesA +
      on.summary.freeSwitchesB;
    assert.ok(counted > 0);
    assert.ok(on.summary.freeSwitchesA + on.summary.freeSwitchesB > 0, 'faints are free');

    const off = battleTeams(ctx, { teamA: mk(A), teamB: mk(B), switchTurnCost: false });
    assert.equal(off.summary.switchTurnCost, false);
  });

  test('costing the turn changes the battle, and stays deterministic', () => {
    const A = [
      ['thievul', { atk: 0, def: 6, hp: 14 }],
      ['araquanid', { atk: 0, def: 12, hp: 5 }],
      ['stunfisk', { atk: 2, def: 9, hp: 9 }],
    ];
    const B = [
      ['talonflame', { atk: 4, def: 12, hp: 15 }],
      ['greninja', { atk: 5, def: 12, hp: 12 }],
      ['empoleon', { atk: 5, def: 15, hp: 13 }],
    ];
    const mk = (ids) => ids.map(([speciesId, ivs]) => buildPokemon(ctx, { speciesId, ivs }));
    const opts = { seed: 5 };

    const on1 = battleTeams(ctx, { teamA: mk(A), teamB: mk(B), ...opts });
    const on2 = battleTeams(ctx, { teamA: mk(A), teamB: mk(B), ...opts });
    assert.deepEqual(on1, on2);

    const off = battleTeams(ctx, { teamA: mk(A), teamB: mk(B), ...opts, switchTurnCost: false });
    assert.ok(on1.summary.costlySwitchesA + on1.summary.costlySwitchesB > 0);
    assert.notDeepEqual(on1.summary.turns, off.summary.turns);
  });
});
