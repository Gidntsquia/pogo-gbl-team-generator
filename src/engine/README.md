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
- `parallel.js` / `parallelWorker.js` — cross-core parallel battle executor
  (GOALS T15). Exports `runBattles(specs, {threads, vendorRoot})`,
  `defaultThreadCount()`, `resolveThreadCount(explicit, env)`. See
  "Parallel battles" below.

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

## Parallel battles (`parallel.js`, GOALS T15)

`battleTeams` calls are independent and fully self-contained (each resets its
own `Battle`, virtual clock, and seeded RNG -- see above), so many can run at
once across OS threads with no change to the engine or any battle math.
`parallel.js`'s `runBattles(specs, {threads, vendorRoot})` spawns a pool of
`node:worker_threads` workers, each of which boots its **own** headless
pvpoke engine context exactly once (`parallelWorker.js` calls the same
`initEngine` everything else uses) and then answers a stream of battle specs
from the main thread. Results come back **in spec order**; `test/parallel.test.js`
asserts they match a serial loop of `battleTeams(ctx, spec)` calls (plus edge
cases at `threads=1` and `threads=4`) for that suite's battle plans. See
**"Known limitation"** below, discovered during T15b: this holds for battle
*winners* generally, but exact HP totals are not guaranteed bit-identical to a
serial run when a Pokemon instance is reused across several battles, because
pvpoke itself carries a subtle order-sensitivity across such reuse.

**Why specs are plain data, and why team-building happens per worker, not on
the main thread.** A built pvpoke `Pokemon` instance lives inside one
specific `vm` context tied to one V8 isolate; it cannot be handed to a
worker_thread (`postMessage`'s structured clone doesn't preserve class
instances/methods, and even a deep-cloned plain object would be disconnected
from that worker's own `Battle`/`GameMaster` singletons). Team-building must
therefore happen per worker, not on the main thread. So a `BattleSpec`'s
`teamA`/`teamB` are plain-data `MonSpec` arrays --
`{speciesId, ivs, shadow, bestBuddy}` -- and each worker rebuilds real
Pokemon via the existing `buildPokemon`, caching by a stable key so a mon
that recurs across many specs on the same worker (very common: an evaluator
plays one candidate as team A against many opponents, or one meta team as
team B against many candidates) is only built once. The cache is split into
`cacheA`/`cacheB` (one per side) rather than a single shared cache, because
`battleTeams` requires `teamA`/`teamB` to be **distinct instances even in a
mirror match** (same species+IVs on both sides) -- building every `teamA`
from `cacheA` and every `teamB` from `cacheB` guarantees that for free.

**Thread count.** `defaultThreadCount()` is `max(1, os.cpus().length - 1)`
(leave one core free). `resolveThreadCount(explicit, env)` prefers an
explicit override, then the `POGO_GBL_THREADS` env var, then the default; a
non-positive or non-numeric override/env value falls through instead of
throwing. `runBattles` further clamps the resolved count to
`[1, specs.length]` so it never spawns a worker with no work.

**Failure handling.** A battle that throws inside a worker (e.g. an invalid
spec) or a worker that crashes outright rejects the whole `runBattles()`
promise with a clear error identifying what went wrong; every other worker
is terminated before the promise settles, so a failure surfaces as a
rejection, never a hang. `runBattles` does not retry or skip-and-continue on
a bad spec -- callers that want skip-with-warning semantics (like
`scripts/tournament.mjs`'s per-battle error handling) validate/catch at
their own layer, same as they already do around a serial `battleTeams` call.

**Measured effect (sandbox, this container has 4 vCPUs).**
`node scripts/bench.mjs --n 80 --threads N` (same 80 deterministic
azumarill/registeel/altaria vs stunfisk_galarian/mandibuzz/clodsire battles
as the T14 serial bench, driven through `runBattles` instead of a loop):

| threads | ms/battle (wall) | vs. serial (~142ms/battle) |
| --- | --- | --- |
| 1 (serial baseline) | ~141.6ms | 1.0x |
| 1 (via runBattles)  | ~143.8ms | ~1.0x (thread/message overhead is noise) |
| 2                    | ~81.0ms  | ~1.75x |
| 4                    | ~64.1ms  | ~2.21x |

Sub-linear scaling at `threads=4` on a 4-vCPU box is expected -- the main
thread plus OS/runtime overhead compete for the same cores the worker pool
is using. `defaultThreadCount()` already reflects that by reserving one core.
On Jaxon's multi-core Mac (measured serial baseline ~68-73ms/battle vs this
sandbox's ~172ms/battle for the same code -- see T14), more physical cores
free of that contention should scale further toward linear; that number is
not measured here and should be recorded locally when convenient.

**Integration status (GOALS T15b).** `matrix.builtMons` (`src/scoring/index.js`)
and every meta-team member (`buildMetaMon`/`buildRecommendedMon`) now carry a
`spec` field alongside `pokemon` -- the raw `{speciesId, ivs, shadow,
bestBuddy}` a `MonSpec` needs (plus `fastMove`/`chargedMoves` when the mon was
built with an EXPLICIT moveset via `buildMetaMon`, e.g. a curated preset team
member -- `parallelWorker.js` reapplies it via `applyGroupMoveset`, since
`buildPokemon` alone always selects pvpoke's *recommended* moveset, which is
not always what the mon was actually carrying; this was a real bug caught
during verification, see PROGRESS.md). `evaluateTeams` (`src/teams/index.js`)
now accepts an opt-in `opts.threads` (and the CLI a `--threads` flag) that
collects every battle across every candidate into one flat spec list and runs
it through a single `runBattles()` call.

**GOALS T15c** wired the same executor into `scripts/tournament.mjs`, which
drives `battleTeams` directly rather than through `evaluateTeams` (its 3-stage
funnel needs per-battle skip-and-continue error handling across all three
stages, which `evaluateTeams` doesn't have). `runFunnelStage`'s `opts.threads`
batches one CANDIDATE's entire battle set (every opponent x every lead
pairing) into a single `runBattles()` call, rather than the whole stage --
`runBattles` rejects its entire batch on any one bad spec, so batching at
stage granularity would mean one bad matchup could cost an entire stage's
worth of battles; batching per candidate instead means a batch failure only
costs that one candidate (counted as errors, logged, and skipped, same
skip-and-continue spirit as the serial path, just at coarser granularity).
The spec-carrying plumbing T15b already added (`matrix.builtMons[key].spec`,
every meta/sampled team member's `.spec`) covers everything `tournament.mjs`
needs -- no additional plumbing was required.

## Known limitation: battle order and reused-instance move selection

Discovered during T15b's verification (executing real battles caught this --
see the standing rule about verification, not code review, being what counts).
pvpoke's `Pokemon#resetMoves()` (called by `fullReset()`, which our
`battleTeams()` wrapper calls on every team member before every battle) picks
`bestChargedMove` partly from `move.dpe`, which `initializeMove()` computes via
`move.damage = DamageCalculator.damage(self, battle.getOpponent(self.index), move)`.
`self.index` is the Pokemon's *battle slot* from whichever `Battle` it last
participated in; our wrapper calls `fullReset()` **before**
`battle.setNewPokemon()` reassigns indices for the *current* battle, so this
read can see a stale/absent opponent relative to the battle about to run. The
practical effect: a Pokemon instance's very first battle can pick a (very
slightly) different `bestChargedMove` tie-break than its second, third, etc.
battle -- verified directly (`buildPokemon` + `applyGroupMoveset` twice,
identical moveset/stats/shadowType/level/cp both times, same seed, same
opponent instances, yet different `survivorsHp`/turn counts on the first call
only; stable from the second call onward).

This is a **pre-existing pvpoke engine characteristic**, not something T15/T15b
introduced -- it applies to *any* reuse of a Pokemon instance across
sequential battles, which today's serial `evaluateTeams`/`tournament.mjs`
already do constantly (a candidate's `teamA` instances are built once and
battle every meta team in a loop; a meta team's `teamB` instances are built
once and battle every candidate). Serial execution is self-consistent only
because its battle order never changes run to run; `runBattles`' worker pool
distributes specs across workers in an order that generally differs from the
serial loop's, and each worker's own build cache reuses instances in *its*
order -- so **exact HP totals (`avgHpMargin`, `safeSwap.avgHpPct`) can drift by
a small amount** between a serial and a threaded run of the same inputs.

**CORRECTION (GOALS T15c, found by executing a larger real run than T15b's
test covered):** T15b's original claim here -- that win/loss outcomes and team
win rates are *unaffected* by threading -- does not hold in general; it only
held at T15b's smaller test scale. A real `scripts/tournament.mjs` run at
larger scale (4 finalists x 4 opponents x 9 pairings = 144 stage-3 battles,
`test/tournament.test.js`) hit a case where the SAME mechanism above (a
reused instance's `bestChargedMove` tie-break depending on which battles that
cache entry already went through) reclassified one battle's verdict, not only
its HP margin -- a narrow win under serial execution came out a tie under
threaded execution of the identical seed/spec. Practical impact is bounded:
each such flip moves a team's win rate by at most one battle's weight (out of
however many battles feed that rate), and it is rare enough that T15b's
smaller-scale test never tripped over it -- but "unaffected" was too strong a
claim. `test/tournament.test.js`'s threaded-vs-serial test therefore checks
win rates within a small documented tolerance rather than exact equality;
`test/teams.test.js`'s smaller-scale T15b test still happens to pass exactly,
which is consistent with this being rare rather than absent. Standing rule 4
(vendor is read-only, never reimplement battle math) means this is documented
here as a known characteristic rather than patched; it is also direct evidence
for ROADMAP's existing "TrainingAI variance study" gap, which a future fire
could use this as a starting point for.

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

## Performance (GOALS T14)

`scripts/bench.mjs` times repeated `battleTeams` calls between two fixed,
competitively-matched teams (built once, battled many times — the same
build-once/battle-many pattern `evaluateTeams` and `tournament.mjs` already
use) and reports ms/battle. Sandbox baseline: **~172ms/battle** (Jaxon's
local machine measured ~73-68ms/battle in earlier PROGRESS entries — faster
hardware, same code).

A `node --cpu-prof` capture of a 150-battle bench run (analyzed by bucketing
sampled stack frames by source file) found **97.0%** of samples inside
`vendor/pvpoke` (`DamageCalculator.damage`, `ActionLogic.decideAction`,
`Battle.step`/`useMove`, `Pokemon.resetMoves`, `TrainingAI.*`) and only
**0.3%** inside this package's own `src/engine/*` wrapper code — and over
half of *that* sliver is `initEngine`'s one-time setup (gamemaster load +
search-map indexing), not the per-battle hot path. The per-battle wrapper
functions (`battleTeams`, the virtual-timer `drain()`, the symmetric-AI
`forceSwitch`/`decrementSwitchTimer` overrides, `orderWithLead`) accounted
for roughly 0.15% of total samples combined. `node --prof` /
`--prof-process` on the same workload corroborates this: essentially every
named-function JS tick traces to a `vendor/pvpoke/src/js/*` file.

**Conclusion: there is no meaningful single-thread win available in OUR
code.** The engine itself (which standing rule 4 forbids touching) accounts
for essentially all wall-clock time; this package's driving code is already
close to the noise floor. T14 is therefore a documented **null result** —
profiled, nothing safe to squeeze — and the real lever for "make battles
faster" is T15's cross-core parallelism (running independent `battleTeams`
calls concurrently in separate `worker_threads`, each with its own vm engine
context), not shaving wrapper overhead that isn't there.

To reproduce the profiling: `node --cpu-prof --cpu-prof-dir=out
--cpu-prof-name=bench.cpuprofile scripts/bench.mjs --n 150`, then inspect
`out/bench.cpuprofile` (Chrome DevTools "Performance" tab, or `node
--prof`/`--prof-process` for a text report) — bucket `callFrame.url` by
`vendor/pvpoke` vs `src/engine` to repeat the split above.

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
