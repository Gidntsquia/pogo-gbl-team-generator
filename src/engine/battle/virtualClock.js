// Seeded PRNG and the synchronous virtual clock that stands in for pvpoke's timers.


/**
 * Small deterministic mulberry32 PRNG. Given the same 32-bit seed it yields
 * the same sequence, which is what makes a whole team battle reproducible.
 * @param {number} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cheap string hash -> 32-bit int, for deriving a default seed from teams. */
export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * A virtual-time timer queue that replaces setTimeout/clearTimeout inside the
 * pvpoke vm. pvpoke's emulate mode schedules charged-move animation phases
 * (~6-10s) and the on-faint switch window (~2-13s) with real setTimeout; on a
 * real page those fire on the wall clock while a 500ms setInterval steps the
 * battle. Headless, we step the battle ourselves and drain() these timers in
 * fire-time order between steps -- reproducing the exact ordering pvpoke
 * relies on (e.g. the AI's ~2-5s switch choice firing before the 13s
 * force-switch fallback) without any real waiting.
 */
export function makeScheduler() {
  let clock = 0;
  let nextId = 1;
  const timers = new Map();

  return {
    setTimeout(fn, delay) {
      const id = nextId++;
      timers.set(id, { fireAt: clock + (delay > 0 ? delay : 0), fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    /** Fire every pending timer in (fireAt, id) order until the queue drains. */
    drain() {
      let guard = 0;
      while (timers.size > 0) {
        if (guard++ > 100000) {
          throw new Error('teamBattle: virtual timer drain runaway');
        }
        let bestId = null;
        let best = null;
        for (const [id, t] of timers) {
          if (
            best === null ||
            t.fireAt < best.fireAt ||
            (t.fireAt === best.fireAt && id < bestId)
          ) {
            best = t;
            bestId = id;
          }
        }
        timers.delete(bestId);
        clock = best.fireAt;
        best.fn();
      }
    },
    reset() {
      clock = 0;
      nextId = 1;
      timers.clear();
    },
  };
}
