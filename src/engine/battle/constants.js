// Timing and AI-behaviour constants for the team-battle driver (see ../teamBattle.js).


export const TIME_LIMIT_MS = 240000; // pvpoke's own battle time limit (Battle.js)

export const DEFAULT_DIFFICULTY = 3; // aiArchetypes.json index 3 = "Champion" (highest)

export const NORMAL_TURN_MS = 500; // pvpoke's own deltaTime (Battle.js)

// pvpoke's chargedMinigameTime (Battle.js:56) is 10000, but a charged-move
// round does not also spend its own 500ms turn tick, so a charged move nets
// 9500ms on the clock. Measured directly off pvpoke's own simulate() path:
// a 1v1 Thievul/Talonflame battle ran 33 turns with 5 charged moves and
// reported duration 64000ms == 33*500 + 5*9500. See wrapBattleClock.
export const CHARGED_MOVE_CLOCK_MS = 9500;

// Reaction time, in milliseconds, for BOTH players. pvpoke stores this per
// AI archetype in TURNS (aiArchetypes.json: Novice 12, Rival 8, Elite 4,
// Champion 0) and gates switch execution on it in TrainingAI#decideAction
// (TrainingAI.js:1062). We express it in ms and divide by the 500ms turn so
// the knob reads in the same units a player thinks in; 200ms is under one
// turn, so its practical effect is that a decision formed on turn T is
// executed no earlier than turn T+1 -- a switch can never be tapped inside
// the same 500ms window it was decided in, which is what Champion's 0 allowed.
export const DEFAULT_REACTION_TIME_MS = 200;

// Throw-and-go: number of charged moves a Pokemon lands (since it switched
// in) before it swaps out to bank the energy advantage. 2 is the standard
// GBL line -- throw twice, then leave on the switch. See wrapThrowAndGo.
export const DEFAULT_THROW_AND_GO_MOVES = 2;

// The turn a switch costs the Pokemon coming in. pvpoke charges nothing: the
// incoming Pokemon arrives on cooldown 0 (Pokemon.js:1836, startCooldown = 0)
// and acts on the very next turn, so in pvpoke every switch is a free one. In
// the real game an ordinary switch is a 1-turn disadvantage -- the Pokemon
// coming in has to wait out the switch animation while the opponent keeps
// attacking. 1000ms, not 500: Battle#step decrements every cooldown by one
// turn (Battle.js:296) BEFORE reading it, so 500 would already be spent by the
// time anything looks at it. See wrapSwitchCost for the three cases that are
// genuinely free.
export const SWITCH_TURN_COST_MS = 1000;

// Shield banking. A shield blocks exactly one hit, so it is worth whatever
// that hit would have cost you -- and a shield you still hold when your
// closer comes in is worth a whole extra matchup. pvpoke's TrainingAI has no
// model of either: decideShield weighs the move in front of it and nothing
// else, and its one clause that could preserve a shield ("Preserve shield
// advantage", TrainingAI.js:1310) is gated on `defender.battleStats.shieldsUsed
// > 0`, so it can never stop the FIRST shield -- the one that actually gives
// away the advantage. See canTankAndAnswer.
//
// The common-sense ceiling on top of that rule: however good the arithmetic
// looks, a hit taking more than half a full health bar gets shielded. Araquanid
// does not tank a Meteor Beam. Measured against stats.hp, like everything else
// here, because it is a statement about how big the hit is, not about how much
// of a hurt Pokemon is left.
export const MAX_TANKABLE_HP_FRACTION = 0.5;
