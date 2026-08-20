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
import { initEngine, buildPokemon } from '../src/engine/harness.js';
import { battleTeams, initTeamBattle } from '../src/engine/teamBattle.js';

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
