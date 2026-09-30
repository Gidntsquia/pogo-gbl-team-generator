// Tests for src/meta/sampleTeams.js -- the weighted opponent-team sampler.
// Verifies: determinism under a fixed seed, no duplicate
// species within a team, curated/sampled mixture proportion, battle
// readiness (real 3v3 battle), the meta-pool cap (the sampled half only ever
// draws from the top N species by pvpoke's own ranking score), a loose
// usage-weight distribution check with that cap lifted (top-quartile-weight
// species appear meaningfully more often than bottom-quartile ones), and
// designated leads (members[0] is the lead, chosen from the leads role
// priors when they're supplied).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { initEngine } from '../src/engine/harness.js';
import { battleTeams } from '../src/engine/teamBattle.js';
import { loadUsageWeights } from '../src/meta/usage.js';
import { loadRoleScores } from '../src/meta/roles.js';
import {
  DEFAULT_META_POOL_SIZE,
  loadMovesetPool,
  sampleOpponentTeams,
} from '../src/meta/sampleTeams.js';

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
  // Cap lifted (metaPoolSize: 0) -- this asserts the WEIGHTS still shape the
  // draw across the full field. The cap is a separate knob, tested below.
  const sorted = [...weights.entries()].sort((a, b) => b[1] - a[1]);
  const n = sorted.length;
  const topSet = new Set(sorted.slice(0, Math.floor(n / 4)).map(([id]) => id));
  const botSet = new Set(sorted.slice(Math.floor((3 * n) / 4)).map(([id]) => id));

  const teams = sampleOpponentTeams(ctx, {
    count: 220,
    weights,
    seed: 'dist-test',
    curatedRatio: 0,
    metaPoolSize: 0,
  });
  assert.equal(teams.length, 220);

  let topCount = 0;
  let botCount = 0;
  for (const team of teams) {
    for (const m of team.members) {
      if (topSet.has(m.speciesId)) topCount++;
      if (botSet.has(m.speciesId)) botCount++;
    }
  }
  assert.ok(botCount > 0, 'sanity: with the cap lifted, bottom-quartile species appear sometimes');
  const ratio = topCount / botCount;
  assert.ok(ratio >= 2, `expected top-quartile species to appear >=2x as often as bottom-quartile, got ${ratio}`);
});

test('the meta-pool cap keeps every sampled member inside the top N by ranking score', () => {
  const capped = new Set(loadMovesetPool(ctx, { metaPoolSize: 30 }).map((e) => e.speciesId));
  assert.equal(capped.size, 30);

  const teams = sampleOpponentTeams(ctx, { count: 25, weights, seed: 'cap-pool', curatedRatio: 0, metaPoolSize: 30 });
  for (const team of teams) {
    for (const m of team.members) {
      assert.ok(capped.has(m.speciesId), `${m.speciesId} is outside the top-30 meta pool`);
    }
  }

  // Default cap, and the uncapped field it is carved out of.
  const byDefault = loadMovesetPool(ctx);
  const uncapped = loadMovesetPool(ctx, { metaPoolSize: 0 });
  assert.equal(byDefault.length, DEFAULT_META_POOL_SIZE);
  assert.ok(uncapped.length > byDefault.length, 'the cap actually removes species');
  assert.ok(
    byDefault.every((e, i) => i === 0 || e.score <= byDefault[i - 1].score),
    'the pool is score-sorted descending'
  );
  assert.ok(byDefault.at(-1).score >= uncapped.at(-1).score, 'the cap keeps the top of the field, not the tail');
});

test('every team is lead-ordered: members[0] leads, leadIndex is 0', () => {
  const roleScores = loadRoleScores(ctx);
  const teams = sampleOpponentTeams(ctx, { count: 12, weights, seed: 'lead-order', curatedRatio: 0.5, roleScores });
  assert.ok(teams.some((t) => t.label === 'curated') && teams.some((t) => t.label === 'sampled'));

  for (const team of teams) {
    assert.equal(team.leadIndex, 0, `${team.id} declares members[0] as its lead`);
    if (team.label !== 'sampled') continue;
    const leadPriors = team.members.map((m) => roleScores.get(m.speciesId)?.lead ?? 0);
    assert.equal(
      leadPriors[0],
      Math.max(...leadPriors),
      `${team.id} leads with its highest lead prior (${team.members.map((m) => m.speciesId)})`
    );
  }
});

test('without role scores a sampled lead is still assigned, deterministically', () => {
  const opts = { count: 8, weights, seed: 'no-roles', curatedRatio: 0 };
  const a = sampleOpponentTeams(ctx, opts);
  const b = sampleOpponentTeams(ctx, opts);
  assert.deepEqual(
    a.map((t) => t.members.map((m) => m.speciesId)),
    b.map((t) => t.members.map((m) => m.speciesId))
  );
  assert.ok(a.every((t) => t.leadIndex === 0 && t.members.length === 3));
  // The lead is part of the id, so the id agrees with the member order.
  assert.ok(a.every((t) => t.id === `sampled-${t.members.map((m) => m.speciesId).join('-')}`));
});
