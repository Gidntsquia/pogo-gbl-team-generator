# src/engine

A headless runner for **pvpoke's own** Great League (CP 1500) battle
simulator. Nothing in this directory reimplements battle math, CP/level
math, or move-selection logic — every number `simBattle` and `buildPokemon`
produce comes from executing `vendor/pvpoke`'s unmodified JS.

## Files

- `pvpokeLoader.js` — loads seven vendor/pvpoke source files into a Node
  `vm` context with a small browser-globals shim (see below). Exports
  `loadPvpokeEngine(opts?)`.
- `harness.js` — the public API: `initEngine`, `buildPokemon`, `simBattle`.
  Builds on `pvpokeLoader.js` by injecting gamemaster + ranking data read
  directly from `vendor/pvpoke/src/data/*.json`, and adding the small
  amount of glue logic pvpoke's UI code doesn't expose as a standalone
  function (see the comment in `buildPokemon` about the level-search loop).

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
