// Tests for src/meta/sampleTeams.js -- the weighted opponent-team sampler.
// Verifies: determinism under a fixed seed, no duplicate
// species within a team, curated/sampled mixture proportion, battle
// readiness (real 3v3 battle), and a loose usage-weight distribution check
// (top-quartile-weight species appear meaningfully more often than
// bottom-quartile ones across many sampled teams).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { initEngine } from '../src/engine/harness.js';
import { battleTeams } from '../src/engine/teamBattle.js';
import { loadUsageWeights } from '../src/meta/usage.js';
import { sampleOpponentTeams } from '../src/meta/sampleTeams.js';

const ctx = await initEngine();
const weights = loadUsageWeights(ctx);

function baseIdOf(speciesId) {
  return speciesId.endsWith('_shadow') ? speciesId.slice(0, -'_shadow'.length) : speciesId;
}

test('is deterministic across repeated calls under the same seed', () => {
  const a = sampleOpponentTeams(ctx, { count: 10, weights, seed: 'repeat-me' });
  const b = sampleOpponentTeams(ctx, { count: 10, weights, seed: 'repeat-me' });
  assert.deepEqual(
    a.map((t) => ({ id: t.id, label: t.label, species: t.members.map((m) => m.speciesId) })),
    b.map((t) => ({ id: t.id, label: t.label, species: t.members.map((m) => m.speciesId) }))
  );
});

test('a different seed produces a different sampled composition', () => {
  const a = sampleOpponentTeams(ctx, { count: 10, weights, seed: 'seed-a' });
  const b = sampleOpponentTeams(ctx, { count: 10, weights, seed: 'seed-b' });
  const sampledA = a.filter((t) => t.label === 'sampled').map((t) => t.id);
  const sampledB = b.filter((t) => t.label === 'sampled').map((t) => t.id);
  assert.notDeepEqual(sampledA, sampledB);
});

test('every team has 3 distinct species (shadow/base count as the same species)', () => {
  const teams = sampleOpponentTeams(ctx, { count: 20, weights, seed: 'dedup-check' });
  for (const team of teams) {
    assert.equal(team.members.length, 3, `${team.id} should have 3 members`);
    const baseIds = team.members.map((m) => baseIdOf(m.speciesId));
    assert.equal(new Set(baseIds).size, 3, `${team.id} should have 3 distinct species, got ${baseIds}`);
  }
});

test('mixture proportion: curatedRatio controls the curated/sampled split', () => {
  const teams = sampleOpponentTeams(ctx, { count: 20, weights, seed: 'mix-check', curatedRatio: 0.4 });
  assert.equal(teams.length, 20);
  const curated = teams.filter((t) => t.label === 'curated');
  const sampled = teams.filter((t) => t.label === 'sampled');
  assert.equal(curated.length, 8, 'round(20 * 0.4) curated teams');
  assert.equal(sampled.length, 12);
});

test('curatedRatio 0 / 1 gracefully cap at the requested extremes', () => {
  const allSampled = sampleOpponentTeams(ctx, { count: 15, weights, seed: 'all-sampled', curatedRatio: 0 });
  assert.ok(allSampled.every((t) => t.label === 'sampled'));

  const allCurated = sampleOpponentTeams(ctx, { count: 5, weights, seed: 'all-curated', curatedRatio: 1 });
  assert.ok(allCurated.every((t) => t.label === 'curated'));
  assert.equal(allCurated.length, 5);
});

test('a curated draw larger than the curated pool is capped, not thrown', () => {
  const tinyCurated = [
    { id: 'x', name: 'X', members: [] },
    { id: 'y', name: 'Y', members: [] },
  ];
  const teams = sampleOpponentTeams(ctx, {
    count: 10,
    weights,
    seed: 'cap-check',
    curatedRatio: 1,
    curated: tinyCurated,
  });
  const curated = teams.filter((t) => t.label === 'curated');
  assert.equal(curated.length, 2, 'capped at the curated pool size, not the requested count');
});

test('a sampled team is battle-ready and usable in a real 3v3 battle', () => {
  const [teamX, teamY] = sampleOpponentTeams(ctx, {
    count: 2,
    weights,
    seed: 'battle-ready',
    curatedRatio: 0,
  });
  for (const team of [teamX, teamY]) {
    for (const m of team.members) {
      const p = m.pokemon;
      assert.ok(p.fastMove && p.fastMove.moveId, `${m.speciesId} has a fast move`);
      assert.ok(p.chargedMoves.length >= 1, `${m.speciesId} has a charged move`);
      assert.ok(p.cp <= 1500 && p.cp > 0, `${m.speciesId} cp ${p.cp} in (0,1500]`);
      assert.ok(p.stats.hp > 0, `${m.speciesId} has positive HP`);
    }
  }
  const result = battleTeams(ctx, {
    teamA: teamX.members.map((m) => m.pokemon),
    teamB: teamY.members.map((m) => m.pokemon),
    leadA: 0,
    leadB: 0,
  });
  assert.ok(['a', 'b', 'tie'].includes(result.winner));
  assert.ok(result.summary.turns > 0, 'a real battle ran (>0 turns)');
});

test('top-quartile-weight species appear meaningfully more often than bottom-quartile ones', () => {
  const sorted = [...weights.entries()].sort((a, b) => b[1] - a[1]);
  const n = sorted.length;
  const topSet = new Set(sorted.slice(0, Math.floor(n / 4)).map(([id]) => id));
  const botSet = new Set(sorted.slice(Math.floor((3 * n) / 4)).map(([id]) => id));

  const teams = sampleOpponentTeams(ctx, { count: 220, weights, seed: 'dist-test', curatedRatio: 0 });
  assert.equal(teams.length, 220);

  let topCount = 0;
  let botCount = 0;
  for (const team of teams) {
    for (const m of team.members) {
      if (topSet.has(m.speciesId)) topCount++;
      if (botSet.has(m.speciesId)) botCount++;
    }
  }
  assert.ok(botCount > 0, 'sanity: bottom-quartile species should still appear sometimes');
  const ratio = topCount / botCount;
  assert.ok(ratio >= 2, `expected top-quartile species to appear >=2x as often as bottom-quartile, got ${ratio}`);
});
