# src/engine

A headless runner for **pvpoke's own** Great League (CP 1500) battle
simulator. Nothing in this directory reimplements battle math, CP/level
math, or move-selection logic — every number `simBattle` and `buildPokemon`
produce comes from executing `vendor/pvpoke`'s unmodified JS.

## Files

- `pvpokeLoader.js` — loads pvpoke's battle-engine source files into a Node
  `vm` context with a small browser-globals shim (see below). Exports
  `loadPvpokeEngine(opts?)` (the seven core engine files) and
  `loadTrainingModules(context, vendorRoot)` (adds `Player`, `TrainingAI`,
  `DecisionOption` plus the AI difficulty archetypes, for team battles).
- `harness.js` — the public API: `initEngine`, `buildPokemon`, `simBattle`.
  Builds on `pvpokeLoader.js` by injecting gamemaster + ranking data read
  directly from `vendor/pvpoke/src/data/*.json`, and adding the small
  amount of glue logic pvpoke's UI code doesn't expose as a standalone
  function (see the comment in `buildPokemon` about the level-search loop).
- `teamBattle.js` — headless **3v3 team battles** via pvpoke's own
  Training-mode ("emulate") engine and `TrainingAI`. Exports
  `initTeamBattle(ctx)` and `battleTeams(ctx, {teamA, teamB, leadA, leadB,
  difficulty, seed})`. See "3v3 team battles" below.

## 3v3 team battles (`teamBattle.js`)

pvpoke's Training mode is the real GBL 3v3 engine: `Battle.js` run in
`emulate` mode with a `Player` per side (team of 3, shared pool of 2 shields,
45-second switch timer) and `TrainingAI` deciding leads, shields, switches,
charged-move usage, and baiting. `battleTeams` runs that engine unmodified
and returns `{ winner: 'a'|'b'|'tie', survivorsHp, summary }`. It does **not**
reimplement any battle math, AI, or shield/switch logic — it only supplies
the three things a browserless run is missing:

1. **A deterministic virtual clock.** Emulate mode is written for a live page:
   it schedules charged-move animation phases (~6–10 s) and the on-faint
   switch window (~2–13 s) with real `setTimeout`, while a 500 ms
   `setInterval` steps the battle. Headless, `teamBattle.js` steps the battle
   itself and drains a virtual timer queue in fire-time order between steps —
   reproducing the exact ordering pvpoke relies on (e.g. the AI's ~2–5 s
   switch choice firing before the 13 s force-switch fallback) with no real
   waiting. `setInterval` is a no-op because pvpoke's own emulate main loop is
   never started.
2. **Seeded RNG (the RNG policy).** `TrainingAI` makes several *randomized*
   decisions (shield-energy guesses, weighted switch/strategy choices,
   overfarm rolls), so raw emulate battles are non-deterministic. `battleTeams`
   swaps the vm's `Math.random` for a seeded mulberry32 PRNG, re-seeded at the
   start of every battle. **RNG is pinned, not aggregated:** a battle is fully
   reproducible for a given `(teams, leads, difficulty, seed)`. When `seed` is
   omitted it is derived deterministically from the matchup, so repeated calls
   with identical inputs still agree. Callers that want to study AI variance
   can vary `seed` and aggregate (see ROADMAP's "TrainingAI variance study").
3. **Symmetric both-players-are-AI wiring.** Emulate mode assumes player 0 is
   a human and hardwires a few hooks to player 1 only (initial matchup
   evaluation, on-faint AI switching, switch-timer re-evaluation).
   `battleTeams` drives *both* sides with `TrainingAI` at the chosen
   `difficulty` (0–3; default **3 = "Champion"**, the strongest), mirroring
   those hooks onto player 0 (it overrides `Battle#forceSwitch` to use
   `decideSwitch` for any fainted AI player, and `Player#decrementSwitchTimer`
   for player 0). It also sets `sandbox` mode so the engine honors the AI's
   shield decisions in `useMove`, with `buffChanceModifier = 0` to match
   emulate's normal buff-application chance.

**Balance / tolerance.** A residual player-1 edge remains from pvpoke's
emulate design, so mirror matches land *near* 50/50 rather than exactly:
across all 9 lead pairings of a top-meta team against itself the split is
5–4. `test/teamBattle.test.js` therefore asserts neither side takes more than
6 of 9 pairings (win rate inside `[2/9, 7/9]`), not a hard 50/50. A blatantly
dominant team (3 top-meta mons vs 3 joke mons) wins **all 9** pairings.

**Instance rules.** As with `simBattle`, `teamA` and `teamB` must be distinct
Pokemon instances from each other (pvpoke mutates `.index`/battle state on the
objects it is handed); for a mirror match, build the same species twice. Every
`battleTeams` call resets the Pokemon it is given, so instances may be reused
across sequential calls, and a **fresh `Battle`** is constructed per call
(matching pvpoke's own `MatchHandler`).

## Why a `vm` sandbox instead of a browser

`vendor/pvpoke`'s engine code (`Battle.js`, `Pokemon.js`, `GameMaster.js`,
`DamageCalculator.js`, `ActionLogic.js`, and the two `Timeline*.js` classes)
is written as plain global `<script>`-tag JS with no module system —
`Pokemon` and `Battle` are just `function` declarations, `GameMaster` is an
IIFE-built singleton, etc. Grepping all seven files for `$`, `window`, and
`document` shows the *only* browser dependency anywhere in that set is
jQuery usage inside `GameMaster.js` (`$.each`/`$.ajax`/`$.getJSON`, plus a
couple of DOM-manipulation calls reachable only from an ajax success
callback this harness never lets fire) and two guarded `window.localStorage`
reads on a "load a custom gamemaster from local storage" branch that is
never taken here. `Pokemon.js`, `Battle.js`, `DamageCalculator.js`,
`ActionLogic.js`, and the timeline classes have **zero** browser
dependencies. Given that, spinning up a real browser (Playwright) or a DOM
shim (jsdom) would be pure overhead for what's actually just a jQuery
utility-method shim. `pvpokeLoader.js` runs each vendor file as its own
`vm.Script` against one shared `vm.createContext()` sandbox — equivalent to
concatenated `<script>` tags — and stubs exactly the handful of globals
those files touch: a `$` with working `.each`/no-op `.ajax`/`.getJSON`, a
`window` object with inert `localStorage`, and the plain config values
(`settings`, `host`, `webRoot`, `siteVersion`) `GameMaster.js` reads at
construction time. No network I/O and no DOM ever happen.

## Data loading

pvpoke's browser build fetches `gamemaster.json` and per-league ranking
files over `$.ajax`. `initEngine` never lets that fire: it reads
`vendor/pvpoke/src/data/gamemaster.json` and
`vendor/pvpoke/src/data/rankings/all/overall/rankings-1500.json` directly
off disk with `fs.readFileSync`, assigns them onto the `GameMaster`
singleton (`gm.data`, `gm.rankings.alloverall1500`) exactly where pvpoke's
own code expects to find them, and calls pvpoke's own `gm.createSearchMaps()`
to index them. Everything downstream — `getPokemonById`, `getMoveById`,
`selectRecommendedMoveset` — is pvpoke's unmodified code reading real
vendor data.

## API contract

See the JSDoc in `harness.js` for the authoritative signatures. Two
behaviors worth calling out because they follow directly from how
`vendor/pvpoke/src/js/battle/Battle.js` is written, not from a choice made
here:

- **`simBattle`'s `p1`/`p2` must be distinct object instances.**
  `Battle#setNewPokemon` mutates `.index` on whatever object it's handed;
  passing the same built Pokemon as both sides corrupts the simulation
  instead of producing a mirror match. Call `buildPokemon` twice with
  identical params for a mirror match.
- **A single `Battle` instance is reused across every `buildPokemon` /
  `simBattle` call** for a given `ctx` (returned once from `initEngine`).
  This mirrors `vendor/pvpoke/src/js/battle/rankers/Ranker.js`, which keeps
  one `battle` alive across an entire ranking run rather than constructing
  one per matchup. It's safe because `Battle#setNewPokemon` +
  `Battle#simulate` (via `start()`) fully reset HP/energy/cooldown/shields
  from each Pokemon's own `start*` fields before every simulation.

## Validation

`test/engine.test.js` rebuilds several real Great League Pokemon using
pvpoke's own default (max-stat-product) IV spread for CP 1500 — read
directly from each species' `defaultIVs.cp1500` entry in gamemaster data,
not recomputed — and pvpoke's own recommended moveset, then simulates them
against each other with 1 shield per side (pvpoke's "leads" ranking
scenario) and asserts the resulting battle ratings match
`vendor/pvpoke/src/data/rankings/all/overall/rankings-1500.json` **exactly**.
No tolerance is needed: with the same IVs, level, moveset, and shield
scenario, running pvpoke's own simulator reproduces pvpoke's own recorded
ratings bit-for-bit.
