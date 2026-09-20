// Wrappers that fix pvpoke's battle clock, reaction time and lead ordering for headless play.

import { CHARGED_MOVE_CLOCK_MS, NORMAL_TURN_MS } from './constants.js';

/**
 * Order a team array so the chosen lead sits at index 0 (pvpoke uses
 * getTeam()[0] as the starting Pokemon). Returns a shallow copy; the same
 * Pokemon instances are reused, just reordered.
 */
export function orderWithLead(team, leadIndex) {
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
