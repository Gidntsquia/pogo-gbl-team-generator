// Tests for src/meta/opponentPool.js -- the OPPONENT-side genetic algorithm.
// Everything here runs on a hand-built pool over a 12-species meta slice: no
// battles, no fitness that came from one. Verifies the invariants the module
// exists to hold -- curated entries are never culled and never modified in
// place, the cull fires whether the pool is growing or shrinking, mutation
// rates differ by origin, immigrants fill what is left, a culled team cannot
// be re-created the same generation, and a pool survives the checkpoint
// round trip.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { initEngine } from '../src/engine/harness.js';
import { buildMetaMon } from '../src/scoring/index.js';
import { loadMovesetPool } from '../src/meta/sampleTeams.js';
import {
  DEFAULT_OPPONENT_DEATH_RATE,
  curatedHeadcount,
  initOpponentPool,
  isProtectedOpponent,
  nextOpponentPool,
  rehydrateOpponentPool,
  serializeOpponentPool,
} from '../src/meta/opponentPool.js';

const ctx = await initEngine();

// A deliberately small slice of the real meta pool: big enough that distinct
// teams are easy to compose, small enough that collisions are reachable on
// purpose (see the graceful-shortfall test).
const movesetPool = loadMovesetPool(ctx, { metaPoolSize: 12 });
const weights = new Map(movesetPool.map((e) => [e.speciesId, 1]));

/** A curated MetaTeam built out of `n` consecutive meta-pool entries from `at`. */
function curatedTeam(id, at, tier) {
  const members = movesetPool.slice(at, at + 3).map((e) => buildMetaMon(ctx, e));
  return {
    id,
    name: members.map((m) => m.speciesId).join(' / '),
    members,
    leadIndex: 0,
    ...(tier ? { tier } : {}),
  };
}

const curated = [
  curatedTeam('cur-a', 0),
  curatedTeam('cur-b', 3),
  curatedTeam('cur-c', 6),
  curatedTeam('cur-d', 9, 'off-meta'),
];

const NEVER = { mutationFloor: 0, mutationCeil: 0, curatedMutationRate: 0 };
const ALWAYS = { mutationFloor: 1, mutationCeil: 1, curatedMutationRate: 1 };

function origins(pool) {
  const counts = {};
  for (const e of pool) counts[e.origin] = (counts[e.origin] ?? 0) + 1;
  return counts;
}

function newPool(size, seed, curatedRatio = 0.5) {
  return initOpponentPool(ctx, { size, weights, curated, curatedRatio, movesetPool, seed });
}

test('curatedHeadcount is the ratio, capped by both the curated pool and the pool size', () => {
  assert.equal(curatedHeadcount(10, 0.5, 100), 5);
  assert.equal(curatedHeadcount(10, 0.66, 100), 7); // round, not floor
  assert.equal(curatedHeadcount(10, 0.9, 4), 4, 'capped at the curated pool');
  assert.equal(curatedHeadcount(3, 2, 100), 3, 'capped at the pool size');
  assert.equal(curatedHeadcount(10, 0, 100), 0);
});

test('gen 0 is a curated majority plus composed teams, all lead-ordered and unique', () => {
  const pool = newPool(8, 'gen0');
  assert.equal(pool.length, 8);
  assert.equal(pool.filter(isProtectedOpponent).length, 4, 'round(8 * 0.5), capped at the 4 curated teams');
  assert.deepEqual(origins(pool), { curated: 4, sampled: 4 });
  assert.equal(new Set(pool.map((e) => e.id)).size, 8, 'ids are unique within the pool');
  for (const e of pool) {
    assert.equal(e.leadIndex, 0);
    assert.equal(e.members.length, 3);
    assert.equal(e.label, e.origin);
  }
  assert.deepEqual(
    newPool(8, 'gen0').map((e) => e.id),
    pool.map((e) => e.id),
    'same seed, same pool'
  );
});

test('curated entries survive a generation in which they are the worst performers', () => {
  const pool = newPool(8, 'protect');
  // Fitness 0 for every curated entry, 1 for everything else: if curated were
  // cullable at all, this is the generation that would cull them.
  const fitness = pool.map((e) => (isProtectedOpponent(e) ? 0 : 1));
  const { pool: next, lineage } = nextOpponentPool(ctx, {
    pool,
    fitness,
    targetSize: 8,
    weights,
    curated,
    curatedRatio: 0.5,
    movesetPool,
    seed: 'protect-next',
    opts: NEVER,
  });
  const survivingCuratedIds = next.filter(isProtectedOpponent).map((e) => e.id).sort();
  assert.deepEqual(survivingCuratedIds, pool.filter(isProtectedOpponent).map((e) => e.id).sort());
  assert.ok(lineage.died.every((i) => !isProtectedOpponent(pool[i])), 'only evolvable entries died');
  // Untouched, not merely present: same object identity for the members.
  for (const before of pool.filter(isProtectedOpponent)) {
    const after = next.find((e) => e.id === before.id);
    assert.deepEqual(after.members.map((m) => m.speciesId), before.members.map((m) => m.speciesId));
  }
});

test('the cull takes the worst evolvable entries, worst first', () => {
  const pool = newPool(10, 'cull', 0.4);
  const evolvable = pool.map((e, i) => i).filter((i) => !isProtectedOpponent(pool[i]));
  // Ascending fitness in pool order, so the first evolvable index is the worst.
  const fitness = pool.map((_, i) => i / pool.length);
  const { lineage } = nextOpponentPool(ctx, {
    pool,
    fitness,
    targetSize: 10,
    weights,
    curated,
    curatedRatio: 0.4,
    movesetPool,
    seed: 'cull-next',
    opts: NEVER,
  });
  const expectedDeaths = Math.round(DEFAULT_OPPONENT_DEATH_RATE * evolvable.length);
  assert.equal(lineage.died.length, expectedDeaths);
  assert.deepEqual(lineage.died, evolvable.slice(0, expectedDeaths), 'worst-fitness first');
});

test('the cull still fires while the pool is growing, and the pool hits its new size', () => {
  const pool = newPool(8, 'grow');
  const fitness = pool.map((_, i) => i);
  const { pool: next, lineage } = nextOpponentPool(ctx, {
    pool,
    fitness,
    targetSize: 14,
    weights,
    curated,
    curatedRatio: 0.3,
    movesetPool,
    seed: 'grow-next',
    opts: NEVER,
  });
  assert.equal(next.length, 14);
  assert.ok(lineage.died.length >= 1, 'growth does not switch the cull off');
  const diedIds = new Set(lineage.died.map((i) => pool[i].id));
  assert.ok(next.every((e) => !diedIds.has(e.id)), 'a culled team is not in the next pool');
});

test('a shrinking target trims to exactly targetSize', () => {
  const pool = newPool(12, 'shrink', 0.25);
  const fitness = pool.map((_, i) => i);
  const { pool: next } = nextOpponentPool(ctx, {
    pool,
    fitness,
    targetSize: 6,
    weights,
    curated,
    curatedRatio: 0.25,
    movesetPool,
    seed: 'shrink-next',
    opts: NEVER,
  });
  assert.equal(next.length, 6);
});

test('mutants come from their parents and never displace the parent', () => {
  const pool = newPool(10, 'mutate', 0.4);
  const fitness = pool.map((_, i) => i);
  // Grown to 16 so there are more open slots than mutation rolls -- mutants
  // compete for a fixed number of slots by fitness percentile, and curated
  // parents sit at the bottom of that order by construction (flat rate, no
  // percentile), so a tight pool would never show a curated-mutant at all.
  const { pool: next } = nextOpponentPool(ctx, {
    pool,
    fitness,
    targetSize: 16,
    weights,
    curated,
    curatedRatio: 0.4,
    movesetPool,
    seed: 'mutate-next',
    opts: { ...ALWAYS, immigrantFraction: 0 },
  });
  const mutants = next.filter((e) => e.origin === 'mutant' || e.origin === 'curated-mutant');
  assert.ok(mutants.length >= 1, 'a mutation rate of 1 produced at least one mutant');
  const byId = new Map(pool.map((e) => [e.id, e]));
  for (const m of mutants) {
    const parent = byId.get(m.parentId);
    assert.ok(parent, `${m.id} names a parent that was in the pool`);
    assert.equal(
      m.origin,
      parent.origin === 'curated' ? 'curated-mutant' : 'mutant',
      'a curated parent yields a distinctly-labeled lineage'
    );
    assert.notEqual(m.id, parent.id, 'a mutant is a new entry, not an edit');
    assert.equal(m.leadIndex, 0);
  }
  assert.ok(
    mutants.some((m) => byId.get(m.parentId).origin === 'curated'),
    'curatedMutationRate 1 mutates curated parents too'
  );
  // Every curated parent is still in the pool alongside its mutant.
  for (const e of pool.filter(isProtectedOpponent)) {
    assert.ok(next.some((n) => n.id === e.id), `${e.id} stayed in the pool`);
  }
});

test('with mutation off, the freed slots go to immigrants', () => {
  const pool = newPool(10, 'immi', 0.4);
  const fitness = pool.map((_, i) => i);
  const { pool: next, lineage } = nextOpponentPool(ctx, {
    pool,
    fitness,
    targetSize: 10,
    weights,
    curated,
    curatedRatio: 0.4,
    movesetPool,
    seed: 'immi-next',
    opts: NEVER,
  });
  assert.equal(next.length, 10);
  assert.equal(origins(next).immigrant ?? 0, lineage.died.length);
  assert.equal(origins(next).mutant ?? 0, 0);
});

test('a culled team cannot be re-created the same generation (graceful shortfall)', () => {
  // Only 3 species in the pool, so there are exactly 6 distinct teams (three
  // species x which one leads -- the id is positional) and the pool below
  // already holds every one of them. The cull frees a slot that nothing legal
  // can fill, which must fall short rather than resurrect the team just
  // culled or loop forever.
  const tinyPool = movesetPool.slice(0, 3);
  const tinyWeights = new Map(tinyPool.map((e) => [e.speciesId, 1]));
  const built = tinyPool.map((e) => buildMetaMon(ctx, e));
  const permutations = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2],
    [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ];
  const pool = permutations.map((order) => {
    const members = order.map((i) => built[i]);
    return {
      id: `sampled-${members.map((m) => m.speciesId).join('-')}`,
      name: members.map((m) => m.speciesId).join(' / '),
      members,
      leadIndex: 0,
      origin: 'sampled',
      label: 'sampled',
    };
  });
  assert.equal(new Set(pool.map((e) => e.id)).size, 6, 'all six distinct teams are in the pool');

  const { pool: next, lineage } = nextOpponentPool(ctx, {
    pool,
    fitness: pool.map((_, i) => i),
    targetSize: 6,
    weights: tinyWeights,
    curated: [],
    curatedRatio: 0,
    movesetPool: tinyPool,
    seed: 'shortfall',
    opts: { ...NEVER, deathRate: 0.17, immigrantFraction: 0 },
  });
  assert.deepEqual(lineage.died, [0], 'the worst-fitness entry');
  assert.equal(next.length, 5, 'falls short of targetSize rather than resurrecting the culled team');
  assert.ok(!next.some((e) => e.id === pool[0].id));
});

test('serialize -> rehydrate round-trips a pool, re-resolving curated from the live pool', () => {
  const pool = newPool(8, 'roundtrip');
  const back = rehydrateOpponentPool(ctx, serializeOpponentPool(pool), curated);
  assert.deepEqual(
    back.map((e) => ({ id: e.id, origin: e.origin, lead: e.leadIndex, species: e.members.map((m) => m.speciesId) })),
    pool.map((e) => ({ id: e.id, origin: e.origin, lead: e.leadIndex, species: e.members.map((m) => m.speciesId) }))
  );
  for (const e of back) {
    for (const m of e.members) {
      assert.ok(m.pokemon.fastMove?.moveId, `${m.speciesId} rebuilt battle-ready`);
      assert.ok(m.pokemon.chargedMoves.length >= 1);
    }
  }
  const curatedBack = back.filter(isProtectedOpponent);
  assert.ok(curatedBack.length > 0);
  assert.ok(
    curatedBack.every((e) => e.members === curated.find((t) => t.id === e.curatedId).members),
    'a curated entry is re-resolved from the live curated pool, not round-tripped'
  );
});

test('a curated team that vanished from the source file is rebuilt with a warning, not dropped', () => {
  const pool = newPool(8, 'vanished');
  const serialized = serializeOpponentPool(pool);
  const survivingCurated = curated.filter((t) => t.id !== serialized.find((e) => e.origin === 'curated').curatedId);
  const logs = [];
  const back = rehydrateOpponentPool(ctx, serialized, survivingCurated, (m) => logs.push(m));
  assert.equal(back.length, pool.length, 'the pool did not silently shrink');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /no longer in the curated pool/);
  const rebuilt = back.find((e) => e.id === logs[0].match(/"([^"]+)"/)[1]);
  assert.equal(rebuilt.origin, 'curated');
  assert.ok(rebuilt.members.every((m) => m.pokemon.fastMove?.moveId));
});

test('the same seed and inputs produce the same next pool', () => {
  const pool = newPool(10, 'determinism', 0.4);
  const fitness = pool.map((_, i) => i);
  const params = {
    pool,
    fitness,
    targetSize: 12,
    weights,
    curated,
    curatedRatio: 0.4,
    movesetPool,
    seed: 'determinism-next',
  };
  const a = nextOpponentPool(ctx, params);
  const b = nextOpponentPool(ctx, params);
  assert.deepEqual(a.pool.map((e) => e.id), b.pool.map((e) => e.id));
  assert.deepEqual(a.lineage.died, b.lineage.died);
  const c = nextOpponentPool(ctx, { ...params, seed: 'determinism-other' });
  assert.notDeepEqual(a.pool.map((e) => e.id), c.pool.map((e) => e.id));
});
