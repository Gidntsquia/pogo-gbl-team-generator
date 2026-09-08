# Plan: restructure evolve fitness so popular cores are not counter-bred out

Written 2026-09-08 from an investigation of `out/evolve-meta-vs-meta-newseason`
(100 gens, seed `meta-vs-meta-newseason`, cp 1500, curated-ratio 0,
opponent-meta-pool 400, fitness battle-reality). Read `CLAUDE.md` and
`SIMULATION_RUNBOOK.md` first. Run `bash scripts/setup.sh` before anything.

## Why (the evidence, so the new session does not re-derive it)

1. **Opponent draw is flat.** `src/meta/usage.js` weights species by
   `(pvpokeScore/100)^2.5`. Over the top-400 rankings the score runs 92 → 78,
   so species #1 draws only 1.5x as often as species #400. Sableye, Quagsire,
   Tinkaton each enter at 0.6% of draws, same as Seaking. Water is 18% of slots
   in a flat top-400 draw purely by headcount; the opponent GA amplified it to
   23% (gens 80–99, 288 distinct species in the pool).
2. **Counter-breeding is real and rewarded twice.** Population mean fitness fell
   0.512 → 0.503 after gen 40 while selection kept running. Annihilape's live
   win rate fell 0.558 → 0.533 as its share rose to 21%; Carbink 0.563 → 0.539.
   Two mechanisms in code:
   - `scripts/evolve.mjs` ~line 2597: opponent fitness is
     `1 - winPoints/battles`, an unweighted mean over the candidate population.
     An opponent that beats a 15%-share species collects 15x the credit of one
     that beats a 1% species.
   - Candidate fitness (`evaluateTeamsInOrder`, ~line 1530) counts every
     opponent once, but 247 of 300 pool entries are mutants. A counter lineage
     that spawned 30 near-duplicate children counts 30 times.
3. **The final ranking measures the same thing.** Elites pass = 400 archive
   (strongest bred counters, `buildOpponentArchive`) + 20 fresh flat-drawn
   teams (4.8% of the score). The 30% "recent" term is the live pool from (2).

The user's decisions: rank-position weighting (item A), keep
`--opponent-meta-pool` as is, no curated/usage anchor (new season, no usage
data exists yet), and implement B, C, D below.

## Constraints

- Node ≥ 18, ESM, no TypeScript, no new npm deps. 2-space indent, JSDoc on
  exports. Only `node:test` + `node:assert`.
- Determinism: same seed ⇒ identical results serial or threaded. All randomness
  through `src/util/rng.js`. Nothing here adds randomness; keep every new
  computation a pure function of existing per-generation data.
- Never edit `vendor/pvpoke`. Never reimplement battle math; every change here
  is arithmetic over battle results that already exist.
- Do NOT `git commit` unless the user asks. Keep the diff to the files listed.
- Checkpoint compatibility: `configsMatch` (evolve.mjs ~1252) decides whether a
  resume is valid. Every new knob goes into `config` so an old checkpoint with a
  different setting starts fresh rather than silently grafting.
- Tests: `node --test test/<file>.test.js` per module while working;
  `TS_FULL=1 npm run test:full` once at the end (the hook blocks the bare
  full-suite command; the override is for the pre-push gate).

## A. Rank-position weighting for the species draw

**File:** `src/meta/usage.js` (+ `test/metaUsage.test.js`).

Replace `(score/100)^gamma` with a Zipf-style weight over rank position:

```
weight(species at rank r, 1-based) ∝ 1 / (r + k)^alpha
```

- Rank = position in the rankings file sorted by score descending (the vendored
  file is already sorted; sort defensively, ties broken by speciesId).
- Defaults: `alpha = 1.0`, `k = 5`. Sanity numbers with these defaults over a
  400-species pool: rank 1 ≈ 3.9% of draws, rank 10 ≈ 1.6%, rank 50 ≈ 0.42%,
  rank 100 ≈ 0.22%, rank 400 ≈ 0.06%. Top 20 ≈ 36% of draws, top 100 ≈ 69%.
  (Normaliser is H(400+k) − H(k) ≈ 4.30 for k = 5.)
  Document these in the JSDoc the way the old gamma comment did.
- Species in the universe (`collectSpeciesUniverse`) that have no score keep
  the existing "left out of the map" behavior. Group/training species that have
  a score but sit outside the rankings top-N still get a rank (rank in the full
  file), so nothing that previously had a weight loses it.
- Keep `gamma` accepted in `opts` for one release but unused, OR delete it and
  its callers. Grep for `gamma` across `src/`, `scripts/`, `test/` and pick
  one; delete is preferred if nothing outside tests passes it.
- Export the new tunables as named constants (`DEFAULT_RANK_ALPHA`,
  `DEFAULT_RANK_OFFSET`) and accept `opts.rankAlpha` / `opts.rankOffset`.
- Snapshot path (`data/meta-usage.json`) keeps working: if a snapshot has
  scores, rank by the snapshot's scores.

**Tests to update/add in `test/metaUsage.test.js`:** the existing gamma-ratio
assertions become rank-ratio assertions (rank 1 vs rank 2 ratio = (7/6)^alpha;
rank 1 vs rank 100 ratio ≈ 17.5). Weights still sum to 1. Species with no score
still absent. Delete any test that only exercised gamma.

**Downstream:** `src/teams/sample.js` (candidate sampler) and
`src/meta/sampleTeams.js` consume the same map; no changes needed, but run
`node --test test/sampleTeams.test.js test/sampleCandidates.test.js` to
confirm any fixture that hard-coded expected weights.

**Also:** the `--opponent-meta-pool` cap stays at whatever the user passes
(default 100 in `src/meta/sampleTeams.js`, the recent run used 400). Don't
change the default.

## B. Archetype-stratified candidate fitness

**Files:** `scripts/evolve.mjs` (`evaluateTeamsInOrder` and the fitness line
~2592), a new pure module `src/meta/archetypes.js`, `test/opponentPool.test.js`
or a new `test/archetypes.test.js`.

### B1. Archetype key

Add `src/meta/archetypes.js` exporting:

```js
/** Sorted base-species triple ("a|b|c") after stripping _shadow and form
 *  suffixes via baseIdOf(). Two opponents share an archetype when they share
 *  at least TWO of three base species. */
export function archetypeGroups(opponents) → number[]   // groupId per opponent
```

Implementation: union-find over opponents; union any pair that shares ≥ 2 base
species. O(n²) over ≤ 400 opponents is fine (160k pair checks, once per
generation). Deterministic: iterate in input order, group ids assigned in order
of first appearance. Do NOT use `parentId` chains: an immigrant that happens to
be a Stunfisk/Sableye/Tinkaton build is the same archetype as the mutant
lineage and must be grouped with it.

Expose a helper `archetypeWeights(groups, {beta})` returning a per-opponent
weight of `groupSize^(-beta)`, so an archetype of size s contributes a total
of `s^(1-beta)` votes. Default `beta = 0.5` (export `DEFAULT_ARCHETYPE_BETA`,
accept `--archetype-beta`). This is deliberately sublinear, NOT flat:

| archetype size | total votes at beta 0.5 | (beta 1 would give) |
|---|---|---|
| 1 | 1.0 | 1 |
| 4 | 2.0 | 1 |
| 10 | 3.2 | 1 |
| 30 | 5.5 | 1 |

A 30-strong Stunfisk lineage still outweighs a lone immigrant by ~5×, which
reflects that the pool "believes" in it, but it no longer counts as 30
separate teams to beat. `beta = 0` reproduces today's raw mean; `beta = 1`
is one-vote-per-archetype. Keep beta in `config` so it is resumable.

### B2. Use it as opponentWeights in every generation

`evaluateTeamsInOrder` already accepts `opponentWeights[j]` and computes a
weighted `winRate` (line ~1669, ~1759). Today per-generation calls pass none.
Change the per-generation call (~line 2576) to pass
`opponentWeights: archetypeWeights(archetypeGroups(opponents))`.

Effect: `winRate` becomes a weighted mean in which a crowded archetype's
members each count for `size^-0.5` of a lone opponent. `battles`, `perMeta`,
`opponentTally` stay raw (they are documented as never weighted; keep that).

`snowballScore` (computeSnowballScore) is exchange-count based and unweighted.
Leave it; it is 30% of blend fitness and not the problem. Note this in the
report.

### B3. Record it

- Add `archetypeCount` and the per-archetype size histogram (or at least
  `maxArchetypeSize`) to `computeOpponentAnalytics` output so the generations
  JSON shows how clustered the pool is. Cheap, and it is the number that proves
  B works on the next run.
- Add `config.archetypeBeta` (default 0.5) via `buildRunConfig`, so a
  checkpoint written with a different beta (including old checkpoints that
  lack the key, which behaved as beta 0) is not resumed. `--archetype-beta 0`
  restores the old behavior.

### B4. Test

Pure-function tests on `archetypeGroups`: three teams sharing two species form
one group; a team sharing one species with each of two otherwise-distinct teams
does not bridge them into one group unless it shares two with one of them;
shadow and non-shadow of the same species count as the same base; a group of
size s has total weight s^(1-beta) (beta 0 → s, beta 1 → 1, beta 0.5 →
sqrt(s)). One parameterized test, not five.

## C. Frequency-normalised opponent fitness

**Files:** `scripts/evolve.mjs` (`evaluateTeamsInOrder`, opponent fitness line
~2597), `test/evolve.test.js` if a helper is factored out into
`src/teams/evolve.js`.

### C1. Per-candidate weight

For the current population, compute per-species share
(`computeGenerationAnalytics` already does this as `representation`; factor
the species-share map out into a small helper so both use it). Candidate team
weight:

```
w_i = 1 / max_m share(m)     -- share of the team's MOST common member
```

Rationale: a Melmetal/X/Y team should be down-weighted by Melmetal's share, no
matter how rare X and Y are; that is the term that pays counters for hunting
the majority core. (Using the rarest member instead would let a Melmetal team
carrying one obscure filler slip past the normalisation.) Normalise so weights sum to the population size (keeps the
`0.5` fallback and every downstream magnitude comparable). Clamp each weight to
`[0.2, 5]` before normalising so a single 1-of-118 species cannot dominate an
opponent's score.

### C2. Apply it in the tally

Add `candidateWeights?: number[]` (parallel to `teams`) to
`evaluateTeamsInOrder`. In the accumulate loop, alongside the raw
`opponentTally[j].winPoints/battles`, keep `weightedWinPoints/weightedBattles`
per opponent. Opponent fitness becomes
`1 - weightedWinPoints / weightedBattles` (fallback 0.5 unchanged). Keep the
raw tally fields too; `buildOpponentArchive` and the analytics read them and
should keep reading the raw numbers unless you decide otherwise (document the
choice).

Pass `candidateWeights` only from the per-generation loop, never from the
elites pass (the elites pass does not evolve opponents).

### C3. Record it

Config flag `config.opponentFitnessNormalised: true` (+ `--no-...` to disable)
so `configsMatch` handles resumes. Log the min/max candidate weight per
generation in the existing generation log line.

### C4. Test

Unit test the weight helper: shares {a: 0.5, b: 0.1}, team [a, b, c] gets
weight from `a`; clamping; normalisation sums to n. Put it wherever the helper
lands (if it lives in `scripts/evolve.mjs`, export it and test from
`test/evolve.test.js`, which already imports from that script for
`buildOpponentArchive`-style helpers; check how that file imports first).

## D. Consistency term in candidate fitness

**Files:** `scripts/evolve.mjs` (`evaluateTeamsInOrder` result fields,
`computeBlendFitness`, `DEFAULT_FITNESS_WEIGHTS`), report rendering.

### D1. Per-archetype win rates

With B in place, `evaluateTeamsInOrder` has per-opponent `perMeta[].winRate`
and the archetype group id. Compute per team:

- `archetypeWinRates[]`: mean win rate per archetype group.
- `consistencyScore` = 25th percentile of `archetypeWinRates` (linear
  interpolation, deterministic). Percentile rather than `mean − λ·std` because
  it is scale-free and directly answers "what does this team do against its
  bad archetypes".
- Guard: fewer than 4 archetypes ⇒ `consistencyScore = winRate`.

### D2. Blend

Change `DEFAULT_FITNESS_WEIGHTS` from `{winRate: 0.6, snowball: 0.3,
closer: 0.1}` to `{winRate: 0.45, consistency: 0.2, snowball: 0.25,
closer: 0.1}`. Keep it a documented judgment call in the same comment block
that documents the current one (~line 767). Make `--fitness classic` still
mean plain `winRate` (now the stratified one from B).

### D3. Surface it

- Store `consistencyScore` and `archetypeWinRates.length` on each result entry
  so checkpoints and `analytics.topTeams` carry it.
- Report (`renderEvolveReport`, HTML counterpart): add "worst-quartile
  archetype win%" next to the existing score breakdown for each finalist.
- Elites pass: compute `consistencyScore` there too (archetype groups over
  archive + fresh) and print it; do NOT fold it into `combinedScore` in this
  change. One behavioral change to the finalist ordering at a time; the user
  can decide after seeing the number.

### D4. Test

`computeConsistencyScore([...])`: percentile of a known array, the < 4 guard,
determinism on ties. Extend the existing `computeBlendFitness` test (if one
exists in `test/evolve.test.js`) for the new weight key; otherwise one
parameterized test.

## E. Wiring, docs, verification

1. `--help` text in `scripts/evolve.mjs` for every new flag. `scripts/sim.sh`
   needs no change unless you want the new flags in the recipe; value-bearing
   flags go after `--`.
2. `configsMatch` / `buildRunConfig`: every new knob present with a default so
   old checkpoints do not resume into the new fitness.
3. `CLAUDE.md` Module map: one line for `src/meta/archetypes.js`.
   `SIMULATION_RUNBOOK.md` §7 ("what the recipe actually does"): update the
   fitness description. Wiki page How-Scoring-Works should be updated after the
   user has seen a run; note it in the report, do not edit the wiki.
4. Verification, in this order:
   - `node --test test/metaUsage.test.js` after A.
   - `node --test test/archetypes.test.js test/opponentPool.test.js` after B.
   - `node --test test/evolve.test.js` after C and D.
   - `TS_FULL=1 npm run test:full` at the end.
   - Smoke run, serial and threaded, and diff the checkpoints (must be
     byte-identical apart from timing fields):
     ```
     node scripts/evolve.mjs out/meta-collection-1500.csv --meta --seed smoke \
       --population 30 --generations 3 --opponents-per-gen 20 --pool 40 \
       --curated-ratio 0 --threads 1 --out out/smoke-serial
     node scripts/evolve.mjs out/meta-collection-1500.csv --meta --seed smoke \
       --population 30 --generations 3 --opponents-per-gen 20 --pool 40 \
       --curated-ratio 0 --threads 4 --out out/smoke-threaded
     ```
     (check `--help` for the exact flag names; `--meta` and `--out` may be
     named differently. `out/meta-collection-1500.csv` exists from the last
     run.)
   - Confirm in the smoke log that `archetypeCount` < opponent count and that
     candidate weights show a min < 1 < max.
5. Report back with: the diff file list, the exact new flags and defaults, test
   output, and the smoke-run determinism check. Then the user launches the real
   run via `scripts/sim.sh --meta --name meta-vs-meta-v2 -- --curated-ratio 0
   --opponent-meta-pool 400` (plus whatever flags they choose).

## What this plan does NOT do (agreed with the user)

- No usage-data anchor or curated stratum (no data until the season starts).
- No change to `--opponent-meta-pool` default or the 400 used last run.
- No change to the elites-pass `combinedScore` formula beyond reporting the
  new consistency number next to it.
- No change to opponent-side mutation rates or immigrant fraction. If, after
  the next run, the opponent pool is still > 80% mutants by gen 60, raising
  `DEFAULT_OPPONENT_IMMIGRANT_FRACTION` (0.08) is the next lever; B already
  removes most of the incentive.

## Expected signals on the next full run

Compared with `out/evolve-meta-vs-meta-newseason/evolve-generations.json`:

- Water share of opponent slots (gens 80–99) under 20%, and Sableye, Tinkaton,
  Stunfisk, Alolan Ninetales present from gen 0 at several percent each.
- Population mean fitness flat or rising after gen 40, not falling.
- The top core's live win rate does not fall as its share rises.
- `archetypeCount` per generation well below pool size (a pool of 300 with
  ~60–120 archetypes is the expected shape).
- Finalists with a worst-quartile archetype win% above ~45%.
