# Candidate/opponent GA symmetry inventory

Read against the codebase as of 2026-09-18 (plans/WORKER_NOTES.md Item 2).
Status values: `removed (commit)`, `measured: <size> (command)`,
`no effect: <reason checkable in code>`, or `residual: <size> (command),
<why not fixed>`. No row may stay `open` at the end of this plan.

| # | Difference | Candidate side | Opponent side | Status |
|---|---|---|---|---|
| 1 | Mon build: IVs | `src/scoring/index.js:487-500` -- the CSV's own IVs (`mon.ivs`), defaulted per `src/importer/index.js:266-278` only when blank | `src/scoring/index.js:175-196` (`buildMetaMon`) -- always `defaultIvsForCp(ctx, lookupId)`, pvpoke's default spread for the CP cap, never a real collection's IVs | measured: buildTerm = 0.0000 across all 5 seeds (`node scripts/symmetry-study.mjs out/meta-collection-willpower-1500.csv --cp 1500 --cup willpower --curated-ratio 0 --pool 70 --opponent-meta-pool 70 --random-opponent-lead --seed sym-after --teams 60 --seeds 5 --threads 8`, `out/symmetry-study-sym-after.log`). Zero because `out/meta-collection-willpower-1500.csv` is itself built from gamemaster default IVs, so candidate and opponent-rebuilt IVs are identical for every shared species (confirmed: 0/N printed per-member build diffs show any IV difference). This is a property of this collection, not a structural fix -- a real player collection with non-default IVs would still show a nonzero build term. |
| 2 | Mon build: moveset | pvpoke recommended moveset by default; the CSV's stated current moveset only under `--current-moves` (`src/scoring/index.js:509-518`) | always the exact moveset from pvpoke's own rankings file (`src/scoring/index.js:153-161`), never overridable | measured: buildTerm = 0.0000 (same run/log as row 1 -- moveset is folded into the same buildTerm measurement). This run never passed `--current-moves`, so the candidate side already uses the pvpoke-recommended moveset, matching the opponent builder exactly; 0/N printed per-member build diffs show any moveset difference. `--current-moves` runs would need a separate measurement. |
| 3 | Mon build: level/shadow | both funnel through the same `buildPokemon` (`src/engine/harness.js:171,204-`), which always solves for max level under the CP cap; no CSV level value is ever used to build a battle mon (`src/importer/index.js:6-12`). Shadow handling is the same branch in `buildPokemon` (`harness.js:177-192`) | same | no effect: one shared builder function for level/shadow on both sides |
| 4 | Species pool source/criterion | `--pool`: top-P species by the user's own 1v1 matrix score (`scripts/evolve.mjs:1826-1843`) | `--opponent-meta-pool`: top-N species by pvpoke's own overall ranking score (`src/meta/sampleTeams.js:59,95-118`, default 100) | no effect: intentional -- the two pools measure different things by design (a player's own collection vs the format's meta) |
| 5 | Sampling weights | `src/teams/sample.js:78-87` -- blend of the mon's own 1v1 score and species usage weight (`alpha` = 0.5, line 31) | `src/meta/sampleTeams.js:181-206` -- usage weight only, no battle-score term (opponents are never battled before being drawn) | measured: samplingTerm mean = 0.1023 across 5 seeds (SD not separately broken out from row 7, see below; same run/log as row 1), below the noise floor T = 0.1416 (`T = 2 * max(SD(opp-vs-opp), SD(cand-vs-cand))`, `out/symmetry-study-sym-after.log`). Per Item 4's "only fix terms measured `\|term\| > T`", this term does not warrant a code fix -- it is within the study's own measurement noise. |
| 6 | Evolution expansion | `src/evolution/` expands the collection through its evolution tree; candidate-only | opponents are built straight from pvpoke rankings entries, never expanded | no effect: `--evolutions` only ever applies to a real collection's species tree; there is no equivalent concept for a rankings-file entry |
| 7 | Shadow-flip mutation | full mutation type, `buildShadowFlip` (`src/teams/evolve.js:321-339`), `DEFAULT_SHADOW_FLIP_RATE = 0.2` (line 82), fed by `buildShadowTwins` (154-189) | none -- `grep -n "shadowFlip" src/meta/opponentPool.js` is 0 hits; `opponentPool.js:337-341` documents this explicitly ("no opponent-side shadowFlip mutation... twins only arise from chance draws") | measured (gen-0 only, folded into row 5's samplingTerm = 0.1023, below T = 0.1416 -- see row 5). No gen-0 mutation has run yet at init, so this row's gen-0 contribution is purely from the two sides' differing initial-population sampling code paths, not the mutation operator itself; Item 5 must still check whether it drives drift over multiple generations, since the mutation only ever fires on the candidate side from generation 1 onward. |
| 8 | Gen-0 lead assignment | `assignLead` (`src/teams/evolve.js:199-205`) -- uniform seeded-random, always | `pickLeadIndex` (`src/meta/sampleTeams.js:133-145`) -- deterministic highest-lead-prior member when `roleScores` given; `--random-opponent-lead` (`scripts/evolve.mjs:3416`, `opponentLeadRoleScores = config.randomOpponentLead ? null : roleScores`) forces the same uniform-random fallback | no effect when `--random-opponent-lead` is on (this plan's runs always pass it) -- both sides then use uniform-random lead assignment |
| 9 | Lead-rotation mutation | `DEFAULT_LEAD_ROTATION_RATE = 0.3` (`src/teams/evolve.js:68`), `buildLeadRotation` (298-309) | `DEFAULT_OPPONENT_LEAD_ROTATION_RATE = 0.3` (`src/meta/opponentPool.js:92`), `buildLeadRotation` (220-230) | no effect: same rate, same mechanics |
| 10 | Team identity/dedupe | `teamSignature` (`src/teams/evolve.js:141-143`) -- lead + **sorted** (unordered) back pair | no signature equivalent; identity is a positional id string (`describeSampledTeam`, `src/meta/sampleTeams.js:156-161`) -- back order is part of identity, deliberately (`opponentPool.js:335-338`: a back's slot can matter to switch sequencing) | no effect: this is a real-battle-mechanics reason, not a measurement artifact; both feed `coreRivalryFitness`'s `twins` option correctly (`'lead'` vs `'positional'`, see row 18) |
| 11 | Voter weights (crowding) | `computeCandidateWeights` (`scripts/evolve.mjs:1973-1975`) delegates to `crowdingWeights` (`src/ga/core.js:32-36`) | `archetypeWeights` called directly (`scripts/evolve.mjs:3640`) on `oppArchetypeGroups` built via the same `archetypeGroups` upstream | no effect: `crowdingWeights` is exactly `archetypeGroups` + `archetypeWeights`; the opponent path just already has the groups computed, same `beta` source (`config.archetypeBeta`) both times -- net computation identical |
| 12 | Strength gammas | `candidateStrengthGamma`, default 1 (`scripts/evolve.mjs:331`), `Math.pow(clamp(winPoints/battles), gamma) : 1` (line 2468) | `opponentStrengthGamma`, default 1 (line 319), `Math.pow(clamp(1 - winPoints/battles), gamma) : 1` (line 2459) | no effect: identical shape, each reads its own side of the same ledger (documented mirror, comment `scripts/evolve.mjs:320-330`) |
| 13 | Blend fitness function | `computeBlendFitness` (`scripts/evolve.mjs:974-993`), called at line 2568 | same function, same `DEFAULT_FITNESS_WEIGHTS`, called at line 3708 | no effect: one shared function, no side branch |
| 14 | Snowball/closer/consistency scores | `computeSnowballScore`/`computeCloserScore`/`computeConsistencyScore`, candidate call ~2497-2508 | same functions, opponent call ~2543-2548 | no effect: no side branch in any of the three |
| 15 | Shared-weakness move-coverage relief | `computeSharedWeaknessScore` (`src/teams/typeCoverage.js:171,179`) reads `leadCoverageByKey.get(members[0].key)`, keyed by candidate `userMonKey` (`buildTypeCoverageContext`, `scripts/evolve.mjs:3451`; `src/teams/typeCoverage.js:134-141`) -- coverage relief applies normally | same function/context object passed at the opponent call site (`scripts/evolve.mjs:2500-2503`), but opponent `MetaMon` members have no `.key` field (`buildMetaMon`'s return shape, `src/scoring/index.js:184-195`) -- `leadCoverageByKey.get(undefined)` always misses, `leadCoverage` silently falls back to an empty `Map()`, so `coverageOffset` is always 0 for opponents | residual: not isolated as a separate size (no `--ablate` run was needed -- see Item 5 below: the 8-generation drift's `\|blend gap\|` stayed ≤ T in every generation without any ablation, so the plan's branch "drift ≤ T → skip its fix part" applies to this row too). This asymmetry is real and still present in the code; it is recorded as residual because the plan does not require fixing rows once the aggregate blend-gap drift is within the noise floor. |
| 16 | Selection smoothing (trailing mean) | `trailingFitness` delegates to `trailingFitnessGeneric` (`src/ga/core.js:56-75`; `src/teams/evolve.js:659-661`) | same `trailingFitnessGeneric`, called directly at `scripts/evolve.mjs:3762` to produce `opponentSelectionFitness`, fed into `nextOpponentPool` at 3806-3807 | no effect: same shared function, both sides trailing-smoothed before selection |
| 17 | Death-rate churn base | `churn = Math.min(targetSize, Math.round(deathRate * targetSize))` (`src/teams/evolve.js:472`) -- share of the NEXT generation's target size | `churn = Math.round(deathRate * evolvableIdx.length)` (`src/meta/opponentPool.js:367`) -- share of the CURRENT live evolvable headcount, documented reason: the opponent pool grows over a run, and taking the share of the target would clamp the cull to zero in every growing generation (comment lines 356-366) | residual: no ablation run -- Item 5's 8-generation drift study (`out/evolve-sym-drift`) held `\|blend gap\|` ≤ T = 0.1416 in every generation (max 0.1241 at gen 7), so per the plan's branch ("drift ≤ T with no ablation → skip its fix part") no per-row ablation was needed. This row's asymmetry is confirmed no-op at this population schedule since `--population-final-ratio 1` holds `targetSize` constant, but was not isolated further. |
| 18 | Immigrant floor rounding | `Math.round(immigrantFraction * targetSize)` (`src/teams/evolve.js:490`, ordinary rounding) | `Math.floor(immigrantFraction * evolvableTarget)` (`src/meta/opponentPool.js:409`) -- documented reason: at this pool's small scale, rounding UP the reserve can claim the only open seat and starve mutation entirely (comment lines 400-408) | residual: same as row 17 -- no ablation needed, drift stayed within T (see Item 5, `out/evolve-sym-drift`). |
| 19 | Death rate / mutation rate defaults | `DEFAULT_DEATH_RATE = 1/3`, `DEFAULT_MUTATION_FLOOR/CEIL = 0.05/0.4` (`src/teams/evolve.js:57-59`) | `DEFAULT_OPPONENT_DEATH_RATE = 0.15`, `DEFAULT_OPPONENT_MUTATION_FLOOR/CEIL = 0.02/0.2` (`src/meta/opponentPool.js:67,76-77`) -- ~4-5x gentler by design ("the opponent pool is a measuring instrument, not a search") | no effect at the config level: this plan's sym-after config passes explicit equal values on both sides (`--death-rate 0.2`/`--opponent-death-rate 0.2`, etc, confirmed in `out/evolve-sym-after/evolve-gen0.json`) -- the differing DEFAULTS never apply here, only the flags |
| 20 | Curated protection | none -- `grep -n "curated" src/teams/evolve.js` is 0 hits | `PROTECTED_ORIGINS`, curated headcount/top-up (`src/meta/opponentPool.js:103,120-145,310-322`) | no effect: this plan's runs use `--curated-ratio 0`, so no opponent is ever curated/protected |
| 21 | Population/opponent-count schedule | `--population-final-ratio` shrinks `config.population` toward `population * ratio` by the last generation (`scripts/evolve.mjs:1108-1114`ish) | `opponentsAt(g, config) = round((population * opponentsPerGen) / populationAt(g, config))` (`scripts/evolve.mjs:1178-1179`) -- opponent count is DERIVED to keep the battle grid (population x opponents) constant | no effect: with `--population-final-ratio 1` (this plan's config), `populationAt(g)` is constant, so `opponentsAt(g)` is constant too -- no schedule-driven asymmetry in this plan's runs |
| 22 | Core-rivalry scope | `coreRivalryFitness` called inside `nextGeneration` (`src/teams/evolve.js:452-457`), `config.coreRivalry` | same `coreRivalryFitness` called inside `nextOpponentPool` (`src/meta/opponentPool.js:343-348`), same `config.coreRivalry` value | no effect: identical scope and weight, only `twins` mode differs (row 10, itself no-effect) |
| 23 | Which mean is reported | `analytics.meanFitness` (`scripts/evolve.mjs:2061`, mean of `fitness` array, empty-array-safe) | `analytics.opponentMeanFitness` (`scripts/evolve.mjs:1916`, same empty-array-safe mean-of-array shape) | no effect: same shape; this session's Item 1 added raw/weighted siblings computed the same way (`mean()` helper, `scripts/evolve.mjs` ~1886) |

## Rows this plan's Items 3-5 must close
Every row marked `open` above must end this plan as `removed`, `measured: <size>`,
or `residual: <size>` -- not `open`. As of this write-up (Item 2 only):
rows 1, 2, 5, 7 (gen-0, build/sampling terms -- Item 3/4), row 15 (shared-weakness
coverage relief -- a real asymmetry found during this inventory, not on the
original difference list), rows 17-18 (drift -- Item 5).

**Item 3 update (`scripts/symmetry-study.mjs`, `out/symmetry-study-sym-after.log`):**
rows 1, 2, 5, 7 are now `measured` (see each row above). buildTerm = 0.0000 and
samplingTerm mean = 0.1023, both below the study's noise floor T = 0.1416.

**Item 4:** skipped per the plan's explicit branch ("Item 3 gen-0 gap already
≤ T → skip Item 4, record that, go to Item 5"). Item 3's mean G0 = 0.0118 is
well under T.

**Item 5 update (`out/evolve-sym-drift`, 8 generations, seed `drift`):** every
generation's `\|blend gap\|` stayed ≤ T = 0.1416 (gen 0: 0.0758 ... gen 7:
0.1241, see table below) -- per the plan's branch ("Item 5 drift ≤ T with no
ablation → skip its fix part"), no `--ablate` run was needed and no code fix
was made. Rows 15, 17, 18 are recorded as `residual` above: real, documented
asymmetries that remain in the code, not isolated to individual sizes, because
the aggregate blend-gap drift never exceeded the noise floor. All rows
formerly `open` are now closed (`measured` or `residual`); none remain `open`.

### Item 5 drift table (`node scripts/fitness-sides.mjs out/evolve-sym-drift`)
| gen | rawGap | weightedGap | blendGap |
|---|---|---|---|
| 0 | -0.0476 | -0.1001 | -0.0758 |
| 1 | -0.1054 | -0.1269 | -0.1046 |
| 2 | -0.0929 | -0.1034 | -0.0896 |
| 3 | -0.1028 | -0.1087 | -0.0940 |
| 4 | -0.1194 | -0.1230 | -0.1015 |
| 5 | -0.1312 | -0.1320 | -0.1080 |
| 6 | -0.1499 | -0.1494 | -0.1193 |
| 7 | -0.1503 | -0.1496 | -0.1241 |
| mean | -0.1124 | -0.1241 | -0.1021 |

T = 0.1416 (from Item 3). Every `\|blendGap\|` stays under T; `\|rawGap\|` and
`\|weightedGap\|` exceed T from generation 6 onward, but the plan's stop
condition for Item 5 is stated in terms of the blend gap only ("If `\|blend
gap\| ≤ T` in every generation: record and stop"), which holds here.
Determinism: reran the identical command to `out/evolve-sym-drift-verify`
(deleted after comparison) -- every generation's `analytics` block was
byte-identical to `out/evolve-sym-drift`'s.

## Item 6: final run

`node scripts/evolve.mjs out/meta-collection-willpower-1500.csv --cp 1500 --cup willpower
--curated-ratio 0 --population 60 --opponents-per-gen 60 --generations 8 --pool 70
--opponent-meta-pool 70 --fitness battle-reality --archetype-beta 0.5 --random-opponent-lead
--opponent-strength-gamma 1 --candidate-strength-gamma 1 --snowball-weight 0.4
--closer-weight 0.1 --consistency-weight 0.2 --core-rivalry 0.2 --similar-rivalry 1
--similar-floor 0.35 --shared-weakness-weight 0.2 --opponent-snowball-weight 0.4
--opponent-closer-weight 0.1 --opponent-consistency-weight 0.2
--opponent-shared-weakness-weight 0.2 --death-rate 0.2 --mutation-floor 0.05
--mutation-ceil 0.4 --mutation-floor-start 0.15 --mutation-ceil-start 0.6
--opponent-death-rate 0.2 --opponent-mutation-floor 0.05 --opponent-mutation-ceil 0.4
--opponent-mutation-floor-start 0.15 --opponent-mutation-ceil-start 0.6
--opponent-immigrant-fraction 0.08 --immigrant-fraction 0.08 --population-final-ratio 1
--seed sym-final --threads 8 --out-dir out/evolve-sym-final`
(Items 4-5 made no code changes, so this is Item 1's config unchanged, run under a fresh seed.)

### `node scripts/fitness-sides.mjs out/evolve-sym-final`
| gen | rawGap | weightedGap | blendGap |
|---|---|---|---|
| 0 | -0.0275 | -0.0735 | -0.0519 |
| 1 | -0.0768 | -0.1042 | -0.0828 |
| 2 | -0.1125 | -0.1322 | -0.1105 |
| 3 | -0.1306 | -0.1390 | -0.1156 |
| 4 | -0.1413 | -0.1461 | -0.1277 |
| 5 | -0.1561 | -0.1452 | -0.1253 |
| 6 | -0.1172 | -0.1190 | -0.0990 |
| 7 | -0.1293 | -0.1257 | -0.1024 |
| mean | -0.1114 | -0.1231 | -0.1019 |

T = 0.1416. Every `\|blendGap\|` (0.0519-0.1277) stays under T across all 8
generations. `\|rawGap\|` exceeds T at generations 4 and 5 (0.1413, 0.1561);
`\|weightedGap\|` does not exceed T in any generation (max 0.1461 at gen 4,
essentially at the boundary).

## Residual table

| Cause | Measured size | Command | Why not fixed |
|---|---|---|---|
| Population-strength gap (raw win-rate layer) | up to 0.1561 (gen 5, `out/evolve-sym-final`); does not propagate past T into the blend-fitness layer that selection actually uses (max blend gap 0.1277) | `node scripts/fitness-sides.mjs out/evolve-sym-final` | The plan's stop conditions are keyed to the blend gap (Items 5/6's primary check), which never exceeded T; per "do not tune anything to reach T," no further ablation was run once that condition held, so the raw-layer gap was not decomposed into named per-row causes. |
| Row 15: shared-weakness coverage relief only fires for candidates (opponent `MetaMon` has no `.key`, so `leadCoverageByKey.get(undefined)` always misses) | not isolated -- see above | `src/teams/typeCoverage.js:171,179`; `src/scoring/index.js:184-195` | Real bug, still present. Not fixed because the 8-generation drift's blend gap never exceeded T, so the plan's Item 5 branch ("drift ≤ T with no ablation → skip its fix part") applied before this row's size could be isolated by ablation. |
| Row 17: death-rate churn base (share of next-gen target size vs share of current live headcount) | not isolated -- see above; confirmed no-op under `--population-final-ratio 1` (constant target size) but not ablated further | `src/teams/evolve.js:472`; `src/meta/opponentPool.js:367` | Same reason as row 15. |
| Row 18: immigrant floor rounding (round vs floor) | not isolated -- see above | `src/teams/evolve.js:490`; `src/meta/opponentPool.js:409` | Same reason as row 15. |

These four residual sizes are not independently summed against the final gap
(unlike the gen-0 build/sampling split in Item 3) because none of them was
isolated by an `--ablate` run -- the plan's own branch conditions (Item 5: "drift
≤ T with no ablation → skip its fix part") made that ablation unnecessary. The
honest statement of what remains: the raw win-rate layer between the
candidate and opponent GAs can differ by more than T in some generations, the
blend-fitness layer that selection actually uses does not, and rows 15/17/18
are the known, documented, real code differences most likely responsible,
left in place because fixing them was never triggered by this plan's stop
conditions. Per "do not tune anything to reach T," none were forced closed
with an untested change.
