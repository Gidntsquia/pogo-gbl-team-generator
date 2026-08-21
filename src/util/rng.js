// JavaScript Document
//
// Tiny seeded PRNG + weighted-sampling-without-replacement helper. Pure
// arithmetic/statistics utility used by the samplers in src/meta/sampleTeams.js
// (T10) and src/teams/sample.js (T11) -- no battle math, no pvpoke data, no
// npm dependency. See PLAN.md's Rev 3 section.

/**
 * mulberry32: a small, fast, deterministic 32-bit PRNG. Same seed -> same
 * infinite sequence of floats in [0, 1) every time, on every platform (pure
 * integer arithmetic, no Math.random anywhere in this module).
 *
 * @param {number} seed - a 32-bit integer (values outside that range are
 *   coerced via `>>> 0`, matching the reference mulberry32 implementation).
 * @returns {() => number} a generator function; each call advances the
 *   internal state and returns the next float in [0, 1).
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministically hash an arbitrary string down to a 32-bit integer seed
 * (FNV-1a), so callers can pass a human-readable `--seed` string (a CLI flag,
 * a test label) instead of memorizing a magic number. Same string -> same
 * seed every time, on every platform.
 *
 * @param {string} str
 * @returns {number} a 32-bit unsigned integer.
 */
export function seedFromString(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Normalize a caller-supplied seed (a number, a string, or undefined) into a
 * ready-to-use mulberry32 generator. `undefined` falls back to a fixed
 * default string so an omitted seed is still deterministic (never wall-clock
 * or Math.random-based) rather than throwing or silently varying run to run.
 *
 * @param {number|string} [seed]
 * @param {string} [fallback] - label hashed when `seed` is omitted.
 * @returns {() => number}
 */
export function rngFromSeed(seed, fallback = 'default-seed') {
  if (typeof seed === 'number') return mulberry32(seed);
  return mulberry32(seedFromString(typeof seed === 'string' ? seed : fallback));
}

/**
 * Weighted sampling WITHOUT replacement, k items from `items`, one at a time
 * via roulette-wheel selection (draw a uniform threshold over the remaining
 * total weight, walk the cumulative sum). Pure sampling machinery -- no
 * domain knowledge of what `items` are.
 *
 * Items with a non-positive weight are never chosen (skipped when computing
 * the cumulative sum) but are otherwise left alone; if every remaining item
 * has non-positive weight, sampling stops early and returns fewer than k
 * items rather than throwing.
 *
 * @template T
 * @param {() => number} rng - a generator from mulberry32/rngFromSeed.
 * @param {T[]} items
 * @param {(item: T) => number} weightFn
 * @param {number} k - how many to draw; gracefully capped at `items.length`.
 * @returns {T[]} up to k distinct items from `items`, in draw order.
 */
export function pickWeighted(rng, items, weightFn, k) {
  const pool = items.slice();
  const chosen = [];
  const n = Math.min(k, pool.length);
  for (let i = 0; i < n; i++) {
    const weights = pool.map(weightFn);
    const total = weights.reduce((sum, w) => sum + (w > 0 ? w : 0), 0);
    if (total <= 0) break;
    let threshold = rng() * total;
    let idx = -1;
    for (let j = 0; j < pool.length; j++) {
      const w = weights[j] > 0 ? weights[j] : 0;
      threshold -= w;
      if (threshold <= 0 && w > 0) {
        idx = j;
        break;
      }
    }
    if (idx === -1) idx = weights.findIndex((w) => w > 0);
    if (idx === -1) break;
    chosen.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return chosen;
}
