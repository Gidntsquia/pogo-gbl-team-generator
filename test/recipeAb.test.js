import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdict, quality, wallTime, overlap, simDefs, simArgs } from '../scripts/recipe-ab-lib.mjs';

test('verdict: keep / worse / not distinguishable / not available', () => {
  const base = { quality: 0.6, wallMs: 1000 };
  assert.equal(verdict(base, { quality: 0.58, wallMs: 500 }).verdict, 'keep'); // -2 pts, faster
  assert.equal(verdict(base, { quality: 0.62, wallMs: 500 }).verdict, 'keep');
  assert.equal(verdict(base, { quality: 0.56, wallMs: 500 }).verdict, 'worse'); // -4 pts
  assert.equal(verdict(base, { quality: 0.6, wallMs: 1500 }).verdict, 'not distinguishable'); // slower
  assert.equal(verdict(base, null).verdict, 'not available');
  assert.equal(verdict({ quality: null, wallMs: 1 }, base).verdict, 'not available');
});

test('quality averages the top 5; wallTime excludes downtime', () => {
  assert.equal(quality([0.5, 0.5, 0.5, 0.5, 0.5, 0.0]), 0.5);
  const w = wallTime([{ elapsedMs: 10 }, { elapsedMs: 20 }], 5, [{ start: 0, end: 100 }, { start: 150, end: 300 }]);
  assert.deepEqual(w, { runningMs: 35, downtimeMs: 50 });
});

test('overlap marks shared teams, cores and species per pair', () => {
  const lists = { a: [['x#1', 'y#2', 'z#3']], b: [['x#9', 'z#8', 'y#7']], c: [['q#1', 'y#1', 'w#1']] };
  const o = overlap(lists);
  const ab = o.pairs.find((p) => p.a === 'a' && p.b === 'b');
  assert.equal(ab.teams, 1);
  assert.equal(ab.species, 3);
  assert.deepEqual(o.marks.a[0].teamIn, ['b']);
  assert.deepEqual(o.marks.c[0].teamIn, []);
});

test('sim definitions: sims 1 and 2 differ only in halving; sim 3 sizes per spec', () => {
  const [s1, s2, s3] = simDefs();
  assert.deepEqual({ ...s1, n: 0, name: '', halving: 0 }, { ...s2, n: 0, name: '', halving: 0 });
  assert.equal(s1.halving, 0);
  assert.equal(s2.halving, 3);
  assert.deepEqual([s3.population, s3.opponents, s3.k, s3.finalRatio], [200, 566, 400, 1]);
  assert.ok(!simArgs(s1).includes('--battle-cache-file') && !simArgs(s1).includes('--seed-from'));
});
