// Tests for src/ga/core.js -- the GA scaffolding shared by the candidate
// (src/teams/evolve.js) and opponent (src/meta/opponentPool.js) GAs. Pure
// functions over hand-built inputs, no engine boot, no battles.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { crowdingWeights, trailingFitnessGeneric, computeChurn, evolveStep } from '../src/ga/core.js';
import { rngFromSeed } from '../src/util/rng.js';

test('crowdingWeights: a crowded shared-core entry weighs less than a singleton-core entry, both candidate- and opponent-shaped', () => {
  const entries = [
    { id: 'a', species: ['majority', 'x', 'y'] },
    { id: 'b', species: ['majority', 'x', 'z'] },
    { id: 'c', species: ['majority', 'x', 'w'] },
    { id: 'd', species: ['rare', 'p', 'q'] },
  ];
  const weights = crowdingWeights(entries, (e) => e.species.map((speciesId) => ({ speciesId })));
  assert.equal(weights.length, 4);
  assert.ok(Math.abs(weights[0] - weights[1]) < 1e-9);
  assert.ok(Math.abs(weights[1] - weights[2]) < 1e-9);
  assert.ok(weights[3] > weights[0]);
});

test('crowdingWeights: beta 0 flattens every entry to equal weight regardless of crowding', () => {
  const entries = [
    { species: ['a', 'b', 'c'] },
    { species: ['a', 'b', 'd'] },
    { species: ['e', 'f', 'g'] },
  ];
  const weights = crowdingWeights(entries, (e) => e.species.map((speciesId) => ({ speciesId })), { beta: 0 });
  for (const w of weights) assert.ok(Math.abs(w - 1) < 1e-9);
});

test('trailingFitnessGeneric: recency-weighted mean by an arbitrary signature (opponent-shaped ids), matches trailing:1 to the raw draw', () => {
  const history = [
    { population: [{ id: 'x' }, { id: 'y' }], fitness: [0.4, 0.6] },
    { population: [{ id: 'x' }, { id: 'y' }], fitness: [0.6, 0.4] },
  ];
  const raw = trailingFitnessGeneric(history, (e) => e.id, 1, 0.6);
  assert.deepEqual(raw, [0.6, 0.4]);

  const smoothed = trailingFitnessGeneric(history, (e) => e.id, 2, 0.6);
  // x: (0.6*1 + 0.4*0.6) / (1 + 0.6); y: (0.4*1 + 0.6*0.6) / (1 + 0.6)
  assert.ok(Math.abs(smoothed[0] - (0.6 + 0.4 * 0.6) / 1.6) < 1e-9);
  assert.ok(Math.abs(smoothed[1] - (0.4 + 0.6 * 0.6) / 1.6) < 1e-9);
});

test('trailingFitnessGeneric: an entry seen only in the newest generation is scored on that one sample', () => {
  const history = [
    { population: [{ id: 'x' }], fitness: [0.3] },
    { population: [{ id: 'x' }, { id: 'newcomer' }], fitness: [0.5, 0.9] },
  ];
  const scores = trailingFitnessGeneric(history, (e) => e.id, 3, 0.6);
  assert.equal(scores[1], 0.9);
});

// plans/PLAN.md Item 2's shared-step behaviour test: evolveStep driven through
// two differently-shaped adapters (a candidate-like team = array of key
// strings; an opponent-like entry = {members:[{speciesId}]}) with the same
// fitness vector, rates and seed must kill, mutate and immigrate the same
// number of teams for a steady, a shrinking and a growing target.
const SPECIES = Array.from({ length: 40 }, (_, i) => `mon${i}`);
function fakeAdapter(shape) {
  const wrap = (ids) => (shape === 'keys' ? ids : { members: ids.map((speciesId) => ({ speciesId })) });
  const idsOf = (e) => (shape === 'keys' ? e : e.members.map((m) => m.speciesId));
  const randomTrio = (rng) => {
    const picked = [];
    while (picked.length < 3) {
      const id = SPECIES[Math.floor(rng() * SPECIES.length)];
      if (!picked.includes(id)) picked.push(id);
    }
    return picked;
  };
  return {
    wrap,
    profilesOf: idsOf,
    signatureOf: (e) => `${idsOf(e)[0]}||${idsOf(e).slice(1).sort().join('|')}`,
    buildMutant(parent, type, accept, rng, maxAttempts) {
      if (type === 'shadowFlip') return null; // no twins -> core must fall through to a memberSwap
      for (let a = 0; a < maxAttempts; a++) {
        const ids = idsOf(parent).slice();
        if (type === 'leadRotation') [ids[0], ids[1]] = [ids[1], ids[0]];
        else ids[Math.floor(rng() * 3)] = SPECIES[Math.floor(rng() * SPECIES.length)];
        if (new Set(ids).size < 3) continue;
        const entry = wrap(ids);
        if (accept(entry)) return { entry };
      }
      return null;
    },
    *immigrants(budget, rng) {
      for (let i = 0; i < budget; i++) yield wrap(randomTrio(rng));
    },
  };
}

function runStep(shape, liveCount, targetSize) {
  const adapter = fakeAdapter(shape);
  const seedRng = rngFromSeed('ga-step-teams');
  const entries = [];
  const seen = new Set();
  while (entries.length < liveCount) {
    const e = adapter.immigrants(1, seedRng).next().value;
    if (seen.has(adapter.signatureOf(e))) continue;
    seen.add(adapter.signatureOf(e));
    entries.push(e);
  }
  const out = evolveStep({
    entries,
    fitness: entries.map((_, i) => ((i * 37) % 101) / 100),
    targetSize,
    rng: rngFromSeed('ga-step'),
    rates: { deathRate: 0.2, mutationFloor: 0.05, mutationCeil: 0.4, leadRotationRate: 0.2, shadowFlipRate: 0.2, immigrantFraction: 0.08 },
    rivalry: { coreRivalry: 0, similar: 0, floor: 0, similarity: null },
    adapter,
  });
  return {
    died: out.died,
    survivors: out.survivorIdx,
    mutantTypes: out.mutants.map((m) => `${m.parentIndex}:${m.type}`),
    immigrants: out.immigrants.length,
    size: out.survivorIdx.length + out.mutants.length + out.immigrants.length,
  };
}

for (const [label, liveCount, targetSize] of [
  ['a steady population', 60, 60],
  ['a shrinking population', 60, 30],
  ['a growing population', 20, 60],
]) {
  test(`shared GA step: ${label} -- both adapters get the same deaths, mutants and immigrants`, () => {
    const candidateSide = runStep('keys', liveCount, targetSize);
    const opponentSide = runStep('entries', liveCount, targetSize);
    assert.deepEqual(opponentSide, candidateSide);
    assert.equal(candidateSide.size, targetSize);
    assert.ok(candidateSide.died.length >= Math.round(0.2 * liveCount));
    assert.ok(!candidateSide.mutantTypes.some((t) => t.endsWith('shadowFlip')), 'unbuildable shadowFlip fell through to memberSwap');
  });
}

test('shared GA step: the cull still fires under a target far larger than the live count (the bug computeChurn fixes)', () => {
  // Regression for the failure mode documented on computeChurn: a naive
  // `targetSize - churn` survivorsWanted can exceed liveCount when the
  // target grows a lot, clamping deathCount to 0 no matter how stale the
  // population is. min(liveCount - churn, targetSize) does not.
  const { churn, deathCount } = computeChurn({ liveCount: 4, contenders: 4, targetSize: 10, deathRate: 0.15 });
  assert.equal(churn, 1);
  assert.equal(deathCount, 1, 'the cull must still remove the churn share even while growing a lot');
});
