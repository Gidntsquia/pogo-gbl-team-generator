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
// GOALS T19: this file's protocol was already batch-agnostic -- a worker has
// no notion of where one `run()` call ends and the next begins, it just
// answers `{type:'battle', id, spec}` messages with `result`/`battleError`
// responses indefinitely -- so createExecutor's persistent pool needed ZERO
// changes here to be reused across many run() calls. One notable side effect
// worth knowing about: cacheA/cacheB (below) now persist for the pool's
// entire lifetime rather than just one runBattles() call, so a long-lived
// executor reused across many batches (e.g. a future multi-stage tournament
// run, GOALS T21) will build any given mon at most once per worker ever,
// not once per batch -- a nice bonus, but also means the cache can grow
// across a very large number of DISTINCT mons over a long-lived executor's
// life; nothing here bounds/evicts it (not needed by anything T19 requires,
// flagged for whoever tunes a long-running pool later).
//
// Pokemon instances built in one thread's vm context cannot be sent to
// another thread (postMessage's structured clone doesn't preserve class
// instances/methods, and a vm context is tied to its own V8 isolate anyway),
// so specs travel as plain data -- {speciesId, ivs, shadow, bestBuddy,
// fastMove?, chargedMoves?} per mon -- and each worker rebuilds + caches its
// own Pokemon instances. See src/engine/parallel.js's header comment for why
// the cache is split into cacheA/cacheB (mirror-match distinctness).
// fastMove/chargedMoves (GOALS T15b), when present, are reapplied via
// src/scoring/index.js's applyGroupMoveset -- buildPokemon alone always
// selects pvpoke's RECOMMENDED moveset, which is not what a buildMetaMon-built
// mon (e.g. a curated preset team member) necessarily carries.

import { parentPort, workerData } from 'node:worker_threads';
import { initEngine, buildPokemon } from './harness.js';
import { battleTeams } from './teamBattle.js';
import { applyGroupMoveset } from '../scoring/index.js';

if (!parentPort) {
  throw new Error('parallelWorker.js must be run as a worker_thread');
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
 * many candidates (mirrors how src/teams/index.js and scripts/tournament.mjs
 * already drive battleTeams).
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

let ctx = null;
// Split caches for team A and team B: battleTeams requires teamA and teamB
// to be DISTINCT Pokemon instances even when they're the same species+IVs
// (a mirror match) -- see teamBattle.js's header comment. Always building
// teamA from cacheA and teamB from cacheB guarantees that without adding any
// same-battle "is this mon on both sides" bookkeeping.
const cacheA = new Map();
const cacheB = new Map();

async function init() {
  ctx = await initEngine(workerData?.vendorRoot ? { vendorRoot: workerData.vendorRoot } : {});
  parentPort.postMessage({ type: 'ready' });
}

parentPort.on('message', (msg) => {
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
