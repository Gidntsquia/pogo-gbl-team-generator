// src/evolve/cache.js: the --battle-cache-file save/load round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBattleCache, loadBattleCacheFile, saveBattleCacheFile } from '../src/evolve/cache.js';

const mon = (speciesId, atk) => ({ speciesId, ivs: { atk, def: 15, hp: 15 }, shadow: false, bestBuddy: false });
const result = (winner) => ({ winner, survivorsHp: { a: 1, b: 0, aPerMon: [1, 0, 0], bPerMon: [0, 0, 0] }, summary: { leadFaintTurnA: 3, leadFaintTurnB: 2, extra: 'dropped' } });

test('a saved cache reloads under the same keys, counts file hits, and refuses another league', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'battle-cache-'));
  try {
    const file = path.join(dir, 'cache.json');
    const A = [mon('azumarill', 0), mon('skarmory', 1), mon('lanturn', 2)];
    const B = [mon('medicham', 3), mon('registeel', 4), mon('swampert', 5)];
    const first = createBattleCache(100);
    first.keyFor(B, 1, A, 0, 1); // intern B first so saved ids are not trivially 0/1
    first.set(first.keyFor(A, 0, B, 1, 1), result('a'));
    saveBattleCacheFile(first, file, 'cp1500|all');

    const second = createBattleCache(100);
    assert.deepEqual(loadBattleCacheFile(second, file, 'cp1500|all'), { loaded: 1, reason: null });
    const hit = second.get(second.keyFor(A, 0, B, 1, 1));
    assert.equal(hit.winner, 'a');
    assert.equal(hit.summary.extra, undefined);
    assert.equal(second.get(second.keyFor(A, 1, B, 1, 1)), undefined);
    assert.equal(second.stats().diskHits, 1);

    const other = createBattleCache(100);
    assert.equal(loadBattleCacheFile(other, file, 'cp2500|all').loaded, 0);
    assert.equal(loadBattleCacheFile(createBattleCache(100), path.join(dir, 'missing.json'), 'cp1500|all').reason, 'no file yet');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
