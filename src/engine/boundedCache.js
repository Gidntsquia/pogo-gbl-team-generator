// JavaScript Document
//
// A Map with a fixed capacity and least-recently-used eviction. Extracted
// from parallelWorker.js so it's importable/testable outside a worker_thread
// context (that file throws immediately if required outside a worker).

/**
 * Map-like cache that evicts its least-recently-used entry once `maxEntries`
 * is exceeded. `get` promotes the entry to most-recently-used.
 */
export class BoundedCache {
  /** @param {number} maxEntries */
  constructor(maxEntries) {
    this.maxEntries = maxEntries;
    this.map = new Map();
  }

  /** @param {string} key @returns {*} */
  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /** @param {string} key @param {*} value */
  set(key, value) {
    this.map.set(key, value);
    if (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value);
    }
  }

  get size() {
    return this.map.size;
  }
}
