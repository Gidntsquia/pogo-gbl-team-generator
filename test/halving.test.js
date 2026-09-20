// Tests for src/evolve/halving.js (--halving-rounds): slice sizes, battle savings,
// survivors, and that a cut team never outranks one that outlasted it. Stub executor, no real battles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWithHalving, halvingSlices } from '../src/evolve/halving.js';

const spec = (id) => ({ speciesId: id, ivs: { atk: 0, def: 0, hp: 0 }, shadow: false, bestBuddy: false });

// Candidate k beats every opponent from either seat when k >= 4, else loses to all.
const isStrong = (s) => s.some((m) => m.speciesId.startsWith('cand') && Number(m.speciesId.slice(4)) >= 4);
const executor = {
  async run(specs) {
    return specs.map((s) => {
      const candIsA = s.teamA.some((m) => m.speciesId.startsWith('cand'));
      const cand = candIsA ? s.teamA : s.teamB;
      const candWins = isStrong(cand);
      const winner = candWins === candIsA ? 'a' : 'b';
      const hp = (side) => (winner === side ? 100 : 0);
      return {
        ok: true,
        value: {
          winner,
          survivorsHp: { a: hp('a'), b: hp('b'), aPerMon: [hp('a'), 0, 0], bPerMon: [hp('b'), 0, 0] },
          summary: { leadFaintTurnA: null, leadFaintTurnB: null },
        },
      };
    });
  },
};

const N = 8;
const builtMons = Object.fromEntries(
  Array.from({ length: N }, (_, k) => [`c${k}`, { speciesId: `cand${k}`, name: `Cand${k}`, pokemon: {}, spec: spec(`cand${k}`) }])
);
const opponents = Array.from({ length: N }, (_, j) => ({
  id: `o${j}`, name: `O${j}`, leadIndex: 0, members: [{ speciesId: `opp${j}`, spec: spec(`opp${j}`) }],
}));
const params = {
  teams: Array.from({ length: N }, (_, k) => [`c${k}`]),
  matrix: { builtMons },
  opponents,
  pairingsFor: () => [{ leadA: 0, leadB: 0 }],
  executor,
};
const halving = { rounds: 3, keep: 0.5, seed: 'h', fitnessOf: (r) => r.winRate };

test('halvingSlices doubles up to the full pool', () => {
  assert.deepEqual(halvingSlices(40, 3), [10, 20, 40]);
  assert.deepEqual(halvingSlices(30, 4), [4, 8, 15, 30]);
});

test('halving fights fewer pairings, keeps the strong teams, and never ranks a cut team above a survivor', async () => {
  const run = await evaluateWithHalving({}, params, halving);
  // 8 teams x 2 opps + 4 x 2 new + 2 x 4 new, two seats each = 64 (the full grid is 128)
  assert.equal(run.battleCount, 64);
  assert.equal(run.results.length, N);
  const finalists = run.results.slice(4).map((r) => r.winRate);
  assert.ok(finalists.every((w) => w === 1), 'strong teams win everything they play');
  const floor = Math.min(...finalists);
  for (const r of run.results.slice(0, 4)) assert.ok(r.winRate <= floor);
  assert.ok(run.opponentTally.every((t) => t && t.battles > 0), 'every opponent has a ledger');
});
