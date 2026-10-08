// Tests for src/evolve/analytics.js: per-generation checkpoint analytics on fake inputs (no battles).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGenerationAnalytics } from '../src/evolve/analytics.js';

test('topTeams holds the top 15; topCores still counts only the top 10 teams', () => {
  const builtMons = {};
  const population = Array.from({ length: 20 }, (_, i) => {
    const keys = [`a${i}`, `b${i}`, `c${i}`];
    keys.forEach((k, j) => { builtMons[k] = { speciesId: `s${i}_${j}`, speciesName: k }; });
    return keys;
  });
  const fitness = population.map((_, i) => 1 - i / 100);
  const a = computeGenerationAnalytics({ matrix: { builtMons }, population, fitness, lineage: null, results: [] });
  assert.equal(a.topTeams.length, 15);
  assert.deepEqual(a.topTeams.map((t) => t.rank).slice(0, 2), [1, 2]);
  assert.ok(a.topCores.length > 0);
  assert.ok(!/s1\d_/.test(JSON.stringify(a.topCores)), 'teams ranked 11+ never feed topCores');
});
