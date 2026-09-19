// Tests for src/teams/rankedPool.js and usage.js's rank-only helpers: the
// candidate pool is chosen by pvpoke rank alone (no 1v1 scoring).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadUsageWeights, lastPlaceWeight } from '../src/meta/usage.js';
import { dedupeByRank, buildRankedPool } from '../src/teams/rankedPool.js';
import { sampleCandidateTeams, makeRankWeightFn } from '../src/teams/sample.js';

// Ranked field: a (1) > b (2) > c (3) > d_shadow (4). "zz" is not ranked.
const RANKED = ['a', 'b', 'c', 'd_shadow'];
const weights = loadUsageWeights({ vendorRoot: '' }, {
  ignoreSnapshot: true,
  rankingsEntries: RANKED.map((speciesId, i) => ({ speciesId, score: 90 - i })),
  groupEntries: [],
  trainingSpeciesIds: [],
});

const built = (speciesId, extra = {}) => ({
  speciesId, spec: { shadow: !!extra.shadow }, pokemon: { stats: extra.stats ?? { atk: 1, def: 1, hp: 1 } }, lineageKey: extra.lineageKey,
});

test('an unranked build weighs exactly rank N+1: 1/(N+1+20), same scale as the ranked weights', () => {
  const n = RANKED.length;
  const w1 = weights.get('a');
  const expected = w1 * (1 + 20) / (n + 1 + 20);
  assert.ok(Math.abs(lastPlaceWeight(weights) - expected) < 1e-12);
  assert.ok(lastPlaceWeight(weights) < weights.get('d_shadow'));
});

test('dedupeByRank: best-ranked form per lineage, then best stat product per build, then key', () => {
  const out = dedupeByRank({
    x1: built('c', { lineageKey: 'row1' }),
    x2: built('a', { lineageKey: 'row1' }), // evolution of the same row, better ranked -> wins the lineage
    y1: built('b', { stats: { atk: 1, def: 1, hp: 1 } }),
    y2: built('b', { stats: { atk: 2, def: 2, hp: 2 } }), // same build, higher stat product
    s1: built('d', { shadow: true }),
    s2: built('d'), // plain d is unranked; separate build from the shadow
  }, weights);
  assert.deepEqual(Object.keys(out).sort(), ['s1', 's2', 'x2', 'y2']);
});

test('buildRankedPool caps at N best-ranked species, unranked last, exclusions dropped', () => {
  const bm = { k1: built('a'), k2: built('b'), k3: built('c'), kz: built('zz') };
  assert.deepEqual(buildRankedPool(bm, weights, 2), ['k1', 'k2']);
  assert.deepEqual(buildRankedPool(bm, weights, 0), ['k1', 'k2', 'k3', 'kz']);
  assert.deepEqual(buildRankedPool(bm, weights, 0, ['a']), ['k2', 'k3', 'kz']);
});

test('the sampling weight of an unranked build is exactly last place; ranked builds read their own rank', () => {
  const wf = makeRankWeightFn(weights);
  assert.equal(wf({ usageId: 'zz' }), lastPlaceWeight(weights));
  assert.equal(wf({ usageId: 'b' }), weights.get('b'));
  assert.equal(wf({ usageId: 'd_shadow' }), weights.get('d_shadow'));
  assert.ok(wf({ usageId: 'a' }) > wf({ usageId: 'zz' }));
});

test('a real-collection draw favours better-ranked builds', () => {
  const ids = Array.from({ length: 60 }, (_, i) => `s${i}`);
  const w = loadUsageWeights({ vendorRoot: '' }, {
    ignoreSnapshot: true,
    rankingsEntries: ids.map((speciesId, i) => ({ speciesId, score: 100 - i })),
    groupEntries: [],
    trainingSpeciesIds: [],
  });
  const bm = Object.fromEntries(ids.map((id) => [id, built(id)]));
  const teams = sampleCandidateTeams({ matrix: { builtMons: bm }, pool: ids, weights: w, count: 300, seed: 'rank' });
  const share = (lo, hi) => teams.flat().filter((k) => +k.slice(1) >= lo && +k.slice(1) < hi).length;
  assert.ok(share(0, 10) > 2 * share(50, 60));
});
