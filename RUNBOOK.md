# Simulation Runbook

Operational reference for running this app. Written so an AI assistant can
complete every routine task from this file alone, without reading source.
Run every command from `/home/jaxon/files/pogo-gbl-team-generator` in WSL.

What the app does: take a Pokemon GO collection CSV, find the best 3-mon GO
Battle League teams buildable from it, ranked by real 3v3 battles run through
pvpoke's vendored engine. Two front doors:

| Want | Run | Time |
| --- | --- | --- |
| Quick answer, small sample | `node src/cli.js <csv>` | ~1-3 min |
| Real answer, evolutionary search (the normal case) | `scripts/sim.sh <csv> --name NAME --threads 8 --mutation-floor-start 0.15 --mutation-ceil-start 0.6` | ~8 h |

Everything else in this file supports the second row.

## 1. Preflight (every session, every scheduled run)

```bash
cd /home/jaxon/files/pogo-gbl-team-generator
test "$(git branch --show-current)" = "main"
bash scripts/setup.sh          # materializes/repairs vendor/pvpoke (gitignored) at the pin
test "$(git -C vendor/pvpoke rev-parse HEAD)" = "cc89274c1589574114cb3ba79c7fb24fb25b0468"
```

`setup.sh` is idempotent and fixes an existing checkout to the pin.
`sim.sh` only repairs a *missing* `vendor/pvpoke`; it never re-checks the pin,
so run `setup.sh` yourself first.

Optional sanity check that the preview-season move data is loaded:

```bash
jq -r '.moves[] | select(.moveId=="BODY_SLAM" or .moveId=="BUBBLE_BEAM" or .moveId=="INFESTATION")
  | [.moveId,.power,.energy,.energyGain] | @tsv' vendor/pvpoke/src/data/gamemaster.json
```

Expected: `BODY_SLAM 65 40 0`, `BUBBLE_BEAM 50 50 0`, `INFESTATION 10 0 12`.

Requirements: Node 18+, `jq` for the check above. Machine: 8 cores / 16
threads, 8 GB RAM. Every recent run used `--threads 8`; the raw `cpus-1`
count (15) is slower and OOM'd the VM twice on bare `evolve.mjs`
all-generated-opponents runs (each worker boots its own pvpoke engine
context, so more threads costs memory too). `defaultThreadCount()`
(`src/engine/parallel.js`) caps the automatic default at 8 for this reason,
so an omitted `--threads` is safe -- but still pass `--threads 8` explicitly,
since it's also the measured-fastest count here, not just the safe one (see
"Why `--threads 8`" in section 3).

Memory over a long run: each worker caches every built Pokemon it has seen
(`src/engine/parallelWorker.js`), unbounded before 2026-09-07 (mutation keeps
introducing new IVs/movesets, so RSS grew all run). Now an LRU capped at
5000 entries/side/worker (~70 MB/side at ~14 KB/mon) -- still spans many
generations of turnover. `POGO_GBL_WORKER_CACHE=N` raises or lowers the cap.

The bigger consumer was the per-worker scenario memo
(`src/engine/teamBattle.js`): at its old 200k-entry cap it held ~380 MB/worker
(~3 GB at `--threads 8`) and sat at cap all run -- that plus unbounded V8 heap
growth in 8 isolates is what got `evolve-meta-vs-meta-v5` killed at 8.2 GB
RSS (2026-09-09). Now 20k entries (same hit rate, measured), worker heap
capped at 512 MB; see section 3's `--profile` notes for expected numbers.

The safety net for a run that outgrows the box is this machine's `earlyoom`
(configured `-m 10 -s 20 --prefer node`, so it targets node first once
available memory is under 10% AND swap free under 20%). It SIGTERMs the run,
leaving checkpoints intact; nothing lands in the run's own log, so a run that
stopped without `evolve-DONE` should be checked against
`journalctl -u earlyoom`, which records the killed cmdline (handy for the
resume). The former `scripts/mem-watchdog.sh` was removed on 2026-09-09.

## 2. Inputs on disk

Collection CSVs live in the repo root, are gitignored, and are personal data.
Never commit, move, or rename them.

| File | Owner | Rows |
| --- | --- | ---: |
| `jaxon-gl-collection.csv` | Jaxon, Great League | ~115 |
| `jaxon-ultra-league.csv` | Jaxon, Ultra League (use `--cp 2500`) | ~15 |
| `jet-gl-collection.csv` | Jet, Great League | ~395 |
| `marisa-gl-collection.csv` | Marisa, Great League | ~429 |
| `shared-gbl-collection.csv` | Jaxon ∩ Jet, built by `build-shared-collection.mjs` | ~66 |

CSV shape (header + one mon per row; Poke Genie exports also work):

```text
name,atk,def,sta,shadow,level,cp
Ninetales,9,15,12,,24,1500
```

Test fixtures for dry runs without personal data: `fixtures/*.csv`.

## 3. Standard evolve run (the normal task)

### The recipe every recent real run used

Updated 2026-09-15 (`meta-vs-meta-v6`): snowball-weight raised 0.2 -> 0.4 and
consistency-weight raised 0.1 -> 0.2, per the user directly. Carries forward
the 2026-09-12 (`jaxon-standard-2`, flags from `shared-standard-3-fitness`)
baseline: opponent side co-evolves again (curated-ratio 0.66), candidate
fitness blends snowball + closer + consistency, core-rivalry uses the
similarity-aware terms, and shared-weakness-weight is on. Treat this as the
default unless told otherwise. `sim.sh` already bakes in
`--config recipes/standard.json` (opponents-per-gen 120, elites 15, baseline
weights 0.2/0.1/0.1/0.2 -- see `sim.sh` reference below), so the weight flags
below just override those baseline values with this recipe's raised ones:

```bash
COLLECTION="jaxon-gl-collection.csv"
RUN_NAME="jaxon-standard-2"        # unique, shell-safe; doubles as the PRNG seed

bash scripts/setup.sh
scripts/sim.sh "$COLLECTION" --name "$RUN_NAME" --threads 8 \
  --mutation-floor-start 0.15 --mutation-ceil-start 0.6 \
  --dry-run -- \
  --curated-ratio 0.66 \
  --opponent-meta-pool 100 \
  --archetype-beta 0.5 \
  --opponent-strength-gamma 1 \
  --population-final-ratio 0.4 \
  --snowball-weight 0.4 \
  --closer-weight 0.1 \
  --consistency-weight 0.2 \
  --core-rivalry 0.2 \
  --similar-rivalry 1 \
  --similar-floor 0.35 \
  --shared-weakness-weight 0.2         # inspect, then rerun without --dry-run
```

| Addition | Why |
| --- | --- |
| `--mutation-floor-start 0.15 --mutation-ceil-start 0.6` | hot-start mutation: 15-60% at generation 0, decreasing linearly to the standard 5-40% at the last generation (`mutationRatesAt` in `scripts/evolve.mjs`, covered by a unit test); user asked for this to widen early diversity |
| `--threads 8` | what every recent run used; ~2 GB RSS on an 8 GB machine with headroom for the user's desktop. Re-measured 2026-09-04: 8 is fastest, 12 and 15 are slower (see "Why `--threads 8`" below) |
| `--pool` left unset | no cap -- draws candidates from the whole deduped collection instead of the top 70 by 1v1 score; user asked for the entire collection to be eligible, 2026-09-10 |
| `--curated-ratio 0.66`, `--opponent-meta-pool 100`, `--archetype-beta 0.5` | opponent side co-evolves (no `--fixed-opponents`) -- these are the config that `evolve-shared-standard-3-fitness` (the most recent completed real run, gen 99, DONE) actually used, carried over 2026-09-12 |
| `--opponent-strength-gamma 1` | candidate fitness IS weighted by how strong the opponent it beat was (default weighting) -- reverted from the `jaxon-standard-1` recipe's `0`, per `shared-standard-3-fitness` |
| `--population-final-ratio 0.4` | candidate population at the last generation is 40% of the starting population; per `shared-standard-3-fitness` |
| `--snowball-weight 0.4` | candidate-only fitness weight on `snowballScore` (own fraction of decided lead exchanges won), on top of `winRate: 1`; opponent-side fitness (`src/meta/opponentPool.js`) is a separate plain win-rate calc and is never touched by this flag; raised `0.1` -> `0.2` per `shared-standard-3-fitness`, then `0.2` -> `0.4` per the user directly, 2026-09-15 |
| `--closer-weight 0.1`, `--consistency-weight 0.2` | candidate-only fitness weights on `closerScore` (mean...) and `consistencyScore`; both newly added to the standard recipe per `shared-standard-3-fitness`; consistency-weight raised `0.1` -> `0.2` per the user directly, 2026-09-15 |
| `--core-rivalry 0.2`, `--similar-rivalry 1`, `--similar-floor 0.35` | each better team sharing a two-species core (or a pvpoke-similar core, above the `similar-floor` similarity threshold, weighted `similar-rivalry` relative to an identical core) costs seats in fitness; raised from the earlier default of 0.1 to `0.2`, per `shared-standard-3-fitness` |
| `--shared-weakness-weight 0.2` | candidate-only blend weight on `sharedWeaknessScore` (`src/teams/typeCoverage.js`). Per lead weakness type a back member also carries: lead severity (double weakness = 1.6x single, the actual 2.56/1.6 ratio) × prevalence (rank-weighted share of PvPoke's top 200, dampened by `PREVALENCE_INFLUENCE=0.3` to `(1 - 0.3*(1-prevalence))` rather than raw -- top-200 data spans ~18x, Water 1 vs Rock 0.055, and unblended it alone dragged a real Talonflame/Tinkaton/Walrein double-Rock/single-Electric case to a 0.98 score) × moveset-coverage relief (up to 80% off if the lead's own moves hit that type super effectively) × the other back's resistance offset (partial credit, none if both backs share the weakness). Terms sum to a raw load, normalized against the single worst defensive typing PvPoke's type chart can produce (Dark/Grass, checked across all 171 mono/dual combos), fully shared with no coverage/resistance offset -- so every team is judged on the same scale. No extra battles simulated. Off by default; active in `battle-reality` fitness only; in the resume fingerprint (omitted and explicit 0 are equivalent, v10 semantics -- bump to v11 if the prevalence-dampening math changes). Final report ranking still uses the existing win-rate blend; this term affects evolution and finalist selection only. |

The dry run prints collection, seed, out dir, bans, budget, and the full
`evolve.mjs` command. Confirm bans, anneal flags, and threads appear, then
launch. The launcher refuses to start if `out/evolve-RUN_NAME.pid` points at a
live process.

Add `--exclude carbink` only when asked (the user has excluded Carbink from
candidates before because it is too expensive to build; opponents keep it).
Add `--hours H` when the user gives a time budget; the 8 h marisa run used
`--hours 7.75` (465 min) to leave room for the final pass.

### The "as large as possible" 24 h recipe

Used for `shared-24h-1` when the user asked for large populations to reduce
overfitting. Bare `evolve.mjs`, because `sim.sh` fixes opponents/elites:

```bash
nohup node scripts/evolve.mjs "shared-gbl-collection.csv" \
  --population 450 --opponents-per-gen 160 --generations 130 --deadline-minutes 1410 \
  --pool 70 --elites 15 --threads 8 \
  --mutation-floor-start 0.15 --mutation-ceil-start 0.6 \
  --seed shared-24h-1 --out-dir "out/evolve-shared-24h-1" > out/evolve-shared-24h-1.log 2>&1 &
echo $! > out/evolve-shared-24h-1.pid
```

Result: 129 generations in ~23.5 h at 8 threads. (That run also carried
`--ban cramorant,mimikyu`, a cup rule that no longer applies as of 2026-09-04;
do not add it unless the user asks.) Scale rule for a shorter
budget: keep the grid `population × opponents` proportional to the hours
(36k pairings ≈ 8 h at 100 generations, 72k ≈ 24 h at 130).

### All-generated opponents with co-evolution (2026-09-04)

Optional recipe for when there's no curated/community team file to draw on
(e.g. before `data/meta-teams-community.json` has been repopulated for a new
season). Drop curated teams entirely and let the opponent side evolve as hard
as the candidate side. `--curated-ratio 0` removes curated teams from every
generation AND the final pass. The opponent GA normally culls only 15% and
mutates at 2-20%; mutants can only fill seats the cull opens, so raise the
cull together with the rates. All four `--opponent-mutation-*` flags mirror
the candidate flags, including the linear hot-start anneal. Fresh runs only
(part of the checkpoint fingerprint); bare `evolve.mjs`, since `sim.sh` fixes
opponents/elites.

Lessons from the first run of this recipe (`shared-s2-gen-1`, 2026-09-04, see
section 7 and the 2026-09-05 header note in `scripts/evolve.mjs`): a 0.34
cull turned over a third of the opponent pool per generation, swinging a
team's win rate 3.9 points generation to generation while real teams sat only
2.2 points apart. Selection now ranks on a 5-generation recency-weighted
trailing mean, and the final pass is held out (archive, plus a small fresh
stratum only when `--curated-ratio 0`), which absorbs most of that -- but
keep the cull at 0.2, since the archive already preserves every strong
opponent bred, so churn buys nothing. Size `--generations` to the deadline
(75 for 450 min on this grid) -- a deadline stop mid-schedule leaves both
anneals and the population ramp unfinished. Send 30 finalists to the pass,
not 15: with real teams only ~2 points apart, the top 15 of the trailing
mean is too tight a cut to trust against the out-of-sample pass.

```bash
nohup node scripts/evolve.mjs "shared-gbl-collection.csv" \
  --population 400 --opponents-per-gen 100 --generations 75 --deadline-minutes 450 \
  --pool 70 --elites 30 --threads 8 \
  --curated-ratio 0 \
  --mutation-floor-start 0.15 --mutation-ceil-start 0.6 \
  --opponent-death-rate 0.2 \
  --opponent-mutation-floor 0.05 --opponent-mutation-ceil 0.4 \
  --opponent-mutation-floor-start 0.15 --opponent-mutation-ceil-start 0.6 \
  --seed shared-s2-gen-2 --out-dir "out/evolve-shared-s2-gen-2" > out/evolve-shared-s2-gen-2.log 2>&1 &
echo $! > out/evolve-shared-s2-gen-2.pid
```

Sizing: 400x100 = 40k pairings per generation (the 24 h run was 450x160 over
130 generations). Candidates shrink to 160 and opponents grow to 250 by the
last generation (`--population-final-ratio 0.4`, grid held flat). Gen 0 took
12.6 min on this grid in the s2 run (later ones 5-6 min once the battle cache
warmed); at that pace 75 generations fit the 450 min deadline with the final
pass (30 finalists x ~800 opponents ≈ 24k battles, ~6 min) to spare.
Expected log line:
`generation 0: battling 400 teams against 100 opponents (0 curated, 100 evolved)`.

**Check gen 0 timing before walking away.** The population schedule and both
mutation anneals are indexed to `--generations`, so a deadline stop leaves the
run mid-ramp. If `generation 0: done` reports more than ~13 min, kill the run,
delete the out dir, and relaunch with fewer generations (generations are in the
checkpoint fingerprint, so this must be a fresh start).

```bash
until grep -q "generation 0: done" out/evolve-shared-s2-gen-2.log; do sleep 30; done
grep "generation 0: done" out/evolve-shared-s2-gen-2.log
```

| Flag | Meaning | Default |
| --- | --- | --- |
| `--curated-ratio 0` | no curated/community opponents anywhere, final pass included | 0.66 |
| `--opponent-death-rate R` | evolvable-opponent cull per generation | 0.15 |
| `--opponent-mutation-floor/ceil R` | opponent mutation odds, worst→best survivor | 0.02 / 0.2 |
| `--opponent-mutation-floor-start/ceil-start R` | hot-start values at gen 0, annealed linearly to floor/ceil by the last generation | no anneal |
| `--opponent-immigrant-fraction R` | fresh-immigrant share of the evolvable opponent pool each generation (mirrors `--immigrant-fraction`); in the fingerprint only when set, so existing runs resume unchanged | 0.08 |
| `--selection-trailing N` | generations a team's fitness is recency-weighted-averaged over before the cull/mutation ranking and the finalist pick (1 = the pre-2026-09-05 single-draw behaviour); in the fingerprint only when set | 5 |
| `--elites N` | last-generation teams sent to the final pass; NOT in the fingerprint, so a finished run can be re-rendered with more | 15 |
| `--final-archive N` | final pass: strongest evolved opponents from the whole run, minus any fielded in the last `selection-trailing` generations; not in the fingerprint | 400 |
| `--final-fresh N` | final pass: fresh meta-composed opponents never fought during the run -- these are essentially random legal teams, not opponent-GA-selected ones, so kept off by default; not in the fingerprint | 0 (20 at `--curated-ratio 0`) |

### Meta vs. meta, 30 generations (both sides co-evolving)

The recipe behind the recent `meta-vs-meta-*` runs: no curated/community
opponents anywhere (all Pokemon vs. all Pokemon), both the candidate side and
the opponent side evolving. It's the "All-generated opponents with
co-evolution" recipe above, but generations cut to 30 -- that's what those
runs actually needed to converge, so it's the default for this recipe rather
than the 75 used for the shared-s2 runs. Bare `evolve.mjs`, because `sim.sh`
fixes opponents/elites.

**Symmetry rule (Jaxon, 2026-09-17): the candidate and opponent populations
must be identical in size and in every GA flag.** Both sides draw from the
same pool in a meta-vs-meta run, so there is no reason to break the symmetry.
Concretely, every pair below is set to the same value on both sides, and the
population ramp is switched off so the two sides stay the same size all run:

| Candidate side | Opponent side | Value |
| --- | --- | --- |
| `--population` | `--opponents-per-gen` | 200 (40k pairings/gen, same grid cost as the old 300x120) |
| `--population-final-ratio 1` | (opponent count is derived from it) | 1 -- no shrink/grow, 200 vs 200 every generation |
| `--pool` | `--opponent-meta-pool` | 70 |
| `--death-rate` | `--opponent-death-rate` | 0.2 |
| `--mutation-floor` / `--mutation-ceil` | `--opponent-mutation-floor` / `--opponent-mutation-ceil` | 0.05 / 0.4 |
| `--mutation-floor-start` / `--mutation-ceil-start` | `--opponent-mutation-floor-start` / `--opponent-mutation-ceil-start` | 0.15 / 0.6 |
| `--immigrant-fraction` | `--opponent-immigrant-fraction` | 0.08 |

Also pass `--random-opponent-lead` (2026-09-17, Jaxon): without it, every
composed opponent gets pvpoke's own lead-prior winner rotated into slot 0
(`composeSampledOpponent` -> `pickLeadIndex`), while the candidate side always
assigns a uniform-random lead and only converges on a good one through
selection (`assignLead` / `buildLeadRotation` in `src/teams/evolve.js`). That
gap gave the opponent side a lead-quality head start from generation 0 on in
every prior `meta-vs-meta-*` run -- a persistent opponent-fitness-over-
candidate-fitness gap (~0.55 vs ~0.47 mean, both at gen 0 and after 20+
generations) that never closed on its own. `--random-opponent-lead` makes
opponent composition assign leads the same random way as candidates.

#### Known artifact: candidates read ~5-8pts low on fitness (side bias, not population skill)

(Jaxon, 2026-09-17) Every meta-vs-meta run, including the paused
`evolve-meta-vs-meta-willpower-3`, shows candidate mean fitness running
several points below opponent mean fitness every generation, even with
`--random-opponent-lead` on and the symmetry rule fully satisfied.
`node scripts/fitness-sides.mjs out/evolve-meta-vs-meta-willpower-3` prints
the numbers: over generations 0-44, candidate fitness averages 0.476, raw
candidate win rate (mean of `winRateBySignature`) averages 0.460, opponent
fitness averages 0.542 -- at gen 44 alone raw win rate (0.450) plus opponent
fitness (0.551) sum to 1.001. That sum holding near 1.00 every generation is
the tell: the two numbers are not independent strength measurements, they
are the same ~40,000 battles per generation read from opposite sides of one
scoreboard -- when candidates win 45%, opponents "win" the other 55% by
definition, and that 55% is what's stored as opponent fitness.

Cause: candidates always battle as team A, opponents always as team B
(`scripts/evolve.mjs` lines 94-98, `src/teams/index.js` lines 17-23), and
pvpoke emulate mode carries a residual team-B edge even in a mirror match --
a top-meta team against itself splits 5-4 across 9 lead pairings, 55.6% for
team B (`src/engine/README.md` "Balance / tolerance"). A 200x200 co-evolving
population run for 45 generations turns that single-pairing bias into a
population-scale ~5-8pt offset. This is a harness side-assignment bias, not
a skill gap: the symmetry rule still holds (identical size and GA flags both
sides), the offset cancels for ranking teams within one side, and it does
not cancel in the absolute mean-fitness number.

Ruled out against the checkpoints/code: IVs (both sides use pvpoke default
IVs -- `resolveDefaultIvs`, `src/importer/index.js:273`; `defaultIvsForCp`,
`src/scoring/index.js:175-195`); shadows (present both sides); pool size and
GA flags (identical per the symmetry-rule table, checked in each
checkpoint's `config`). Still open: candidates get pvpoke's recommended
moveset (`src/scoring/index.js:148-150`) vs. opponents' explicit
`loadMovesetPool` moveset (`scripts/evolve.mjs:3306`) -- usually equal, not
verified species-by-species, so a residual <=1pt contribution isn't ruled
out. Unsettled: a side-swap re-battle of the gen-44 populations, not run.

So "opponent fitness > candidate fitness" means the opponent side won more
battles as team B, not that the opponent population is winning an arms race.
Check your own run: `node scripts/fitness-sides.mjs out/evolve-<name>`.

Pass every one of these explicitly even where it matches a default, so the
checkpoint `config` shows the symmetry rather than relying on two modules'
defaults staying equal (they don't: candidate defaults are death 1/3, floor
0.05, ceil 0.4, immigrants 0.1; opponent defaults are death 0.15, floor 0.02,
ceil 0.2, immigrants 0.08). Older `meta-vs-meta-v1..v6` runs pre-date this
rule (300 candidates vs 120 opponents, candidate death 1/3 vs opponent 0.2,
ramp 0.4); don't resume them with this recipe -- the fingerprint won't match.
`meta-vs-meta-v1..v6` and `meta-vs-meta-willpower-1/2` also pre-date
`--random-opponent-lead` (added 2026-09-17) -- their opponent side used
lead-prior leads throughout, so their fitness numbers aren't directly
comparable to a run started with the flag on; don't resume them with it added
either, same fingerprint-mismatch reason.

This rule is specific to meta-vs-meta. The standard recipe above (real
collection vs. a co-evolving meta) is deliberately asymmetric -- the two sides
draw from different pools -- and none of these flags or values carry over to
it; `scripts/sim.sh` and its defaults are untouched by this recipe.

```bash
COLLECTION="jaxon-gl-collection.csv"
RUN_NAME="meta-vs-meta-vN"          # bump N each run

nohup node scripts/evolve.mjs "$COLLECTION" \
  --population 200 --opponents-per-gen 200 --population-final-ratio 1 \
  --generations 30 --elites 30 --threads 8 \
  --pool 70 --opponent-meta-pool 70 \
  --curated-ratio 0 \
  --death-rate 0.2 --opponent-death-rate 0.2 \
  --mutation-floor 0.05 --mutation-ceil 0.4 \
  --opponent-mutation-floor 0.05 --opponent-mutation-ceil 0.4 \
  --mutation-floor-start 0.15 --mutation-ceil-start 0.6 \
  --opponent-mutation-floor-start 0.15 --opponent-mutation-ceil-start 0.6 \
  --immigrant-fraction 0.08 --opponent-immigrant-fraction 0.08 \
  --random-opponent-lead \
  --seed "$RUN_NAME" --out-dir "out/evolve-$RUN_NAME" > "out/evolve-$RUN_NAME.log" 2>&1 &
echo $! > "out/evolve-$RUN_NAME.pid"
```

Expected gen-0 log line:
`generation 0: battling 200 teams against 200 opponents (0 curated, 200 evolved)`.

Same "check gen 0 timing before walking away" rule as the shared-s2 recipe
above applies -- the population schedule and both mutation anneals are indexed
to `--generations`, so a deadline stop mid-schedule leaves them unfinished.
`evolve-meta-vs-meta-v5-test` (2026-09-09/10) died mid-run (process killed,
no `evolve-DONE`, stopped at generation 19) -- if a run under this recipe
stops short, check `journalctl -u earlyoom` per section 1 before assuming it
just finished.

### `sim.sh` reference

Options (anything else is passed through to `evolve.mjs`):

| Flag | Meaning | Default |
| --- | --- | --- |
| `--name NAME` | run name → seed + `out/evolve-NAME/` | `<csv-stem>-<HHMM>` (avoid; always name runs) |
| `--ban a,b` | format-wide base-species ban, both sides (cup rules) | none |
| `--generations G` | generation cap | 100 |
| `--population N` | candidate population at gen 0 | 300 |
| `--hours H` | wall-clock budget → `--deadline-minutes` | none |
| `--threads N` | battle worker threads | cpus-1 capped at 8 (use 8 or 12) |
| `--profile` | per-worker CPU profile + scenario-memo + heap stats → `out/evolve-NAME/` | off |
| `--fg` | foreground instead of nohup | detached |
| `--dry-run` | print command, exit | off |

The launcher always adds `--config recipes/standard.json --seed NAME
--out-dir out/evolve-NAME`. `recipes/standard.json` holds the baked
defaults -- `opponents-per-gen 120`, `elites 15`, weights
`snowball/closer/consistency/shared-weakness 0.2/0.1/0.1/0.2` -- edit that
file, not `sim.sh`, to change them for every future run. A passthrough flag
of the same name overrides its `--config` value; a passthrough `--config
other.json` replaces `recipes/standard.json` wholesale (evolve.mjs only
honors one). `--pool` is left unset -- no cap, whole deduped collection --
unless `--meta` sets it to `--meta-pool`. A bare `node scripts/evolve.mjs`
uses much smaller defaults (pop 100, 20 opponents, 15 gens) and is not a
standard run.

### Common variants

```bash
scripts/sim.sh "$COLLECTION" --name "$RUN_NAME" --threads 8  --hours 7.75         # ~8 h budget incl. final pass
scripts/sim.sh "$COLLECTION" --name "$RUN_NAME" --threads 8  --cp 2500            # Ultra League
scripts/sim.sh "$COLLECTION" --name "$RUN_NAME" --threads 8  --ban a,b            # cup rule, both sides
scripts/sim.sh "$COLLECTION" --name "$RUN_NAME" --threads 8  --exclude carbink    # candidate side only
scripts/sim.sh "$COLLECTION" --name "$RUN_NAME" --threads 8  --no-evolutions      # own forms only
```

- `--ban` drops the species from candidates, from any curated opponent team
  containing it, and from the composed-opponent pool. `_shadow` counts as the
  same base species; regional/battle forms are distinct ids.
- `--exclude` is an exact candidate-side species id. It does not remove the
  shadow form or touch opponents.
- `--hours H` is checked only between generations; the final pass and
  reports still run after the deadline. On resume, elapsed time counts from the
  original start timestamp including downtime, so pass the new *total*.
- Do not pass `--out-dir` through the wrapper; `--name` owns it.
- Full lower-level flag list: `node scripts/evolve.mjs --help`.

### Cup run

```bash
scripts/sim.sh "$COLLECTION" --name "$RUN_NAME" --threads 8  --cup willpower
```

Restricts the whole run (candidates, opponents, movesets, usage weights, role
priors, meta group) to the named pvpoke cup -- `--cp` still applies alongside
it (a cup and its CP cap are looked up together; e.g. `--cup little --cp 500`
for Little Cup). Two things to expect, both correct, not bugs:

- **Curated opponents are usually empty.** The vendor "GO Battle League"
  preset file is a Great-League-meta pool; every preset with an
  ineligible member is dropped, which under most cups is all of them. Opponent
  quality then rests entirely on the composed/sampled half of the pool
  (`src/meta/sampleTeams.js`), drawn from the cup's own rankings -- consider
  raising `--opponent-meta-pool` toward the cup's full field size (it's
  usually well under the Great League 400 default; the run log prints the
  effective pool size).
- `--ban` still layers on top for house rules (e.g. a community-run extra
  ban) -- the cup's own bans (type/tag/id) come from pvpoke's cup definition
  and are never something `--ban` needs to restate.

### Timing expectations (marisa, 300×120 grid, `--threads 8`)

| Phase | Wall clock |
| --- | ---: |
| Generation 0 (no cache) | ~10.5 min |
| Late generations (~60% cache hits) | ~4 min |
| 100 generations + final pass | ~7.5 h |

Budget a full day slot for a run to be safe. Two concurrent battle runs each
take more than twice as long; run one at a time. The figures above predate the
engine's scenario memo; expect roughly 25-30% less.

### Why `--threads 8` (measured 2026-09-04, do not change without re-measuring)

The limit is the machine, not the executor: 8 independent single-worker
processes each run 2.1x slower than one alone (103 -> 217 ms/battle). 8 threads
gives ~3.8x; 12 and 15 are slower than 8. Profiling and the engine's scenario
memo are documented in `src/engine/README.md`, "The scenario memo".

### Profiling a run (`--profile`)

```bash
scripts/sim.sh "$COLLECTION" --name "$RUN_NAME" --threads 8 --profile
```

Requires `--threads > 0` (no-op serial). Each worker runs a `node:inspector`
CPU profile for its whole life; on a clean stop (generation/deadline cap
reached, not a kill) it writes `out/evolve-NAME/worker-<id>.cpuprofile`
(load into Chrome DevTools' Performance tab) plus
`out/evolve-NAME/profile-summary.json` with each worker's scenario-memo
hit/miss counts, build-cache sizes, and per-isolate heap (current +
5s-sampled peak) at exit — the log line also prints the aggregate hit rate
and worker heap totals. (Heap, not RSS: inside a worker_thread `rss` is the
whole process's number, which is why older logs show "worker RSS 68 GB" on a
12 GB box.) A hard kill/Ctrl-C skips the flush, same as `--cpu-prof` elsewhere in
this repo. Full mechanics: `src/engine/parallel.js`'s `profileDir` option
and `src/engine/parallelWorker.js`'s `shutdown()`.

Process RSS (main thread plus all workers) is logged every generation
regardless of `--profile` (in each `generation N: done -- ...` log line).
Memory ceilings: each worker's scenario memo is capped at 20k entries (~40
MB) and its two build caches at 5000 mons each (~70 MB), and each worker
isolate's old-generation heap is capped at 512 MB (`POGO_GBL_WORKER_HEAP_MB`
to override) so V8 collects instead of ballooning -- a `--threads 8` run
should hold roughly 2-3 GB of RSS. If a run still gets killed for memory,
check what else is on the box first (earlyoom logs the culprit's cmdline in
`journalctl -u earlyoom`).

## 4. Monitor, stop, resume, queue

```bash
scripts/sim.sh status                      # every run: RUNNING/DONE/STOPPED + last checkpoint gen + last log line
tail -f out/evolve-RUN_NAME.log
grep -E '^generation [0-9]+: done' out/evolve-RUN_NAME.log | tail -3
```

After launching, past sessions verified health the same way each time: wait for
`generation 0: battling`, then check the process once a minute for a few
minutes, then wait for `generation 0: done` to get real timing.

```bash
until grep -q "generation 0: battling" out/evolve-RUN_NAME.log; do sleep 10; done
ps -p "$(cat out/evolve-RUN_NAME.pid)" -o pid,etime,rss --no-headers; free -m | sed -n 2p
until grep -q "generation 0: done" out/evolve-RUN_NAME.log || ! kill -0 "$(cat out/evolve-RUN_NAME.pid)" 2>/dev/null; do sleep 30; done
grep "generation 0: done" out/evolve-RUN_NAME.log || { echo "died before gen 0"; tail -5 out/evolve-RUN_NAME.log; }
```

Run long waits as background Bash tasks, not foreground sleeps. If the user
asks "is anything running", answer from `scripts/sim.sh status` or
`pgrep -af evolve.mjs`.

Log lines to recognise:

```text
evolve: starting (collection=..., out-dir=..., report=...)
generation 0: battling 300 teams against 120 opponents (79 curated, 41 evolved)
generation 0: done -- mean fitness 41.4%, opponent mean fitness 46.2%, 36000 battles simulated + 0 served from cache (0 errors), 10m 32s elapsed
evolve: resuming -- 37 generation(s) already complete (config matches)
Top team: Tinkaton (Lead) / Furret / Carbink -- score 55% (57% elites-pass win rate, 51% over the last 5 generation(s)).
Done marker written to out/evolve-RUN_NAME/evolve-DONE
```

Stop (keeps every completed-generation checkpoint; the in-progress generation is lost):

```bash
kill "$(cat out/evolve-RUN_NAME.pid)"
```

Resume: rerun the *identical* launch command (same csv, name, bans, cp,
population, generations, and any GA flags). Threads, `--hours`, and
`--no-battle-cache` may change freely. Anything else mismatching the stored
config makes the driver reject the checkpoints. A detached restart overwrites
the old `.log`, so copy it first if it matters.

```bash
cp out/evolve-RUN_NAME.log out/evolve-RUN_NAME.log.1
scripts/sim.sh "$COLLECTION" --name "$RUN_NAME" --threads 8 --mutation-floor-start 0.15 --mutation-ceil-start 0.6
```

Never reuse a run name for a different collection or configuration.

Queue a run to start when another finishes (pattern from `out/queue-marisa-8h.sh`):

```bash
cat > out/queue-NEXT.sh <<'EOF'
#!/bin/bash
cd /home/jaxon/files/pogo-gbl-team-generator || exit 1
prev=$(cat out/evolve-PREV.pid)
while kill -0 "$prev" 2>/dev/null; do sleep 60; done
sleep 15
scripts/sim.sh "COLLECTION.csv" --name NEXT --threads 8 --mutation-floor-start 0.15 --mutation-ceil-start 0.6 >> out/evolve-queue.log 2>&1
EOF
nohup bash out/queue-NEXT.sh >/dev/null 2>&1 &
```


## 5. Read the results

Inside `out/evolve-RUN_NAME/`:

| File | Contents |
| --- | --- |
| `evolve-DONE` | present ⇒ final pass + reports finished without an uncaught error (stop reason may be convergence, cap, or deadline) |
| `my-teams-evolve.md` | final report; top 12 teams, weighted final-pass win%, score, build costs |
| `my-teams-evolve.html` | same, with the animated generation race chart embedded |
| `evolve-ranking.json` | machine-readable final ranking (array, rank 1 first) |
| `evolve-generations.json` | compact per-generation analytics |
| `evolve-genN.json` | full checkpoint per generation (config, populations, fitness, lineage, timing) |

Quick answers:

```bash
grep -m1 '^Top team' out/evolve-RUN_NAME.log
node -e 'for (const t of JSON.parse(require("fs").readFileSync("out/evolve-RUN_NAME/evolve-ranking.json")).slice(0,5))
  console.log(t.rank, t.name, (t.combinedScore*100).toFixed(1)+"%")'
```

`evolve-ranking.json` entries: `{rank, name, signature, combinedScore, winRate,
recentWinRate, selectionFitness, winRateByStratum: {curated|archive|fresh: {winRate, battles}}}`.
`combinedScore = 0.7 × winRate (weighted final pass) + 0.3 × recentWinRate`;
`selectionFitness` is the trailing-mean fitness that made the team a finalist,
`winRateByStratum` the unweighted pass result per opponent stratum (runs
re-rendered before 2026-09-05 lack both).
Team names read `Lead (Lead) / back1 / back2`; `members[0]` is the lead everywhere.

### Mid-run review (before `evolve-DONE` exists)

For a status check on a run still in progress -- top teams, top species,
speed, memory -- there's no ranking/report yet, so read the latest
`evolve-genN.json` checkpoint directly:

```bash
scripts/sim.sh status                       # confirms it's running + latest checkpoint gen
tail -50 out/evolve-RUN_NAME.log            # per-generation timing/RSS/battle counts
```

```bash
node -e '
const fs = require("fs");
const dir = "out/evolve-RUN_NAME";
const latest = fs.readdirSync(dir).filter(f => /^evolve-gen\d+\.json$/.test(f))
  .sort((a,b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]).pop();
const d = JSON.parse(fs.readFileSync(`${dir}/${latest}`));
const {population: pop, fitness: fit} = d;
const order = pop.map((_,i)=>i).sort((a,b)=>fit[b]-fit[a]);
const seen = new Set(); let shown = 0;
console.log(`--- top teams (${latest}) ---`);
for (const i of order) {
  const key = pop[i].map(s=>s.split("#")[0]).sort().join(",");
  if (seen.has(key)) continue;
  seen.add(key);
  console.log((fit[i]*100).toFixed(1)+"%", pop[i].join(" / "));
  if (++shown >= 12) break;
}
const counts = {};
for (const t of pop) for (const s of t) { const b = s.split("#")[0]; counts[b] = (counts[b]||0)+1; }
console.log(`--- top species by frequency across ${pop.length} teams ---`);
for (const [s,c] of Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,15)) console.log(c, s);
'
```

Population entries are `species#lineageIndex` strings, not objects -- split on
`#` for the base species name. This is early-generation data and will churn
as the run progresses; treat it as a snapshot, not a forecast of the final
ranking. Speed/memory per generation (battle count, cache hits, elapsed,
RSS) come straight from the log lines, not the checkpoint.

Standalone chart file, if the HTML report is not enough:

```bash
node scripts/chart-top-teams.mjs out/evolve-RUN_NAME [--top N] [--out PATH]
```

Reports flag members marked **not buildable** when evolving keeps a level that
lands over the CP cap (e.g. a L24 Mareep becomes a CP 1743 Ampharos). Runs
from `marisa-2-1` onward filter these during the run; older reports may still
contain them. The user has asked before to keep only fully buildable teams.

Rankings are relative. Absolute win% carries a small fixed-side offset because
candidates always fight as team A; compare teams to each other, not to 50%.

### Re-render reports without re-simulating

Rerunning the exact original command on a finished run resumes past the last
checkpoint, redoes only the deterministic final pass, and rewrites the reports.
Use this after changing report code in `scripts/evolve.mjs`. Since 2026-09-05
the final pass battles held-out opponents (archive + fresh) that the
generations never fought, so a re-render costs real battles (30 finalists x
~800 opponents ≈ 24k, ~6 min at 8 threads) and rankings only come out identical
when the final-pass code and `--elites/--final-archive/--final-fresh` are
unchanged. Those three flags are outside the checkpoint fingerprint, so a
finished run CAN be re-rendered with `--elites 30`; `--selection-trailing` is
inside it (only when set), so never add it on a re-render. For a bare
`evolve.mjs` run, repeat its original command with `--fg`-style foreground
redirection instead of `sim.sh`.

```bash
cp out/evolve-RUN_NAME/evolve-ranking.json out/evolve-RUN_NAME/evolve-ranking.json.bak
scripts/sim.sh "$COLLECTION" --name "$RUN_NAME" --threads 8 <same flags> --fg > out/evolve-RUN_NAME-rerender.log 2>&1
diff <(jq . out/evolve-RUN_NAME/evolve-ranking.json) <(jq . out/evolve-RUN_NAME/evolve-ranking.json.bak) && echo identical
grep "final pass --" out/evolve-RUN_NAME-rerender.log   # shows the curated/archive/fresh split it fought
```

### Excluding a species after a run finished

Changing `--exclude`/`--ban` invalidates checkpoints, so that is a fresh run
(a 40-gen `--exclude carbink` rerun was started and abandoned for this reason).
The cheap route, done for `marisa-8h-1`: the final pass already scored all 12
finalists, so drop finalists containing the species from the copied report
(`my-teams-evolve-nocarbink.{md,html}`), promote the rest, and add a note naming
the removed winner and why. That is a report edit, not a simulation; say so in
the report.

### Sharing a report as an artifact

The user shares results as Claude artifacts. The HTML report is self-contained;
extract the body between `<body>` and `</body>` plus the `<style>` block, add a
`<title>`, and publish. Past titles: "Great League Podium", "Marisa's Great
League Podium". Republish to the same artifact URL when updating.

## 6. Other tasks

### Quick sampled run (no GA)

```bash
node src/cli.js "$COLLECTION" --threads 12 [--cp 2500] [--top 10] [--exclude a,b] [--current-moves] [--no-evolutions]
# → out/report.md, out/report.html   (change with --out / --html)
```

Defaults: 15 candidate teams × 7 opponents, pool 30, seed
`pogo-gbl-team-generator`. `--exhaustive --topK K --meta M` swaps in all C(K,3)
candidates against a fixed curated list. Good for smoke tests and Ultra League
collections too small for a GA.

### Shared collection for two players

```bash
node scripts/build-shared-collection.mjs jaxon-gl-collection.csv jet-gl-collection.csv \
  --out shared-gbl-collection.csv [--cp 1500]
```

Keeps, per base species both can field, the weaker player's copy, so every
output mon is buildable by both. Then run `sim.sh` on the output. Note the
script's positional defaults reference old filenames; always pass both paths.

### Multi-stage offline tournament (alternative to the GA, rarely used)

```bash
node scripts/tournament.mjs "$COLLECTION" --threads 12 --deadline-minutes 450 --out-dir out/tournament-NAME
```

Three-stage funnel (500×50×3, 100×200×3, 10×500×9 battles at defaults);
stages 2-3 self-tune to the deadline. Report: `<out-dir>/my-teams-tournament.md`.

### Refresh usage weights (deliberate, human-triggered only)

```bash
node scripts/refresh-usage.mjs        # writes data/meta-usage.json from live pvpoke GL rankings
```

Currently no `data/meta-usage.json` or `data/meta-roles.json` exists, so usage
and role priors come from the pinned pvpoke rankings. Community-curated teams in
`data/meta-teams-community.json` are a separate local source; changing the pin
does not update them.

### Tests (only when code changed)

```bash
node --test test/<file>.test.js   # one module
npm run test:changed              # a few files in one area
npm test                          # fast tier, ~1 s
TS_FULL=1 npm run test:full       # ~13 s; required before a push
```

A hook blocks whole-suite runs and prints the narrower command; follow it.

## 7. What the standard recipe actually does

Resolved settings for `scripts/sim.sh <csv> --name NAME --threads 12`:

| Setting | Value |
| --- | --- |
| League | Great League, CP 1500 |
| Generations | 100 (0-99), or earlier on convergence/deadline |
| Candidate population | 300 at gen 0, shrinking linearly to 120 at gen 99 |
| Opponents per generation | 120 at gen 0, growing to 300 at gen 99 (`round(36000 / population)`) |
| Battles per generation | ≈36,000 (one per candidate/opponent pair, both at designated leads) |
| Candidate species pool | top 70 of the collection by 1v1 score (meta size 20) |
| Candidate draw weight | 50% normalized 1v1 score + 50% normalized pvpoke usage, usage = rank-position Zipf weight `1/(rank+5)^1.0` (as of 2026-09-08; replaced a raw-score power law that went nearly flat over a wide field) |
| Curated opponent target | 66% of the pool, capped by the curated teams available; curated teams are never culled or mutated |
| Composed opponents | built from pvpoke's overall top 100 species |
| Opponent archetype grouping | opponents are grouped by their dominant two-species core (the pair of base species most common across the pool; no transitive chaining, since 2026-09-09) (`--archetype-beta`, default 0.5); a group of size s counts for `s^(1-beta)` total votes, both as candidate-side opponent weight and as the divisor of each candidate's consistency score (since 2026-09-08, see `docs/plans/2026-09-08-fitness-restructure.md`) |
| Opponent-strength weighting | each opponent's vote in a candidate's win rate (and inside its archetype for consistency) is scaled by (that opponent's own win rate against the population)^`--opponent-strength-gamma` (default 1; 0 = off), computed from the same generation's battles in a second pass -- beating a weak singleton earns little, beating a strong team earns most (since 2026-09-09) |
| Core rivalry | `--core-rivalry R` (default 0.1; 0 = off): in both the candidate population and the opponent pool, every better team sharing any two base species costs a team R x (the field's max-min fitness) before the cull and mutation ranking, so trailing near-duplicates of a core are culled first while a second variant that fights well on its own survives; raw fitness in checkpoints is untouched (since 2026-09-09). The same function scores shadow twins: a shadow and its base have member similarity 0.9 (the top of the scale short of identity), and a team that is a better team's shadow variant (candidate side: same lead, same backs; opponent side: same species slot for slot) pays a whole-team twin load of 2 x 0.9 on top of its core load -- 2.8 steps against a plain same-core variant's 1, so the weaker twin is pushed toward the cull but a twin that out-fights the field's tail survives. Only an exact duplicate (whole-team similarity 1, possible only from opponent-side draws) dies outright, whatever R is; it is counted in the plain death tolls, not tracked separately. Candidate shadow-flip mutations are 20% of mutation successes (since 2026-09-10; was 15%) and flip a uniformly random non-empty combination of the team's flippable members, so a two- or three-shadow variant is one mutation away, not a walk through intermediates that may each die |
| Similar-core rivalry | `--similar-rivalry S` (default 1) / `--similar-floor F` (default 0.35; 0 similar-rivalry = exact cores only): a better team whose core is a *similar*, not identical, pair adds a fraction of an identical-core rival to the core-rivalry load, scored by pvpoke's own "Similar Pokemon" metric (`src/engine/similarity.js`, `calculateSimilarity` -- shared types, moves, and traits, normalised 0..1). Matches at or below the floor count as unrelated (0); above it the score scales linearly up to `similar` at 1.0 (Feraligatr/Empoleon ~0.55 loads ~0.3, Charizard/Blaziken ~0.62 loads ~0.4, Annihilape/Mimikyu ~0.33 loads nothing at the default floor). Each better team counts once, through its best-matching core, and a team is charged only for its single most crowded core, so carrying two or three popular cores does not stack the penalty (since 2026-09-09; pvpoke metric adopted 2026-09-09) |
| Opponent fitness | frequency-normalised by default (`--no-opponent-fitness-normalised` to disable): each candidate's contribution to an opponent's win-rate ledger is weighted down by its most-common member's population share (clamped [0.2, 5]), so a crowded counter-bred core no longer collects N× the credit for beating it |
| Fitness | `battle-reality` = 0.45 win rate + 0.20 consistency (25th-percentile per-archetype win rate) + 0.25 decided lead-exchange win rate + 0.10 mean closer prior of the back line |
| Selection statistic | each team's recency-weighted mean fitness over its last 5 generations (`--selection-trailing`, its own window separate from convergence's); the cull, the mutation ranking and the finalist pick all use it, never a single generation's draw (since 2026-09-05; the s2 run showed one draw moves 3.9 points while real teams sit 2.2 apart) |
| Candidate cull | `round(1/3 × next size)` replaced per generation, plus shrink |
| Mutation chance | 5% (worst survivor) to 40% (best), linear by fitness percentile; 30% lead rotation / 70% one-member swap |
| Immigrants | `round(10% × next size)` fresh teams |
| Opponent-side GA | cull 15% of non-curated, mutation 2-20%, immigrants ≤8%, curated parents mutate at a flat 3% into new teams; opponent fitness = 1 − candidate win points, no extra battles |
| Convergence | smoothed (10-gen) top-10 unchanged for 6 straight transitions and elite lift improving ≤0.005 vs the prior 10-gen baseline; cannot fire before gen 16. Tunable only via `--conv-window`, `--conv-top-n` |
| Final pass | top 12 last-generation candidates by the selection statistic vs every curated team + a held-out archive (the 400 strongest evolved opponents of the whole run, excluding any fielded in the last 10 generations) + 400 fresh meta-composed teams never fought during the run. Curated weights meta/untagged 1, recommended 0.5, off-meta 0.25; archive+fresh together carry the run's `(1-curated-ratio)/curated-ratio` share of the curated weight (with `--curated-ratio 0`, every opponent weighs 1). Out-of-sample by construction: before 2026-09-05 the pass re-fought the last generation's own pool, which with `--curated-ratio 0` meant 0 new battles and a winner's-curse ranking |
| Final rank | `0.70 × weighted final-pass win% + 0.30 × mean raw win% over the last 5 generations` (`ceil(gens/4)` if fewer than 20 ran); the report also shows each finalist's unweighted win% per stratum |
| Evolutions of owned mons | on |
| AI difficulty | 3 (engine default) |
| Battle cache | on, in memory, ≤2,000,000 entries; does not survive restart |
| Determinism | same seed ⇒ identical results, serial or threaded |

`--fixed-opponents` freezes the opponent pool (no culling, mutation,
immigration, or growth). Opponent-side rates have no CLI flags.

## 8. Source of truth

Consult only when this file disagrees with observed behaviour, then fix this file.

| Concern | Source |
| --- | --- |
| Launcher recipe, pid/log conventions, `status` | `scripts/sim.sh` |
| Driver defaults, schedule, fitness, checkpoints, final ranking, CLI | `scripts/evolve.mjs` |
| Candidate GA constants and convergence | `src/teams/evolve.js` |
| Candidate draw blend | `src/teams/sample.js` |
| Opponent GA constants | `src/meta/opponentPool.js` |
| Composed-opponent top-100 | `src/meta/sampleTeams.js` |
| Usage exponent and snapshot fallback | `src/meta/usage.js` |
| Role priors | `src/meta/roles.js` |
| Curated teams and tier weights | `src/meta/teams.js`, `data/meta-teams-community.json` |
| pvpoke pin and sparse paths | `scripts/setup.sh` |
| Thread default | `src/engine/parallel.js` |
| Feature docs (flags, cost math, GA) | GitHub wiki: `curl -s "https://raw.githubusercontent.com/wiki/Gidntsquia/pogo-gbl-team-generator/<Page>.md"` — pages Running-the-CLI, How-Scoring-Works, Build-Costs-and-Evolutions, Evolutionary-Team-Search, Shared-Collections, Development-and-Tests |
