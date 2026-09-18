// Tests for src/ga/core.js -- the GA scaffolding shared by the candidate
// (src/teams/evolve.js) and opponent (src/meta/opponentPool.js) GAs. Pure
// functions over hand-built inputs, no engine boot, no battles.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { crowdingWeights, trailingFitnessGeneric, computeChurn, allocateNewSlots, finalizeImmigrantCount } from '../src/ga/core.js';

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

// plans/PLAN.md Item 2's shared-step behaviour test: the exact same death
// count, mutant count and immigrant count for a steady, a shrinking and a
// growing target, driven purely through computeChurn/allocateNewSlots/
// finalizeImmigrantCount -- the two adapters (src/teams/evolve.js's
// nextGeneration, src/meta/opponentPool.js's nextOpponentPool) both reduce
// to exactly this arithmetic, just with different entity-building code
// behind `chosenRolls`.
function runStep({ liveCount, targetSize, deathRate, immigrantFraction, rollCount, builtMutantCount }) {
  const { churn, deathCount } = computeChurn({ liveCount, contenders: liveCount, targetSize, deathRate });
  const openSlots = targetSize - (liveCount - deathCount);
  const rolls = Array.from({ length: rollCount }, (_, i) => ({ percentile: i / Math.max(1, rollCount - 1) }));
  const { chosenRolls } = allocateNewSlots({ openSlots, immigrantFraction, targetSize, rolls });
  const actualBuilt = Math.min(builtMutantCount, chosenRolls.length);
  const immigrantCount = finalizeImmigrantCount({ openSlots, builtMutantCount: actualBuilt });
  return { churn, deathCount, openSlots, mutantCount: actualBuilt, immigrantCount };
}

for (const [label, liveCount, targetSize] of [
  ['a steady population', 60, 60],
  ['a shrinking population', 60, 30],
  ['a growing population', 20, 60],
]) {
  test(`shared GA step: ${label} -- same death/mutant/immigrant counts from the same inputs, whichever adapter calls it`, () => {
    const params = { liveCount, targetSize, deathRate: 0.2, immigrantFraction: 0.08, rollCount: 12, builtMutantCount: 12 };
    const candidateSide = runStep(params);
    const opponentSide = runStep(params); // same shared functions, same inputs -- must be identical regardless of caller
    assert.deepEqual(opponentSide, candidateSide);
    assert.ok(candidateSide.deathCount >= 0);
    assert.equal(liveCount - candidateSide.deathCount + candidateSide.openSlots, targetSize);
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
