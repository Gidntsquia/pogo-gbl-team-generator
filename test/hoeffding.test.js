// Tests for src/evolve/hoeffding.js (--hoeffding-races): Wilson interval math,
// battle savings, survivors, and that a cut team never outranks one that
// outlasted it. Stub executor, no real battles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWithHoeffding, wilsonInterval } from '../src/evolve/hoeffding.js';

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
const hoeffding = { chunk: 2, keep: 0.5, confidence: 0.95, seed: 'h', fitnessOf: (r) => r.winRate };

test('wilsonInterval: n=0 is maximally wide, a clean 0/n sits at 0 with a positive upper bound, more battles narrows the interval', () => {
  assert.deepEqual(wilsonInterval(0, 0), { lo: 0, hi: 1 });
  const small = wilsonInterval(0, 4);
  assert.equal(small.lo, 0);
  assert.ok(small.hi > 0 && small.hi < 1);
  const big = wilsonInterval(0, 400);
  assert.ok(big.hi < small.hi, 'more evidence of losing narrows the upper bound');
});

test('hoeffding races fights fewer pairings than the full grid, keeps the strong teams ahead, and never ranks a cut team above a survivor', async () => {
  const run = await evaluateWithHoeffding({}, params, hoeffding);
  assert.equal(run.results.length, N);
  assert.ok(run.battleCount < N * N * 2, `expected savings vs the full grid (${N * N * 2}), got ${run.battleCount}`);
  const finalists = run.results.slice(4).map((r) => r.winRate);
  assert.ok(finalists.every((w) => w === 1), 'strong teams win everything they play');
  const floor = Math.min(...finalists);
  for (const r of run.results.slice(0, 4)) assert.ok(r.winRate <= floor);
  assert.ok(run.opponentTally.every((t) => t && t.battles > 0), 'every opponent has a ledger');
  assert.ok(run.hoeffding.rounds >= 1);
});

test('hoeffding races off by default; --hoeffding-races on replaces halving in the run config and is refused on resume with a different value', async () => {
  const { buildRunConfig, configsMatch } = await import('../src/evolve/config.js');
  const csv = new URL('../fixtures/sample-pokegenie.csv', import.meta.url).pathname;
  const off = buildRunConfig(csv, {});
  assert.ok(!('hoeffdingRaces' in off));
  assert.equal(off.halvingRounds, 3, 'halving stays the default when hoeffding is off');
  const on = buildRunConfig(csv, { hoeffdingRaces: true });
  assert.equal(on.hoeffdingRaces, true);
  assert.equal(on.hoeffdingChunk, 10);
  assert.equal(on.hoeffdingKeep, 0.5);
  assert.equal(on.hoeffdingConfidence, 0.95);

  assert.ok(!configsMatch(off, on), 'flipping the switch must be a config mismatch, refusing a silent resume');
});
