// Tests for src/meta/archetypes.js -- pure grouping/weighting over an
// already-battled opponent pool, no engine calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { archetypeGroups, archetypeWeights, DEFAULT_ARCHETYPE_BETA } from '../src/meta/archetypes.js';

function opp(...speciesIds) {
  return { members: speciesIds.map((speciesId) => ({ speciesId })) };
}

test('teams sharing >=2 base species group together; shadow/non-shadow count as the same base', () => {
  const opponents = [
    opp('a', 'b', 'c'),
    opp('a', 'b', 'd'), // shares a,b with [0] -> same group
    opp('a_shadow', 'b', 'e'), // shadow a + b still shares 2 with [0] -> same group
    opp('x', 'y', 'z'), // unrelated -> its own group
  ];
  const groups = archetypeGroups(opponents);
  assert.equal(groups[0], groups[1]);
  assert.equal(groups[0], groups[2]);
  assert.notEqual(groups[0], groups[3]);
});

test('a team sharing only ONE species with each of two otherwise-distinct teams does not bridge them', () => {
  const opponents = [
    opp('a', 'p', 'q'), // shares only 'a' with [1], only... nothing with [2]
    opp('a', 'r', 's'),
    opp('t', 'u', 'v'),
  ];
  const groups = archetypeGroups(opponents);
  // No pair shares >=2, so every opponent is its own group.
  assert.equal(new Set(groups).size, 3);
});

test('a team sharing two species with one of two candidates joins only that one', () => {
  const opponents = [
    opp('a', 'b', 'c'),
    opp('a', 'b', 'd'), // shares a,b with [0]
    opp('a', 'x', 'y'), // shares only 'a' with [0]
  ];
  const groups = archetypeGroups(opponents);
  assert.equal(groups[0], groups[1]);
  assert.notEqual(groups[0], groups[2]);
});

test('archetypeWeights: a group of size s has total weight s^(1-beta) (beta 0/1/0.5)', () => {
  for (const beta of [0, 1, 0.5]) {
    const groups = [0, 0, 0, 0, 1, 1, 2]; // sizes 4, 2, 1
    const weights = archetypeWeights(groups, { beta });
    const totalByGroup = new Map();
    groups.forEach((g, i) => totalByGroup.set(g, (totalByGroup.get(g) ?? 0) + weights[i]));
    for (const [g, total] of totalByGroup) {
      const size = groups.filter((x) => x === g).length;
      const expected = Math.pow(size, 1 - beta);
      assert.ok(Math.abs(total - expected) < 1e-9, `group ${g} size ${size} beta ${beta}: expected ${expected}, got ${total}`);
    }
  }
});

test('default beta is 0.5', () => {
  assert.equal(DEFAULT_ARCHETYPE_BETA, 0.5);
});
