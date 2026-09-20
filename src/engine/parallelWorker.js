// JavaScript Document
//
// worker_threads entry point for src/engine/parallel.js's createExecutor()/
// runBattles(). Each worker boots its own headless pvpoke engine context
// ONCE (same initEngine used everywhere else -- no engine/vendor changes, no
// battle math here) and then answers a stream of battle specs from the main
// thread for as long as this worker lives. Nothing in this file does battle
// math: it only (1) rebuilds Pokemon from plain-data specs via the existing
// buildPokemon, and (2) calls the existing battleTeams.
//
// This file's protocol was already batch-agnostic -- a worker has
// no notion of where one `run()` call ends and the next begins, it just
// answers `{type:'battle', id, spec}` messages with `result`/`battleError`
// responses indefinitely -- so createExecutor's persistent pool needed ZERO
// changes here to be reused across many run() calls. One notable side effect
// worth knowing about: cacheA/cacheB (below) now persist for the pool's
// entire lifetime rather than just one runBattles() call, so a long-lived
// executor reused across many batches (e.g. a multi-stage run) will build any given mon at most once per worker ever, not once per
// batch -- a nice bonus. But an evolve.mjs run keeps ONE executor alive for
// its ENTIRE 100-generation run (see src/evolve/run.js), and mutation means
// every generation introduces candidates with new IVs/movesets -- there is no
// natural ceiling on the number of distinct mons a worker will ever see, so
// an unbounded cache here grows for as long as the run does. This was the
// root cause of the RSS growth observed on long evolve runs (2026-09-07):
// each worker's cache size, not a fixed per-battle allocation,
// was what kept climbing. `BoundedCache` caps each side's cache at a fixed
// entry count with LRU eviction so memory plateaus instead of growing with
// generation count -- while still spanning many generations, so the cross-
// generation reuse (the whole point of a persistent pool) is kept: see
// MAX_CACHE_ENTRIES below for the sizing.
//
// Pokemon instances built in one thread's vm context cannot be sent to
// another thread (postMessage's structured clone doesn't preserve class
// instances/methods, and a vm context is tied to its own V8 isolate anyway),
// so specs travel as plain data -- {speciesId, ivs, shadow, bestBuddy,
// fastMove?, chargedMoves?} per mon -- and each worker rebuilds + caches its
// own Pokemon instances. See src/engine/parallel.js's header comment for why
// the cache is split into cacheA/cacheB (mirror-match distinctness).
// fastMove/chargedMoves, when present, are reapplied via
// src/scoring/index.js's applyGroupMoveset -- buildPokemon alone always
// selects pvpoke's RECOMMENDED moveset, which is not what a buildMetaMon-built
// mon (e.g. a curated preset team member) necessarily carries.

import { parentPort, workerData, threadId } from 'node:worker_threads';
import { Session } from 'node:inspector';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { initEngine, buildPokemon } from './harness.js';
import { battleTeams } from './teamBattle.js';
import { applyGroupMoveset } from '../scoring/index.js';
import { BoundedCache } from './boundedCache.js';

if (!parentPort) {
  throw new Error('parallelWorker.js must be run as a worker_thread');
}

// Diagnostic-only, opt-in via createExecutor({ profileDir }) / evolve.mjs's
// --profile flag: a per-worker node:inspector CPU profile spanning this
// worker's entire life, so a real multi-generation run can be inspected the
// same way scripts/bench.mjs's single-process --cpu-prof capture is (see
// src/engine/README.md's Performance section) but across every thread that
// actually did the battling. Started eagerly at init so battle #1 is
// captured too; stopped and flushed only on the graceful 'shutdown' message
// below -- terminate() (used on crash/abrupt close) gives no such chance, so
// profiling only ever produces a file on a clean run.
let profileSession = null;
if (workerData?.profileDir) {
  profileSession = new Session();
  profileSession.connect();
  profileSession.post('Profiler.enable');
  profileSession.post('Profiler.start');
}

// Diagnostic-only, same --profile gate as the CPU profiler above: tracks the
// highest heap this worker has hit, sampled every 5s. Also what backs the
// live per-generation 'stats' poll (see below) -- gated behind --profile,
// same as the CPU profiler, so a run with no interest in this diagnostic
// pays nothing for it. unref()'d so it never keeps the process alive past a
// normal exit.
//
// Why heapUsed and not rss: worker_threads share one OS process, so
// `process.memoryUsage().rss` inside a worker is the WHOLE process's RSS,
// identical in every worker. An earlier version of this file summed it
// across workers and logged "worker RSS 68 GB total" on a 12 GB box -- and
// derived a ~1.5 MB-per-built-Pokemon estimate from that, which is wrong by
// ~100x (measured ~14 KB). heapUsed is per-isolate and is the number that
// actually attributes memory to this worker.
let peakHeapBytes = 0;
let heapTimer = null;
if (workerData?.profileDir) {
  peakHeapBytes = process.memoryUsage().heapUsed;
  heapTimer = setInterval(() => {
    const heap = process.memoryUsage().heapUsed;
    if (heap > peakHeapBytes) peakHeapBytes = heap;
  }, 5000);
  heapTimer.unref();
}

/** Stable cache key for a plain-data mon spec (moveset included -- two specs for the same species/IVs but different explicit movesets must not share a build). */
function monKey(m) {
  const moveset = m.fastMove ? `${m.fastMove}/${(m.chargedMoves || []).join(',')}` : '';
  return `${m.speciesId}|${m.ivs.atk},${m.ivs.def},${m.ivs.hp}|${m.shadow ? 1 : 0}|${m.bestBuddy ? 1 : 0}|${moveset}`;
}

/**
 * Build (or reuse from `cache`) a battle-ready Pokemon for each plain-data
 * mon spec. A cache is per-side (see below) so this worker doesn't rebuild
 * an identical mon on every battle -- teamA is very often the same candidate
 * across many opponents, and teamB is very often the same opponent across
 * many candidates (mirrors how src/evolve/evaluate.js
 * already drives battleTeams).
 */
function buildTeam(ctx, cache, monSpecs) {
  return monSpecs.map((m) => {
    const key = monKey(m);
    let built = cache.get(key);
    if (!built) {
      built = buildPokemon(ctx, {
        speciesId: m.speciesId,
        ivs: m.ivs,
        shadow: !!m.shadow,
        bestBuddy: !!m.bestBuddy,
      });
      // buildPokemon always applies pvpoke's RECOMMENDED moveset; a spec
      // carrying an explicit fastMove (from buildMetaMon, e.g. a curated
      // preset team member) must have that exact moveset reapplied here --
      // otherwise a threaded rebuild silently diverges from what the main
      // thread's serial path would have battled with.
      if (m.fastMove) applyGroupMoveset(built, { fastMove: m.fastMove, chargedMoves: m.chargedMoves });
      cache.set(key, built);
    }
    return built;
  });
}

/** Max distinct built-Pokemon entries kept per side, per worker. The cache is
 * meant to span MANY generations, not one: a mon that keeps reappearing
 * (elites, survivors, recurring opponents) is refreshed on every hit and so
 * never ages out, and the cap only decides how many generations' worth of
 * churned-out mutants stay around before being evicted. A built Pokemon costs
 * ~14 KB of heap (measured 2026-09-09 by heap delta over 300 real builds), so
 * 5000/side at cap is ~70 MB/side, ~140 MB/worker -- bounded and harmless. An
 * earlier revision of this comment put it at ~1.5 MB by correlating the
 * per-worker "RSS" telemetry with cache growth; that telemetry was the whole
 * process's RSS repeated once per worker (see the heap sampler above), so the
 * estimate was ~100x too high. The standard recipe sees at most ~900 distinct
 * teamA and ~360 distinct teamB mons per generation, so a run takes many
 * generations to reach cap at all. Override with `POGO_GBL_WORKER_CACHE=N`;
 * raising it should be paired with parallel.js's WORKER_OLD_GEN_MB. */
const MAX_CACHE_ENTRIES = (() => {
  const n = Number(process.env.POGO_GBL_WORKER_CACHE);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5000;
})();

let ctx = null;
// Split caches for team A and team B: battleTeams requires teamA and teamB
// to be DISTINCT Pokemon instances even when they're the same species+IVs
// (a mirror match) -- see teamBattle.js's header comment. Always building
// teamA from cacheA and teamB from cacheB guarantees that without adding any
// same-battle "is this mon on both sides" bookkeeping.
const cacheA = new BoundedCache(MAX_CACHE_ENTRIES);
const cacheB = new BoundedCache(MAX_CACHE_ENTRIES);

async function init() {
  const initOpts = {};
  if (workerData?.vendorRoot) initOpts.vendorRoot = workerData.vendorRoot;
  if (workerData?.cp !== undefined) initOpts.cp = workerData.cp;
  if (workerData?.cup !== undefined) initOpts.cup = workerData.cup;
  ctx = await initEngine(initOpts);
  parentPort.postMessage({ type: 'ready' });
}

/** Snapshot of this worker's current memo/cache/heap numbers -- the shared
 * shape both the live 'stats' poll (non-destructive, mid-run) and shutdown()
 * (destructive, end-of-run) report. `heapMb`/`peakHeapMb` are THIS isolate's
 * heap (see the note above the sampler); process RSS is the main thread's to
 * report, once. */
function snapshotStats() {
  const memo = ctx?.__teamBattle?.scenarioMemo;
  const heap = process.memoryUsage().heapUsed;
  return {
    memoHits: memo?.hits ?? 0,
    memoMisses: memo?.misses ?? 0,
    memoSize: memo?.map.size ?? 0,
    cacheASize: cacheA.size,
    cacheBSize: cacheB.size,
    heapMb: Math.round(heap / 1048576),
    peakHeapMb: Math.round(Math.max(peakHeapBytes, heap) / 1048576),
  };
}

/** Stop this worker's CPU profiler (if running), flush its .cpuprofile, and
 * report scenario-memo hit/miss counts -- the graceful counterpart to
 * terminate(), which src/engine/parallel.js's close() sends before tearing
 * down the pool so profiling/stats data isn't silently lost. */
function shutdown() {
  if (heapTimer) clearInterval(heapTimer);
  const stats = snapshotStats();
  if (!profileSession) {
    parentPort.postMessage({ type: 'shutdownDone', stats });
    process.exit(0);
    return;
  }
  profileSession.post('Profiler.stop', (err, { profile } = {}) => {
    if (!err && profile) {
      const file = path.join(workerData.profileDir, `worker-${threadId}.cpuprofile`);
      try {
        writeFileSync(file, JSON.stringify(profile));
        stats.profilePath = file;
      } catch (writeErr) {
        stats.profileError = writeErr.message;
      }
    } else if (err) {
      stats.profileError = err.message;
    }
    parentPort.postMessage({ type: 'shutdownDone', stats });
    process.exit(0);
  });
}

parentPort.on('message', (msg) => {
  if (msg.type === 'shutdown') {
    shutdown();
    return;
  }
  if (msg.type === 'stats') {
    // Non-destructive: unlike shutdown() this leaves the CPU profiler (if
    // running) and this worker's caches untouched -- safe to call between
    // battles mid-run for live per-generation memory/speed visibility.
    parentPort.postMessage({ type: 'statsResult', requestId: msg.requestId, stats: snapshotStats() });
    return;
  }
  if (msg.type !== 'battle') return;
  const { id, spec } = msg;
  if (spec.__crashWorker) {
    // Test-only hook (test/parallel.test.js): a spec can ask its worker to
    // die outright, so the pool's crash handling can be exercised without
    // depending on a real engine bug to trigger it.
    process.exit(1);
  }
  try {
    const teamA = buildTeam(ctx, cacheA, spec.teamA);
    const teamB = buildTeam(ctx, cacheB, spec.teamB);
    const result = battleTeams(ctx, {
      teamA,
      teamB,
      leadA: spec.leadA,
      leadB: spec.leadB,
      difficulty: spec.difficulty,
      seed: spec.seed,
    });
    parentPort.postMessage({ type: 'result', id, result });
  } catch (err) {
    parentPort.postMessage({ type: 'battleError', id, message: err.message });
  }
});

init().catch((err) => {
  parentPort.postMessage({ type: 'initError', message: err.message });
  process.exit(1);
});
