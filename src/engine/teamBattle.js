// JavaScript Document
//
// Headless 3v3 team-battle driver. Runs pvpoke's own Training-mode
// ("emulate") team battles in Node -- the real GBL 3v3 engine, with pvpoke's
// TrainingAI making every lead/shield/switch/charged-move decision on both
// sides. No battle math, AI logic, or shield/switch heuristics are
// reimplemented here: this module only provides (1) a deterministic virtual
// clock so pvpoke's timer-driven emulate flow can be stepped synchronously,
// (2) a seeded Math.random so the TrainingAI's randomized decisions are
// reproducible, and (3) symmetric wiring so BOTH players are AI-controlled
// (pvpoke's emulate mode is built for human-vs-AI and hardcodes a few
// player-1-only hooks; we mirror them for player 0). See README.md.

import vm from 'node:vm';
import { loadTrainingModules } from './pvpokeLoader.js';

const TIME_LIMIT_MS = 240000; // pvpoke's own battle time limit (Battle.js)
const DEFAULT_DIFFICULTY = 3; // aiArchetypes.json index 3 = "Champion" (highest)
const NORMAL_TURN_MS = 500; // pvpoke's own deltaTime (Battle.js)
// pvpoke's chargedMinigameTime (Battle.js:56) is 10000, but a charged-move
// round does not also spend its own 500ms turn tick, so a charged move nets
// 9500ms on the clock. Measured directly off pvpoke's own simulate() path:
// a 1v1 Thievul/Talonflame battle ran 33 turns with 5 charged moves and
// reported duration 64000ms == 33*500 + 5*9500. See wrapBattleClock.
const CHARGED_MOVE_CLOCK_MS = 9500;

// Reaction time, in milliseconds, for BOTH players. pvpoke stores this per
// AI archetype in TURNS (aiArchetypes.json: Novice 12, Rival 8, Elite 4,
// Champion 0) and gates switch execution on it in TrainingAI#decideAction
// (TrainingAI.js:1062). We express it in ms and divide by the 500ms turn so
// the knob reads in the same units a player thinks in; 200ms is under one
// turn, so its practical effect is that a decision formed on turn T is
// executed no earlier than turn T+1 -- a switch can never be tapped inside
// the same 500ms window it was decided in, which is what Champion's 0 allowed.
const DEFAULT_REACTION_TIME_MS = 200;

// Throw-and-go: number of charged moves a Pokemon lands (since it switched
// in) before it swaps out to bank the energy advantage. 2 is the standard
// GBL line -- throw twice, then leave on the switch. See wrapThrowAndGo.
const DEFAULT_THROW_AND_GO_MOVES = 2;

// Shield banking. A shield blocks exactly one hit, so it is worth whatever
// that hit would have cost you -- and a shield you still hold when your
// closer comes in is worth a whole extra matchup. pvpoke's TrainingAI has no
// model of either: decideShield weighs the move in front of it and nothing
// else, and its one clause that could preserve a shield ("Preserve shield
// advantage", TrainingAI.js:1310) is gated on `defender.battleStats.shieldsUsed
// > 0`, so it can never stop the FIRST shield -- the one that actually gives
// away the advantage. These two thresholds define the moves not worth a
// shield: weak (takes at most this share of a full health bar) and cheap (low
// enough energy that the attacker will simply have it again). Bubble Beam
// (25p/40e) and Night Slash (50p/35e) are the archetypes. See isCheapChip.
const WEAK_MOVE_HP_FRACTION = 0.35;
const CHEAP_MOVE_ENERGY = 45;

/**
 * Small deterministic mulberry32 PRNG. Given the same 32-bit seed it yields
 * the same sequence, which is what makes a whole team battle reproducible.
 * @param {number} seed
 * @returns {() => number}
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cheap string hash -> 32-bit int, for deriving a default seed from teams. */
function hashSeed(str) {
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
function makeScheduler() {
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

/**
 * One-time setup of the team-battle capability on an engine context: loads
 * pvpoke's Player/TrainingAI/DecisionOption modules and installs the virtual
 * clock + seeded RNG hooks into the vm. Safe to call repeatedly; the work is
 * done once and cached on ctx.__teamBattle.
 *
 * @param {object} ctx - from initEngine()
 * @returns {object} ctx (with ctx.Player, ctx.TrainingAI, ctx.__teamBattle)
 */
export function initTeamBattle(ctx) {
  if (ctx.__teamBattle) return ctx;

  const { Player, TrainingAI } = loadTrainingModules(ctx.context, ctx.vendorRoot);

  const scheduler = makeScheduler();
  // Route the vm's timers through our virtual clock. setInterval is only used
  // by pvpoke's own emulate() main loop, which we never call (we step the
  // battle by hand), so it is a hard no-op here.
  ctx.context.setTimeout = (fn, delay) => scheduler.setTimeout(fn, delay);
  ctx.context.clearTimeout = (id) => scheduler.clearTimeout(id);
  ctx.context.setInterval = () => 0;
  ctx.context.clearInterval = () => undefined;

  // pvpoke's emulate path has a few stray debug console.log() calls
  // (Player.startSwitchTimer, Battle.setNewPokemon) that would spam stdout on
  // every battle. Silence log/info/debug in the vm while keeping warn/error so
  // real problems (e.g. "ERROR: Can't find move") still surface.
  const realConsole = ctx.context.console || console;
  ctx.context.console = {
    log: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    warn: (...a) => realConsole.warn(...a),
    error: (...a) => realConsole.error(...a),
  };

  // Grab the vm's own Math so we can swap in a seeded random per battle.
  const vmMath = vm.runInContext('Math', ctx.context);

  ctx.Player = Player;
  ctx.TrainingAI = TrainingAI;
  // TimelineAction is a plain `function` declaration inside the sandbox, so
  // it is not an own-property of the context object -- read it back through
  // the vm. wrapThrowAndGo constructs switch actions with it.
  const TimelineAction = vm.runInContext('TimelineAction', ctx.context);
  // Same story for DamageCalculator (a `class` declaration in the sandbox):
  // not an own-property of the context. wrapShieldBanking asks it what a move
  // would actually do right now, the same call decideShield itself makes
  // (TrainingAI.js:1205), so buffs and shadow forms are pvpoke's problem.
  const DamageCalculator = vm.runInContext('DamageCalculator', ctx.context);

  // TrainingAI captures `props = aiData[level]` BY REFERENCE at construction
  // (TrainingAI.js:20), so mutating a field on the archetype object retunes
  // every AI built from it -- both players, this battle and later ones. Keep
  // the pristine values so setReactionTime(ctx, level, null) can restore them.
  const aiData = ctx.context.aiData;
  const baseReactionTimes = aiData.map((a) => a.reactionTime);

  ctx.__teamBattle = {
    scheduler,
    vmMath,
    TimelineAction,
    DamageCalculator,
    aiData,
    baseReactionTimes,
  };
  return ctx;
}

/**
 * GOALS T20b (determinism mechanism 2): pvpoke's own TrainingAI#runScenario
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
 */
export function wrapRunScenario(ai) {
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
      return original.call(ai, type, pokemon, opponent);
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

/**
 * Order a team array so the chosen lead sits at index 0 (pvpoke uses
 * getTeam()[0] as the starting Pokemon). Returns a shallow copy; the same
 * Pokemon instances are reused, just reordered.
 */
function orderWithLead(team, leadIndex) {
  if (leadIndex < 0 || leadIndex >= team.length) {
    throw new Error(
      `battleTeams: lead index ${leadIndex} out of range for team of ${team.length}`
    );
  }
  const rest = team.filter((_, i) => i !== leadIndex);
  return [team[leadIndex], ...rest];
}

/**
 * Make a Battle's clock agree with pvpoke's own simulate() clock.
 *
 * pvpoke charges a fixed `chargedMinigameTime` (Battle.js:56, 10000ms) to the
 * battle clock for every charged move, on top of the 500ms a normal turn
 * costs. That constant is right -- a charged move really does eat ~10s of the
 * 240s GBL clock. But in EMULATE mode (the mode this module runs, and the only
 * one that plays 3v3) it is charged TWICE per move:
 *
 *   Battle#processAction's "charged" case (Battle.js:909-985) calls
 *   `self.useMove(...)` synchronously in simulate mode, but in emulate mode
 *   defers it to a `setTimeout(..., 8000)` -- and in BOTH modes it runs
 *   `roundChargedMoveUsed++` after that branch. Battle#useMove (Battle.js:1069)
 *   then charges another `chargedMinigameTime` when
 *   `usePriority && roundChargedMoveUsed > 0 && roundShieldUsed == 0`.
 *   In simulate mode useMove runs BEFORE the increment, so that guard is false
 *   for the round's first charged move and only Battle#step's own charge
 *   (Battle.js:522-531) applies -- 10s total, correct. In emulate mode the
 *   counter is already 1 by the time the deferred useMove fires, so the guard
 *   is true and the same 10s lands a second time -- 20s total (10s when the
 *   move faints the defender, so ~17s on average).
 *
 * Measured on the same Thievul/Talonflame pair: pvpoke's simulate() spends
 * 9,500ms per charged move; this driver spent ~17,000ms. The consequence is
 * that the turn loop's `getDuration() <= TIME_LIMIT_MS` guard fired far too
 * early: 72.2% of a 234-battle curated-pool run ended by "timeout" rather than
 * KO, at a mean of 84.9 turns. With the clock corrected, that is 0.9%.
 *
 * The fix has to live here: vendor/pvpoke is read-only and Battle's `time` is
 * a closure-private variable, so the double charge cannot be undone in place.
 * Instead we replace the battle's own `getDuration()` with the same arithmetic
 * simulate() produces. This is a clock/termination policy, not battle math --
 * no damage, AI, shield or switch logic is touched, and the turn-by-turn
 * simulation is byte-for-byte pvpoke's. Safe to override because `getDuration`
 * is read nowhere inside pvpoke's battle engine: only by its own UI
 * (Interface.js) and TeamRanker.js, neither of which this project calls, plus
 * this module's turn-loop guard and `summary.duration`.
 *
 * NOTE: `summary.duration` therefore now reports the corrected clock. Results
 * recorded before this change are not comparable -- an A/B over the curated
 * pool changed 16.2% of battle outcomes (38/234).
 *
 * @param {object} battle - a pvpoke Battle instance, before `start()`
 * @returns {object} the same battle
 */
export function wrapBattleClock(battle) {
  let chargedMoves = 0;
  const realUseMove = battle.useMove;

  battle.useMove = function (attacker, defender, move) {
    if (move && move.energy > 0) chargedMoves += 1;
    return realUseMove.apply(this, arguments);
  };

  battle.getDuration = function () {
    return (battle.getTurns() - 1) * NORMAL_TURN_MS + chargedMoves * CHARGED_MOVE_CLOCK_MS;
  };

  return battle;
}

/**
 * Set the AI reaction time, in milliseconds, for BOTH players.
 *
 * pvpoke's TrainingAI reads `props.reactionTime` in TURNS and uses it in one
 * place: TrainingAI.js:1062, which refuses to execute a SWITCH_BASIC decision
 * until `turn - turnLastEvaluated >= props.reactionTime`. `turnLastEvaluated`
 * is stamped by evaluateMatchup (TrainingAI.js:806-810), which runs on every
 * switch-in for both sides (Battle#setNewPokemon, Battle.js:112-119) and on
 * every switch-timer expiry -- so this is exactly "how long after seeing the
 * board change can this player act on it".
 *
 * Champion ships reactionTime 0, i.e. it may switch on the very turn it
 * evaluated -- an instant, superhuman read. Anything in (0, 500] ms converts
 * to a sub-turn value that still forces the decision to land on the FOLLOWING
 * turn, which is the floor for a human holding a phone. Larger values scale
 * linearly: 1000ms = 2 turns of lag, and so on.
 *
 * `props` is captured by reference from the shared aiArchetypes array at
 * TrainingAI construction, so this retunes every AI at that level -- which is
 * what "for all players, friendly and enemy" requires, since battleTeams
 * builds both Players at the same difficulty. Pass ms = null to restore
 * pvpoke's own archetype value.
 *
 * @param {object} ctx - from initEngine() (must be initTeamBattle'd)
 * @param {number} difficulty - aiArchetypes index (0-3)
 * @param {number|null} ms - reaction time in milliseconds, or null to reset
 * @returns {number} the turn-denominated value actually written
 */
export function setReactionTime(ctx, difficulty, ms) {
  const { aiData, baseReactionTimes } = ctx.__teamBattle;
  const archetype = aiData[difficulty];
  if (!archetype) throw new Error(`setReactionTime: no AI archetype at index ${difficulty}`);

  const turns = ms === null || ms === undefined
    ? baseReactionTimes[difficulty]
    : ms / NORMAL_TURN_MS;

  archetype.reactionTime = turns;
  return turns;
}

/**
 * Is this Pokemon being "farmed down"? That is: would the opponent's fast-move
 * chip damage finish it BEFORE its own fast moves could bank enough energy to
 * answer with another charged move?
 *
 * This is the precise sense of the term, and it is the whole reason a player
 * throws and then leaves. A Pokemon that can still reach a charged move has an
 * answer and should stay and use it. One that cannot is just standing there
 * absorbing chip damage with nothing to give back -- so it leaves, having
 * already spent its energy on the way out rather than taking it to the grave.
 *
 * Deliberately fast-move-only and energy-based, rather than "who wins the HP
 * race": an HP race has no margin in it, so a Pokemon one point behind an even
 * matchup reads as losing and bails out of a fight it is not actually losing.
 * That failure is visible immediately in a mirror match, where both identical
 * sides want to leave at once.
 *
 * Every input is pvpoke's own, computed against the CURRENT opponent and
 * refreshed by resetMoves() for both actives on every switch-in
 * (Battle.js:110-112): `fastMove.dps` is damage per 500ms turn (Pokemon.js:842
 * -- pvpoke's own comment on the field reads "I guess this really damage per
 * turn"), and energy per turn is `energyGain / (cooldown / 500)`, the same
 * expression TrainingAI.js:701 uses.
 *
 * @param {object} poke - the active Pokemon deciding whether to stay
 * @param {object} opponent - the Pokemon across from it
 * @returns {boolean} true if it faints before it could throw again
 */
export function beingFarmedDown(poke, opponent) {
  if (!poke || !opponent || !poke.fastMove || !opponent.fastMove) return false;

  const incomingDpt = opponent.fastMove.dps;
  if (!(incomingDpt > 0)) return false; // a 0-damage fast move farms nobody down
  const turnsUntilFaint = poke.hp / incomingDpt;

  const charged = poke.chargedMoves || [];
  if (!charged.length) return true; // nothing to answer with, ever
  const cheapest = Math.min(...charged.map((m) => m.energy));

  const energyPerTurn = poke.fastMove.energyGain / (poke.fastMove.cooldown / NORMAL_TURN_MS);
  if (!(energyPerTurn > 0)) return true;

  // Already holding enough energy => zero turns to an answer => never farmed
  // down, whatever its HP is.
  const turnsUntilAnswer = Math.max(cheapest - poke.energy, 0) / energyPerTurn;

  return turnsUntilFaint < turnsUntilAnswer;
}

/**
 * Teach both AIs the throw-and-go: land N charged moves, then immediately
 * swap out.
 *
 * This is a real GBL line pvpoke's TrainingAI does not model. Its only
 * switching motive is "I am losing this matchup" -- switchWeight is
 * `Math.floor(Math.max((switchThreshold - overallRating) / 10, 0))`
 * (TrainingAI.js:660), which is 0 whenever the AI is at or above a 500
 * rating. So an AI that is WINNING never leaves, and therefore never converts
 * a pair of charged moves into a free switch. (Champion's archetype does list
 * SWITCH_ADVANCED and SACRIFICIAL_SWAP among its strategies, but neither
 * string is referenced anywhere in TrainingAI.js -- they are unimplemented.)
 *
 * The human line: throw two charged moves, forcing shields or damage, then
 * leave on the switch before the opponent can punish. The switching player
 * banks the energy their incoming Pokemon accrues while the opponent spends a
 * turn or more reacting, and keeps the mon that just spent its energy alive.
 *
 * Implemented entirely by wrapping, per pvpoke's read-only rule:
 *   - `battle.useMove` counts charged moves per attacker (`move.energy > 0`);
 *   - `battle.setNewPokemon` zeroes that counter on every switch-in, so the
 *     count is always "charged moves thrown during THIS stint on the field"
 *     and a Pokemon that comes back later can throw-and-go again;
 *   - each `ai.decideAction` returns a "switch" TimelineAction -- built the
 *     same way TrainingAI.js:1073 builds its own -- when the counter is met.
 *     The switch target is pvpoke's own `ai.decideSwitch()`; we choose the
 *     TIMING, never the target.
 *
 * Spending the energy is only half of it -- the other half is having a REASON
 * to leave. A Pokemon that can still answer with another charged move should
 * stay in and answer; only one that would be FARMED DOWN first has to go. So
 * the swap additionally requires `beingFarmedDown(poke, opponent)`. That gate
 * is the whole difference between a throw-and-go and simply abandoning a
 * matchup, and it is what keeps a fast-charging attacker from throwing twice
 * and then walking away from a lead it was winning.
 *
 * The remaining preconditions mirror what a player can actually do: the switch
 * clock must be up (`getSwitchTimer() == 0`), there must be a live bench mon,
 * and the opponent must still be alive -- nobody swaps away from a Pokemon
 * they just knocked out, since the free turns are worth more.
 *
 * Reaction time deliberately does NOT gate this. It models how long it takes
 * to react to something the OPPONENT did; the throw-and-go is self-initiated,
 * already decided before the charged move was thrown. Gating it anyway is not
 * a harmless conservatism -- it actively breaks the behavior. pvpoke re-steps
 * the same turn index after a charged move resolves, so `turn - readyTurn` is
 * still 0 on the step where the swap should happen. Blocking that step hands
 * the AI straight to its fast-move fallback, and a long fast move (Incinerate,
 * 5 turns) then locks it out of deciding anything until it has been farmed
 * down several more turns -- observed on the Talonflame line this was built
 * for: eligible at T29, blocked, locked into Incinerate, next decision at T34
 * on 4 HP.
 *
 * @param {object} battle - the pvpoke Battle for this match
 * @param {object[]} players - [p0, p1]
 * @param {Function} TimelineAction - the sandbox's TimelineAction constructor
 * @param {{ moves?: number }} [opts]
 *   moves: charged moves before swapping (default 2; 0 disables entirely)
 * @returns {number[]} a live per-player-index count of throw-and-go switches
 *   that were actually carried out, for auditing how often the behavior fires
 */
export function wrapThrowAndGo(battle, players, TimelineAction, opts = {}) {
  const moves = opts.moves ?? DEFAULT_THROW_AND_GO_MOVES;
  const fired = players.map(() => 0);
  // Per-player "we returned a throw-and-go switch and it has not been carried
  // out yet". pvpoke can still reject the action (Battle.js:504-508), and a
  // Pokemon that faints on the same turn switches out for a different reason,
  // so `fired` must count switches that actually HAPPENED, not intentions.
  const pending = players.map(() => false);
  if (!moves || moves < 1) return fired;

  const realUseMove = battle.useMove;
  battle.useMove = function (attacker, defender, move) {
    const result = realUseMove.apply(this, arguments);
    // Count AFTER the move resolves: a charged move that faints the defender
    // still counts, but the opponent-alive gate below then declines the swap.
    if (attacker && move && move.energy > 0) {
      attacker.chargedSinceSwitchIn = (attacker.chargedSinceSwitchIn || 0) + 1;
    }
    return result;
  };

  const realSetNewPokemon = battle.setNewPokemon;
  battle.setNewPokemon = function (pokemon, index) {
    // Count the swap only if the Pokemon leaving the field is the one that
    // asked to leave AND is walking off alive -- a faint on the same turn is
    // pvpoke's forced switch, not a throw-and-go.
    if (pending[index]) {
      const outgoing = battle.getPokemon()[index];
      if (outgoing && outgoing.hp > 0) fired[index] += 1;
      pending[index] = false;
    }
    if (pokemon) pokemon.chargedSinceSwitchIn = 0;
    return realSetNewPokemon.apply(this, arguments);
  };

  for (const player of players) {
    const ai = player.getAI();
    if (!ai) continue;
    const realDecideAction = ai.decideAction;

    ai.decideAction = function (turn, poke, opponent) {
      const index = player.getIndex();
      pending[index] = false;

      if (
        poke &&
        poke.hp > 0 &&
        (poke.chargedSinceSwitchIn || 0) >= moves &&
        player.getSwitchTimer() === 0 &&
        player.getRemainingPokemon() > 1 &&
        opponent &&
        opponent.hp > 0 &&
        beingFarmedDown(poke, opponent)
      ) {
        const choice = ai.decideSwitch();
        if (choice !== null && choice !== undefined) {
          pending[index] = true;
          return new TimelineAction('switch', index, turn, choice, {
            priority: poke.priority,
          });
        }
      }
      return realDecideAction.call(this, turn, poke, opponent);
    };
  }

  return fired;
}

/**
 * Is this charged move cheap chip -- weak enough, and cheap enough, that a
 * shield spent on it is wasted?
 *
 * Three things have to be true at once.
 *
 * WEAK: the move takes at most WEAK_MOVE_HP_FRACTION of a full health bar.
 * Measured against `stats.hp`, not current HP, deliberately: a shield's value
 * is the damage it blocks, which does not grow just because the defender is
 * already hurt. Against a 130 HP Thievul this splits Night Slash (41, 0.32)
 * from Fly (63, 0.48) and Brave Bird (103, 0.79) exactly where a player would.
 *
 * CHEAP: the move costs at most CHEAP_MOVE_ENERGY. This is what makes the
 * shield a bad trade rather than merely a small one -- block a 35-energy move
 * and the attacker is most of the way back to throwing it again, so the shield
 * bought a delay, not a matchup. An expensive move is a much bigger share of
 * the attacker's whole battle and is worth blocking even when it hits softly.
 *
 * AFFORDABLE: the defender survives the move plus the two fast hits that
 * follow it. That is pvpoke's own definition of a move being "hard hitting or
 * knockout" (`moveDamage + fastMoveDamage * 2 >= defender.hp`,
 * TrainingAI.js:1264), used here as its strict inverse -- a shield is only
 * declined on a move pvpoke itself would not class as dangerous. A stricter
 * test was tried first (survive TWO copies of the move, chip included) and is
 * wrong: it demands a full extra cycle of health, which nothing below about
 * 90% HP has against even a weak move, so it declined almost nothing. It kept
 * shielding the exact hit this rule exists to decline -- Talonflame at 86/135
 * putting a shield on a 41-damage Night Slash.
 *
 * The caller also has to have something in the back -- see wrapShieldBanking.
 * Everything else (which move the attacker is even guessed to be holding, the
 * matchup rating, last-Pokemon protection) stays pvpoke's decision; this only
 * ever turns a yes into a no.
 *
 * @param {object} defender - the Pokemon deciding whether to shield
 * @param {object} move - the charged move being thrown at it
 * @param {number} moveDamage - what that move would do right now
 * @param {number} fastDamage - the attacker's fast move damage per hit
 * @returns {boolean}
 */
export function isCheapChip(defender, move, moveDamage, fastDamage) {
  if (!defender || !move) return false;
  if (!(moveDamage > 0)) return false;
  if (!(move.energy > 0) || move.energy > CHEAP_MOVE_ENERGY) return false;
  if (moveDamage > defender.stats.hp * WEAK_MOVE_HP_FRACTION) return false;
  const chip = fastDamage > 0 ? fastDamage * 2 : 0;
  return moveDamage + chip < defender.hp;
}

/**
 * Bank shields against weak, cheap moves, symmetrically for both players.
 *
 * Wraps each AI's decideShield and turns a yes into a no when the incoming
 * move is cheap chip (see isCheapChip) AND the player still has a Pokemon in
 * the back for the banked shield to be worth something to. A no is never
 * turned into a yes, and pvpoke's own decision is always computed first --
 * both so the last-Pokemon protection and matchup weighting still apply, and
 * so the seeded RNG is consumed in exactly the same order as stock, which
 * keeps an A/B against `bankShields: false` a comparison of this rule alone.
 *
 * @param {object[]} players - [p0, p1]
 * @param {object} DamageCalculator - the sandbox's DamageCalculator class
 * @param {{ enabled?: boolean }} [opts]
 * @returns {number[]} a live per-player-index count of shields declined
 */
export function wrapShieldBanking(players, DamageCalculator, opts = {}) {
  const declined = players.map(() => 0);
  if (opts.enabled === false) return declined;

  for (const player of players) {
    const ai = player.getAI();
    if (!ai) continue;
    const realDecideShield = ai.decideShield;

    ai.decideShield = function (attacker, defender, move) {
      const decision = realDecideShield.apply(this, arguments);
      if (!decision) return decision;
      // Nothing behind this Pokemon means the shield has no later value; that
      // is the whole reason to hold it, so stand aside and let pvpoke shield.
      if (player.getRemainingPokemon() <= 1) return decision;
      if (!attacker || !defender || !move) return decision;

      const moveDamage = DamageCalculator.damage(attacker, defender, move, true);
      const fastDamage = attacker.fastMove
        ? DamageCalculator.damage(attacker, defender, attacker.fastMove, true)
        : 0;

      if (isCheapChip(defender, move, moveDamage, fastDamage)) {
        declined[player.getIndex()] += 1;
        return false;
      }
      return decision;
    };
  }

  return declined;
}

/**
 * Run one full 3v3 team battle using pvpoke's emulate engine, headless.
 *
 * teamA and teamB are arrays of battle-ready pvpoke Pokemon (from
 * buildPokemon). They must be DISTINCT instances from each other (pvpoke
 * mutates `.index`/battle state on the objects it is given, so a Pokemon may
 * not appear in both teams); for a mirror match, build the same species twice.
 * Both teams are reset at the start of every call, so instances may be reused
 * across sequential battleTeams calls.
 *
 * Both sides are driven by pvpoke's TrainingAI at the given difficulty (0-3,
 * default 3 = "Champion", the strongest). The battle is deterministic for a
 * given (teams, leads, difficulty, seed); when seed is omitted it is derived
 * from the matchup so repeated calls with the same inputs still agree.
 *
 * Three behaviors are layered on top of pvpoke's AI, symmetrically for both
 * players, because pvpoke's Training AI does not model them:
 *   - reactionTimeMs (default 200): how long after the board changes either
 *     player may act on it. See setReactionTime.
 *   - throwAndGoMoves (default 2): land this many charged moves, then swap
 *     out. Pass 0 for pvpoke's stock behavior. See wrapThrowAndGo.
 *   - bankShields (default true): don't spend a shield on a weak, cheap move
 *     while there is still a Pokemon in the back. Pass false for pvpoke's
 *     stock shielding. See wrapShieldBanking.
 *
 * @param {object} ctx - from initEngine() (initTeamBattle is applied lazily)
 * @param {{
 *   teamA: object[], teamB: object[],
 *   leadA?: number, leadB?: number,
 *   difficulty?: number, seed?: number,
 *   reactionTimeMs?: number, throwAndGoMoves?: number, bankShields?: boolean
 * }} params
 * @returns {{
 *   winner: 'a'|'b'|'tie',
 *   survivorsHp: { a: number, b: number, aPerMon: number[], bPerMon: number[] },
 *   summary: {
 *     remainingA: number, remainingB: number,
 *     turns: number, duration: number,
 *     leadA: number, leadB: number, difficulty: number, seed: number,
 *     reactionTimeMs: number, throwAndGoMoves: number, bankShields: boolean,
 *     throwAndGoSwitchesA: number, throwAndGoSwitchesB: number,
 *     shieldsDeclinedA: number, shieldsDeclinedB: number,
 *     endedBy: 'ko'|'timeout',
 *     leadFaintTurnA: number|null, leadFaintTurnB: number|null,
 *     shieldsRemainingA: number, shieldsRemainingB: number
 *   }
 * }}
 */
export function battleTeams(ctx, params) {
  const {
    teamA,
    teamB,
    leadA = 0,
    leadB = 0,
    difficulty = DEFAULT_DIFFICULTY,
    seed,
    reactionTimeMs = DEFAULT_REACTION_TIME_MS,
    throwAndGoMoves = DEFAULT_THROW_AND_GO_MOVES,
    bankShields = true,
  } = params;

  if (!Array.isArray(teamA) || !Array.isArray(teamB) || !teamA.length || !teamB.length) {
    throw new Error('battleTeams: teamA and teamB must be non-empty arrays of Pokemon');
  }

  initTeamBattle(ctx);
  const { Player, Battle } = ctx;
  const { scheduler, vmMath, TimelineAction, DamageCalculator } = ctx.__teamBattle;

  // Deterministic RNG for this battle (seeds every TrainingAI random choice).
  const effectiveSeed =
    seed !== undefined
      ? seed >>> 0
      : hashSeed(
          teamA.map((p) => p.speciesId).join(',') +
            '|' +
            teamB.map((p) => p.speciesId).join(',') +
            `|${leadA}:${leadB}:${difficulty}`
        );
  scheduler.reset();
  vmMath.random = mulberry32(effectiveSeed);

  // A fresh Battle per match (pvpoke's own MatchHandler/BattleInterface do the
  // same). Defaults are Great League: cp 1500, levelCap 50, cup "all".
  const battle = new Battle();
  // Correct pvpoke's emulate-mode double charge of chargedMinigameTime before
  // anything reads the clock (see wrapBattleClock).
  wrapBattleClock(battle);
  // GOALS T18c: match the harness's CP cap (initEngine's opts.cp) so the
  // battle reports the league it's actually running. Safe here for the same
  // reason it is in initEngine -- setCP re-initializes any Pokemon already on
  // the Battle, and this one has none yet.
  if (ctx.cp) battle.setCP(ctx.cp);

  const orderedA = orderWithLead(teamA, leadA);
  const orderedB = orderWithLead(teamB, leadB);

  // Retune the shared archetype BEFORE the Players (and their AIs) are built,
  // so both sides read the same reaction time. See setReactionTime.
  setReactionTime(ctx, difficulty, reactionTimeMs);

  const p0 = new Player(0, difficulty, battle);
  const p1 = new Player(1, difficulty, battle);
  // GOALS T20b: make runScenario's battle/baitShields/farmEnergy/priority
  // mutations side-effect-transparent (see wrapRunScenario's own doc comment).
  wrapRunScenario(p0.getAI());
  wrapRunScenario(p1.getAI());
  // Throw-and-go for both sides -- installed before the leads are set so the
  // setNewPokemon wrapper zeroes their counters too (see wrapThrowAndGo).
  const throwAndGoFired = wrapThrowAndGo(battle, [p0, p1], TimelineAction, {
    moves: throwAndGoMoves,
  });
  // Shield banking for both sides (see wrapShieldBanking).
  const shieldsDeclined = wrapShieldBanking([p0, p1], DamageCalculator, {
    enabled: bankShields,
  });
  p0.setRoster(orderedA);
  p0.setTeam(orderedA);
  p1.setRoster(orderedB);
  p1.setTeam(orderedB);

  // GOALS T20b (determinism mechanism 2): baitShields/farmEnergy/priority are
  // never touched by fullReset()/setRoster() -- only by pvpoke's own
  // setNewPokemon()/evaluateMatchup(), which only run for whichever Pokemon
  // is actually ACTIVE at some point. A bench member that stays benched the
  // whole battle (or that was itself a lead in this instance's LAST battle)
  // otherwise starts this battle still carrying those fields from an
  // unrelated matchup -- proven directly: instrumenting a real reproduced
  // flip (variance-study's "4|4|2|2" battle) showed the bench members'
  // baitShields/priority differing (0/1 vs pvpoke's own documented defaults
  // 1/0) between a battle run fresh vs. run after 332 prior battles, with
  // active-lead pre-battle state (index/bestChargedMove/move damage/dpe --
  // T20's own fix) confirmed bit-identical in both cases. Stamp pvpoke's own
  // constructor defaults (Pokemon.js: baitShields=1, farmEnergy=false,
  // priority=0) on all six members before anything reads them; the lead-only
  // setNewPokemon calls below and evaluateMatchup's own unconditional reset
  // correctly override these for whichever Pokemon actually leads or later
  // switches in, so this only changes behavior for Pokemon that stay benched.
  //
  // Follow-up (same fire, routine 2026-08-22): `hasActed` belongs in this
  // same reset for the same reason -- also constructor-defaulted (`false`,
  // Pokemon.js:109), also never touched by reset()/fullReset(), and
  // Battle#step()'s own per-turn `poke.hasActed = false` (Battle.js:300)
  // only clears it for the two currently-ACTIVE `pokemon[]` slots, never a
  // bench member. A stale `hasActed=true` carried in from a previous battle
  // where this instance was active can make Battle#getTurnAction's
  // `! poke.hasActed` gate (Battle.js:749) treat a just-switched-in mon as
  // having already acted this turn -- an independent state leak from the 3
  // fields above, same root shape, same fix.
  for (const mon of [...orderedA, ...orderedB]) {
    mon.baitShields = 1;
    mon.farmEnergy = false;
    mon.priority = 0;
    mon.hasActed = false;
    // Same cross-battle leak shape as the four fields above: wrapThrowAndGo's
    // counter lives on the Pokemon instance and nothing in pvpoke's own
    // reset()/fullReset() clears it, so a bench member could otherwise start
    // this battle already "ready" to throw-and-go from a previous one.
    mon.chargedSinceSwitchIn = 0;
  }

  battle.setBattleMode('emulate');
  battle.setTurns(1);
  battle.setPlayers([p0, p1]);
  battle.setNewPokemon(orderedA[0], 0, false);
  battle.setNewPokemon(orderedB[0], 1, false);

  // --- Symmetric AI wiring -------------------------------------------------
  // pvpoke's emulate mode assumes player 0 is a human and hardwires a few
  // AI hooks to player 1 only. We drive both sides with the AI, so we mirror
  // those hooks for player 0.

  // (1) On-faint switching. Battle.forceSwitch() switches in the first
  // available Pokemon (the human fallback). Override it so any fainted,
  // AI-controlled player uses TrainingAI.decideSwitch() instead. Fainted
  // actors are exactly the active Pokemon at 0 HP (no need for the private
  // phaseProps). queueAction dedupes per actor, so if player 1's own AI
  // switch was already queued (via the shorter timer that fires first), this
  // leaves it untouched and only fills in player 0.
  battle.forceSwitch = function () {
    const active = battle.getPokemon();
    const players = battle.getPlayers();
    for (let i = 0; i < active.length; i++) {
      if (active[i] && active[i].hp <= 0) {
        const ai = players[i].getAI();
        let choice = null;
        if (ai) {
          choice = ai.decideSwitch();
        }
        if (choice === null || choice === undefined) {
          // Fallback: first available bench Pokemon (matches pvpoke default).
          const team = players[i].getTeam();
          for (let n = 0; n < team.length; n++) {
            if (team[n].hp > 0) {
              choice = n;
              break;
            }
          }
        }
        if (choice !== null && choice !== undefined) {
          battle.queueAction(i, 'switch', choice);
        }
      }
    }
  };

  // (2) Switch-timer matchup re-evaluation. Player.decrementSwitchTimer only
  // re-evaluates the matchup for player index 1 when the switch clock expires.
  // Mirror that for player 0 so both AIs refresh their strategy on the same
  // cadence.
  p0.decrementSwitchTimer = function (deltaTime) {
    let evaluateMatchup = false;
    if (this.switchTimer <= deltaTime && this.switchTimer > 0) {
      evaluateMatchup = true;
    }
    this.switchTimer = Math.max(this.switchTimer - deltaTime, 0);
    if (evaluateMatchup) {
      this.ai.evaluateMatchup(
        battle.getTurns(),
        battle.getPokemon()[0],
        battle.getPokemon()[1],
        battle.getPlayers()[1]
      );
    }
  };

  // --- Emulate setup (mirrors Battle.emulate()'s head, minus the DOM/timer
  // main loop, and symmetric across both players) ---------------------------
  p0.reset();
  p1.reset();
  // GOALS T20: bench members never went through setNewPokemon (only the two
  // leads do, above), so their fullReset() -> resetMoves() -> initializeMove()
  // (Pokemon.js:831-839) reads a stale PRIVATE `battle`/`index` left over from
  // whatever context last built/battled that instance -- frequently a shared
  // scoring-pipeline battle from an unrelated matchup -- and the
  // bestChargedMove DPE tie-break can flip depending on that leftover
  // opponent. Stamp all 6 members with the same public setters
  // Battle#setNewPokemon itself uses (Battle.js:82-120) before resetting them,
  // so every member's tie-break sees THIS battle's real opponent.
  for (const mon of orderedA) {
    mon.setBattle(battle);
    mon.index = 0;
  }
  for (const mon of orderedB) {
    mon.setBattle(battle);
    mon.index = 1;
  }
  for (const mon of orderedA) mon.fullReset();
  for (const mon of orderedB) mon.fullReset();
  battle.getPokemon().forEach((mon) => mon.setBattle(battle));

  battle.start();
  // sandbox=true is what makes the engine honor the AI's shield decisions
  // (forceShields) in emulate useMove; setSandboxMode also sets
  // buffChanceModifier=-1, so restore it to 0 to match emulate()'s own state
  // (probabilistic buffs apply at their normal chance).
  battle.setSandboxMode(true);
  battle.setBuffChanceModifier(0);

  // Initial matchup evaluation for BOTH players (emulate() does player 1 only).
  const active = battle.getPokemon();
  p0.getAI().evaluateMatchup(battle.getTurns(), active[0], active[1], p1);
  p1.getAI().evaluateMatchup(battle.getTurns(), active[1], active[0], p0);

  // --- Turn loop -----------------------------------------------------------
  // GOALS T27 (alignment/lead-exchange investigation): track the first turn
  // each side's ORIGINAL LEAD (orderedA[0]/orderedB[0]) reaches 0 HP. A
  // Pokemon's `.hp` is a plain instance field that only ever decreases (pvpoke
  // never revives a fainted mon mid-battle), and it still reflects reality
  // even while the mon is benched after switching out -- so polling it once
  // per turn, for exactly these two instances, is enough to date each lead's
  // faint without touching vendor code or reimplementing any battle logic.
  const leadPokemonA = orderedA[0];
  const leadPokemonB = orderedB[0];
  let leadFaintTurnA = null;
  let leadFaintTurnB = null;

  let guard = 0;
  while (
    p0.getRemainingPokemon() > 0 &&
    p1.getRemainingPokemon() > 0 &&
    battle.getDuration() <= TIME_LIMIT_MS
  ) {
    if (guard++ > 5000) {
      throw new Error('teamBattle: turn loop runaway (no resolution)');
    }
    battle.step();
    // Resolve any charged-move / switch suspensions synchronously.
    scheduler.drain();
    const turnNow = battle.getTurns() - 1;
    if (leadFaintTurnA === null && leadPokemonA.hp <= 0) leadFaintTurnA = turnNow;
    if (leadFaintTurnB === null && leadPokemonB.hp <= 0) leadFaintTurnB = turnNow;
  }

  const remainingA = p0.getRemainingPokemon();
  const remainingB = p1.getRemainingPokemon();
  const aPerMon = orderedA.map((m) => Math.max(0, Math.round(m.hp)));
  const bPerMon = orderedB.map((m) => Math.max(0, Math.round(m.hp)));
  const hpA = aPerMon.reduce((s, h) => s + h, 0);
  const hpB = bPerMon.reduce((s, h) => s + h, 0);

  let winner;
  if (remainingA > remainingB) winner = 'a';
  else if (remainingB > remainingA) winner = 'b';
  else if (hpA > hpB) winner = 'a';
  else if (hpB > hpA) winner = 'b';
  else winner = 'tie';

  const endedBy =
    remainingA === 0 || remainingB === 0 ? 'ko' : 'timeout';

  return {
    winner,
    survivorsHp: { a: hpA, b: hpB, aPerMon, bPerMon },
    summary: {
      remainingA,
      remainingB,
      turns: battle.getTurns() - 1,
      duration: battle.getDuration(),
      leadA,
      leadB,
      difficulty,
      seed: effectiveSeed,
      reactionTimeMs,
      throwAndGoMoves,
      bankShields,
      throwAndGoSwitchesA: throwAndGoFired[0],
      throwAndGoSwitchesB: throwAndGoFired[1],
      shieldsDeclinedA: shieldsDeclined[0],
      shieldsDeclinedB: shieldsDeclined[1],
      endedBy,
      // GOALS T27: lead-exchange + shield-banking ground truth, read off
      // pvpoke's own live objects (no vendor edits, no battle math added).
      leadFaintTurnA,
      leadFaintTurnB,
      shieldsRemainingA: p0.getShields(),
      shieldsRemainingB: p1.getShields(),
    },
  };
}
