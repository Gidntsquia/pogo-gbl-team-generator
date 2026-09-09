// Tests for src/meta/archetypes.js -- pure grouping/weighting over an
// already-battled opponent pool, no engine calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { archetypeGroups, archetypeWeights, coreRivalryFitness, memberSimilarity, opponentProfiles, DEFAULT_ARCHETYPE_BETA } from '../src/meta/archetypes.js';

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

test('grouping is by dominant core pair, not transitive: a chain A/B/C, B/C/D, C/D/E, D/E/F does not collapse into one group', () => {
  const opponents = [opp('a', 'b', 'c'), opp('b', 'c', 'd'), opp('c', 'd', 'e'), opp('d', 'e', 'f')];
  const groups = archetypeGroups(opponents);
  // b|c and c|d and d|e each appear twice; every opponent joins its most
  // common pair (ties by key), so [0] and [1] share b|c, [2] takes c|d,
  // [3] takes d|e. Union-find would have merged all four.
  assert.equal(groups[0], groups[1]);
  assert.equal(new Set(groups).size, 3);
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

test('coreRivalryFitness: each better team sharing a core pair costs rivalry x range; the best variant and unrelated teams pay nothing', () => {
  const ids = [['a', 'b', 'c'], ['a', 'b', 'd'], ['a', 'b', 'e'], ['x', 'y', 'z']];
  const fitness = [0.6, 0.5, 0.4, 0.2]; // range 0.4
  const { shared, rivalsAbove } = coreRivalryFitness(ids, fitness, 0.1);
  assert.deepEqual(rivalsAbove, [0, 1, 2, 0]);
  assert.ok(Math.abs(shared[0] - 0.6) < 1e-12);
  assert.ok(Math.abs(shared[1] - (0.5 - 0.04)) < 1e-12);
  assert.ok(Math.abs(shared[2] - (0.4 - 0.08)) < 1e-12);
  assert.ok(Math.abs(shared[3] - 0.2) < 1e-12);
  assert.deepEqual(coreRivalryFitness(ids, fitness, 0).shared, fitness, 'rivalry 0 is a no-op');
});

// Fake pvpoke Pokemon: only needs to be distinguishable by the fake `similarity` callback below.
const pk = (id) => ({ id });
const tink = { baseId: 'tinkaton', pokemon: pk('tinkaton') };
const gatr = { baseId: 'feraligatr', pokemon: pk('feraligatr') };
const empo = { baseId: 'empoleon', pokemon: pk('empoleon') };
const copper = { baseId: 'copperajah', pokemon: pk('copperajah') };
const sab = { baseId: 'sableye', pokemon: pk('sableye') };
const clod = { baseId: 'clodsire', pokemon: pk('clodsire') };

// Fake pvpoke similarity score (pre-floor/scale), symmetric, keyed by unordered id pair.
const SCORES = {
  'empoleon|feraligatr': 0.7,
  'copperajah|tinkaton': 0.7,
  'copperajah|empoleon': 0.35, // at the floor -- counts as unrelated
};
function fakeSimilarity(a, b) {
  const key = [a.id, b.id].sort().join('|');
  return SCORES[key] ?? 0;
}

test('memberSimilarity: same species 1, else floored/scaled similarity() score, else 0', () => {
  assert.equal(memberSimilarity(gatr, { ...gatr }, { similar: 0.5, floor: 0.35, similarity: fakeSimilarity }), 1);
  // (0.7 - 0.35) / (1 - 0.35) = 0.538..., x similar 0.5
  assert.ok(Math.abs(memberSimilarity(gatr, empo, { similar: 0.5, floor: 0.35, similarity: fakeSimilarity }) - 0.5 * ((0.7 - 0.35) / 0.65)) < 1e-12);
  assert.equal(memberSimilarity(copper, empo, { similar: 0.5, floor: 0.35, similarity: fakeSimilarity }), 0, 'at or below floor = 0');
  assert.equal(memberSimilarity(gatr, sab, { similar: 0.5, floor: 0.35, similarity: fakeSimilarity }), 0, 'no score entry = 0');
  assert.equal(memberSimilarity(gatr, empo, { similar: 0, floor: 0.35, similarity: fakeSimilarity }), 0, 'similar 0 = exact species only');
  assert.equal(memberSimilarity(gatr, empo, { similar: 0.5, floor: 0.35 }), 0, 'no similarity callback = exact species only');
});

test('coreRivalryFitness: a similar core loads at the similarity weight, and a team is charged only for its most crowded core', () => {
  const teams = [
    [tink, gatr, sab], // 0: best
    [tink, empo, clod], // 1: tink/empo ~ tink/gatr (0.5)
    [tink, gatr, clod], // 2: tink/gatr identical to 0 (1) + ~ 1's tink/empo (0.5)
    [copper, empo, clod], // 3: see the per-core loads below
    [sab, clod, copper], // 4
  ];
  const opts = { similar: 0.5, floor: 0, similarity: (a, b) => (a.id === b.id ? 1 : SCORES[[a.id, b.id].sort().join('|')] === 0.7 ? 1 : 0) };
  const fitness = [1, 0.9, 0.8, 0.7, 0.6]; // range 0.4, step 0.04
  const { shared, rivalsAbove } = coreRivalryFitness(teams, fitness, 0.1, opts);
  assert.equal(rivalsAbove[0], 0);
  assert.equal(rivalsAbove[1], 0.5);
  assert.equal(rivalsAbove[2], 1.5);
  // team 3, per core, summed over the better teams 0/1/2:
  //   copper/empo: 0.25 + 0.5 + 0.25 = 1.0
  //   empo/clod:   0 + 1 + 0.5 = 1.5
  //   copper/clod: 0 + 0.5 + 0.5 = 1.0
  assert.ok(Math.abs(rivalsAbove[3] - 1.5) < 1e-12, 'max over cores, not their sum (3.5)');
  assert.ok(Math.abs(shared[3] - (0.7 - 0.04 * 1.5)) < 1e-12);
  const exact = coreRivalryFitness(teams, fitness, 0.1, { similar: 0 });
  assert.deepEqual(exact.rivalsAbove, [0, 0, 1, 1, 1], 'similar 0 counts identical cores only');
});

test('opponentProfiles dedupes shadow twins by base id and carries the built Pokemon only when it can score similarity', () => {
  const withSim = { speciesId: 'feraligatr', calculateSimilarity: () => 0 };
  const noSim = { speciesId: 'feraligatr_shadow' };
  const other = { speciesId: 'tinkaton', calculateSimilarity: () => 0 };
  const o = { members: [withSim, noSim, other] };
  const profiles = opponentProfiles(o);
  assert.deepEqual(profiles.map((p) => p.baseId), ['feraligatr', 'tinkaton']);
  assert.equal(profiles[0].pokemon, withSim, 'first feraligatr entry wins the dedupe');
  assert.equal(profiles[1].pokemon, other);
});
