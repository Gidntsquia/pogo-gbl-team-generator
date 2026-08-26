// JavaScript Document
//
// Pure-function tests for src/engine/parallel.js -- thread-count resolution
// and the deterministic spec->worker chunking. No battles run here: the
// invariant that a threaded run is bit-identical to a serial one needs the
// real engine, so it lives in test/e2e.test.js, the suite's only simulation
// file, alongside the pipeline runs that exercise the same executor.
//
// Run with: node --test test/parallel.test.js

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {
  defaultThreadCount,
  resolveThreadCount,
  partitionContiguous,
  THREADS_ENV_VAR,
} from '../src/engine/parallel.js';

describe('thread-count resolution', () => {
  test('defaultThreadCount is max(1, cpus - 1)', () => {
    assert.equal(defaultThreadCount(), Math.max(1, os.cpus().length - 1));
  });

  test('resolveThreadCount prefers an explicit value over env and default', () => {
    assert.equal(resolveThreadCount(3, { [THREADS_ENV_VAR]: '7' }), 3);
  });

  test('resolveThreadCount falls back to the env var when no explicit value is given', () => {
    assert.equal(resolveThreadCount(undefined, { [THREADS_ENV_VAR]: '5' }), 5);
  });

  test('resolveThreadCount falls back to the default when neither is set', () => {
    assert.equal(resolveThreadCount(undefined, {}), defaultThreadCount());
  });

  test('a malformed env var degrades to the default instead of throwing', () => {
    assert.equal(resolveThreadCount(undefined, { [THREADS_ENV_VAR]: 'not-a-number' }), defaultThreadCount());
  });

  test('a non-positive explicit value falls through instead of being used', () => {
    assert.equal(resolveThreadCount(0, { [THREADS_ENV_VAR]: '5' }), 5);
    assert.equal(resolveThreadCount(-2, {}), defaultThreadCount());
  });
});

// --- Deterministic spec -> worker partitioning -----------------------------
//
// createExecutor now assigns specs to workers via CONTIGUOUS, deterministic
// chunks (partitionContiguous) rather than availability-based dispatch, so a
// given (specs, threads) always produces the same worker-assignment and is
// therefore reproducible bit-for-bit run to run -- see src/engine/parallel.js's
// module header for the full rationale.

describe('partitionContiguous: pure chunking function', () => {
  test('ranges are contiguous, cover [0, n) exactly, in worker-index order', () => {
    for (const [n, workers] of [
      [10, 3],
      [9, 3],
      [1, 4],
      [0, 4],
      [100, 7],
    ]) {
      const parts = partitionContiguous(n, workers);
      assert.equal(parts.length, workers);
      assert.equal(parts[0].start, 0);
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) assert.equal(parts[i].start, parts[i - 1].end);
      }
      assert.equal(parts[parts.length - 1].end, n);
    }
  });

  test('chunk sizes never differ by more than 1 (as-even-as-possible split)', () => {
    const parts = partitionContiguous(11, 4); // 11/4 = 2 remainder 3
    const sizes = parts.map((p) => p.end - p.start);
    assert.deepEqual(sizes, [3, 3, 3, 2]);
  });

  test('is a pure function: same (n, workers) always yields the same ranges', () => {
    assert.deepEqual(partitionContiguous(17, 5), partitionContiguous(17, 5));
  });

  test('workers is floored to at least 1', () => {
    assert.deepEqual(partitionContiguous(5, 0), [{ start: 0, end: 5 }]);
  });
});

