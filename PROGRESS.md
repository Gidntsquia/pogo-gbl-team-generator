# PROGRESS — append-only run log (newest entry LAST; never edit past entries)

## 2026-08-24 — AI fidelity: 200ms reaction time + throw-and-go (interactive, with Jaxon)
Follow-on to the same session's battle-clock fix (`1d16f1d`). Jaxon audited a
full turn-by-turn trace of Thievul/Araquanid/Stunfisk vs Talonflame/Greninja/
Empoleon and named two things pvpoke's TrainingAI does not model. Both are now
in `src/engine/teamBattle.js`, both symmetric across the two players, both
implemented by wrapping — `vendor/pvpoke` untouched.

**1. Reaction time (`reactionTimeMs`, default 200).** `setReactionTime(ctx,
difficulty, ms)` writes `ms / 500` onto the shared aiArchetypes object, which
TrainingAI captures by reference at construction (`props = aiData[l]`,
TrainingAI.js:20) — so one write retunes both players. pvpoke reads it in one
place, TrainingAI.js:1062, which blocks a SWITCH_BASIC decision until
`turn - turnLastEvaluated >= props.reactionTime`. Champion ships 0, i.e. it may
switch on the very turn it evaluated the matchup; 200ms is sub-turn but still
non-zero, so the decision now lands no earlier than the following turn. Pass
`null` to restore pvpoke's own archetype value (the pristine values are
captured once in `initTeamBattle`).

**2. Throw-and-go (`throwAndGoMoves`, default 2).** Land N charged moves, then
swap out. pvpoke's only switching motive is "I am losing" — `switchWeight =
Math.floor(Math.max((switchThreshold - overallRating) / 10, 0))`
(TrainingAI.js:660) is 0 for any AI at or above a 500 rating, so an AI that is
WINNING never leaves and never converts two charged moves into a free switch.
(Champion's archetype lists SWITCH_ADVANCED and SACRIFICIAL_SWAP, but neither
string appears anywhere else in TrainingAI.js — unimplemented.) `wrapThrowAndGo`
counts charged moves per attacker off `battle.useMove`, zeroes the counter on
every `setNewPokemon` (so the count means "this stint on the field" and a mon
can throw-and-go again on a later stint), and returns a switch TimelineAction
from `ai.decideAction`. The switch TARGET is pvpoke's own `ai.decideSwitch()`
— only the TIMING is ours. Gated on: switch clock up, a live bench mon, and the
opponent still alive (nobody swaps away from a mon they just KO'd).
`summary.throwAndGoSwitchesA/B` report how often it actually fired.

**Measured**, candidate team vs the full 78-team pool × 3 mirrored lead
pairings (234 battles), all three configs identical apart from the two knobs:

| config | win rate | throw-and-go switches | timeouts |
|---|---|---|---|
| stock (rt=0, tag off) | 123/234 = 52.6% | 0 | 2 |
| rt=200 only | 120/234 = 51.3% | 0 | 2 |
| rt=200 + tag=2 (new default) | 113/234 = 48.3% | 231 (0.99/battle) | 0 |

25.2% of outcomes (59/234) flip vs stock. **Every fitness number in the repo
predates this and needs re-running**, on top of the clock fix's own
invalidation.

**Open caveat, flagged not fixed:** throw-and-go is unconditional — it fires
whenever the preconditions hold, including when the active mon is WINNING the
matchup and should stay. On the traced matchup that costs team A more than it
gains (Thievul is fast enough on Snarl energy to hit two Night Slashes early,
so it swaps out of a lead it was winning). The obvious refinement is to gate it
on the matchup rating pvpoke's `evaluateMatchup` already computes; deliberately
not done here, since Jaxon asked for the behavior itself first.

**Verified (FOREGROUND, standing rule 8):** `node --test test/teamBattle.test.js`
→ 20/20; `npm test` → **256/256 green** (~144s), up from 250 by the 6 new tests
covering the ms→turns conversion, the null restore, both defaults being
reported, disable-with-0, that the behavior actually fires over a seed sweep,
that a higher threshold fires strictly less, and that determinism survives.

### Same day, follow-up — throw-and-go gated on being farmed down
Jaxon reviewed the trace and rejected the unconditional version: "Thievul
should not throw and switch; it should stay in. Only Talonflame should throw
and go, and its only because it would be 'farmed down' with fast move damage
if it stays in."

**New gate, `beingFarmedDown(poke, opponent)` (exported).** A Pokemon is being
farmed down when the opponent's fast-move chip finishes it BEFORE its own fast
moves could bank enough energy for another charged move — `poke.hp /
opponent.fastMove.dps  <  max(cheapestChargedEnergy - poke.energy, 0) /
(poke.fastMove.energyGain / (poke.fastMove.cooldown / 500))`. Both expressions
are pvpoke's own (`fastMove.dps` is per-turn damage vs the CURRENT opponent,
Pokemon.js:842, refreshed by resetMoves() for both actives on every switch-in,
Battle.js:110-112; the energy-per-turn form is TrainingAI.js:701's).

Two earlier formulations were tried and rejected against real numbers:
- *Unconditional* (the first version): Thievul, which builds Snarl energy fast,
  threw twice and walked out of a lead it was winning. Wrong per Jaxon.
- *HP race* (`turnsUntilIFaint <= turnsUntilTheyFaint`): an HP race has no
  margin, so a Pokemon one point behind an even matchup reads as losing. In a
  MIRROR both identical sides wanted to leave at once — caught immediately by
  the pre-existing "identical teams split the 9 pairings near evenly" test
  (a=2 b=7). Switching to strict `<` did not fix it; the model was wrong, not
  the comparison. The energy formulation has margin built in and the mirror
  test passes untouched. **That test was NOT loosened.**

**Reaction time no longer gates the throw-and-go.** It models reacting to what
the OPPONENT did; a throw-and-go is self-initiated and already decided. Gating
it was not harmless: pvpoke re-steps the same turn index after a charged move
resolves, so `turn - readyTurn` is still 0 on the step where the swap belongs.
Blocking that step dropped the AI into its fast-move fallback, and a 5-turn
Incinerate then locked Talonflame out of deciding anything until T34 on 4 HP —
observed directly on the line this was built for. `throwAndGoReadyTurn` is gone
with it. Reaction time still does its real job on pvpoke's own SWITCH_BASIC
path (TrainingAI.js:1062).

**`throwAndGoSwitchesA/B` now count switches that actually HAPPENED**, not
intentions. pvpoke can reject the action (Battle.js:504-508), and a Pokemon
that faints the same turn switches out for a different reason — the old counter
credited Talonflame's T34 attempt even though it died that turn.

**The traced line now matches Jaxon's read exactly:** Talonflame throws Fly
(T20) and Brave Bird (T29), forcing both of Thievul's shields, then leaves at
T29 on 28 HP (it needs 6.25 turns to reach Fly again and has 4.7 turns to
live). Thievul never throw-and-goes — Sucker Punch banks Night Slash in 4
turns while it is chipped at 3.2/turn — and it wins the lead fight. A takes it
2-0 in 72 turns.

**Re-measured**, same 234-battle pool sweep as above:

| config | win rate | throw-and-go switches | timeouts |
|---|---|---|---|
| stock (rt=0, tag off) | 123/234 = 52.6% | 0 | 2 |
| rt=200 only | 120/234 = 51.3% | 0 | 2 |
| rt=200 + tag=2 (gated) | 123/234 = 52.6% | 67 (0.29/battle) | 2 |

Firing rate drops 0.99 -> 0.29 per battle: situational, which is the point.
13.2% of outcomes still flip vs stock (was 25.2% unconditional).

**Verified (FOREGROUND):** `node --test test/teamBattle.test.js` -> 26/26;
`npm test` -> **262/262 green** (~350s). Six new tests are direct unit tests of
`beingFarmedDown` (the Talonflame case and the Thievul case at their real
traced numbers, already-has-energy, mirror safety incl. the 1-HP-deficit case,
zero-damage fast move / no charged moves, null safety) plus two integration
tests asserting Talonflame goes and Thievul stays in the real matchup.

### Same day, follow-up — bank shields against weak, cheap moves

Jaxon: "Teams should avoid shielding weak, cheap moves such as bubble beam and
night slash; this is because you will likely get more value from the shields
later and also because getting a shield advantage can give your closer in the
back a winning advantage."

pvpoke's `decideShield` weighs the move in front of it and nothing else. Its
one clause that could preserve a shield — "Preserve shield advantage"
(TrainingAI.js:1310) — is gated on `defender.battleStats.shieldsUsed > 0`, so
it can never stop the FIRST shield, which is the one that gives the advantage
away. Its advanced-shielding block (TrainingAI.js:1326-1358) is commented out
in the vendor source.

**New: `isCheapChip(defender, move, moveDamage, fastDamage)`** — a move is not
worth a shield when all three hold:

- **weak**: `moveDamage <= defender.stats.hp * 0.35`. Measured against MAX HP,
  not current: a shield's value is the damage it blocks, which does not grow
  because the defender is already hurt. Against a 135 HP Talonflame this splits
  Night Slash (41, 0.30) from Fly (63/130 on Thievul, 0.48) and Brave Bird
  (103/130, 0.79) exactly where a player would.
- **cheap**: `move.energy <= 45`. This is what makes it a bad trade rather than
  a small one — block a 35-energy move and the attacker is most of the way back
  to throwing it again.
- **affordable**: `moveDamage + fastDamage*2 < defender.hp`. This is pvpoke's
  own "hard hitting or knockout" test (TrainingAI.js:1264) used as its strict
  inverse.

**`wrapShieldBanking(players, DamageCalculator, opts)`** installs it for both
players. It computes pvpoke's decision FIRST and only ever turns a yes into a
no — so last-Pokemon protection and matchup weighting still apply, and the
seeded RNG is consumed in the same order as stock, which makes an A/B against
`bankShields: false` a test of this rule alone. It also declines to fire when
`getRemainingPokemon() <= 1`: with nothing in the back the banked shield has no
later value, which is the second half of Jaxon's reasoning.

**Rejected first formulation:** affordability as "survive TWO copies of the
move, chip included". Too strict — it demands a full extra cycle of health,
which nothing below ~90% HP has against even a weak move. It declined 271
shields but kept shielding the exact hit the rule exists to decline: Talonflame
at 86/135 spending a shield on a 41-damage Night Slash.

**New engine knob** `bankShields` (default true), reported in the summary
alongside `shieldsDeclinedA/B`.

**Measured**, candidate team vs the full 78-team pool x 3 mirrored lead
pairings (234 battles):

| config | win rate | shields declined | shields left on board (A/B) |
|---|---|---|---|
| stock (rt=0, tag=0, bank=off) | 152/234 = 65.0% | 0 | 10 / 9 |
| rt=200 + tag=2, bank=off | 153/234 = 65.4% | 0 | 16 / 19 |
| rt=200 + tag=2, bank=on | 157/234 = 67.1% | 472 (2.0/battle) | 52 / 71 |

Shields surviving the battle more than triple. 25.6% of outcomes flip vs the
previous default; 33.8% vs stock. Spot-checking the declines: Bulldoze (45e,
0.23 of the bar) on Stunfisk, Bubble Beam (40e, 0.10) on Tinkaton, Icy Wind
(45e, 0.07) on Araquanid, Body Slam (35e, 0.30) on Thievul — all moves nobody
shields.

**Interaction with throw-and-go, reported not hidden:** on the traced
Thievul/Talonflame line the two behaviors now collide. Talonflame declines the
T14 Night Slash, is dead by T23, and never reaches the T29 throw-and-go the
previous entry documents; B wins 1-0 instead of losing 0-2. The two
throw-and-go tests that assert that traced line are pinned to
`bankShields: false` so they still isolate `wrapThrowAndGo`; the comment in the
test says why.

**Verified (FOREGROUND):** `node --test test/teamBattle.test.js` -> 42/42;
`npm test` -> **278/278 green** (~341s). Ten new unit tests of `isCheapChip`
(Night Slash and Bubble Beam at their real traced numbers, Fly = cheap but not
weak, Brave Bird = neither, a soft 60-energy move, the T23 Talonflame KO case,
fast-move chip sensitivity, fast moves, zero damage, null safety) plus six on
`wrapShieldBanking` (default on/reported/disable, the traced decline, shields
left on the board, the last-Pokemon stand-aside, never-a-no-into-a-yes,
determinism).

### Same day, follow-up 2 — the shield rule collapses to one question, and real switch timing

Two corrections from Jaxon in the same sitting.

**1. "Someone should only decline a shield if they can tank the move and have
enough health to still throw another move of their own. This will usually apply
only to cheap and weak moves. Thus, this idea should umbrella in the 'weak' and
'cheap' ideas — we don't need a specifically carve out for them."**

`isCheapChip` is gone, and with it `WEAK_MOVE_HP_FRACTION` (0.35) and
`CHEAP_MOVE_ENERGY` (45). Replaced by **`canTankAndAnswer(defender, attacker,
moveDamage, fastDamage)`**, two conditions:

- **tank it**: `defender.hp - moveDamage > 0`.
- **still answer**: what is left outlives a full charge cycle at the attacker's
  fast-move chip rate — `hpAfterHit > turnsToChargedMove(defender, 0) *
  incomingPerTurn`.

The thresholds really were redundant: a move that is not weak fails the tank
test, and one you cannot come back from fails the answer test.

Also extracted **`turnsToChargedMove(poke, energy = poke.energy)`**, now shared
with `beingFarmedDown`. The two rules are the same shape — does this Pokemon
reach its own next move before the fast-move chip finishes it — asked at
different HP: `beingFarmedDown` asks about now (should I leave?),
`canTankAndAnswer` asks about the HP left after eating one more hit (should I
spend a shield?).

**Rejected: counting from current energy.** The obvious reading of "throw
another move" is `turnsToChargedMove(defender)`, the wait from whatever energy
is in hand. That reads 0 turns for anything already loaded, which makes "I can
still throw" trivially true and licenses declining a shield that leaves 2 HP on
the board. Measured: 349 of 786 declines had `turnsToAnswer == 0`, including a
Thievul on 66 HP declining against a 64-damage Fly, and a Stunfisk on 113
declining a 111-damage Avalanche. Pool win rate fell to 57.7%. A move already
in hand is not "another move of my own" — the horizon is the NEXT one, which is
a full cycle whether or not one is loaded. That fix took the worst decline from
1 HP left to 5 HP and the win rate back to 62.4%.

**2. "If you switch immediately after a move resolves or immediately after a
pokemon faints or when the game starts, you get a '0-turn' switch... you don't
get the usual disadvantageous 1-turn switch in standard scenarios."**

pvpoke charges nothing for any switch: the incoming Pokemon arrives on cooldown
0 (`startCooldown = 0`, Pokemon.js:1836) and acts on the very next turn, so the
only cost is the single action spent switching. **`wrapSwitchCost(battle,
opts)`** adds the real cost — `incoming.cooldown = 1000` — and exempts the
three free cases:

1. **after a charged move**: every charged `useMove` stamps the turn; a switch
   processed on that same turn index is inside the window. Either side's move
   opens it. (pvpoke re-steps the same turn after a charged move resolves,
   which is what makes the turn index a usable marker.)
2. **after a faint**: `poke.hp < 1`, the branch pvpoke already routes
   separately (Battle.js:1005).
3. **at the start**: leads are placed with a direct `setNewPokemon` call and
   never reach `processAction`, so they are never charged and never counted.

1000ms, not 500: `Battle#step` decrements every cooldown by a turn
(Battle.js:296) *before* reading it, so 500 is spent before anything sees it.

Verified on the traced battle: with the cost on, Stunfisk's first Thunder Shock
after switching in slides T27 -> T28. The throw-and-go switch is correctly free
(it lands on the same turn as the charged move that triggered it), so
`costlySwitchesB` is 0 in that battle.

New knob `switchTurnCost` (default true), with `costlySwitchesA/B` and
`freeSwitchesA/B` in the summary. The AI is not told about the cost — TrainingAI
has no switch-cost model — so this changes what a switch COSTS, not how either
side decides to make one. It does feed back into pvpoke's own switch validity
check (`poke.cooldown == 0`, Battle.js:504), which now correctly stops a
Pokemon from switching straight back out while it is still arriving.

**Measured**, candidate vs the full 78-team pool x 3 mirrored lead pairings:

| config | win rate | shields declined | switches costly/free | shields left A/B |
|---|---|---|---|---|
| pvpoke stock | 152/234 = 65.0% | 0 | 490 / 898 | 10 / 9 |
| +rt200 +tag2 | 153/234 = 65.4% | 0 | 508 / 881 | 16 / 19 |
| +bankShields | 146/234 = 62.4% | 628 | 485 / 906 | 89 / 81 |
| +switchTurnCost (all on) | 151/234 = 64.5% | 662 | 494 / 892 | 75 / 74 |

About 36% of mid-battle switches now cost a turn; the rest are post-faint or
post-charged-move.

**On the 62.4% dip, checked rather than assumed:** it is orientation, not weak
play. Running the same candidate in the B slot against the same pool, shield
banking *raises* its win rate 59.4% -> 64.1%. The rule is symmetric; this
particular team's matchups are not.

**Known gap, not fixed:** the survival window counts only fast-move chip, so it
misses the attacker's next charged move landing inside it. That lets through
e.g. Araquanid on 122/134 declining a 108-damage Meteor Beam — it survives 14
turns of 1-damage chip, which is long enough to charge a Water Pulse, but not
if a second charged move arrives. Closing it means re-deriving pvpoke's
runScenario, so it is left as a known limitation.

**Verified (FOREGROUND):** `node --test test/teamBattle.test.js` -> 52/52;
`npm test` -> **288/288 green** (~162s). Ten unit tests of `canTankAndAnswer`
(the traced T14 decline and the T23 spend, un-tankable hits, Fly surviving by
2 HP, energy-in-hand not making it free, no charged move, a fast move that
banks no energy, no chip, null safety) and ten of `wrapSwitchCost` (ordinary
cost, both sides' charged moves opening the window, a fast move not opening it,
the window closing next turn, post-faint, disabled-still-counts, non-switch
actions, plus two integration tests).

### Same day, follow-up 3 — an honest survival window, a damage ceiling, and the endgame

Jaxon, three additions to the shield rule: count the attacker's next charged
move inside the survival window ("it's relevant to the truth of whether the
Pokemon can actually tank and answer"); shield anything that does too much
damage regardless ("Araquanid should not be tanking a meteor beam"); and don't
bank in the endgame ("if you're the last pokemon remaining, you may need to
shield even if you can tank and answer to avoid being farmed down by an enemy
Pokemon in the back — we don't want to lose a game when we still had shields
available").

**1. The window now counts what the attacker throws inside it.** Over
`turnsToChargedMove(defender, 0)` turns the attacker banks
`energyGain / (cooldown/500)` per turn on top of whatever is left after this
move, so `floor((energyLeft + banked) / cheapestChargedEnergy)` more charged
moves land. Measured on the previous rule: **291 of 662 declines (44%) were
dead before their own move landed** once those follow-ups were counted.

**Corrected mid-implementation by Jaxon:** "If you deny the shield on the first
guy, and then they throw the second move before you can get to your next move,
you should still have a shield which you can use on the second move and be good
to go." Right — declining KEEPS the shield. Follow-ups are counted against
`defender.shields` first and only the surplus does damage. Since decideShield is
only asked when the defender holds at least one shield, a single follow-up in
the window is always covered; the term bites when the attacker fits more
charged moves into the window than the defender has shields left.

This is the difference between the rule helping and hurting. Charging follow-ups
at full damage: 265 declines, 61.5% as A / (not measured) as B. Crediting the
shields: 502 declines, and banking finally helps in BOTH orientations.

**2. `MAX_TANKABLE_HP_FRACTION = 0.5`** — a hit taking more than half a full
health bar is shielded however the arithmetic comes out. It fires 122 times
across the pool: Earthquake at 0.66 of Stunfisk's bar, Hydro Cannon at 0.69,
Dynamic Punch at 0.78 on Thievul, Stone Edge at 0.59 on Araquanid. The
Meteor Beam case that motivated it was 108 of Araquanid's 134 = 0.81.

**3. Endgame stand-aside.** `wrapShieldBanking` already stood aside at
`getRemainingPokemon() <= 1`; it now also stands aside when this player has
FEWER Pokemon left than the opponent. Down a body, the banked shield has to
survive a fresh Pokemon arriving before it can ever be spent. This is the
biggest of the three gates — 310 blocks across the pool.

**Where the blocks come from** (candidate vs the 78-team pool x 3 mirrored lead
pairings), out of every shield pvpoke wanted to spend that the rule looked at:

| outcome | count |
|---|---|
| declined | 502 |
| blocked by the endgame gate | 310 |
| blocked by the damage ceiling | 122 |
| blocked by follow-up charged moves in the window | 23 |

**Measured**, same sweep:

| config | win rate | shields declined | switches costly/free | shields left A/B |
|---|---|---|---|---|
| pvpoke stock | 152/234 = 65.0% | 0 | 490 / 898 | 10 / 9 |
| +rt200 +tag2 | 153/234 = 65.4% | 0 | 508 / 881 | 16 / 19 |
| +bankShields | 149/234 = 63.7% | 488 | 485 / 889 | 78 / 65 |
| +switchTurnCost (all on) | 154/234 = 65.8% | 502 | 496 / 890 | 68 / 57 |

**Both orientations now agree**, which is the check that the earlier version
failed (with everything else on, banking on vs off):

| orientation | bank off | bank on |
|---|---|---|
| candidate as A | 148/234 = 63.2% | 154/234 = 65.8% |
| candidate as B | 138/234 = 59.0% | 156/234 = 66.7% |

Losing with shields still in hand — the failure Jaxon named — stays rare and
total losses fall: as A, 5 of 86 losses -> 6 of 80; as B, 2 of 96 -> 8 of 78.

**Verified (FOREGROUND):** `node --test test/teamBattle.test.js` -> 53/53;
`npm test` -> **289/289 green** (~147s). `canTankAndAnswer`'s tests now cover
the ceiling (the Meteor Beam board, and the same board under the ceiling), and
follow-up accounting at 1 vs 2 shields against 4 throws in the window;
`wrapShieldBanking` gains a behind-on-bodies test alongside the last-Pokemon
one.

### Same day, follow-up 4 — the endgame gate was checking the wrong thing

Jaxon caught it: the `remaining < foe.getRemainingPokemon()` half of the
endgame gate blocked banking for ANY body-count deficit, e.g. 2 left against
3 -- not just the true "no later to spend it" case. His point: 2v3 isn't the
endgame, and a weak last-gasp move should still be declinable, especially
when the defender is winning the DPS race and can farm the attacker down.

Root cause: shields are match-wide, not per-Pokemon, so the only real
"no later" case is being on your OWN last Pokemon (`remaining <= 1`,
already the first half of the gate). Being behind on count with a bench
left still has a later. Deleted the `foe`-comparison line; `canTankAndAnswer`
now runs whenever this player has more than one Pokemon left, regardless of
the opponent's count. The "behind on bodies" test never actually exercised
the deleted line (`pair(1,2)` hit the last-Pokemon condition first) --
replaced it with one that checks `pair(2,3)` still declines.

**Measured**, candidate vs the 78-team pool x 3 mirrored leads, before/after:

| orientation | buggy gate | fixed gate |
|---|---|---|
| as A | 154/234 = 65.8% | 163/234 = 69.7% |
| as B | 156/234 = 66.7% | 153/234 = 65.4% |

Declines roughly doubled (candidate's own declines: 300 as A, up from ~250;
348 as B, up from ~250). Losing with shields still in hand also rose in raw
count in both orientations (as A 10 of 71 losses, as B 11 of 81) though as-A
total losses fell (80 -> 71). This is the honest cost of the fix: more
declines means more variance, and `canTankAndAnswer`'s window is a heuristic,
not a guarantee. Reported to Jaxon as-is rather than tuned further -- the old
gate was a modeling bug (shields don't expire per-Pokemon in real GBL), not a
dial to trade off against the B-orientation dip.

Jaxon's other point from the same message -- actively holding a shield to
protect a *DPS-race* advantage when the opponent is low and being farmed
down -- is a distinct idea from this bug fix (favoring a hold beyond "can
tank and answer") and is not implemented; noted for later if he wants it.

**Verified (FOREGROUND):** `node --test test/teamBattle.test.js` -> 53/53;
`npm test` -> 289/289 green.
