import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import path from 'node:path';

// Memo-cache ceiling. Measured (2026-08-26, heap-delta over a real run) at
// 289 bytes per trimmed entry plus its interned key, so a FULL cache is about
// 578 MB of main-process heap -- affordable for a run big enough to reach it,
// and well inside node's default old-space, but not free. Smaller runs never
// come close: a 120-generation run at the sizes Jaxon actually uses lands
// around a million distinct pairings, ~290 MB.
// Past the cap the cache simply stops accepting new entries -- see
// createBattleCache for why there is no eviction.
export const BATTLE_CACHE_MAX_ENTRIES = 2_000_000;

/** Stable key for one plain-data mon spec. Mirrors src/engine/parallelWorker.js's own `monKey` -- same fields, same order, for the same reason (two specs differing only in an explicit moveset are different mons). */
function monSpecKey(m) {
  const moveset = m.fastMove ? `${m.fastMove}/${(m.chargedMoves || []).join(',')}` : '';
  return `${m.speciesId}|${m.ivs.atk},${m.ivs.def},${m.ivs.hp}|${m.shadow ? 1 : 0}|${m.bestBuddy ? 1 : 0}|${moveset}`;
}

/**
 * The battle-result fields anything downstream of `evaluateTeamsInOrder`
 * actually reads. Cached entries are trimmed to exactly this shape so a long
 * run's cache stays a few tens of MB instead of a few hundred: `winner`,
 * `survivorsHp.{a,b,aPerMon}` (win/loss, HP margin, and the per-member
 * switched-in HP the safe-swap stat needs), and the two `summary` fields the
 * lead-exchange classifier reads. ADDING A NEW CONSUMER OF SOME OTHER
 * `summary` FIELD MEANS ADDING IT HERE TOO -- otherwise it silently reads
 * `undefined` on a cache hit.
 */
function trimBattleResult(r) {
  return {
    winner: r.winner,
    // bPerMon (added v13, alongside aPerMon) so mirrorBattleResult can turn a
    // cached FORWARD hit into a valid reversed-direction result without a
    // missing field -- the two-direction elites pass runs with trackLeads.
    survivorsHp: {
      a: r.survivorsHp.a,
      b: r.survivorsHp.b,
      aPerMon: r.survivorsHp.aPerMon,
      bPerMon: r.survivorsHp.bPerMon,
    },
    summary: { leadFaintTurnA: r.summary.leadFaintTurnA, leadFaintTurnB: r.summary.leadFaintTurnB },
  };
}

/**
 * Create the run-scoped battle memo. Team specs are interned to small integer
 * ids so a cache key is ~15 characters rather than the ~250 a pair of full
 * spec lists would cost -- at a million entries that is the difference
 * between tens and hundreds of megabytes of keys alone.
 *
 * @param {number} maxEntries - stop inserting past this many results (the
 *   cache degrades to "some misses" rather than growing without bound; there
 *   is no eviction, because the entries most worth keeping are the oldest --
 *   long-surviving elites against long-surviving opponents).
 */
export function createBattleCache(maxEntries) {
  const teamIds = new Map();
  const results = new Map();
  let hits = 0;
  let misses = 0;
  let dropped = 0;
  let diskHits = 0; // distinct entries loaded from a previous run's file that this run used
  const preloaded = new Set();

  function teamId(specs) {
    const key = specs.map(monSpecKey).join(';');
    let id = teamIds.get(key);
    if (id === undefined) {
      id = teamIds.size;
      teamIds.set(key, id);
    }
    return id;
  }

  return {
    keyFor(teamASpec, leadA, teamBSpec, leadB, difficulty) {
      return `${teamId(teamASpec)}:${leadA}|${teamId(teamBSpec)}:${leadB}|${difficulty ?? ''}`;
    },
    get(key) {
      const hit = results.get(key);
      if (hit === undefined) {
        misses += 1;
        return undefined;
      }
      hits += 1;
      if (preloaded.delete(key)) diskHits += 1; // counted once per entry: battles this run did not re-simulate
      return hit;
    },
    set(key, result) {
      if (results.size >= maxEntries) {
        dropped += 1;
        return;
      }
      results.set(key, trimBattleResult(result));
    },
    stats() {
      return { hits, misses, size: results.size, dropped, diskHits };
    },
    /**
     * Load entries saved by `exportState` (a previous run's cache). Must run
     * before the first `keyFor`, because keys embed interned team ids and the
     * saved ids are only valid when interned in the same order.
     * @param {{teams:string[], entries:Array<[string, object]>}} state
     */
    importState(state) {
      if (teamIds.size || results.size) throw new Error('battle cache: importState must run on an empty cache');
      state.teams.forEach((key, i) => teamIds.set(key, i));
      for (const [key, value] of state.entries) {
        if (results.size >= maxEntries) break;
        results.set(key, value);
        preloaded.add(key);
      }
    },
    /** Every entry plus the team-id table its keys refer to, as plain JSON-able data. */
    exportState() {
      return { teams: [...teamIds.keys()], entries: [...results.entries()] };
    },
  };
}

/** On-disk format version of a saved battle cache (`--battle-cache-file`). */
export const BATTLE_CACHE_FILE_VERSION = 1;

/**
 * Load a saved battle cache into a fresh `createBattleCache` instance. A
 * battle's result is a pure function of its key (teams, leads, difficulty; the
 * engine derives the RNG seed from the matchup), so entries from another run
 * are exactly what this run would compute -- provided the league matches,
 * which `scope` (cp/cup) guards. A missing file or a scope mismatch loads
 * nothing.
 * @returns {{loaded:number, reason:string|null}}
 */
export function loadBattleCacheFile(cache, file, scope) {
  if (!existsSync(file)) return { loaded: 0, reason: 'no file yet' };
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (data.version !== BATTLE_CACHE_FILE_VERSION) return { loaded: 0, reason: `version ${data.version} != ${BATTLE_CACHE_FILE_VERSION}` };
  if (data.scope !== scope) return { loaded: 0, reason: `scope ${data.scope} != ${scope}` };
  cache.importState(data);
  return { loaded: cache.stats().size, reason: null };
}

/** Save a battle cache for later runs (atomic: temp file + rename). */
export function saveBattleCacheFile(cache, file, scope) {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const { teams, entries } = cache.exportState();
  // Written piecewise: a single JSON.stringify of a million-entry cache can exceed V8's max string length.
  const fd = openSync(tmp, 'w');
  writeSync(fd, `{"version":${BATTLE_CACHE_FILE_VERSION},"scope":${JSON.stringify(scope)},"teams":${JSON.stringify(teams)},"entries":[`);
  for (let i = 0; i < entries.length; i += 10000) {
    const chunk = entries.slice(i, i + 10000).map((e) => JSON.stringify(e)).join(',');
    writeSync(fd, (i ? ',' : '') + chunk);
  }
  writeSync(fd, ']}');
  closeSync(fd);
  renameSync(tmp, file);
}

/**
 * Cache-disabled stand-in with the same shape, so the battle loop has exactly
 * one code path. Every `keyFor` call returns a fresh unique string, so
 * nothing is ever a hit AND nothing is ever deduplicated within a batch
 * either -- `--no-battle-cache` reproduces the pre-cache behavior exactly,
 * including re-fighting a pairing that appears twice in the same generation.
 */
export function createNullBattleCache() {
  let n = 0;
  return {
    disabled: true,
    keyFor: () => `uncached-${n++}`,
    get: () => undefined,
    set: () => undefined,
    stats: () => ({ hits: 0, misses: 0, size: 0, dropped: 0 }),
  };
}
