
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
      return { hits, misses, size: results.size, dropped };
    },
  };
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
