// JavaScript Document
//
// Cross-core parallel battle executor (GOALS T15, extended by T19). No battle
// math, engine, or vendor changes live here -- this module only decides HOW
// MANY OS threads drive independent battleTeams() calls, how work is handed
// out between them, and (as of T19) how the worker pool's lifetime relates to
// callers' individual batches of work. Every battle result still comes from
// vendor/pvpoke's own code, executed unmodified inside each worker's own
// headless engine context (see parallelWorker.js).
//
// Why this is safe to parallelize: every battleTeams() call's WINNER is
// deterministic given its own (teams, leads, difficulty, seed) --
// src/engine/teamBattle.js resets a fresh Battle + virtual clock + seeded RNG
// per call. Running independent battles on independent engine contexts (one
// per worker thread, each its own V8 isolate) therefore produces the same
// winners as running them serially on one context; results are always placed
// back into spec order before a run resolves, so callers never observe
// worker-assignment reordering.
//
// CORRECTION (discovered during GOALS T15b, see src/engine/README.md's "Known
// limitation" section): this is NOT quite "bit-identical per battle" -- a
// Pokemon INSTANCE reused across several battles carries a subtle pvpoke
// engine artifact (Pokemon#resetMoves()'s bestChargedMove tie-break reads a
// stale battle-slot index) that makes exact HP totals sensitive to which
// order that instance's battles ran in. Since a worker's per-spec build cache
// reuses instances in the order specs happen to land on that worker, threaded
// and serial runs can therefore differ in HP margin even though win/loss
// outcomes (verified empirically) very rarely do. This affects any REUSE of a
// Pokemon instance across sequential battles, so it already existed in
// today's serial evaluateTeams/tournament.mjs too. Standing rule 4 (vendor is
// read-only, never reimplement battle math) means this is documented as a
// known engine characteristic, not "fixed" here -- GOALS T20 is the ticket
// that addresses it directly.
//
// Team-building happens PER WORKER, not on the main thread: pvpoke Pokemon
// instances live inside a specific vm context tied to one V8 isolate, so they
// cannot be handed to a worker_thread at all (postMessage's structured clone
// doesn't preserve class instances/methods, and even if it tried, the result
// would be disconnected from that worker's Battle/GameMaster singletons).
// Specs therefore carry plain-data mon descriptors (speciesId/ivs/shadow/
// bestBuddy); each worker rebuilds + caches its own Pokemon instances via the
// same buildPokemon() every other caller uses (see parallelWorker.js).
//
// --- GOALS T19: persistent executor -----------------------------------------
//
// Before T19, `runBattles()` built a fresh worker pool (N workers, each
// booting its own headless engine context) for every call and tore it down
// before resolving -- correct, but it means pool+engine boot cost (dominated
// by parsing/indexing gamemaster.json once per worker) is paid again on every
// single call, which is exactly why scripts/tournament.mjs had to batch big
// runs per-candidate rather than pay that cost once for the whole run (T15c).
//
// `createExecutor(opts)` splits pool lifecycle from individual batches of
// work: `run(specs)` can be called many times against the SAME pool, which
// boots once (lazily, on the first non-empty `run()` call) and stays alive
// until `close()`. `runBattles(specs, opts)` is now a thin wrapper that
// creates an executor, runs one batch, and closes it -- so its own behavior
// (one pool per call, torn down before the returned promise settles) is
// unchanged; the new amortization only benefits callers that adopt
// `createExecutor` directly and call `run()` repeatedly (scripts/tournament.mjs
// and src/teams/index.js's evaluateTeams -- GOALS T21).
//
// **run() concurrency policy: serialized, not parallel-dispatched.** Multiple
// `run()` calls against one executor are safe to issue without awaiting each
// other, but they execute ONE AT A TIME, in call order, against the shared
// pool -- the second call's battles are not dispatched until the first call's
// entire batch has resolved. This was chosen over interleaving two batches'
// specs across the same workers because it keeps the per-run bookkeeping
// (results array, nextIndex cursor, idle-worker counting, fault handling)
// completely independent between batches with no shared mutable state to get
// wrong -- a batch either fully owns the pool or isn't running yet. The cost
// is that concurrent callers don't get extra parallelism from overlapping
// their batches (the pool is already using all its threads on the batch in
// front, so there is little to gain from interleaving anyway); if a future
// caller needs true cross-batch interleaving, this is the place to revisit.
//
// **Worker crash policy: always fatal to the in-flight run(), never a
// per-spec fault -- even under `continueOnError`.** `continueOnError`
// isolates BATTLE exceptions caught inside a worker's own try/catch (the
// worker survives, only that one spec is bad); a worker crash/unexpected exit
// is an infrastructure fault with no way to know what state the crashed
// battle was in, so it always rejects the run it occurred in. When that
// happens the whole pool is torn down (every worker terminated, even
// survivors -- partial-pool "healing" was judged not worth the complexity),
// and the executor transparently boots a FRESH pool on the next `run()` call
// (the executor is not permanently broken by a crash -- only `close()` is
// terminal). See "createExecutor" below for the full contract.

import { Worker } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'parallelWorker.js');

export const THREADS_ENV_VAR = 'POGO_GBL_THREADS';

/**
 * @typedef {{
 *   speciesId: string, ivs: {atk:number, def:number, hp:number},
 *   shadow?: boolean, bestBuddy?: boolean,
 *   fastMove?: string, chargedMoves?: string[]
 * }} MonSpec
 *   `fastMove`/`chargedMoves` (GOALS T15b) are set only for a mon built with
 *   an EXPLICIT moveset (src/scoring/index.js's buildMetaMon, e.g. a curated
 *   preset team member) rather than pvpoke's recommended one -- when present,
 *   parallelWorker.js reapplies that exact moveset after rebuilding the
 *   Pokemon, since buildPokemon alone always selects the recommended moveset.
 */

/**
 * @typedef {{
 *   teamA: MonSpec[], teamB: MonSpec[],
 *   leadA?: number, leadB?: number,
 *   difficulty?: number, seed?: number
 * }} BattleSpec
 */

/**
 * @typedef {{ok: true, value: object} | {ok: false, error: {message: string}}} SpecResult
 *   Per-spec result slot shape used ONLY when an executor is created with
 *   `continueOnError: true`. `value` is exactly what `battleTeams()`/
 *   `runBattles()` return per spec today ({winner, survivorsHp, summary}).
 */

/**
 * `max(1, cpus - 1)` -- leaves one core free for the main thread / OS, per
 * GOALS T15. Cloud sandboxes tend to have very few vCPUs; the real payoff is
 * on a multi-core dev machine (see src/engine/README.md's Performance
 * section for measured numbers).
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
 * Boot one worker and resolve once it signals `{type:'ready'}` (i.e. its own
 * `initEngine()` finished) -- or reject if it fails to start, fails to
 * initialize, or dies before ever becoming ready. The boot-only listeners
 * remove themselves the moment they settle, so they never see the
 * steady-state `result`/`battleError` traffic a worker sends later.
 * @param {string|undefined} vendorRoot
 * @param {(worker: Worker) => void} onStarted - called synchronously the
 *   moment the Worker object is constructed (even before it's ready), so a
 *   caller can track/terminate it if a LATER worker in the same pool fails.
 * @returns {Promise<Worker>}
 */
function bootWorker(vendorRoot, onStarted) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(WORKER_PATH, { workerData: { vendorRoot } });
    } catch (err) {
      reject(new Error(`createExecutor: failed to start worker: ${err.message}`));
      return;
    }
    onStarted(worker);

    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    const onMessage = (msg) => {
      if (msg.type === 'ready') {
        cleanup();
        resolve(worker);
      } else if (msg.type === 'initError') {
        cleanup();
        reject(new Error(`createExecutor: worker failed to initialize engine: ${msg.message}`));
      }
    };
    const onError = (err) => {
      cleanup();
      reject(new Error(`createExecutor: worker crashed during boot: ${err.message}`));
    };
    const onExit = (code) => {
      if (code !== 0) {
        cleanup();
        reject(new Error(`createExecutor: worker exited during boot with code ${code}`));
      }
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
  });
}

/**
 * Create a reusable, persistent battle executor (GOALS T19). The worker pool
 * (each worker booting its own headless pvpoke engine context, exactly as
 * `runBattles` always has) boots ONCE -- lazily, on the first `run()` call
 * that actually has work to do -- and is REUSED across every subsequent
 * `run()` call, amortizing pool+engine boot cost across many batches instead
 * of paying it per batch. See the module header above for the full run()
 * concurrency policy and worker-crash policy.
 *
 * @param {{ threads?: number, vendorRoot?: string, continueOnError?: boolean }} [opts]
 *   `threads` is resolved ONCE via resolveThreadCount() when the pool boots
 *   and fixed for the executor's lifetime -- unlike `runBattles`, it is NOT
 *   re-clamped to any individual `run()` call's `specs.length`, because the
 *   whole point of a persistent pool is serving many batches of possibly
 *   very different sizes; a `run()` call smaller than the pool simply leaves
 *   some workers idle for that call (see `assignNext` below), which is safe
 *   and cheap. `continueOnError` (default false) selects the per-spec
 *   fault-isolation result shape (`SpecResult`) described on `run()` below.
 * @returns {{
 *   run(specs: BattleSpec[]): Promise<object[]|SpecResult[]>,
 *   close(): Promise<void>
 * }}
 *   `run(specs)` resolves to results in spec order. When the executor was
 *   created with `continueOnError: true`, each element is a `SpecResult`
 *   (`{ok:true, value}` or `{ok:false, error:{message}}`) and a bad spec
 *   never aborts the rest of that call's batch. Otherwise (the default)
 *   each element is exactly `battleTeams()`'s return value, and a single bad
 *   spec rejects the WHOLE `run()` call -- matching `runBattles`'s long-
 *   standing whole-batch-reject behavior. Either way, a worker crash always
 *   rejects the in-flight `run()` call (see module header) and tears down
 *   the pool; the NEXT `run()` call transparently boots a fresh one. `close()`
 *   terminates every worker; a `run()` call issued after `close()` has been
 *   invoked rejects immediately with a clear error instead of touching a
 *   torn-down pool.
 */
export function createExecutor(opts = {}) {
  const vendorRoot = opts.vendorRoot;
  const continueOnError = !!opts.continueOnError;

  /** @type {{workers: Worker[]}|null} */
  let pool = null;
  /** @type {Promise<{workers: Worker[]}>|null} */
  let bootPromise = null;
  /** In-flight run() state. Only ever one at a time -- run() calls are
   * serialized via `enqueue` below, so nothing else mutates `active` while
   * it's set. */
  let active = null;
  let closed = false;

  // Serializes run()/close() calls against this executor: each call's work
  // starts only after the previous one has fully settled (success or
  // failure), but each call's OWN promise still resolves/rejects with only
  // its own outcome. See the module header's "run() concurrency policy".
  let queueTail = Promise.resolve();
  function enqueue(fn) {
    const started = queueTail.then(fn, fn);
    queueTail = started.then(
      () => undefined,
      () => undefined
    );
    return started;
  }

  function settle(fn, value) {
    if (!active || active.settled) return;
    active.settled = true;
    active = null;
    fn(value);
  }

  function failActive(err) {
    if (active) settle(active.reject, err);
  }

  /** Terminate every worker in `p` (if any) without waiting for it. */
  function terminatePool(p) {
    if (!p) return;
    for (const w of p.workers) {
      w.removeAllListeners();
      w.terminate().catch(() => undefined);
    }
  }

  /** A worker died (crash or unexpected exit) -- see module header's worker-
   * crash policy: always fatal to the in-flight run, never per-spec, and
   * always tears down the whole pool so the next run() boots fresh. */
  function handleWorkerDeath(err) {
    const dead = pool;
    pool = null;
    bootPromise = null;
    terminatePool(dead);
    failActive(err);
  }

  function assignNext(worker) {
    if (!active) return;
    if (active.nextIndex >= active.specs.length) {
      active.idleAtEnd += 1;
      if (pool && active.idleAtEnd === pool.workers.length) {
        settle(active.resolve, active.results);
      }
      return;
    }
    const id = active.nextIndex++;
    worker.postMessage({ type: 'battle', id, spec: active.specs[id] });
  }

  /** Attached once per worker, right after it boots, and used across every
   * `run()` call for the rest of that worker's life (steady state -- boot's
   * own `ready`/`initError` messages are already consumed by `bootWorker`'s
   * one-shot listener by the time this is attached). */
  function attachSteadyStateHandlers(worker) {
    worker.on('message', (msg) => {
      if (!active) return; // stray message with no run in flight; ignore
      if (msg.type === 'result') {
        active.results[msg.id] = continueOnError ? { ok: true, value: msg.result } : msg.result;
        assignNext(worker);
      } else if (msg.type === 'battleError') {
        if (continueOnError) {
          active.results[msg.id] = { ok: false, error: { message: msg.message } };
          assignNext(worker);
        } else {
          failActive(new Error(`createExecutor.run: battle ${msg.id} failed: ${msg.message}`));
        }
      }
    });
    worker.on('error', (err) => {
      handleWorkerDeath(new Error(`createExecutor.run: worker crashed: ${err.message}`));
    });
    worker.on('exit', (code) => {
      if (code !== 0) {
        handleWorkerDeath(new Error(`createExecutor.run: worker exited unexpectedly with code ${code}`));
      }
    });
  }

  /** Boot the pool if it isn't already up (or already booting). Idempotent
   * and safe to call from every run(); serialization means it's never
   * actually re-entered concurrently, but the `bootPromise` guard is kept as
   * cheap defensive insurance. */
  function ensurePool() {
    if (pool) return Promise.resolve(pool);
    if (bootPromise) return bootPromise;

    const threadCount = Math.max(1, resolveThreadCount(opts.threads));
    const started = [];
    const bootOne = () => bootWorker(vendorRoot, (w) => started.push(w));

    bootPromise = Promise.all(Array.from({ length: threadCount }, bootOne))
      .then((workers) => {
        for (const w of workers) attachSteadyStateHandlers(w);
        pool = { workers };
        bootPromise = null;
        return pool;
      })
      .catch((err) => {
        terminatePool({ workers: started });
        bootPromise = null;
        throw err;
      });
    return bootPromise;
  }

  async function runInternal(specs) {
    if (specs.length === 0) return [];
    await ensurePool();
    return new Promise((resolve, reject) => {
      active = {
        specs,
        results: new Array(specs.length),
        nextIndex: 0,
        idleAtEnd: 0,
        settled: false,
        resolve,
        reject,
      };
      for (const w of pool.workers) assignNext(w);
    });
  }

  return {
    async run(specs) {
      if (closed) throw new Error('createExecutor: run() called after close()');
      if (!Array.isArray(specs)) throw new Error('createExecutor.run: specs must be an array');
      return enqueue(() => runInternal(specs));
    },

    async close() {
      closed = true;
      return enqueue(async () => {
        if (bootPromise) {
          try {
            await bootPromise;
          } catch {
            // Boot already failed and cleaned up after itself; nothing left
            // to terminate.
          }
        }
        terminatePool(pool);
        pool = null;
        bootPromise = null;
      });
    },
  };
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
 * GOALS T19: this is now a thin `createExecutor` → `run` → `close` wrapper
 * (one pool per call, torn down before the returned promise settles) --
 * signature, behavior, and return shape are UNCHANGED from before T19.
 * Callers that issue many batches over time and want to amortize pool+engine
 * boot cost across them should use `createExecutor` directly instead and
 * call `run()` repeatedly against the same pool.
 *
 * A single specs.length === 0 call resolves to `[]` without spawning any
 * workers. threads is clamped to `[1, specs.length]` (no point spawning more
 * workers than there is work) -- this clamp is specific to `runBattles`'
 * one-batch-per-call contract; `createExecutor` does not apply it (see its
 * own docs).
 *
 * Failure modes surface as a REJECTED promise, not a hang: a battle that
 * throws inside a worker (e.g. an invalid spec) rejects with the offending
 * spec's index and message; a worker that crashes outright (uncaught
 * exception, forced exit) rejects with a "worker crashed" error. Either way
 * every worker is terminated before the promise settles, so no worker_thread
 * is left running (and keeping the process alive) after runBattles() returns.
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

  const threads = Math.max(1, Math.min(resolveThreadCount(opts.threads), specs.length));
  const executor = createExecutor({ threads, vendorRoot: opts.vendorRoot });
  return executor.run(specs).finally(() => executor.close());
}
