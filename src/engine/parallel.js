// JavaScript Document
//
// Cross-core parallel battle executor. No battle math or vendor changes live
// here: this module decides how many worker threads drive independent
// battleTeams() calls, how specs are handed out, and how the pool's lifetime
// relates to callers' batches. Every result comes from vendor/pvpoke's own
// code, run unmodified in each worker's own headless engine context
// (parallelWorker.js). History and measurements: src/engine/README.md.
//
// Determinism. A battle's result depends only on its own spec and seed, so
// serial and threaded runs of the same specs give bit-identical result arrays
// at any thread count, always returned in spec order (asserted in
// test/parallel.test.js and test/e2e.test.js).
//
// Team building happens per worker. pvpoke Pokemon instances live in one V8
// isolate's vm context and cannot cross a worker boundary, so specs carry
// plain-data mon descriptors (speciesId/ivs/shadow/bestBuddy) and each worker
// rebuilds and caches its own instances through buildPokemon().
//
// Persistent executor. `createExecutor(opts)` boots its pool lazily on the
// first non-empty `run(specs)` and keeps it until `close()`, so pool and
// engine boot cost (parsing gamemaster.json once per worker) is paid once per
// run instead of once per batch. `runBattles(specs, opts)` is the one-shot
// wrapper: create, run one batch, close.
//   * run() calls are serialized: a second call waits for the first batch to
//     resolve, so per-run bookkeeping never overlaps.
//   * A worker crash always rejects the in-flight run(), even under
//     `continueOnError` (which only isolates exceptions caught inside a
//     worker's own try/catch). The whole pool is torn down and the next
//     run() boots a fresh one; only close() is terminal.
//
// Partitioning. Specs are split into contiguous chunks, one per worker, from
// nothing but `specs.length` and the worker count (`partitionContiguous`):
// callers group a team's battles next to each other, so contiguous chunks keep
// a worker's build cache warm. A worker that exhausts its chunk steals the
// tail of the busiest remaining chunk (`stealNext`) instead of idling
// (measured at 3.7% median / 7.7% mean wall-clock otherwise, threads=7), so
// which worker runs which spec is not reproducible -- and nothing depends on it.

import { Worker } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'parallelWorker.js');

// Old-generation heap ceiling per worker isolate. Without one, V8 sizes each
// worker's heap against the whole machine and lets garbage from the battle
// sim (which allocates heavily) pile up before collecting: measured 2026-09-09,
// one isolate sat at ~450 MB RSS over ~20 MB of live heap, and 8 of them
// accounted for most of an evolve run's ~6.5 GB starting RSS. A worker's live
// data is small and bounded -- the scenario memo (~40 MB at its 20k cap, see
// teamBattle.js) plus the two built-Pokemon caches (~70 MB each at their
// 5000-entry cap, see parallelWorker.js) -- so 512 MB is a ~2.5x margin over
// the worst case, and just makes V8 collect sooner instead of growing.
// Exceeding it is fatal to that worker (and, per the crash policy above, to
// the run), so raise it via POGO_GBL_WORKER_HEAP_MB rather than lifting the
// cache caps without revisiting this number.
const WORKER_OLD_GEN_MB = (() => {
  const n = Number(process.env.POGO_GBL_WORKER_HEAP_MB);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 512;
})();

export const THREADS_ENV_VAR = 'POGO_GBL_THREADS';

/**
 * @typedef {{
 *   speciesId: string, ivs: {atk:number, def:number, hp:number},
 *   shadow?: boolean, bestBuddy?: boolean,
 *   fastMove?: string, chargedMoves?: string[]
 * }} MonSpec
 *   `fastMove`/`chargedMoves` are set only for a mon built with
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

/** Hard ceiling on the automatic default, independent of core count. Each
 * worker boots its own full pvpoke engine context (a `loading gamemaster`
 * per thread) before battling starts, so thread count drives peak memory as
 * much as CPU time. On a 16-core/7.7GB WSL box, `cpus-1` (15) OOM'd the VM
 * twice during that boot burst; 8 is the measured-fastest count on that same
 * machine (see src/engine/README.md's Performance section) and stays well
 * inside its memory budget. Anyone with headroom to spare can still pass
 * `--threads`/`POGO_GBL_THREADS` explicitly above this. */
const DEFAULT_THREAD_CAP = 8;

/**
 * `min(DEFAULT_THREAD_CAP, max(1, cpus - 1))` -- leaves one core free for the
 * main thread / OS, then caps at `DEFAULT_THREAD_CAP` regardless of core
 * count (see its doc comment for why more cores doesn't mean more threads
 * here). Cloud sandboxes tend to have very few vCPUs; the real payoff is
 * on a multi-core dev machine (see src/engine/README.md's Performance
 * section for measured numbers).
 * @returns {number}
 */
export function defaultThreadCount() {
  return Math.min(DEFAULT_THREAD_CAP, Math.max(1, os.cpus().length - 1));
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
 * Split `n` spec indices into `workers` contiguous, deterministic chunks --
 * as even as possible, with any remainder (`n % workers`) going one-each to
 * the FIRST chunks so sizes never differ by more than 1. Pure function of its
 * two arguments; used by `createExecutor` to decide which worker
 * processes which spec index BEFORE any battle runs, so that assignment is a
 * function of (specs.length, threads) rather than of real-time worker
 * availability. `workers` is floored to at least 1.
 * @param {number} n - total number of specs.
 * @param {number} workers - pool size.
 * @returns {Array<{start:number, end:number}>} one range per worker, in
 *   worker-index order; `end` is exclusive. Ranges partition `[0, n)` exactly
 *   (they are contiguous and their sizes sum to `n`); a worker whose range is
 *   empty (`start === end`) simply has no work this run.
 */
export function partitionContiguous(n, workers) {
  const w = Math.max(1, Math.floor(workers) || 1);
  const base = Math.floor(n / w);
  const remainder = n % w;
  const parts = [];
  let start = 0;
  for (let i = 0; i < w; i++) {
    const size = base + (i < remainder ? 1 : 0);
    parts.push({ start, end: start + size });
    start += size;
  }
  return parts;
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
 * @param {string|undefined} profileDir
 * @param {number|undefined} cp - forwarded to the worker's own initEngine
 *   so a spec without an explicit moveset still gets the right format's
 *   recommended moveset (see src/engine/harness.js's initEngine).
 * @param {string|undefined} cup - forwarded to the worker's own initEngine.
 * @returns {Promise<Worker>}
 */
function bootWorker(vendorRoot, onStarted, profileDir, cp, cup) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(WORKER_PATH, {
        workerData: { vendorRoot, profileDir, cp, cup },
        resourceLimits: { maxOldGenerationSizeMb: WORKER_OLD_GEN_MB },
      });
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
 * Create a reusable, persistent battle executor. The worker pool
 * (each worker booting its own headless pvpoke engine context, exactly as
 * `runBattles` always has) boots ONCE -- lazily, on the first `run()` call
 * that actually has work to do -- and is REUSED across every subsequent
 * `run()` call, amortizing pool+engine boot cost across many batches instead
 * of paying it per batch. See the module header above for the full run()
 * concurrency policy and worker-crash policy.
 *
 * @param {{ threads?: number, vendorRoot?: string, continueOnError?: boolean, profileDir?: string, cp?: number, cup?: string }} [opts]
 *   `cp`/`cup` are forwarded to each worker's own `initEngine` (see
 *   bootWorker) so a spec without an explicit moveset still gets the right
 *   format's recommended moveset; default to Great League ('all', 1500) when
 *   omitted, matching initEngine's own defaults.
 *   `profileDir` is diagnostic-only and off by default: when set, each worker
 *   runs a `node:inspector` CPU profiler for its whole life and, on `close()`,
 *   writes `<profileDir>/worker-<i>.cpuprofile` plus reports its scenario-memo
 *   hit/miss counts (see `close()`'s return value and parallelWorker.js).
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

  /** Diagnostic-only, opt-in via opts.profileDir: ask every worker to stop its
   * CPU profiler (if running), flush a .cpuprofile file, and report its
   * scenario-memo hit/miss counts before the pool is torn down -- terminate()
   * gives a worker no chance to flush anything, so a plain close() would
   * silently lose profiling data. Best-effort: a worker that doesn't answer
   * within the timeout is skipped rather than blocking close() indefinitely. */
  function collectShutdownStats(p) {
    if (!p || !opts.profileDir) return Promise.resolve([]);
    return Promise.all(
      p.workers.map(
        (w, i) =>
          new Promise((resolve) => {
            const done = (stats) => {
              w.off('message', onMessage);
              clearTimeout(timer);
              resolve(stats ? { worker: i, ...stats } : null);
            };
            const onMessage = (msg) => {
              if (msg.type === 'shutdownDone') done(msg.stats);
            };
            const timer = setTimeout(() => done(null), 5000);
            w.on('message', onMessage);
            w.postMessage({ type: 'shutdown' });
          })
      )
    ).then((results) => results.filter(Boolean));
  }

  /** Non-destructive counterpart to collectShutdownStats: ask every currently
   * booted worker for its live memo/cache/RSS snapshot without stopping its
   * CPU profiler or touching its caches. Returns [] if no pool is up yet
   * (e.g. called before the first run()). Best-effort per worker, same
   * timeout pattern as shutdown stats, so a stuck worker can't hang a
   * mid-run poll. */
  function collectLiveStats(p) {
    if (!p) return Promise.resolve([]);
    let nextRequestId = 0;
    return Promise.all(
      p.workers.map(
        (w, i) =>
          new Promise((resolve) => {
            const requestId = nextRequestId++;
            const done = (stats) => {
              w.off('message', onMessage);
              clearTimeout(timer);
              resolve(stats ? { worker: i, ...stats } : null);
            };
            const onMessage = (msg) => {
              if (msg.type === 'statsResult' && msg.requestId === requestId) done(msg.stats);
            };
            const timer = setTimeout(() => done(null), 5000);
            w.on('message', onMessage);
            try {
              w.postMessage({ type: 'stats', requestId });
            } catch {
              // Worker died between run() resolving and this poll -- best-effort,
              // so skip it instead of rejecting the whole Promise.all.
              done(null);
            }
          })
      )
    ).then((results) => results.filter(Boolean));
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

  /**
   * Find a spec to steal for a worker that has exhausted its own chunk: take
   * the LAST UNCLAIMED index from whichever chunk has the most left. Only
   * unclaimed indices are eligible (`cursor <= idx < ends`), so a spec is
   * never handed out twice and the one a victim is currently running is never
   * touched. Taking from the tail leaves the victim's own forward run of
   * adjacent specs -- and therefore its build-cache locality -- intact. Ties
   * go to the lowest worker index, which keeps a run's steal pattern stable
   * when the timings happen to be. Note the final queued spec of a chunk IS
   * stealable: that is precisely the straggler case worth fixing (a worker
   * mid-battle with one spec queued behind it, while another sits idle).
   * @returns {number} the stolen spec index, or -1 if nothing is stealable.
   */
  function stealNext() {
    let victim = -1;
    let most = 0; // any chunk with an unclaimed spec is a candidate
    for (let i = 0; i < active.ends.length; i++) {
      const remaining = active.ends[i] - active.cursor[i];
      if (remaining > most) {
        most = remaining;
        victim = i;
      }
    }
    if (victim === -1) return -1;
    return --active.ends[victim];
  }

  /** Hand `worker` (at `workerIndex` in the pool) the next spec inside ITS OWN
   * contiguous chunk; once that chunk is exhausted, steal the tail of the
   * busiest remaining chunk (see module header), and only count it
   * idle-at-end when there is nothing left anywhere to take. */
  function assignNext(worker, workerIndex) {
    if (!active) return;
    let id;
    if (active.cursor[workerIndex] < active.ends[workerIndex]) {
      id = active.cursor[workerIndex]++;
    } else {
      id = stealNext();
    }
    if (id === -1) {
      active.idleAtEnd += 1;
      if (pool && active.idleAtEnd === pool.workers.length) {
        settle(active.resolve, active.results);
      }
      return;
    }
    worker.postMessage({ type: 'battle', id, spec: active.specs[id] });
  }

  /** Attached once per worker, right after it boots, and used across every
   * `run()` call for the rest of that worker's life (steady state -- boot's
   * own `ready`/`initError` messages are already consumed by `bootWorker`'s
   * one-shot listener by the time this is attached). `workerIndex` is this
   * worker's fixed position in `pool.workers`, used to look up its
   * deterministic partition range each `run()` call. */
  function attachSteadyStateHandlers(worker, workerIndex) {
    worker.on('message', (msg) => {
      if (!active) return; // stray message with no run in flight; ignore
      if (msg.type === 'result') {
        active.results[msg.id] = continueOnError ? { ok: true, value: msg.result } : msg.result;
        assignNext(worker, workerIndex);
      } else if (msg.type === 'battleError') {
        if (continueOnError) {
          active.results[msg.id] = { ok: false, error: { message: msg.message } };
          assignNext(worker, workerIndex);
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
    const bootOne = () =>
      bootWorker(vendorRoot, (w) => started.push(w), opts.profileDir, opts.cp, opts.cup);

    bootPromise = Promise.all(Array.from({ length: threadCount }, bootOne))
      .then((workers) => {
        workers.forEach((w, i) => attachSteadyStateHandlers(w, i));
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
      const partition = partitionContiguous(specs.length, pool.workers.length);
      active = {
        specs,
        results: new Array(specs.length),
        partition,
        cursor: partition.map((r) => r.start),
        // Mutable copy of each chunk's exclusive end. A steal decrements the
        // victim's `ends` entry, which is what makes "unclaimed" a single
        // shared fact: an index is handed out either by its own worker's
        // `cursor++` or by a stealer's `--ends`, never both, because a steal
        // only fires while `ends[victim] - cursor[victim] >= 2`.
        ends: partition.map((r) => r.end),
        idleAtEnd: 0,
        settled: false,
        resolve,
        reject,
      };
      pool.workers.forEach((w, i) => assignNext(w, i));
    });
  }

  return {
    async run(specs) {
      if (closed) throw new Error('createExecutor: run() called after close()');
      if (!Array.isArray(specs)) throw new Error('createExecutor.run: specs must be an array');
      return enqueue(() => runInternal(specs));
    },

    /** @returns {Promise<Array<object>>} per-worker {worker, memoHits,
     *   memoMisses, memoSize, cacheASize, cacheBSize, heapMb, peakHeapMb} --
     *   safe to call between run() calls (e.g. once per evolve.mjs
     *   generation) for live memory/speed visibility. Non-destructive: does
     *   NOT stop the CPU profiler or clear caches, unlike close(). heapMb is
     *   the worker isolate's own heapUsed (rss would be the whole process's);
     *   peakHeapMb is 0 unless this executor was booted with `profileDir`
     *   (heap sampling is gated the same as the CPU profiler -- see
     *   parallelWorker.js). Returns [] before the pool has booted. */
    async stats() {
      return collectLiveStats(pool);
    },

    /** @returns {Promise<Array<object>>} per-worker profile/memo stats
     *   (empty unless `opts.profileDir` was set) -- see collectShutdownStats. */
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
        const stats = await collectShutdownStats(pool);
        terminatePool(pool);
        pool = null;
        bootPromise = null;
        return stats;
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
 * This is now a thin `createExecutor` → `run` → `close` wrapper
 * (one pool per call, torn down before the returned promise settles) --
 * signature, behavior, and return shape are UNCHANGED from before the
 * persistent executor existed.
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
 * @param {{ threads?: number, vendorRoot?: string, cp?: number, cup?: string }} [opts]
 * @returns {Promise<object[]>} results in spec order, each shaped like
 *   battleTeams()'s return value ({winner, survivorsHp, summary}).
 */
export function runBattles(specs, opts = {}) {
  if (!Array.isArray(specs)) {
    throw new Error('runBattles: specs must be an array');
  }
  if (specs.length === 0) return Promise.resolve([]);

  const threads = Math.max(1, Math.min(resolveThreadCount(opts.threads), specs.length));
  const executor = createExecutor({ threads, vendorRoot: opts.vendorRoot, cp: opts.cp, cup: opts.cup });
  return executor.run(specs).finally(() => executor.close());
}
