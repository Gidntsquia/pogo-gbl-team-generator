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
  ctx.__teamBattle = { scheduler, vmMath };
  return ctx;
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
 * @param {object} ctx - from initEngine() (initTeamBattle is applied lazily)
 * @param {{
 *   teamA: object[], teamB: object[],
 *   leadA?: number, leadB?: number,
 *   difficulty?: number, seed?: number
 * }} params
 * @returns {{
 *   winner: 'a'|'b'|'tie',
 *   survivorsHp: { a: number, b: number, aPerMon: number[], bPerMon: number[] },
 *   summary: {
 *     remainingA: number, remainingB: number,
 *     turns: number, duration: number,
 *     leadA: number, leadB: number, difficulty: number, seed: number,
 *     endedBy: 'ko'|'timeout'
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
  } = params;

  if (!Array.isArray(teamA) || !Array.isArray(teamB) || !teamA.length || !teamB.length) {
    throw new Error('battleTeams: teamA and teamB must be non-empty arrays of Pokemon');
  }

  initTeamBattle(ctx);
  const { Player, Battle } = ctx;
  const { scheduler, vmMath } = ctx.__teamBattle;

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

  const orderedA = orderWithLead(teamA, leadA);
  const orderedB = orderWithLead(teamB, leadB);

  const p0 = new Player(0, difficulty, battle);
  const p1 = new Player(1, difficulty, battle);
  p0.setRoster(orderedA);
  p0.setTeam(orderedA);
  p1.setRoster(orderedB);
  p1.setTeam(orderedB);

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
      endedBy,
    },
  };
}
