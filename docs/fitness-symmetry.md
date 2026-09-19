# Candidate/opponent GA symmetry inventory

Read against the codebase as of 2026-09-19 (`FITNESS_SEMANTICS`
`core-pair-archetypes-v16`, after the removal of 1v1 scoring from evolve runs).
BASE is the flag list in `scripts/symmetry-gap.mjs` plus `--meta-mode`.
Every row's status is one of: `removed (commit)`, `kept: <size ± SE>
(labels), <reason>`, or `inactive under BASE: <reason checkable in code>`.
No row ends as `kept`: every difference found was either removed for all runs or
switched off by `--meta-mode`. Line numbers were read on 2026-09-19.

**What is measured and what is not.** The 5-seed labels (`base`, `ga`,
`sample-usage-only-v2`, `finalv14`, `meta3`, `final`) and the 200 x 200 run
(`real`) below were run on v15 code, before 1v1 scoring was removed and before
both pools were widened to the full 281-build field, so they do **not** measure
the current code. After this change only one short sanity run was made (label
`rank`, seed s1, 60 x 60, 3 generations). One seed cannot prove the 0.02 bound.
Rows 2, 4, 6, 10, 12, 13, 25, 27-31 were measured together as one label
(`meta3`) and have no per-row size; that batch's combined step was about
1 SE (see Ladder).

| # | Difference | Candidate side | Opponent side | Status |
|---|---|---|---|---|
| 1 | Mon build: IVs | `src/scoring/index.js` `buildMon`-path uses the CSV's own IVs, defaulted only when blank (`src/importer/index.js:266-278`) | `src/scoring/index.js` `buildMetaMon` always uses `defaultIvsForCp` | inactive under BASE: BASE's CSV (`out/meta-collection-willpower-1500.csv`) is itself built from gamemaster default IVs, so every shared species already has identical IVs on both sides — checkable by diffing any built member's `ivs` field between a candidate and opponent build of the same species under BASE. A real player collection with non-default IVs would make this an active, measurable difference; not yet measured under BASE since it cannot fire there. |
| 2 | Mon build: moveset | pvpoke's auto-selected moveset (`buildPokemon`), or the row's own under `currentMoves` (`src/scoring/index.js:451`) | the exact moveset in pvpoke's rankings file (`buildMetaMon`, `src/scoring/index.js:175`) | inactive under BASE: BASE includes `--meta-mode`, which gives every candidate the rankings-file moveset for its build (`scripts/evolve.mjs:3416`). Each run logs `build parity: N/N ranked builds identical on both sides` (IVs, level, CP, moves, rebuilt fresh from the spec); label `meta3` logged 70/70 in all five seeds and label `rank` (after this change) logged 281/281. Kept for real-collection runs, not measured per row (part of the `meta3` batch, see Ladder): forcing a rankings moveset onto a player's mon would recommend a build they may not have the moves for. |
| 3 | Mon build: level/shadow | `buildPokemon` (`src/engine/harness.js`), solves for max level under the CP cap; shadow branch same function | same `buildPokemon` call | removed: one shared builder function, no side branch — `grep -n "function buildPokemon" src/engine/harness.js` shows one definition, called from both `src/scoring/index.js`'s candidate and opponent build paths. |
| 4 | Species pool criterion | real-collection: the player's mons, `--pool P` keeps the P best-ranked species (`buildRankedPool`, `src/teams/rankedPool.js`); meta mode: every ranked build (`scripts/evolve.mjs:3453`-`3488`) | `--opponent-meta-pool`: top-N builds by pvpoke overall rank (`loadMovesetPool`); under `--meta-mode` the default is the full field (`scripts/evolve.mjs`, `buildRunConfig` `opponentMetaPool`) | removed: the 1v1 matrix-score pool is gone. Both sides now use the same criterion, pvpoke rank, and under `--meta-mode` the same set: label `rank` log reads `candidate species pool = 281 of pvpoke's top 281 ranked builds` and `opponent meta pool of 281 species`. BASE no longer caps either pool (`scripts/symmetry-gap.mjs` `BASE_FLAGS`). Caps still work when passed. Before this change (v15): candidates were cut to 70 builds, opponents drew 70 (label `final`), a config the user rejected. |
| 5 | Sampling weights | `makeRankWeightFn` (`src/teams/sample.js`): each build's pvpoke-rank weight 1/(rank+20) from `loadUsageWeights`, last place when unranked | the same `loadUsageWeights` map (`src/meta/sampleTeams.js`) | removed: the alpha blend of 1v1 score and usage (`--candidate-sample-alpha`, `makeBlendedWeightFn`) no longer exists. Both sides read one weight map (`scripts/evolve.mjs` passes `ignoreSnapshot: true`, so `data/meta-usage.json` cannot reorder either side). Draw share at gen 0 of label `rank`, by node one-liner over `evolve-gen0.json` (see `plans/WORKER_NOTES.md`): top-70 builds hold 54.4% of candidate slots and 53.3% of opponent slots, bottom-70 hold 10.0% and 11.7% (the curve alone gives 55% and 10%). Older measured size of the blend difference (v15, labels `sample-usage-only-v2` minus `ga`): mean final blend −0.1079 → −0.0272, raw −0.1373 → −0.0323. |
| 6 | Evolution expansion | `src/evolution/` expands each row into its evolutions; `dedupeByRank` then keeps one entry per lineage, the form whose build pvpoke ranks best (real-collection runs only) | opponents are built straight from rankings entries | inactive under BASE: `--meta-mode` forces `evolutions: false` (`scripts/evolve.mjs:1442`). With expansion on, a ranked pre-evolution was folded into its evolved form's lineage and vanished from the candidate side: a smoke run logged 62/70 builds present (missing morgrem, zweilous, pawmo, hakamo_o, farfetchd_galarian, grimer_alolan, primeape_shadow, morpeko), 69/70 with expansion off (part of the `meta3` batch). Real-collection runs keep expansion: it is how the tool recommends a form the player does not own yet. Lineage and specimen choice is now by rank weight, then atk×def×hp stat product, then smaller userMonKey (`src/teams/rankedPool.js`), not by 1v1 score. |
| 7 | Shadow-flip mutation | `buildShadowFlip` (`src/teams/evolve.js:283`), rate `DEFAULT_SHADOW_FLIP_RATE = 0.2` (`:81`), fed by `buildShadowTwins` (`:171`) | `buildOpponentShadowFlip` (`src/meta/opponentPool.js:281-315`), rate `DEFAULT_OPPONENT_SHADOW_FLIP_RATE = 0.2` (`:70`), fed by `buildOpponentShadowTwins` (`src/meta/opponentPool.js:150-170`ish) | removed (commit, this Item 2): opponent side previously had no shadowFlip mutation at all; added for mutation-type parity, same 0.2 default rate on both sides, rolled by the one type roll inside `evolveStep` (`src/ga/core.js:223`). Under BASE both sides hold shadow builds: label `finalv14`, gen 7, 254 candidate vs 282 opponent shadow slots of 900 (the round-1 evaluation's "zero candidate shadows" came from grepping the CSV for `shadow=true`; its cells read `true`, 86 of 281 rows). |
| 8 | Gen-0 lead assignment | `assignLead` (`src/teams/evolve.js:198`) — uniform seeded-random, always | `pickLeadIndex` (`src/meta/sampleTeams.js:133-145`) — deterministic highest-lead-prior member when `roleScores` given; `--random-opponent-lead` forces the same uniform-random fallback | inactive under BASE: BASE passes `--random-opponent-lead`, so both sides use uniform-random lead assignment — read at `scripts/evolve.mjs:3497`, `opponentLeadRoleScores = config.randomOpponentLead ? null : roleScores`. |
| 9 | Lead-rotation mutation | `DEFAULT_LEAD_ROTATION_RATE = 0.3` (`src/teams/evolve.js:67`), `buildLeadRotation` (`:262`) | `DEFAULT_OPPONENT_LEAD_ROTATION_RATE = 0.3` (`src/meta/opponentPool.js:92`), `buildLeadRotation` (`:233-243`) | removed: same rate, same mechanics, one type roll inside `evolveStep` (`src/ga/core.js:223`) for both sides. |
| 10 | Team identity | `teamSignature` (`src/teams/evolve.js:140`): lead + sorted backs | `opponentSignature` (`src/meta/opponentPool.js:210`): lead + sorted backs | removed (68e45a6): the opponent side used its positional id, so the same trio with backs swapped counted as two teams there and one here. Both adapters now hand `evolveStep` the same identity rule. `test/opponentPool.test.js` "a culled team cannot be re-created" changed from 6 distinct teams to 3 for this reason. |
| 11 | Member-swap replacement weights | `buildMutant` (`src/teams/evolve.js`), `makeRankWeightFn` | `buildMemberSwap` (`src/meta/opponentPool.js`), the same rank weights | removed: same weight map as row 5 on both sides. |
| 12 | Mutant eligibility | replacement must be a species not on the team, the replaced member's species included | now the same: every current member's base species excluded (`src/meta/opponentPool.js`, `buildMemberSwap`) | removed (68e45a6): the opponent side excluded only the two kept members, so a swap could bring back the replaced species' shadow twin, which on the candidate side only the shadowFlip mutation can do. |
| 13 | Used-identity set | seeded from every team alive at the start of the step, culled ones included | same | removed (68e45a6): one `used` set inside `evolveStep` (`src/ga/core.js:223`). The candidate side used to seed it from survivors only, so it could re-create a team culled the same generation and the opponent side could not. |
| 14 | Voter weights (crowding) | `computeCandidateWeights` delegates to `crowdingWeights` (`src/ga/core.js:142-146`) | `archetypeWeights` called directly on `oppArchetypeGroups` (`scripts/evolve.mjs`) | removed: `crowdingWeights` is exactly `archetypeGroups` + `archetypeWeights`; the opponent path already had the groups computed, same `beta` source (`config.archetypeBeta`) both times — net computation identical. |
| 15 | Strength gammas | `candidateStrengthGamma`, default 1, `Math.pow(clamp(winPoints/battles), gamma) : 1` | `opponentStrengthGamma`, default 1, `Math.pow(clamp(1 - winPoints/battles), gamma) : 1` | inactive under BASE: identical shape, each reads its own side of the same ledger (documented mirror in `scripts/evolve.mjs`); BASE passes `--opponent-strength-gamma 1 --candidate-strength-gamma 1`, read at `scripts/evolve.mjs:2458` and `:2467`; gamma 1 is a no-op power, so both sides are inert. |
| 16 | Blend fitness function | `computeBlendFitness` (`scripts/evolve.mjs`), one shared function, same `DEFAULT_FITNESS_WEIGHTS` | same function, same call | removed: one shared function, no side branch. |
| 17 | Snowball/closer/consistency scores | `computeSnowballScore`/`computeCloserScore`/`computeConsistencyScore` | same functions, same call shape | removed: no side branch in any of the three. |
| 18 | Shared-weakness move-coverage relief | `leadCoverageFor` (`src/teams/typeCoverage.js:198`) | same | removed (12a0e12, 68e45a6): first fix keyed the lookup by build instead of the candidate-only `.key`; this round the key reads moves off the built Pokemon (a candidate matrix entry has no top-level `fastMove`), drops `_shadow` (coverage does not depend on it), and a build absent from the collection is computed on first lookup instead of getting an empty map. Test: `test/typeCoverage.test.js` parity test, which fails on the previous code (map size 1, expected 2). |
| 19 | Selection smoothing (trailing mean) | `trailingFitness` delegates to `trailingFitnessGeneric` (`src/ga/core.js:166-186`) | same `trailingFitnessGeneric`, called directly to produce `opponentSelectionFitness` | removed: same shared function, both sides trailing-smoothed before selection. |
| 20 | Death-rate churn accounting | previously `churn = min(targetSize, round(deathRate * targetSize))`, `survivorsWanted = targetSize - churn` (candidate-only formula, broke under a growing target) | previously `churn = round(deathRate * liveCount)`, `survivorsWanted = max(0, min(liveCount - churn, targetSize))` | removed (commit, this Item 2): `evolveStep` calls `computeChurn` (`src/ga/core.js:61`) for both sides, using the opponent's original (algebraically correct under both growth and shrink) formula. Verified against `test/opponentPool.test.js`'s pre-existing "the cull still fires while the pool is growing" case and a new explicit regression in `test/ga.test.js` (`liveCount:4, targetSize:10` no longer zeroes `deathCount`). One real behavior change: under a deep shrink the candidate side no longer reserves `churn` slots of new blood the way it used to — inert under BASE (`--population-final-ratio 1` never shrinks the candidate side; a fixed `--opponents-per-gen` never shrinks the opponent side). |
| 21 | Immigrant-slot rounding and seat allocation | previously candidate used `Math.round(immigrantFraction * targetSize)`; opponent used `Math.floor(...)` plus a borrow-one-seat rule the candidate side lacked | same as candidate previously | removed (commit, this Item 2): `evolveStep` calls `allocateNewSlots` (`src/ga/core.js:105`) for both sides, which floors the immigrant reserve (opponent's original rule — flooring never over-claims the seat budget at any pool size) and applies the borrow-one-seat rule (previously opponent-only) on both sides. Immigrant count is now computed after mutant building via shared `finalizeImmigrantCount` on both sides (previously only the opponent side backfilled a failed mutant build with an extra immigrant; the candidate side left the slot empty — candidate side now backfills too). |
| 22 | Death rate / mutation rate defaults | `DEFAULT_DEATH_RATE = 1/3`, `DEFAULT_MUTATION_FLOOR/CEIL = 0.05/0.4` | `DEFAULT_OPPONENT_DEATH_RATE = 0.15`, `DEFAULT_OPPONENT_MUTATION_FLOOR/CEIL = 0.02/0.2` — deliberately gentler by design ("the opponent pool is a measuring instrument, not a search") | inactive under BASE: BASE passes explicit equal values on both sides (`--death-rate 0.2 --opponent-death-rate 0.2`, matching mutation floor/ceil pairs), read at `scripts/evolve.mjs:3883` and `:3913`, so the differing DEFAULTS never apply — checkable in any BASE run's `config` block in its `evolve-gen0.json`. |
| 23 | Curated protection | none on the candidate side | `PROTECTED_ORIGINS`, curated headcount/top-up (`src/meta/opponentPool.js`) | inactive under BASE: BASE passes `--curated-ratio 0`, read at `scripts/evolve.mjs:1452`, so no opponent is ever curated/protected. This is opponent input data (a curated preset pool), not GA behavior, and stays by design per PLAN.md Item 2 ("curated protection stays ... must be inert at `--curated-ratio 0`"). |
| 24 | Population/opponent-count schedule | `--population-final-ratio` shrinks `config.population` toward `population * ratio` by the last generation | `opponentsAt(g, config)` is DERIVED to keep the battle grid (population × opponents) constant | inactive under BASE: `--population-final-ratio 1` (BASE, read at `scripts/evolve.mjs:1130`) holds `populationAt(g)` constant, so `opponentsAt(g)` is constant too — no schedule-driven asymmetry under BASE. |
| 25 | Core-rivalry twin mode | `twins: 'lead'` | `twins: 'lead'` | removed (68e45a6): `coreRivalryFitness` is called once, inside `evolveStep`, with `'lead'` for whoever calls. The opponent side used `'positional'`. |
| 26 | Which mean is reported | `analytics.meanFitness` | `analytics.opponentMeanFitness` | removed: same empty-array-safe mean-of-array shape; `scripts/symmetry-gap.mjs` (Item 1) reads raw/weighted siblings computed the same way on both sides. |
| 27 | Shadow builds in the sampler | one sampler entry per (species, shadow) build, weighted by its own pvpoke rank id (`buildScoredPool`, `src/teams/sample.js`), never two builds of one species on a team | shadow and plain are separate pool entries, each with its own weight | removed: this is now the only mode, for real-collection runs too. Before (v15) it was `--meta-mode` only (part of the `meta3` batch: gen 0 of an early meta-mode run without it had 47 distinct candidate builds against 65 opponent builds). |
| 28 | Gen-0 dedupe | unique unordered species set, lead assigned after | same (`src/meta/opponentPool.js:190`) | removed (68e45a6): the opponent side deduped gen 0 by positional id, so it could start with two leads of one trio. |
| 29 | Immigrant dedupe | `evolveStep`'s lead-aware `used` set only (`allowRepeatSets`, `src/teams/evolve.js:420`) | same | removed (68e45a6): candidate immigrants were also deduped by unordered set inside the sampler's batch. |
| 30 | Meta collection species names | CSV `name` column is the base speciesId, resolved exactly (`src/importer/gamemaster.js:171`) | rankings speciesId | removed (68e45a6): the CSV used pvpoke's `speciesName`; pvpoke's rankings label `morpeko_full_belly` "Morpeko (Hangry)", so the candidate side fielded `morpeko_hangry`, a different Pokemon, and had no Full Belly. `out/meta-collection-willpower-1500.csv` was rebuilt (old file kept as `.names-v1.csv.bak`); labels before `meta3` used the old file. |
| 31 | The generation step itself | `nextGeneration` → `evolveStep` | `nextOpponentPool` → `evolveStep` | removed (68e45a6): rivalry ranking, cull, mutation roll, seat split, shadowFlip→memberSwap fallback, fill and dedupe are one function (`src/ga/core.js:223`). Adapters supply only `profilesOf`, `signatureOf`, `buildMutant`, `immigrants`; the opponent side also passes its protected curated entries (`extraParents`, `reserved`), empty at `--curated-ratio 0`. `test/ga.test.js` drives it through two differently-shaped adapters and asserts identical deaths, mutants and immigrants for a steady, shrinking and growing target. |

## Result

Bound: mean candidate-minus-opponent fitness gap within 0.02, blend and raw, at
the final generation and averaged over all generations. Five seeds, 8
generations, 60 x 60, willpower cup, `out/meta-collection-willpower-1500.csv`.

Command (BASE lives in `scripts/symmetry-gap.mjs` `BASE_FLAGS`, which now
includes `--meta-mode`):

```
node scripts/symmetry-gap.mjs run --label final
node scripts/symmetry-gap.mjs report --label final     # exit 0 = inside the bound
```

### After this change (v16): short sanity run only

`node scripts/symmetry-gap.mjs run --label rank --seeds s1 -- --generations 3`
(one seed, 60 x 60, 3 generations, full 281-build field on both sides, no 1v1
scoring; log reads `281 mons built (no 1v1 scoring)`, 0 lines `mons scored`).
`report --label rank`:

```
seed	gen0Blend	gen0Raw	finalBlend	finalWeighted	finalRaw	allGenBlendMean	allGenRawMean	semantics
s1	0.0336	0.0594	0.0151	0.0278	0.0182	0.0165	0.0299	core-pair-archetypes-v16
```

This is a sanity number, not a pass of the 0.02 bound: one seed, 3 generations,
no SE. `report --label rank` prints `VERDICT: FAIL` (exit 1): the final blend
and raw gaps (+0.0151, +0.0182) and the all-generation blend gap (+0.0165) are
under 0.02, but the all-generation raw gap is +0.0299, and gen 0 is +0.0336
blend / +0.0594 raw (the gap shrinks after gen 0 as both populations evolve).
All are inside the 0.05 line at which the work would be reported as a problem.
No
5-seed and no 200 x 200 run was made on v16 (ruled out for this round).

The measurements below are v15 and predate this change.

Before any change (`report --label base`, exit 1):

```
symmetry-gap report --label base
seed	gen0Blend	gen0Raw	finalBlend	finalWeighted	finalRaw	allGenBlendMean	allGenRawMean	semantics
s1	-0.1064	-0.0500	-0.1874	-0.2283	-0.2360	-0.1587	-0.1785	core-pair-archetypes-v13
s2	-0.1090	-0.1000	-0.0986	-0.1080	-0.1004	-0.1270	-0.1377	core-pair-archetypes-v13
s3	-0.0229	0.0035	-0.0584	-0.0678	-0.0717	-0.0490	-0.0564	core-pair-archetypes-v13
s4	0.0319	0.0718	-0.0657	-0.0964	-0.0896	-0.0458	-0.0565	core-pair-archetypes-v13
s5	-0.0542	-0.0339	-0.1536	-0.1865	-0.1954	-0.1286	-0.1439	core-pair-archetypes-v13

mean final blend gap: -0.1127 (SE 0.0251)  mean final raw gap: -0.1386 (SE 0.0324)
mean all-gen blend gap: -0.1018 (SE 0.0229)  mean all-gen raw gap: -0.1146 (SE 0.0247)
VERDICT: FAIL
```

Final code, semantics v15, meta mode on (`report --label final`, exit 0):

```
symmetry-gap report --label final
seed	gen0Blend	gen0Raw	finalBlend	finalWeighted	finalRaw	allGenBlendMean	allGenRawMean	semantics
s1	-0.0299	-0.0240	-0.0085	-0.0121	-0.0129	-0.0276	-0.0274	core-pair-archetypes-v15
s2	-0.0251	-0.0139	-0.0422	-0.0423	-0.0519	-0.0274	-0.0314	core-pair-archetypes-v15
s3	0.0033	0.0006	0.0140	-0.0029	0.0003	0.0089	0.0038	core-pair-archetypes-v15
s4	0.0601	0.0856	0.0080	0.0027	0.0035	0.0348	0.0423	core-pair-archetypes-v15
s5	0.0238	0.0218	-0.0081	-0.0019	-0.0040	0.0186	0.0247	core-pair-archetypes-v15

mean final blend gap: -0.0074 (SE 0.0098)  mean final raw gap: -0.0130 (SE 0.0101)
mean all-gen blend gap: 0.0014 (SE 0.0125)  mean all-gen raw gap: 0.0024 (SE 0.0144)
VERDICT: PASS (<= 0.02 on all four)
```

Paired on the same seeds (`report --label final --minus base`):

```
symmetry-gap --minus: (final) - (base), final-generation gaps
seed	blendDiff	rawDiff
s1	0.1789	0.2231
s2	0.0563	0.0485
s3	0.0724	0.0719
s4	0.0737	0.0931
s5	0.1454	0.1914

mean blend diff: 0.1053 (SE 0.0240)  mean raw diff: 0.1256 (SE 0.0344)
```

At the size the user runs, 200 x 200, 8 generations, one seed so no SE
(`run --label real --seeds r1 --population 200 --opponents-per-gen 200`, then
`report --label real`, exit 0):

```
symmetry-gap report --label real
seed	gen0Blend	gen0Raw	finalBlend	finalWeighted	finalRaw	allGenBlendMean	allGenRawMean	semantics
r1	0.0307	0.0447	0.0074	0.0035	0.0037	0.0072	0.0084	core-pair-archetypes-v15

mean final blend gap: 0.0074 (SE n/a)  mean final raw gap: 0.0037 (SE n/a)
mean all-gen blend gap: 0.0072 (SE n/a)  mean all-gen raw gap: 0.0084 (SE n/a)
VERDICT: PASS (<= 0.02 on all four)
```

## Ladder

Mean final-generation gap +/- SE over seeds s1-s5. Each label is
`out/evolve-symgap-<label>-s*`, summarised in `out/symmetry-gap-<label>.json`.

| label | commit | what changed | blend | raw |
|---|---|---|---|---|
| base | 3d2e843 | nothing | -0.1127 +/- 0.0251 | -0.1386 +/- 0.0324 |
| ga | 12a0e12 | shared churn and seat arithmetic, coverage lookup fix, opponent shadowFlip | -0.1079 +/- 0.0235 | -0.1373 +/- 0.0282 |
| sample-usage-only-v2 | c937359 | candidate sampling weight = usage only (`--candidate-sample-alpha 1`) | -0.0272 +/- 0.0201 | -0.0323 +/- 0.0236 |
| finalv14 | 1c25d84 | same code, alpha 1 made part of `sim.sh --meta` | -0.0272 +/- 0.0201 | -0.0323 +/- 0.0236 |
| meta3 | 68e45a6 | one `evolveStep` for both sides; `--meta-mode`: shared species pool, per-build sampling, rankings movesets, no evolution expansion; CSV species names fixed | -0.0074 +/- 0.0098 | -0.0130 +/- 0.0101 |
| final | 01e9bf9 | logging only; rows identical to `meta3` (`--minus meta3` is 0.0000 on every seed) | -0.0074 +/- 0.0098 | -0.0130 +/- 0.0101 |

Measured steps: `ga` to `sample-usage-only-v2` moved the blend gap from -0.1079
to -0.0272 (rows 5 and 11). `meta3 --minus finalv14` is +0.0198 (SE 0.0163)
blend, +0.0193 (SE 0.0217) raw: that batch (rows 2, 4, 6, 10, 12, 13, 25, 27-31)
was run as one label, so its rows have no separate sizes, and the step is about
1 SE, so it is not shown to be more than noise on five seeds. `base` to `ga`
(+0.0048) is inside noise.

## Remainder

No `kept` rows. On v15 the remainder was the final gap itself: blend -0.0074
(SE 0.0098), raw -0.0130 (SE 0.0101), within 2 SE of zero. On v16 the remainder
is not measured beyond the single sanity run above (blend +0.0151, raw +0.0182,
one seed, no SE). Real-collection runs (no `--meta-mode`) differ between sides on
purpose: candidates are the player's own mons (own IVs, own or auto movesets,
evolution expansion on) while opponents are pvpoke's ranked builds; no equal
fitness is expected there.

## Checking your own run

```
node scripts/fitness-sides.mjs out/evolve-<name>          # per-generation means, both sides
node scripts/symmetry-gap.mjs report --label <label>      # for out/evolve-symgap-<label>-* runs
```
