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

test('fixed-K sampling: each candidate fights at most K opponents, all opponents covered, off by default, refusals name the problem', async () => {
  const { blocksForPerCandidate } = await import('../src/evolve/sampled.js');
  const { buildRunConfig, configsMatch, describeConfigMismatch } = await import('../src/evolve/config.js');
  const { parseEvolveArgs } = await import('../src/evolve/cli.js');
  assert.equal(blocksForPerCandidate(500, 50), 10);
  assert.equal(blocksForPerCandidate(50, 50), 1);
  assert.equal(blocksForPerCandidate(30, 50), 1);
  const run = await evaluateWithSampling({}, params, { perCandidate: 4, seed: 's' });
  assert.deepEqual(run.sampled.blocks, [{ teams: 4, opponents: 4 }, { teams: 4, opponents: 4 }]);
  assert.equal(run.sampled.perCandidate, 4);
  for (const t of run.opponentTally) assert.ok(t && t.battles > 0);
  const all = await evaluateWithSampling({}, params, { perCandidate: 50, seed: 's' });
  assert.equal(all.battleCount, (await evaluateTeamsInOrder({}, params)).battleCount);
  const csv = new URL('../fixtures/sample-pokegenie.csv', import.meta.url).pathname;
  assert.ok(!('sampledOpponents' in buildRunConfig(csv, {})));
  const k10 = buildRunConfig(csv, { sampledOpponents: 10 });
  assert.match(describeConfigMismatch(k10, buildRunConfig(csv, { sampledOpponents: 50 })), /sampledOpponents/);
  assert.ok(!configsMatch(k10, buildRunConfig(csv, {})));
  assert.equal(parseEvolveArgs([csv, '--sampled-opponents', '10', '--population', '60', '--opponents-per-gen', '300', '--population-final-ratio', '1']).opts.sampledOpponents, 10);
  // 40 candidates cannot cover 500 opponents at K=10 (needs 50 blocks)
  assert.throws(() => parseEvolveArgs([csv, '--sampled-opponents', '10', '--opponents-per-gen', '500']), /never be fought/);
  assert.throws(() => parseEvolveArgs([csv, '--sampled-opponents', '1.5']), /whole number/);
  assert.throws(() => parseEvolveArgs([csv, '--sampled-opponents', '5', '--sampled-combats', '0.5']), /cannot be combined/);
});

test('fixed-K A/B stop rule: sweep answers yes / no / undecided from the paired 95% range', async () => {
  const { sweepDecision, decisionsAt, MIN_SEEDS } = await import('../scripts/sampled-k-stats.mjs');
  assert.equal(sweepDecision({ lower: 0.005, upper: 0.03 }), 'yes');
  assert.equal(sweepDecision({ lower: -0.03, upper: -0.005 }), 'no');
  assert.equal(sweepDecision({ lower: -0.008, upper: 0.008 }), 'no', 'inside +-1 point counts as no');
  assert.equal(sweepDecision({ lower: -0.02, upper: 0.03 }), 'undecided');
  assert.equal(MIN_SEEDS, 3);
  const cell = (arm, seed, q) => ({ arm, seed, heldoutMeanTop: q, genBattles: 100, genSeconds: 1 });
  const seeds = ['s1', 's2', 's3'];
  const cells = seeds.flatMap((s, k) => [cell('base', s, 0.5), cell('k10eq', s, 0.5), cell('o50', s, 0.5), cell('c40', s, 0.5),
    cell('o500', s, 0.6 + k * 0.001), cell('c320', s, 0.5 + (k ? 0.03 : -0.03))]);
  const d = decisionsAt(cells, seeds, 3);
  assert.equal(d.sweeps.opponents, 'yes');
  assert.equal(d.sweeps.candidates, null);
});
