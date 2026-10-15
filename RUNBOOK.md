# Simulation Runbook

Operational reference for running this app. Written so an AI assistant can
complete every routine task from this file alone, without reading source.
Run every command from `/home/jaxon/files/pogo-gbl-team-generator` in WSL.

What the app does: take a Pokemon GO collection CSV, find the best 3-mon GO
Battle League teams buildable from it, ranked by real 3v3 battles run through
pvpoke's vendored engine. The one front door is the evolutionary search:

| Want | Run | Time |
| --- | --- | --- |
| Quick smoke test | `node scripts/evolve.mjs <csv> --generations 2 --population 12 --opponents-per-gen 8 --threads 2` | ~1 min |
| Real answer, evolutionary search (the normal case) | `scripts/sim.sh <csv> --name NAME --threads 8` | ~8 h |

Everything else in this file supports these rows. There is no 1v1 scoring: candidate
sampling is by pvpoke rank alone (1/(rank+20) per species+shadow build; a build pvpoke
does not rank is last place).

## 1. Preflight (every session, every scheduled run)

```bash
cd /home/jaxon/files/pogo-gbl-team-generator
test "$(git branch --show-current)" = "main"
bash scripts/setup.sh          # materializes/repairs vendor/pvpoke (gitignored) at the pin
test "$(git -C vendor/pvpoke rev-parse HEAD)" = "e87448291024aff808f21a2e5f74e69f68b521df"
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
"Why `--threads 8`" in section 3). A resume keeps the run's own thread
count (`threadsUsed` in the latest checkpoint); `resume_sim` does this unless
given `threads`.

Memory over a long run: each worker caches every built Pokemon it has seen
(`src/engine/parallelWorker.js`) in an LRU capped at 5000 entries/side/worker (~70 MB/side).
`POGO_GBL_WORKER_CACHE=N` raises or lowers the cap. The per-worker scenario memo
(`src/engine/teamBattle.js`) holds 20k entries and each worker's heap is capped at 512 MB; see
`--profile` below for expected numbers.

The safety net for a run that outgrows the box is this machine's `earlyoom`
(configured `-m 10 -s 20 --prefer node`, so it targets node first once
available memory is under 10% AND swap free under 20%). It SIGTERMs the run,
leaving checkpoints intact; nothing lands in the run's own log, so a run that
stopped without `evolve-DONE` should be checked against
`journalctl -u earlyoom`, which records the killed cmdline (handy for the
resume).

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

### The standard recipe

`scripts/sim.sh` bakes in `--config recipes/standard.json`: population 300 ramping to 120
(`--population-final-ratio 0.4`), 120 opponents per generation fought in full, Sequential Halving
R=3, 15 elites, 100 generations, curated-ratio 0.66, opponent-meta-pool 400, archetype-beta 0.5,
opponent-strength-gamma 1, core-rivalry 0.2, similar-rivalry 1 / similar-floor 0.35, mutation
hot-start 0.15-0.6, and candidate fitness weights snowball 0.4 / closer 0.1 / consistency 0.2 /
shared-weakness 0.2. `--meta` runs use the same file. The full run is:

```bash
COLLECTION="jaxon-gl-collection.csv"
RUN_NAME="jaxon-standard-2"        # unique, shell-safe; doubles as the PRNG seed

bash scripts/setup.sh
scripts/sim.sh "$COLLECTION" --name "$RUN_NAME" --threads 8 --dry-run   # inspect, then rerun without --dry-run
```

| Setting | Meaning |
| --- | --- |
| `--threads 8` | the measured-fastest count here (12 and 15 are slower); ~2 GB RSS (see "Why `--threads 8`" below) |
| `--pool` unset | no cap: candidates are drawn from the whole deduped collection |
| `--curated-ratio 0.66`, `--opponent-meta-pool 400`, `--archetype-beta 0.5` | the opponent side co-evolves (no `--fixed-opponents`) |
| `--opponent-strength-gamma 1` | each opponent's vote is weighted by its own strength |
| `--snowball-weight 0.4` | candidate-only weight on `snowballScore` (own fraction of decided lead exchanges won), on top of `winRate: 1`; opponent-side fitness (`src/meta/opponentPool.js`) is a plain win-rate calc |
| `--closer-weight 0.1`, `--consistency-weight 0.2` | candidate-only weights on `closerScore` and `consistencyScore` |
| `--core-rivalry 0.2`, `--similar-rivalry 1`, `--similar-floor 0.35` | each better team sharing a two-species core (or a pvpoke-similar core above the floor, weighted by `similar-rivalry`) costs a team fitness |
| `--shared-weakness-weight 0.2` | candidate-only weight on `sharedWeaknessScore` (`src/teams/typeCoverage.js`): a lead weakness type that a back member also carries, scaled by severity, type prevalence in pvpoke's top 200, lead moveset coverage and the other back's resistance; normalized to the worst possible typing. No extra battles; in the resume fingerprint; affects evolution and finalist selection only, not the report ranking |

The dry run prints collection, seed, out dir, bans, budget, and the full
`evolve.mjs` command. Confirm bans, anneal flags, and threads appear, then
launch. The launcher refuses to start if `out/evolve-RUN_NAME.pid` points at a
live process.
Add `--exclude carbink` only when asked (the user has excluded Carbink from
candidates before because it is too expensive to build; opponents keep it).
Add `--hours H` when the user gives a time budget; the 8 h marisa run used
`--hours 7.75` (465 min) to leave room for the final pass.

### GPU battles (`--gpu`, opt-in, plain `evolve.mjs` only)

`node scripts/evolve.mjs ... --gpu` sends each step's uncached 3v3 battles to the CUDA sidecar (`gpu/`, needs `uv`
and an NVIDIA GPU) while the CPU workers run a deterministic share of the same batch; the memo stays in front and
both sides write the same cache keys. The share defaults to `auto`: per step, a CPU count sized to finish inside the
shortest measured GPU step under the rates in `GPU_RATE_MODEL` (`src/engine/gpuExecutor.js`, refit with
`node gpu/fit-share.mjs`; ~95 battles a step), a pure function of the step size. `--gpu-cpu-share F` pins a fixed fraction instead. Rows the kernel flags invalid are re-run on the CPU
as soon as their launch returns. Each step logs `gpu step -- N memo hits, N battles on GPU in Xs, N on CPU in Xs
[(F GPU rows flagged invalid, re-run on CPU)], share auto (N CPU), wall Xs`, and `<out-dir>/gpu-profile.json` holds
per-step / per-generation time buckets (`node gpu/gpu-profile.mjs` renders `out/gpu-profile.html`). Results are
float32: ~99.8% winner agreement with the CPU engine. With no device, a dead sidecar or a start failure the run exits
1 with one `gpu: <reason>` line, the last full generation's checkpoint stays valid, and the identical command resumes;
`--gpu` is part of the run config, so resuming without it is refused. The MCP tools do not know `--gpu`.
Experimental, off by default: `POGO_GPU_KERNEL=warp|queue`, `POGO_GPU_WARP_BELOW=N` (warp kernel for launches up to N battles; measured ×1.28 at 5k, below bar). Report builders: `node gpu/gpu-ab.mjs agree|score [--v 2]|report`, `node gpu/gpu-gap.mjs`. Details: `docs/gpu-viability.md`.
`POGO_COMMUNITY_FILE=<path>` points the curated-team loader at another file. The recipe-ab A/B needs
`POGO_COMMUNITY_FILE=data/archive/meta-teams-community-mega-great.json`: the live file is base Great League, which
a mega cup filters to 0 curated teams. Check the startup line says `(N curated)` with N > 0.
```bash
POGO_COMMUNITY_FILE=data/archive/meta-teams-community-mega-great.json nohup $(cat out/recipe-ab-cpu-baseline.cmd) \
  --gpu --out-dir out/evolve-recipe-ab-gpu2-halving > out/evolve-recipe-ab-gpu2-halving.log 2>&1 &
```

### Bare `evolve.mjs` recipes (no curated opponents)

`sim.sh` fixes the opponent and elite settings, so a run with no curated teams uses bare
`evolve.mjs`. `--curated-ratio 0` removes curated teams from every generation and from the final
pass, and the opponent side then evolves as hard as the candidate side. Keep the opponent cull
near 0.2, size `--generations` to the deadline (a deadline stop mid-schedule leaves both anneals
and the population ramp unfinished) and send about 30 finalists to the final pass.
Check generation 0 timing before walking away; generations are in the checkpoint fingerprint, so
a fix means a fresh start.

```bash
node scripts/evolve.mjs "$COLLECTION" \
  --population 400 --opponents-per-gen 100 --generations 75 --deadline-minutes 450 \
  --pool 70 --elites 30 --threads 8 --curated-ratio 0 \
  --mutation-floor-start 0.15 --mutation-ceil-start 0.6 \
  --opponent-death-rate 0.2 \
  --opponent-mutation-floor 0.05 --opponent-mutation-ceil 0.4 \
  --opponent-mutation-floor-start 0.15 --opponent-mutation-ceil-start 0.6 \
  --seed "$RUN_NAME" --out-dir "out/evolve-$RUN_NAME" > "out/evolve-$RUN_NAME.log" 2>&1 &
echo $! > "out/evolve-$RUN_NAME.pid"
```

Scale rule: keep `population x opponents` proportional to the hours (36k pairings is about 8 h at
100 generations). Expected log line:
`generation 0: battling 400 teams against 100 opponents (0 curated, 100 evolved)`.

| Flag | Meaning | Default |
| --- | --- | --- |
| `--curated-ratio 0` | no curated/community opponents anywhere, final pass included | 0.66 |
| `--opponent-death-rate R` | evolvable-opponent cull per generation | 0.15 |
| `--opponent-mutation-floor/ceil R` | opponent mutation odds, worst to best survivor | 0.02 / 0.2 |
| `--opponent-mutation-floor-start/ceil-start R` | hot-start values at gen 0, annealed linearly to floor/ceil by the last generation | no anneal |
| `--opponent-immigrant-fraction R` | fresh-immigrant share of the evolvable opponent pool each generation; in the fingerprint only when set | 0.08 |
| `--selection-trailing N` | generations a team's fitness is recency-weighted-averaged over before the cull/mutation ranking and the finalist pick (1 = single draw); in the fingerprint only when set | 5 |
| `--elites N` | last-generation teams sent to the final pass; NOT in the fingerprint, so a finished run can be re-rendered with more | 15 |
| `--final-archive N` | final pass: strongest evolved opponents from the whole run, minus any fielded in the last `selection-trailing` generations; not in the fingerprint | 400 |
| `--final-fresh N` | final pass: fresh meta-composed opponents never fought during the run; not in the fingerprint | 0 (20 at `--curated-ratio 0`) |
### Meta vs. meta (both sides co-evolving)

No curated/community opponents anywhere (all Pokemon vs. all Pokemon), both
sides evolving from the same pvpoke-ranked field:

```bash
scripts/sim.sh --meta --name meta-vs-meta-<cup>-N [--cup <cup>] --threads 8 --dry-run
# inspect, then rerun without --dry-run
```

`--meta` supplies everything else (`sim.sh --help` has the full list):

| What | Value |
| --- | --- |
| Collection | built once per run from pvpoke's rankings (`scripts/build-meta-collection.mjs` -> `out/evolve-NAME/meta-collection-[CUP-]CP.csv`), reused on resume; IVs = pvpoke defaults |
| Pools | `--pool 400 --opponent-meta-pool 400` (`--meta-pool N`; 0 = full field) |
| Mode | `--no-evolutions --meta-mode --random-opponent-lead` |
| Size | `recipes/standard.json`: population 300 ramping to 120, 120 opponents per generation fought in full, 15 elites, 100 generations |
| Fitness weights | snowball 0.4, closer 0.1, consistency 0.2, shared-weakness 0.2, on BOTH sides (`--opponent-*-weight`) |
| Search | Sequential Halving R=3 (default), core-rivalry 0.2 |

`--random-opponent-lead` stays on: without it every composed opponent gets pvpoke's own
lead-prior winner rotated into slot 0 (`composeSampledOpponent` -> `pickLeadIndex`), while the
candidate side assigns a uniform-random lead and converges on a good one only through selection
(`assignLead` / `buildLeadRotation` in `src/teams/evolve.js`), which would hand the opponent side a
lead-quality head start. It has no off-switch flag; a run whose config lacks it cannot be resumed
through `sim.sh --meta`.
#### Meta-vs-meta symmetry rules

Both sides run one shared generation step (`src/ga/core.js` `evolveStep`), and every pairing is
battled from both seats (`mirrorBattleResult`), so battles per generation are exactly
`2 x population x opponents-per-gen`. `sim.sh --meta` passes `--meta-mode`, which gives candidates
the opponent side's species pool (pvpoke's top `--pool` ranked builds), usage-only sampling
weights, per-build shadow/plain sampling and rankings movesets, with evolution expansion off. It
also passes the same fitness weights (snowball 0.4 / closer 0.1 / consistency 0.2 /
shared-weakness 0.2) to the candidate flags and the `--opponent-*-weight` flags. `--meta-mode` is
part of the run config. Candidate and opponent fitness should sit within 0.02 of each other; check
a run with:

```
node scripts/fitness-sides.mjs out/evolve-<name>        # per-generation means, both sides
node scripts/symmetry-gap.mjs report --label <label>    # exit 0 = within 0.02; reads out/evolve-symgap-<label>-*
```

This rule is specific to meta-vs-meta. The standard recipe (real collection vs. a co-evolving
meta) is deliberately asymmetric: the two sides draw from different pools.

Expected gen-0 log line: `generation 0: battling 300 teams against 120 opponents (0 curated, 120 evolved)`.
Check gen 0 timing before walking away: the population schedule and both mutation anneals are
indexed to `--generations`, so a deadline stop mid-schedule leaves them unfinished. If a run stops
short with no `evolve-DONE`, check `journalctl -u earlyoom` per section 1.
### New meta: curated teams from a meta-vs-meta run

Repeat this when a new cup or season starts and `data/meta-teams-community.json`
has nothing (or stale teams) for it. The meta-vs-meta run is the source of the
curated opponents for real-collection runs.

1. **Meta-vs-meta run.** `scripts/sim.sh --meta --name meta-vs-meta-<cup>-N --cup <cup> ...`
   (flags as in the meta-vs-meta recipe above; `--meta` supplies `--meta-mode`,
   the symmetric weights and the pool). Wait for `evolve-DONE`. Example:
   `meta-vs-meta-retro-3` (50 generations, population 100 vs 100).
2. **Archive the old file.** The loader reads only `data/meta-teams-community.json`,
   so the old pool must move out of the way:
   `git mv data/meta-teams-community.json data/archive/meta-teams-community-<label>.json`.
3. **Generate the new file** from the last checkpoint:
   `node scripts/build-curated-from-meta.mjs out/evolve-<meta-run> --cup <cup> [--candidates 50] [--opponents 50]`.
   It takes the top N candidate teams by `selectionFitness` and the top M
   opponent teams by `opponentSelectionFitness` (deduped by lead + species),
   writes species only (`members[0]` = lead, shadow as `<id>_shadow`), and
   stamps `"cup"` in the file. Vendor GL presets are not merged in by default
   (`loadMetaTeams` takes `includeVendor: true` to opt in), so the pool is exactly
   the file. Opponent-side movesets are not carried over; the loader builds pvpoke's recommended moveset. It refuses to overwrite an
   existing file. Candidate teams are included on purpose: the run's own
   winners are what the new meta looks like.
4. **Check the load.** Start the real run and read the `shared setup done` log
   line: `N curated opponent teams` should equal the file's team count. A cup mismatch loads zero.
5. **Launch a standard run** with `--cup <cup>` (section 3 recipe). Curated
   teams enter at `--curated-ratio 0.66`. Set `--opponent-meta-pool` to about
   the cup's field size (retro: 200, as the meta-vs-meta run used).


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
--out-dir out/evolve-NAME` (the same file under `--meta`).
`recipes/standard.json` holds the baked defaults: `opponents-per-gen 120`, `population-final-ratio 0.4`,
`halving-rounds 3`, `elites 15`, `curated-ratio 0.66`, `opponent-meta-pool 400`,
`archetype-beta 0.5`, `opponent-strength-gamma 1`, `similar-rivalry 1`,
`similar-floor 0.35`, `mutation-floor-start 0.15`, `mutation-ceil-start 0.6`,
weights `snowball/closer/consistency/shared-weakness 0.4/0.1/0.2/0.2`,
`core-rivalry 0.2`; default `--population` is 300. Edit that file, not
`sim.sh`, to change them for every future run. A passthrough flag of the same
name overrides its `--config` value; a passthrough `--config other.json`
replaces the recipe file wholesale (evolve.mjs only honors one). `--pool` is left unset -- no cap, whole deduped collection --
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

- **Curated opponents are usually empty** unless a curated file for the cup
  exists. Vendor presets are off by default (`includeVendor`); when opted in,
  the vendor "GO Battle League" file is a Great-League-meta pool and every
  preset with an ineligible member is dropped, which under most cups is all of them. Opponent
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

### Why `--threads 8` (measured; do not change without re-measuring)

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

Resume checklist:

- Read `config` from the latest `out/evolve-<name>/evolve-gen*.json` first, and
  look for flags the recipe omits (e.g. `meta-vs-meta-newseason` uses
  `--curated-ratio 0`).
- Extra flags with a value go after `--`
  (`scripts/sim.sh --meta --name X -- --curated-ratio 0`); a bare
  `--curated-ratio 0` makes sim.sh treat the `0` as a collection path.
- Watch the log for `resuming -- N generation(s) already complete` before
  walking away. `starting fresh` means the config didn't match and the
  checkpoints are being overwritten -- kill it.

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
`winRateByStratum` the unweighted pass result per opponent stratum.
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
Use this after changing report code in `scripts/evolve.mjs`. The final pass battles held-out opponents (archive + fresh) that the
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

### Shared collection for two players

```bash
node scripts/build-shared-collection.mjs jaxon-gl-collection.csv jet-gl-collection.csv \
  --out shared-gbl-collection.csv [--cp 1500]
```

Keeps, per base species both can field, the weaker player's copy, so every
output mon is buildable by both. Then run `sim.sh` on the output. Note the
script's positional defaults reference old filenames; always pass both paths.

### Refresh usage weights (deliberate, human-triggered only)

```bash
node scripts/refresh-usage.mjs        # writes meta-usage.json (in data/) from live pvpoke GL rankings
```

Evolve runs ignore `meta-usage.json` (sampling is pure pvpoke rank). Currently none or `meta-roles.json` exists in `data/`, so usage
and role priors come from the pinned pvpoke rankings. Community-curated teams in
`data/meta-teams-community.json` are a separate local source; changing the pin
does not update them.

### Tests (only when code changed)

```bash
node --test test/<file>.test.js   # one module
npm run test:changed              # a few files in one area
npm test                          # fast tier, ~1 s
npm run test:full                 # ~13 s; required before a push
```

## 7. What the standard recipe actually does

Resolved settings for `scripts/sim.sh <csv> --name NAME --threads 12`:

| Setting | Value |
| --- | --- |
| League | Great League, CP 1500 |
| Generations | 100 (0-99), or earlier on convergence/deadline |
| Candidate population | 300 at gen 0, shrinking linearly to 120 at gen 99 |
| Opponents per generation | 120 at gen 0, growing to 300 at gen 99 (`round(36000 / population)`) |
| Battles per generation | ≈36,000 (one per candidate/opponent pair, both at designated leads) |
| Candidate species pool | the whole deduped collection (`--pool N` caps it by pvpoke rank) |
| Candidate draw weight | pvpoke rank alone: `1/(rank+20)` per species+shadow build; an unranked build is last place |
| Curated opponent target | 66% of the pool, capped by the curated teams available; curated teams are never culled or mutated |
| Composed opponents | built from pvpoke's overall top 100 species |
| Opponent archetype grouping | opponents are grouped by their dominant two-species core (the pair of base species most common across the pool; no transitive chaining) (`--archetype-beta`, default 0.5); a group of size s counts for `s^(1-beta)` total votes, both as candidate-side opponent weight and as the divisor of each candidate's consistency score |
| Opponent-strength weighting | each opponent's vote in a candidate's win rate (and inside its archetype for consistency) is scaled by (that opponent's own win rate against the population)^`--opponent-strength-gamma` (default 1; 0 = off), computed from the same generation's battles in a second pass -- beating a weak singleton earns little, beating a strong team earns most |
| Core rivalry | `--core-rivalry R` (evolve.mjs default 0.1; `recipes/standard.json` sets 0.2 for `sim.sh` runs; 0 = off): in both the candidate population and the opponent pool, every better team sharing any two base species costs a team R x (the field's max-min fitness) before the cull and mutation ranking, so trailing near-duplicates of a core are culled first while a second variant that fights well on its own survives; raw fitness in checkpoints is untouched. The same function scores shadow twins: a shadow and its base have member similarity 0.9 (the top of the scale short of identity), and a team that is a better team's shadow variant (candidate side: same lead, same backs; opponent side: same species slot for slot) pays a whole-team twin load of 2 x 0.9 on top of its core load -- 2.8 steps against a plain same-core variant's 1, so the weaker twin is pushed toward the cull but a twin that out-fights the field's tail survives. Only an exact duplicate (whole-team similarity 1, possible only from opponent-side draws) dies outright, whatever R is; it is counted in the plain death tolls, not tracked separately. Candidate shadow-flip mutations are 20% of mutation successes and flip a uniformly random non-empty combination of the team's flippable members, so a two- or three-shadow variant is one mutation away, not a walk through intermediates that may each die |
| Similar-core rivalry | `--similar-rivalry S` (default 1) / `--similar-floor F` (default 0.35; 0 similar-rivalry = exact cores only): a better team whose core is a *similar*, not identical, pair adds a fraction of an identical-core rival to the core-rivalry load, scored by pvpoke's own "Similar Pokemon" metric (`src/engine/similarity.js`, `calculateSimilarity` -- shared types, moves, and traits, normalised 0..1). Matches at or below the floor count as unrelated (0); above it the score scales linearly up to `similar` at 1.0 (Feraligatr/Empoleon ~0.55 loads ~0.3, Charizard/Blaziken ~0.62 loads ~0.4, Annihilape/Mimikyu ~0.33 loads nothing at the default floor). Each better team counts once, through its best-matching core, and a team is charged only for its single most crowded core, so carrying two or three popular cores does not stack the penalty |
| Opponent fitness | frequency-normalised by default (`--no-opponent-fitness-normalised` to disable): each candidate's contribution to an opponent's win-rate ledger is weighted down by its most-common member's population share (clamped [0.2, 5]), so a crowded counter-bred core no longer collects N× the credit for beating it |
| Fitness | `battle-reality` = 0.45 win rate + 0.20 consistency (25th-percentile per-archetype win rate) + 0.25 decided lead-exchange win rate + 0.10 mean closer prior of the back line |
| Selection statistic | each team's recency-weighted mean fitness over its last 5 generations (`--selection-trailing`, its own window separate from convergence's); the cull, the mutation ranking and the finalist pick all use it, never a single generation's draw |
| Candidate cull | `round(1/3 × next size)` replaced per generation, plus shrink |
| Mutation chance | 5% (worst survivor) to 40% (best), linear by fitness percentile; 30% lead rotation / 70% one-member swap |
| Immigrants | `round(10% × next size)` fresh teams |
| Opponent-side GA | cull 15% of non-curated, mutation 2-20%, immigrants ≤8%, curated parents mutate at a flat 3% into new teams; opponent fitness = 1 − candidate win points, no extra battles |
| Convergence | smoothed (10-gen) top-10 unchanged for 6 straight transitions and elite lift improving ≤0.005 vs the prior 10-gen baseline; cannot fire before gen 16. Tunable only via `--conv-window`, `--conv-top-n` |
| Final pass | top 12 last-generation candidates by the selection statistic vs every curated team + a held-out archive (the 400 strongest evolved opponents of the whole run, excluding any fielded in the last 10 generations) + 400 fresh meta-composed teams never fought during the run. Curated weights meta/untagged 1, recommended 0.5, off-meta 0.25; archive+fresh together carry the run's `(1-curated-ratio)/curated-ratio` share of the curated weight (with `--curated-ratio 0`, every opponent weighs 1). Out-of-sample by construction. |
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

## Sequential Halving (`--halving-rounds`, on by default)

`--halving-rounds R` (with `--halving-keep F`, default 0.5) reveals each generation's opponents in R
growing slices and drops the weaker teams after each round, so cut teams skip most battles
(R=3: ~0.59x battles, R=4: ~0.43x). R=3 is the default; `--halving-rounds 0` turns it off and the
search runs the full grid. The value is part of the run config: pass the same one on every resume.

## Hoeffding Races (`--hoeffding-races`, off by default)

Same goal as Sequential Halving (skip battles against teams that are going to lose anyway) with an
adaptive schedule. Opponents are revealed in chunks (`--hoeffding-chunk`, default 10); after each
chunk, every alive team's Wilson-score win-rate interval is checked against the cull-line team's
interval (`--hoeffding-keep` sets the cull-line rank, default the median; `--hoeffding-confidence`
sets the interval width, default 0.1). A team is cut only when its upper bound falls below the cull
line's lower bound. `--hoeffding-races` replaces halving for the run regardless of
`--halving-rounds`. It joins the config fingerprint only when on; resuming with the switch flipped,
or with a different confidence, is refused (the error names the key).

## Sampled combats (`--sampled-combats F`, `--sampled-opponents K`, off by default)

`--sampled-combats F` (F = 1/K: 0.5, 0.25, ...) shuffles the opponent pool into K blocks and the
candidates into K groups each generation; each group fights one block. `--sampled-opponents K`
fixes the number of opponents each candidate fights per generation instead; Halving runs inside
each block, and start-up refuses when candidates < blocks. The two flags cannot be combined, and
`--sampled-combats` cannot combine with `--hoeffding-races`. Same seed gives identical results at
any `--threads`. Resuming without the same value is refused (the error names the key).
## MCP servers (`mcp/server.mjs` = `pogo-sim`, `mcp/server-extra.mjs` = `pogo-sim-extra`)

`.mcp.json` registers both for Claude Code sessions in this folder only. `pogo-sim` has
`"alwaysLoad": true`, so its tool schemas load inline on turn 1 (otherwise Claude Code defers
every MCP tool behind a `ToolSearch` turn, whatever its size). `pogo-sim-extra` is off by default
via `disabledMcpjsonServers` in `.claude/settings.json`; to use it for a session, remove it
from that list (or run `/mcp` and enable it). Every launch is detached, so closing the session
never kills a sim.

`pogo-sim` (kept: used in 4+ of the last 20 sessions, or a lifecycle tool kept by decision):

| tool | RUNBOOK counterpart |
|---|---|
| `run_standard`, `run_meta` | section 3 `scripts/sim.sh [--meta]` (`dry_run` prints the command; `extra` goes after `--`) |
| `status_sim` (no name needed: the live run, or the most recently launched of several by `launch.json.at` -> checkpoint `runStartedAt` -> dir mtime; params `teams` default 15, `mons` default 5 -> 15 candidate teams / 5 mons / 15 opponent teams / 5 opponent mons, mons by representation %, `(N of M available in this checkpoint)` when short; compact text), `list_runs`, `tail_log` | `sim.sh status`, `tail -f`, section 2. `status_sim` on a DONE run ends with `report: <abs html path>` (renders if stale) |
| `stop_sim` (`after_generation` / `hard`), `cancel_stop` | section 4; soft stop = detached `mcp/soft-stop.mjs` (polls every 10 s, SIGTERM after the next checkpoint) |
| `resume_sim` | section 4 resume; flags rebuilt from the checkpoint `config`, non-fingerprint flags from `out/evolve-NAME/launch.json` |
| `check_oom` | earlyoom journal grep |

`pogo-sim-extra`:

| tool | RUNBOOK counterpart |
|---|---|
| `get_report` | builds the HTML report of a finished run (if missing or stale), returns only its path (rarely used, so not in `pogo-sim`) |
| `preflight`, `smoke_test`, `check_sim` | section 1 checks, `--quick` trial, `evolve.mjs --check` |
| `run_raw` | bare `node scripts/evolve.mjs` recipe; any `--help` flag, typos rejected with a suggestion |
| `list_collections` | section 2 |
| resource `pogo-sim://runs/{name}/report.html`, `render_report`, `chart_top_teams`, `fitness_sides`, `symmetry_gap`, `build_curated_from_meta` | section 5 |
| `build_shared_collection`, `build_meta_collection`, `refresh_usage` | section 6 |
