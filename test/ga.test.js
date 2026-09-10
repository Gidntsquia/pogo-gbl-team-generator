// Tests for src/ga/core.js -- the GA scaffolding shared by the candidate
// (src/teams/evolve.js) and opponent (src/meta/opponentPool.js) GAs. Pure
// functions over hand-built inputs, no engine boot, no battles.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { crowdingWeights, trailingFitnessGeneric } from '../src/ga/core.js';

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
