# src/engine

A headless runner for **pvpoke's own** CP-capped cup battle simulator,
defaulting to Great League (CP 1500) but usable for any CP cap pvpoke ships
vendored ranking data for (`initEngine({ cp: 2500 })` for Ultra League, etc.
— see "CP-cap parameterization" below). Nothing in this directory
reimplements battle math, CP/level math, or move-selection logic — every
number `simBattle` and `buildPokemon` produce comes from executing
`vendor/pvpoke`'s unmodified JS.

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
  (persistent worker pool). Exports `createExecutor({threads,
  vendorRoot, continueOnError})` (a reusable worker pool -- `{run(specs),
  close()}`), `runBattles(specs, {threads, vendorRoot})` (a one-shot
  create→run→close wrapper), `defaultThreadCount()`,
  `resolveThreadCount(explicit, env)`. See "Parallel battles" below.

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
   can vary `seed` and aggregate.
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
5–4. `test/e2e.test.js` therefore asserts neither side takes more than
6 of 9 pairings (win rate inside `[2/9, 7/9]`), not a hard 50/50. A blatantly
dominant team (3 top-meta mons vs 3 joke mons) wins **all 9** pairings.

**Instance rules.** As with `simBattle`, `teamA` and `teamB` must be distinct
Pokemon instances from each other (pvpoke mutates `.index`/battle state on the
objects it is handed); for a mirror match, build the same species twice. Every
`battleTeams` call resets the Pokemon it is given, so instances may be reused
across sequential calls, and a **fresh `Battle`** is constructed per call
(matching pvpoke's own `MatchHandler`).

## Parallel battles (`parallel.js`)

`battleTeams` calls are independent and fully self-contained (each resets its
own `Battle`, virtual clock, and seeded RNG -- see above), so many can run at
once across OS threads with no change to the engine or any battle math.
`parallel.js` spawns a pool of `node:worker_threads` workers, each of which
boots its **own** headless pvpoke engine context exactly once
(`parallelWorker.js` calls the same `initEngine` everything else uses) and
then answers a stream of battle specs from the main thread. Results come back
**in spec order**; `test/parallel.test.js` asserts they match a serial loop of
`battleTeams(ctx, spec)` calls (plus edge cases at `threads=1` and
`threads=4`) for that suite's battle plans. See **"Resolved: battle order and
reused-instance state"** below: verification originally found exact HP
totals could drift from a serial run when a Pokemon instance was reused
across several battles in a different order, because pvpoke itself carried a
subtle order-sensitivity across such reuse -- later work found and
fixed the mechanisms behind that, and results are now bit-identical, not
merely winner-equivalent.

### `createExecutor` vs `runBattles`

Two exports cover this, at different granularities:

- **`createExecutor({threads, vendorRoot, continueOnError})`** is
  the persistent form: it returns `{run(specs), close()}`. The worker pool
  boots **once** -- lazily, on the first `run()` call that actually has work
  -- and is **reused** across every later `run()` call, so pool+engine boot
  cost (dominated by each worker parsing/indexing `gamemaster.json`) is paid
  once for the executor's whole lifetime instead of once per batch. `close()`
  terminates every worker; a `run()` issued after `close()` has been called
  rejects immediately instead of touching a torn-down pool.
- **`runBattles(specs, {threads, vendorRoot})`** is unchanged in
  signature, behavior, and return shape -- it is now a thin
  `createExecutor` → `run` → `close` wrapper: one pool, one batch, torn down
  before the returned promise settles. Use it for a single one-off batch;
  use `createExecutor` directly when many batches will run over the
  executor's lifetime (e.g. a multi-stage tournament run or an evaluator
  scoring many candidates) and you want to amortize boot
  cost across them.

**`run()` concurrency: serialized, not interleaved.** Multiple `run()` calls
against one executor are safe to fire without awaiting each other -- each
still resolves with its own correct results, in its own spec order -- but
they execute **one at a time, in call order**, against the shared pool; the
next call's battles aren't dispatched until the previous call's entire batch
has resolved (or rejected). This was chosen over interleaving two batches'
specs across the same workers because it keeps each batch's bookkeeping
(results array, dispatch cursor, idle-worker counting, fault handling)
completely independent, with no shared mutable state between batches to get
wrong. `close()` is likewise queued behind any already-issued `run()` calls,
so it waits for in-flight work to finish rather than yanking workers out from
under a running batch.

**Per-spec fault isolation (`continueOnError`).** By default (`continueOnError`
unset/false), a single bad spec rejects the **whole** `run()` call -- same
whole-batch-reject semantics `runBattles` has always had. With
`continueOnError: true`, each result slot is instead
`{ok: true, value}` (`value` = exactly what `battleTeams`/`runBattles` return
per spec today) or `{ok: false, error: {message}}`, and a bad spec never
aborts the rest of that call's batch -- callers that want skip-and-continue
semantics (like `scripts/tournament.mjs`'s per-battle error handling) no
longer need to batch small to bound the blast radius of one bad spec (see
the per-candidate-batching workaround below, which `continueOnError` now
makes unnecessary for a caller that adopts it).

**Worker crash: always fatal to the in-flight `run()`, never a per-spec fault
-- even under `continueOnError`.** `continueOnError` isolates *battle*
exceptions caught inside a worker's own try/catch (the worker survives, only
that one spec is bad); a worker crash or unexpected exit is an infrastructure
fault with no reliable way to know what state the in-flight battle was in, so
it always rejects the `run()` call it occurred in, regardless of
`continueOnError`. When that happens the **whole pool** is torn down (every
worker terminated, including survivors -- partial-pool "healing" mid-batch
was judged not worth the complexity) and the executor transparently boots a
**fresh** pool on the next `run()` call; only an explicit `close()` is
terminal. `test/parallel.test.js` covers both halves of this: a worker crash
rejects even with `continueOnError: true`, and the executor recovers on its
next `run()`.

**Thread count is fixed for the executor's lifetime.** `createExecutor`
resolves `threads` once, via `resolveThreadCount(opts.threads)`, when the
pool boots -- it is **not** re-clamped per `run()` call the way `runBattles`
clamps to that call's own `specs.length` (see below), because a persistent
pool must serve batches of very different sizes over its life. A `run()`
call smaller than the pool just leaves some workers idle for that call (the
existing per-run dispatch loop already handles a worker having nothing left
to do); `runBattles`, being one pool per one batch, still clamps
`threads` to `[1, specs.length]` so it never boots a worker with no work at
all.

**Deterministic spec → worker partitioning.** Each `run()` call
splits its specs into **contiguous, deterministic chunks** -- one per worker
-- via `partitionContiguous(specs.length, threads)`, computed purely from the
batch size and the (fixed-at-boot) thread count. A worker only ever pulls its
next spec from inside its own chunk. This replaced availability-based
dispatch (whichever worker finished first grabbed the next spec off a shared
cursor), under which two runs of the *same* `(specs, threads)` could assign
specs to workers differently depending on real execution timing. Since each
worker keeps its own per-spec build cache and reuses Pokemon instances across
the specs it personally handles, and reusing an instance across sequential
battles has pvpoke's own order-sensitivity (see "Known limitation" below),
availability-based dispatch meant the exact sequence of battles a given
worker's instances saw wasn't reproducible run to run -- only each
individual battle's winner was (each spec is self-contained: teams + seed).
Deterministic partitioning makes worker assignment itself a pure function of
`(specs.length, threads)`, so a threaded run at a fixed `(seed, threads)` is
now bit-for-bit reproducible (`test/parallel.test.js`'s reproducibility describe
block proves this on a plan long enough to exercise instance reuse: two
independent `runBattles()`/`createExecutor` calls on the same plan match
exactly). Contiguous chunks (not striped/round-robin) were chosen because
callers build their flat spec lists with locality already in them (all 9
lead pairings of one candidate-vs-meta-team matchup are adjacent, etc.) --
contiguous chunks keep that locality inside one worker's build cache rather
than spreading every matchup evenly across every worker for no throughput
benefit.

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
`[1, specs.length]` so it never spawns a worker with no work; `createExecutor`
does **not** apply that clamp (see "`createExecutor` vs `runBattles`" above)
since its pool must serve many `run()` calls of possibly very different
sizes over its lifetime, not just the one batch in front of it.

**Failure handling.** This is `runBattles`' behavior specifically (it always
runs with `continueOnError` unset); see "`createExecutor` vs `runBattles`"
above for the full `continueOnError`/worker-crash contract, which
`runBattles` sits on top of unchanged. A battle that throws inside a worker
(e.g. an invalid spec) or a worker that crashes outright rejects the whole
`runBattles()` promise with a clear error identifying what went wrong; every
worker is terminated before the promise settles, so a failure surfaces as a
rejection, never a hang. `runBattles` does not retry or skip-and-continue on
a bad spec -- callers that want skip-with-warning semantics at the `runBattles`
granularity (like `scripts/tournament.mjs`'s per-battle error handling)
validate/catch at their own layer, same as they already do around a serial
`battleTeams` call; a caller using `createExecutor` directly can instead opt
into `continueOnError: true` and get that isolation from the executor itself.

**Measured effect (sandbox, this container had 4 vCPUs when this table was
recorded -- see the baseline note below for a re-measurement on an 8-vCPU
sandbox).** `node scripts/bench.mjs --n 80 --threads N` (same 80 deterministic
azumarill/registeel/altaria vs stunfisk_galarian/mandibuzz/clodsire battles
as the serial bench, driven through `runBattles` instead of a loop --
i.e. **one pool booted per `--threads` invocation**, since `bench.mjs` only
calls `runBattles` once per process run today):

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
sandbox's ~172ms/battle for the same code -- see "Performance" below), more
physical cores free of that contention should scale further toward linear;
that number is
not measured here and should be recorded locally when convenient.

**Baseline note.** The table above predates the persistent pool and measures
`runBattles`' per-call pool boot cost, which the pool did not change. A
re-run of `node scripts/bench.mjs --n 150` in a later sandbox (which
happened to have **8** vCPUs, not 4 -- sandbox CPU counts vary run to run)
recorded a serial baseline of **~78.1ms/battle** (150 battles, 11.7s total;
one-time engine setup 22.6ms, team build 2.7ms) and, via today's
per-call-pool `runBattles`, **~50.2ms/battle at threads=2**,
**~36.2ms/battle at threads=4**, **~40.1ms/battle at threads=7** (7 slightly
*worse* than 4 -- with a fixed `--n 150`, more threads means fewer battles
per worker to amortize that worker's own boot cost against, which is exactly
the cost `createExecutor`'s pool reuse is designed to amortize away when a
caller issues many `run()` calls instead of one `runBattles()` call per
batch). `createExecutor`'s own amortized-across-many-`run()`-calls numbers
aren't in this table because `bench.mjs` doesn't yet drive repeated `run()`
calls against one pool (it calls `runBattles`/one-shot `--threads` today) --
that instrumentation is the `--batches` work's job (next paragraph), which
also owns re-measuring speedup on Jaxon's target hardware;
`test/parallel.test.js`'s "pool reused across many run() calls" coverage
confirms the reuse itself is correct, just not yet benchmarked end-to-end.

**`--batches B` added (code half).** `node scripts/bench.mjs --n N
--threads T --batches B` (B > 1) now drives the same N battles, split into B
roughly-equal groups, through repeated `run()` calls against ONE
`createExecutor()` pool instead of one `runBattles()` call -- exercising
exactly the amortization scenario above (`runBenchPersistent` in
`scripts/bench.mjs`, no longer covered by a test after the suite consolidation). Per-batch
timing is printed (or returned in the JSON via `--json`), so batch 0 (pool
boot + battles) is directly comparable against batch 1+ (amortized, no
boot) -- this is the tool to run locally to fill in the table above with
real amortized-pool numbers; `--threads` without `--batches` (or with
`--batches 1`) is unchanged and still reproduces the earlier one-shot
`runBattles()` measurement byte-for-byte. **The measured numbers themselves
are the measurement half of that work and belong on Jaxon's target
hardware** -- not pasted here from a sandbox run.

**Integration status.** `matrix.builtMons` (`src/scoring/index.js`)
and every meta-team member (`buildMetaMon`/`buildRecommendedMon`) now carry a
`spec` field alongside `pokemon` -- the raw `{speciesId, ivs, shadow,
bestBuddy}` a `MonSpec` needs (plus `fastMove`/`chargedMoves` when the mon was
built with an EXPLICIT moveset via `buildMetaMon`, e.g. a curated preset team
member -- `parallelWorker.js` reapplies it via `applyGroupMoveset`, since
`buildPokemon` alone always selects pvpoke's *recommended* moveset, which is
not always what the mon was actually carrying; this was a real bug caught
during verification). `evaluateTeams` (`src/teams/index.js`)
now accepts an opt-in `opts.threads` (and the CLI a `--threads` flag) that
collects every battle across every candidate into one flat spec list and runs
it through a single `runBattles()` call.

**Tournament integration.** The same executor is wired into
`scripts/tournament.mjs`, which drives `battleTeams` directly rather than
through `evaluateTeams` (its 3-stage
funnel needs per-battle skip-and-continue error handling across all three
stages, which `evaluateTeams` doesn't have). `runFunnelStage`'s `opts.threads`
batches one CANDIDATE's entire battle set (every opponent x every lead
pairing) into a single `runBattles()` call, rather than the whole stage --
`runBattles` rejects its entire batch on any one bad spec, so batching at
stage granularity would mean one bad matchup could cost an entire stage's
worth of battles; batching per candidate instead means a batch failure only
costs that one candidate (counted as errors, logged, and skipped, same
skip-and-continue spirit as the serial path, just at coarser granularity).
The spec-carrying plumbing already in place (`matrix.builtMons[key].spec`,
every meta/sampled team member's `.spec`) covers everything `tournament.mjs`
needs -- no additional plumbing was required.

## Resolved: battle order and reused-instance state (history; was "Known limitation")

> **Note on the test citations below.** This section was written when the suite
> ran real battles from eleven files, and it cites `test/teamBattle.test.js`,
> `test/tournament.test.js` and `test/teams.test.js` as the proofs for the two
> mechanisms. Those files were removed when the suite was consolidated so that
> `test/e2e.test.js` is the only place real battles run. The *fixes* described
> here are still in the code and still correct — but the specific regression
> tests that pinned them (the pre-battle-state probe, the `wrapRunScenario`
> restore tests, and the replayed 332-battle flip) went with those files and are
> **not** currently covered. Treat the citations as history, not as a claim about
> what the suite checks today. Re-pinning them would mean porting those cases
> into `test/e2e.test.js`.

**Status (2026-08-22): RESOLVED.** Every mechanism behind this
section's history is fixed, INCLUDING the threaded-execution follow-up the
"What this does NOT yet establish" paragraph below left open. Serial and
threaded execution of the same battles are now bit-identical -- not merely
winner-equivalent or rank-equivalent -- verified directly (`assert.deepEqual`
on full result objects, `avgHpMargin` included, in `test/e2e.test.js`
) and at scale (`scripts/variance-study.mjs`
across several seeds/pool sizes, 0 flips throughout). **Serial is no longer
the "reference" mode threaded execution merely approximates -- both are
simply correct.** The rest of this section is kept as history: it explains
the mechanisms, in the order they were found, for anyone touching
`teamBattle.js`'s setup sequence or reused-instance handling in the future.

Discovered during hands-on verification (executing real battles caught this
-- verification, not code review, is what counts).
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

This is a **pre-existing pvpoke engine characteristic**, not something this
package introduced -- it applies to *any* reuse of a Pokemon instance across
sequential battles, which today's serial `evaluateTeams`/`tournament.mjs`
already do constantly (a candidate's `teamA` instances are built once and
battle every meta team in a loop; a meta team's `teamB` instances are built
once and battle every candidate). Serial execution is self-consistent only
because its battle order never changes run to run; `runBattles`' worker pool
distributes specs across workers in an order that generally differs from the
serial loop's, and each worker's own build cache reuses instances in *its*
order -- so **exact HP totals (`avgHpMargin`, `safeSwap.avgHpPct`) can drift by
a small amount** between a serial and a threaded run of the same inputs.

**CORRECTION (found by executing a larger real run than the original
test covered):** the original claim here -- that win/loss outcomes and team
win rates are *unaffected* by threading -- does not hold in general; it only
held at that smaller test scale. A real `scripts/tournament.mjs` run at
larger scale (4 finalists x 4 opponents x 9 pairings = 144 stage-3 battles,
`test/tournament.test.js`) hit a case where the SAME mechanism above (a
reused instance's `bestChargedMove` tie-break depending on which battles that
cache entry already went through) reclassified one battle's verdict, not only
its HP margin -- a narrow win under serial execution came out a tie under
threaded execution of the identical seed/spec. Practical impact is bounded:
each such flip moves a team's win rate by at most one battle's weight (out of
however many battles feed that rate), and it is rare enough that the
smaller-scale test never tripped over it -- but "unaffected" was too strong a
claim. `test/tournament.test.js`'s threaded-vs-serial test therefore checks
win rates within a small documented tolerance rather than exact equality;
`test/teams.test.js`'s smaller-scale threaded test still happens to pass
exactly, which is consistent with this being rare rather than absent. The
vendor-is-read-only rule (never reimplement battle math) means this is
documented here as a known characteristic rather than patched; it is also
direct evidence for the still-open "TrainingAI variance study" question,
which a future fire could use this as a starting point for.

**UPDATE (2026-08-21): one root cause of the above fixed, a second one found.** Investigation traced the paragraph above to two DISTINCT mechanisms rather than one:

1. **Mechanism 1 (fixed):** `battleTeams()`'s two LEADS get `.battle`/`.index` stamped correctly before their `fullReset()` call -- via `battle.setNewPokemon(orderedA[0], 0, false)` / `(orderedB[0], 1, false)`, called earlier in the function (before the fullReset loop). The four BENCH members never went through `setNewPokemon()` at all, so their `fullReset()` -> `resetMoves()` -> `initializeMove()` read whatever `.battle`/`.index` that instance's constructor left it with -- for a mon built via `buildPokemon()`, that is `ctx.battle` (the ONE shared `Battle` instance `src/scoring/index.js`'s 1v1 matrix pass reuses across the whole scoring pipeline) at `index=0`, meaning `initializeMove()`'s `battle.getOpponent(self.index)` could return whatever opponent an entirely unrelated 1v1 scoring battle last left sitting in that shared battle's other player slot. **Fix:** stamp all 6 members the same way `Battle#setNewPokemon` itself does -- `mon.setBattle(battle); mon.index = <0|1>` -- immediately before the existing `fullReset()` loop. Zero cost (two cheap public-API calls), no battle math touched. Proven directly: `test/teamBattle.test.js`'s new pre-battle-state describe block dirties the shared `ctx.battle` with real 1v1 sims against different species in different orders, then builds a fresh probe team and asserts its pre-battle state (`.index`, `bestChargedMove`, every move's `damage`/`dpe`) is bit-identical regardless of what was left in the shared context -- fails without the fix (moves' `damage`/`dpe` differ), passes with it.
2. **Mechanism 2 (root-caused and fixed; see the "UPDATE" below for the actual final cause, which is NOT this runScenario leak):** even with mechanism 1 fully neutralized (pre-battle state instrumented and proven bit-identical across orderings for all 6 members), a reproduced knife-edge battle from `scripts/variance-study.mjs` STILL flips winner under reordering -- so a second, distinct order-dependent mechanism acts DURING the turn loop, not just at setup. The lead named here originally -- `vendor/pvpoke/src/js/training/TrainingAI.js`'s `runScenario` builds a throwaway `Battle` and calls `setNewPokemon` on real team/bench mons (mutating `.battle`/`.index`/`baitShields`/`farmEnergy`/`priority`), and its restore block puts back 7 fields but not `.battle`, `baitShields`, or `priority` -- was confirmed real by direct code reading and fixed: `src/engine/teamBattle.js` now exports `wrapRunScenario(ai)`, applied to both players' `TrainingAI` instances right after they're constructed, which wraps `runScenario` so every call snapshots and restores those 4 fields (via pvpoke's own public `getBattle()`/`setBattle()` -- a getter exists at `Pokemon.js:1975`, so no vendor edit was needed) on both its `pokemon` and `opponent` arguments, regardless of what the wrapped call does or throws. Every real call site of `runScenario`/`runBulkScenarios` reachable from our headless battle path (`evaluateMatchup`, `decideSwitch`, `decideShield`, and `runBulkScenarios` itself) was traced by hand and confirmed to only ever read the scenario's *return value*, never rely on the leaked mutation persisting -- so the wrap is safe. `test/teamBattle.test.js`'s `wrapRunScenario` describe block proves the wrap mechanism directly against fake stand-ins (restores all 4 fields on both args; restores even if the wrapped call throws; restores correctly across sequential calls -- the shape `evaluateMatchup`'s 4 back-to-back scenario calls actually produce).

   **This is a real, proven, non-no-op fix -- but it does not close mechanism 2.** Re-running `scripts/variance-study.mjs --candidates 5 --opponents 8 --shuffles 3 --seed variance-study` with the fix applied shows one candidate's CANONICAL (single fixed order) win rate shift (0.583 -> 0.597 vs the pre-fix baseline below), proving the leak was live and this wrap changes real battle outcomes. But the SPECIFIC 1-in-360 reversed-ordering flip this section's evidence names is **still present, unchanged** after the fix (still exactly 1/360, reversed ordering only, 0.069% mean, no ranking change) -- so a third, still-unidentified mechanism is responsible for at least that flip, not (solely) the leak just fixed. A future investigation should NOT re-derive the battle/baitShields/farmEnergy/priority leak (now fixed) -- worth looking at instead: `TrainingAI`'s own per-instance `scenarios`/`currentStrategy`/`previousStrategy` fields persisting across a mon's repeated `evaluateMatchup` calls within one battle in an order-sensitive way, or `chooseOption`'s random draw consuming the shared seeded RNG stream at a position that itself depends on how many scenarios were evaluated first (an accounting difference in *how much* randomness is consumed before a given draw, rather than a state-leak difference).

**Net effect as of that point (superseded by the next "UPDATE" below):** mechanism 1 was a real, general bug (bench members could pick up a moveset tie-break from a completely unrelated scoring battle) and was already fixed. Mechanism 2's `.battle`/`baitShields`/`farmEnergy`/`priority` runScenario leak was also real and was fixed here, and measurably changed some outcomes -- but the specific knife-edge flip this section documents survived it, so at THIS point in the investigation the serial/threaded HP-margin and knife-edge-battle drift documented above and in the CORRECTION paragraph was still not fully explained; the serial-reference doctrine stood. Re-running `scripts/variance-study.mjs --candidates 5 --opponents 8 --shuffles 3 --seed variance-study` before and after the ORIGINAL mechanism-1 fix, on that fire's repo state, had produced BIT-IDENTICAL output (same 1-flip-out-of-4-orderings result) -- consistent with mechanism 1 depending on what a completely separate earlier scoring pass leaves lying around, not on battle order within the study itself. A later fire (see the "UPDATE (2026-08-22)" paragraph immediately below) found and fixed the actual remaining cause.

**UPDATE (2026-08-22): mechanism 2 root-caused and fixed.** With mechanism 1 fully neutralized (pre-battle state for all six members bit-identical across orderings, per mechanism 1's own test above), the reproduced `variance-study --candidates 5 --opponents 8 --shuffles 3 --seed variance-study` flip (`4|4|2|2`: candidate `corsola_galarian-empoleon_shadow-tinkaton` lead 2 vs opponent `tinkaton-feraligatr_shadow-gourgeist_super` lead 2) STILL flipped winner under reordering -- proving a second, distinct mechanism, as this section already anticipated. Direct instrumentation (dumping every ROSTER member's state right before `battle.start()`, not just the two active leads mechanism 1 already covered) found it: pvpoke's own `fullReset()`/`Player#setRoster()` never touch a Pokemon's `baitShields`, `farmEnergy`, or `priority` fields -- only `Battle#setNewPokemon()`/`TrainingAI#evaluateMatchup()` do, and both only ever run for whichever Pokemon is currently ACTIVE (the two leads at battle start, or whoever later switches in). A bench member that stays benched the whole battle -- or that was itself a LEAD in this same instance's immediately preceding `battleTeams()` call -- carries those three fields over from that unrelated matchup. Comparing a fresh build of the flipping matchup against the same matchup reached after 332 real prior battles (canonical order) found the bench members sitting at `baitShields=0`/`priority=1` in the contaminated run versus pvpoke's own documented `Pokemon.js` constructor defaults (`baitShields=1`, `farmEnergy=false`, `priority=0`) in the fresh run -- while the two ACTIVE leads' own pre-battle state (index, `bestChargedMove`, every move's damage/dpe) was independently confirmed bit-identical in both runs, isolating the divergence to the bench fields specifically. (An earlier, disproven hypothesis on the way to this: wrapping `TrainingAI#runScenario` to restore `.battle`/`baitShields`/`farmEnergy`/`priority` on its two parameters immediately after each call -- the ticket's originally-suspected lead -- made no difference to the reproduced flip, because the leak isn't from an incomplete restore *within* a call, it's from nothing ever initializing these fields for a Pokemon that participates in a battle without ever being explicitly activated.)

**The fix:** `battleTeams()` now stamps pvpoke's own defaults (`baitShields=1`, `farmEnergy=false`, `priority=0`) on all six roster members immediately after `setRoster()`/`setTeam()`, before `setNewPokemon()` is called on the two leads -- so the lead-only `setNewPokemon` calls and `evaluateMatchup`'s own unconditional reset still correctly override these for whichever Pokemon actually leads or later switches in; this only changes behavior for a Pokemon that stays benched all battle. Same permitted-fix shape as mechanism 1's fix: a public-API-level stamp in our own harness, zero vendor edits, zero battle-math changes.

**Verification.** `test/teamBattle.test.js`'s new bench-state describe blocks: (1) a direct unit test proves a mon that led one battle (deterministically finishing with `priority=1`, via `Player`'s own player-index-based priority, not AI strategy) resets to pvpoke's exact defaults when reused as a bench member of the next battle -- fails without the fix (asserted by reverting it locally), passes with it; (2) the literal reproduced `4|4|2|2` flip, replayed as an exact 332-prior-battles-then-the-flip-battle sequence, now produces a result bit-identical (winner, `survivorsHp`, turn count) to a fresh-instance run of that same matchup -- also fails without the fix. `scripts/variance-study.mjs --candidates 5 --opponents 8 --shuffles 3 --seed variance-study` now reports **0/360 flips across all 4 non-baseline orderings** (down from the 1/360-in-"reversed"-only baseline this section documented above) -- re-run a second time at a different scale/seed (`--candidates 6 --opponents 10 --shuffles 3 --seed t20b-verify`, 540 battles/ordering) for a total of **0 flips across 3,600 battle-comparisons** (2 seeds/scales combined), versus flips present pre-fix. `npm test` stayed **216/216 green** (214 prior + 2 new); no existing test's expected values needed to change, same as mechanism 1's own outcome.

**Follow-up closed (same day, second routine fire, 2026-08-22): the threaded-execution gap the paragraph above left open is now verified fixed, and a fourth field was found in the process.** Reviewing the bench-state fix above (`baitShields`/`farmEnergy`/`priority`) against pvpoke's own `Pokemon` constructor found a fourth field with the exact same shape: `hasActed` also defaults to a constant (`false`, `Pokemon.js:109`), and is ALSO never touched by `reset()`/`fullReset()` -- `Battle#step()`'s own per-turn `poke.hasActed = false` (`Battle.js:300`) only clears it for the two currently-ACTIVE `pokemon[]` slots, never a bench member. A stale `hasActed=true` carried in from a previous battle can make `Battle#getTurnAction`'s `! poke.hasActed` gate (`Battle.js:749`) treat a just-switched-in mon as having already acted this turn -- a real, independent gap in the fix above, not yet covered by its own reset loop. Added to the same reset (`teamBattle.js`'s existing `baitShields`/`farmEnergy`/`priority` stamp loop now also sets `hasActed = false`), proven directly (`test/teamBattle.test.js`'s new bench-`hasActed` test: a `hasActed=true` sentinel does not survive being reused as a bench member -- fails without the fix, passes with it).

With that gap closed, the SPECIFIC follow-up the paragraph above asked for -- re-verifying against real threaded (worker-pool) execution, not just single-threaded list reordering -- was run: `evaluateTeams(ctx, {..., opts:{threads:2}})` vs its serial equivalent on a real fixture collection now produce full-result-object-identical output (`avgHpMargin` included, not just win rates), and `test/tournament.test.js`'s own 144-stage-3-battle threaded-vs-serial test (the exact scale the correction above originally found its flip at) now asserts exact `winRate` AND `avgHpMargin` equality per finalist team instead of the previous `3/36` tolerance band -- and passes. `scripts/variance-study.mjs` re-run across 4 different seeds/pool sizes with the complete fix (all 4 fields): **0 flips out of 1341+ battles combined**, on top of the 0/3,600 the bench-state fix alone already achieved for single-threaded reordering.

**Net effect: the doctrine is retired.** `test/tournament.test.js`'s and `test/teams.test.js`'s threaded-vs-serial tests now assert bit-identity, not tolerance (`test/parallel.test.js`'s own serial-vs-parallel tests already asserted exact equality and needed no change -- its fixed battle plans apparently never happened to hit this class of bug). The "serial is the reference mode, threaded is statistically equivalent" language in the corrections above and in `README.md`'s top-level `--threads` docs is superseded -- same spec + seed → same result, full stop, regardless of execution order or thread count.

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
`vendor/pvpoke/src/data/rankings/all/overall/rankings-<cp>.json` (`<cp>`
being `opts.cp`, default `1500`) directly off disk with `fs.readFileSync`,
assigns them onto the `GameMaster` singleton (`gm.data`,
`gm.rankings.alloverall<cp>`) exactly where pvpoke's own code expects to
find them, and calls pvpoke's own `gm.createSearchMaps()` to index them.
Everything downstream — `getPokemonById`, `getMoveById`,
`selectRecommendedMoveset` — is pvpoke's unmodified code reading real
vendor data.

### CP-cap parameterization (engine layer)

`initEngine({ cp })` (default `1500`) loads the matching
`rankings-<cp>.json` and calls pvpoke's own `battle.setCP(cp)` — always,
even for the 1500 default, so `ctx.battle.getCP()` reflects an explicit
choice rather than relying on `Battle()`'s own default. `buildPokemon`
needed **no changes**: its CP-cap search loop already reads
`battle.getCP()` dynamically rather than a hardcoded 1500, so it was
already CP-generic. Every CP cap pvpoke ships (500/1500/2500/10000) shares
the same `"all"` cup (only a Mega-Pokemon exclusion, no CP/type
restriction), so `battle.setCup()` is still never called — only the CP
number itself varies. An unsupported `cp` (no matching vendored rankings
file) throws a clear error rather than silently falling back.
`test/engine.test.js`'s `initEngine({ cp })` describe block verifies this
end-to-end against `rankings-2500.json`, the same "reproduces pvpoke's own
ratings exactly" pattern the CP-1500 tests use below.

This covers the **engine layer**. A later change threaded `ctx.cp` through
`src/scoring/index.js`'s `defaultIvsForCp` (formerly `defaultCp1500Ivs`) and
`src/meta/teams.js`/`src/meta/usage.js`'s vendor-file paths. A `--cp` CLI
flag, and which meta GROUP file (`groups/great.json` vs `groups/ultra.json`)
represents "the meta" at a non-1500 cp, are still NOT wired.

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

## Performance

`scripts/bench.mjs` times repeated `battleTeams` calls between two fixed,
competitively-matched teams (built once, battled many times — the same
build-once/battle-many pattern `evaluateTeams` and `tournament.mjs` already
use) and reports ms/battle. Sandbox baseline: **~172ms/battle** (Jaxon's
local machine measured ~73-68ms/battle in earlier runs — faster
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
code.** The engine itself (which is read-only vendor code) accounts
for essentially all wall-clock time; this package's driving code is already
close to the noise floor. That is a documented **null result** —
profiled, nothing safe to squeeze — and the real lever for "make battles
faster" is cross-core parallelism (running independent `battleTeams`
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
