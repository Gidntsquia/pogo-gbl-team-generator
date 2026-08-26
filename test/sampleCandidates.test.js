// Tests for src/teams/sample.js -- the weighted candidate-team sampler.
// Pure list generation over a fake matrix/pool/weights (no
// engine, no vendor data, no battles) -- verifies: determinism under a fixed
// seed, team uniqueness, no-duplicate-species-per-team (including when the
// pool defensively needs deduping), excludeSpecies, count/cap behavior when
// the pool is too small, and monotonicity (a clearly higher-weight mon
// appears on more sampled teams than a clearly lower-weight one).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sampleCandidateTeams } from '../src/teams/sample.js';

/** A fake mon entry: uniform ratings so computeWeightedScore == score exactly. */
function mon(key, speciesId, score) {
  return {
    key,
    builtMon: { speciesId, name: speciesId },
    ratings: { somemeta: { s00: score, s11: score, s22: score } },
  };
}

/** Build a fake scoreCollection-shaped matrix from a list of mon() entries. */
function fakeMatrix(mons) {
  const ratings = {};
  const builtMons = {};
  for (const m of mons) {
    ratings[m.key] = m.ratings;
    builtMons[m.key] = m.builtMon;
  }
  return { ratings, builtMons };
}

function poolKeys(mons) {
  return mons.map((m) => m.key);
}

// 10 distinct species, scores spread out; used by most tests.
const TEN_MONS = [
  mon('a', 'azumarill', 900),
  mon('b', 'registeel', 850),
  mon('c', 'altaria', 800),
  mon('d', 'medicham', 750),
  mon('e', 'stunfisk', 700),
  mon('f', 'lanturn', 650),
  mon('g', 'skarmory', 600),
  mon('h', 'talonflame', 550),
  mon('i', 'sableye', 500),
  mon('j', 'wigglytuff', 450),
];

test('is deterministic across repeated calls under the same seed', () => {
  const matrix = fakeMatrix(TEN_MONS);
  const pool = poolKeys(TEN_MONS);
  const a = sampleCandidateTeams({ matrix, pool, count: 8, seed: 'repeat-me' });
  const b = sampleCandidateTeams({ matrix, pool, count: 8, seed: 'repeat-me' });
  assert.deepEqual(a, b);
});

test('a different seed produces a different sampled composition', () => {
  const matrix = fakeMatrix(TEN_MONS);
  const pool = poolKeys(TEN_MONS);
  const a = sampleCandidateTeams({ matrix, pool, count: 8, seed: 'seed-a' });
  const b = sampleCandidateTeams({ matrix, pool, count: 8, seed: 'seed-b' });
  assert.notDeepEqual(a, b);
});

test('every returned team has 3 distinct keys and is unique across the batch', () => {
  const matrix = fakeMatrix(TEN_MONS);
  const pool = poolKeys(TEN_MONS);
  const teams = sampleCandidateTeams({ matrix, pool, count: 15, seed: 'uniqueness' });
  assert.ok(teams.length > 0);

  const seen = new Set();
  for (const team of teams) {
    assert.equal(team.length, 3);
    assert.equal(new Set(team).size, 3, 'no duplicate key within a team');
    const signature = [...team].sort().join('|');
    assert.ok(!seen.has(signature), `team ${signature} should not repeat`);
    seen.add(signature);
  }
});

test('no duplicate species within a team, even when the pool has duplicate species', () => {
  // Two keys share "azumarill" (defensive dedupe should collapse to the
  // higher-scoring one before sampling), so no team can ever contain both.
  const mons = [
    mon('a1', 'azumarill', 900),
    mon('a2', 'azumarill', 400), // weaker duplicate -- should lose the dedupe
    mon('b', 'registeel', 850),
    mon('c', 'altaria', 800),
    mon('d', 'medicham', 750),
  ];
  const matrix = fakeMatrix(mons);
  const pool = poolKeys(mons);
  const teams = sampleCandidateTeams({ matrix, pool, count: 20, seed: 'dedupe-check' });

  for (const team of teams) {
    assert.ok(!team.includes('a2'), 'the weaker duplicate should never be sampled');
    const species = team.map((key) => matrix.builtMons[key].speciesId);
    assert.equal(new Set(species).size, 3, `team ${team} should have 3 distinct species`);
  }
  // With only 4 distinct species (a1/b/c/d) after dedupe, C(4,3) = 4 max unique teams.
  assert.ok(teams.length <= 4, `expected at most C(4,3)=4 unique teams, got ${teams.length}`);
});

test('excludeSpecies drops a species from the sampled pool entirely', () => {
  const matrix = fakeMatrix(TEN_MONS);
  const pool = poolKeys(TEN_MONS);
  const teams = sampleCandidateTeams({
    matrix,
    pool,
    count: 15,
    seed: 'exclude-check',
    excludeSpecies: ['azumarill', 'registeel'],
  });
  assert.ok(teams.length > 0);
  for (const team of teams) {
    const species = team.map((key) => matrix.builtMons[key].speciesId);
    assert.ok(!species.includes('azumarill'));
    assert.ok(!species.includes('registeel'));
  }
});

test('gracefully caps at C(pool,3) when count exceeds the number of possible distinct teams', () => {
  // Only 4 distinct species -> C(4,3) = 4 possible unique teams, however
  // large `count` is requested.
  const mons = TEN_MONS.slice(0, 4);
  const matrix = fakeMatrix(mons);
  const pool = poolKeys(mons);
  const teams = sampleCandidateTeams({ matrix, pool, count: 500, seed: 'cap-check' });
  assert.equal(teams.length, 4, 'capped at C(4,3), not the requested 500');

  const signatures = new Set(teams.map((t) => [...t].sort().join('|')));
  assert.equal(signatures.size, 4, 'all 4 possible unique teams were found, none repeated');
});

test('a pool smaller than 3 species returns no teams rather than throwing', () => {
  const mons = TEN_MONS.slice(0, 2);
  const matrix = fakeMatrix(mons);
  const pool = poolKeys(mons);
  const teams = sampleCandidateTeams({ matrix, pool, count: 5, seed: 'tiny-pool' });
  assert.deepEqual(teams, []);
});

test('a species missing from `weights` is treated as usage weight 0, not a crash', () => {
  const matrix = fakeMatrix(TEN_MONS);
  const pool = poolKeys(TEN_MONS);
  const weights = new Map([['azumarill', 0.9]]); // every other species is absent
  const teams = sampleCandidateTeams({ matrix, pool, weights, count: 10, seed: 'sparse-weights' });
  assert.ok(teams.length > 0);
});

test('an entirely omitted `weights` degrades to pure 1v1-score sampling without crashing', () => {
  const matrix = fakeMatrix(TEN_MONS);
  const pool = poolKeys(TEN_MONS);
  const teams = sampleCandidateTeams({ matrix, pool, count: 10, seed: 'no-weights' });
  assert.ok(teams.length > 0);
});

test('a clearly higher-blended-weight mon appears on more sampled teams than a clearly lower one', () => {
  // 30 species: "star" scores highest AND has the highest usage weight;
  // "dud" scores lowest AND has the lowest usage weight; 28 filler mons in
  // between so the pool is wide enough for a meaningful large sample.
  const mons = [mon('star', 'clodsire', 950), mon('dud', 'delibird', 50)];
  const weights = new Map([
    ['clodsire', 0.95],
    ['delibird', 0.01],
  ]);
  for (let i = 0; i < 28; i++) {
    const speciesId = `filler${i}`;
    mons.push(mon(`filler${i}`, speciesId, 500));
    weights.set(speciesId, 0.3);
  }
  const matrix = fakeMatrix(mons);
  const pool = poolKeys(mons);

  const teams = sampleCandidateTeams({ matrix, pool, weights, count: 300, seed: 'monotonic' });
  assert.ok(teams.length > 0);

  let starCount = 0;
  let dudCount = 0;
  for (const team of teams) {
    if (team.includes('star')) starCount++;
    if (team.includes('dud')) dudCount++;
  }
  assert.ok(dudCount > 0, 'sanity: the low-weight mon should still appear sometimes');
  assert.ok(
    starCount > dudCount * 2,
    `expected the high-weight mon to appear meaningfully more often (star=${starCount}, dud=${dudCount})`
  );
});
