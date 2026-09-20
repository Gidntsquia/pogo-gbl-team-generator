// Wrappers that give both players real-game behaviour pvpoke's TrainingAI lacks: throw-and-go, shield banking, switch cost.

import {
  DEFAULT_THROW_AND_GO_MOVES,
  MAX_TANKABLE_HP_FRACTION,
  NORMAL_TURN_MS,
  SWITCH_TURN_COST_MS,
} from './constants.js';

/**
 * How many turns until `poke` can throw a charged move, starting from `energy`?
 * Defaults to the energy it is holding now, so 0 if it is already loaded.
 * Infinity if it has no charged move to reach, or no way to bank toward one.
 *
 * Pass `0` to ask a different question: how long a WHOLE charge cycle takes.
 * That is the horizon canTankAndAnswer uses, because "can I still throw a move
 * of my own" is only worth asking about a move that is not already in hand.
 *
 * Turns are pvpoke's 500ms turns and the energy-per-turn idiom is pvpoke's own
 * (`energyGain / (cooldown / 500)`, TrainingAI.js:701). Cheapest move, not best
 * move: the question is when it can answer at all, not how well.
 *
 * @param {object} poke
 * @param {number} [energy] - energy to count up from (default: its current)
 * @returns {number}
 */
function turnsToChargedMove(poke, energy = poke.energy) {
  const charged = poke.chargedMoves || [];
  if (!charged.length) return Infinity;
  const cheapest = Math.min(...charged.map((m) => m.energy));

  const energyPerTurn = poke.fastMove.energyGain / (poke.fastMove.cooldown / NORMAL_TURN_MS);
  if (!(energyPerTurn > 0)) return Infinity;

  return Math.max(cheapest - energy, 0) / energyPerTurn;
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
function beingFarmedDown(poke, opponent) {
  if (!poke || !opponent || !poke.fastMove || !opponent.fastMove) return false;

  const incomingDpt = opponent.fastMove.dps;
  if (!(incomingDpt > 0)) return false; // a 0-damage fast move farms nobody down
  const turnsUntilFaint = poke.hp / incomingDpt;

  // Infinity (no charged moves, or a fast move that banks no energy) means the
  // answer never comes, so any finite time-to-faint is a farm-down. Zero
  // (already holding the energy) means it never is, whatever the HP.
  return turnsUntilFaint < turnsToChargedMove(poke);
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
 * Can `defender` afford to take this charged move on the chin -- tank it, and
 * still be alive to throw a charged move of its own afterwards?
 *
 * This is the whole shield-banking rule. It deliberately says nothing about
 * the incoming move being "weak" or "cheap": those were separate thresholds in
 * an earlier version and they are redundant, because a move that is not weak
 * fails the tank test and a move you cannot come back from fails the answer
 * test. What is left is the question a player actually asks -- if I eat this,
 * am I still in the fight?
 *
 * Four conditions:
 *
 * NOT TOO BIG: `incoming.damage <= defender.stats.hp * MAX_TANKABLE_HP_FRACTION`.
 * A blunt ceiling that overrides the arithmetic below. Some hits are simply not
 * for tanking however the sums come out, and a rule with no ceiling will find
 * a case: Araquanid on 122 of 134 declining a 108-damage Meteor Beam, because
 * the 14 HP left survives 14 turns of 1-damage chip.
 *
 * TANK IT: `defender.hp - incoming.damage > 0`. A shield you have to spend to
 * survive is not a shield you were ever banking.
 *
 * STILL ANSWER: what is left outlives the wait for the defender's own next
 * charged move -- a full charge cycle, `turnsToChargedMove(defender, 0)`.
 * Counting a whole cycle, rather than the wait from whatever energy the
 * defender happens to be holding, is load-bearing. The from-current-energy
 * version reads 0 turns for anything already loaded, which makes "I can still
 * throw" trivially true and licenses declining a shield that leaves 2 HP on
 * the board -- measured, that was 349 of 786 declines across the pool. A move
 * already in hand is not "another move of my own".
 *
 * SURVIVE WHAT ARRIVES IN THAT WINDOW: not just fast-move chip. The attacker
 * banks energy through the same turns and throws again, and a window that
 * ignores that is not telling the truth about whether the defender can tank
 * and answer -- measured, 44% of the declines this rule made without the term
 * (291 of 662) were dead before their own move landed if those follow-ups
 * landed unblocked.
 *
 * They mostly do not land unblocked, though, and that is the point of
 * declining: the shield this rule just kept is still in hand when the next
 * charged move arrives. So the follow-ups are counted against
 * `defender.shields` first, and only the ones past that do damage. Since
 * decideShield is only ever asked when the defender has at least one shield,
 * a single follow-up inside the window is always covered; the term bites when
 * the attacker can fit more charged moves into the window than the defender
 * has shields to answer them with.
 *
 * `beingFarmedDown` is the same shape -- does this Pokemon reach its own next
 * move before it is chipped out -- asked about now rather than about the HP
 * left after one more hit. They share turnsToChargedMove.
 *
 * The caller also has to have something in the back -- see wrapShieldBanking.
 * Everything else (which move the attacker is even guessed to be holding, the
 * matchup rating, last-Pokemon protection) stays pvpoke's decision; this only
 * ever turns a yes into a no.
 *
 * @param {object} defender - the Pokemon deciding whether to shield
 * @param {object} attacker
 * @param {{ damage: number, energy: number }} incoming - the charged move
 *   being thrown right now, and what it costs the attacker
 * @param {number} fastDamage - the attacker's fast-move damage per hit (turned
 *   into a per-turn rate here using that move's own cooldown)
 * @param {{ damage: number, energy: number }} [followUp] - the attacker's
 *   cheapest charged move, i.e. what it can get back to inside the window.
 *   Omit to count fast-move chip only.
 * @returns {boolean}
 */
function canTankAndAnswer(defender, attacker, incoming, fastDamage, followUp) {
  if (!defender || !attacker || !defender.fastMove || !attacker.fastMove) return false;
  if (!incoming || !(incoming.damage >= 0)) return false;

  // However the sums come out, some hits are not for tanking.
  if (incoming.damage > defender.stats.hp * MAX_TANKABLE_HP_FRACTION) return false;

  const hpAfterHit = defender.hp - incoming.damage;
  if (hpAfterHit <= 0) return false; // cannot tank it

  const turnsToAnswer = turnsToChargedMove(defender, 0);
  if (!Number.isFinite(turnsToAnswer)) return false; // no answer to hold out for

  const chipPerTurn = fastDamage / (attacker.fastMove.cooldown / NORMAL_TURN_MS);
  let incomingInWindow = chipPerTurn > 0 ? chipPerTurn * turnsToAnswer : 0;

  // What else the attacker can throw before the defender's own move lands.
  // Energy left after this move, plus what its fast move banks in the window.
  if (followUp && followUp.energy > 0 && followUp.damage > 0) {
    const energyPerTurn =
      attacker.fastMove.energyGain / (attacker.fastMove.cooldown / NORMAL_TURN_MS);
    const energyLeft = Math.max((attacker.energy || 0) - (incoming.energy || 0), 0);
    const banked = energyPerTurn > 0 ? energyPerTurn * turnsToAnswer : 0;
    const throws = Math.floor((energyLeft + banked) / followUp.energy);
    // Declining keeps the shield, so it is still there for the next one.
    const unblocked = Math.max(throws - (defender.shields || 0), 0);
    incomingInWindow += unblocked * followUp.damage;
  }

  return hpAfterHit > incomingInWindow;
}

/**
 * Bank shields for both players: don't spend one on a hit you can take.
 *
 * Wraps each AI's decideShield and turns a yes into a no when the defender can
 * tank the move and still answer with a charged move of its own (see
 * canTankAndAnswer) AND this player is in a position for a banked shield to be
 * worth something -- it has a Pokemon in the back. A no is never turned into
 * a yes, and pvpoke's own decision is always computed first -- both so the
 * last-Pokemon protection and matchup weighting still apply, and so the
 * seeded RNG is consumed in exactly the same order as stock, which keeps an
 * A/B against `bankShields: false` a comparison of this rule alone.
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
      // Endgame. A banked shield is only worth something if this player has
      // a later Pokemon to spend it on. As the last Pokemon there is no
      // later at all -- shielding stops here regardless of body count on
      // either side, because a shield banked now and never spent is the
      // failure this stands aside to avoid. Being behind on bodies with a
      // bench left is not the same story: there is still a later, so the
      // matchup math below gets to run.
      const remaining = player.getRemainingPokemon();
      if (remaining <= 1) return decision;
      if (!attacker || !defender || !move) return decision;

      const incoming = {
        damage: DamageCalculator.damage(attacker, defender, move, true),
        energy: move.energy,
      };
      const fastDamage = attacker.fastMove
        ? DamageCalculator.damage(attacker, defender, attacker.fastMove, true)
        : 0;
      // What the attacker can get back to soonest -- its cheapest charged move
      // by energy, which is the one that fits inside the window.
      const cheapest = (attacker.chargedMoves || []).reduce(
        (best, m) => (best === null || m.energy < best.energy ? m : best),
        null
      );
      const followUp = cheapest
        ? {
            damage: DamageCalculator.damage(attacker, defender, cheapest, true),
            energy: cheapest.energy,
          }
        : undefined;

      if (canTankAndAnswer(defender, attacker, incoming, fastDamage, followUp)) {
        declined[player.getIndex()] += 1;
        return false;
      }
      return decision;
    };
  }

  return declined;
}

/**
 * Charge an ordinary switch the turn it costs in the real game, and don't
 * charge the three switches that are genuinely free.
 *
 * pvpoke models no switch cost at all. The Pokemon coming in arrives on
 * cooldown 0 and acts on the next turn exactly as the one it replaced would
 * have, so switching only ever costs the single action spent on it. Real GBL
 * charges more than that: the Pokemon coming in has to sit through the switch
 * animation, so the opponent gets a free turn on top. That is the "1-turn
 * switch", and it is why switching in neutral is a real concession.
 *
 * Three switches skip it, because they happen inside a window where nobody was
 * going to act anyway:
 *
 *   1. Immediately after a charged move resolves. Tracked by stamping the turn
 *      on every charged useMove: pvpoke re-steps the same turn index once a
 *      charged move has resolved, so a switch processed on that same turn is
 *      one taken inside the window. Either side's charged move opens it.
 *   2. Immediately after a faint. pvpoke already routes these differently
 *      (Battle.js:1005, the `poke.hp > 0` else-branch), and the replacement is
 *      free in game.
 *   3. At the start of the battle. Leads are placed with a direct
 *      setNewPokemon call, never through processAction, so they never reach
 *      this code at all.
 *
 * The AI is not told about any of this. TrainingAI has no switch-cost model
 * and would need one to weigh the concession properly; what this changes is
 * what a switch actually COSTS, not how either side decides to make one. The
 * one place it feeds back is pvpoke's own switch validity check
 * (`poke.cooldown == 0`, Battle.js:504), which now correctly stops a Pokemon
 * from switching straight back out while it is still arriving.
 *
 * @param {object} battle - the pvpoke Battle for this match
 * @param {{ enabled?: boolean }} [opts]
 * @returns {{ costly: number[], free: number[] }} live per-player-index counts
 */
export function wrapSwitchCost(battle, opts = {}) {
  const enabled = opts.enabled !== false;
  const counts = { costly: [0, 0], free: [0, 0] };
  // The turn a charged move last resolved on, either side. -1 so turn 0 (which
  // pvpoke never uses; battles start at turn 1) cannot match by accident.
  let lastChargedTurn = -1;

  const realUseMove = battle.useMove;
  battle.useMove = function (attacker, defender, move) {
    const result = realUseMove.apply(this, arguments);
    if (move && move.energy > 0) lastChargedTurn = battle.getTurns();
    return result;
  };

  const realProcessAction = battle.processAction;
  battle.processAction = function (action, poke, opponent) {
    // Read this BEFORE the real call: processAction sets action.processed, and
    // poke.hp is what tells a voluntary switch from a replacement after a
    // faint (Battle.js:1005 branches on exactly this).
    const isSwitch = !!action && action.type === 'switch' && action.valid && !action.processed;
    const afterFaint = isSwitch && poke.hp < 1;
    const index = isSwitch ? poke.index : -1;

    const result = realProcessAction.apply(this, arguments);
    if (!isSwitch) return result;

    const free = afterFaint || battle.getTurns() === lastChargedTurn;
    if (free) {
      counts.free[index] += 1;
      return result;
    }
    counts.costly[index] += 1;

    if (enabled) {
      const incoming = battle.getPokemon()[index];
      // Guard against a switch pvpoke declined to carry out: only stamp the
      // cooldown when the Pokemon on the field actually changed.
      if (incoming && incoming !== poke) incoming.cooldown = SWITCH_TURN_COST_MS;
    }
    return result;
  };

  return counts;
}
