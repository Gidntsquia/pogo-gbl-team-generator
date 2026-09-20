// Memoisation of pvpoke's scenario simulations (TrainingAI runScenario), keyed on the full battle state.

import vm from 'node:vm';

// Scenario memo ceiling per engine context (i.e. per worker thread); past it
// the least-recently-used entry is evicted (see createScenarioMemo).
//
// Sized from measurement (2026-09-09, single context, 350 real battles): an
// entry costs ~1.9 KB of heap (a ~277-char key plus the record), and a 20k
// cap produced the IDENTICAL hit count as the old 200k cap -- hits are
// overwhelmingly near in time (the same battle's repeated lookaheads and its
// neighbours), so a deep memo buys nothing but memory. 200k x 8 workers was
// ~3 GB of memo and the single biggest reason evolve-meta-vs-meta-v5 was
// OOM-killed at 8.2 GB RSS on a 12 GB box; 20k is ~40 MB per worker.
// Throughput cost of 20k vs 200k measured at ~7%, vs ~25% for no memo at all.
// Override per context with ctx.scenarioMemoMax before initTeamBattle.
const DEFAULT_SCENARIO_MEMO_MAX = 20000;

/**
 * Memo for pvpoke's TrainingAI#runScenario -- the AI's internal 1v1 lookahead
 * sims. Profiling a 3v3 battle shows ~95% of its CPU goes into these lookaheads
 * (evaluateMatchup runs four scenarios every time a Pokemon enters, decideShield
 * and decideSwitch run more), and the real 3v3 turn loop is a rounding error.
 * The lookahead is a pure function of (scenario type, both Pokemon's build and
 * current battle state), and a candidate team is re-evaluated against many
 * opponents from identical starting states, so the same lookahead is
 * recomputed thousands of times across a run. The memo returns the recorded
 * result instead.
 *
 * Exactness: the only randomness inside a lookahead is Battle#useMove's buff
 * roll (Battle.js:1389). In simulate mode `buffChanceModifier` is -1 and
 * `shieldBuffModifier` 0, so the roll's VALUE can never satisfy the apply
 * condition -- chance buffs apply deterministically via buffApplyMeter -- but
 * the draw still advances the seeded stream. A memo entry therefore records
 * how many draws the lookahead consumed, and a hit replays that many draws, so
 * the outer battle sees the identical random sequence either way. Results with
 * and without the memo are bit-identical (test/e2e.test.js asserts this).
 *
 * The memo lives for the engine context's lifetime and is shared across
 * battles, which is where the win comes from. Entries are small (a short key
 * string plus a handful of numbers); at `max` entries the least-recently-used
 * one is evicted (hits re-insert their key to mark it recent), so hot
 * entries survive overflow instead of the whole memo being wiped at once.
 *
 * Created once per context by initTeamBattle (ctx.__teamBattle.scenarioMemo);
 * setting `ctx.scenarioMemo = false` before the first battle, `battleTeams(ctx,
 * { scenarioMemo: false })`, or the env var POGO_SCENARIO_MEMO=0 runs every
 * lookahead for real instead. `memo.verify = (mismatch) => ...` turns on a
 * diagnostic mode that runs every hit for real as well and reports any
 * disagreement.
 *
 * @param {object} ctx - from initEngine(), after initTeamBattle
 * @param {{ max?: number }} [opts]
 * @returns {{ map: Map<string, {draws:number, rating:number, carried:Array}>, hits: number, misses: number, max: number }}
 */
export function createScenarioMemo(ctx, opts = {}) {
  return {
    map: new Map(),
    hits: 0,
    misses: 0,
    max: opts.max ?? DEFAULT_SCENARIO_MEMO_MAX,
    vmMath: ctx.__teamBattle.vmMath,
    RealBattle: ctx.Battle,
    // `new Battle()` inside TrainingAI resolves the vm global at call time;
    // assign through the vm so the swap lands on the context's own global.
    setGlobalBattle: vm.runInContext('(function (B) { Battle = B; })', ctx.context),
  };
}

/**
 * Everything one inner `simulate()` depends on for one Pokemon, read at the
 * moment simulate() is entered: the build (species, active form, final stats,
 * shadow multiplier, moveset), the start* fields Battle#start's reset() will
 * load (hp/energy/cooldown/shields/buffs/form), the bait/farm flags the
 * scenario type set, and the fields pvpoke's sim reads but never resets
 * (priority, turnsToKO, hasActed, optimizeMoveTiming, chargedMovesOnly,
 * nativeStatBuffs).
 */
function simMonKey(p) {
  const s = p.stats;
  const cm = p.chargedMoves.map((m) => (m ? m.moveId : '-')).join(',');
  return (
    `${p.speciesId}/${p.startFormId}|${s.atk},${s.def},${s.hp}|${p.shadowType}|` +
    `${p.fastMove ? p.fastMove.moveId : '-'}/${cm}|${p.priority}|${p.turnsToKO}|` +
    `${p.baitShields}${p.farmEnergy ? 1 : 0}${p.hasActed ? 1 : 0}` +
    `${p.optimizeMoveTiming ? 1 : 0}${p.chargedMovesOnly ? 1 : 0}|` +
    `${p.startHp},${p.startEnergy},${p.startCooldown},${p.startingShields},` +
    `${p.startStatBuffs[0]},${p.startStatBuffs[1]},${p.nativeStatBuffs[0]},${p.nativeStatBuffs[1]}`
  );
}

/**
 * The state a sim leaves on a Pokemon. runScenario's own restore + reset()
 * put most of it back, but (a) hasActed/turnsToKO/chargedMovesOnly are never
 * reset and leak into the outer battle, and (b) reset() re-initializes
 * pokemon[0]'s moves against pokemon[1]'s not-yet-reset buffs and form, so
 * the post-sim values of everything reset() touches still shape the outer
 * battle. A replayed sim therefore leaves the Pokemon exactly as the real one
 * did.
 */
function readCarried(p) {
  return [
    p.hasActed, p.turnsToKO, p.chargedMovesOnly,
    p.hp, p.energy, p.cooldown, p.shields, p.damageWindow, p.faintSource,
    p.statBuffs[0], p.statBuffs[1], p.activeFormId,
  ];
}

function applyCarried(p, c) {
  p.hasActed = c[0];
  p.turnsToKO = c[1];
  p.chargedMovesOnly = c[2];
  p.hp = c[3];
  p.energy = c[4];
  p.cooldown = c[5];
  p.shields = c[6];
  p.damageWindow = c[7];
  p.faintSource = c[8];
  p.statBuffs = [c[9], c[10]];
  if (p.activeFormId !== c[11]) p.changeForm(c[11]);
}

/**
 * Run pvpoke's runScenario unchanged, but with the vm's global `Battle`
 * temporarily swapped for a factory whose instances have `simulate()` and
 * `getBattleRatings()` intercepted. Every side effect of runScenario on the
 * real Pokemon (start* fields, reset(), move re-initialization against the
 * throwaway battle) happens exactly as it would without the memo; only the
 * individual `simulate()` calls are memoized, each under a key built from both
 * Pokemon's state at that moment (see simMonKey).
 *
 * Miss: simulate() runs for real; the memo records how many seeded draws it
 * consumed, the rating it produced, and the fields it left behind on the two
 * Pokemon (see readCarried). Hit: simulate() is skipped, the recorded draws
 * are replayed against the seeded stream, the carried fields are written
 * back, and getBattleRatings() hands back the recorded rating.
 *
 * Memoizing per sim rather than per scenario matters: pvpoke's NEITHER_BAIT
 * and NO_BAIT scenarios set identical flags, so every evaluateMatchup runs
 * the same sims twice, and a per-sim key serves the second set from memo.
 */
function memoizedScenario(memo, ai, original, type, pokemon, opponent) {
  const { vmMath, RealBattle, setGlobalBattle } = memo;

  function MemoBattle() {
    const b = new RealBattle();
    const realSimulate = b.simulate;
    const realRatings = b.getBattleRatings;
    b.simulate = function () {
      b.getBattleRatings = realRatings;
      const [p0, p1] = b.getPokemon();
      // Battle#start resets pokemon[0] first, and that reset re-initializes
      // its moves against pokemon[1]'s CURRENT (not yet reset) stat buffs and
      // form -- pvpoke's own order dependence, so both go in the key.
      const key = `${simMonKey(p0)}|${simMonKey(p1)}|${p1.activeFormId},${p1.statBuffs[0]},${p1.statBuffs[1]}`;
      const hit = memo.map.get(key);
      if (hit && !memo.verify) {
        memo.hits += 1;
        // Promote to most-recently-used (re-insert at the end) so LRU
        // eviction below doesn't evict hot entries just because they were
        // written a while ago.
        memo.map.delete(key);
        memo.map.set(key, hit);
        for (let i = 0; i < hit.draws; i++) vmMath.random();
        applyCarried(p0, hit.carried[0]);
        applyCarried(p1, hit.carried[1]);
        b.getBattleRatings = () => [hit.rating, 0];
        return [];
      }
      const realRandom = vmMath.random;
      let draws = 0;
      vmMath.random = () => {
        draws += 1;
        return realRandom();
      };
      try {
        realSimulate.call(b);
      } finally {
        vmMath.random = realRandom;
      }
      const rec = { draws, rating: realRatings()[0], carried: [readCarried(p0), readCarried(p1)] };
      if (hit) {
        // memo.verify: diagnostic mode -- run every hit for real too and
        // report any entry whose replay would have disagreed.
        memo.hits += 1;
        if (JSON.stringify(rec) !== JSON.stringify(hit)) memo.verify({ key, rec, hit, p0, p1 });
        return [];
      }
      memo.misses += 1;
      // LRU eviction (Map iterates insertion order, and hits are re-inserted
      // above to stay "recent") -- evict one at a time rather than clearing
      // the whole memo, so hot entries (elites, recurring opponents) survive
      // overflow instead of every lookahead missing until the memo refills.
      if (memo.map.size >= memo.max) memo.map.delete(memo.map.keys().next().value);
      memo.map.set(key, rec);
      return [];
    };
    return b;
  }

  setGlobalBattle(MemoBattle);
  try {
    return original.call(ai, type, pokemon, opponent);
  } finally {
    setGlobalBattle(RealBattle);
  }
}

/**
 * Determinism mechanism 2: pvpoke's own TrainingAI#runScenario
 * (vendor/pvpoke/src/js/training/TrainingAI.js) builds a throwaway
 * single-battle `Battle` to test a shield/bait scenario, and calls that
 * throwaway battle's own setNewPokemon() on the REAL pokemon/opponent
 * instances it's given -- which (via Pokemon#setBattle) repoints their
 * PRIVATE `battle` reference at the throwaway battle. Its own restore block
 * (TrainingAI.js's runScenario, ~921-937) puts back hp/energy/cooldown/
 * shields/stat-buffs/form/index but NOT `.battle`, `.baitShields`, or
 * `.priority` -- so after runScenario returns, the pokemon's private
 * `battle` still points at a battle that no longer exists. A LATER
 * resetMoves() on that same instance (another scenario evaluation, a
 * switch/shield decision, or -- across sequential battleTeams() calls --
 * this module's own next-battle fullReset()) can then read
 * `battle.getOpponent(self.index)` against the wrong (or a torn-down)
 * opponent, and which throwaway battle was "last" depends on the exact
 * order scenarios were evaluated in -- an order that can differ between a
 * serial and a threaded run of the same battle set (see
 * src/engine/README.md's "Known limitation").
 *
 * Fix shape (permitted: wrapping pvpoke's own code is allowed; editing
 * vendor files or reimplementing battle/AI logic is not): wrap runScenario
 * on each battle's two TrainingAI instances so every call snapshots and
 * restores exactly these fields on BOTH its `pokemon` and `opponent`
 * arguments, via pvpoke's own public getBattle()/setBattle() getter/setter
 * (baitShields/farmEnergy/priority are plain public properties). This makes
 * runScenario side-effect-transparent to its caller for state outside its
 * own return value -- every other read of a Pokemon's `battle` already
 * assumes it reflects whichever battle is actually running.
 *
 * Verified harmless to the callers that DO rely on runScenario's
 * baitShields/farmEnergy mutation: evaluateMatchup sets them itself right
 * before calling runScenario (each scenario type sets them again on entry)
 * and finalizes them via processStrategy afterward, never reading the
 * value in between; decideShield only ever reads runScenario's *return
 * value* (`.average`), never the mutated fields.
 *
 * @param {object} ai - a TrainingAI instance (e.g. from Player#getAI())
 * @param {object} [memo] - from createScenarioMemo; omitted = no memoization
 */
export function wrapRunScenario(ai, memo) {
  const original = ai.runScenario;
  ai.runScenario = function (type, pokemon, opponent) {
    const snapshots = [pokemon, opponent].map((mon) => ({
      mon,
      battle: mon.getBattle(),
      baitShields: mon.baitShields,
      farmEnergy: mon.farmEnergy,
      priority: mon.priority,
    }));
    try {
      if (!memo) return original.call(ai, type, pokemon, opponent);
      return memoizedScenario(memo, ai, original, type, pokemon, opponent);
    } finally {
      for (const s of snapshots) {
        s.mon.setBattle(s.battle);
        s.mon.baitShields = s.baitShields;
        s.mon.farmEnergy = s.farmEnergy;
        s.mon.priority = s.priority;
      }
    }
  };
}
