# Candidate/opponent GA symmetry: what is still asymmetric

Current code: `FITNESS_SEMANTICS` `core-pair-archetypes-v16`, commit 370583a.
Checked 2026-09-19. Fixed differences and every result from older code are in
[History](#history-fixed-differences-and-results-from-older-code-v13-v15) at the
bottom of this file.

## Leftover gap on current code (v16)

Candidate-side mean fitness minus opponent-side mean fitness, in percentage
points (positive = candidates score higher). Source: label `rank`, from
`node scripts/symmetry-gap.mjs report --label rank`
(`out/evolve-symgap-rank-s1/`, `out/symmetry-gap-rank.json`).
**1 seed (s1), 3 generations, 60 x 60, full 281-build field on both sides, no SE.**

| | blend | raw |
|---|---|---|
| final generation | +1.51 | +1.82 |
| all generations, averaged | +1.65 | +2.99 |
| generation 0 (before either side has evolved) | +3.36 | +5.94 |

The accepted bound is 2.00 points. Final-generation and all-generation blend
and final raw are under it; all-generation raw (+2.99) and generation 0 are
over it, so `report --label rank` prints `VERDICT: FAIL`.

**Justification: the leftover gap is probably noise.** One seed with no SE
cannot separate a real gap from noise, and nothing else is claimed. For scale,
the last multi-seed run, on older code (v15, label `final`, 5 seeds, 60 x 60, 8
generations, pools capped at 70), had a mean final-generation gap of -0.74
(SE 0.98) blend and -1.30 (SE 1.01) raw, and an all-generation gap of +0.14
(SE 1.25) blend and +0.24 (SE 1.44) raw. Those are within 2 SE of zero and
inside the bound. No 5-seed run has been made on v16.

## Remaining differences in the code

Each row is a difference that exists in the source today. The number column is
that row's own contribution to the gap, in percentage points. No per-row size
has been measured for any of them, because none can fire in the runs that
measure the gap.

| # | Difference | Candidate side | Opponent side | Number | Fires when | Why it stays |
|---|---|---|---|---|---|---|
| 1 | Mon IVs | CSV's own IVs; blank IVs default to pvpoke's spread (`src/importer/index.js:266-278`) | always pvpoke default IVs (`src/scoring/index.js:180`, `buildMetaMon`) | not measured | Real collections with non-default IVs. Not in meta-vs-meta runs: the meta CSV is built from default IVs. | A player's mon has the IVs it has. |
| 2 | Mon moveset | pvpoke's auto-selected moveset, or the row's own with `currentMoves` (`src/scoring/index.js:451`) | the exact moveset in pvpoke's rankings file (`src/scoring/index.js:175`, `buildMetaMon`) | not measured | Real-collection runs. `--meta-mode` overrides candidates with the rankings moveset (`scripts/evolve.mjs:3416`). | Forcing a rankings moveset onto a player's mon would suggest moves they may not have. |
| 3 | Evolution expansion | each row expands to its evolutions; one entry per lineage is kept (`src/evolution/`, `dedupeByRank` in `src/teams/rankedPool.js`) | opponents built straight from rankings entries | not measured | Real-collection runs (default). `--meta-mode` forces it off (`scripts/evolve.mjs:1442`). | It is how the tool suggests a form the player does not own yet. |
| 4 | Gen-0 lead choice | uniform random (`assignLead`, `src/teams/evolve.js:198`) | highest lead-prior member when role scores are passed (`pickLeadIndex`, `src/meta/sampleTeams.js:129-141`) | not measured | Default flags. `--random-opponent-lead` (in the gap runs' flags) makes both random (`scripts/evolve.mjs:3497`). | The lead prior is the better opponent model outside the gap runs. |
| 5 | Strength gamma | `candidateStrengthGamma`, default 1 (`scripts/evolve.mjs:2467`) | `opponentStrengthGamma`, default 1 (`scripts/evolve.mjs:2458`) | not measured | Only if the two flags are set to different values. Both default to 1 and mirror each other. | Mirror of each other; kept as separate knobs for experiments. |
| 6 | Death and mutation rate defaults | `DEFAULT_DEATH_RATE = 1/3`, mutation 0.05-0.4 (`src/teams/evolve.js:56-58`) | `DEFAULT_OPPONENT_DEATH_RATE = 0.15`, mutation 0.02-0.2 (`src/meta/opponentPool.js:68`, `:77-78`) | not measured | Default flags. The gap runs pass equal explicit values (`scripts/evolve.mjs:3883`, `:3913`). | The opponent pool is a measuring instrument, not a search, so it changes more slowly. |
| 7 | Curated opponents | none | curated preset teams are protected from culling (`PROTECTED_ORIGINS`, `src/meta/opponentPool.js:116`) | not measured | Default `--curated-ratio`. The gap runs pass 0 (`scripts/evolve.mjs:1452`), so none exist. | It is opponent input data (real GL teams), not GA behavior. |
| 8 | Population/opponent-count schedule | `populationAt` shrinks the population by `--population-final-ratio` (`scripts/evolve.mjs:1130`) | opponent count is derived to keep the battle grid constant (`opponentsAt`) | not measured | Default flags. The gap runs pass `--population-final-ratio 1`, so both stay constant. | Fewer candidates late in a run saves battles once the search has converged. |

Real-collection runs differ between sides on purpose (rows 1-3, 6-8), so a gap
there is not evidence of a bug.

## Checking your own run

```
node scripts/fitness-sides.mjs out/evolve-<name>          # per-generation means, both sides
node scripts/symmetry-gap.mjs report --label <label>      # for out/evolve-symgap-<label>-* runs
```

## History: fixed differences and results from older code (v13-v15)

Nothing below describes current code except where marked. Line numbers here
may no longer match the source.

### Fixed differences

One line each: what it was, what removed it, measured size where one exists.
Sizes come from the Ladder below and are on older code.

- Level/shadow build: one shared `buildPokemon`, no side branch.
- Species pool criterion: candidate pool was cut by 1v1 matrix score, opponent pool by pvpoke rank. Now both use pvpoke rank and, under `--meta-mode`, the same 281-build set (v16, commit 370583a). Old (v15) config: 70 builds a side.
- Sampling weights: candidates used a blend of 1v1 score and usage (`--candidate-sample-alpha`), opponents usage only. Now both use `1/(rank+20)` per species+shadow build (370583a). Size, v15, `sample-usage-only-v2` vs `ga`: final blend -10.79 -> -2.72 points, raw -13.73 -> -3.23.
- Shadow-flip mutation: opponent side had none; added with the same 0.2 rate (Item 2, `ga` label; no separate size).
- Lead-rotation mutation: same rate and mechanics on both sides via `evolveStep` (`src/ga/core.js`).
- Team identity: opponent side used a positional id, candidate side lead + sorted backs; both now use lead + sorted backs (68e45a6, part of `meta3`).
- Member-swap replacement weights: both use the rank-weight map (370583a; size shared with the sampling-weights row).
- Mutant eligibility: opponent swap could bring back the replaced species' shadow twin; now excluded on both sides (68e45a6, `meta3`).
- Used-identity set: candidate side seeded it from survivors only; both now seed from every team alive at step start (68e45a6, `meta3`).
- Voter (crowding) weights: both call the same `crowdingWeights` path; no side difference in output.
- Blend fitness function: one shared `computeBlendFitness`.
- Snowball/closer/consistency scores: one shared function each.
- Shared-weakness move-coverage relief: lookup key read differently per side; fixed in 12a0e12 and 68e45a6 (`ga` label; no separate size).
- Selection smoothing (trailing mean): one shared `trailingFitnessGeneric`.
- Death-rate churn accounting: two different formulas; one `computeChurn` (Item 2, `ga`).
- Immigrant-slot rounding and seat allocation: round vs floor and a borrow-one-seat rule on one side only; one `allocateNewSlots` (Item 2, `ga`).
- Core-rivalry twin mode: opponent side used `'positional'`, candidate `'lead'`; both `'lead'` (68e45a6, `meta3`).
- Which mean is reported: same shape on both sides; no difference.
- Shadow builds in the sampler: shadow and plain were separate entries only in `--meta-mode`; now always (370583a; part of `meta3`, no separate size).
- Gen-0 dedupe: opponent side deduped by positional id; both now by unordered species set (68e45a6, `meta3`).
- Immigrant dedupe: candidate immigrants were also deduped inside the sampler batch; now only by `evolveStep`'s set (68e45a6, `meta3`).
- Meta collection species names: CSV used pvpoke `speciesName`, so `morpeko_full_belly` became `morpeko_hangry` (68e45a6, `meta3`).
- The generation step itself: `nextGeneration` and `nextOpponentPool` are now thin callers of one `evolveStep` (68e45a6, `meta3`). `meta3 --minus finalv14` is +1.98 points (SE 1.63) blend, +1.93 (SE 2.17) raw for the whole batch, about 1 SE.

### v16 sanity run (raw report)

`node scripts/symmetry-gap.mjs run --label rank --seeds s1 -- --generations 3`;
`report --label rank`:

```
seed	gen0Blend	gen0Raw	finalBlend	finalWeighted	finalRaw	allGenBlendMean	allGenRawMean	semantics
s1	0.0336	0.0594	0.0151	0.0278	0.0182	0.0165	0.0299	core-pair-archetypes-v16
```

### Results on older code (v13-v15)

Bound: mean candidate-minus-opponent fitness gap within 0.02, blend and raw,
final generation and averaged over all generations. Five seeds, 8 generations,
60 x 60, willpower cup, `out/meta-collection-willpower-1500.csv`.

```
node scripts/symmetry-gap.mjs run --label final
node scripts/symmetry-gap.mjs report --label final     # exit 0 = inside the bound
```

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

### Ladder (older code)

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
to -0.0272 (the sampling-weight and member-swap-weight differences). `meta3 --minus finalv14` is +0.0198 (SE 0.0163)
blend, +0.0193 (SE 0.0217) raw: that batch (team identity, mutant eligibility, used-identity set, core-rivalry twin mode, gen-0 and immigrant dedupe, species names, per-build sampling, the shared step, plus differences 1-3 of the current table under `--meta-mode`)
was run as one label, so its rows have no separate sizes, and the step is about
1 SE, so it is not shown to be more than noise on five seeds. `base` to `ga`
(+0.0048) is inside noise.

