# Pokemon GO Great League Team Generator — Plan

## Brief
CLI that reads your Pokemon collection (Poke Genie export CSV or a simple generic CSV), scores every Pokemon for GO Battle League **Great League (CP ≤ 1500)** by battling it against the current Great League meta using **pvpoke's actual battle simulator** (vendored, executed headlessly in Node), then searches teams of 3 for best meta coverage and outputs ranked team recommendations with threat analysis.

## Architecture
- Node ≥ 18, ESM (`"type": "module"`), **no build step**, tests via `node --test`.
- `vendor/pvpoke` — pinned shallow **sparse** clone (only `src/js`, `src/data`), commit `ea601f0a61c548f9140e4605b94a31fa97fe6aba`, **gitignored**, restored by `scripts/setup.sh`. Read-only: we load and execute pvpoke's engine code; we never fork or reimplement its battle math.
- Key vendor paths: engine `src/js/battle/Battle.js`, `src/js/battle/DamageCalculator.js`, `src/js/pokemon/Pokemon.js`, `src/js/GameMaster.js`; data `src/data/gamemaster.json`, meta group `src/data/groups/great.json`, validation ground truth `src/data/rankings/all/overall/rankings-1500.json`.

## Data flow
`collection.csv` → **importer** (normalized mons) → **engine** (level each mon to best CP ≤ 1500 with its actual IVs, pvpoke recommended moveset) → **scoring** (sim matrix vs meta, shields 0v0 / 1v1 / 2v2 weighted 0.25 / 0.50 / 0.25) → **team search** (top K=20 candidates, all C(K,3) combos, coverage metric) → **report** (terminal summary + `out/report.md`).

## Interfaces (contracts between packets — do not drift)
- **NormalizedMon** (importer out): `{ speciesId, name, ivs: {atk, def, hp}, cp?, level?, shadow, purified, lucky, bestBuddy, sourceRow }` — `speciesId` is pvpoke's gamemaster speciesId; no level/CP math in the importer.
- **Engine API** (`src/engine/harness.js`): `await initEngine(opts?)` → `ctx`; `buildPokemon(ctx, { speciesId, ivs, shadow, bestBuddy })` → battle-ready mon at highest level with CP ≤ 1500 (level cap 50, 51 if bestBuddy), pvpoke recommended moveset; `simBattle(ctx, { p1, p2, shields: [s1, s2] })` → `{ rating1, rating2, hp1, hp2, turns }` (ratingX = pvpoke 0–1000 battle rating).
- **Matrix** (scoring out): `{ mons: [{ speciesId, name, score, leadIn }], meta: [speciesId…], ratings: { [userMonKey]: { [metaSpeciesId]: { s00, s11, s22 } } } }` — userMonKey disambiguates duplicates (`speciesId#row`).
- **Teams** (team search out): `[{ members: [3 userMonKeys], score, coveragePct, threats: [uncovered metaSpeciesIds] }]` sorted best-first.

> **Rev 2 (2026-08-20): the project pivoted to 3v3 team battles — see "Rev 2" section at the bottom. The packet table below is historical (P1/P2 landed as described); the live work queue is GOALS.md.**

## Packets
| id | goal | owns (touch nothing else) | deps | verify |
|----|------|--------------------------|------|--------|
| P1 | Headless pvpoke engine harness + validation vs pvpoke's own rankings data | `src/engine/**`, `test/engine.test.js`, `scripts/setup.sh` | — | `node --test test/engine.test.js` |
| P2 | Collection importer (Poke Genie CSV + generic CSV → NormalizedMon[]) | `src/importer/**`, `test/importer.test.js`, `fixtures/**` | — | `node --test test/importer.test.js` |
| P3 | Meta scoring matrix (collection × groups/great.json across shield scenarios) | `src/scoring/**`, `test/scoring.test.js` | P1 | `node --test test/scoring.test.js` |
| P4 | Team-of-3 search + coverage/threat analysis | `src/teams/**`, `test/teams.test.js` | P3 (matrix shape; may build against fixture matrix) | `node --test test/teams.test.js` |
| P5 | CLI + report (`node src/cli.js <collection.csv>` → terminal + out/report.md) | `src/cli.js`, `src/report/**` | P2, P3, P4 | run CLI on fixture collection |
| P6 | End-to-end test on fixture collection + README | `test/e2e.test.js`, `README.md` | all | `npm test` |

Milestone 1 (MVP) = P1–P6. **Stretch:** restrict sims to each mon's current moves; HTML report; `--cp 2500` flag; usage-weighted meta; safe-swap analysis; web UI.

## Scoring & team metric (tunable, documented here)
- Per-mon score = mean over meta of weighted battle rating (0.25·s00 + 0.50·s11 + 0.25·s22). *(Still live — used for candidate pruning and per-mon report insight.)*
- ~~A team covers a meta mon if any member's s11 rating vs it ≥ 500…~~ **Superseded by Rev 2: teams are ranked by simulated 3v3 team-battle results, not 1v1 coverage.**

## Rev 2 — 3v3 team-battle pivot (2026-08-20, user directive)
The user wants candidate teams evaluated in **team battles against meta TEAMS**, not by aggregating 1v1 matchups.

**Primary path — pvpoke's own 3v3 machinery, headless.** pvpoke's Training mode implements full GBL team battles natively: `Battle.js` in *emulate* mode with `src/js/pokemon/Player.js` (team of 3, shared pool of 2 shields per player, switch timer) and `src/js/training/` (TrainingAI: lead/swap/shield decision logic, difficulty levels). Extend the P1 vm-loader to include these modules and expose `battleTeams(ctx, {teamA, teamB, leadA, leadB, difficulty})` → `{winner, survivorsHp, summary}`. Fix the highest AI difficulty; if the AI has stochastic elements, either pin its RNG or aggregate repeated runs — document which. This is not an approximation: it is pvpoke's real team-battle engine.

**Fallback — chained-1v1 battle tree (only if emulate mode proves genuinely infeasible headless, with findings written up first).** Translate 1v1 sims into a 3v3: leads fight (1v1 sim); on a faint, the losing side sends its best remaining counter (chosen from the 1v1 matrix); the survivor carries its remaining HP and energy into the next 1v1 (pvpoke's sim supports custom starting HP/energy); enumerate each player's shared-2-shield allocations across their mons; resolve the outcome tree. Documented plainly as an approximation (no switch-timer dynamics, deterministic switch policy).

**Meta opponents are real teams:** pvpoke ships curated Great League teams in `vendor/pvpoke/src/data/training/` — that's the opponent pool (fallback: compose teams from `groups/great.json` top entries).

**Pipeline (Rev 2):** import collection → 1v1 scoring matrix (pruning + insight + fallback switch policy) → candidate teams = C(topK, 3), no duplicated species (shadow/base count as same species) → every candidate battles every meta team across all 3×3 lead pairings via `battleTeams` → rank by mean win rate (tiebreak: mean surviving-HP margin) → report: per candidate team, win% vs each meta team, best lead, hardest opposing teams.

**Interface (new, for the team evaluator):** `evaluateTeams(ctx, {candidates: [[3 userMonKeys]], metaTeams, matrix, opts})` → `[{members, winRate, bestLead, perMeta: [{metaTeamId, wins, losses, avgHpMargin}], hardestTeams}]` sorted best-first. Work queue and acceptance criteria live in **GOALS.md**.

## Rev 3 — weighted-sampling surface expansion (2026-08-21, user directive)
The exhaustive path (candidates = C(topK,3), opponents = fixed curated list) couples coverage to battle count. Rev 3 decouples them by weighted sampling on BOTH sides of the matchup while holding battles ≈ flat:
- **Usage weights** (`src/meta/usage.js`): per-species weight from vendored `rankings-1500.json` scores (deterministic base), optionally refreshed from pvpoke's live rankings JSON into a committed `data/meta-usage.json` snapshot — never a hard network dependency, tests never touch the network.
- **Opponent sampler** (`src/meta/sampleTeams.js`): opponents = mixture of curated training teams + weighted-random 3-mon compositions from the meta pool (weight ∝ usage). Seeded PRNG lives in `src/util/rng.js` (no npm deps; sampling machinery, not battle math).
- **Candidate sampler** (`src/teams/sample.js`): candidate teams sampled from a wide deduped user-mon pool, P(mon) ∝ blend(normalized 1v1 matrix score, species usage weight) — the user's own meta mons appear on more candidate teams.
- **`evaluateTeams` is UNCHANGED** — samplers are pure list generators feeding its existing `candidates`/`metaTeams` params. The exhaustive path remains available via `--exhaustive`.
- Everything seeded + deterministic by default; the report prints sampling settings + seed for reproducibility.

**Interfaces (Rev 3):** `loadUsageWeights(ctx, opts)` → `Map<speciesId, weight>` (normalized, positive); `sampleOpponentTeams(ctx, {count, weights, seed, curatedRatio, curated})` → same shape as `loadMetaTeams` output; `sampleCandidateTeams({matrix, pool, weights, count, seed, excludeSpecies})` → `[[3 userMonKeys]…]`. Queue: GOALS.md T9–T12.

## Rev 4 — deterministic parallel throughput (2026-08-21, user directive: larger simulations)
Serial is ~73ms/battle on the target 8-core Mac (4P+4E); the 225K-battle overnight ran SERIAL (4h13m) because threaded mode was only statistically equivalent (pvpoke reused-instance `resetMoves()` order sensitivity — engine README "Known limitation") and the worker pool re-boots per `runBattles()` call (per-candidate batches → ~1.23x overall, T15c). Rev 4 makes parallelism bit-deterministic and amortized; vendor stays read-only throughout.
- **Executor** (`src/engine/parallel.js`): `createExecutor({threads, continueOnError})` → `{ run(specs) → Promise<results in spec order>, close() }`. Pool boots once, reused across `run()` calls. With `continueOnError: true` each slot is `{ok:true, value}` / `{ok:false, error:{message}}` — callers keep skip-and-continue at any batch size. `runBattles(specs, opts)` keeps today's exact signature/behavior as a thin create→run→close wrapper.
- **Order independence** (`src/engine/teamBattle.js`): before each battle, drive pvpoke's OWN reset/initialize path in a canonical fixed sequence (or rebuild from spec per battle if canonicalization proves impossible — measure first) so a battle's result is a pure function of (spec, seed): independent of prior battles, execution order, thread count. Retires the "serial is the reference mode" doctrine; serial and any-thread runs must be bit-identical (winners AND survivorsHp). Knife-edge battles may flip once vs pre-Rev-4 serial history — documented, accepted.
- **Adoption**: `scripts/tournament.mjs` batches per STAGE on one persistent pool (per-spec errors preserve its skip-and-continue design); `--threads` defaults to `max(1, cpus-1)`; report records thread count. `evaluateTeams` public interface stays frozen (`opts.threads` already exists; internals may reuse a pool). CLI default stays serial.
- **Target**: ≥3x (aim 4–6x) tournament throughput on the 8-core target machine, proven by a same-seed serial-vs-threaded A/B with identical rankings (bit-identical results post-T20). Queue: GOALS.md T19–T22 (session-owned).

**Amendment 2026-08-21 ~16:05Z (orchestrator, from the determinism investigation):** full bit-identity across thread counts is NOT achievable from the known mechanism alone — with the bench-member `.index`/`.battle` staleness fully fixed and pre-battle state proven bit-identical, a reproduced knife-edge battle still flips under reordering: a SECOND order-dependent mechanism exists inside pvpoke's TrainingAI (`runScenario`'s restore block skips `.battle`/`baitShields`/`priority`; GOALS T20b has the full lead). Rev 4 therefore ships a revised, honest doctrine: (1) T20 lands the proven mechanism-1 stamp fix (zero cost, kills cross-pipeline moveset contamination — a real bug regardless); (2) T21 adds deterministic spec→worker partitioning, making any threaded run REPRODUCIBLE bit-for-bit at a fixed (seed, threads); (3) serial remains the cross-config reference; residual serial↔threaded divergence ~0.28% of knife-edge battles, rank-preserving in every study to date; (4) T20b (queued after the Rev 5 evolution tickets) hunts mechanism 2 — if it lands, tests tighten to full bit-identity and this amendment retires.

## Rev 5 — evolutionary team search ("survival of the fittest", 2026-08-21 user directive)
Jaxon: gen 0 = random candidate teams from the collection; winningest teams move on, some survivors "mutate" (one member swapped), losiest teams die; repeat until convergence — so the best teams/cores bubble up and compute isn't wasted on bad teams. Plus cheap per-generation analytics (e.g. species representation per generation). This is a seeded genetic algorithm layered on EXISTING machinery: fitness = real 3v3 battles (`battleTeams` via the Rev 4 executor), populations built/mutated with the same weighted-sampling primitives as Rev 3 (`sampleCandidateTeams`'s score/usage blend), opponents = fresh seeded `sampleOpponentTeams` draw per generation. GA code is sampling machinery, NOT battle math — vendor stays untouched. Deterministic end to end: same seed → same trajectory (post-T20, even threaded).

**Module split:** `src/teams/evolve.js` = pure generational logic, no battles inside (unit-testable with fake fitness); `scripts/evolve.mjs` = driver (battles, checkpoints, deadline, analytics, report), sibling of tournament.mjs — the funnel stays available.

**Interfaces (Rev 5):**
- `initPopulation({matrix, pool, weights, count, seed, excludeSpecies})` → `[[3 userMonKeys]…]` (delegates to `sampleCandidateTeams`; teams unique by species-set).
- `nextGeneration({population, fitness, pool, weights, matrix, seed, opts})` → `{population, lineage}` where `fitness[i]` = that team's win rate this gen, and `lineage` records per team: survived / mutant-of-X (which slot swapped) / immigrant / died.
- `hasConverged(history, opts)` → `{converged, reason}`.

**Selection defaults (REVISED 2026-08-21 by Jaxon: bottom-50% death "too harsh"; mutation must be a random roll with higher-percentile teams simply likelier to mutate. All tunable via opts/flags):** rank by this generation's win rate; only the bottom `deathRate` fraction dies (default **0.25**); every SURVIVOR then rolls a seeded mutation chance that scales with its fitness percentile (default linear from `mutationFloor` **0.05** at the lowest surviving percentile to `mutationCeil` **0.40** at the top) — a successful roll spawns one MUTANT: a copy with one uniform-random slot swapped to a different eligible pool mon, P(new mon) ∝ the Rev 3 score/usage blend (seeded; random-but-meta-aware), no duplicate species in a team, population deduped by species-set composition, bounded resample retries on collision. Next generation is held at exactly P: rolled mutants fill the dead slots (oversubscription resolved in favor of higher-percentile parents; undersubscription grows the immigrant share), and a floor of ~10% of P fresh IMMIGRANT teams (`sampleCandidateTeams`) is always reserved so the population keeps seeing new blood. Elites are RE-evaluated every generation against that generation's fresh opponent draw — no stale fitness carryover, no overfitting to one opponent sample (`--fixed-opponents` opts out, documented).

**Evaluation per generation:** each team vs M sampled opponents (fresh seed per gen), 3 seeded lead pairings per matchup (tournament stage-1/2 style), per-battle skip-and-continue via the executor's `continueOnError`. Default budget example: pop 100 × 20 opponents × 3 = 6,000 battles/gen ≈ 1.5 min threaded post-Rev-4 (≈7 min serial today); 12 gens ≈ 72K battles. Final generation's elites get the full 9-pairing treatment (bestLead/safeSwap, like tournament stage 3) for the report.

**Convergence:** stop when the top-10 composition set is unchanged for 3 consecutive generations, OR `--generations` cap (default 15), OR `--deadline-minutes`. Report says which fired.

**Analytics (free — counting over data the run already has; no extra battles):** per generation: species representation (fraction of teams containing s), mean fitness of teams containing s, per-species survival rate gen→gen+1, mutation-in vs immigrant-in origin counts; elite 2-species PAIR (core) representation. Written to `out/evolve-generations.json` (full per-gen data) + report section (top-species trajectory table across generations, top cores of the final elites). Queue: GOALS.md T23–T25 (routine-eligible once the T19–T22 fence lifts).
