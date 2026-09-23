// Tests for src/evolve/sampled.js (--sampled-combats): every candidate fights only its own 1/K
// block of opponents, nobody ends a generation without a fitness, same seed => same result,
// and the config/CLI wiring (off by default, refused on resume). Stub executor, no real battles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWithSampling, blocksForFraction } from '../src/evolve/sampled.js';
import { evaluateTeamsInOrder } from '../src/evolve/evaluate.js';

const spec = (id) => ({ speciesId: id, ivs: { atk: 0, def: 0, hp: 0 }, shadow: false, bestBuddy: false });
const isStrong = (s) => s.some((m) => m.speciesId.startsWith('cand') && Number(m.speciesId.slice(4)) >= 4);
const executor = {
  async run(specs) {
    return specs.map((s) => {
      const candIsA = s.teamA.some((m) => m.speciesId.startsWith('cand'));
      const cand = candIsA ? s.teamA : s.teamB;
      const winner = isStrong(cand) === candIsA ? 'a' : 'b';
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

test('blocksForFraction accepts 1/K only', () => {
  assert.equal(blocksForFraction(0.5), 2);
  assert.equal(blocksForFraction(0.25), 4);
  assert.equal(blocksForFraction(0.3), null);
  assert.equal(blocksForFraction(1), null);
});

test('sampled combats fights F of the grid, gives every team and opponent a result, and is deterministic per seed', async () => {
  const full = await evaluateTeamsInOrder({}, params);
  const run = await evaluateWithSampling({}, params, { fraction: 0.5, seed: 's' });
  assert.equal(run.battleCount, full.battleCount / 2);
  assert.equal(run.results.length, N);
  assert.equal(run.opponentTally.length, N);
  for (const r of run.results) assert.ok(Number.isFinite(r.winRate));
  for (const t of run.opponentTally) assert.ok(t && t.battles > 0, 'every opponent is fought by someone');
  assert.deepEqual(run.sampled.blocks, [{ teams: 4, opponents: 4 }, { teams: 4, opponents: 4 }]);
  const again = await evaluateWithSampling({}, params, { fraction: 0.5, seed: 's' });
  assert.deepEqual(again.results, run.results);
});

test('sampled combats with Halving on fights fewer battles than sampled alone', async () => {
  const plain = await evaluateWithSampling({}, params, { fraction: 0.5, seed: 's' });
  const halved = await evaluateWithSampling({}, params, {
    fraction: 0.5, seed: 's', halving: { rounds: 2, keep: 0.5, fitnessOf: (r) => r.winRate },
  });
  assert.ok(halved.battleCount < plain.battleCount);
  for (const r of halved.results) assert.ok(Number.isFinite(r.winRate));
  for (const t of halved.opponentTally) assert.ok(t);
});

test('--sampled-combats is off by default, part of the run config, and a mismatch names the key', async () => {
  const { buildRunConfig, configsMatch, describeConfigMismatch } = await import('../src/evolve/config.js');
  const { parseEvolveArgs } = await import('../src/evolve/cli.js');
  const csv = new URL('../fixtures/sample-pokegenie.csv', import.meta.url).pathname;
  const off = buildRunConfig(csv, {});
  assert.ok(!('sampledCombats' in off));
  const on = buildRunConfig(csv, { sampledCombats: 0.5 });
  assert.equal(on.sampledCombats, 0.5);
  assert.equal(on.halvingRounds, 3, 'works alongside Halving');
  assert.ok(!configsMatch(off, on));
  assert.ok(!configsMatch(on, buildRunConfig(csv, { sampledCombats: 0.25 })));
  assert.match(describeConfigMismatch(on, off), /sampledCombats/);
  assert.equal(parseEvolveArgs([csv, '--sampled-combats', '0.25']).opts.sampledCombats, 0.25);
  assert.throws(() => parseEvolveArgs([csv, '--sampled-combats', '0.3']), /not 1\/K/);
});
