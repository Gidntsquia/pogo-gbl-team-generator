import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoundedCache } from '../src/engine/boundedCache.js';

test('BoundedCache evicts the least-recently-used entry once over capacity', () => {
  const cache = new BoundedCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3); // evicts 'a' (oldest, never re-gotten)
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), 3);
  assert.equal(cache.size, 2);
});

test('get() promotes an entry to most-recently-used, protecting it from eviction', () => {
  const cache = new BoundedCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a'); // 'a' is now MRU; 'b' is now LRU
  cache.set('c', 3); // evicts 'b', not 'a'
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('c'), 3);
});
