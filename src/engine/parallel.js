// JavaScript Document
//
// Cross-core parallel battle executor (GOALS T15). No battle math, engine, or
// vendor changes live here -- this module only decides HOW MANY OS threads
// drive independent battleTeams() calls and how work is handed out between
// them; every battle result still comes from vendor/pvpoke's own code,
// executed unmodified inside each worker's own headless engine context (see
// parallelWorker.js).
//
// Why this is safe to parallelize: every battleTeams() call is already fully
// self-contained and deterministic given its own (teams, leads, difficulty,
// seed) -- src/engine/teamBattle.js resets a fresh Battle + virtual clock +
// seeded RNG per call and never shares mutable state across calls on the same
// ctx. Running independent battles on independent engine contexts (one per
// worker thread, each its own V8 isolate) therefore produces bit-identical
// per-battle results to running them serially on one context; only the ORDER
// battles are computed in changes, and runBattles() puts every result back in
// spec order before resolving, so callers never observe that reordering.
//
// Team-building happens PER WORKER, not on the main thread: pvpoke Pokemon
// instances live inside a specific vm context tied to one V8 isolate, so they
// cannot be handed to a worker_thread at all (postMessage's structured clone
// doesn't preserve class instances/methods, and even if it tried, the result
// would be disconnected from that worker's Battle/GameMaster singletons).
// Specs therefore carry plain-data mon descriptors (speciesId/ivs/shadow/
// bestBuddy); each worker rebuilds + caches its own Pokemon instances via the
// same buildPokemon() every other caller uses (see parallelWorker.js).

import { Worker } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'parallelWorker.js');

export const THREADS_ENV_VAR = 'POGO_GBL_THREADS';

/**
 * @typedef {{ speciesId: string, ivs: {atk:number, def:number, hp:number}, shadow?: boolean, bestBuddy?: boolean }} MonSpec
 */

/**
 * @typedef {{
 *   teamA: MonSpec[], teamB: MonSpec[],
 *   leadA?: number, leadB?: number,
 *   difficulty?: number, seed?: number
 * }} BattleSpec
 */

/**
 * `max(1, cpus - 1)` -- leaves one core free for the main thread / OS, per
 * GOALS T15. Cloud sandboxes tend to have very few vCPUs (this one has 4); the
 * real payoff is on a multi-core dev machine (see src/engine/README.md's
 * Performance section for measured numbers).
 * @returns {number}
 */
export function defaultThreadCount() {
  return Math.max(1, os.cpus().length - 1);
}

/**
 * Resolve a thread count from (in priority order) an explicit argument, the
 * `POGO_GBL_THREADS` env var, then defaultThreadCount(). Never returns less
 * than 1; a non-numeric/non-positive override falls through to the next
 * source rather than throwing, so a malformed env var degrades to the
 * default instead of breaking a run.
 * @param {number|undefined} explicit
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function resolveThreadCount(explicit, env = process.env) {
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const fromEnv = Number(env?.[THREADS_ENV_VAR]);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return defaultThreadCount();
}

/**
 * Run a batch of independent 3v3 team battles across a pool of worker
 * threads, each running its own headless pvpoke engine context, and return
 * results in the SAME ORDER as `specs` -- identical to what a serial loop of
 * `battleTeams(ctx, spec)` calls would produce (see the module header for
 * why). Every element of `specs.teamA`/`specs.teamB` must be a plain-data
 * MonSpec (speciesId/ivs/shadow/bestBuddy), not a built Pokemon instance --
 * those can't cross a thread boundary; see the module header.
 *
 * A single specs.length === 0 call resolves to `[]` without spawning any
 * workers. threads is clamped to `[1, specs.length]` (no point spawning more
 * workers than there is work).
 *
 * Failure modes surface as a REJECTED promise, not a hang: a battle that
 * throws inside a worker (e.g. an invalid spec) rejects with the offending
 * spec's index and message; a worker that crashes outright (uncaught
 * exception, forced exit) rejects with a "worker crashed" error. Either way
 * every remaining worker is terminated before the promise settles, so no
 * worker_thread is left running (and keeping the process alive) after
 * runBattles() returns.
 *
 * @param {BattleSpec[]} specs
 * @param {{ threads?: number, vendorRoot?: string }} [opts]
 * @returns {Promise<object[]>} results in spec order, each shaped like
 *   battleTeams()'s return value ({winner, survivorsHp, summary}).
 */
export function runBattles(specs, opts = {}) {
  if (!Array.isArray(specs)) {
    throw new Error('runBattles: specs must be an array');
  }
  if (specs.length === 0) return Promise.resolve([]);

  const threadCount = Math.max(1, Math.min(resolveThreadCount(opts.threads), specs.length));
  const vendorRoot = opts.vendorRoot;

  return new Promise((resolve, reject) => {
    const results = new Array(specs.length);
    const workers = [];
    let nextIndex = 0;
    let idleAtEnd = 0;
    let settled = false;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      for (const w of workers) {
        w.removeAllListeners();
        w.terminate().catch(() => undefined);
      }
      fn(value);
    };

    const fail = (err) => settle(reject, err);

    const assignNext = (worker) => {
      if (settled) return;
      if (nextIndex >= specs.length) {
        idleAtEnd += 1;
        if (idleAtEnd === workers.length) settle(resolve, results);
        return;
      }
      const id = nextIndex++;
      worker.postMessage({ type: 'battle', id, spec: specs[id] });
    };

    for (let i = 0; i < threadCount; i++) {
      let worker;
      try {
        worker = new Worker(WORKER_PATH, { workerData: { vendorRoot } });
      } catch (err) {
        fail(new Error(`runBattles: failed to start worker: ${err.message}`));
        return;
      }
      workers.push(worker);

      worker.on('message', (msg) => {
        if (msg.type === 'ready') {
          assignNext(worker);
        } else if (msg.type === 'result') {
          results[msg.id] = msg.result;
          assignNext(worker);
        } else if (msg.type === 'battleError') {
          fail(new Error(`runBattles: battle ${msg.id} failed: ${msg.message}`));
        } else if (msg.type === 'initError') {
          fail(new Error(`runBattles: worker failed to initialize engine: ${msg.message}`));
        }
      });
      worker.on('error', (err) => {
        fail(new Error(`runBattles: worker crashed: ${err.message}`));
      });
      worker.on('exit', (code) => {
        if (!settled && code !== 0) {
          fail(new Error(`runBattles: worker exited unexpectedly with code ${code}`));
        }
      });
    }
  });
}
